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

export function buildMapData({ targets = [], areas = [], segments = [], aisGaps = [], alerts = [], replayEnd = Infinity } = {}) {
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
    .map((alert) => pointFeature(alert.id, { targetMmsi: alert.targetMmsi, title: alert.title, type: alert.type, severity: alert.severity, summary: alert.summary, time: alert.time }, toNumber(alert.lon), toNumber(alert.lat)))
    .filter(Boolean);
  return {
    vesselPoints: { type: "FeatureCollection", features: vesselPoints },
    monitoredAreas: { type: "FeatureCollection", features: monitoredAreas },
    trackSegments: { type: "FeatureCollection", features: trackSegments },
    aisGaps: { type: "FeatureCollection", features: gapFeatures },
    alertPoints: { type: "FeatureCollection", features: alertFeatures },
  };
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
