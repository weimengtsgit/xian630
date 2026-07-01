const NM_PER_KM = 0.539956803;
const EARTH_RADIUS_KM = 6371.0088;

export const DEFAULT_PARAMETERS = {
  lowSpeedMaxKn: 3,
  lowSpeedDurationMinutes: 10,
  repeatedPathRatio: 3,
  aisGapWarningMinutes: 30,
  aisGapCriticalMinutes: 360,
  segmentGapMinutes: 360,
  segmentJumpNm: 50,
};

export const STATUS_PRIORITY = {
  "异常行为目标": 0,
  "高可信目标": 1,
  "待核验目标": 2,
  "仅最新位置": 3,
};

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeTargetSpeedKn(raw) {
  const n = toNumber(raw);
  return n === null ? null : Number((n / 10).toFixed(3));
}

export function isNameHit(name) {
  return /^SEASATS?\s*(?:TEST|\d+)\b/i.test(String(name || "").trim());
}

export function dimensionMatch(length, width) {
  const l = toNumber(length);
  const w = toNumber(width);
  if (l === 4 && w === 2) return { level: "strong", label: "4*2 强命中", score: 20 };
  if (l === 3 && w === 2) return { level: "review", label: "3*2 尺寸偏差", score: 12 };
  return { level: "mismatch", label: "尺寸不符", score: 0 };
}

export function isLowSpeed(speedKn, maxKn = DEFAULT_PARAMETERS.lowSpeedMaxKn) {
  const speed = toNumber(speedKn);
  return speed !== null && speed >= 0 && speed <= maxKn;
}

export function haversineNm(a, b) {
  if (!a || !b) return null;
  const lon1 = toNumber(a.lon);
  const lat1 = toNumber(a.lat);
  const lon2 = toNumber(b.lon);
  const lat2 = toNumber(b.lat);
  if ([lon1, lat1, lon2, lat2].some((n) => n === null)) return null;
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)) * NM_PER_KM;
}

export function pointInArea(point, area) {
  if (!point || !area || !area.center) return false;
  const radiusNm = toNumber(area.radiusNm);
  if (radiusNm === null) return false;
  const distance = haversineNm(point, area.center);
  return distance !== null && distance <= radiusNm;
}

export function areaIdsForPoint(point, areas = []) {
  return areas.filter((area) => pointInArea(point, area)).map((area) => area.id);
}

function parseTimeMs(time) {
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? ms : null;
}

function sortedTrack(points = []) {
  return [...points]
    .filter((p) => parseTimeMs(p.time) !== null && toNumber(p.lon) !== null && toNumber(p.lat) !== null)
    .sort((a, b) => parseTimeMs(a.time) - parseTimeMs(b.time));
}

function minutesBetween(a, b) {
  const ams = parseTimeMs(a?.time);
  const bms = parseTimeMs(b?.time);
  if (ams === null || bms === null) return null;
  return (bms - ams) / 60000;
}

function summarizeSegment(points, index, areas, targetMmsi, params) {
  let pathNm = 0;
  let lowSpeedMinutes = 0;
  let maxSpeedKn = 0;
  const areaHits = new Set();

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    areaIdsForPoint(point, areas).forEach((id) => areaHits.add(id));
    const speed = toNumber(point.speedKn);
    if (speed !== null && speed > maxSpeedKn) maxSpeedKn = speed;
    if (i === 0) continue;
    const prev = points[i - 1];
    pathNm += haversineNm(prev, point) || 0;
    const gapMin = minutesBetween(prev, point);
    if (
      gapMin !== null &&
      gapMin >= 0 &&
      gapMin <= params.aisGapWarningMinutes &&
      isLowSpeed(prev.speedKn, params.lowSpeedMaxKn) &&
      isLowSpeed(point.speedKn, params.lowSpeedMaxKn)
    ) {
      lowSpeedMinutes += gapMin;
    }
  }

  const first = points[0];
  const last = points[points.length - 1];
  const displacementNm = points.length > 1 ? haversineNm(first, last) || 0 : 0;
  const durationMinutes = points.length > 1 ? Math.max(0, minutesBetween(first, last) || 0) : 0;
  const lons = points.map((p) => toNumber(p.lon)).filter((n) => n !== null);
  const lats = points.map((p) => toNumber(p.lat)).filter((n) => n !== null);
  const centroid = {
    lon: lons.length ? lons.reduce((sum, n) => sum + n, 0) / lons.length : null,
    lat: lats.length ? lats.reduce((sum, n) => sum + n, 0) / lats.length : null,
  };

  return {
    id: `${targetMmsi || "track"}-seg-${index}`,
    targetMmsi,
    index,
    points,
    startTime: first?.time || null,
    endTime: last?.time || null,
    durationMinutes,
    lowSpeedMinutes,
    pathNm,
    displacementNm,
    pathDisplacementRatio: displacementNm > 0.01 ? pathNm / displacementNm : null,
    maxSpeedKn,
    areaIds: [...areaHits],
    centroid,
  };
}

export function splitTrackSegments(points = [], options = {}) {
  const params = { ...DEFAULT_PARAMETERS, ...options };
  const areas = options.areas || [];
  const sorted = sortedTrack(points);
  const segments = [];
  let current = [];
  let index = 1;
  for (const point of sorted) {
    const prev = current[current.length - 1];
    const gapMin = prev ? minutesBetween(prev, point) : null;
    const jumpNm = prev ? haversineNm(prev, point) : null;
    const split =
      current.length > 0 &&
      ((gapMin !== null && gapMin > params.segmentGapMinutes) ||
        (jumpNm !== null && jumpNm > params.segmentJumpNm));
    if (split) {
      segments.push(summarizeSegment(current, index, areas, current[0]?.mmsi, params));
      current = [];
      index += 1;
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(summarizeSegment(current, index, areas, current[0]?.mmsi, params));
  return segments;
}

export function detectAisGaps(points = [], options = {}) {
  const params = { ...DEFAULT_PARAMETERS, ...options };
  const areas = options.areas || [];
  const sorted = sortedTrack(points);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const point = sorted[i];
    const gapMinutes = minutesBetween(prev, point);
    if (gapMinutes === null || gapMinutes <= params.aisGapWarningMinutes) continue;
    const nearAreaIds = [...new Set([...areaIdsForPoint(prev, areas), ...areaIdsForPoint(point, areas)])];
    gaps.push({
      id: `${point.mmsi || "track"}-gap-${i}`,
      targetMmsi: point.mmsi || prev.mmsi || null,
      fromTime: prev.time,
      toTime: point.time,
      gapMinutes,
      severity: gapMinutes > params.aisGapCriticalMinutes ? "critical" : "warning",
      nearAreaIds,
      from: { lon: toNumber(prev.lon), lat: toNumber(prev.lat) },
      to: { lon: toNumber(point.lon), lat: toNumber(point.lat) },
      lon: (toNumber(prev.lon) + toNumber(point.lon)) / 2,
      lat: (toNumber(prev.lat) + toNumber(point.lat)) / 2,
    });
  }
  return gaps;
}

function areaNames(areaIds, areas) {
  const byId = new Map(areas.map((area) => [area.id, area.name]));
  return areaIds.map((id) => byId.get(id) || id);
}

export function buildAlerts({ target, segments = [], aisGaps = [], areas = [], params = DEFAULT_PARAMETERS }) {
  const alerts = [];
  const targetName = target?.name || target?.mmsi || "目标";
  for (const segment of segments) {
    if (segment.areaIds.length === 0) continue;
    const names = areaNames(segment.areaIds, areas).join(" / ");
    if (segment.lowSpeedMinutes >= params.lowSpeedDurationMinutes) {
      alerts.push({
        id: `${segment.id}-low-speed`,
        targetMmsi: target?.mmsi || segment.targetMmsi,
        targetName,
        type: "sustained-low-speed",
        severity: segment.lowSpeedMinutes >= 60 ? "critical" : "warning",
        title: "持续低速活动",
        summary: `${targetName} 在 ${names} 低速覆盖 ${Math.round(segment.lowSpeedMinutes)} 分钟`,
        time: segment.endTime,
        lon: segment.centroid.lon,
        lat: segment.centroid.lat,
        areaIds: segment.areaIds,
        evidence: [`低速阈值 0-3 节`, `覆盖 ${Math.round(segment.lowSpeedMinutes)} 分钟`, `区域 ${names}`],
      });
    }
    if (
      segment.durationMinutes >= params.lowSpeedDurationMinutes &&
      segment.pathDisplacementRatio !== null &&
      segment.pathDisplacementRatio >= params.repeatedPathRatio
    ) {
      alerts.push({
        id: `${segment.id}-repeated`,
        targetMmsi: target?.mmsi || segment.targetMmsi,
        targetName,
        type: "repeated-activity",
        severity: segment.pathDisplacementRatio >= 10 ? "critical" : "warning",
        title: "疑似往返/盘旋测试",
        summary: `${targetName} 在 ${names} 路径/位移比 ${segment.pathDisplacementRatio.toFixed(1)}`,
        time: segment.endTime,
        lon: segment.centroid.lon,
        lat: segment.centroid.lat,
        areaIds: segment.areaIds,
        evidence: [
          `路径 ${segment.pathNm.toFixed(1)} 海里`,
          `首尾位移 ${segment.displacementNm.toFixed(1)} 海里`,
          `比值 ${segment.pathDisplacementRatio.toFixed(1)}`,
        ],
      });
    }
  }
  for (const gap of aisGaps) {
    const names = areaNames(gap.nearAreaIds, areas);
    alerts.push({
      id: gap.id,
      targetMmsi: target?.mmsi || gap.targetMmsi,
      targetName,
      type: "ais-gap",
      severity: gap.severity,
      title: "疑似 AIS 中断",
      summary: `${targetName} AIS 轨迹缺口 ${Math.round(gap.gapMinutes)} 分钟${names.length ? `，靠近 ${names.join(" / ")}` : ""}`,
      time: gap.toTime,
      lon: gap.lon,
      lat: gap.lat,
      areaIds: gap.nearAreaIds,
      evidence: [`上一点 ${gap.fromTime}`, `下一点 ${gap.toTime}`, `缺口 ${Math.round(gap.gapMinutes)} 分钟`],
    });
  }
  if (target?.dimension?.level === "review") {
    alerts.push({
      id: `${target.mmsi}-dimension-review`,
      targetMmsi: target.mmsi,
      targetName,
      type: "dimension-review",
      severity: "info",
      title: "尺寸近似命中",
      summary: `${targetName} 为 3*2，作为尺寸偏差目标保留核验`,
      time: target.latestTime,
      lon: target.lon,
      lat: target.lat,
      areaIds: target.latestAreaIds || [],
      evidence: ["客户强特征为 4*2", "附件存在 3*2 样本", "保留为待核验对象"],
    });
  }
  return alerts;
}

export function scoreTarget({ nameHit, dimension, latestAreaIds = [], hasObservedTrack, alerts = [] }) {
  let score = 0;
  if (nameHit) score += 30;
  score += dimension?.score || 0;
  if (latestAreaIds.length > 0) score += 10;
  if (hasObservedTrack) score += 8;
  if (alerts.some((a) => a.type === "sustained-low-speed")) score += 20;
  if (alerts.some((a) => a.type === "repeated-activity")) score += 15;
  if (alerts.some((a) => a.type === "ais-gap")) score += 10;
  return Math.min(100, score);
}

function classifyStatus(score, alerts, hasObservedTrack) {
  if (alerts.some((a) => a.severity === "critical" || a.type === "sustained-low-speed" || a.type === "repeated-activity")) return "异常行为目标";
  if (score >= 65 && hasObservedTrack) return "高可信目标";
  if (score >= 40) return "待核验目标";
  return "仅最新位置";
}

export function analyzePayload(payload) {
  const params = { ...DEFAULT_PARAMETERS, ...(payload.parameters || {}) };
  const areas = payload.monitoredAreas || [];
  const trackByMmsi = new Map();
  for (const point of payload.trackPoints || []) {
    const list = trackByMmsi.get(point.mmsi) || [];
    list.push(point);
    trackByMmsi.set(point.mmsi, list);
  }
  const allSegments = [];
  const allGaps = [];
  const allAlerts = [];
  const targets = (payload.targets || []).map((rawTarget) => {
    const latestAreaIds = areaIdsForPoint({ lon: rawTarget.lon, lat: rawTarget.lat }, areas);
    const dimension = dimensionMatch(rawTarget.length, rawTarget.width);
    const nameHit = isNameHit(rawTarget.name);
    const points = trackByMmsi.get(rawTarget.mmsi) || [];
    const hasObservedTrack = points.length > 0;
    const segments = splitTrackSegments(points, { ...params, areas });
    const aisGaps = detectAisGaps(points, { ...params, areas });
    const targetBase = {
      ...rawTarget,
      nameHit,
      dimension,
      latestAreaIds,
      hasObservedTrack,
      trackSource: hasObservedTrack ? "真实附件轨迹" : "仅最新位置",
    };
    const alerts = buildAlerts({ target: targetBase, segments, aisGaps, areas, params });
    const score = scoreTarget({ nameHit, dimension, latestAreaIds, hasObservedTrack, alerts });
    const status = classifyStatus(score, alerts, hasObservedTrack);
    const target = { ...targetBase, segments, aisGaps, alerts, score, status };
    allSegments.push(...segments);
    allGaps.push(...aisGaps);
    allAlerts.push(...alerts);
    return target;
  });
  return {
    ...payload,
    parameters: params,
    targets: sortAnalyses(targets),
    segments: allSegments,
    aisGaps: allGaps,
    alerts: allAlerts.sort((a, b) => {
      const severity = { critical: 0, warning: 1, info: 2 };
      const sa = severity[a.severity] ?? 3;
      const sb = severity[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      return Date.parse(b.time || 0) - Date.parse(a.time || 0);
    }),
  };
}

export function sortAnalyses(targets = []) {
  return [...targets].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99;
    const pb = STATUS_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return Date.parse(b.latestTime || 0) - Date.parse(a.latestTime || 0);
  });
}
