import assert from "node:assert/strict";
import test from "node:test";
import { subscribeEscapeKey, subscribeEscapeKeyTopmost } from "./escapeKey.js";

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

test("subscribeEscapeKeyTopmost closes the topmost layer first and does not close the lower overlay", () => {
  const target = new EventTarget();
  let topmostCount = 0;
  let lowerCount = 0;
  // 每次派发都新建事件对象，避免复用同一事件残留 stopImmediatePropagation 标志。
  const pressEscape = () => {
    const escape = new Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    target.dispatchEvent(escape);
  };
  // 先注册最上层（关联详情弹窗，捕获阶段），再注册底层（综合分析悬浮框，冒泡阶段），
  // 模拟真实 DOM 中捕获阶段先于冒泡阶段触发。
  const unsubscribeTopmost = subscribeEscapeKeyTopmost(target, () => { topmostCount += 1; });
  const unsubscribeLower = subscribeEscapeKey(target, () => { lowerCount += 1; });

  pressEscape();

  assert.equal(topmostCount, 1, "topmost handler fires on Escape");
  // 捕获阶段 stopImmediatePropagation 阻止冒泡，底层悬浮框不应被同时关闭。
  assert.equal(lowerCount, 0, "lower overlay must not close while the dialog is open");

  // 弹窗关闭（取消订阅）后，Escape 才落到综合分析悬浮框。
  unsubscribeTopmost();
  pressEscape();
  assert.equal(lowerCount, 1, "lower overlay closes after the dialog is gone");

  unsubscribeLower();
});

test("subscribeEscapeKeyTopmost ignores non-Escape keys and cleans up", () => {
  const target = new EventTarget();
  let count = 0;
  const unsubscribe = subscribeEscapeKeyTopmost(target, () => { count += 1; });
  const enter = new Event("keydown", { bubbles: true });
  Object.defineProperty(enter, "key", { value: "Enter" });
  target.dispatchEvent(enter);
  assert.equal(count, 0);

  unsubscribe();
  const escape = new Event("keydown", { bubbles: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  target.dispatchEvent(escape);
  assert.equal(count, 0);
});

test("subscribeEscapeKeyTopmost returns a safe no-op for an unavailable target", () => {
  assert.doesNotThrow(() => subscribeEscapeKeyTopmost(null, () => {})());
});
