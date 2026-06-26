import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveMapClickAction, isSatelliteSourceError } from "./mapInteraction.js";

const feature = (layerId, properties) => ({
  layer: { id: layerId },
  properties,
});

test("sea event wins over an overlapping carrier track", () => {
  const action = resolveMapClickAction([
    feature("carrier-tracks", { carrierId: "CVN-78" }),
    feature("sea-events", { id: "evt-4" }),
  ]);

  assert.deepEqual(action, { kind: "event", eventId: "evt-4" });
});

test("carrier position wins when it overlaps a sea event", () => {
  const action = resolveMapClickAction([
    feature("sea-events", { id: "evt-4" }),
    feature("carrier-positions", { carrierId: "CVN-78" }),
  ]);

  assert.deepEqual(action, { kind: "carrier", carrierId: "CVN-78" });
});

test("audit event is selected before a carrier track fallback", () => {
  const action = resolveMapClickAction([
    feature("carrier-tracks", { carrierId: "CVN-71" }),
    feature("audit-events", { id: "audit-1" }),
  ]);

  assert.deepEqual(action, { kind: "audit", eventId: "audit-1" });
});

test("only the satellite source marks the basemap as limited", () => {
  assert.equal(isSatelliteSourceError({ sourceId: "satellite" }), true);
  assert.equal(isSatelliteSourceError({ sourceId: "sea-events" }), false);
  assert.equal(isSatelliteSourceError({}), false);
});
