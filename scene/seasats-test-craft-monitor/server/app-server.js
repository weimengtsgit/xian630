import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MONITORED_VESSELS } from "./seasatsScope.js";
import { JUDGEMENT_PARAMETERS, MONITORED_AREAS } from "./monitoringRules.js";
import { CARRIER_AFFILIATION_RULES } from "./carrierAffiliation.js";
import { analyzePayload, sortAnalyses } from "../src/logic/domain.js";
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
const remoteMapBaseUrl = "http://218.61.33.200:18000";
// 此密钥由远程球面地图公开前端使用；仅在本服务端请求中使用，绝不返回浏览器。
const remoteMapApiKey = process.env.REMOTE_MAP_API_KEY || "yAjFdLc$Mb76@9rC";
// 用户指定的轨迹数据窗口：先从 2025-12-01 开始；满一年后仅保留最近一年。
const trackBaselineStartMs = Date.UTC(2025, 11, 1);
const trackWindowMs = 365 * 24 * 60 * 60 * 1000;
const mimeTypes = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

let summarySnapshot = null;
let affiliationHistory = null;
let fleetRefreshPromise = null;
let affiliationRefreshPromise = null;
// 服务刚启动时必须完成一次全量球形地图更新，避免页面先展示过期快照再逐项跳变。
let summaryReady = false;
// 态势分数需及时反映 AIS 新报点，关联计算则单独按较低频率执行。
const fleetRefreshMs = 30 * 60 * 1000;
const affiliationRefreshMs = 5 * 60 * 60 * 1000;
const affiliationSnapshotVersion = "python-select-v3-map-fallback-distance-evidence";

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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${config.baseUrl}/daasDMS/entity/RawAISData/list`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, Spaceid: config.spaceId, scopeType: config.scopeType, "Content-Type": "application/json" },
        body: JSON.stringify({ rowType: "map", ...body }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`ONTOLOGY_HTTP_${response.status}`);
      const data = await response.json();
      const details = data.details || {};
      if (data.resultCode !== 200 || details.resultCode !== 200) throw new Error(`ONTOLOGY_RESULT_${details.resultCode || data.resultCode || "UNKNOWN"}`);
      return details;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
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
  const date = new Date(value.includes("T") && !/[zZ]|[+-]\d\d:\d\d$/.test(value) ? `${value}Z` : value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function currentTrackStartMs(nowMs = Date.now()) {
  return Math.max(trackBaselineStartMs, nowMs - trackWindowMs);
}

function formatOntologyTime(timeMs) {
  // 本体接口使用无时区的 YYYY-MM-DD HH:mm:ss，统一按 UTC 传递以避免本地时区漂移。
  return new Date(timeMs).toISOString().slice(0, 19).replace("T", " ");
}

function normalizePoint(row, index = 0) {
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
    rawTypeCode: rows.find((item) => item.typeCode)?.typeCode ?? null,
  };
}

function remoteMapCipherKey() {
  // 与球面地图前端一致：按北京时间当天生成 AES 密钥。
  const now = Date.now();
  const dayStart = now - (now + 8 * 60 * 60 * 1000) % (24 * 60 * 60 * 1000);
  return (String(dayStart).slice(0, 10) + String(dayStart).slice(0, 6)).slice(0, 16).padEnd(16, "0");
}

function decodeRemoteMapResponse(raw) {
  const key = Buffer.from(remoteMapCipherKey());
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, key);
  return JSON.parse(`${decipher.update(raw, "hex", "utf8")}${decipher.final("utf8")}`);
}

async function requestRemoteMapLatest(mmsi) {
  const param = Buffer.from(JSON.stringify({ mmsi }), "utf8").toString("base64");
  const signSource = `C#t36KclJs6JlT$yapi_key${remoteMapApiKey}cmd0x5101param${param}`;
  const sign = crypto.createHash("sha1").update(signSource).digest("hex");
  const url = new URL("/blmcgi", remoteMapBaseUrl);
  url.searchParams.set("cmd", "0x5101");
  url.searchParams.set("param", param);
  url.searchParams.set("api_key", remoteMapApiKey);
  url.searchParams.set("sign", sign);
  url.searchParams.set("cipher", "1");
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`REMOTE_MAP_HTTP_${response.status}`);
  return decodeRemoteMapResponse(await response.text());
}

async function requestRemoteMapTrack(mmsi, startMs = currentTrackStartMs(), endMs = Date.now()) {
  // 球形地图轨迹接口无需分页，按 MMSI 和时间窗口一次返回；用于点选舰艇的快速历史统计。
  const body = {
    uid: "",
    mmsi,
    startdt: String(Math.floor(startMs / 1000)),
    enddt: String(Math.floor(endMs / 1000)),
    news: true,
  };
  const url = new URL("/blmcgi", remoteMapBaseUrl);
  url.searchParams.set("cmd", "0x0157");
  url.searchParams.set("param", Buffer.from(JSON.stringify(body), "utf8").toString("base64"));
  url.searchParams.set("cipher", "1");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`REMOTE_MAP_TRACK_HTTP_${response.status}`);
  const data = decodeRemoteMapResponse(await response.text());
  if (Number(data?.eid) !== 0) throw new Error(`REMOTE_MAP_TRACK_RESULT_${data?.eid ?? "UNKNOWN"}`);
  return data;
}

async function buildRemoteMapTrack(mmsi) {
  if (!/^[0-9]{6,12}$/.test(mmsi)) throw new Error("INVALID_MMSI");
  const startMs = currentTrackStartMs();
  // 同时取历史轨迹和状态接口的最新单点，避免轨迹服务延迟时图表停留在旧报点。
  const [trackRequest, latestRequest] = await Promise.allSettled([
    requestRemoteMapTrack(mmsi, startMs),
    fetchLatestVessel({ mmsi }),
  ]);
  // 两个球形地图接口互为降级：历史轨迹或最新单点任一成功都可完成该艇的本轮研判。
  if (trackRequest.status === "rejected" && latestRequest.status === "rejected") {
    throw new Error(`REMOTE_MAP_DATA_UNAVAILABLE_${mmsi}`);
  }
  const data = trackRequest.status === "fulfilled" ? trackRequest.value : { track: [] };
  const latestResult = latestRequest.status === "fulfilled" ? latestRequest.value[1] : { trackPoints: [] };
  const uniquePoints = new Map();
  for (const [index, record] of (Array.isArray(data.track) ? data.track : []).entries()) {
    const fields = String(record || "").split("|");
    // 远程格式：经度、纬度、秒级时间、航向(×10)、速度(×10)…；部分后续行会省略 MMSI，使用请求的 MMSI 补齐。
    const timeSeconds = Number(fields[3]);
    const lon = Number(fields[1]);
    const lat = Number(fields[2]);
    if (!Number.isFinite(timeSeconds) || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const point = {
      id: `${mmsi}-${timeSeconds}-${index}`,
      mmsi,
      time: new Date(timeSeconds * 1000).toISOString(),
      lon,
      lat,
      speedKn: Number.isFinite(Number(fields[5])) ? Number(fields[5]) / 10 : null,
      courseDeg: Number.isFinite(Number(fields[4])) ? Number(fields[4]) / 10 : null,
      orientation: Number.isFinite(Number(fields[4])) ? Number(fields[4]) / 10 : null,
      heading: null,
      navStatus: fields[12] || null,
      aisSourceType: null,
      name: null,
      provider: "remote-map-track",
      confidence: 1,
    };
    uniquePoints.set([point.time, point.lon, point.lat, point.speedKn, point.courseDeg].join("|"), point);
  }
  for (const point of latestResult.trackPoints || []) {
    uniquePoints.set([point.time, point.lon, point.lat, point.speedKn, point.courseDeg].join("|"), point);
  }
  const trackPoints = [...uniquePoints.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return {
    mmsi,
    trackPoints,
    meta: {
      source: "remote-map-track+latest",
      loadedCount: trackPoints.length,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date().toISOString(),
    },
  };
}

async function fetchLatestVessel(vessel) {
  // 球面地图状态接口按 MMSI 直接返回单条最新 AIS 点，避免从无排序的本体历史轨迹中反查。
  const row = await requestRemoteMapLatest(vessel.mmsi);
  const timeSeconds = Number(row.time);
  const latest = Number.isFinite(timeSeconds) && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))
    ? {
      id: `${vessel.mmsi}-${timeSeconds}`, mmsi: vessel.mmsi, time: new Date(timeSeconds * 1000).toISOString(),
      lon: Number(row.x), lat: Number(row.y), speedKn: Number.isFinite(Number(row.sog)) ? Number(row.sog) / 10 : null,
      courseDeg: Number.isFinite(Number(row.cog)) ? Number(row.cog) / 10 : null,
      orientation: Number.isFinite(Number(row.cog)) ? Number(row.cog) / 10 : null,
      heading: Number.isFinite(Number(row.true_head)) ? Number(row.true_head) : null,
      navStatus: row.nav_status ?? null, aisSourceType: row.ship_type ?? null,
      name: String(row.shipname || row.shipnamecn || "").trim() || null,
      length: Number.isFinite(Number(row.length)) ? Number(row.length) : null,
      width: Number.isFinite(Number(row.width)) ? Number(row.width) : null,
      provider: "remote-map-latest", confidence: 1,
    }
    : null;
  return [vessel.mmsi, { trackPoints: latest ? [latest] : [] }];
}

async function buildTrack(mmsi) {
  if (!/^\d{6,12}$/.test(mmsi)) throw new Error("INVALID_MMSI");
  const columns = ["mmsi", "shipName", "latitude", "longitude", "sog", "courseOverGround", "trueHeading", "navigationalStatus", "typeCode", "startTime", "dataUpdateTime"];
  const windowStartMs = currentTrackStartMs();
  const pageSize = 200_000;
  const filters = [
    { column: "mmsi", logic: "=", condition: mmsi, useCondition: true },
    { column: "startTime", logic: ">=", condition: formatOntologyTime(windowStartMs), useCondition: true },
  ];
  // 单页最多拉 20 万条。接口分页没有可靠排序且可能重复，因此超过单页后仍须按业务字段去重。
  const first = await requestRawAis({ columns, pageParam: { pageIndex: 1, limit: pageSize }, filters });
  const total = Number(first.pageParam?.recordTotal || 0);
  const pageCount = Math.ceil(total / pageSize);
  const pages = await mapConcurrent(Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2), 2, (pageIndex) => requestRawAis({ columns, pageParam: { pageIndex, limit: pageSize }, filters }));
  const rows = [ ...(first.rows || []), ...pages.flatMap((page) => page.rows || []) ];
  const uniquePoints = new Map();
  for (const [index, row] of rows.entries()) {
    const point = normalizePoint(row, index);
    const timeMs = Date.parse(point.time);
    if (!Number.isFinite(timeMs) || timeMs < windowStartMs || point.lon === null || point.lat === null) continue;
    // 接口会返回重复页/重复记录；组合业务字段后保留唯一报点。
    const key = [point.mmsi, point.time, point.lon, point.lat, point.speedKn, point.courseDeg, point.heading, point.navStatus].join("|");
    uniquePoints.set(key, point);
  }
  const trackPoints = [...uniquePoints.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const payload = { mmsi, trackPoints, meta: { source: "ontology-daas", recordTotal: total, fetchedRowCount: rows.length, loadedCount: trackPoints.length, startTime: new Date(windowStartMs).toISOString(), truncated: false } };
  return payload;
}

async function buildAffiliationTrack(mmsi) {
  try {
    const ontologyTrack = await buildTrack(mmsi);
    if (ontologyTrack.trackPoints.length) return ontologyTrack;
    // 本体存在脏数据清理或缺失时，不可把“0 条”误判成“无航母关联”。
    console.warn(`本体未返回 ${mmsi} 的历史 AIS，回退至球形地图轨迹`);
  } catch (error) {
    // 关联快照是后台能力，本体单船暂时不可用时仍可用球形地图完成该船的历史研判。
    console.warn(`本体拉取 ${mmsi} 历史 AIS 失败，回退至球形地图：${error instanceof Error ? error.message : error}`);
  }
  const remoteTrack = await buildRemoteMapTrack(mmsi);
  return {
    ...remoteTrack,
    meta: { ...remoteTrack.meta, source: "remote-map-affiliation-fallback" },
  };
}

async function buildFastSummary() {
  // 页面首屏只加载名单和默认关注船的完整轨迹，确保不被其他舰船的全量历史数据阻塞。
  const [identities, initialTrack] = await Promise.all([
    mapConcurrent(MONITORED_VESSELS, 6, fetchVesselIdentity),
    buildTrack(MONITORED_VESSELS[0].mmsi),
  ]);
  const identityByMmsi = new Map(identities.map((identity) => [identity.mmsi, identity]));
  const initialLatest = initialTrack.trackPoints.at(-1);
  const targets = MONITORED_VESSELS.map((vessel) => {
    const identity = identityByMmsi.get(vessel.mmsi);
    const latest = vessel.mmsi === initialTrack.mmsi ? initialLatest : null;
    return {
      mmsi: vessel.mmsi,
      name: latest?.name || identity?.name || `MMSI ${vessel.mmsi}`,
      latestTime: latest?.time || null,
      lon: latest?.lon ?? null,
      lat: latest?.lat ?? null,
      speedKn: latest?.speedKn ?? null,
      speedRawDiv10: latest?.speedKn == null ? null : latest.speedKn * 10,
      courseDeg: latest?.courseDeg ?? null,
      length: null, width: null, vesselCategory: vessel.role, rawTypeCode: latest?.aisSourceType ?? identity?.rawTypeCode ?? null,
    };
  });
  const points = initialTrack.trackPoints;
  return {
    metadata: {
      source: "ontology-daas", generatedAt: new Date().toISOString(), targetCount: targets.length,
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
    const rawTarget = {
      mmsi,
      // 船名以本体 shipName 为准；北邮只补充实时点位及本体缺失时的名称，避免通用占位名覆盖真实名称。
      name: identity?.name || (latest?.name && !isGenericVesselName(latest.name) ? latest.name : vessel.name || latest?.name || `MMSI ${mmsi}`),
      latestTime: latest?.time || null,
      lon: latest?.lon ?? null,
      lat: latest?.lat ?? null,
      speedKn: latest?.speedKn ?? null,
      speedRawDiv10: latest?.speedKn == null ? null : latest.speedKn * 10,
      courseDeg: latest?.courseDeg ?? null,
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
    const { segments, aisGaps, alerts, ...compactTarget } = target;
    compactTargets.push(compactTarget);
    allAlerts.push(...analyzed.alerts);
    allTimes.push(...trackPoints.map((point) => point.time).filter(Boolean));
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
      generatedAt: new Date().toISOString(),
      targetCount: targets.length,
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
  await mkdir(dataRoot, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

async function refreshFleetSnapshot() {
  if (fleetRefreshPromise) return fleetRefreshPromise;
  fleetRefreshPromise = (async () => {
    // 使用球形地图的历史轨迹与最新点位，按原有完整规则计算威胁分，而非用单点降级评分。
    // 球形地图并发过高会偶发超时；6 路实测可在首屏时限内稳定完成整批更新。
    const [tracks, identities] = await Promise.all([
      mapConcurrent(MONITORED_VESSELS, 6, async (vessel) => [vessel.mmsi, await buildRemoteMapTrack(vessel.mmsi)]),
      // 仅查询姓名字段，控制并发以免本体查询影响 AIS 历史轨迹服务。
      mapConcurrent(MONITORED_VESSELS, 6, async (vessel) => {
        try {
          return await fetchVesselIdentity(vessel);
        } catch (error) {
          // 单艘船名查询失败不得阻断整批点位与威胁分快照，继续使用北邮或配置名称。
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
    if (!summarySnapshot) await refreshFleetSnapshot();
    // 航母归属需全轨迹，独立低频拉取，不能挤占 30 分钟一次的首屏态势刷新。
    const tracks = await mapConcurrent(MONITORED_VESSELS, 2, async (vessel) => [vessel.mmsi, await buildAffiliationTrack(vessel.mmsi)]);
    const tracksByMmsi = Object.fromEntries(tracks.map(([mmsi, track]) => [mmsi, track.trackPoints]));
    const trackSourcesByMmsi = Object.fromEntries(tracks.map(([mmsi, track]) => [mmsi, {
      source: track.meta?.source || "unknown",
      loadedCount: track.meta?.loadedCount || track.trackPoints.length,
    }]));
    const carriers = MONITORED_VESSELS.filter((vessel) => vessel.role === "航母");
    const result = await analyzeAffiliationsInWorker({ vessels: MONITORED_VESSELS, carriers, tracksByMmsi });
    const refreshedAt = new Date().toISOString();
    const nextAffiliation = { ...result, algorithmVersion: affiliationSnapshotVersion, trackSourcesByMmsi, refreshedAt, refreshIntervalHours: 5 };
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

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/seasats/summary") {
      // 首次打开必须等待所有舰艇完成球形地图轨迹研判，避免把半成品评分送入页面。
      if (!summaryReady || !summarySnapshot) {
        void refreshFleetSnapshot().catch(() => {});
        return sendJson(response, 202, { status: "refreshing" });
      }
      return sendJson(response, 200, summarySnapshot);
    }
    if (request.method === "GET" && url.pathname === "/api/seasats/affiliations") return sendJson(response, 200, affiliationHistory || { status: fleetRefreshPromise ? "refreshing" : "not-generated", refreshIntervalHours: 5 });
    const trackMatch = url.pathname.match(/^\/api\/seasats\/vessels\/(\d+)\/track$/);
    // 点选统计走球形地图的快速轨迹，不再被本体无排序的全量分页查询拖慢。
    if (request.method === "GET" && trackMatch) return sendJson(response, 200, await buildRemoteMapTrack(trackMatch[1]));
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
  // 即使磁盘中存在旧快照，启动后也要用球形地图全量刷新后才允许首屏读取。
  summaryReady = false;
  // 每 30 分钟原子更新一次完整态势；已有历史关联快照时不因重启重复慢算。
  void refreshFleetSnapshot().catch(() => {});
  // 重算期间保留上一份完整快照，避免页面先清空再显示新结果。
  if (!affiliationHistory || affiliationRulesChanged(affiliationHistory)) {
    void refreshAffiliationHistory().catch(() => {});
  }
  setInterval(() => { void refreshFleetSnapshot().catch(() => {}); }, fleetRefreshMs);
  setInterval(() => { void refreshAffiliationHistory().catch(() => {}); }, affiliationRefreshMs);
});
