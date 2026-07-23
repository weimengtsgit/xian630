import React, { useEffect, useRef } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, LineChart, X } from "lucide-react";

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

function formatLagHours(lagMinutes) {
  // 关联卡片中的时延统一按“小时（天）”呈现，如 308.0小时（12.83天）。
  const minutes = numberOrNull(lagMinutes);
  if (minutes === null) return "--";
  const hours = minutes / 60;
  const days = minutes / (60 * 24);
  return `${hours.toFixed(1)}小时（${days.toFixed(2)}天）`;
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

function relationEntry({ name, mmsi, relation, key, followerName, followerCode }) {
  // 卡片中的另一方按代号判定为属舰或无人艇；航母自身不重复添加类型标签。
  const followerLabel = withVesselKind(followerName, followerCode);
  const relationship = relation.relationType === "同步伴随"
    ? `${followerLabel} 与 ${name} 同步伴随`
    // 与使用方 Python 程序的 Lead(参考艇) → Follow(航母) 输出口径一致。
    : `${name} 跟随 ${followerLabel}`;
  const averageDistance = numberOrNull(relation?.lag?.averageDistanceNm);
  const minimumDistance = numberOrNull(relation?.lag?.minimumDistanceNm);
  const matchedPoints = numberOrNull(relation?.lag?.matchedPoints) || 0;
  const courseEvidence = relation?.lag?.courseFilterApplied
    ? "航向误差不超过45°"
    : "航向数据不足，未纳入45°过滤";
  let assessment;
  if (relation.relationType === "同步伴随") {
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
  return React.createElement(
    "div",
    { className: "affiliation-match", key },
    React.createElement("strong", null, relationship),
    React.createElement("small", null, `关联航母 ${mmsi} · ${relation.relationType}`),
    React.createElement("span", null, relation.relationType === "同步伴随"
      ? `同步最小距离 ${formatNumber(relation.sync.minimumDistanceNm, 2)} 海里`
      : `延时时间 ${formatLagHours(relation.lag.lagMinutes)}，最小距离 ${formatNumber(relation.lag.minimumDistanceNm, 2)} 海里`),
    React.createElement("p", { className: "affiliation-assessment" }, assessment),
    operationalAssessment ? React.createElement("p", { className: "affiliation-assessment" }, operationalAssessment) : null,
  );
}

function formatChartTime(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(time).replace(",", " ");
}

function distanceEvidence({ relation, subjectName, subjectCode }) {
  const series = relation?.lag?.distanceSeries || [];
  if (relation?.relationType !== "时延跟随" || series.length < 2) return null;
  const isInterpolated = relation?.lag?.distanceSeriesSource === "interpolated";
  const sourceLabel = isInterpolated ? "插值对齐距离" : "实测对齐距离";
  const subjectLabel = withVesselKind(subjectName, subjectCode);
  const values = series.map((item) => numberOrNull(item.distanceNm)).filter((value) => value !== null);
  if (values.length < 2) return null;
  const width = 300;
  const height = 120;
  const plot = { left: 30, right: 6, top: 16, bottom: 88 };
  const thresholdNm = 100;
  // 纵轴至少覆盖判定阈值，曲线相对阈值的位置才能直观反映关联依据。
  const observedMaxDistance = Math.max(...values);
  const maxDistance = Math.max(observedMaxDistance, thresholdNm, 1);
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
    React.createElement("strong", null, `关联依据：${subjectLabel} 实际轨迹的${sourceLabel}`),
    React.createElement("small", null, `${subjectLabel} 实际报点时间 · ${isInterpolated ? "航母报点稀疏，按关联算法插值对齐" : "原始 AIS 报点对齐"} · 延迟 ${formatDurationMinutes(relation.lag.lagMinutes)} · 最小距离 ${formatNumber(relation.lag.minimumDistanceNm, 2)} 海里 · ${formatCount(relation.lag.matchedPoints)} 个匹配点（判定阈值 100 海里）`),
    React.createElement(
      "svg",
      { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": `${subjectLabel} 实际轨迹时延对齐后的距离曲线` },
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
      React.createElement("text", { x: width / 2, y: height - 2, textAnchor: "middle", className: "affiliation-evidence-label title" }, `${vesselKindLabel(subjectCode)}实际时间（北京时间）`),
    ),
    React.createElement("span", null, `曲线范围 ${formatNumber(Math.min(...values), 2)}–${formatNumber(observedMaxDistance, 2)} 海里；越低表示轨迹越接近。`),
  );
}

function affiliationContent(affiliation, selectedMmsi, selectedName, allAffiliations, allTargets) {
  if (!affiliation || affiliation.status === "refreshing" || affiliation.status === "not-generated") {
    return React.createElement("p", { className: "affiliation-empty" }, "暂无可用的航母关联历史快照。");
  }
  if (affiliation.status === "carrier") {
    const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
    const codeByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.code]));
    const selectedCarrierName = carrierDisplayName(selectedMmsi, nameByMmsi.get(selectedMmsi));
    const relatedVessels = Object.entries(allAffiliations || {}).flatMap(([mmsi, item]) => (item.carriers || [])
      .filter((relation) => relation.carrier.mmsi === selectedMmsi && relation.relationType !== "未命中")
      .map((relation) => ({ mmsi, name: carrierDisplayName(mmsi, nameByMmsi.get(mmsi)), code: codeByMmsi.get(mmsi), relation })));
    if (!relatedVessels.length) return React.createElement("p", { className: "affiliation-empty" }, "暂无满足历史关联阈值的舰船。");
    return React.createElement(
      React.Fragment,
      null,
      relatedVessels.map((item) => relationEntry({ name: selectedCarrierName, mmsi: selectedMmsi, followerName: item.name, followerCode: item.code, relation: item.relation, key: `${selectedMmsi}-${item.mmsi}` })),
    );
  }
  if (affiliation.status === "source-error") return React.createElement("p", { className: "affiliation-empty error", role: "alert" }, "本体轨迹查询失败，暂不生成航母关联结论。");
  const partialSourceWarning = affiliation.status === "partial-source-error"
    ? React.createElement("p", { className: "affiliation-empty error", role: "alert" }, "部分航母轨迹查询失败，当前关联结论不完整。")
    : null;
  if (affiliation.status === "no-track") return React.createElement("p", { className: "affiliation-empty" }, "历史窗口内未获取到该舰艇 AIS 轨迹。");
  const matched = (affiliation.carriers || []).filter((item) => item.relationType !== "未命中");
  if (!matched.length) return partialSourceWarning || React.createElement("p", { className: "affiliation-empty" }, "暂无满足历史关联阈值的航母关联。");
  const nameByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.name]));
  const codeByMmsi = new Map((allTargets || []).map((target) => [target.mmsi, target.code]));
  const followerName = selectedName || nameByMmsi.get(selectedMmsi) || `MMSI ${selectedMmsi}`;
  const followerCode = codeByMmsi.get(selectedMmsi);
  return React.createElement(
    React.Fragment,
    null,
    partialSourceWarning,
    // 卡片使用首页已经识别出的真实船名，避免只显示 CVN-71 一类内部编号。
    matched.map((item) => {
      const name = carrierDisplayName(item.carrier.mmsi, nameByMmsi.get(item.carrier.mmsi) || item.carrier.name);
      return React.createElement(
        React.Fragment,
        { key: item.carrier.mmsi },
        relationEntry({ name, mmsi: item.carrier.mmsi, followerName, followerCode, relation: item, key: item.carrier.mmsi }),
        // 只呈现命中的、时延已对齐的实测距离，避免全量轨迹图造成时间语义误读。
        distanceEvidence({ relation: item, subjectName: followerName, subjectCode: followerCode }),
      );
    }),
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
        React.createElement("h2", null, selectedTarget?.displayName || vesselName(selectedTarget)),
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
      affiliationContent(affiliation, vesselMmsi(selectedTarget), vesselName(selectedTarget), allAffiliations, allTargets),
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
