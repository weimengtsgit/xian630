import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildTimelineFromMessages,
  initialConversationState,
  applyConversationEvent,
  titleForSession,
} from '../src/hooks/conversationTimeline.js'

const session = {
  id: 'clar_1',
  status: 'waiting_user',
  initial_prompt: '生成一个航母编队复盘应用',
  requirement: { appName: '航母编队复盘应用', appType: 'situation_replay', coreScenario: '复盘近 1 个月航迹' },
}

assert.equal(titleForSession(session), '航母编队复盘应用')
assert.equal(titleForSession({ initial_prompt: 'x'.repeat(60), requirement: {} }).length <= 35, true)

const messages = [
  { id: 'u1', role: 'user', kind: 'prompt', content: '生成应用' },
  { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '识别到这是态势复盘类应用。' },
  {
    id: 'q1',
    role: 'agent',
    kind: 'question',
    content: '',
    metadata_json: JSON.stringify({ id: 'targetUsers', label: '用户', options: [{ value: 'ops', label: '作战参谋' }] }),
  },
  { id: 'ans1', role: 'user', kind: 'answer', content: 'ops', metadata_json: JSON.stringify({ questionId: 'targetUsers', value: 'ops' }) },
]
const timeline = buildTimelineFromMessages(messages, session)
assert.deepEqual(timeline.map(item => item.type), ['user_message', 'analysis_stream', 'question_group', 'user_message', 'requirement_summary'])
assert.equal(timeline[2].questions[0].id, 'targetUsers')

let state = initialConversationState()
state = { ...state, selectedSessionId: 'clar_1' }
state = applyConversationEvent(state, 'clarification.message.delta', {
  type: 'clarification.message.delta',
  session_id: 'clar_2',
  message_id: 'foreign',
  delta: 'must not enter current timeline',
})
assert.equal(state.timeline.length, 0)
assert.equal(state.sessionActivity.clar_2.status, 'updated')

state = applyConversationEvent(state, 'clarification.message.delta', {
  type: 'clarification.message.delta',
  session_id: 'clar_1',
  message_id: 'm1',
  delta: '本轮正在分析需求',
})
assert.equal(state.timeline.length, 1)
assert.equal(state.timeline[0].content, '本轮正在分析需求')

state = applyConversationEvent(state, 'clarification.question.created', {
  type: 'clarification.question.created',
  session_id: 'clar_1',
  data: { id: 'app_type', label: '应用类型', options: [{ value: 'command_dashboard', label: '指挥看板' }] },
})
assert.equal(state.questions.length, 1)
assert.equal(state.timeline.at(-1).type, 'question_group')

const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')

assert.match(appJsx, /<ConversationWorkbench/, 'App must render ConversationWorkbench')
assert.doesNotMatch(appJsx, /<ClarificationPanel/, 'App must not render the old ClarificationPanel')
assert.doesNotMatch(appJsx, /<ChatDialog/, 'App must not render the old ChatDialog')
assert.match(appCss, /\.wb-center\s*>\s*\.conversation-workbench/, 'center column must allocate space to ConversationWorkbench')
assert.match(workbenchJsx, /历史会话/, 'ConversationWorkbench must expose historical sessions')
assert.match(workbenchJsx, /新建会话/, 'ConversationWorkbench must expose new session action')
assert.match(workbenchJsx, /模型分析过程/, 'ConversationWorkbench must label user-facing model analysis process')

console.log('check-conversation-workbench: OK')
