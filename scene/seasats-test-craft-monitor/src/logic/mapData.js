import { toNumber } from "./domain.js";

const EARTH_RADIUS_NM = 3440.065;

export function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function validLonLat(lon, lat) {
  return typeof lon === "number" && Number.isFinite(lon) && typeof lat === "number" && Number.isFinite(lat);
}

function pointFeature(id, properties, lon, lat) {
  if (!validLonLat(lon, lat)) return null;
  return { type: "Feature", id, properties: { id, ...properties }, geometry: { type: "Point", coordinates: [lon, lat] } };
}

function lineFeature(id, properties, coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  return { type: "Feature", id, properties: { id, ...properties }, geometry: { type: "LineString", coordinates } };
}

function destinationPoint(center, radiusNm, bearingDeg) {
  const lon = toNumber(center?.lon);
  const lat = toNumber(center?.lat);
  const radius = toNumber(radiusNm);
  if (lon === null || lat === null || radius === null) return null;
  const delta = radius / EARTH_RADIUS_NM;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const lambda2 =
    lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return [(lambda2 * 180) / Math.PI, (phi2 * 180) / Math.PI];
}

function areaFeature(area) {
  const ring = [];
  for (let i = 0; i <= 48; i += 1) {
    const point = destinationPoint(area.center, area.radiusNm, (i / 48) * 360);
    if (point) ring.push(point);
  }
  if (ring.length < 4) return null;
  return {
    type: "Feature",
    id: area.id,
    properties: { id: area.id, name: area.name, radiusNm: area.radiusNm, centerLon: area.center?.lon, centerLat: area.center?.lat },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

function inReplay(point, replayEnd) {
  if (!Number.isFinite(replayEnd)) return true;
  const ms = Date.parse(point.time);
  return Number.isFinite(ms) && ms <= replayEnd;
}

export function buildMapData({ targets = [], areas = [], segments = [], aisGaps = [], alerts = [], replayEnd = Infinity, coast = null, selectedTarget = null } = {}) {
  const vesselPoints = targets
    .map((target) =>
      pointFeature(
        target.mmsi,
        { mmsi: target.mmsi, name: target.name, status: target.status, score: target.score, trackSource: target.trackSource, latestTime: target.latestTime },
        toNumber(target.lon),
        toNumber(target.lat)
      )
    )
    .filter(Boolean);
  const monitoredAreas = areas.map(areaFeature).filter(Boolean);
  const trackSegments = segments
    .map((segment) => {
      const coordinates = (segment.points || [])
        .filter((point) => inReplay(point, replayEnd))
        .map((point) => [toNumber(point.lon), toNumber(point.lat)])
        .filter(([lon, lat]) => validLonLat(lon, lat));
      return lineFeature(segment.id, {
        targetMmsi: segment.targetMmsi,
        areaIds: (segment.areaIds || []).join(","),
        startTime: segment.startTime,
        endTime: segment.endTime,
        lowSpeedMinutes: segment.lowSpeedMinutes,
        pathDisplacementRatio: segment.pathDisplacementRatio,
      }, coordinates);
    })
    .filter(Boolean);
  const gapFeatures = aisGaps
    .map((gap) => pointFeature(gap.id, { targetMmsi: gap.targetMmsi, severity: gap.severity, gapMinutes: Math.round(gap.gapMinutes || 0), fromTime: gap.fromTime, toTime: gap.toTime }, toNumber(gap.lon), toNumber(gap.lat)))
    .filter(Boolean);
  const alertFeatures = alerts
    .map((alert) => pointFeature(alert.id, { targetMmsi: alert.targetMmsi, title: alert.title, type: alert.type, severity: alert.severity, summary: alert.summary, time: alert.time, level: alert.level }, toNumber(alert.lon), toNumber(alert.lat)))
    .filter(Boolean);

  const selectedPoints = selectedTarget
    ? (selectedTarget.points || (Array.isArray(selectedTarget.segments) ? selectedTarget.segments.flatMap((s) => s.points || []) : []) || [])
    : [];
  return {
    vesselPoints: { type: "FeatureCollection", features: vesselPoints },
    monitoredAreas: { type: "FeatureCollection", features: monitoredAreas },
    trackSegments: { type: "FeatureCollection", features: trackSegments },
    aisGaps: { type: "FeatureCollection", features: gapFeatures },
    alertPoints: { type: "FeatureCollection", features: alertFeatures },
    speedSegments: selectedTarget ? speedColorSegments(selectedPoints, { maxCount: 400 }) : emptyFeatureCollection(),
    coastLine: coastFeatures(coast),
    nearestPoint: { type: "FeatureCollection", features: [nearestPointFeature(selectedTarget)].filter(Boolean) },
    maxSpeedSegment: { type: "FeatureCollection", features: [maxSpeedFeature(selectedTarget)].filter(Boolean) },
  };
}

export function decimatePoints(points = [], opts = {}) {
  const maxCount = toNumber(opts.maxCount) || 400;
  const valid = points.filter((p) => validLonLat(toNumber(p.lon), toNumber(p.lat)));
  if (valid.length <= maxCount) return valid;
  const step = Math.ceil(valid.length / maxCount);
  const out = [];
  for (let i = 0; i < valid.length; i += step) out.push(valid[i]);
  if (out[out.length - 1] !== valid[valid.length - 1] && out.length < maxCount) out.push(valid[valid.length - 1]);
  return out;
}

export function speedColorSegments(points = [], opts = {}) {
  const d = decimatePoints(points, opts);
  const features = [];
  for (let i = 1; i < d.length; i += 1) {
    const prev = d[i - 1];
    const cur = d[i];
    const speed = toNumber(prev.speedKn);
    features.push({
      type: "Feature",
      properties: { speedKn: speed ?? 0 },
      geometry: { type: "LineString", coordinates: [[toNumber(prev.lon), toNumber(prev.lat)], [toNumber(cur.lon), toNumber(cur.lat)]] },
    });
  }
  return { type: "FeatureCollection", features };
}

export function coastFeatures(coast) {
  const features = (coast?.features || []).filter((f) => f?.geometry?.type === "LineString");
  return { type: "FeatureCollection", features };
}

export function nearestPointFeature(target) {
  const np = target?.nearestCoastPoint;
  if (!np || !validLonLat(toNumber(np.lon), toNumber(np.lat))) return null;
  return { type: "Feature", properties: { label: "离国土最近" }, geometry: { type: "Point", coordinates: [toNumber(np.lon), toNumber(np.lat)] } };
}

export function maxSpeedFeature(target) {
  const seg = target?.maxSpeedSegment;
  if (!seg?.fromPoint || !seg.toPoint) return null;
  const a = seg.fromPoint, b = seg.toPoint;
  if (!validLonLat(toNumber(a.lon), toNumber(a.lat)) || !validLonLat(toNumber(b.lon), toNumber(b.lat))) return null;
  return { type: "Feature", properties: { speedKn: seg.speedKn ?? 0, label: "最快段" }, geometry: { type: "LineString", coordinates: [[toNumber(a.lon), toNumber(a.lat)], [toNumber(b.lon), toNumber(b.lat)]] } };
}

function collectGeometryCoordinates(geometry, out) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return;
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    if (validLonLat(lon, lat)) out.push([lon, lat]);
  } else if (geometry.type === "LineString") {
    for (const [lon, lat] of geometry.coordinates) if (validLonLat(lon, lat)) out.push([lon, lat]);
  } else if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) for (const [lon, lat] of ring) if (validLonLat(lon, lat)) out.push([lon, lat]);
  }
}

export function boundsForMapData(mapData) {
  const coords = [];
  for (const collection of Object.values(mapData || {})) {
    if (!collection || !Array.isArray(collection.features)) continue;
    for (const feature of collection.features) collectGeometryCoordinates(feature.geometry, coords);
  }
  if (coords.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of coords) {
    west = Math.min(west, lon);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    north = Math.max(north, lat);
  }
  return [[west, south], [east, north]];
}
