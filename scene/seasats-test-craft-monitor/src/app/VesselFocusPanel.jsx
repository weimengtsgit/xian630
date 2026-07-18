import React from "react";
import { AlertTriangle } from "lucide-react";

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

function textOrFallback(value, fallback = "--") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function relationEntry({ name, mmsi, relation, key }) {
  return React.createElement(
    "div",
    { className: "affiliation-match", key },
    React.createElement("strong", null, name),
    React.createElement("small", null, `${mmsi} · ${relation.relationType}`),
    React.createElement("span", null, relation.relationType === "同步伴随"
      ? `同步均距 ${formatNumber(relation.sync.averageDistanceNm, 2)} 海里`
      : `时延 ${formatDurationMinutes(relation.lag.lagMinutes)}，均距 ${formatNumber(relation.lag.averageDistanceNm, 2)} 海里`),
  );
}

function formatChartTime(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(time).replace(",", " ");
}

function distanceEvidence({ relation, name }) {
  const series = relation?.lag?.distanceSeries || [];
  if (relation?.relationType !== "时延跟随" || series.length < 2) return null;
  const values = series.map((item) => numberOrNull(item.distanceNm)).filter((value) => value !== null);
  if (values.length < 2) return null;
  const width = 300;
  const height = 120;
  const plot = { left: 30, right: 6, top: 16, bottom: 88 };
  const thresholdNm = 100;
  // 纵轴至少覆盖判定阈值，曲线相对阈值的位置才能直观反映关联依据。
  const maxDistance = Math.max(...values, thresholdNm, 1);
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = plot.bottom - plot.top;
  const xFor = (index) => plot.left + (index / (series.length - 1)) * plotWidth;
  const yFor = (distance) => plot.bottom - (distance / maxDistance) * plotHeight;
  const points = series.map((item, index) => {
    const distance = numberOrNull(item.distanceNm);
    if (distance === null) return null;
    const x = xFor(index);
    const y = yFor(distance);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(" ");
  const timeIndexes = [...new Set([0, Math.round((series.length - 1) / 2), series.length - 1])];
  const yTicks = [maxDistance, maxDistance / 2, 0];
  return React.createElement(
    "section",
    { className: "affiliation-evidence", key: `evidence-${relation.carrier.mmsi}` },
    React.createElement("strong", null, `关联依据：${name} 的时延对齐距离`),
    React.createElement("small", null, `延迟 ${formatDurationMinutes(relation.lag.lagMinutes)} · 平均 ${formatNumber(relation.lag.averageDistanceNm, 2)} 海里 · ${formatCount(relation.lag.matchedPoints)} 个匹配点（判定阈值 100 海里）`),
    React.createElement(
      "svg",
      { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": `${name} 时延对齐后的距离曲线` },
      yTicks.map((tick) => React.createElement(React.Fragment, { key: `y-${tick}` },
        React.createElement("line", { x1: plot.left, x2: width - plot.right, y1: yFor(tick), y2: yFor(tick), className: "affiliation-evidence-grid" }),
        React.createElement("text", { x: plot.left - 4, y: yFor(tick) + 3, textAnchor: "end", className: "affiliation-evidence-label" }, formatNumber(tick, tick >= 10 ? 0 : 1)),
      )),
      timeIndexes.map((index) => React.createElement(React.Fragment, { key: `x-${index}` },
        React.createElement("line", { x1: xFor(index), x2: xFor(index), y1: plot.top, y2: plot.bottom, className: "affiliation-evidence-grid vertical" }),
        React.createElement("text", { x: xFor(index), y: plot.bottom + 13, textAnchor: index === 0 ? "start" : index === series.length - 1 ? "end" : "middle", className: "affiliation-evidence-label" }, formatChartTime(series[index]?.time)),
      )),
      React.createElement("line", { x1: plot.left, x2: width - plot.right, y1: yFor(thresholdNm), y2: yFor(thresholdNm), className: "affiliation-evidence-threshold" }),
      React.createElement("text", { x: width - plot.right, y: yFor(thresholdNm) - 3, textAnchor: "end", className: "affiliation-evidence-threshold-label" }, "阈值 100 海里"),
      React.createElement("text", { x: plot.left, y: 10, className: "affiliation-evidence-label title" }, "距离（海里）"),
      React.createElement("polyline", { points, className: "affiliation-evidence-line" }),
      React.createElement("text", { x: width / 2, y: height - 2, textAnchor: "middle", className: "affiliation-evidence-label title" }, "时间（北京时间）"),
    ),
    React.createElement("span", null, `曲线范围 ${formatNumber(Math.min(...values), 2)}–${formatNumber(maxDistance, 2)} 海里；越低表示轨迹越接近。`),
  );
}

function affiliationContent(affiliation, selectedMmsi, allAffiliations, allTargets) {
  if (!affiliation || affiliation.status === "refreshing" || affiliation.status === "not-generated") {
    return React.createElement("p", { className: "affiliation-empty" }, "历史关联正在计算，完成后自动展示。");
  }
  if (affiliation.status === "carrier") {
    const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
    const relatedVessels = Object.entries(allAffiliations || {}).flatMap(([mmsi, item]) => (item.carriers || [])
      .filter((relation) => relation.carrier.mmsi === selectedMmsi && relation.relationType !== "未命中")
      .map((relation) => ({ mmsi, name: carrierDisplayName(mmsi, nameByMmsi.get(mmsi)), relation })));
    if (!relatedVessels.length) return React.createElement("p", { className: "affiliation-empty" }, "暂无满足历史关联阈值的舰船。");
    return React.createElement(
      React.Fragment,
      null,
      relatedVessels.map((item) => relationEntry({ ...item, key: `${selectedMmsi}-${item.mmsi}` })),
    );
  }
  if (affiliation.status === "no-track") return React.createElement("p", { className: "affiliation-empty" }, "历史窗口内未获取到该舰艇 AIS 轨迹。");
  const matched = (affiliation.carriers || []).filter((item) => item.relationType !== "未命中");
  if (!matched.length) return React.createElement("p", { className: "affiliation-empty" }, "暂无满足历史关联阈值的航母关联。");
  const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
  return React.createElement(
    React.Fragment,
    null,
    // 卡片使用首页已经识别出的真实船名，避免只显示 CVN-71 一类内部编号。
    matched.map((item) => {
      const name = carrierDisplayName(item.carrier.mmsi, nameByMmsi.get(item.carrier.mmsi) || item.carrier.name);
      return React.createElement(
        React.Fragment,
        { key: item.carrier.mmsi },
        relationEntry({ name, mmsi: item.carrier.mmsi, relation: item, key: item.carrier.mmsi }),
        // 只呈现命中的、时延已对齐的实测距离，避免全量轨迹图造成时间语义误读。
        distanceEvidence({ relation: item, name }),
      );
    }),
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
}) {
  const maxSpeed = valueFrom(selectedTarget, ["maxSpeedKn", "fastestSpeedKn", "maxSpeed"]) ?? selectedTarget?.maxSpeedSegment?.speedKn;
  const avgSpeed = valueFrom(selectedTarget, ["avgSpeedKn", "averageSpeedKn", "avgSpeed"]);
  const heading = valueFrom(selectedTarget, ["headingDeg", "courseDeg", "orientation", "heading"]);
  const activeDays = valueFrom(selectedTarget, ["activeDays", "activityDays"]);
  const aisGapCount = countFrom(selectedTarget, ["aisGapCount", "aisGapsCount", "gapCount"], ["aisGaps"]);
  const alertCount = countFrom(selectedTarget, ["alertCount", "alertsCount"], ["alerts"]);
  const threatScore = valueFrom(selectedTarget, ["threatScore", "score"]);
  const snapshotTime = formatSnapshotTime(affiliationRefreshedAt);

  return React.createElement(
    "aside",
    { className: "vessel-focus-panel", "aria-label": "关注舰艇" },
    React.createElement(
      "header",
      { className: "vessel-focus-header" },
      React.createElement(
        "div",
        null,
        React.createElement("small", null, "关注舰艇"),
        React.createElement("h2", null, vesselName(selectedTarget)),
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
        React.createElement("span", null, "航母关联（历史）"),
        snapshotTime && React.createElement("time", null, `快照：${snapshotTime}`),
      ),
      affiliationContent(affiliation, vesselMmsi(selectedTarget), allAffiliations, allTargets),
    ),
  );
}

export default VesselFocusPanel;
