import { test } from "node:test";
import assert from "node:assert/strict";

import { revealAircraftSelection } from "./interaction.js";

test("revealing an aircraft clears a conflicting carrier filter", () => {
  assert.deepEqual(revealAircraftSelection("A5"), {
    selectedIcao: "A5",
    selectedCarrierId: null,
    carrierFilter: "ALL",
  });
});
