import { toNumber } from "./domain.js";
import { nearestPointOnCoastNm } from "./coast.js";

function targetPoints(target) {
  if (!target?.segments) return [];
  return target.segments.flatMap((s) => s.points || []);
}

function decimateByCount(arr, maxCount) {
  if (arr.length <= maxCount) return arr;
  const step = Math.ceil(arr.length / maxCount);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  return out;
}

// 选中船速度时序 [{t, v}]（v=kt）
export function speedSeries(target, maxPoints = 80) {
  const pts = decimateByCount(targetPoints(target), maxPoints);
  return pts
    .map((p) => ({ t: p.time, v: toNumber(p.speedKn) }))
    .filter((x) => x.v !== null);
}

// 选中船离国土距离时序 [{t, v}]（v=海里）
export function coastDistanceSeries(target, coast, maxPoints = 80) {
  if (!coast) return [];
  const pts = decimateByCount(targetPoints(target), maxPoints);
  const out = [];
  for (const p of pts) {
    const np = nearestPointOnCoastNm(p, coast);
    if (np.distanceNm !== null) out.push({ t: p.time, v: np.distanceNm });
  }
  return out;
}

export function statusDistribution(targets) {
  const order = [
    { key: "异常行为目标", label: "异常", color: "#ef4444" },
    { key: "高可信目标", label: "高可信", color: "#22c55e" },
    { key: "待核验目标", label: "待核验", color: "#eab308" },
    { key: "仅最新位置", label: "仅位置", color: "#64748b" },
  ];
  return order.map((o) => ({ ...o, count: targets.filter((t) => t.status === o.key).length }));
}

export function alertDistribution(alerts) {
  const sev = [
    { key: "critical", label: "高风险", color: "#dc2626" },
    { key: "warning", label: "关注", color: "#f97316" },
    { key: "info", label: "提示", color: "#38bdf8" },
  ];
  const bySeverity = sev.map((s) => ({ ...s, count: alerts.filter((a) => a.severity === s.key).length }));
  const typeLabel = {
    "sustained-low-speed": "持续低速",
    "repeated-activity": "往返盘旋",
    "ais-gap": "AIS 异常",
    "coast-proximity": "接近国土",
    "dimension-review": "尺寸核验",
  };
  const typeCount = {};
  for (const a of alerts) typeCount[a.type] = (typeCount[a.type] || 0) + 1;
  const byType = Object.entries(typeCount)
    .map(([k, v]) => ({ key: k, label: typeLabel[k] || k, count: v }))
    .sort((a, b) => b.count - a.count);
  return { bySeverity, byType };
}

// 选中船报点的 UTC 小时分布（0-23）
export function hourDistribution(target) {
  const counts = new Array(24).fill(0);
  for (const p of targetPoints(target)) {
    const ms = Date.parse(p.time);
    if (Number.isFinite(ms)) counts[new Date(ms).getUTCHours()] += 1;
  }
  return counts.map((count, h) => ({ h, count }));
}

const DIRS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
// 选中船航向（orientation）8 方向分布
export function headingDistribution(target) {
  const counts = new Array(8).fill(0);
  for (const p of targetPoints(target)) {
    const o = toNumber(p.orientation) ?? toNumber(p.courseDeg);
    if (o === null || !Number.isFinite(o)) continue;
    counts[Math.round(o / 45) % 8] += 1;
  }
  return DIRS.map((dir, i) => ({ dir, count: counts[i] }));
}

// 全部目标离国土距离分布（升序）
export function targetDistanceDistribution(targets) {
  return targets
    .filter((t) => t.minCoastDistanceNm != null)
    .map((t) => ({ name: t.name, mmsi: t.mmsi, dist: t.minCoastDistanceNm, status: t.status }))
    .sort((a, b) => a.dist - b.dist);
}

// 活动天数 Top N
export function activityDaysTop(targets, n = 6) {
  return targets
    .filter((t) => t.activeDays != null)
    .map((t) => ({ name: t.name, days: t.activeDays }))
    .sort((a, b) => b.days - a.days)
    .slice(0, n);
}

// 威胁分构成（复刻 scoreTarget 分项，用于可视化）
export function scoreBreakup(target) {
  const b = { nameHit: 0, dimension: 0, area: 0, track: 0, lowSpeed: 0, repeated: 0, aisGap: 0, coast: 0 };
  if (target?.nameHit) b.nameHit = 30;
  b.dimension = target?.dimension?.score || 0;
  if ((target?.latestAreaIds || []).length > 0) b.area = 10;
  if (target?.hasObservedTrack) b.track = 8;
  const alerts = target?.alerts || [];
  if (alerts.some((a) => a.type === "sustained-low-speed")) b.lowSpeed = 20;
  if (alerts.some((a) => a.type === "repeated-activity")) b.repeated = 15;
  if (alerts.some((a) => a.type === "ais-gap")) b.aisGap = 10;
  const co = alerts.find((a) => a.type === "coast-proximity");
  if (co) b.coast = co.level === "high" ? 25 : co.level === "medium" ? 15 : 8;
  const total = Math.min(100, Object.values(b).reduce((s, v) => s + v, 0));
  const labels = { nameHit: "名称命中", dimension: "尺寸", area: "区域", track: "轨迹", lowSpeed: "持续低速", repeated: "往返盘旋", aisGap: "AIS中断", coast: "接近国土" };
  const items = Object.entries(b).filter(([, v]) => v > 0).map(([k, v]) => ({ key: k, label: labels[k], value: v }));
  return { total, items };
}

// 轨迹活动模式判定
export function classifyPattern(target) {
  const segs = target?.segments || [];
  if (segs.length === 0) return { key: "none", label: "无轨迹", detail: "" };
  const total = segs.reduce((s, seg) => s + (seg.durationMinutes || 0), 0);
  const lowSpeed = segs.reduce((s, seg) => s + (seg.lowSpeedMinutes || 0), 0);
  const maxRatio = Math.max(...segs.map((s) => s.pathDisplacementRatio || 0));
  if (maxRatio >= 3) return { key: "loiter", label: "盘旋/往返测试", detail: `路径位移比 ${maxRatio.toFixed(1)}` };
  if (total > 0 && lowSpeed / total > 0.5) return { key: "linger", label: "低速停留", detail: `低速 ${Math.round(lowSpeed)}分钟` };
  return { key: "transit", label: "直线航行", detail: `${segs.length}段轨迹` };
}

// AIS 信号质量
export function signalQuality(target) {
  const reportCount = target?.reportCount || 0;
  const gaps = target?.aisGaps || [];
  const gapMinutes = gaps.reduce((s, g) => s + (g.gapMinutes || 0), 0);
  return { reportCount, gapCount: gaps.length, gapMinutes };
}

// 各目标告警类型堆叠数据（Top N 有告警目标）
const ALERT_TYPE_META = [
  { key: "sustained-low-speed", label: "持续低速", color: "#f59e0b" },
  { key: "repeated-activity", label: "往返盘旋", color: "#a855f7" },
  { key: "ais-gap", label: "AIS 异常", color: "#ef4444" },
  { key: "coast-proximity", label: "接近国土", color: "#ec4899" },
  { key: "dimension-review", label: "尺寸核验", color: "#64748b" },
];
export function perTargetAlertBreakdown(targets, n = 8) {
  const rows = targets.map((t) => {
    const counts = {};
    for (const a of t.alerts || []) counts[a.type] = (counts[a.type] || 0) + 1;
    return { mmsi: t.mmsi, name: t.name, counts, total: (t.alerts || []).length };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total).slice(0, n);
  return { rows, types: ALERT_TYPE_META };
}
