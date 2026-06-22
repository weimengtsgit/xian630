export const CHAT_TEXTAREA_MIN_HEIGHT = 46
export const CHAT_TEXTAREA_MAX_HEIGHT = 160

export function textareaSizingForScrollHeight(
  scrollHeight,
  {
    minHeight = CHAT_TEXTAREA_MIN_HEIGHT,
    maxHeight = CHAT_TEXTAREA_MAX_HEIGHT,
  } = {},
) {
  const measured = Number.isFinite(scrollHeight) ? scrollHeight : 0
  const height = Math.min(Math.max(measured, minHeight), maxHeight)
  return {
    height: `${height}px`,
    overflowY: measured > maxHeight ? 'auto' : 'hidden',
  }
}

export function applyTextareaAutosize(textarea) {
  if (!textarea) return null
  textarea.style.height = 'auto'
  const sizing = textareaSizingForScrollHeight(textarea.scrollHeight)
  textarea.style.height = sizing.height
  textarea.style.overflowY = sizing.overflowY
  return sizing
}
