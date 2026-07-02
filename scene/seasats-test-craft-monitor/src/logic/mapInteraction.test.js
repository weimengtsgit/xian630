import { test } from "node:test";
import assert from "node:assert/strict";
import { isSatelliteSourceError, resolveMapClickAction } from "./mapInteraction.js";

const feature = (layerId, properties) => ({ layer: { id: layerId }, properties });

test("resolveMapClickAction prioritizes alert points", () => {
  assert.deepEqual(resolveMapClickAction([
    feature("track-segments", { id: "seg-1" }),
    feature("vessel-points", { mmsi: "1" }),
    feature("alert-points", { id: "alert-1" }),
  ]), { kind: "alert", id: "alert-1", targetMmsi: undefined });
});

test("resolveMapClickAction resolves vessel and area features", () => {
  assert.deepEqual(resolveMapClickAction([feature("vessel-points", { mmsi: "1" })]), { kind: "target", mmsi: "1" });
  assert.deepEqual(resolveMapClickAction([feature("monitored-area-fill", { id: "a" })]), { kind: "area", id: "a" });
});

test("isSatelliteSourceError filters basemap failures", () => {
  assert.equal(isSatelliteSourceError({ sourceId: "satellite", error: new Error("tile") }), true);
  assert.equal(isSatelliteSourceError({ sourceId: "vessel-points", error: new Error("style") }), false);
});
