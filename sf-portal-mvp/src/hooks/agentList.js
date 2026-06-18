export function appendCreatedAgentForDisplay(current, created) {
  const next = [...(Array.isArray(current) ? current : []), created]
  next.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  return next
}
