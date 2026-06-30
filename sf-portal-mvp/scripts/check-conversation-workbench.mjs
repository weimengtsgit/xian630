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
assert.equal(state.timeline.at(-1).type, 'question_group')
assert.equal(state.timeline.some(item => item.type === 'blueprint_recommendation'), false)

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
const sessionNavJsx = readFileSync(new URL('../src/components/SessionNav.jsx', import.meta.url), 'utf8')
const sessionNavCss = readFileSync(new URL('../src/components/SessionNav.css', import.meta.url), 'utf8')
const apiClientJs = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const eventsJs = readFileSync(new URL('../src/api/events.js', import.meta.url), 'utf8')

assert.match(appJsx, /<ConversationWorkbench/, 'App must render ConversationWorkbench')
assert.doesNotMatch(appJsx, /<ClarificationPanel/, 'App must not render the old ClarificationPanel')
assert.doesNotMatch(appJsx, /<ChatDialog/, 'App must not render the old ChatDialog')
assert.match(appCss, /\.wb-center\s*>\s*\.conversation-workbench/, 'center column must allocate space to ConversationWorkbench')
// Phase 1 (workbench-drawer migration) MOVED historical sessions + 新建会话 +
// the history delete-confirm flow OUT of ConversationWorkbench into the left
// SessionNav rail. The center keeps the analysis process + option/custom
// clarification styling; history lives in SessionNav now. The center header
// (cw-actions) now holds ONLY the 3 drawer-entry buttons. (A terminal hint may
// still mention 新建会话 to point the user at the left nav — that's correct UX,
// not the old header button.)
assert.doesNotMatch(workbenchJsx, /历史会话/, 'Phase 1: ConversationWorkbench must NOT keep the 历史会话 button (moved to left SessionNav)')
const cwActionsBlock = workbenchJsx.match(/<div className="cw-actions">[\s\S]*?<\/div>/)
assert.ok(cwActionsBlock, 'ConversationWorkbench must keep a cw-actions header region')
assert.doesNotMatch(cwActionsBlock[0], /新建会话/, 'Phase 1: the center header (cw-actions) must NOT keep the 新建会话 button (moved to left SessionNav)')
assert.doesNotMatch(workbenchJsx, /cw-history-list|cw-history-close|cw-history-delete|cw-delete-confirm|DialogueHistoryDrawer/, 'Phase 1: ConversationWorkbench must NOT keep the history drawer markup (moved to SessionNav)')
assert.match(sessionNavJsx, /历史会话|session-nav-empty/, 'SessionNav must expose historical sessions (empty state or list)')
assert.match(sessionNavJsx, /新建会话/, 'SessionNav must expose the new-session action')
assert.match(workbenchJsx, /分析过程/, 'ConversationWorkbench must label user-facing analysis process')
assert.match(workbenchJsx, /handleAbandonRequirement/, 'ConversationWorkbench must route abandon through an explicit confirmation handler')
assert.match(workbenchJsx, /window\.confirm\('确定放弃本次需求吗？/, 'abandoning a requirement must ask for confirmation')
assert.match(workbenchJsx, /放弃本次需求/, 'the abandon action should use explicit low-frequency wording')
assert.match(workbenchCss, /\.cw-composer \.cw-abandon-requirement[\s\S]*background:\s*transparent/, 'the abandon action should be visually secondary')
assert.match(workbenchJsx, /optionIsRecommended/, 'question options must derive recommended state')
assert.match(workbenchJsx, /cw-option-recommended/, 'recommended question options must have a visual class')
assert.match(workbenchJsx, /cw-option-badge/, 'recommended question options must render a badge')
assert.match(workbenchJsx, /cw-custom-input/, 'custom clarification input must use a styled input class')
assert.match(workbenchJsx, /cw-custom-submit/, 'custom clarification add button must use a styled button class')
assert.match(workbenchCss, /\.cw-options button[\s\S]*cursor:\s*pointer/, 'question options must visibly afford clicking')
assert.match(workbenchCss, /selected\.cw-option-recommended|cw-option-recommended\.selected/, 'selected recommended options must keep visible selected state')
assert.match(workbenchJsx, /<div className="cw-composer-row">[\s\S]*<textarea[\s\S]*className="cw-send"/, 'composer textarea and send button must live in a dedicated row')
assert.match(workbenchCss, /\.cw-composer\s*\{[\s\S]*flex-direction:\s*column[\s\S]*align-items:\s*stretch/, 'composer must stack scope hint above the input row')
assert.match(workbenchCss, /\.cw-composer-row\s*\{[\s\S]*display:\s*flex[\s\S]*align-items:\s*flex-end/, 'composer row must align textarea and send button horizontally')
assert.match(workbenchCss, /\.cw-composer-row textarea\s*\{[\s\S]*min-width:\s*0/, 'composer textarea must be allowed to shrink inside the row without collapsing')
// History list + delete-confirm now live in SessionNav. Assert the SAME
// behaviors there (scrollable list, delete button, in-app confirm card,
// pendingDelete state, no window.confirm) — not deleted to force green.
assert.match(sessionNavJsx, /session-nav-list/, 'SessionNav must wrap sessions in a scrollable list')
assert.match(sessionNavCss, /\.session-nav-list\s*\{[\s\S]*overflow-y:\s*auto/, 'SessionNav list must scroll independently')
assert.match(sessionNavJsx, /onDeleteSession/, 'SessionNav must accept a delete history callback')
assert.match(sessionNavJsx, /session-nav-delete/, 'SessionNav must render a dedicated delete button')
assert.match(sessionNavJsx, /Trash2/, 'SessionNav delete button must use a delete icon')
assert.doesNotMatch(sessionNavJsx, /window\.confirm\s*\(/, 'SessionNav history deletion must NOT call window.confirm (use the in-app confirm card)')
assert.match(sessionNavJsx, /pendingDelete/, 'SessionNav history deletion must keep pending confirmation state')
assert.match(sessionNavJsx, /session-nav-delete-confirm/, 'SessionNav history deletion must render a custom confirmation panel')
assert.doesNotMatch(sessionNavJsx, /进行中的会话不可删除/, 'SessionNav must allow deleting a session in any status (no in-flight gate)')
assert.match(sessionNavCss, /\.session-nav-delete-confirm\s*\{[\s\S]*position:\s*absolute/, 'custom delete confirmation must be positioned inside the SessionNav rail')
assert.match(sessionNavCss, /\.session-nav-delete-actions/, 'custom delete confirmation must style action buttons')
assert.match(apiClientJs, /deleteDialogue/, 'API client must expose dialogue history deletion')
assert.match(eventsJs, /clarification\.deleted/, 'SSE event registry must include clarification.deleted')
assert.match(workbenchJsx, /deploymentStatusInfo/, 'ConversationWorkbench must derive deployment status info for the selected task')
assert.match(workbenchJsx, /cw-deployment-info/, 'ConversationWorkbench must render deployment info in the workbench body')
assert.match(workbenchJsx, /当前部署版本/, 'deployment info must label the current deployment version')
assert.match(workbenchJsx, /coreScenario/, 'deployment info must use the requirement coreScenario as the summary')
assert.match(workbenchCss, /\.cw-deployment-info/, 'deployment info must have dedicated workbench body styles')

const appsPanelJsx = readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const useApplicationsJs = readFileSync(new URL('../src/hooks/useApplications.js', import.meta.url), 'utf8')
assert.match(appsPanelJsx, /Trash2/, 'ApplicationsPanel must use a delete icon')
assert.match(appsPanelJsx, /isGenerated\(app\)[\s\S]*删除/, 'delete control must be gated to generated apps')
assert.match(useApplicationsJs, /deleteApplication/, 'useApplications must expose deleteApplication')
assert.match(useApplicationsJs, /app\.deleted/, 'useApplications must refresh on app.deleted')

console.log('check-conversation-workbench: OK')
