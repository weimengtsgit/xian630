// Pure helper for building the collaboration-plan card view.
//
// Joins the plan's lanes + agents to the real job_steps (by agent key) and the
// execution-summary (keyed by step_id). Returns a per-lane list of card-view
// entries that JobCenter renders instead of the fixed six-step matrix when a
// plan is present. Framework-free so the Node assertion harness can import it.

import { collaborationAgentName } from './collaborationAgentLabels.js'

export function buildCollaborationCardView(steps = [], summary = [], planResponse = null) {
  const plan = planResponse && planResponse.plan
  const planAgents = plan && Array.isArray(plan.agents) ? plan.agents : []
  const lanes = plan && Array.isArray(plan.lanes) ? plan.lanes : []
  const stepByAgent = {}
  ;(steps || []).forEach(step => {
    if (!step) return
    const key = step.agent_key || step.agentKey
    if (key && !stepByAgent[key]) stepByAgent[key] = step
  })
  const summaryByStepId = {}
  ;(summary || []).forEach(item => {
    if (item && item.step_id != null && !summaryByStepId[item.step_id]) {
      summaryByStepId[item.step_id] = item
    }
  })
  return lanes.map(lane => {
    const cards = planAgents
      .filter(agent => agent.lane === lane.id)
      .map(agent => {
        const step = stepByAgent[agent.key] || null
        const stepId = step && step.id ? step.id : null
        return {
          kind: step ? step.kind : agent.role,
          label: collaborationAgentName(agent),
          agent,
          stepId,
          step,
          summary: stepId ? summaryByStepId[stepId] || null : null,
        }
      })
    return { lane, cards }
  }).filter(group => group.cards.length > 0)
}
