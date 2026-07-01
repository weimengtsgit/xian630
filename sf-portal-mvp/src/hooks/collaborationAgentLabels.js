export function collaborationAgentName(agent) {
  if (!agent) return ''
  const key = agent.key || agent.agentKey || agent.agent_key || ''
  const name = agent.name || ''
  if (key === 'designer' && (!name || name === '设计')) return '界面设计'
  return name || key
}
