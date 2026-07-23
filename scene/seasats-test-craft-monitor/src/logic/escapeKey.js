export function subscribeEscapeKey(target, onEscape) {
  if (!target?.addEventListener || typeof onEscape !== "function") return () => {};
  const onKeyDown = (event) => {
    if (event.key === "Escape") onEscape();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
