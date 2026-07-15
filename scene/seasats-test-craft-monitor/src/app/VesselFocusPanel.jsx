import React from "react";

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

export function VesselFocusPanel({
  selectedTarget,
  visibleCount = 0,
  totalCount = 0,
  focusOnly = false,
  onFocusOnlyChange,
}) {
  const maxSpeed = valueFrom(selectedTarget, ["maxSpeedKn", "fastestSpeedKn", "maxSpeed"]) ?? selectedTarget?.maxSpeedSegment?.speedKn;
  const avgSpeed = valueFrom(selectedTarget, ["avgSpeedKn", "averageSpeedKn", "avgSpeed"]);
  const heading = valueFrom(selectedTarget, ["headingDeg", "courseDeg", "orientation", "heading"]);
  const activeDays = valueFrom(selectedTarget, ["activeDays", "activityDays"]);
  const aisGapCount = countFrom(selectedTarget, ["aisGapCount", "aisGapsCount", "gapCount"], ["aisGaps"]);
  const alertCount = countFrom(selectedTarget, ["alertCount", "alertsCount"], ["alerts"]);
  const threatScore = valueFrom(selectedTarget, ["threatScore", "score"]);
  const visibleLabel = formatCount(visibleCount);
  const totalLabel = formatCount(totalCount);
  const displayStatus = focusOnly
    ? `当前只显示 ${visibleLabel} 艘关注舰艇`
    : `全部 ${totalLabel} 艘舰艇`;

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
        { className: "vessel-threat-score" },
        React.createElement("span", null, "威胁分"),
        React.createElement("strong", null, formatNumber(threatScore, 0)),
      ),
    ),
    React.createElement(
      "div",
      { className: "vessel-focus-state" },
      React.createElement("span", null, "状态：", textOrFallback(valueFrom(selectedTarget, ["status", "state"]), "未知")),
      React.createElement(
        "label",
        { className: "focus-only-toggle" },
        React.createElement("input", {
          type: "checkbox",
          checked: Boolean(focusOnly),
          onChange: (event) => onFocusOnlyChange?.(event.currentTarget.checked),
        }),
        React.createElement("span", null, "只看关注舰艇"),
      ),
    ),
    React.createElement(
      "div",
      { className: "focus-mode-status", "aria-live": "polite" },
      displayStatus,
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
  );
}

export default VesselFocusPanel;
