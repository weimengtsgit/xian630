import { test } from "node:test";
import assert from "node:assert/strict";

import { projectWorld } from "./worldProjection.js";

test("world projection keeps both hemispheres within the global map frame", () => {
  const west = projectWorld(35, -75, 560, 420);
  const east = projectWorld(-33, 151, 560, 420);

  for (const [x, y] of [west, east]) {
    assert.ok(x >= 0 && x <= 560, `x ${x} should be inside the world map`);
    assert.ok(y >= 0 && y <= 420, `y ${y} should be inside the world map`);
  }
  assert.ok(west[0] < east[0], "western hemisphere should render left of eastern hemisphere");
});
