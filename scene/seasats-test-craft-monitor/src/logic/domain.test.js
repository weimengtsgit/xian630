import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePayload,
  computeTrackMetrics,
  buildAlerts,
  detectAisGaps,
  dimensionMatch,
  isLowSpeed,
  isNameHit,
  normalizeTargetSpeedKn,
  pointInArea,
  scoreTarget,
  splitTrackSegments,
} from "./domain.js";

const areas = [{ id: "test-area", name: "测试区", center: { lon: 120, lat: 20 }, radiusNm: 20 }];

test("normalizes target-list speed by dividing by 10", () => {
  assert.equal(normalizeTargetSpeedKn("11"), 1.1);
  assert.equal(normalizeTargetSpeedKn("bad"), null);
});

test("matches SEASAT or SEASATS followed by TEST or a number", () => {
  assert.equal(isNameHit("SEASATS 55"), true);
  assert.equal(isNameHit("seasat TEST"), true);
  assert.equal(isNameHit("MY SEASATS 55"), false);
  assert.equal(isNameHit("SEASATS ALPHA"), false);
});

test("classifies dimensions and inclusive low speed", () => {
  assert.deepEqual(dimensionMatch(4, 2), { level: "strong", label: "4*2 强命中", score: 20 });
  assert.deepEqual(dimensionMatch("3", "2"), { level: "review", label: "3*2 尺寸偏差", score: 12 });
  assert.equal(isLowSpeed(0), true);
  assert.equal(isLowSpeed(3), true);
  assert.equal(isLowSpeed(3.1), false);
});

test("detects center-radius monitored-area hits", () => {
  assert.equal(pointInArea({ lon: 120.05, lat: 20.05 }, areas[0]), true);
  assert.equal(pointInArea({ lon: 121.5, lat: 20.05 }, areas[0]), false);
});

test("splits tracks at long gaps and detects warning/critical AIS gaps", () => {
  const points = [
    { mmsi: "1", time: "2026-01-01T00:00:00Z", lon: 120, lat: 20, speedKn: 1 },
    { mmsi: "1", time: "2026-01-01T00:10:00Z", lon: 120.01, lat: 20.01, speedKn: 1 },
    { mmsi: "1", time: "2026-01-01T01:00:00Z", lon: 120.02, lat: 20.02, speedKn: 1 },
    { mmsi: "1", time: "2026-01-01T08:00:00Z", lon: 120.03, lat: 20.03, speedKn: 1 },
    { mmsi: "1", time: "2026-01-01T08:10:00Z", lon: -117, lat: 32, speedKn: 1 },
  ];
  const segments = splitTrackSegments(points, { areas, segmentGapMinutes: 360, segmentJumpNm: 50 });
  const gaps = detectAisGaps(points, { areas, aisGapWarningMinutes: 30, aisGapCriticalMinutes: 360 });
  assert.equal(segments.length, 3);
  assert.equal(segments[0].lowSpeedMinutes, 10);
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps.map((gap) => gap.severity), ["warning", "critical"]);
});

test("builds behavior alerts and scores partial evidence without hard filtering", () => {
  const segments = [{
    id: "seg-1",
    targetMmsi: "1",
    startTime: "2026-01-01T00:00:00Z",
    endTime: "2026-01-01T00:30:00Z",
    durationMinutes: 30,
    lowSpeedMinutes: 30,
    pathNm: 12,
    displacementNm: 2,
    pathDisplacementRatio: 6,
    areaIds: ["test-area"],
    centroid: { lon: 120, lat: 20 },
  }];
  const alerts = buildAlerts({ target: { mmsi: "1", name: "SEASATS 1" }, segments, areas });
  assert.equal(alerts.some((a) => a.type === "sustained-low-speed"), true);
  assert.equal(alerts.some((a) => a.type === "repeated-activity"), true);
  assert.equal(scoreTarget({ nameHit: true, dimension: { score: 12 }, latestAreaIds: [], hasObservedTrack: false, alerts: [] }), 42);
});

test("analyzes payload and keeps tracked target first", () => {
  const analysis = analyzePayload({
    parameters: { lowSpeedDurationMinutes: 10, aisGapWarningMinutes: 30, aisGapCriticalMinutes: 360 },
    monitoredAreas: areas,
    targets: [
      { mmsi: "1", name: "SEASATS 1", lon: 120, lat: 20, length: 4, width: 2, speedKn: 0, latestTime: "2026-01-02T00:00:00Z" },
      { mmsi: "2", name: "SEASATS 2", lon: 10, lat: 10, length: 3, width: 2, speedKn: 0, latestTime: "2026-01-01T00:00:00Z" },
    ],
    trackPoints: [
      { mmsi: "1", time: "2026-01-01T00:00:00Z", lon: 120, lat: 20, speedKn: 1 },
      { mmsi: "1", time: "2026-01-01T00:20:00Z", lon: 120.01, lat: 20.01, speedKn: 1 },
    ],
  });
  assert.equal(analysis.targets[0].mmsi, "1");
  assert.equal(analysis.targets[0].status, "异常行为目标");
});

test("computeTrackMetrics aggregates a small track", () => {
  const points = [
    { mmsi: "1", time: "2026-01-01T00:00:00Z", lon: 110.0, lat: 21.0, speedKn: 1 },
    { mmsi: "1", time: "2026-01-01T01:00:00Z", lon: 110.1, lat: 21.0, speedKn: 5 },
    { mmsi: "1", time: "2026-01-02T02:00:00Z", lon: 111.0, lat: 22.0, speedKn: 3 },
  ];
  const coast = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { id: "c" }, geometry: { type: "LineString", coordinates: [[109, 20]] } },
  ] };
  const m = computeTrackMetrics(points, coast);
  assert.equal(m.reportCount, 3);
  assert.equal(m.activeDays, 2);
  assert.equal(m.maxSpeedSegment.speedKn, 5);
  assert.deepEqual(m.trackOrigin, { lon: 110.0, lat: 21.0, time: "2026-01-01T00:00:00Z" });
  assert.ok(m.minCoastDistanceNm > 50, `got ${m.minCoastDistanceNm}`);
  assert.equal(m.nearestCoastPoint.segmentId, "c");
  assert.ok(m.avgSpeedKn > 0);
});

test("computeTrackMetrics empty track returns nulls/zeros", () => {
  const m = computeTrackMetrics([], { type: "FeatureCollection", features: [] });
  assert.equal(m.reportCount, 0);
  assert.equal(m.activeDays, 0);
  assert.equal(m.maxSpeedSegment, null);
  assert.equal(m.trackOrigin, null);
  assert.equal(m.minCoastDistanceNm, null);
});

test("analyzePayload attaches coast metrics and proximity alert", () => {
  const payload = {
    parameters: { coastAlertRangeNm: 200, coastAlertHighNm: 80, coastAlertMediumNm: 140 },
    monitoredAreas: [],
    targets: [
      { mmsi: "X1", name: "SEASATS 55", lon: 109.2, lat: 20.1, length: 4, width: 2, latestTime: "2026-01-02T02:00:00Z" },
    ],
    trackPoints: [
      { mmsi: "X1", time: "2026-01-01T00:00:00Z", lon: 109.2, lat: 20.1, speedKn: 2 },
      { mmsi: "X1", time: "2026-01-02T02:00:00Z", lon: 109.3, lat: 20.2, speedKn: 2 },
    ],
  };
  const coast = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { id: "c" }, geometry: { type: "LineString", coordinates: [[109, 20]] } },
  ] };
  const analysis = analyzePayload(payload, coast);
  const t = analysis.targets[0];
  assert.equal(t.activeDays, 2);
  assert.ok(t.minCoastDistanceNm < 80, `got ${t.minCoastDistanceNm}`);
  const co = analysis.alerts.find((a) => a.type === "coast-proximity");
  assert.ok(co, "expected a coast-proximity alert");
  assert.equal(co.level, "high");
  assert.equal(co.severity, "critical");
});

test("analyzePayload without coast skips coast alerts (back-compat)", () => {
  const payload = { targets: [{ mmsi: "X2", name: "SEASATS 9", lon: 50.6, lat: 26.2, length: 4, width: 2, latestTime: "2026-01-01T00:00:00Z" }], trackPoints: [] };
  const analysis = analyzePayload(payload);
  assert.equal(analysis.alerts.find((a) => a.type === "coast-proximity"), undefined);
});

test("ais-gap alert carries card fields (speeds, course, origin)", () => {
  const payload = {
    parameters: {},
    monitoredAreas: [],
    targets: [{ mmsi: "G1", name: "SEASATS 7", lon: 50.6, lat: 26.2, length: 4, width: 2, latestTime: "2026-01-02T05:00:00Z" }],
    trackPoints: [
      { mmsi: "G1", time: "2026-01-01T00:00:00Z", lon: 50.6, lat: 26.2, speedKn: 3, courseDeg: 90 },
      { mmsi: "G1", time: "2026-01-01T01:00:00Z", lon: 50.61, lat: 26.2, speedKn: 4, courseDeg: 95 },
      { mmsi: "G1", time: "2026-01-02T05:00:00Z", lon: 50.7, lat: 26.3, speedKn: 2, courseDeg: 200 },
    ],
  };
  const analysis = analyzePayload(payload);
  const gap = analysis.alerts.find((a) => a.type === "ais-gap");
  assert.ok(gap);
  assert.equal(gap.preSpeedKn, 4);
  assert.equal(gap.postSpeedKn, 2);
  assert.equal(gap.courseDeg, 95);
  assert.deepEqual(gap.trackOrigin, { lon: 50.6, lat: 26.2, time: "2026-01-01T00:00:00Z" });
  assert.ok(gap.segmentAvgSpeedKn >= 0);
});
