import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MONITORED_VESSELS } from "./seasatsScope.js";
import { JUDGEMENT_PARAMETERS, MONITORED_AREAS } from "./monitoringRules.js";
import { CARRIER_AFFILIATION_RULES } from "./carrierAffiliation.js";
import { getVesselOverride, applyVesselOverride } from "./vesselNames.js";
import { analyzePayload, sortAnalyses } from "../src/logic/domain.js";
import { extractHullCode, vesselSidebarLabel } from "../src/logic/vesselLabel.js";
import { FETCH_LIMIT, SAFE_RECORD_THRESHOLD, mergeTrackPoints, splitWindow, trackPointKey } from "./trackWindows.js";
import coastData from "../src/data/chinaCoast.json" with { type: "json" };

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const appRoot = resolve(here, "..");
const distRoot = resolve(appRoot, "dist");
const dataRoot = resolve(here, "data");
const affiliationHistoryFile = resolve(dataRoot, "carrier-affiliation-history.json");
const summarySnapshotFile = resolve(dataRoot, "fleet-summary-snapshot.json");
const skillConfig = resolve(appRoot, "..", "..", ".claude", "skills", "carrier-affiliation-data-skill", "config", "ontology.env");
const externalOntologyConfig = process.env.ONTOLOGY_ENV_FILE || null;
const apiPort = Number(process.env.PORT || 5180);
// 用户指定的轨迹数据窗口：从 2025-01-01 起，不设滚动限制，一直可查看到当前时间。
// 本体单次查询匹配量超 20w 行会静默截断（分页模式不可用），历史数据按 trackWindows 分批拉全量。
const trackBaselineStartMs = Date.UTC(2025, 0, 1);
const mimeTypes = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

let summarySnapshot = null;
let affiliationHistory = null;
let fleetRefreshPromise = null;
let affiliationRefreshPromise = null;
// 服务刚启动时必须完成一次全量本体轨迹更新，避免页面先展示过期快照再逐项跳变。
let summaryReady = false;
// 态势分数需及时反映 AIS 新报点，关联计算则单独按较低频率执行。
const fleetRefreshMs = 30 * 60 * 1000;
const affiliationRefreshMs = 5 * 60 * 60 * 1000;
// v8：轨迹窗口从 2025-12-06 扩到 2025-01-01，旧快照由更短窗口算出，口径不一致必须后台重算。
// v7：详情弹窗航迹对比图需要双方抽稀航迹序列，analyzeLag 另输出中位距离与阈值内比例。
// 仅新增可选展示字段，命中算法/阈值/结论不变；旧快照口径不一致，重启后触发一次后台重算填充新字段。
const affiliationSnapshotVersion = "python-select-v8-track-window-2025-01-01";
const headingFieldVersion = "independent-heading-orientation-v2";
// 轨迹落盘目录：去重后的全量轨迹按 MMSI 持久化，重启后只补增量，不再全量重拉。
const trackStoreRoot = resolve(dataRoot, "tracks");
// 增量刷新时从水位线回退的重叠窗口，吸收迟到/乱序报点。
const TRACK_OVERLAP_MS = 2 * 60 * 60 * 1000;
const trackCache = new Map();
const trackInFlight = new Map();
const monitoredMmsiSet = new Set(MONITORED_VESSELS.map((vessel) => vessel.mmsi));

function affiliationRulesChanged(snapshot) {
  // 规则或轨迹来源升级后不能将旧快照误标为新口径，必须完成一次后台重算再对外展示。
  return snapshot?.algorithmVersion !== affiliationSnapshotVersion
    || JSON.stringify(snapshot?.rules || {}) !== JSON.stringify(CARRIER_AFFILIATION_RULES);
}

function analyzeAffiliationsInWorker(input) {
  // 长历史轨迹的 61 组时延扫描是 CPU 密集型任务，必须脱离 HTTP 主线程执行。
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(new URL("./carrier-affiliation-worker.js", import.meta.url), { workerData: input });
    worker.once("message", (message) => {
      if (message?.error) rejectWorker(new Error(message.error));
      else resolveWorker(message.result);
    });
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0) rejectWorker(new Error(`航母关联计算 Worker 异常退出：${code}`));
    });
  });
}

function readSkillEnv(file) {
  if (!file || !existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return matched ? [[matched[1], matched[2]]] : [];
  }));
}

function ontologyConfig() {
  // 生产环境通过 ONTOLOGY_ENV_FILE 注入受限凭据；本地开发仍兼容原有 skill 配置。
  const fileConfig = { ...readSkillEnv(skillConfig), ...readSkillEnv(externalOntologyConfig) };
  const get = (key) => process.env[key] || fileConfig[key];
  const baseUrl = get("ONTOLOGY_API_BASE_URL");
  const token = get("ONTOLOGY_AUTH_TOKEN");
  const spaceId = get("ONTOLOGY_SPACE_ID");
  const scopeType = get("ONTOLOGY_SCOPE_TYPE") || "Space";
  if (!baseUrl || !token || !spaceId) throw new Error("SOURCE_AUTH_MISSING");
  return { baseUrl, token, spaceId, scopeType };
}

async function requestRawAis(body) {
  const config = ontologyConfig();
  let lastError;
  // 个别大轨迹在本体繁忙时会超过常规响应时间，短暂重试避免整批快照被一艘船拖垮。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`${config.baseUrl}/daasDMS/entity/RawAISData/list`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, Spaceid: config.spaceId, scopeType: config.scopeType, "Content-Type": "application/json" },
        body: JSON.stringify({ rowType: "map", ...body }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`ONTOLOGY_HTTP_${response.status}`);
      const data = await response.json();
      const details = data.details || {};
      if (data.resultCode !== 200 || details.resultCode !== 200) throw new Error(`ONTOLOGY_RESULT_${details.resultCode || data.resultCode || "UNKNOWN"}`);
      return details;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function mapConcurrent(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }));
  return output;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const timestamp = /[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(" ", "T")}+08:00`;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function currentTrackStartMs() {
  return trackBaselineStartMs;
}

function formatOntologyTime(timeMs) {
  // 本体接口的无时区时间按北京时间解释，查询边界也使用同一口径。
  return new Date(timeMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function normalizePoint(row, index = 0) {
  return {
    id: `${row.mmsi}-${row.startTime || row.dataUpdateTime || index}`,
    mmsi: String(row.mmsi),
    time: normalizeTime(row.startTime || row.dataUpdateTime),
    lon: numberOrNull(row.longitude), lat: numberOrNull(row.latitude), speedKn: numberOrNull(row.sog),
    courseDeg: numberOrNull(row.courseOverGround), orientation: numberOrNull(row.courseOverGround),
    heading: numberOrNull(row.trueHeading), navStatus: row.navigationalStatus ?? null, aisSourceType: row.typeCode ?? null,
    name: row.shipName ?? null, provider: "ontology-daas", confidence: 1,
  };
}

function isGenericVesselName(name) {
  return /^(?:US\s+GOV(?:ERNMENT)?(?:\s+VESSEL)?|US\s+WARSHIP|WARSHIP|美国政府船只)$/i.test(String(name || "").trim());
}

// 侧栏“代号 船名”标签：代号优先取名单配置，缺失时用 AIS 船名中提取的舷号兜底；
// 船名优先取名单 shortName/中文名，再取本体识别名中的中文段，最后回退实际获取的名字。
// 该标签供左右侧栏标题使用；航母关联卡片等仍使用 name 字段，显示方式不受影响。
export function sidebarFields(vessel, resolvedName, identityCode) {
  const code = vessel.code ?? identityCode ?? null;
  return {
    code,
    displayName: code ? vesselSidebarLabel({ code, name: vessel.shortName || vessel.name, fallbackName: resolvedName }) : null,
  };
}

function selectPreferredVesselName(names, role = "") {
  return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))]
    .sort((a, b) => {
      const score = (name) => (isGenericVesselName(name) ? -100 : 0)
        + (/航母|CVN|USS/i.test(name) && role === "航母" ? 40 : 0)
        + (/[一-鿿]/.test(name) ? 10 : 0)
        + Math.min(name.length, 30) / 100;
      return score(b) - score(a);
    })[0] || null;
}

async function fetchVesselIdentity(vessel) {
  const details = await requestRawAis({
    columns: ["mmsi", "shipName", "typeCode"],
    pageParam: { pageIndex: 1, limit: 1000 },
    filters: [{ column: "mmsi", logic: "=", condition: vessel.mmsi, useCondition: true }],
  });
  const rows = (details.rows || []).filter((item) => String(item.mmsi) === vessel.mmsi);
  return {
    mmsi: vessel.mmsi,
    // 本体同一船可能有别名，优先标准名称，排除“US GOV VESSEL”等通用占位名。
    name: selectPreferredVesselName(rows.map((item) => item.shipName), vessel.role),
    // 美军舰 AIS 船名常自带舷号（如 USS Benfold DDG-65），提取后可供侧栏代号兜底。
    code: rows.map((item) => extractHullCode(item.shipName)).find(Boolean) ?? null,
    rawTypeCode: rows.find((item) => item.typeCode)?.typeCode ?? null,
  };
}

const AIS_COLUMNS = ["mmsi", "shipName", "latitude", "longitude", "sog", "courseOverGround", "trueHeading", "navigationalStatus", "typeCode", "startTime", "dataUpdateTime"];

function aisTimeFilters(mmsi, startMs, endMs) {
  // 所有窗口都带上界：防止异常未来时间报点把增量水位线推到 now 之后，导致增量窗口永久为空。
  return [
    { column: "mmsi", logic: "=", condition: mmsi, useCondition: true },
    { column: "startTime", logic: ">=", condition: formatOntologyTime(startMs), useCondition: true },
    { column: "startTime", logic: "<", condition: formatOntologyTime(endMs), useCondition: true },
  ];
}

// 轻量探测（只取 1 行、1 个字段），从 pageParam.recordTotal 读窗口匹配总量。
async function probeRecordCount(mmsi, startMs, endMs) {
  const details = await requestRawAis({
    columns: ["mmsi"],
    pageParam: { pageIndex: 1, limit: 1 },
    filters: aisTimeFilters(mmsi, startMs, endMs),
  });
  return Number(details.pageParam?.recordTotal || 0);
}

// 单请求拿全量：前提是窗口 recordTotal ≤ FETCH_LIMIT（20w），否则接口静默截断。
async function fetchWindowRows(mmsi, startMs, endMs) {
  const details = await requestRawAis({
    columns: AIS_COLUMNS,
    pageParam: { pageIndex: 1, limit: FETCH_LIMIT },
    filters: aisTimeFilters(mmsi, startMs, endMs),
  });
  const recordTotal = Number(details.pageParam?.recordTotal || 0);
  const rows = details.rows || [];
  return { rows, recordTotal, complete: recordTotal <= FETCH_LIMIT && rows.length >= recordTotal };
}

// 把一个窗口的原始行规范化后流入去重 Map，原始行随即释放；
// 热点船全历史可达 200w+ 原始行，攒齐再去重会有数百 MB 峰值内存。
function absorbRows(rows, windowStartMs, nowMs, collector, stats) {
  stats.fetched += rows.length;
  for (const row of rows) {
    const point = normalizePoint(row, collector.size);
    const timeMs = Date.parse(point.time);
    // 时钟漂移容忍 10 分钟；更远的未来时间视为坏数据丢弃。
    if (!Number.isFinite(timeMs) || timeMs < windowStartMs || timeMs > nowMs + 10 * 60 * 1000) continue;
    collector.set(trackPointKey(point), point);
  }
}

// 递归细分拉取：探测 ≤ 阈值则单请求拿全；超限按 月→日→二分（下限 1 小时）细分。
async function collectWindowedPoints(mmsi, startMs, endMs, windowStartMs, nowMs, collector, stats, depth = 0) {
  const total = await probeRecordCount(mmsi, startMs, endMs);
  stats.windows += 1;
  if (total === 0) return;
  if (total <= SAFE_RECORD_THRESHOLD) {
    const window = await fetchWindowRows(mmsi, startMs, endMs);
    // 探测到拉取之间数据突增导致截断时，按超限继续细分，绝不接受不完整结果。
    if (window.complete) {
      absorbRows(window.rows, windowStartMs, nowMs, collector, stats);
      return;
    }
  }
  const subWindows = depth < 20 ? splitWindow(startMs, endMs) : null;
  if (!subWindows) {
    // 已细分到 1 小时仍超安全阈值：在 20w 硬上限内硬拉是完整的，仅真正被截断时才标记告警。
    const window = await fetchWindowRows(mmsi, startMs, endMs);
    if (!window.complete) {
      stats.truncated = true;
      console.warn(`本体窗口数据超上限被截断（MMSI ${mmsi}，${formatOntologyTime(startMs)} 起，recordTotal ${window.recordTotal}）`);
    }
    absorbRows(window.rows, windowStartMs, nowMs, collector, stats);
    return;
  }
  for (const [subStart, subEnd] of subWindows) {
    await collectWindowedPoints(mmsi, subStart, subEnd, windowStartMs, nowMs, collector, stats, depth + 1);
  }
}

function trackStoreFile(mmsi) {
  return join(trackStoreRoot, `${mmsi}.json`);
}

async function loadTrackStore(mmsi) {
  const store = await loadSnapshot(trackStoreFile(mmsi), `轨迹缓存（MMSI ${mmsi}）`);
  // 基准窗口变更后旧缓存口径不一致，判废触发全量重拉，避免新旧报点混排。
  if (store?.windowStart !== new Date(trackBaselineStartMs).toISOString()) return null;
  return Array.isArray(store?.trackPoints) ? store : null;
}

async function saveTrackStore(mmsi, trackPoints) {
  await writeSnapshot(trackStoreFile(mmsi), {
    mmsi,
    windowStart: new Date(trackBaselineStartMs).toISOString(),
    updatedAt: new Date().toISOString(),
    trackPoints,
  });
}

async function buildTrack(mmsi) {
  if (!/^\d{6,12}$/.test(mmsi)) throw new Error("INVALID_MMSI");
  const windowStartMs = currentTrackStartMs();
  const nowMs = Date.now();
  const cached = trackCache.get(mmsi)?.track || await loadTrackStore(mmsi);
  const existingPoints = cached?.trackPoints || [];
  // 增量水位线：已有轨迹的最新报点回退 2 小时重叠拉取；钳制到 now 防止未来时间卡死增量。
  const lastTimeMs = existingPoints.length ? Date.parse(existingPoints.at(-1).time) : null;
  const watermarkMs = Number.isFinite(lastTimeMs) ? Math.min(lastTimeMs, nowMs) : null;
  const fetchStartMs = watermarkMs === null ? windowStartMs : Math.max(windowStartMs, watermarkMs - TRACK_OVERLAP_MS);
  const incremental = watermarkMs !== null;
  // 已有报点先入去重 Map，增量/全量新报点按业务键覆盖，重叠窗口天然去重。
  const collector = new Map(existingPoints.map((point) => [trackPointKey(point), point]));
  const stats = { windows: 0, fetched: 0, truncated: false };
  await collectWindowedPoints(mmsi, fetchStartMs, nowMs, windowStartMs, nowMs, collector, stats);
  const trackPoints = [...collector.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  await saveTrackStore(mmsi, trackPoints);
  const payload = {
    mmsi,
    trackPoints,
    meta: {
      source: "ontology-daas",
      fetchedRowCount: stats.fetched,
      windowCount: stats.windows,
      loadedCount: trackPoints.length,
      startTime: new Date(windowStartMs).toISOString(),
      incremental,
      truncated: stats.truncated,
    },
  };
  return payload;
}

export function summarySnapshotUsable(snapshot) {
  return snapshot?.metadata?.source === "ontology-daas"
    && snapshot?.metadata?.headingFieldVersion === headingFieldVersion
    // 轨迹窗口不一致的旧快照不得用于首屏（例如窗口从 2025-12-06 扩到 2025-01-01 后）。
    && snapshot?.metadata?.trackWindowStart === new Date(trackBaselineStartMs).toISOString()
    && Array.isArray(snapshot?.targets)
    && snapshot.targets.length > 0;
}

async function getOntologyTrack(mmsi, { force = false } = {}) {
  if (trackInFlight.has(mmsi)) return trackInFlight.get(mmsi);
  const cached = trackCache.get(mmsi);
  // 缓存不再设 TTL：buildTrack 本身是水位线增量，force 重取也是低成本增量合并。
  if (!force && cached) return cached.track;

  const request = buildTrack(mmsi)
    .then((track) => {
      trackCache.set(mmsi, { track });
      return track;
    })
    .finally(() => trackInFlight.delete(mmsi));
  trackInFlight.set(mmsi, request);
  return request;
}

async function buildOntologyTrackOrEmpty(mmsi, context, options) {
  try {
    return await getOntologyTrack(mmsi, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`本体轨迹查询失败（${context}，MMSI ${mmsi}）：${message}`);
    return {
      mmsi,
      trackPoints: [],
      meta: { source: "ontology-daas", loadedCount: 0, error: message },
    };
  }
}

async function buildAffiliationTrack(mmsi) {
  return buildOntologyTrackOrEmpty(mmsi, "affiliation");
}

async function buildFastSummary() {
  // 页面首屏只加载名单和默认关注船的完整轨迹，确保不被其他舰船的全量历史数据阻塞。
  const [identities, initialTrack] = await Promise.all([
    mapConcurrent(MONITORED_VESSELS, 6, fetchVesselIdentity),
    getOntologyTrack(MONITORED_VESSELS[0].mmsi),
  ]);
  const identityByMmsi = new Map(identities.map((identity) => [identity.mmsi, identity]));
  const initialLatest = initialTrack.trackPoints.at(-1);
  const targets = MONITORED_VESSELS.map((vessel) => {
    const identity = identityByMmsi.get(vessel.mmsi);
    const latest = vessel.mmsi === initialTrack.mmsi ? initialLatest : null;
    // 登记表覆盖优先：本体/名单均无真实船名时，回退到手动登记的舷号/船名。
    const overrideName = getVesselOverride(vessel.mmsi)?.name || null;
    const resolvedName = overrideName || latest?.name || identity?.name || `MMSI ${vessel.mmsi}`;
    return {
      mmsi: vessel.mmsi,
      name: resolvedName,
      ...sidebarFields(applyVesselOverride(vessel), resolvedName, identity?.code),
      latestTime: latest?.time || null,
      lon: latest?.lon ?? null,
      lat: latest?.lat ?? null,
      speedKn: latest?.speedKn ?? null,
      speedRawDiv10: latest?.speedKn == null ? null : latest.speedKn * 10,
      courseDeg: latest?.courseDeg ?? null,
      orientation: latest?.orientation ?? latest?.courseDeg ?? null,
      heading: latest?.heading ?? null,
      length: null, width: null, vesselCategory: vessel.role, rawTypeCode: latest?.aisSourceType ?? identity?.rawTypeCode ?? null,
    };
  });
  const points = initialTrack.trackPoints;
  return {
    metadata: {
      source: "ontology-daas", generatedAt: new Date().toISOString(), targetCount: targets.length,
      headingFieldVersion,
      trackWindowStart: new Date(trackBaselineStartMs).toISOString(),
      trackPointCount: points.length, trackMmsiCount: points.length ? 1 : 0,
      vesselTypes: [...new Set(targets.map((target) => target.vesselCategory))],
      rawTypeCodes: [...new Set(targets.map((target) => target.rawTypeCode).filter(Boolean))],
      dataWindow: { start: points[0]?.time || null, end: points.at(-1)?.time || null, latestPositionStart: null, latestPositionEnd: null },
    },
    parameters: JUDGEMENT_PARAMETERS, monitoredAreas: MONITORED_AREAS, targets, trackPoints: points,
  };
}

function buildSummaryFromTracks(trackEntries, identityByMmsi = new Map()) {
  const allAlerts = [];
  const compactTargets = [];
  const initialMmsi = MONITORED_VESSELS[0]?.mmsi;
  let initialTrackPoints = [];
  let initialSegments = [];
  let initialGaps = [];
  const allTimes = [];
  for (const [mmsi, track] of trackEntries) {
    const vessel = MONITORED_VESSELS.find((item) => item.mmsi === mmsi);
    if (!vessel) continue;
    const trackPoints = track.trackPoints || [];
    const latest = trackPoints.at(-1);
    const identity = identityByMmsi.get(mmsi);
    // 船名和轨迹属性均来自本体，配置名称仅在本体名称缺失时兜底；登记表覆盖优先于以上全部。
    const overrideName = getVesselOverride(mmsi)?.name || null;
    const resolvedName = overrideName || identity?.name || (latest?.name && !isGenericVesselName(latest.name) ? latest.name : vessel.name || latest?.name || `MMSI ${mmsi}`);
    const rawTarget = {
      mmsi,
      name: resolvedName,
      ...sidebarFields(applyVesselOverride(vessel), resolvedName, identity?.code),
      latestTime: latest?.time || null,
      lon: latest?.lon ?? null,
      lat: latest?.lat ?? null,
      speedKn: latest?.speedKn ?? null,
      speedRawDiv10: latest?.speedKn == null ? null : latest.speedKn * 10,
      courseDeg: latest?.courseDeg ?? null,
      orientation: latest?.orientation ?? latest?.courseDeg ?? null,
      heading: latest?.heading ?? null,
      length: latest?.length ?? null,
      width: latest?.width ?? null,
      // 只有一个最新点时才标记“点位”；取得两个及以上有效报点即为真实轨迹。
      latestOnly: trackPoints.length <= 1,
      vesselCategory: vessel.role,
      rawTypeCode: latest?.aisSourceType ?? null,
    };
    // 每艘船在服务端完成与前端一致的研判后立即压缩，只保留评分和证据，避免首屏传输全量报点。
    const analyzed = analyzePayload({
      metadata: {}, parameters: JUDGEMENT_PARAMETERS, monitoredAreas: MONITORED_AREAS,
      targets: [rawTarget], trackPoints,
    }, coastData);
    const target = analyzed.targets[0];
    if (track.meta?.error) {
      target.score = null;
      target.status = "数据查询失败";
      target.trackError = track.meta.error;
      target.dataUnavailable = true;
    }
    const { segments, aisGaps, alerts, ...compactTarget } = target;
    compactTargets.push(compactTarget);
    // 大轨迹（10w+ 点）下展开传参会触发 V8 参数上限（Maximum call stack size exceeded），改逐个 push。
    for (const alert of analyzed.alerts) allAlerts.push(alert);
    for (const point of trackPoints) { if (point.time) allTimes.push(point.time); }
    if (mmsi === initialMmsi) {
      initialTrackPoints = trackPoints;
      initialSegments = analyzed.segments;
      initialGaps = analyzed.aisGaps;
    }
  }
  const times = allTimes.sort();
  const targets = sortAnalyses(compactTargets);
  return {
    metadata: {
      source: "ontology-daas",
      headingFieldVersion,
      generatedAt: new Date().toISOString(),
      targetCount: targets.length,
      trackWindowStart: new Date(trackBaselineStartMs).toISOString(),
      trackPointCount: allTimes.length,
      trackMmsiCount: compactTargets.filter((target) => target.hasObservedTrack).length,
      vesselTypes: [...new Set(targets.map((target) => target.vesselCategory))],
      rawTypeCodes: [...new Set(targets.map((target) => target.rawTypeCode).filter(Boolean))],
      dataWindow: { start: times[0] || null, end: times.at(-1) || null, latestPositionStart: times[0] || null, latestPositionEnd: times.at(-1) || null },
    },
    parameters: JUDGEMENT_PARAMETERS,
    monitoredAreas: MONITORED_AREAS,
    targets,
    // 只随首屏发送默认舰艇轨迹；其它舰艇点选时再从本体查询完整轨迹。
    trackPoints: initialTrackPoints,
    segments: initialSegments,
    aisGaps: initialGaps,
    alerts: allAlerts,
    precomputedAnalysis: true,
  };
}

async function loadSnapshot(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`无法读取${label}`, error);
    return null;
  }
}

async function writeSnapshot(file, value) {
  await mkdir(resolve(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

async function refreshFleetSnapshot() {
  if (fleetRefreshPromise) return fleetRefreshPromise;
  fleetRefreshPromise = (async () => {
    // 除远程地图 iframe 外，所有分析只使用本体 RawAISData 历史轨迹。
    const [tracks, identities] = await Promise.all([
      mapConcurrent(MONITORED_VESSELS, 3, async (vessel) => [vessel.mmsi, await buildOntologyTrackOrEmpty(vessel.mmsi, "fleet-summary", { force: true })]),
      // 仅查询姓名字段，控制并发以免本体查询影响 AIS 历史轨迹服务。
      mapConcurrent(MONITORED_VESSELS, 6, async (vessel) => {
        try {
          return await fetchVesselIdentity(vessel);
        } catch (error) {
          // 单艘船名查询失败不得阻断整批点位与威胁分快照，继续使用配置名称。
          console.warn(`本体未返回 ${vessel.mmsi} 的船名：${error instanceof Error ? error.message : error}`);
          return { mmsi: vessel.mmsi, name: null, rawTypeCode: null };
        }
      }),
    ]);
    const identityByMmsi = new Map(identities.map((identity) => [identity.mmsi, identity]));
    const nextSummary = buildSummaryFromTracks(tracks, identityByMmsi);
    const refreshedAt = new Date().toISOString();
    nextSummary.metadata.refreshedAt = refreshedAt;
    // 舰艇态势计算完成即可进入页面；航母关联可能耗时很长，必须与首屏数据解耦。
    await writeSnapshot(summarySnapshotFile, nextSummary);
    summarySnapshot = nextSummary;
    summaryReady = true;

    console.log(`舰船态势快照已更新：${refreshedAt}`);
    return nextSummary;
  })().catch((error) => {
    console.error("舰船数据快照更新失败", error instanceof Error ? error.message : error);
    throw error;
  }).finally(() => { fleetRefreshPromise = null; });
  return fleetRefreshPromise;
}

async function refreshAffiliationHistory() {
  if (affiliationRefreshPromise) return affiliationRefreshPromise;
  affiliationRefreshPromise = (async () => {
    // 关联计算只消费已完整落盘的态势快照，绝不读取本轮的中间轨迹数据。
    // 启动时先等待正在执行的 fleet 刷新，随后直接复用其轨迹缓存，避免两套全量查询争抢本体连接。
    if (fleetRefreshPromise) await fleetRefreshPromise;
    else if (!summarySnapshot) await refreshFleetSnapshot();
    // 航母归属需全轨迹，独立低频拉取，不能挤占 30 分钟一次的首屏态势刷新。
    const tracks = await mapConcurrent(MONITORED_VESSELS, 2, async (vessel) => [vessel.mmsi, await buildAffiliationTrack(vessel.mmsi)]);
    const tracksByMmsi = Object.fromEntries(tracks.map(([mmsi, track]) => [mmsi, track.trackPoints]));
    const trackSourcesByMmsi = Object.fromEntries(tracks.map(([mmsi, track]) => [mmsi, {
      source: track.meta?.source || "unknown",
      loadedCount: track.meta?.loadedCount || track.trackPoints.length,
      error: track.meta?.error || null,
    }]));
    const carriers = MONITORED_VESSELS.filter((vessel) => vessel.role === "航母");
    const result = await analyzeAffiliationsInWorker({ vessels: MONITORED_VESSELS, carriers, tracksByMmsi });
    const refreshedAt = new Date().toISOString();
    const associationsByMmsi = { ...result.associationsByMmsi };
    for (const [mmsi, source] of Object.entries(trackSourcesByMmsi)) {
      if (!source.error) continue;
      associationsByMmsi[mmsi] = {
        ...(associationsByMmsi[mmsi] || {}),
        status: "source-error",
        error: source.error,
      };
    }
    const failedCarrierMmsi = MONITORED_VESSELS
      .filter((vessel) => vessel.role === "航母" && trackSourcesByMmsi[vessel.mmsi]?.error)
      .map((vessel) => vessel.mmsi);
    if (failedCarrierMmsi.length) {
      for (const [mmsi, association] of Object.entries(associationsByMmsi)) {
        if (trackSourcesByMmsi[mmsi]?.error || association.status === "carrier") continue;
        associationsByMmsi[mmsi] = {
          ...association,
          status: "partial-source-error",
          failedCarrierMmsi,
        };
      }
    }
    const nextAffiliation = { ...result, associationsByMmsi, algorithmVersion: affiliationSnapshotVersion, trackSourcesByMmsi, refreshedAt, refreshIntervalHours: 5 };
    await writeSnapshot(affiliationHistoryFile, nextAffiliation);
    affiliationHistory = nextAffiliation;
    console.log(`航母关联历史快照已更新：${refreshedAt}`);
    return nextAffiliation;
  })().catch((error) => {
    console.error("航母关联历史更新失败", error instanceof Error ? error.message : error);
    throw error;
  }).finally(() => { affiliationRefreshPromise = null; });
  return affiliationRefreshPromise;
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

function serveStatic(request, response) {
  const requested = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const pathname = normalize(requested).replace(/^([.][.][/\\])+/, "");
  let filePath = join(distRoot, pathname);
  if (!filePath.startsWith(distRoot) || !existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(distRoot, "index.html");
  if (!existsSync(filePath)) return sendJson(response, 503, { error: "APP_NOT_BUILT" });
  response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

// 仅作为主模块直接运行时启动 HTTP 服务（npm start / node server/app-server.js）；
// 被 test 通过 import 引入时不监听端口、不触发后台刷新，便于单测 sidebarFields 等。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/seasats/summary") {
      // 首次打开必须等待所有舰艇完成本体轨迹研判，避免把半成品评分送入页面。
      if (!summaryReady || !summarySnapshot) {
        void refreshFleetSnapshot().catch(() => {});
        return sendJson(response, 202, { status: "refreshing" });
      }
      return sendJson(response, 200, summarySnapshot);
    }
    if (request.method === "GET" && url.pathname === "/api/seasats/affiliations") return sendJson(response, 200, affiliationHistory || { status: (fleetRefreshPromise || affiliationRefreshPromise) ? "refreshing" : "not-generated", refreshIntervalHours: 5 });
    const trackMatch = url.pathname.match(/^\/api\/seasats\/vessels\/(\d+)\/track$/);
    // 点选统计只使用本体轨迹；北邮历史轨迹仅由远程地图 iframe 自己加载。
    if (request.method === "GET" && trackMatch) {
      if (!monitoredMmsiSet.has(trackMatch[1])) throw new Error("MMSI_NOT_IN_SCOPE");
      return sendJson(response, 200, await getOntologyTrack(trackMatch[1], { force: url.searchParams.get("fresh") === "1" }));
    }
    serveStatic(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message === "MMSI_NOT_IN_SCOPE" ? 404 : message === "SOURCE_AUTH_MISSING" ? 503 : 502;
    sendJson(response, status, { error: message });
  }
}).listen(apiPort, "0.0.0.0", async () => {
  console.log(`seasats server listening on ${apiPort}`);
  [summarySnapshot, affiliationHistory] = await Promise.all([
    loadSnapshot(summarySnapshotFile, "舰船数据快照"),
    loadSnapshot(affiliationHistoryFile, "航母关联历史快照"),
  ]);
  // 已确认来源为本体的完整快照可立即用于首屏，后台刷新完成后再原子替换。
  summaryReady = summarySnapshotUsable(summarySnapshot);
  // 每 30 分钟原子更新一次完整态势；已有历史关联快照时不因重启重复慢算。
  void refreshFleetSnapshot().catch(() => {});
  // 数据源版本不一致的旧关联快照不得继续对外展示。
  const affiliationNeedsRefresh = !affiliationHistory || affiliationRulesChanged(affiliationHistory);
  if (affiliationNeedsRefresh) {
    affiliationHistory = null;
    void refreshAffiliationHistory().catch(() => {});
  }
  setInterval(() => { void refreshFleetSnapshot().catch(() => {}); }, fleetRefreshMs);
  setInterval(() => { void refreshAffiliationHistory().catch(() => {}); }, affiliationRefreshMs);
});
}
