import React, { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AlertTriangle, Anchor, ChevronLeft, ChevronRight, Eye, LineChart, X } from "lucide-react";
import { subscribeEscapeKeyTopmost } from "../logic/escapeKey.js";

const confirmedCarrierNames = {
  "368913000": "乔治·华盛顿号 (USS George Washington)",
  "366984000": "西奥多·罗斯福号 (USS Theodore Roosevelt)",
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

function isEscortVessel(code) {
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

function vesselName(selectedTarget) {
  return textOrFallback(
    valueFrom(selectedTarget, ["name", "vesselName", "shipName"]),
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

// 摘要文案：固定“存在中等强度关联”，沿用现有“航母 跟随 另一方”业务方向，时延按天两位小数。
export function buildAffiliationSummary({ relation, name, followerName, followerCode }) {
  const followerLabel = withVesselKind(followerName, followerCode);
  const isSync = relation?.relationType === "同步伴随";
  const lagMinutes = relation?.lag?.lagMinutes;
  const lagValid = isValidLag(lagMinutes);
  const relationship = isSync ? `${followerLabel} 与 ${name} 同步伴随` : `${name} 跟随 ${followerLabel}`;
  // 同步伴随没有有效时延，摘要不带“时延X天”；时延跟随缺失/非法时显示“时延未知”。
  const lagSuffix = isSync ? "" : (lagValid ? `，时延${formatLagDays(lagMinutes)}` : "，时延未知");
  const sentence = `${followerLabel} 与 ${name} 存在中等强度关联，关系为 ${relationship}${lagSuffix}。`;
  return { followerLabel, carrierName: name, relationship, lagMinutes, lagValid, isSync, sentence };
}

// 研判文本：迁移自原 relationEntry，保留中等/较强分级与保守任务研判；属舰不显示无人艇任务研判。
export function buildAffiliationAssessment({ relation, name, followerLabel, followerCode }) {
  const averageDistance = numberOrNull(relation?.lag?.averageDistanceNm);
  const minimumDistance = numberOrNull(relation?.lag?.minimumDistanceNm);
  const matchedPoints = numberOrNull(relation?.lag?.matchedPoints) || 0;
  const courseEvidence = relation?.lag?.courseFilterApplied
    ? "航向误差不超过45°"
    : "航向数据不足，未纳入45°过滤";
  let assessment;
  if (relation?.relationType === "同步伴随") {
    const syncDistance = numberOrNull(relation?.sync?.averageDistanceNm);
    const syncMinimumDistance = numberOrNull(relation?.sync?.minimumDistanceNm);
    const syncPoints = numberOrNull(relation?.sync?.matchedPoints) || 0;
    assessment = syncDistance !== null && syncDistance <= 10 && syncPoints >= 30
      ? `研判依据：同期近距离匹配 ${formatCount(syncPoints)} 点、最小距离 ${formatNumber(syncMinimumDistance, 2)} 海里，存在较强协同伴随线索。`
      : `研判依据：存在同期轨迹匹配，但证据强度有限；仅凭 AIS 不能推断具体任务。`;
  } else if (averageDistance !== null && averageDistance <= 10 && matchedPoints >= 30) {
    assessment = `研判依据：近距离时延匹配 ${formatCount(matchedPoints)} 点、最小距离 ${formatNumber(minimumDistance, 2)} 海里、${courseEvidence}，存在较强协同伴随线索。`;
  } else if (averageDistance !== null && averageDistance <= 30 && matchedPoints >= 50) {
    assessment = `研判依据：时延匹配 ${formatCount(matchedPoints)} 点、最小距离 ${formatNumber(minimumDistance, 2)} 海里、${courseEvidence}，存在中等强度关联线索。`;
  } else {
    assessment = `研判依据：时延匹配 ${formatCount(matchedPoints)} 点、最小距离 ${formatNumber(minimumDistance, 2)} 海里、${courseEvidence}；未达到近距离伴随水平，尚不支持仅据 AIS 定性具体任务。`;
  }
  // 无人艇与航母形成命中关联时给出保守任务研判，明确该结论仅是 AIS 行为线索而非任务确认。
  const operationalAssessment = !isEscortVessel(followerCode)
    ? `研判：${followerLabel} 疑似在 ${name} 航行活动中承担协同巡逻或侦察任务；仅据 AIS 无法确认具体任务。`
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
    const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
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
        relation: item.relation, name: selectedCarrierName, followerName: item.name, followerCode: item.code, index,
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
  const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
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
        relation: item, name, followerName, followerCode, index,
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

// 航迹对比图：横轴经度、纵轴纬度，两条真实航迹，区分起终点，等比例展示（参考 select0721.py）。
function TrackComparisonChart({ referenceSeries, carrierSeries, referenceLabel, carrierLabel }) {
  const validTrack = (series) => (Array.isArray(series) ? series : [])
    .filter((item) => numberOrNull(item?.lon) !== null && numberOrNull(item?.lat) !== null)
    .map((item) => ({ ...item, lon: Number(item.lon), lat: Number(item.lat) }));
  const ref = validTrack(referenceSeries);
  const car = validTrack(carrierSeries);
  const points = [...ref, ...car].filter((item) => numberOrNull(item?.lon) !== null && numberOrNull(item?.lat) !== null);
  if (points.length < 2 || (ref.length < 2 && car.length < 2)) {
    return React.createElement("p", { className: "affiliation-detail-empty" }, "暂无可用的航迹对比数据。");
  }
  const lons = points.map((item) => item.lon);
  const lats = points.map((item) => item.lat);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
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
  const width = 360;
  const height = 220;
  const padLeft = 52;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 44;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
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
  const refPoly = toPolyline(ref);
  const carPoly = toPolyline(car);
  const allLonTicks = [minLon, (minLon + maxLon) / 2, maxLon];
  // 等比例地理投影可能让实际经度范围只占绘图区中部；像素间距不足时隐藏中间刻度，
  // 并让首尾标签向外展开，避免三个长小数标签挤在一起。
  const lonTicks = xFor(maxLon) - xFor(minLon) < 120
    ? [minLon, maxLon]
    : allLonTicks;
  const latTicks = [maxLat, (minLat + maxLat) / 2, minLat];
  const endpoint = (series, seriesClass) => {
    const first = series[0];
    const last = series[series.length - 1];
    if (!first || !last) return null;
    return React.createElement(React.Fragment, null,
      React.createElement("circle", { cx: xFor(first.lon), cy: yFor(first.lat), r: 4, className: `affiliation-track-point ${seriesClass} start` }),
      React.createElement("rect", { x: xFor(last.lon) - 3.5, y: yFor(last.lat) - 3.5, width: 7, height: 7, rx: 1, className: `affiliation-track-point ${seriesClass} end` }),
    );
  };
  return React.createElement(
    "figure",
    { className: "affiliation-detail-chart affiliation-trajectory-chart" },
    React.createElement("figcaption", null, "航迹对比图"),
    React.createElement(
      "div",
      { className: "affiliation-chart-description" },
      React.createElement("strong", null, "真实航迹："),
      React.createElement("span", null, "双方 AIS 经纬度序列按统一地理比例绘制"),
      React.createElement("small", null, "红色虚线覆盖在蓝色实线上；轨迹重合时仍可辨识双方。"),
    ),
    React.createElement("div", { className: "affiliation-chart-plot" },
      React.createElement(
        "svg",
        { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${referenceLabel} 与 ${carrierLabel} 航迹对比` },
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
        // 红线采用虚线覆盖在蓝色实线上；轨迹完全重合时仍能从虚线间隙看到双方，坐标不做视觉偏移。
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
    React.createElement("span", { className: "affiliation-chart-note" }, "○ 起点　□ 终点　· 真实 AIS 航迹抽稀后绘制；虚线覆盖处表示两条航迹重合。"),
  );
}

// 距离曲线图：迁移自 distanceEvidence，保留阈值线/插值说明/北京时间；新增中位距离线（如有）。
function DistanceEvidenceChart({ relation, subjectName, subjectCode }) {
  const series = relation?.lag?.distanceSeries || [];
  if (relation?.relationType !== "时延跟随" || series.length < 2) return null;
  const isInterpolated = relation?.lag?.distanceSeriesSource === "interpolated";
  const sourceLabel = isInterpolated ? "插值对齐距离" : "实测对齐距离";
  const subjectLabel = withVesselKind(subjectName, subjectCode);
  const values = series.map((item) => numberOrNull(item.distanceNm)).filter((value) => value !== null);
  if (values.length < 2) return null;
  const width = 360;
  const height = 220;
  const plot = { left: 50, right: 18, top: 22, bottom: 172 };
  const thresholdNm = 100;
  const medianNm = numberOrNull(relation?.lag?.medianDistanceNm);
  const observedMaxDistance = Math.max(...values);
  const referenceMax = Math.max(observedMaxDistance, thresholdNm, medianNm ?? 0, 1);
  const magnitude = 10 ** Math.floor(Math.log10(referenceMax));
  const maxDistance = Math.ceil((referenceMax * 1.1) / magnitude) * magnitude;
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = plot.bottom - plot.top;
  const xFor = (index) => plot.left + (index / (series.length - 1)) * plotWidth;
  const yFor = (distance) => plot.bottom - (distance / maxDistance) * plotHeight;
  const points = series.map((item, index) => {
    const distance = numberOrNull(item.distanceNm);
    if (distance === null) return null;
    return `${xFor(index).toFixed(1)},${yFor(distance).toFixed(1)}`;
  }).filter(Boolean).join(" ");
  const timeIndexes = [...new Set([0, Math.round((series.length - 1) / 2), series.length - 1])];
  const yTicks = [maxDistance, maxDistance / 2, 0];
  return React.createElement(
    "figure",
    { className: "affiliation-detail-chart affiliation-evidence affiliation-distance-chart" },
    React.createElement("figcaption", null, "距离曲线图"),
    React.createElement("div", { className: "affiliation-chart-description" },
      React.createElement("strong", null, "关联依据："),
      React.createElement("span", { title: `${subjectLabel} 实际轨迹的${sourceLabel}` }, `${subjectLabel} 实际轨迹的${sourceLabel}`),
      React.createElement("small", null, `${subjectLabel} 实际报点时间 · ${isInterpolated ? "航母报点稀疏，按关联算法插值对齐" : "原始 AIS 报点对齐"} · 延迟 ${formatDurationMinutes(relation.lag.lagMinutes)} · 最小距离 ${formatNumber(relation.lag.minimumDistanceNm, 2)} 海里 · ${formatCount(relation.lag.matchedPoints)} 个匹配点`),
    ),
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
      medianNm !== null ? React.createElement(React.Fragment, null,
        React.createElement("line", { x1: plot.left, x2: width - plot.right, y1: yFor(medianNm), y2: yFor(medianNm), className: "affiliation-evidence-median" }),
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
      React.createElement("span", { className: "threshold" }, React.createElement("i"), "阈值 100 海里"),
      medianNm !== null ? React.createElement("span", { className: "median" }, React.createElement("i"), `中位距离 ${formatNumber(medianNm, 2)} 海里`) : null,
    ),
    React.createElement("span", { className: "affiliation-chart-note" }, `曲线范围 ${formatNumber(Math.min(...values), 2)}–${formatNumber(observedMaxDistance, 2)} 海里；越低表示轨迹越接近。${medianNm !== null ? "" : "（无中位距离数据）"}`),
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

// 右侧栏紧凑摘要行：仅一句摘要 + “查看详情”按钮，不再直接渲染研判依据与距离证据。
function AffiliationSummaryRow({ relation, name, followerName, followerCode, rowKey, onOpen, setTriggerRef }) {
  const summary = buildAffiliationSummary({ relation, name, followerName, followerCode });
  const ariaLabel = `查看${summary.followerLabel}与${name}的关联详情`;
  return React.createElement(
    "div",
    { className: "affiliation-summary-row" },
    React.createElement("p", { className: "affiliation-summary-text" }, summary.sentence),
    React.createElement(
      "button",
      {
        type: "button",
        className: "affiliation-summary-action",
        onClick: onOpen,
        "aria-label": ariaLabel,
        title: ariaLabel,
        ref: (el) => setTriggerRef(rowKey, el),
      },
      React.createElement(Eye, { size: 14, "aria-hidden": "true" }),
      "查看详情",
    ),
  );
}

// 每条关联自己的详情弹窗：迁移原右侧栏全部详细内容，分区排版。
export function AffiliationDetailDialog({ relation, name, followerName, followerCode, index, snapshotTime, onClose, closeRef, dialogRef, onMaskClick }) {
  if (!relation) return null;
  const followerLabel = withVesselKind(followerName, followerCode);
  const isSync = relation.relationType === "同步伴随";
  const summary = buildAffiliationSummary({ relation, name, followerName, followerCode });
  const { assessment, operationalAssessment } = buildAffiliationAssessment({ relation, name, followerLabel, followerCode });
  const evidence = evidenceFields(relation);
  const titleId = `affiliation-detail-title-${index}`;
  // 直接用原始值判定有效性，避免 numberOrNull(null)===0 把缺失时延误判为 0 天。
  const lagValid = isValidLag(relation.lag?.lagMinutes);
  const lagMinutes = lagValid ? Number(relation.lag.lagMinutes) : null;
  const courseEvidenceText = isSync
    ? "同步航向阈值 ≤30°"
    : (evidence.courseFilterApplied ? `本次最大偏差 ${formatNumber(evidence.maxCourseDifferenceDeg, 0)}°（阈值 ≤45°）` : "航向数据不足，未纳入 45° 过滤");
  const direction = `${name} → ${followerLabel}`;
  const lagTag = isSync ? "同步伴随" : `+${lagValid ? (lagMinutes / 60 / 24).toFixed(1) : "?"}d 时延跟随`;
  const hasDistanceChart = !isSync && Array.isArray(relation.lag?.distanceSeries) && relation.lag.distanceSeries.length >= 2;
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
          React.createElement("span", { className: `affiliation-detail-tag ${isSync ? "sync" : "lag"}` }, isSync ? "同步伴随" : "时延跟随"),
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
            : React.createElement("span", null, "时延：", lagValid ? formatLagHours(relation.lag.lagMinutes) : "--"),
          React.createElement("span", null, "阈值内比例：", formatRatio(evidence.withinThresholdRatio)),
        ),
        // 4. 关键证据指标卡
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
            evidenceCard("航向", courseEvidenceText),
            evidenceCard("阈值内比例", formatRatio(evidence.withinThresholdRatio)),
            evidenceCard("关联时间范围", formatTimeRange(evidence.startTime, evidence.endTime)),
          ),
        ),
        // 5. 可视化证据区
        React.createElement(
          "section",
          { className: "affiliation-detail-charts" },
          React.createElement(
            TrackComparisonChart,
            { referenceSeries: evidence.referenceTrackSeries, carrierSeries: evidence.carrierTrackSeries, referenceLabel: followerLabel, carrierLabel: name },
          ),
          hasDistanceChart
            ? React.createElement(DistanceEvidenceChart, { relation, subjectName: followerName, subjectCode: followerCode })
            : React.createElement("p", { className: "affiliation-detail-empty" }, isSync ? "同步伴随不产生时延距离曲线。" : "暂无可用的距离曲线数据。"),
        ),
        // 6. 智能体研判区
        React.createElement(
          "section",
          { className: "affiliation-detail-judgement" },
          React.createElement("h4", null, "智能体研判"),
          React.createElement("p", null, assessment),
          operationalAssessment ? React.createElement("p", null, operationalAssessment) : null,
          React.createElement("p", { className: "affiliation-detail-limit" }, "以上为基于 AIS 行为的关联线索，仅据 AIS 无法确认具体任务。"),
        ),
      ),
    ),
  );
}

// 预测区块独立渲染：预留 prediction 数据接口，当前无预测接口时展示空状态，不得用历史数据冒充。
// 预留结构（待对接）：{ status, refreshedAt, entries: [{ carrier: { mmsi, name }, relationType, predictedWindow: { start, end }, confidence, note }] }
function predictionEntry(entry, name, key) {
  // 预测接口未上线，载荷可能含 null/畸形 entry；统一防御，缺字段用占位，绝不抛错。
  if (!entry || typeof entry !== "object") return null;
  const { carrier, relationType, predictedWindow, confidence, note } = entry;
  const carrierName = carrier?.mmsi || carrier?.name
    ? carrierDisplayName(carrier?.mmsi, carrier?.name)
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

function predictionContent(prediction, selectedName) {
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
  return React.createElement(
    React.Fragment,
    null,
    // key 仅用 index，保证多个同名 carrier entry 也不重复。
    entries.map((entry, index) => predictionEntry(entry, selectedName, `prediction-${index}`)),
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
  const wasAnalysisOpenRef = useRef(false);
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
  const selectedName = selectedTarget?.displayName || vesselName(selectedTarget);
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
  const heading = valueFrom(selectedTarget, ["headingDeg", "courseDeg", "orientation", "heading"]);
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
      ),
      React.createElement(
        "div",
        null,
        React.createElement("small", null, "关注舰艇"),
        React.createElement("h2", { ref: vesselHeadingRef, tabIndex: -1 }, selectedTarget?.displayName || vesselName(selectedTarget)),
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
      relations.map((item) => React.createElement(AffiliationSummaryRow, {
        key: item.key,
        rowKey: item.key,
        relation: item.relation,
        name: item.name,
        followerName: item.followerName,
        followerCode: item.followerCode,
        onOpen: () => dispatch({ type: "open", key: item.key }),
        setTriggerRef,
      })),
      activeRelation
        ? React.createElement(AffiliationDetailDialog, {
            relation: activeRelation.relation,
            name: activeRelation.name,
            followerName: activeRelation.followerName,
            followerCode: activeRelation.followerCode,
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
      predictionContent(prediction, vesselName(selectedTarget)),
    ),
    showAnalysisOverlay
      ? React.createElement(
          "div",
          // 非模态浮动面板：地图与侧栏需保持可交互（无焦点陷阱/遮罩），aria-modal=false，避免对辅助技术谎称外部 inert。
          { className: "analysis-overlay", role: "dialog", "aria-modal": "false", "aria-labelledby": "analysis-overlay-title" },
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
