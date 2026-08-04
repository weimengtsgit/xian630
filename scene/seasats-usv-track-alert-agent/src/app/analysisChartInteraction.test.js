import assert from "node:assert/strict";
import test from "node:test";
import { nearestValidPointIndex } from "./analysisChartInteraction.js";

test("selects the valid point nearest to the pointer x coordinate", () => {
  const data = [{ v: 2 }, { v: 4 }, { v: 8 }, { v: 16 }];
  assert.equal(nearestValidPointIndex(data, "v", 92, 20, 120), 2);
});

test("skips null values while selecting the nearest point", () => {
  const data = [{ v: 2 }, { v: null }, { v: 8 }];
  assert.equal(nearestValidPointIndex(data, "v", 100, 20, 100), 2);
});

test("returns null when the series has no valid y values", () => {
  assert.equal(nearestValidPointIndex([{ v: null }, {}], "v", 40, 20, 100), null);
});
