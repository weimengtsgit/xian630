const THREAT_LABEL = { critical: "紧急", high: "高危", medium: "中危", low: "低危", none: "平稳" };

export function buildSummary(analysis = {}, params = {}) {
  const alerts = analysis.alerts || [];
  const targets = analysis.targets || [];
  const aisGaps = analysis.aisGaps || [];
  const coastAlerts = alerts.filter((a) => a.type === "coast-proximity");
  const highCoast = coastAlerts.find((a) => a.level === "high");
  const medCoast = coastAlerts.find((a) => a.level === "medium");
  const lowCoast = coastAlerts.find((a) => a.level === "low");
  const criticalGap = aisGaps.some((g) => g.severity === "critical" || (g.gapMinutes || 0) > 360);
  const abnormalTargets = targets.filter((t) => t.status === "异常行为目标");

  let threatLevel = "none";
  if (highCoast || criticalGap || abnormalTargets.length > 0) threatLevel = "critical";
  else if (medCoast) threatLevel = "high";
  else if (lowCoast || alerts.some((a) => a.type === "repeated-activity")) threatLevel = "medium";
  else if (targets.some((t) => (t.score || 0) >= 40)) threatLevel = "low";

  const findings = [];
  const nearest = targets
    .filter((t) => t.minCoastDistanceNm != null)
    .sort((a, b) => a.minCoastDistanceNm - b.minCoastDistanceNm)[0];
  if (nearest) findings.push({ icon: "shore", label: "离国土最近", value: `${nearest.minCoastDistanceNm.toFixed(0)} 海里` });
  const fastest = targets
    .filter((t) => t.maxSpeedSegment)
    .map((t) => ({ name: t.name, sp: t.maxSpeedSegment.speedKn }))
    .sort((a, b) => b.sp - a.sp)[0];
  if (fastest) findings.push({ icon: "gauge", label: "最快航速", value: `${fastest.sp.toFixed(1)} kt` });
  findings.push({ icon: "ship", label: "活跃目标", value: `${targets.length}` });
  if (aisGaps.length) findings.push({ icon: "radio", label: "AIS 异常", value: `${aisGaps.length} 起` });

  const advice = [];
  if (highCoast) advice.push({ level: "high", text: `重点跟监 ${highCoast.targetName}，已进入国土高危警戒（<${params.coastAlertHighNm ?? 80} 海里）` });
  if (criticalGap) advice.push({ level: "high", text: `检测到超 6 小时 AIS 异常，建议核查信号开闭` });
  if (medCoast) advice.push({ level: "medium", text: `${medCoast.targetName} 接近国土，持续关注航向` });
  if (abnormalTargets.length === 0 && threatLevel === "none") advice.push({ level: "low", text: `当前无目标接近国土警戒区` });

  return { threatLevel, threatLabel: THREAT_LABEL[threatLevel], findings, advice };
}
