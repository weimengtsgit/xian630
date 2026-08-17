import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AlertTriangle, Anchor, ChevronLeft, ChevronRight, LineChart, X } from "lucide-react";
import { subscribeEscapeKeyTopmost } from "../logic/escapeKey.js";
import { resolveHeadingValue } from "../logic/heading.js";
import { decimateDistanceForRender, decimateTrackForRender } from "../logic/renderDecimation.js";
import { cancelTrackRender, readSettledTrackRender, requestTrackRender } from "../logic/trackRenderCache.js";

const confirmedCarrierNames = {
  "368913000": "乔治·华盛顿号",
  "366984000": "西奥多·罗斯福号",
};

function isGenericVesselName(name) {
  return /^(?:US\s+GOV(?:ERNMENT)?(?:\s+VESSEL)?|US\s+WARSHIP|WARSHIP|美国政府船只)$/i.test(String(name || "").trim());
}

function carrierDisplayName(mmsi, name) {
  // 关联结果必须标明具体航母，不能将 AIS 通用占位名误展示成航母名称。
  return confirmedCarrierNames[mmsi] || (isGenericVesselName(name) ? null : name) || `航母 MMSI ${mmsi}`;
}

// 属舰 / 无人艇按公开舷号判定，不再依赖关联快照里的 role 字段。
// 属舰：DDG/CG/CVN/SSN/LHD/LHA/T-AO/T-AKE/T-AOE；其余均为无人艇。
const ESCORT_HULL_TYPES = new Set(["DDG", "CG", "CVN", "SSN", "LHA", "LHD", "T-AO", "T-AKE", "T-AOE"]);

function hullTypePrefix(code) {
  // "DDG-65" -> "DDG"，"T-AO-200" -> "T-AO"，"T-AKE-11" -> "T-AKE"。
  return String(code || "").toUpperCase().replace(/-?\d+.*$/, "").replace(/-$/, "");
}

export function isEscortVessel(code) {
  return ESCORT_HULL_TYPES.has(hullTypePrefix(code));
}

function vesselKindLabel(code) {
  return isEscortVessel(code) ? "属舰" : "无人艇";
}

function withVesselKind(name, code) {
  const base = String(name || "");
  return /\s(属舰|无人艇)$/.test(base) ? base : `${base} ${vesselKindLabel(code)}`;
}

function textOrFallback(value, fallback = "--") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// 时延有效性：null/undefined/空串/NaN/Infinity 均视为缺失，0 仍为有效时延（Number(null)===0 会误判，需显式排除）。
function isValidLag(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function valueFrom(selectedTarget, keys) {
  for (const key of keys) {
    const value = selectedTarget?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function resolveDisplayedHeading(selectedTarget) {
  return resolveHeadingValue(selectedTarget);
}

function vesselName(selectedTarget) {
  return textOrFallback(
    valueFrom(selectedTarget, ["rightDisplayName", "displayName", "name", "vesselName", "shipName"]),
    "未选择舰艇",
  );
}

function vesselMmsi(selectedTarget) {
  return textOrFallback(valueFrom(selectedTarget, ["mmsi", "MMSI"]), "未知 MMSI");
}

function formatNumber(value, digits = 1) {
  const number = numberOrNull(value);
  if (number === null) return "--";
  return number.toFixed(digits).replace(/\.0$/, "");
}

function formatCount(value) {
  const number = numberOrNull(value);
  return number === null ? "--" : String(Math.max(0, Math.round(number)));
}

function formatHeading(value) {
  const number = numberOrNull(value);
  return number === null ? "--" : `${number.toFixed(0)}°`;
}

function formatDurationMinutes(value) {
  const totalMinutes = numberOrNull(value);
  if (totalMinutes === null) return "--";
  const sign = totalMinutes < 0 ? "-" : "";
  let remaining = Math.abs(Math.round(totalMinutes));
  const days = Math.floor(remaining / (24 * 60));
  remaining %= 24 * 60;
  const hours = Math.floor(remaining / 60);
  const minutes = remaining % 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes || !parts.length) parts.push(`${minutes}分钟`);
  return `${sign}${parts.join("")}`;
}

function formatLagHours(lagMinutes) {
  // 详情弹窗中的时延统一按“小时（天）”呈现，如 308.0小时（12.83天）。
  const minutes = numberOrNull(lagMinutes);
  if (minutes === null) return "--";
  const hours = minutes / 60;
  const days = minutes / (60 * 24);
  return `${hours.toFixed(1)}小时（${days.toFixed(2)}天）`;
}

// 右侧栏紧凑摘要专用：时延按“天”两位小数呈现；非法/缺失时显示“时延未知”，绝不伪造为 0 天。
export function formatLagDays(lagMinutes) {
  if (!isValidLag(lagMinutes)) return "时延未知";
  return `${(Number(lagMinutes) / 60 / 24).toFixed(2)}天`;
}

function formatSnapshotTime(value) {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toLocaleString("zh-CN", { hour12: false });
}

function countFrom(selectedTarget, countKeys, arrayKeys) {
  const explicitCount = valueFrom(selectedTarget, countKeys);
  if (explicitCount !== undefined) return explicitCount;
  for (const key of arrayKeys) {
    const value = selectedTarget?.[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function metric(label, value) {
  return React.createElement(
    "div",
    { className: "vessel-metric", key: label },
    React.createElement("span", null, label),
    React.createElement("strong", null, value),
  );
}

// 多条关联的稳定唯一标识：组合 selectedMmsi + 另一方 MMSI + 关系类型 + 时延分钟，
// 不依赖数组 index，刷新后同一关联仍命中同一 key。
export function affiliationDetailKey({ selectedMmsi, otherMmsi, relationType, lagMinutes }) {
  const lag = isValidLag(lagMinutes) ? Number(lagMinutes) : "nolag";
  return `${selectedMmsi || "?"}::${otherMmsi || "?"}::${relationType || "?"}::${lag}`;
}

// 时延为 0 天的“时延跟随”实际为同步伴随：展示按同步处理，避免出现“时延0天”这类自相矛盾的文案。
// 证据仍取 lag 字段（命中来自时延分析，sync 字段未必命中），不切换到 sync 证据。
function isZeroLagFollow(relation) {
  const lagMinutes = relation?.lag?.lagMinutes;
  return relation?.relationType === "时延跟随" && isValidLag(lagMinutes) && Number(lagMinutes) === 0;
}

// 摘要文案：固定“存在中等强度关联”，沿用现有“航母 跟随 另一方”业务方向，时延按天两位小数。
export function buildAffiliationSummary({ relation, name, followerName, followerCode }) {
  const followerLabel = withVesselKind(followerName, followerCode);
  const isSync = relation?.relationType === "同步伴随";
  // 0 天时延按同步展示，摘要不再出现“时延0天”。
  const displayAsSync = isSync || isZeroLagFollow(relation);
  const lagMinutes = relation?.lag?.lagMinutes;
  const lagValid = isValidLag(lagMinutes);
  const relationship = displayAsSync ? `${followerLabel} 与 ${name} 同步伴随` : `${name} 跟随 ${followerLabel}`;
  // 同步伴随没有有效时延，摘要不带“时延X天”；时延跟随缺失/非法时显示“时延未知”。
  const lagSuffix = displayAsSync ? "" : (lagValid ? `，时延${formatLagDays(lagMinutes)}` : "，时延未知");
  const sentence = `${followerLabel} 与 ${name} 存在中等强度关联，关系为 ${relationship}${lagSuffix}。`;
  return { followerLabel, carrierName: name, relationship, lagMinutes, lagValid, isSync, lagSuffix, sentence };
}

// 研判文本：迁移自原 relationEntry，保留中等/较强分级与保守任务研判；属舰不显示无人艇任务研判。
export function buildAffiliationAssessment({ relation, name, followerLabel, followerCode }) {
  const averageDistance = numberOrNull(relation?.lag?.averageDistanceNm);
  const minimumDistance = numberOrNull(relation?.lag?.minimumDistanceNm);
  const matchedPoints = numberOrNull(relation?.lag?.matchedPoints) || 0;
  const courseEvidence = relation?.lag?.courseFilterApplied
    ? "航向误差不超过45°"
    : "航向数据不足，未纳入45°过滤";
  // 0 天时延已按同步展示，研判依据里不再用“时延匹配”与之矛盾，改用“同步匹配”。
  const zeroLag = isZeroLagFollow(relation);
  const closeMatchLabel = zeroLag ? "近距离同步匹配" : "近距离时延匹配";
  const matchLabel = zeroLag ? "同步匹配" : "时延匹配";
  let assessment;
  if (relation?.relationType === "同步伴随") {
    const syncDistance = numberOrNull(relation?.sync?.averageDistanceNm);
    const syncMinimumDistance = numberOrNull(relation?.sync?.minimumDistanceNm);
    const syncPoints = numberOrNull(relation?.sync?.matchedPoints) || 0;
    assessment = syncDistance !== null && syncDistance <= 10 && syncPoints >= 30
      ? `研判依据：同期近距离匹配 ${formatCount(syncPoints)} 点、最小距离 ${formatNumber(syncMinimumDistance, 2)} 海里，存在较强协同伴随线索。`
      : `研判依据：存在同期轨迹匹配，但证据强度有限；仅凭 AIS 不能推断具体任务。`;
  } else if (averageDistance !== null && averageDistance <= 10 && matchedPoints >= 30) {
    assessment = `研判依据：${closeMatchLabel} ${formatCount(matchedPoints)} 点、最小距离 ${formatNumber(minimumDistance, 2)} 海里、${courseEvidence}，存在较强协同伴随线索。`;
  } else if (averageDistance !== null && averageDistance <= 30 && matchedPoints >= 50) {
    assessment = `研判依据：${matchLabel} ${formatCount(matchedPoints)} 点、最小距离 ${formatNumber(minimumDistance, 2)} 海里、${courseEvidence}，存在中等强度关联线索。`;
  } else {
    assessment = `研判依据：${matchLabel} ${formatCount(matchedPoints)} 点、最小距离 ${formatNumber(minimumDistance, 2)} 海里、${courseEvidence}；未达到近距离伴随水平，尚不支持仅据 AIS 定性具体任务。`;
  }
  // 无人艇与航母形成命中关联时给出保守任务研判，明确该结论仅是 AIS 行为线索而非任务确认。
  const operationalAssessment = !isEscortVessel(followerCode)
    ? `${followerLabel} 疑似在 ${name} 航行活动中承担协同巡逻或侦察任务。`
    : null;
  return { assessment, operationalAssessment };
}

// 关键证据字段：时延跟随取 lag，同步伴随取 sync；缺失字段统一为 null，前端显示 --，不伪造。
export function evidenceFields(relation) {
  const isSync = relation?.relationType === "同步伴随";
  const lag = relation?.lag || {};
  const sync = relation?.sync || {};
  const src = isSync ? sync : lag;
  return {
    matchedPoints: src.matchedPoints,
    minimumDistanceNm: src.minimumDistanceNm,
    averageDistanceNm: src.averageDistanceNm,
    medianDistanceNm: isSync ? null : lag.medianDistanceNm,
    withinThresholdRatio: isSync ? null : lag.withinThresholdRatio,
    maxCourseDifferenceDeg: isSync ? null : lag.maxCourseDifferenceDeg,
    courseFilterApplied: isSync ? null : lag.courseFilterApplied,
    startTime: src.startTime,
    endTime: src.endTime,
    referenceTrackSeries: relation?.referenceTrackSeries,
    carrierTrackSeries: relation?.carrierTrackSeries,
  };
}

// 弹窗状态机：open/switch/close/vessel-switch/snapshot-refresh 均可独立测试，无需 DOM。
export function reduceActiveAffiliationKey(state, action) {
  switch (action?.type) {
    case "open": return action.key || null;
    case "close":
    case "vessel-switch": return null;
    // 快照刷新后若当前关联已不存在则自动关闭，仍在则保持。
    case "snapshot-refresh": return state && action.validKeys?.has(state) ? state : null;
    default: return state;
  }
}

// 遮罩点击判定：仅当点击命中遮罩自身（而非内部弹窗）时关闭。
export function isDialogMaskClick(event) {
  return !!event && event.target === event.currentTarget;
}

// 将键盘焦点约束在 aria-modal 详情弹窗内；Escape 仍由最上层全局监听统一处理。
export function trapDialogFocus(event, dialog) {
  if (event?.key !== "Tab" || !dialog?.querySelectorAll) return false;
  const focusable = [...dialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute?.("aria-hidden") !== "true");
  if (!focusable.length) {
    event.preventDefault?.();
    dialog.focus?.();
    return true;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = dialog.ownerDocument?.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains?.(active))) {
    event.preventDefault?.();
    last.focus?.();
    return true;
  }
  if (!event.shiftKey && (active === last || !dialog.contains?.(active))) {
    event.preventDefault?.();
    first.focus?.();
    return true;
  }
  return false;
}

function resolveAffiliationRelations(affiliation, selectedMmsi, selectedName, allAffiliations, allTargets) {
  if (!affiliation || affiliation.status === "refreshing" || affiliation.status === "not-generated") {
    return { preamble: { text: "暂无可用的航母关联历史快照。", variant: "empty" }, relations: [] };
  }
  if (affiliation.status === "carrier") {
    const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, vesselName(target)]));
    const codeByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.code]));
    const selectedCarrierName = carrierDisplayName(selectedMmsi, nameByMmsi.get(selectedMmsi));
    const relatedVessels = Object.entries(allAffiliations || {}).flatMap(([mmsi, item]) => (item.carriers || [])
      .filter((relation) => relation.carrier.mmsi === selectedMmsi && relation.relationType !== "未命中")
      .map((relation) => ({ mmsi, name: carrierDisplayName(mmsi, nameByMmsi.get(mmsi)), code: codeByMmsi.get(mmsi), relation })));
    if (!relatedVessels.length) return { preamble: { text: "暂无满足历史关联阈值的舰船。", variant: "empty" }, relations: [] };
    return {
      preamble: null,
      // 航母被选中时的反向关联：仍以“航母 跟随 另一方”方向展示，key 含另一方 MMSI 以保证唯一。
      relations: relatedVessels.map((item, index) => ({
        key: affiliationDetailKey({ selectedMmsi, otherMmsi: item.mmsi, relationType: item.relation.relationType, lagMinutes: item.relation.lag?.lagMinutes }),
        relation: item.relation, name: selectedCarrierName, followerName: item.name, followerCode: item.code, followerMmsi: item.mmsi, unanalyzed: item.relation.relationType === "未分析", index,
      })),
    };
  }
  if (affiliation.status === "source-error") return { preamble: { text: "本体轨迹查询失败，暂不生成航母关联结论。", variant: "error" }, relations: [] };
  const partial = affiliation.status === "partial-source-error";
  if (affiliation.status === "no-track") return { preamble: { text: "历史窗口内未获取到该舰艇 AIS 轨迹。", variant: "empty" }, relations: [] };
  const matched = (affiliation.carriers || []).filter((item) => item.relationType !== "未命中");
  if (!matched.length) {
    return { preamble: partial ? { text: "部分航母轨迹查询失败，当前关联结论不完整。", variant: "error" } : { text: "暂无满足历史关联阈值的航母关联。", variant: "empty" }, relations: [] };
  }
  const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, vesselName(target)]));
  const codeByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.code]));
  const followerName = selectedName || nameByMmsi.get(selectedMmsi) || `MMSI ${selectedMmsi}`;
  const followerCode = codeByMmsi.get(selectedMmsi);
  return {
    preamble: partial ? { text: "部分航母轨迹查询失败，当前关联结论不完整。", variant: "error" } : null,
    // 卡片使用首页已经识别出的真实船名，避免只显示 CVN-71 一类内部编号。
    relations: matched.map((item, index) => {
      const name = carrierDisplayName(item.carrier.mmsi, nameByMmsi.get(item.carrier.mmsi) || item.carrier.name);
      return {
        key: affiliationDetailKey({ selectedMmsi, otherMmsi: item.carrier.mmsi, relationType: item.relationType, lagMinutes: item.lag?.lagMinutes }),
        relation: item, name, followerName, followerCode, followerMmsi: selectedMmsi, unanalyzed: item.relationType === "未分析", index,
      };
    }),
  };
}

function formatChartTime(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(time).replace(",", " ");
}

function formatTimeRange(start, end) {
  const s = formatSnapshotTime(start);
  const e = formatSnapshotTime(end);
  if (!s && !e) return "--";
  return `${s || "--"} ~ ${e || "--"}`;
}

function formatRatio(value) {
  const number = numberOrNull(value);
  if (number === null) return "--";
  return `${(number * 100).toFixed(number >= 0.1 ? 0 : 1)}%`;
}

// 航迹图注：文案必须与数据状态一致，不得把服务端抽稀生成的渲染序列说成浏览器“全量逐点绘制”。
export function trackSourceNote(dataState) {
  const prefix = "○ 起点　□ 终点　· ";
  if (dataState === "full") return `${prefix}双方航迹为服务端自 2025-01-01 起全量轨迹生成的渲染序列（保留首尾与分桶极值）；红线覆盖在蓝线之上，重合处仍可辨识双方。`;
  if (dataState === "partial") return `${prefix}一侧航迹为服务端全量渲染序列，另一侧为快照抽稀回退（拉取未完成或失败）；红线覆盖在蓝线之上。`;
  return `${prefix}真实 AIS 航迹抽稀后绘制；红线覆盖在蓝线之上，重合处仍可辨识双方。`;
}

// 航迹对比图：横轴经度、纵轴纬度，两条真实航迹，区分起终点，等比例展示（参考 select0721.py）。
// dataState：full=双方 2025-01-01 起全量报点；partial=一侧全量一侧快照回退；snapshot=快照抽稀序列。
function TrackComparisonChart({ referenceSeries, carrierSeries, referenceLabel, carrierLabel, dataState = "snapshot" }) {
  // 滚轮缩放 + 拖拽平移：transform 作用于 svg，外层 plot 容器裁剪溢出。
  // hooks 必须在早退返回之前调用，保证渲染分支变化时 hook 顺序稳定。
  const plotRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const zoomStateRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  zoomStateRef.current = { zoom, pan };
  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  // 用原生非被动 wheel 监听，才能 preventDefault 阻止弹窗纵向滚动，把滚轮交给缩放。
  // onWheel 经 useCallback 固定身份，并通过 zoomStateRef 读最新值，避免闭包陈旧。
  const onWheel = useCallback((event) => {
    event.preventDefault();
    const el = plotRef.current;
    if (!el) return;
    const { zoom: curZoom, pan: curPan } = zoomStateRef.current;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.min(12, Math.max(1, curZoom * factor));
    if (next === curZoom) return;
    const ratio = next / curZoom;
    // 以光标所在点为锚点缩放：保持该点屏幕位置不变。
    setPan({ x: cx - (cx - curPan.x) * ratio, y: cy - (cy - curPan.y) * ratio });
    setZoom(next);
  }, []);
  // 回调 ref：plot 容器挂载时挂监听、卸载时摘监听。即便从“无数据”早退切换到有数据，
  // 容器重新出现时也会重新挂载监听，不会因 effect 只跑一次而漏挂。
  const setPlotRef = useCallback((el) => {
    const prev = plotRef.current;
    if (prev === el) return;
    if (prev) prev.removeEventListener("wheel", onWheel);
    plotRef.current = el;
    if (el) el.addEventListener("wheel", onWheel, { passive: false });
  }, [onWheel]);
  const onPointerDown = (event) => {
    if (zoom <= 1) return;
    dragRef.current = { x: event.clientX, y: event.clientY, pan: { ...pan } };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* noop */ }
  };
  const onPointerMove = (event) => {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.pan.x + (event.clientX - dragRef.current.x),
      y: dragRef.current.pan.y + (event.clientY - dragRef.current.y),
    });
  };
  const endDrag = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  };
  const width = 360;
  const height = 220;
  const padLeft = 52;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 44;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  // 几何与折线只依赖轨迹序列：全量轨迹（2025-01-01 起所有报点）单船可达十万级，
  // 滚轮缩放/拖拽引起的高频重渲染不得重复构建折线字符串，故整体放入 useMemo。
  const geometry = useMemo(() => {
    const validTrack = (series) => (Array.isArray(series) ? series : [])
      .filter((item) => numberOrNull(item?.lon) !== null && numberOrNull(item?.lat) !== null)
      .map((item) => ({ ...item, lon: Number(item.lon), lat: Number(item.lat) }));
    const ref = validTrack(referenceSeries);
    const car = validTrack(carrierSeries);
    const points = [...ref, ...car].filter((item) => numberOrNull(item?.lon) !== null && numberOrNull(item?.lat) !== null);
    if (points.length < 2 || (ref.length < 2 && car.length < 2)) return null;
    // 全量轨迹点数远超 V8 展开传参上限，min/max 必须用循环而非 Math.min(...spread)。
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const item of points) {
      if (item.lon < minLon) minLon = item.lon;
      if (item.lon > maxLon) maxLon = item.lon;
      if (item.lat < minLat) minLat = item.lat;
      if (item.lat > maxLat) maxLat = item.lat;
    }
    const centerLat = (minLat + maxLat) / 2;
    const longitudeFactor = Math.max(Math.cos(centerLat * Math.PI / 180), 0.2);
    const rawLonRange = Math.max(maxLon - minLon, 1e-4);
    const rawLatRange = Math.max(maxLat - minLat, 1e-4);
    const lonPadding = Math.max(rawLonRange * 0.1, 5e-5);
    const latPadding = Math.max(rawLatRange * 0.1, 5e-5);
    const domainMinLon = minLon - lonPadding;
    const domainMaxLon = maxLon + lonPadding;
    const domainMinLat = minLat - latPadding;
    const domainMaxLat = maxLat + latPadding;
    const lonRange = (domainMaxLon - domainMinLon) * longitudeFactor;
    const latRange = domainMaxLat - domainMinLat;
    // 经度按中心纬度修正后等比例缩放，避免高纬区域被横向拉伸。
    const scale = Math.min(plotW / lonRange, plotH / latRange);
    const offsetX = padLeft + (plotW - lonRange * scale) / 2;
    const offsetY = padTop + (plotH - latRange * scale) / 2;
    const xFor = (lon) => offsetX + (lon - domainMinLon) * longitudeFactor * scale;
    const yFor = (lat) => offsetY + (domainMaxLat - lat) * scale;
    const toPolyline = (series) => series
      .filter((item) => numberOrNull(item?.lon) !== null && numberOrNull(item?.lat) !== null)
      .map((item) => `${xFor(item.lon).toFixed(1)},${yFor(item.lat).toFixed(1)}`)
      .join(" ");
    // 折线只走渲染层抽稀后的序列（保留首尾与分桶极值）；统计与端点标记仍用全量序列。
    const refPoly = toPolyline(decimateTrackForRender(ref));
    const carPoly = toPolyline(decimateTrackForRender(car));
    const allLonTicks = [minLon, (minLon + maxLon) / 2, maxLon];
    // 等比例地理投影可能让实际经度范围只占绘图区中部；像素间距不足时隐藏中间刻度，
    // 并让首尾标签向外展开，避免三个长小数标签挤在一起。
    const lonTicks = xFor(maxLon) - xFor(minLon) < 120
      ? [minLon, maxLon]
      : allLonTicks;
    const latTicks = [maxLat, (minLat + maxLat) / 2, minLat];
    return { ref, car, refPoly, carPoly, lonTicks, latTicks, xFor, yFor };
  }, [referenceSeries, carrierSeries, plotW, plotH]);
  if (!geometry) {
    return React.createElement("p", { className: "affiliation-detail-empty" }, "暂无可用的航迹对比数据。");
  }
  const { ref, car, refPoly, carPoly, lonTicks, latTicks, xFor, yFor } = geometry;
  const endpoint = (series, seriesClass) => {
    const first = series[0];
    const last = series[series.length - 1];
    if (!first || !last) return null;
    // 起止点几何按 1/zoom 反向缩放，避免放大后被巨点占满；屏幕尺寸与未放大时一致。
    const pr = 4 / zoom;
    const ps = 7 / zoom;
    return React.createElement(React.Fragment, null,
      React.createElement("circle", { cx: xFor(first.lon), cy: yFor(first.lat), r: pr, className: `affiliation-track-point ${seriesClass} start` }),
      React.createElement("rect", { x: xFor(last.lon) - ps / 2, y: yFor(last.lat) - ps / 2, width: ps, height: ps, rx: 1 / zoom, className: `affiliation-track-point ${seriesClass} end` }),
    );
  };
  return React.createElement(
    "figure",
    { className: "affiliation-detail-chart affiliation-trajectory-chart" },
    React.createElement("figcaption", null, "航迹对比图"),
    React.createElement("div", { className: "affiliation-chart-plot affiliation-track-plot", ref: setPlotRef, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerLeave: endDrag, onDoubleClick: resetView },
      zoom > 1 ? React.createElement("button", { type: "button", className: "affiliation-track-reset", onClick: resetView, onPointerDown: (e) => e.stopPropagation(), "aria-label": "重置缩放", title: "重置缩放" }, "重置") : null,
      React.createElement("span", { className: "affiliation-track-zoom-hint" }, "滚轮缩放 · 拖拽平移 · 双击复位"),
      React.createElement(
        "svg",
        { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${referenceLabel} 与 ${carrierLabel} 航迹对比`, style: { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0", cursor: zoom > 1 ? "grab" : "default", "--zoom": String(zoom) } },
        lonTicks.map((tick, index) => React.createElement(React.Fragment, { key: `lon-${tick}` },
          React.createElement("line", { x1: xFor(tick), x2: xFor(tick), y1: padTop, y2: padTop + plotH, className: "affiliation-track-grid" }),
          React.createElement("text", {
            x: xFor(tick),
            y: height - 24,
            textAnchor: index === 0 ? "end" : index === lonTicks.length - 1 ? "start" : "middle",
            className: "affiliation-track-label",
          }, tick.toFixed(3)),
        )),
        latTicks.map((tick) => React.createElement(React.Fragment, { key: `lat-${tick}` },
          React.createElement("line", { x1: padLeft, x2: width - padRight, y1: yFor(tick), y2: yFor(tick), className: "affiliation-track-grid" }),
          React.createElement("text", { x: padLeft - 7, y: yFor(tick) + 3, textAnchor: "end", className: "affiliation-track-label" }, tick.toFixed(3)),
        )),
        // 两条均为实线：蓝色本体航迹（较粗）在下，红色航母航迹覆盖其上；以颜色与线宽区分双方，坐标不做视觉偏移。
        ref.length >= 2 ? React.createElement("polyline", { points: refPoly, className: "affiliation-track-line ref", "data-series": "reference" }) : null,
        car.length >= 2 ? React.createElement("polyline", { points: carPoly, className: "affiliation-track-line carrier", "data-series": "carrier" }) : null,
        ref.length >= 2 ? endpoint(ref, "ref") : null,
        car.length >= 2 ? endpoint(car, "carrier") : null,
        React.createElement("text", { x: width / 2, y: height - 5, textAnchor: "middle", className: "affiliation-track-axis" }, "经度"),
        React.createElement("text", { x: 14, y: height / 2, textAnchor: "middle", className: "affiliation-track-axis", transform: `rotate(-90 14 ${height / 2})` }, "纬度"),
      ),
    ),
    React.createElement(
      "div",
      { className: "affiliation-track-html-legend", "aria-label": "航迹图例" },
      React.createElement("span", { className: "ref", title: referenceLabel }, React.createElement("i"), React.createElement("b", null, referenceLabel)),
      React.createElement("span", { className: "carrier", title: carrierLabel }, React.createElement("i"), React.createElement("b", null, carrierLabel)),
    ),
    React.createElement("span", { className: "affiliation-chart-note" }, trackSourceNote(dataState)),
  );
}

// 关联依据：独立横栏展示在航迹对比图与距离曲线图上方（参照智能体研判的显示方式）。
// 距离曲线与 select0721.py 一致，恒为判定采用的插值对齐序列（航母轨迹插值到无人艇报点时刻）。
function distanceBasisLines(relation, subjectLabel) {
  const series = relation?.lag?.distanceSeries || [];
  if (relation?.relationType !== "时延跟随" || series.length < 2) return null;
  const zeroLag = isZeroLagFollow(relation);
  return {
    title: `${subjectLabel} 实际轨迹的插值对齐距离`,
    detail: `${subjectLabel} 实际报点时间 · 航母轨迹按关联算法插值对齐 · 延迟 ${zeroLag ? "同步" : formatDurationMinutes(relation.lag.lagMinutes)} · 最小距离 ${formatNumber(relation.lag.minimumDistanceNm, 2)} 海里 · ${formatCount(relation.lag.matchedPoints)} 个匹配点`,
  };
}

// 距离曲线图：迁移自 distanceEvidence，保留阈值线/插值说明/北京时间；新增中位距离线（如有）。
function DistanceEvidenceChart({ relation, subjectName, subjectCode }) {
  const series = relation?.lag?.distanceSeries || [];
  if (relation?.relationType !== "时延跟随" || series.length < 2) return null;
  const subjectLabel = withVesselKind(subjectName, subjectCode);
  // 循环统计最大/最小值并保留原始索引：禁止 Math.min(...values) 这类展开传参，
  // 全量距离序列可达十万级以上，展开会触发 V8 参数上限 RangeError。
  const entries = [];
  let minValue = Infinity;
  let observedMaxDistance = -Infinity;
  for (let index = 0; index < series.length; index += 1) {
    const distance = numberOrNull(series[index]?.distanceNm);
    if (distance === null) continue;
    entries.push({ index, distance });
    if (distance < minValue) minValue = distance;
    if (distance > observedMaxDistance) observedMaxDistance = distance;
  }
  if (entries.length < 2) return null;
  const width = 360;
  const height = 220;
  const plot = { left: 50, right: 18, top: 22, bottom: 172 };
  const thresholdNm = 500;
  const medianNm = numberOrNull(relation?.lag?.medianDistanceNm);
  const referenceMax = Math.max(observedMaxDistance, thresholdNm, medianNm ?? 0, 1);
  const magnitude = 10 ** Math.floor(Math.log10(referenceMax));
  const maxDistance = Math.ceil((referenceMax * 1.1) / magnitude) * magnitude;
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = plot.bottom - plot.top;
  const xFor = (index) => plot.left + (index / (series.length - 1)) * plotWidth;
  const yFor = (distance) => plot.bottom - (distance / maxDistance) * plotHeight;
  // 折线只走渲染层抽稀（分桶保留距离极值与首尾）；横轴刻度/范围统计仍基于全量序列。
  const points = decimateDistanceForRender(entries)
    .map((entry) => `${xFor(entry.index).toFixed(1)},${yFor(entry.distance).toFixed(1)}`)
    .join(" ");
  const timeIndexes = [...new Set([0, Math.round((series.length - 1) / 2), series.length - 1])];
  const yTicks = [maxDistance, maxDistance / 2, 0];
  return React.createElement(
    "figure",
    { className: "affiliation-detail-chart affiliation-evidence affiliation-distance-chart" },
    React.createElement("figcaption", null, "距离曲线图"),
    React.createElement("div", { className: "affiliation-chart-plot" },
    React.createElement(
      "svg",
      { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${subjectLabel} 实际轨迹时延对齐后的距离曲线` },
      yTicks.map((tick) => React.createElement(React.Fragment, { key: `y-${tick}` },
        React.createElement("line", { x1: plot.left, x2: width - plot.right, y1: yFor(tick), y2: yFor(tick), className: "affiliation-evidence-grid" }),
        React.createElement("text", { x: plot.left - 4, y: yFor(tick) + 3, textAnchor: "end", className: "affiliation-evidence-label" }, formatNumber(tick, tick >= 10 ? 0 : 1)),
      )),
      timeIndexes.map((index) => React.createElement(React.Fragment, { key: `x-${index}` },
        React.createElement("line", { x1: xFor(index), x2: xFor(index), y1: plot.top, y2: plot.bottom, className: "affiliation-evidence-grid vertical" }),
        React.createElement("text", { x: xFor(index), y: plot.bottom + 18, textAnchor: index === 0 ? "start" : index === series.length - 1 ? "end" : "middle", className: "affiliation-evidence-label" }, formatChartTime(series[index]?.time)),
      )),
      React.createElement("line", { x1: plot.left, x2: width - plot.right, y1: yFor(thresholdNm), y2: yFor(thresholdNm), className: "affiliation-evidence-threshold" }),
      React.createElement("text", { x: plot.left - 4, y: yFor(thresholdNm) + 3, textAnchor: "end", className: "affiliation-evidence-label threshold" }, formatNumber(thresholdNm, 0)),
      medianNm !== null ? React.createElement(React.Fragment, null,
        React.createElement("line", { x1: plot.left, x2: width - plot.right, y1: yFor(medianNm), y2: yFor(medianNm), className: "affiliation-evidence-median" }),
        React.createElement("text", { x: plot.left - 4, y: yFor(medianNm) + 3, textAnchor: "end", className: "affiliation-evidence-label median" }, formatNumber(medianNm, 2)),
      ) : null,
      React.createElement("text", { x: plot.left, y: 13, className: "affiliation-evidence-label title" }, "距离（海里）"),
      React.createElement("polyline", { points, className: "affiliation-evidence-line" }),
      React.createElement("text", { x: width / 2, y: height - 8, textAnchor: "middle", className: "affiliation-evidence-label title" }, `${vesselKindLabel(subjectCode)}实际时间（北京时间）`),
    ),
    ),
    React.createElement(
      "div",
      { className: "affiliation-distance-legend", "aria-label": "距离图例" },
      React.createElement("span", { className: "distance" }, React.createElement("i"), "距离"),
      React.createElement("span", { className: "threshold" }, React.createElement("i"), "阈值 500 海里"),
      medianNm !== null ? React.createElement("span", { className: "median" }, React.createElement("i"), `中位距离 ${formatNumber(medianNm, 2)} 海里`) : null,
    ),
    React.createElement("span", { className: "affiliation-chart-note" }, `曲线范围 ${formatNumber(minValue, 2)}–${formatNumber(observedMaxDistance, 2)} 海里；越低表示轨迹越接近。${medianNm !== null ? "" : "（无中位距离数据）"}`),
  );
}

function evidenceCard(label, value) {
  return React.createElement(
    "div",
    { className: "affiliation-evidence-card", key: label },
    React.createElement("span", null, label),
    React.createElement("strong", null, value),
  );
}

// 右侧栏紧凑摘要行：整行为触发器，左侧箭头展开关联详情弹窗（与综合分析悬浮框的展开箭头风格一致）。
function AffiliationSummaryRow({ relation, name, followerName, followerCode, rowKey, onOpen, setTriggerRef }) {
  const summary = buildAffiliationSummary({ relation, name, followerName, followerCode });
  const ariaLabel = `查看${summary.followerLabel}与${name}的关联详情`;
  return React.createElement(
    "button",
    {
      type: "button",
      className: "affiliation-summary-row",
      onClick: onOpen,
      "aria-label": ariaLabel,
      title: ariaLabel,
      ref: (el) => setTriggerRef(rowKey, el),
    },
    React.createElement(ChevronLeft, { size: 16, className: "affiliation-summary-arrow", "aria-hidden": "true" }),
    React.createElement(
      "span",
      { className: "affiliation-summary-text" },
      `${summary.followerLabel} 与 ${name} 存在中等强度关联，关系为 ${summary.relationship}`,
      summary.lagSuffix ? React.createElement("span", { className: "affiliation-lag" }, summary.lagSuffix) : null,
      "。",
    ),
  );
}

// 每条关联自己的详情弹窗：迁移原右侧栏全部详细内容，分区排版。
export function AffiliationDetailDialog({ relation, name, followerName, followerCode, followerMmsi, index, snapshotTime, onClose, closeRef, dialogRef, onMaskClick }) {
  // 航迹对比图数据状态机（不“先画快照再静默替换”，消除打开后一两秒的跳变）：
  // loading 期间只显示占位、不挂载 SVG；双侧渲染序列（track?render=1）都到位或确定回退后，一次性绘制终图。
  const carrierMmsi = relation?.carrier?.mmsi;
  const canLoadTracks = Boolean(followerMmsi && carrierMmsi && typeof fetch === "function");
  // 快照更新后渲染轨迹也必须更新；该 key 同时隔离浏览器缓存，避免长会话展示旧轨迹。
  const trackRenderCacheKey = snapshotTime || "";
  const [trackLoad, setTrackLoad] = useState(() => {
    // 双侧已有缓存结果（上次打开成功）时直接进入就绪态，重复打开不闪 loading。
    const settled = canLoadTracks ? readSettledTrackRender(followerMmsi, carrierMmsi, trackRenderCacheKey) : null;
    if (settled) return { status: "settled", reference: settled.reference, carrier: settled.carrier };
    return { status: canLoadTracks ? "loading" : "settled", reference: null, carrier: null };
  });
  useEffect(() => {
    if (!canLoadTracks) return undefined;
    const settled = readSettledTrackRender(followerMmsi, carrierMmsi, trackRenderCacheKey);
    if (settled) {
      setTrackLoad({ status: "settled", reference: settled.reference, carrier: settled.carrier });
      return undefined;
    }
    setTrackLoad({ status: "loading", reference: null, carrier: null });
    let cancelled = false;
    const referenceEntry = requestTrackRender(followerMmsi, globalThis.fetch, trackRenderCacheKey);
    const carrierEntry = requestTrackRender(carrierMmsi, globalThis.fetch, trackRenderCacheKey);
    Promise.all([referenceEntry.promise, carrierEntry.promise]).then(([reference, carrier]) => {
      if (!cancelled) setTrackLoad({ status: "settled", reference, carrier });
    });
    // 关闭弹窗/切换关联对象/MMSI 变化时取消未完成请求；已完成结果留在缓存中复用，不重复请求。
    return () => {
      cancelled = true;
      cancelTrackRender(followerMmsi, trackRenderCacheKey);
      cancelTrackRender(carrierMmsi, trackRenderCacheKey);
    };
  }, [followerMmsi, carrierMmsi, canLoadTracks, trackRenderCacheKey]);
  if (!relation) return null;
  const followerLabel = withVesselKind(followerName, followerCode);
  const isSync = relation.relationType === "同步伴随";
  // 0 天时延按同步展示（标签/时延值），证据仍走 lag 字段。
  const zeroLag = isZeroLagFollow(relation);
  const displayAsSync = isSync || zeroLag;
  const summary = buildAffiliationSummary({ relation, name, followerName, followerCode });
  const { assessment, operationalAssessment } = buildAffiliationAssessment({ relation, name, followerLabel, followerCode });
  const evidence = evidenceFields(relation);
  const titleId = `affiliation-detail-title-${index}`;
  // 直接用原始值判定有效性，避免 numberOrNull(null)===0 把缺失时延误判为 0 天。
  const lagValid = isValidLag(relation.lag?.lagMinutes);
  const lagMinutes = lagValid ? Number(relation.lag.lagMinutes) : null;
  const courseEvidenceText = isSync
    ? "≤30°"
    : (evidence.courseFilterApplied ? "≤45°" : "航向数据不足");
  const direction = `${name} → ${followerLabel}`;
  const lagTag = displayAsSync ? "同步伴随" : `${lagValid ? `${lagMinutes >= 0 ? "+" : ""}${(lagMinutes / 60 / 24).toFixed(1)}` : "?"}d 时延跟随`;
  const hasDistanceChart = !isSync && Array.isArray(relation.lag?.distanceSeries) && relation.lag.distanceSeries.length >= 2;
  const basis = distanceBasisLines(relation, followerLabel);
  // 航迹序列优先使用服务端渲染序列（track?render=1），失败侧回退快照抽稀序列；双侧都失败为快照态。
  const referenceSeries = trackLoad.reference || evidence.referenceTrackSeries;
  const carrierSeries = trackLoad.carrier || evidence.carrierTrackSeries;
  // 只有双侧渲染序列都拉取成功才标注“服务端全量渲染”；任一侧失败/为空必须明确标注回退。
  const trackDataState = trackLoad.reference && trackLoad.carrier ? "full" : trackLoad.reference || trackLoad.carrier ? "partial" : "snapshot";
  return React.createElement(
    "div",
    { className: "affiliation-detail-mask", role: "presentation", onClick: onMaskClick },
    React.createElement(
      "div",
      {
        className: "affiliation-detail-dialog",
        ref: dialogRef,
        tabIndex: -1,
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        onKeyDown: (event) => trapDialogFocus(event, event.currentTarget),
      },
      React.createElement(
        "header",
        { className: "affiliation-detail-head" },
        React.createElement(
          "div",
          { className: "affiliation-detail-title" },
          React.createElement(Anchor, { size: 16, "aria-hidden": "true" }),
          React.createElement("strong", { id: titleId }, "航母关联分析"),
          React.createElement("span", { className: "affiliation-detail-index" }, `#${index}`),
          React.createElement("span", { className: `affiliation-detail-tag ${displayAsSync ? "sync" : "lag"}` }, displayAsSync ? "同步伴随" : "时延跟随"),
        ),
        React.createElement(
          "div",
          { className: "affiliation-detail-head-meta" },
          React.createElement("span", null, `${name} · ${followerLabel}`),
          snapshotTime ? React.createElement("time", null, `快照：${snapshotTime}`) : null,
        ),
        React.createElement(
          "button",
          { type: "button", ref: closeRef, className: "affiliation-detail-close", onClick: onClose, "aria-label": "关闭关联详情", title: "关闭关联详情" },
          React.createElement(X, { size: 18, "aria-hidden": "true" }),
        ),
      ),
      React.createElement(
        "div",
        { className: "affiliation-detail-body" },
        // 2. 关系方向区
        React.createElement(
          "section",
          { className: "affiliation-detail-direction" },
          React.createElement("strong", null, direction),
          React.createElement("span", { className: "affiliation-detail-lagtag" }, lagTag),
        ),
        // 3. 研判结论区
        React.createElement(
          "section",
          { className: "affiliation-detail-conclusion" },
          React.createElement("span", { className: "affiliation-detail-strength" }, "中等关联"),
          React.createElement("span", null, "关系描述：", summary.relationship),
          isSync
            ? React.createElement("span", null, "同步伴随无有效时延。")
            : zeroLag
              ? React.createElement("span", null, "同步伴随（无时延）")
              : React.createElement("span", null, "时延：", lagValid ? formatLagHours(relation.lag.lagMinutes) : "--"),
          React.createElement("span", null, "阈值内比例：", formatRatio(evidence.withinThresholdRatio)),
        ),
        // 4. 智能体研判区（只给研判结论句，移到关键证据之上）
        operationalAssessment
          ? React.createElement(
              "section",
              { className: "affiliation-detail-judgement" },
              React.createElement("h4", null, "智能体研判"),
              React.createElement("p", null, operationalAssessment),
            )
          : null,
        // 5. 关键证据指标卡
        React.createElement(
          "section",
          { className: "affiliation-detail-evidence" },
          React.createElement("h4", null, "关键证据"),
          React.createElement(
            "div",
            { className: "affiliation-evidence-grid" },
            evidenceCard("匹配点数", formatCount(evidence.matchedPoints)),
            evidenceCard("最小距离", `${formatNumber(evidence.minimumDistanceNm, 2)} 海里`),
            evidenceCard("平均距离", `${formatNumber(evidence.averageDistanceNm, 2)} 海里`),
            evidenceCard("中位距离", `${formatNumber(evidence.medianDistanceNm, 2)} 海里`),
            evidenceCard("航向偏差", courseEvidenceText),
            evidenceCard("阈值内比例", formatRatio(evidence.withinThresholdRatio)),
            evidenceCard("关联时间范围", formatTimeRange(evidence.startTime, evidence.endTime)),
          ),
        ),
        // 6. 关联依据区：独立一横栏（与智能体研判同级的整行卡片），不与图表放在同一区块。
        basis
          ? React.createElement(
              "section",
              { className: "affiliation-detail-basis" },
              React.createElement("h4", null, "关联依据"),
              React.createElement("p", { title: basis.title }, basis.title),
              React.createElement("p", null, basis.detail),
            )
          : null,
        // 7. 可视化证据区
        React.createElement(
          "section",
          { className: "affiliation-detail-charts" },
          trackLoad.status !== "settled"
            // loading：占位且不挂载 SVG，杜绝“快照图→全量图”的两阶段展示跳变。
            ? React.createElement(
                "figure",
                { className: "affiliation-detail-chart affiliation-trajectory-chart" },
                React.createElement("figcaption", null, "航迹对比图"),
                React.createElement("div", { className: "affiliation-chart-plot affiliation-track-loading", role: "status" }, "正在加载航迹数据…"),
              )
            : React.createElement(
                TrackComparisonChart,
                { referenceSeries, carrierSeries, referenceLabel: followerLabel, carrierLabel: name, dataState: trackDataState },
              ),
          hasDistanceChart
            ? React.createElement(DistanceEvidenceChart, { relation, subjectName: followerName, subjectCode: followerCode })
            : React.createElement("p", { className: "affiliation-detail-empty" }, isSync ? "同步伴随不产生时延距离曲线。" : "暂无可用的距离曲线数据。"),
        ),
      ),
    ),
  );
}

// 预测区块独立渲染：预留 prediction 数据接口，当前无预测接口时展示空状态，不得用历史数据冒充。
// 预留结构（待对接）：{ status, refreshedAt, entries: [{ carrier: { mmsi, name }, relationType, predictedWindow: { start, end }, confidence, note }] }
function predictionEntry(entry, name, carrierNamesByMmsi, key) {
  // 预测接口未上线，载荷可能含 null/畸形 entry；统一防御，缺字段用占位，绝不抛错。
  if (!entry || typeof entry !== "object") return null;
  const { carrier, relationType, predictedWindow, confidence, note } = entry;
  const carrierName = carrier?.mmsi || carrier?.name
    ? carrierDisplayName(carrier?.mmsi, carrierNamesByMmsi.get(carrier?.mmsi) || carrier?.name)
    : "未知关联对象";
  const windowLabel = predictedWindow && (predictedWindow.start || predictedWindow.end)
    ? `${formatSnapshotTime(predictedWindow.start) || "?"} ~ ${formatSnapshotTime(predictedWindow.end) || "?"}`
    : null;
  const confidenceLabel = confidence != null && Number.isFinite(Number(confidence))
    ? `${Math.round(Number(confidence) * 100)}%`
    : null;
  return React.createElement(
    "div",
    { className: "affiliation-match", key },
    React.createElement("strong", null, `${name} 预计与 ${carrierName} ${relationType || "关联"}`),
    React.createElement("small", null, [windowLabel, confidenceLabel && `置信度 ${confidenceLabel}`].filter(Boolean).join(" · ")),
    note ? React.createElement("p", { className: "affiliation-assessment" }, note) : null,
  );
}

function predictionContent(prediction, selectedName, allTargets) {
  if (!prediction || prediction.status === "refreshing" || prediction.status === "not-generated") {
    return React.createElement("p", { className: "affiliation-empty" }, "暂无可用的关联预测数据。");
  }
  if (prediction.status === "source-error") {
    return React.createElement("p", { className: "affiliation-empty error", role: "alert" }, "本体轨迹查询失败，暂不生成关联预测。");
  }
  // 过滤 null/非对象 entry，避免渲染时解构抛错；全部无效时回落到空状态。
  const entries = (prediction.entries || []).filter((entry) => entry && typeof entry === "object");
  if (!entries.length) {
    return React.createElement("p", { className: "affiliation-empty" }, "暂无可用的关联预测数据。");
  }
  const carrierNamesByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, vesselName(target)]));
  return React.createElement(
    React.Fragment,
    null,
    // key 仅用 index，保证多个同名 carrier entry 也不重复。
    entries.map((entry, index) => predictionEntry(
      entry,
      selectedName,
      carrierNamesByMmsi,
      `prediction-${index}`,
    )),
  );
}

export function VesselFocusPanel({
  selectedTarget,
  affiliation,
  affiliationRefreshedAt,
  allAffiliations,
  allTargets,
  visibleAlertCount = 0,
  onAlertToggle,
  prediction,
  analysisPanel,
  showAnalysisOverlay = false,
  onToggleAnalysisOverlay,
}) {
  const analysisToggleRef = useRef(null);
  const analysisCloseRef = useRef(null);
  const analysisOverlayRef = useRef(null);
  const wasAnalysisOpenRef = useRef(false);
  // 收起回调存入 ref，避免 onToggleAnalysisOverlay 每次渲染重建导致监听反复重挂。
  const toggleAnalysisRef = useRef(onToggleAnalysisOverlay);
  toggleAnalysisRef.current = onToggleAnalysisOverlay;
  useEffect(() => {
    if (showAnalysisOverlay) {
      wasAnalysisOpenRef.current = true;
      analysisCloseRef.current?.focus();
      return;
    }
    if (wasAnalysisOpenRef.current) {
      wasAnalysisOpenRef.current = false;
      analysisToggleRef.current?.focus();
    }
  }, [showAnalysisOverlay]);

  // 点击悬浮框之外的任意位置（右侧栏、地图、左侧栏、顶栏等）自动收起。
  // 仅 mousedown：框内内容（含 X 按钮）不收起，关闭交由各自 onClick 触发，防止二次切换。
  // 不再把右侧栏整体排除——否则小屏居中弹窗时点背后右侧栏无法收起，丢失“点其他位置收起”。
  // 依赖仅 showAnalysisOverlay：打开/关闭切换时挂载/卸载监听，其余重渲染不重挂。
  useEffect(() => {
    if (!showAnalysisOverlay) return undefined;
    const onPointerDown = (event) => {
      const overlay = analysisOverlayRef.current;
      if (overlay?.contains(event.target)) return;
      toggleAnalysisRef.current?.();
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [showAnalysisOverlay]);

  // 关联详情弹窗状态：多条关联各自独立 key，切换舰艇/快照刷新后自动收起。
  const [activeAffiliationKey, dispatch] = useReducer(reduceActiveAffiliationKey, null);
  const affiliationCloseRef = useRef(null);
  const affiliationDialogRef = useRef(null);
  const affiliationTriggerRefs = useRef({});
  const vesselHeadingRef = useRef(null);
  const wasAffiliationOpenRef = useRef(false);
  const prevAffiliationKeyRef = useRef(null);
  const setTriggerRef = useCallback((key, element) => {
    if (element) affiliationTriggerRefs.current[key] = element;
    else delete affiliationTriggerRefs.current[key];
  }, []);

  const selectedMmsi = valueFrom(selectedTarget, ["mmsi", "MMSI"]);
  const selectedName = vesselName(selectedTarget);
  const { preamble, relations } = useMemo(
    () => resolveAffiliationRelations(affiliation, selectedMmsi, selectedName, allAffiliations, allTargets),
    [affiliation, selectedMmsi, selectedName, allAffiliations, allTargets],
  );
  const validKeys = useMemo(() => new Set(relations.map((item) => item.key)), [relations]);
  const activeRelation = relations.find((item) => item.key === activeAffiliationKey) || null;

  // 切换舰艇后旧舰艇的详情弹窗必须自动关闭。
  useEffect(() => { dispatch({ type: "vessel-switch" }); }, [selectedMmsi]);
  // 关联快照刷新后若当前关联已不存在，自动关闭弹窗；仍在则保持。
  useEffect(() => { dispatch({ type: "snapshot-refresh", validKeys }); }, [validKeys]);
  // Escape 优先关闭最上层关联详情弹窗，并阻止事件冒泡到综合分析悬浮框监听。
  useEffect(() => {
    if (!activeAffiliationKey) return undefined;
    return subscribeEscapeKeyTopmost(window, () => dispatch({ type: "close" }));
  }, [activeAffiliationKey]);
  // 焦点管理：打开聚焦关闭按钮，关闭恢复到触发该条的“查看详情”按钮。
  useEffect(() => {
    if (activeAffiliationKey) {
      wasAffiliationOpenRef.current = true;
      affiliationCloseRef.current?.focus();
    } else if (wasAffiliationOpenRef.current) {
      wasAffiliationOpenRef.current = false;
      const closedKey = prevAffiliationKeyRef.current;
      const trigger = closedKey ? affiliationTriggerRefs.current[closedKey] : null;
      if (trigger?.isConnected !== false) trigger?.focus();
      else vesselHeadingRef.current?.focus();
    }
    prevAffiliationKeyRef.current = activeAffiliationKey;
  }, [activeAffiliationKey]);

  const maxSpeed = valueFrom(selectedTarget, ["maxSpeedKn", "fastestSpeedKn", "maxSpeed"]) ?? selectedTarget?.maxSpeedSegment?.speedKn;
  const avgSpeed = valueFrom(selectedTarget, ["avgSpeedKn", "averageSpeedKn", "avgSpeed"]);
  const heading = resolveDisplayedHeading(selectedTarget);
  const activeDays = valueFrom(selectedTarget, ["activeDays", "activityDays"]);
  const aisGapCount = countFrom(selectedTarget, ["aisGapCount", "aisGapsCount", "gapCount"], ["aisGaps"]);
  const alertCount = countFrom(selectedTarget, ["alertCount", "alertsCount"], ["alerts"]);
  const threatScore = valueFrom(selectedTarget, ["threatScore", "score"]);
  const snapshotTime = formatSnapshotTime(affiliationRefreshedAt);
  const snapshotLabel = snapshotTime || (affiliation?.status === "refreshing" || affiliation?.status === "not-generated" ? "生成中" : null);

  return React.createElement(
    "aside",
    { className: "vessel-focus-panel", "aria-label": "关注舰艇" },
    React.createElement(
      "header",
      { className: "vessel-focus-header" },
      React.createElement(
        "button",
        {
          type: "button",
          ref: analysisToggleRef,
          className: `analysis-overlay-toggle${showAnalysisOverlay ? " open" : ""}`,
          onClick: onToggleAnalysisOverlay,
          "aria-label": showAnalysisOverlay ? "收起分析面板" : "展开分析面板",
          "aria-expanded": showAnalysisOverlay,
          title: showAnalysisOverlay ? "收起分析面板" : "展开分析面板",
        },
        React.createElement(showAnalysisOverlay ? ChevronRight : ChevronLeft, { size: 16 }),
        React.createElement("span", { className: "analysis-overlay-toggle-text" }, showAnalysisOverlay ? "收起" : "展开"),
      ),
      React.createElement(
        "div",
        null,
        React.createElement("small", null, "关注舰艇"),
        React.createElement("h2", { ref: vesselHeadingRef, tabIndex: -1 }, vesselName(selectedTarget)),
        React.createElement("p", null, "MMSI：", vesselMmsi(selectedTarget)),
      ),
      React.createElement(
        "div",
        { className: "vessel-header-actions" },
        React.createElement(
          "button",
          { className: `vessel-alert-toggle ${visibleAlertCount ? "has" : ""}`, onClick: onAlertToggle, "aria-label": "告警列表" },
          React.createElement(AlertTriangle, { size: 18 }),
          React.createElement("span", null, formatCount(visibleAlertCount)),
        ),
        React.createElement(
          "div",
          { className: "vessel-threat-score" },
          React.createElement("span", null, "威胁分"),
          React.createElement("strong", null, formatNumber(threatScore, 0)),
        ),
      ),
    ),
    selectedTarget?.dataUnavailable
      ? React.createElement("p", { className: "vessel-data-error", role: "alert" }, "本体轨迹查询失败，当前舰艇威胁分不可用。")
      : null,
    React.createElement(
      "div",
      { className: "vessel-metric-grid" },
      metric("最快速度", `${formatNumber(maxSpeed)} 节`),
      metric("平均速度", `${formatNumber(avgSpeed)} 节`),
      metric("航向/方向", formatHeading(heading)),
      metric("活动天数", `${formatNumber(activeDays, 0)} 天`),
      metric("AIS 中断数", `${formatCount(aisGapCount)} 次`),
      metric("告警数", `${formatCount(alertCount)} 条`),
    ),
    React.createElement(
      "section",
      { className: "vessel-affiliation" },
      React.createElement(
        "h3",
        null,
        React.createElement("span", null, "与航母打击群关联分析（历史）"),
        snapshotLabel && React.createElement("time", null, `快照：${snapshotLabel}`),
      ),
      preamble
        ? React.createElement("p", { className: preamble.variant === "error" ? "affiliation-empty error" : "affiliation-empty", role: preamble.variant === "error" ? "alert" : undefined }, preamble.text)
        : null,
      // 命中关联：每条只展示紧凑摘要 + “查看详情”，完整研判与距离证据进入各自弹窗。
      relations.map((item) => (item.unanalyzed
        // 整轨无有效航向的配对不做关联分析（客户 2026-08-15 确认）：静态行说明原因，不可点开详情。
        ? React.createElement("p", { key: item.key, className: "affiliation-empty affiliation-unanalyzed" }, `${withVesselKind(item.followerName, item.followerCode)} 与 ${item.name}：航向数据不足，未进行关联分析。`)
        : React.createElement(AffiliationSummaryRow, {
          key: item.key,
          rowKey: item.key,
          relation: item.relation,
          name: item.name,
          followerName: item.followerName,
          followerCode: item.followerCode,
          onOpen: () => dispatch({ type: "open", key: item.key }),
          setTriggerRef,
        }))),
      activeRelation
        ? React.createElement(AffiliationDetailDialog, {
            // 按关联 key 重建弹窗：切换关联对象时航迹加载状态机从头开始，不残留上一条的渲染序列。
            key: `${activeRelation.key}::${snapshotTime || ""}`,
            relation: activeRelation.relation,
            name: activeRelation.name,
            followerName: activeRelation.followerName,
            followerCode: activeRelation.followerCode,
            followerMmsi: activeRelation.followerMmsi,
            index: activeRelation.index + 1,
            snapshotTime: snapshotLabel,
            onClose: () => dispatch({ type: "close" }),
          closeRef: affiliationCloseRef,
          dialogRef: affiliationDialogRef,
            onMaskClick: (event) => { if (isDialogMaskClick(event)) dispatch({ type: "close" }); },
          })
        : null,
    ),
    React.createElement(
      "section",
      { className: "vessel-affiliation vessel-prediction" },
      React.createElement(
        "h3",
        null,
        React.createElement("span", null, "与航母打击群关联分析（预测）"),
      ),
      predictionContent(prediction, vesselName(selectedTarget), allTargets),
    ),
    showAnalysisOverlay
      ? React.createElement(
          "div",
          // 非模态浮动面板：地图与侧栏需保持可交互（无焦点陷阱/遮罩），aria-modal=false，避免对辅助技术谎称外部 inert。
          { ref: analysisOverlayRef, className: "analysis-overlay", role: "dialog", "aria-modal": "false", "aria-labelledby": "analysis-overlay-title" },
          React.createElement(
            "div",
            { className: "analysis-overlay-head" },
            React.createElement("strong", { id: "analysis-overlay-title" }, React.createElement(LineChart, { size: 15 }), " 舰艇综合分析"),
            React.createElement(
              "button",
              { type: "button", ref: analysisCloseRef, className: "analysis-overlay-close", onClick: onToggleAnalysisOverlay, "aria-label": "收起分析面板", title: "收起分析面板" },
              React.createElement(X, { size: 16 }),
            ),
          ),
          React.createElement("div", { className: "analysis-overlay-body" }, analysisPanel || null),
        )
      : null,
  );
}

export default VesselFocusPanel;
