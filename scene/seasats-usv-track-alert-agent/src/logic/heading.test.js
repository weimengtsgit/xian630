import assert from "node:assert/strict";
import test from "node:test";
import { resolveHeadingValue } from "./heading.js";

test("resolveHeadingValue applies the 511 rule for every vessel payload", () => {
  assert.equal(resolveHeadingValue({ heading: 58.3, orientation: 180 }), 58.3);
  assert.equal(resolveHeadingValue({ heading: 511, orientation: 58.3 }), 58.3);
  assert.equal(resolveHeadingValue({ heading: 511, orientation: 511 }), null);
  assert.equal(resolveHeadingValue({ orientation: 511 }), null);
  assert.equal(resolveHeadingValue({ heading: 456, orientation: 58.3 }), 456);
});
