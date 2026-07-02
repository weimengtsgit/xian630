import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePayload,
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
