import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildTimelineFromMessages,
  initialConversationState,
  applyConversationEvent,
  questionsFromMessages,
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

const multiRoundMessages = [
  { id: 'u1', role: 'user', kind: 'prompt', content: '生成应用' },
  {
    id: 'q1',
    role: 'agent',
    kind: 'question',
    content: '',
    metadata_json: JSON.stringify({ id: 'targetUsers', label: '用户' }),
  },
  { id: 'ans1', role: 'user', kind: 'answer', content: 'ops', metadata_json: JSON.stringify({ questionId: 'targetUsers', value: 'ops' }) },
  {
    id: 'q2',
    role: 'agent',
    kind: 'question',
    content: '',
    metadata_json: JSON.stringify({ id: 'coreScenario', label: '核心场景' }),
  },
]
assert.deepEqual(questionsFromMessages(multiRoundMessages, 'waiting_user').map(q => q.id), ['coreScenario'])

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

state = applyConversationEvent(state, 'clarification.blueprint.recommended', {
  type: 'clarification.blueprint.recommended',
  session_id: 'clar_1',
  data: [{ id: 'carrier-formation-replay', name: '航母编队复盘', reason: '匹配复盘场景' }],
})
assert.equal(state.timeline.at(-1).type, 'blueprint_recommendation')
assert.equal(state.timeline.at(-1).blueprints[0].id, 'carrier-formation-replay')

state = {
  ...state,
  session: { id: 'clar_1', status: 'confirmed' },
  sessions: [{ id: 'clar_1' }, { id: 'clar_2' }],
}
state = applyConversationEvent(state, 'clarification.deleted', {
  type: 'clarification.deleted',
  session_id: 'clar_1',
})
assert.equal(state.selectedSessionId, null)
assert.equal(state.session, null)
assert.deepEqual(state.sessions.map(sess => sess.id), ['clar_2'])

const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const workbenchCss = readFileSync(new URL('../src/components/ConversationWorkbench.css', import.meta.url), 'utf8')
const apiClientJs = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const eventsJs = readFileSync(new URL('../src/api/events.js', import.meta.url), 'utf8')

assert.match(appJsx, /<ConversationWorkbench/, 'App must render ConversationWorkbench')
assert.doesNotMatch(appJsx, /<ClarificationPanel/, 'App must not render the old ClarificationPanel')
assert.doesNotMatch(appJsx, /<ChatDialog/, 'App must not render the old ChatDialog')
assert.match(appCss, /\.wb-center\s*>\s*\.conversation-workbench/, 'center column must allocate space to ConversationWorkbench')
assert.match(workbenchJsx, /历史会话/, 'ConversationWorkbench must expose historical sessions')
assert.match(workbenchJsx, /新建会话/, 'ConversationWorkbench must expose new session action')
assert.match(workbenchJsx, /分析过程/, 'ConversationWorkbench must label user-facing analysis process')
assert.match(workbenchJsx, /optionIsRecommended/, 'question options must derive recommended state')
assert.match(workbenchJsx, /cw-option-recommended/, 'recommended question options must have a visual class')
assert.match(workbenchJsx, /cw-option-badge/, 'recommended question options must render a badge')
assert.match(workbenchJsx, /cw-custom-input/, 'custom clarification input must use a styled input class')
assert.match(workbenchJsx, /cw-custom-submit/, 'custom clarification add button must use a styled button class')
assert.match(workbenchCss, /\.cw-options button[\s\S]*cursor:\s*pointer/, 'question options must visibly afford clicking')
assert.match(workbenchCss, /selected\.cw-option-recommended|cw-option-recommended\.selected/, 'selected recommended options must keep visible selected state')
assert.match(workbenchJsx, /cw-history-list/, 'history drawer must wrap sessions in a scrollable list')
assert.match(workbenchJsx, /cw-history-close/, 'history drawer close action must have a dedicated styled control')
assert.match(workbenchCss, /\.cw-history\s*\{[\s\S]*overflow:\s*hidden/, 'history drawer must clip overflowing content')
assert.match(workbenchCss, /\.cw-history-list\s*\{[\s\S]*overflow-y:\s*auto/, 'history drawer list must scroll independently')
assert.match(workbenchCss, /\.cw-history-close/, 'history close button must have dedicated styles')
assert.match(apiClientJs, /deleteDialogue/, 'API client must expose dialogue history deletion')
assert.match(eventsJs, /clarification\.deleted/, 'SSE event registry must include clarification.deleted')
assert.match(workbenchJsx, /onDeleteSession/, 'ConversationWorkbench must accept a delete history callback')
assert.match(workbenchJsx, /cw-history-delete/, 'history drawer must render a dedicated delete button')
assert.match(workbenchJsx, /Trash2/, 'history drawer delete button must use a delete icon')
assert.doesNotMatch(workbenchJsx, /window\.confirm/, 'history deletion must use an in-app confirmation instead of browser native confirm')
assert.match(workbenchJsx, /pendingDelete/, 'history deletion must keep pending confirmation state')
assert.match(workbenchJsx, /cw-delete-confirm/, 'history deletion must render a custom confirmation panel')
assert.match(workbenchJsx, /deletable/, 'history drawer must gate deletion by session status')
assert.match(workbenchCss, /\.cw-history-delete/, 'history delete button must have dedicated styles')
assert.match(workbenchCss, /\.cw-delete-confirm\s*\{[\s\S]*position:\s*absolute/, 'custom delete confirmation must be positioned inside the workbench')
assert.match(workbenchCss, /\.cw-delete-confirm-actions/, 'custom delete confirmation must style action buttons')
assert.match(workbenchJsx, /updated_at/, 'history drawer must show updated time')
assert.match(workbenchJsx, /coreScenario/, 'history drawer must show requirement summary')
assert.match(workbenchJsx, /resolvedApplication|createdAgent|seededJob/, 'history drawer must show resolved outcome')

const appsPanelJsx = readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const useApplicationsJs = readFileSync(new URL('../src/hooks/useApplications.js', import.meta.url), 'utf8')
assert.match(appsPanelJsx, /Trash2/, 'ApplicationsPanel must use a delete icon')
assert.match(appsPanelJsx, /isGenerated\(app\)[\s\S]*删除/, 'delete control must be gated to generated apps')
assert.match(useApplicationsJs, /deleteApplication/, 'useApplications must expose deleteApplication')
assert.match(useApplicationsJs, /app\.deleted/, 'useApplications must refresh on app.deleted')

console.log('check-conversation-workbench: OK')
