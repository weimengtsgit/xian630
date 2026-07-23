import assert from "node:assert/strict";
import test from "node:test";
import { subscribeEscapeKey } from "./escapeKey.js";

test("invokes the close callback only for Escape and removes the listener on cleanup", () => {
  const target = new EventTarget();
  let closeCount = 0;
  const unsubscribe = subscribeEscapeKey(target, () => { closeCount += 1; });

  const enter = new Event("keydown");
  Object.defineProperty(enter, "key", { value: "Enter" });
  target.dispatchEvent(enter);
  assert.equal(closeCount, 0);

  const escape = new Event("keydown");
  Object.defineProperty(escape, "key", { value: "Escape" });
  target.dispatchEvent(escape);
  assert.equal(closeCount, 1);

  unsubscribe();
  target.dispatchEvent(escape);
  assert.equal(closeCount, 1);
});

test("returns a safe no-op cleanup for an unavailable event target", () => {
  assert.doesNotThrow(() => subscribeEscapeKey(null, () => {})());
});
