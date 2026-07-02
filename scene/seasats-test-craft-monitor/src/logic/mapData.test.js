import { test } from "node:test";
import assert from "node:assert/strict";
import { boundsForMapData, buildMapData, emptyFeatureCollection, decimatePoints, speedColorSegments, coastFeatures, nearestPointFeature, maxSpeedFeature } from "./mapData.js";

test("emptyFeatureCollection returns valid empty GeoJSON", () => {
  assert.deepEqual(emptyFeatureCollection(), { type: "FeatureCollection", features: [] });
});

test("buildMapData converts targets, areas, tracks, gaps, and alerts to collections", () => {
  const data = buildMapData({
    targets: [{ mmsi: "1", name: "SEASATS 1", lon: 120, lat: 20, status: "异常行为目标", score: 90 }],
    areas: [{ id: "a", name: "区域A", center: { lon: 120, lat: 20 }, radiusNm: 10 }],
    segments: [{ id: "seg-1", targetMmsi: "1", areaIds: ["a"], points: [
      { time: "2026-01-01T00:00:00Z", lon: 120, lat: 20 },
      { time: "2026-01-01T00:10:00Z", lon: 120.1, lat: 20.1 },
      { time: "2026-01-01T00:20:00Z", lon: 120.2, lat: 20.2 },
    ] }],
    aisGaps: [{ id: "gap-1", targetMmsi: "1", lon: 120.05, lat: 20.05, severity: "critical" }],
    alerts: [{ id: "alert-1", targetMmsi: "1", title: "持续低速活动", lon: 120.06, lat: 20.06, severity: "warning" }],
    replayEnd: Date.parse("2026-01-01T00:10:00Z"),
  });
  assert.equal(data.vesselPoints.features.length, 1);
  assert.equal(data.monitoredAreas.features.length, 1);
  assert.equal(data.trackSegments.features.length, 1);
  assert.equal(data.aisGaps.features.length, 1);
  assert.equal(data.alertPoints.features.length, 1);
  assert.deepEqual(data.trackSegments.features[0].geometry.coordinates, [[120, 20], [120.1, 20.1]]);
});

test("boundsForMapData encloses points, lines, and polygons", () => {
  const bounds = boundsForMapData({
    vesselPoints: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [120, 20] } }] },
    monitoredAreas: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[119, 19], [121, 19], [121, 21], [119, 21], [119, 19]]] } }] },
    trackSegments: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[118, 18], [122, 22]] } }] },
    aisGaps: emptyFeatureCollection(),
    alertPoints: emptyFeatureCollection(),
  });
  assert.deepEqual(bounds, [[118, 18], [122, 22]]);
});

test("decimatePoints reduces by step", () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ lon: i, lat: i, time: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z` }));
  const d = decimatePoints(pts, { maxCount: 10 });
  assert.ok(d.length <= 10 && d.length >= 2, `got ${d.length}`);
});

test("speedColorSegments builds one feature per gap with speedKn", () => {
  const pts = [
    { lon: 50, lat: 26, time: "2026-01-01T00:00:00Z", speedKn: 2 },
    { lon: 50.1, lat: 26, time: "2026-01-01T00:10:00Z", speedKn: 8 },
    { lon: 50.2, lat: 26, time: "2026-01-01T00:20:00Z", speedKn: 3 },
  ];
  const fc = speedColorSegments(pts, { maxCount: 50 });
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0].properties.speedKn, 2);
});

test("coastFeatures passes through LineStrings", () => {
  const coast = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { id: "a" }, geometry: { type: "LineString", coordinates: [[110, 21], [109, 20]] } },
  ] };
  const fc = coastFeatures(coast);
  assert.equal(fc.features.length, 1);
});

test("nearestPointFeature from target.nearestCoastPoint", () => {
  const f = nearestPointFeature({ nearestCoastPoint: { lon: 110, lat: 21, time: "t" } });
  assert.equal(f.geometry.type, "Point");
  assert.deepEqual(f.geometry.coordinates, [110, 21]);
});

test("maxSpeedFeature from target.maxSpeedSegment", () => {
  const f = maxSpeedFeature({ maxSpeedSegment: { fromPoint: { lon: 50, lat: 26 }, toPoint: { lon: 50.1, lat: 26 }, speedKn: 8 } });
  assert.equal(f.geometry.type, "LineString");
});
