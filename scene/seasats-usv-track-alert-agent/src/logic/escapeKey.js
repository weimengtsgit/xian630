export function subscribeEscapeKey(target, onEscape) {
  if (!target?.addEventListener || typeof onEscape !== "function") return () => {};
  const onKeyDown = (event) => {
    if (event.key === "Escape") onEscape();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

// 关联详情弹窗等“最上层”浮层使用：在捕获阶段先处理 Escape 并停止传播，
// 避免事件冒泡到舰艇综合分析悬浮框的 Escape 监听同时关闭底层浮层。
// 与 subscribeEscapeKey 并存：后者保持原有冒泡阶段行为与测试不变。
export function subscribeEscapeKeyTopmost(target, onEscape) {
  if (!target?.addEventListener || typeof onEscape !== "function") return () => {};
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    onEscape();
    // 真实 DOM 中捕获阶段调用 stopImmediatePropagation 会阻止事件进入目标/冒泡阶段，
    // 因此底层综合分析悬浮框的冒泡监听不会同时触发；弹窗关闭后再次按 Escape 才落到悬浮框。
    event.stopImmediatePropagation();
  };
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}
