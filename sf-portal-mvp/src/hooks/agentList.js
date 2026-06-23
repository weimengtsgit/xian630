export function sortAgentsForDisplay(agents) {
  return [...(Array.isArray(agents) ? agents : [])].sort(
    (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
  )
}

export function splitAgentsByCategory(agents) {
  const sorted = sortAgentsForDisplay(agents)
  return {
    software: sorted.filter(agent => agent.category === 'software'),
    business: sorted.filter(agent => agent.category === 'business' || !agent.category),
  }
}

export function applySelectedBusinessAgents(agents, selectedIds) {
  const priority = new Map((selectedIds || []).map((id, index) => [id, index + 1]))
  return sortAgentsForDisplay(agents).map(agent => ({
    ...agent,
    isSelectedForConversation: priority.has(agent.id),
    selectedPriority: priority.get(agent.id) || 0,
  }))
}

export function moveSelectedBusinessAgent(selectedIds, id, delta) {
  const next = [...(selectedIds || [])]
  const index = next.indexOf(id)
  if (index < 0) return next
  const target = index + delta
  if (target < 0 || target >= next.length) return next
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}

export function appendCreatedAgentForDisplay(current, created) {
  return sortAgentsForDisplay([...(Array.isArray(current) ? current : []), created])
}
