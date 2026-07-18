import React from "react";

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
      : `时延 ${formatNumber(relation.lag.lagMinutes, 0)} 分钟，均距 ${formatNumber(relation.lag.averageDistanceNm, 2)} 海里`),
  );
}

function affiliationContent(affiliation, refreshedAt, selectedMmsi, allAffiliations, allTargets) {
  if (!affiliation || affiliation.status === "refreshing" || affiliation.status === "not-generated") {
    return React.createElement("p", { className: "affiliation-empty" }, "历史关联正在计算，完成后自动展示。");
  }
  if (affiliation.status === "carrier") {
    const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
    const relatedVessels = Object.entries(allAffiliations || {}).flatMap(([mmsi, item]) => (item.carriers || [])
      .filter((relation) => relation.carrier.mmsi === selectedMmsi && relation.relationType !== "未命中")
      .map((relation) => ({ mmsi, name: carrierDisplayName(mmsi, nameByMmsi.get(mmsi)), relation })));
    if (!relatedVessels.length) return React.createElement("p", { className: "affiliation-empty" }, "暂无满足 MATLAB 阈值的关联舰船。");
    return React.createElement(
      React.Fragment,
      null,
      relatedVessels.map((item) => relationEntry({ ...item, key: `${selectedMmsi}-${item.mmsi}` })),
      refreshedAt && React.createElement("time", { className: "affiliation-time" }, `历史快照：${new Date(refreshedAt).toLocaleString("zh-CN", { hour12: false })}`),
    );
  }
  if (affiliation.status === "no-track") return React.createElement("p", { className: "affiliation-empty" }, "历史窗口内未获取到该舰艇 AIS 轨迹。");
  const matched = (affiliation.carriers || []).filter((item) => item.relationType !== "未命中");
  if (!matched.length) return React.createElement("p", { className: "affiliation-empty" }, "暂无满足 MATLAB 阈值的历史航母关联。");
  const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
  return React.createElement(
    React.Fragment,
    null,
    // 卡片使用首页已经识别出的真实船名，避免只显示 CVN-71 一类内部编号。
    matched.map((item) => relationEntry({ name: carrierDisplayName(item.carrier.mmsi, nameByMmsi.get(item.carrier.mmsi) || item.carrier.name), mmsi: item.carrier.mmsi, relation: item, key: item.carrier.mmsi })),
    refreshedAt && React.createElement("time", { className: "affiliation-time" }, `历史快照：${new Date(refreshedAt).toLocaleString("zh-CN", { hour12: false })}`),
  );
}

export function VesselFocusPanel({
  selectedTarget,
  visibleCount = 0,
  totalCount = 0,
  focusOnly = false,
  onFocusOnlyChange,
  affiliation,
  affiliationRefreshedAt,
  allAffiliations,
  allTargets,
  trackLoading = false,
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
      trackLoading ? "数据加载中…" : displayStatus,
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
      React.createElement("h3", null, "航母关联（历史）"),
      affiliationContent(affiliation, affiliationRefreshedAt, vesselMmsi(selectedTarget), allAffiliations, allTargets),
    ),
  );
}

export default VesselFocusPanel;
