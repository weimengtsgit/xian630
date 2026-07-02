import { test } from "node:test";
import assert from "node:assert/strict";
import { coastVertices, nearestPointOnCoastNm, coastProximityLevel, COAST_LEVELS } from "./coast.js";

const COAST = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "seg-a" }, geometry: { type: "LineString", coordinates: [[110, 21], [109, 20]] } },
    { type: "Feature", properties: { id: "seg-b" }, geometry: { type: "LineString", coordinates: [[121, 25]] } },
  ],
};

test("coastVertices flattens all LineString points with segmentId", () => {
  const v = coastVertices(COAST);
  assert.equal(v.length, 3);
  assert.deepEqual(v[0], { lon: 110, lat: 21, segmentId: "seg-a" });
  assert.equal(v[2].segmentId, "seg-b");
});

test("nearestPointOnCoastNm returns ~0 at a coast vertex", () => {
  const r = nearestPointOnCoastNm({ lon: 110, lat: 21 }, COAST);
  assert.ok(r.distanceNm < 0.5);
  assert.equal(r.segmentId, "seg-a");
});

test("nearestPointOnCoastNm picks the closest vertex", () => {
  const r = nearestPointOnCoastNm({ lon: 110, lat: 22 }, COAST);
  assert.equal(r.segmentId, "seg-a");
  assert.ok(r.distanceNm > 50 && r.distanceNm < 70, `got ${r.distanceNm}`);
  assert.deepEqual(r.point, [110, 21]);
});

test("nearestPointOnCoastNm returns null distance for invalid point", () => {
  const r = nearestPointOnCoastNm({ lon: null, lat: 22 }, COAST);
  assert.equal(r.distanceNm, null);
});

test("nearestPointOnCoastNm handles empty coast", () => {
  const r = nearestPointOnCoastNm({ lon: 110, lat: 21 }, { type: "FeatureCollection", features: [] });
  assert.equal(r.distanceNm, null);
});

const PARAMS = { coastAlertRangeNm: 200, coastAlertHighNm: 80, coastAlertMediumNm: 140 };

test("coastProximityLevel boundaries", () => {
  assert.equal(coastProximityLevel(70, PARAMS), COAST_LEVELS.HIGH);
  assert.equal(coastProximityLevel(79.9, PARAMS), COAST_LEVELS.HIGH);
  assert.equal(coastProximityLevel(100, PARAMS), COAST_LEVELS.MEDIUM);
  assert.equal(coastProximityLevel(139.9, PARAMS), COAST_LEVELS.MEDIUM);
  assert.equal(coastProximityLevel(160, PARAMS), COAST_LEVELS.LOW);
  assert.equal(coastProximityLevel(199.9, PARAMS), COAST_LEVELS.LOW);
  assert.equal(coastProximityLevel(200, PARAMS), null);
  assert.equal(coastProximityLevel(250, PARAMS), null);
  assert.equal(coastProximityLevel(null, PARAMS), null);
});
