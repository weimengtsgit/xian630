import assert from 'node:assert/strict'
import {
  splitAgentsByCategory,
  applySelectedBusinessAgents,
  moveSelectedBusinessAgent,
} from '../src/hooks/agentList.js'

const agents = [
  { id: 'agent_req', key: 'requirement-analyst', category: 'software', sort_order: 1 },
  { id: 'agent_b', key: 'b', category: 'business', sort_order: 101 },
  { id: 'agent_a', key: 'a', category: 'business', sort_order: 100 },
]

const split = splitAgentsByCategory(agents)
assert.deepEqual(split.software.map(agent => agent.key), ['requirement-analyst'])
assert.deepEqual(split.business.map(agent => agent.key), ['a', 'b'])

const marked = applySelectedBusinessAgents(split.business, ['agent_b', 'agent_a'])
assert.deepEqual(
  marked.map(agent => [agent.id, agent.selectedPriority]),
  [
    ['agent_a', 2],
    ['agent_b', 1],
  ],
)

assert.deepEqual(moveSelectedBusinessAgent(['agent_b', 'agent_a', 'agent_c'], 'agent_a', -1), [
  'agent_a',
  'agent_b',
  'agent_c',
])
assert.deepEqual(moveSelectedBusinessAgent(['agent_b', 'agent_a'], 'agent_b', -1), ['agent_b', 'agent_a'])
