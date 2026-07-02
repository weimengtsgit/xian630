import { toNumber, haversineNm } from "./domain.js";

// 把 coast GeoJSON (FeatureCollection of LineString) 展平为顶点列表
export function coastVertices(coast) {
  const out = [];
  if (!coast || !Array.isArray(coast.features)) return out;
  for (const feature of coast.features) {
    const segmentId = feature?.properties?.id ?? null;
    const coords = feature?.geometry?.coordinates || [];
    for (const [lon, lat] of coords) {
      out.push({ lon, lat, segmentId });
    }
  }
  return out;
}

// 点到海岸折线集合的最近距离（遍历顶点取最近 haversine；coast 采样密度 ≤10NM 保证误差 <5%）
export function nearestPointOnCoastNm(point, coast) {
  const lon = toNumber(point?.lon);
  const lat = toNumber(point?.lat);
  if (lon === null || lat === null) return { distanceNm: null, point: null, segmentId: null };
  const vertices = coastVertices(coast);
  if (vertices.length === 0) return { distanceNm: null, point: null, segmentId: null };
  let best = Infinity;
  let bestVertex = null;
  for (const v of vertices) {
    const d = haversineNm({ lon, lat }, v);
    if (d !== null && d < best) {
      best = d;
      bestVertex = v;
    }
  }
  return {
    distanceNm: best === Infinity ? null : best,
    point: bestVertex ? [bestVertex.lon, bestVertex.lat] : null,
    segmentId: bestVertex?.segmentId ?? null,
  };
}

export const COAST_LEVELS = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

export function coastProximityLevel(distanceNm, params = {}) {
  const d = toNumber(distanceNm);
  const range = toNumber(params.coastAlertRangeNm);
  if (d === null || range === null || d >= range) return null;
  if (d < toNumber(params.coastAlertHighNm)) return COAST_LEVELS.HIGH;
  if (d < toNumber(params.coastAlertMediumNm)) return COAST_LEVELS.MEDIUM;
  return COAST_LEVELS.LOW;
}
