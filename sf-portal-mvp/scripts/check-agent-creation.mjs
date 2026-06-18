import assert from 'node:assert/strict'
import { appendCreatedAgentForDisplay } from '../src/hooks/agentList.js'

const current = [
  { id: 'agent_tester', key: 'tester', sort_order: 5 },
  { id: 'agent_requirement', key: 'requirement-analyst', sort_order: 1 },
]

const created = { id: 'agent_review', key: 'review-agent', sort_order: 3 }
const ordered = appendCreatedAgentForDisplay(current, created)

assert.deepEqual(
  ordered.map(agent => agent.key),
  ['requirement-analyst', 'review-agent', 'tester'],
)
assert.notEqual(ordered, current)
