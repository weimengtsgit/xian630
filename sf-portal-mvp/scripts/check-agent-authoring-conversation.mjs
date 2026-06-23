import assert from 'node:assert/strict'
import {
  buildTimelineFromMessages,
  applyConversationEvent,
  initialConversationState,
} from '../src/hooks/conversationTimeline.js'

// --- agent_draft message type in timeline ---
const messages = [
  { id: 'u1', role: 'user', kind: 'prompt', content: '创建海事预警智能体' },
  { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '正在分析业务场景' },
  {
    id: 'd1',
    role: 'agent',
    kind: 'agent_draft',
    content: '已根据对话更新智能体预览',
    metadata_json: JSON.stringify({
      key: 'maritime-alert-expert',
      name: '海事预警专家',
      description: '海事异常航迹监控',
      prompt: '你是海事预警专家。请关注以下业务要求...',
      enabled: true,
    }),
  },
]
const timeline = buildTimelineFromMessages(messages, null)
assert.deepEqual(
  timeline.map(item => item.type),
  ['user_message', 'analysis_stream', 'agent_draft'],
  'timeline must include agent_draft items'
)
const draftItem = timeline.find(item => item.type === 'agent_draft')
assert.equal(draftItem.draft.name, '海事预警专家')
assert.equal(draftItem.draft.key, 'maritime-alert-expert')
assert.equal(draftItem.draft.prompt, '你是海事预警专家。请关注以下业务要求...')

// --- agent_draft without valid metadata is skipped ---
const badMessages = [
  {
    id: 'd2',
    role: 'agent',
    kind: 'agent_draft',
    content: '',
    metadata_json: 'not valid json',
  },
]
const badTimeline = buildTimelineFromMessages(badMessages, null)
assert.equal(badTimeline.length, 0, 'invalid agent_draft metadata must be skipped')

// --- SSE event applyAgentDraftEvent ---
let state = initialConversationState()
state = { ...state, selectedSessionId: 'clar_1' }

state = applyConversationEvent(state, 'agent_authoring.draft.updated', {
  type: 'agent_authoring.draft.updated',
  session_id: 'clar_1',
  data: {
    key: 'report-writer',
    name: '报表生成专家',
    description: '自动生成业务报表',
    prompt: '你是报表生成专家...',
    enabled: true,
  },
})
assert.equal(state.timeline.length, 1, 'SSE draft event must add timeline item')
assert.equal(state.timeline[0].type, 'agent_draft')
assert.equal(state.timeline[0].draft.name, '报表生成专家')
assert.equal(state.timeline[0].live, true, 'live SSE draft must have live flag')

// --- SSE event replaces existing live draft ---
state = applyConversationEvent(state, 'agent_authoring.draft.updated', {
  type: 'agent_authoring.draft.updated',
  session_id: 'clar_1',
  data: {
    key: 'report-writer',
    name: '报表生成专家 v2',
    description: '更新后的描述',
    prompt: '更新后的提示词...',
    enabled: true,
  },
})
assert.equal(state.timeline.length, 1, 'updated draft must replace, not append')
assert.equal(state.timeline[0].draft.name, '报表生成专家 v2')

// --- SSE event for foreign session does not enter current timeline ---
state = applyConversationEvent(state, 'agent_authoring.draft.updated', {
  type: 'agent_authoring.draft.updated',
  session_id: 'clar_999',
  data: { name: 'foreign', key: 'foreign' },
})
assert.equal(state.timeline.length, 1, 'foreign session draft must not enter current timeline')

console.log('check-agent-authoring-conversation: OK')
