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
