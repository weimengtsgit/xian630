// Pure-logic + static checks for the dialogue-driven ConversationWorkbench (Task 5).
// Runs under node with NO React import. It exercises the dialogueTimeline mapper
// (pure reducer + builders) and asserts static source invariants:
//   - the workbench imports dialogue APIs and NOT the old useConversationSessions
//   - no 蓝本/模板/blueprint/internal-slug strings leak into the workbench source
//   - locked-route composer behavior (non-editable when route locked/terminal)
//
// The dialogueTimeline contract mirrors the backend DialogueView (Task 4):
//   { session, messages[], route{intent,confidence,needsRouteConfirmation,userFacingReason},
//     recommendations[{applicationId,slug,name,appType,matchReason,status,runtimeUrl,primary}],
//     agentDraft{name,description,prompt}, child{...clarificationView}, resolvedApplication,
//     createdAgent, seededJob }
//
// The mapper consumes persisted parent+child messages and emits SEMANTIC UI items,
// deliberately dropping unknown/internal metadata keys (blueprint/internal-slug/thinking).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildDialogueTimeline,
  initialDialogueState,
  applyDialogueEvent,
  lockedFromView,
  openQuestionsForView,
  statusText,
  titleForDialogue,
} from '../src/hooks/dialogueTimeline.js'

// ---- route event ordering + primary/alternatives ----------------------------

// A recommending view carries one primary + up to two alternatives.
const recommendingView = {
  session: {
    id: 'dlg_1', status: 'recommending', intent: 'existing_application',
    route_locked: true, initial_prompt: '我想看航母编队态势',
  },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '我想看航母编队态势' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '匹配到已有态势看板应用。' },
  ],
  route: {
    intent: 'existing_application', confidence: 'high', needsRouteConfirmation: false,
    userFacingReason: '已有航母编队态势看板覆盖该需求', existingApplicationSlugs: ['carrier-formation', 'fleet-ops'],
  },
  recommendations: [
    { applicationId: 'app_1', slug: 'carrier-formation', name: '航母编队态势看板', appType: 'command_dashboard', matchReason: '覆盖该需求', status: 'running', runtimeUrl: 'http://x', primary: true },
    { applicationId: 'app_2', slug: 'fleet-ops', name: '舰队作战应用', appType: 'command_dashboard', matchReason: '覆盖该需求', status: 'stopped', primary: false },
  ],
}

const recTimeline = buildDialogueTimeline(recommendingView)
const recTypes = recTimeline.map(item => item.type)
// Ordering: user message first, then analysis, then app recommendation cards.
assert.deepEqual(recTypes, ['user_message', 'analysis_stream', 'app_recommendation'], `route timeline ordering wrong: ${JSON.stringify(recTypes)}`)
const appItem = recTimeline[2]
assert.equal(appItem.cards.length, 2)
assert.equal(appItem.cards[0].primary, true, 'first recommendation must be primary')
assert.equal(appItem.cards.filter(c => c.primary).length, 1, 'exactly one primary recommendation')
assert.equal(appItem.cards.length <= 3, true, 'at most 1 primary + 2 alternatives')

// Each card must NOT carry any internal/blueprint slug or hidden id beyond the
// applicationId + runtimeUrl the workbench legitimately needs to open the app.
for (const card of appItem.cards) {
  assert.equal(card.internalBlueprintSlug, undefined, 'card must not leak internalBlueprintSlug')
  assert.equal(card.blueprint, undefined, 'card must not leak blueprint field')
}

// Continuing-session inquiry replies are persisted as ordinary agent replies and
// must remain visible in the dialogue thread, not be dropped as unknown metadata.
const inquiryTimeline = buildDialogueTimeline({
  session: { id: 'dlg_inquiry', status: 'active', intent: 'application_generation', route_locked: true },
  messages: [
    { id: 'u_q', role: 'user', kind: 'message', content: '为什么 AviationCarrier 401？' },
    { id: 'a_reply', role: 'agent', kind: 'reply', content: 'HTTP 401 表示认证失败。' },
  ],
  route: {},
})
assert.deepEqual(
  inquiryTimeline.map(item => item.type),
  ['user_message', 'agent_message'],
  'continuing-session agent replies must render as visible agent_message items',
)
assert.equal(inquiryTimeline[1].content, 'HTTP 401 表示认证失败。')

// ---- no blueprint text in rendered timeline items ---------------------------

// The requirement summary must not surface BlueprintRefs even if the raw child
// requirement (server-side-only) were to carry them in a legacy payload.
const draftView = {
  session: { id: 'dlg_2', status: 'drafting_application', intent: 'application_generation', route_locked: true, initial_prompt: '生成一个复盘应用' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成一个复盘应用' }],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  child: {
    id: 'clar_1', status: 'ready_to_confirm', round: 6, max_rounds: 6,
    requirement: {
      appType: 'situation_replay', appName: '航母编队复盘', coreScenario: '复盘航迹',
      primaryView: '时间轴', dataPolicy: '本地',
      // Legacy/internal field that must NEVER surface in the UI.
      blueprintRefs: ['carrier-formation-replay'],
    },
  },
}
const draftTimeline = buildDialogueTimeline(draftView)
const draftSerialized = JSON.stringify(draftTimeline)
assert.equal(draftSerialized.includes('blueprint'), false, 'timeline must not contain blueprint text')
assert.equal(draftSerialized.includes('蓝本'), false, 'timeline must not contain 蓝本 text')
assert.equal(draftSerialized.includes('模板'), false, 'timeline must not contain 模板 text')
assert.equal(draftSerialized.includes('carrier-formation-replay'), false, 'timeline must not leak internal blueprint slug')
// requirement summary must be present for a ready_to_confirm child.
assert.equal(draftTimeline.some(item => item.type === 'requirement_summary'), true, 'ready_to_confirm child must yield a requirement summary')

// ---- locked-route composer behavior ----------------------------------------

// routing (route not yet locked, no confirmation needed) => composer editable
const routingView = {
  session: { id: 'dlg_3', status: 'routing', intent: 'routing', route_locked: false, initial_prompt: 'help me' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: 'help me' }],
  route: { intent: 'existing_application', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
}
assert.equal(lockedFromView(routingView), false, 'unlocked routing view with a clear route must keep composer editable')

// route locked but intent ambiguous (needsRouteConfirmation) => composer locked
const ambiguousView = {
  session: { id: 'dlg_4', status: 'routing', intent: 'routing', route_locked: false, initial_prompt: 'help' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: 'help' }],
  route: { intent: 'routing', confidence: 'medium', needsRouteConfirmation: true, userFacingReason: '可复用应用或新生成' },
}
// When route confirmation is needed, route cards render; composer is NOT free-text editable.
assert.equal(lockedFromView(ambiguousView), true, 'route-needs-confirmation view must lock free-text composer')

// An application-generation route with no recommended existing application must
// still expose a way to continue, without rendering an unusable reuse action.
const generationChoiceView = {
  session: { id: 'dlg_generation_choice', status: 'routing', intent: 'routing', route_locked: false, initial_prompt: '创建一个新的排班应用' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '创建一个新的排班应用' }],
  route: {
    intent: 'application_generation', confidence: 'high', needsRouteConfirmation: true,
    userFacingReason: '我会澄清需求并生成一个可运行的新应用。', existingApplicationSlugs: [],
  },
}
const generationChoice = buildDialogueTimeline(generationChoiceView).find(item => item.type === 'route_recommendation')
assert.ok(generationChoice, 'application generation must render a route-selection action')
assert.equal(generationChoice.canReuseExistingApplication, false, 'an empty existing-app match must not render a reuse action')

// resolved/abandoned/failed => terminal => composer locked
for (const status of ['resolved', 'abandoned', 'failed']) {
  const termView = {
    session: { id: `dlg_t_${status}`, status, intent: 'existing_application', route_locked: true, initial_prompt: 'x' },
    messages: [],
    route: { intent: 'existing_application', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  }
  assert.equal(lockedFromView(termView), true, `${status} must lock composer (terminal)`)
}

// ---- open questions feed the answer bar (regression for review P0 #2) --------

// loadView must derive the answer-bar `questions` from the open child questions;
// ConversationWorkbench's 提交本轮澄清 control depends on questions.length > 0.
// openQuestionsForView is the pure derivation the hook now consumes.
const openQuestionView = {
  session: { id: 'dlg_q', status: 'drafting_application', intent: 'application_generation', route_locked: true, initial_prompt: 'gen' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: 'gen' }],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  child: {
    id: 'clar_q', status: 'active', round: 1, max_rounds: 6, requirement: {},
    messages: [
      { id: 'cmq', role: 'agent', kind: 'question', metadata_json: JSON.stringify({ id: 'appType', label: '应用类型', options: [{ value: 'dashboard', label: '看板' }, { value: 'map', label: '地图' }], recommendation: 'dashboard' }) },
    ],
  },
}
const openQs = openQuestionsForView(openQuestionView)
assert.equal(openQs.length, 1, `openQuestionsForView must surface the open child question; got ${openQs.length}`)
assert.equal(openQs[0].id, 'appType', 'open question id must be appType')
assert.equal(openQs[0].options.length, 2, 'open question must carry its options for the answer bar')
// A ready_to_confirm child has no open questions.
const readyView = { ...openQuestionView, child: { ...openQuestionView.child, status: 'ready_to_confirm' } }
assert.equal(openQuestionsForView(readyView).length, 0, 'ready_to_confirm child must yield no open questions')

// ---- adaptive round-5 consolidation render ----------------------------------

// A round-5 child carrying a recommendation_consolidation message must render a
// consolidation table item with 接受推荐 + one-field-adjust controls (asserted via
// the timeline item shape; the workbench renders the controls).
const round5View = {
  session: { id: 'dlg_5', status: 'drafting_application', intent: 'application_generation', route_locked: true, initial_prompt: 'gen' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: 'gen' }],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  child: {
    id: 'clar_5', status: 'active', round: 5, max_rounds: 6,
    requirement: { appType: '', appName: '', coreScenario: '' },
  },
  // The child messages stream arrives via the child view's messages; the timeline
  // builder reads them off child.messages.
  childMessages: [
    { id: 'cm1', role: 'agent', kind: 'recommendation_consolidation', metadata_json: JSON.stringify([
      { field: 'appType', recommendedValue: 'command_dashboard', reason: '指挥看板最匹配', alternatives: ['situation_replay'] },
      { field: 'primaryView', recommendedValue: '地图', reason: '地图为主视图' },
    ]) },
  ],
}
const round5Timeline = buildDialogueTimeline({ ...round5View, child: { ...round5View.child, messages: round5View.childMessages } })
assert.equal(round5Timeline.some(item => item.type === 'consolidation_table'), true, 'round-5 consolidation must render a consolidation table item')
const tableItem = round5Timeline.find(item => item.type === 'consolidation_table')
assert.equal(tableItem.rows.length, 2, 'consolidation table must list each recommended field')
assert.equal(tableItem.rows[0].field, 'appType')

// ---- business-draft confirmation controls -----------------------------------

const businessView = {
  session: { id: 'dlg_6', status: 'drafting_business_agent', intent: 'business_processing_agent', route_locked: true, initial_prompt: '帮我做一个告警分诊助手' },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '帮我做一个告警分诊助手' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '将配置为业务处理 Agent。' },
  ],
  route: { intent: 'business_processing_agent', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '适合配置为业务 Agent' },
  agentDraft: { name: '告警分诊助手', description: '按规则分诊告警', prompt: '你是告警分诊助手...' },
}
const businessTimeline = buildDialogueTimeline(businessView)
assert.equal(businessTimeline.some(item => item.type === 'business_recommendation' || item.type === 'agent_draft'), true, 'business drafting must surface a recommendation/draft item')
// No raw prompt/hidden reasoning leak beyond the draft's own fields.
const bizSerialized = JSON.stringify(businessTimeline)
assert.equal(bizSerialized.includes('internalBlueprintSlug'), false)

// ---- business-draft multi-round question visibility (regression P0 #4) -------

// A business-drafting round that asks a clarifying question must surface it as an
// answerable question_group (parent agent question after the last user turn), so
// the locked business route — which has no free-text /messages path — can still
// collect the answer via the continue endpoint.
const businessQuestionView = {
  session: { id: 'dlg_bq', status: 'drafting_business_agent', intent: 'business_processing_agent', route_locked: true, initial_prompt: '做一个告警分诊助手' },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '做一个告警分诊助手' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '需要确认分诊范围' },
    { id: 'q1', role: 'agent', kind: 'question', metadata_json: JSON.stringify({ id: 'scope', label: '分诊范围', options: [{ value: 'all', label: '全部告警' }, { value: 'critical', label: '仅严重告警' }], recommendation: 'all' }) },
  ],
  route: { intent: 'business_processing_agent', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  agentDraft: { name: '', description: '', prompt: '' },
}
const bizQTimeline = buildDialogueTimeline(businessQuestionView)
assert.equal(bizQTimeline.some(item => item.type === 'question_group'), true, 'business drafting must surface its open clarifying question as a question_group')
const bizOpenQs = openQuestionsForView(businessQuestionView)
assert.equal(bizOpenQs.length, 1, 'openQuestionsForView must surface the business question for the answer bar')
assert.equal(bizOpenQs[0].id, 'scope', 'business open question id must be scope')

// Business-agent round-5 consolidation must use the same recommendation table
// surface as application clarification, but it lives on the parent dialogue
// messages rather than on a child clarification view.
const businessConsolidationView = {
  session: { id: 'dlg_bc', status: 'drafting_business_agent', intent: 'business_processing_agent', route_locked: true, initial_prompt: '做一个告警分诊助手' },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '做一个告警分诊助手' },
    { id: 'c1', role: 'agent', kind: 'recommendation_consolidation', metadata_json: JSON.stringify([
      { field: 'agentDraft.name', recommendedValue: '告警分诊助手', reason: '匹配业务目标', alternatives: ['告警处置助手'] },
      { field: 'agentDraft.prompt', recommendedValue: '你是告警分诊助手。', reason: '可保存为业务 Agent 指令' },
    ]) },
  ],
  route: { intent: 'business_processing_agent', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  agentDraftStatus: 'waiting_user',
  agentDraft: { name: '告警分诊助手', description: '', prompt: '' },
}
const bizConsolidationTimeline = buildDialogueTimeline(businessConsolidationView)
assert.equal(bizConsolidationTimeline.some(item => item.type === 'consolidation_table'), true, 'business round-5 consolidation must render a consolidation table')
assert.equal(openQuestionsForView(businessConsolidationView).length, 0, 'business consolidation view must not fabricate open questions')

// ---- resolved application/agent history records -----------------------------

// Resolved existing-application dialogue => resolved outcome item naming the app.
const resolvedAppView = {
  session: { id: 'dlg_7', status: 'resolved', intent: 'existing_application', route_locked: true, initial_prompt: '看态势' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '看态势' }],
  route: { intent: 'existing_application', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  resolvedApplication: { id: 'app_1', slug: 'carrier-formation', name: '航母编队态势看板', status: 'running' },
}
const resolvedAppTimeline = buildDialogueTimeline(resolvedAppView)
assert.equal(resolvedAppTimeline.some(item => item.type === 'resolved_outcome'), true, 'resolved dialogue must render a resolved outcome item')
const resolvedItem = resolvedAppTimeline.find(item => item.type === 'resolved_outcome')
assert.ok(['application', 'agent', 'job'].includes(resolvedItem.kind), `unexpected resolved outcome kind: ${resolvedItem.kind}`)

// Resolved business-agent dialogue => resolved outcome naming the agent.
const resolvedAgentView = {
  session: { id: 'dlg_8', status: 'resolved', intent: 'business_processing_agent', route_locked: true, initial_prompt: '分诊' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '分诊' }],
  route: { intent: 'business_processing_agent', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  createdAgent: { id: 'agent_1', key: 'biz-abc', name: '告警分诊助手', role: 'business_processing' },
}
const resolvedAgentTimeline = buildDialogueTimeline(resolvedAgentView)
assert.equal(resolvedAgentTimeline.some(item => item.type === 'resolved_outcome'), true)
const agentOutcome = resolvedAgentTimeline.find(item => item.type === 'resolved_outcome')
assert.equal(agentOutcome.kind, 'agent')

// Resolved application-generation dialogue => resolved outcome naming the seeded job.
const resolvedJobView = {
  session: { id: 'dlg_9', status: 'resolved', intent: 'application_generation', route_locked: true, initial_prompt: '生成态势看板' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成态势看板' }],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  seededJob: { id: 'job_1', app_name: '态势看板' },
}
const resolvedJobTimeline = buildDialogueTimeline(resolvedJobView)
assert.equal(resolvedJobTimeline.some(item => item.type === 'resolved_outcome'), true)
const jobOutcome = resolvedJobTimeline.find(item => item.type === 'resolved_outcome')
assert.equal(jobOutcome.kind, 'job')

// ---- event hydration after reload ------------------------------------------

// A dialogue.* event for a DIFFERENT dialogue must record activity, not clobber
// the selected view's timeline.
let state = initialDialogueState()
state = { ...state, selectedDialogueId: 'dlg_1' }
state = applyDialogueEvent(state, 'dialogue.intent.updated', {
  dialogue_id: 'dlg_2', data: { intent: 'existing_application' },
})
assert.equal(state.dialogueActivity['dlg_2'].status, 'updated', 'foreign dialogue event must record activity not refresh')

// A dialogue.resolved event for the selected dialogue must flag a targeted refresh.
state = applyDialogueEvent(state, 'dialogue.resolved', {
  dialogue_id: 'dlg_1', data: { resolved_application_id: 'app_1' },
})
assert.equal(state.needsRefresh, 'dlg_1', 'selected dialogue resolved must request a targeted refresh by id')

// A wrapped clarification event (dialogue.clarification.updated) must also key by dialogue_id.
state = applyDialogueEvent(state, 'dialogue.clarification.updated', {
  dialogue_id: 'dlg_1', data: { child_id: 'clar_1' },
})
assert.equal(state.needsRefresh, 'dlg_1', 'wrapped clarification event must request a targeted refresh by dialogue id')

// ---- title + status text ----------------------------------------------------

assert.equal(titleForDialogue(recommendingView.session), '我想看航母编队态势')
assert.equal(statusText('routing'), '识别需求中')
assert.equal(statusText('recommending'), '推荐智能体中')
assert.equal(statusText('drafting_application'), '需求澄清中')
assert.equal(statusText('drafting_business_agent'), '配置 Agent 中')
assert.equal(statusText('resolved'), '已完成')
assert.equal(statusText('failed'), '已失败')
assert.equal(statusText('abandoned'), '已放弃')
assert.equal(statusText('unknown'), 'unknown')

// ---- static source checks ---------------------------------------------------

const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const workbenchCss = readFileSync(new URL('../src/components/ConversationWorkbench.css', import.meta.url), 'utf8')
const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const apiClientJs = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const eventsJs = readFileSync(new URL('../src/api/events.js', import.meta.url), 'utf8')
const dialogueHookJs = readFileSync(new URL('../src/hooks/useDialogueSessions.js', import.meta.url), 'utf8')
const routingSkill = readFileSync(new URL('../../.claude/skills/dialogue-intent-routing/SKILL.md', import.meta.url), 'utf8')

// The hook MUST derive the answer-bar questions from the open child questions
// (regression for review P0 #2): without it the submit control never renders.
assert.match(dialogueHookJs, /openQuestionsForView/, 'useDialogueSessions must derive questions via openQuestionsForView')

// The workbench + App must use dialogue APIs, not the old clarification hook.
assert.match(workbenchJsx, /dialogueTimeline|useDialogueSessions|titleForDialogue/, 'workbench must consume the dialogue timeline')
assert.doesNotMatch(workbenchJsx, /useConversationSessions/, 'workbench must NOT import the old useConversationSessions hook')
assert.match(appJsx, /useDialogueSessions/, 'App must use the useDialogueSessions hook')
assert.doesNotMatch(appJsx, /useConversationSessions/, 'App must NOT import useConversationSessions')
assert.match(apiClientJs, /listDialogues/, 'API client must expose listDialogues')
assert.match(apiClientJs, /createDialogue/, 'API client must expose createDialogue')
assert.match(apiClientJs, /selectDialogueRoute/, 'API client must expose selectDialogueRoute')
assert.match(apiClientJs, /openDialogueApplication/, 'API client must expose openDialogueApplication')
assert.match(apiClientJs, /answerDialogueClarificationBatch/, 'API client must expose answerDialogueClarificationBatch')
assert.match(apiClientJs, /patchDialogueRequirement/, 'API client must expose patchDialogueRequirement')
assert.match(apiClientJs, /confirmDialogueClarification/, 'API client must expose confirmDialogueClarification')
assert.match(apiClientJs, /confirmDialogueBusinessAgent/, 'API client must expose confirmDialogueBusinessAgent')
assert.match(eventsJs, /dialogue\.intent\.updated/, 'SSE registry must include dialogue.intent.updated')
assert.match(eventsJs, /dialogue\.application\.recommended/, 'SSE registry must include dialogue.application.recommended')
assert.match(eventsJs, /dialogue\.route\.confirmed/, 'SSE registry must include dialogue.route.confirmed')
assert.match(eventsJs, /dialogue\.route\.delta/, 'SSE registry must include dialogue.route.delta for live routing output')
assert.match(eventsJs, /dialogue\.draft\.delta/, 'SSE registry must include dialogue.draft.delta for live business drafting output')
assert.match(eventsJs, /dialogue\.draft\.consolidation\.updated/, 'SSE registry must include business draft consolidation updates')
assert.match(eventsJs, /dialogue\.agent_draft\.updated/, 'SSE registry must include dialogue.agent_draft.updated')
assert.match(eventsJs, /dialogue\.agent\.created/, 'SSE registry must include dialogue.agent.created')
assert.match(eventsJs, /dialogue\.resolved/, 'SSE registry must include dialogue.resolved')
assert.match(dialogueHookJs, /dialogue\.draft\.delta/, 'useDialogueSessions must route dialogue.draft.delta events into targeted refresh handling')
assert.match(workbenchJsx, /agentDraftStatus/, 'business confirm button must be gated by agentDraftStatus')

// No blueprint / template / hidden-id strings in the workbench source.
assert.doesNotMatch(workbenchJsx, /蓝本/, 'workbench must not surface the word 蓝本')
assert.doesNotMatch(workbenchJsx, /模板/, 'workbench must not surface the word 模板')
assert.doesNotMatch(workbenchJsx, /blueprint/, 'workbench must not surface blueprint identifiers')
assert.doesNotMatch(workbenchJsx, /internalBlueprintSlug/, 'workbench must not reference internal blueprint slug')
assert.doesNotMatch(workbenchJsx, /internal_slug/, 'workbench must not reference internal slugs')
assert.doesNotMatch(workbenchCss, /蓝本/, 'workbench CSS must not surface 蓝本')

// The composer must be non-editable when the route is locked/terminal: either the
// textarea is disabled, or the locked branch suppresses the textarea entirely.
assert.match(workbenchJsx, /lockedFromView|locked\b/, 'workbench must derive a locked flag for the composer')
assert.ok(
  /disabled=\{[^}]*submitting/.test(workbenchJsx) || /locked\s*\?/.test(workbenchJsx),
  'composer must be gated (disabled or suppressed) when locked',
)

// App recommendation cards: running => 打开智能体; stopped => 启动并打开.
assert.match(workbenchJsx, /打开智能体/, 'running recommendation card must offer 打开智能体')
assert.match(workbenchJsx, /启动并打开/, 'stopped recommendation card must offer 启动并打开')

// Route cards render when intent is ambiguous.
assert.match(workbenchJsx, /route_recommendation|route_choice/, 'workbench must render route choice cards')

// Round-5 table with accept + adjust controls.
assert.match(workbenchJsx, /接受推荐/, 'round-5 table must offer 接受推荐')
assert.match(workbenchJsx, /consolidation_table|consolidation/, 'round-5 table must render consolidation rows')

// Business recommendation with explicit confirm + re-describe.
assert.match(workbenchJsx, /确认创建|确认配置/, 'business recommendation must offer an explicit confirm/create action')
assert.match(workbenchJsx, /重新描述|重新说明/, 'business recommendation must offer a re-describe action')

// Route choices must NOT expose the business_processing_agent option, but must
// still offer existing-app reuse and app generation.
assert.doesNotMatch(workbenchJsx, /onSelectRoute\('business_processing_agent'\)/, 'route choices must not expose business_processing_agent')
assert.doesNotMatch(workbenchJsx, /配置业务 Agent/, 'route choices must not show 配置业务 Agent')
assert.doesNotMatch(workbenchJsx, /创建一个业务处理 Agent/, 'route choices must not show 创建一个业务处理 Agent')
assert.match(workbenchJsx, /复用已有智能体/, 'route choices must still offer existing-agent reuse')
assert.match(workbenchJsx, /生成新智能体/, 'route choices must still offer agent generation')
assert.match(workbenchJsx, /canReuseExistingApplication/, 'route choices must hide reuse when no application is recommended')

const genericReasonRule = routingSkill.match(/- `userFacingReason`[\s\S]*?- `needsRouteConfirmation`/)
assert.ok(genericReasonRule, 'routing skill must define the user-facing reason rule')
assert.match(genericReasonRule[0], /runnable application/, 'generic application generation must describe a runnable application')
assert.doesNotMatch(genericReasonRule[0], /assistant application/, 'only agent or assistant requests may be framed as assistant applications')
// TimelineItem MUST receive onSend (regression for review P1 #5): the business
// recommendation branch references onRedescribe={onSend}, so an unthreaded onSend
// threw a ReferenceError and crashed the whole workbench render.
assert.match(workbenchJsx, /onSend=\{onSend\}/, 'TimelineItem must receive onSend so the business re-describe action does not crash')

// Resolved state non-editable with a clear 新建会话 action (already present, re-assert).
assert.match(workbenchJsx, /新建会话/, 'resolved state must keep a clear 新建会话 action')

// ---- Task 1 (D5): optimistic user-message insert + faster send ---------------

// buildDialogueTimeline must accept an optional optimistic user message and
// PREPEND it as a user_message item, so the user sees their own message
// immediately (before any server round-trip).
const baseSendView = {
  session: { id: 'dlg_opt', status: 'drafting_application', intent: 'application_generation', route_locked: true, initial_prompt: 'gen' },
  messages: [{ id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '正在分析...' }],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
}
const optimisticTimeline = buildDialogueTimeline(baseSendView, { id: 'opt_1', content: '帮我做一个排班应用' })
const optTypes = optimisticTimeline.map(item => item.type)
assert.equal(optTypes[0], 'user_message', `optimistic message must be prepended as a user_message; got ${JSON.stringify(optTypes)}`)
assert.equal(optimisticTimeline[0].id, 'opt_1', 'optimistic user_message must keep its client id')
assert.equal(optimisticTimeline[0].content, '帮我做一个排班应用', 'optimistic user_message must carry the typed content')
assert.equal(optimisticTimeline[0].optimistic, true, 'optimistic user_message must be flagged so the UI can style/rollback it')

// When the reloaded persisted view ALREADY contains a user message with identical
// content for this turn, the optimistic message must be DEDUPED (not rendered
// twice) — the persisted message is authoritative.
const reloadedView = {
  ...baseSendView,
  messages: [
    { id: 'u_real', role: 'user', kind: 'prompt', content: '帮我做一个排班应用' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '正在分析...' },
  ],
}
const dedupedTimeline = buildDialogueTimeline(reloadedView, { id: 'opt_1', content: '帮我做一个排班应用' })
const userMsgItems = dedupedTimeline.filter(item => item.type === 'user_message')
assert.equal(userMsgItems.length, 1, `persisted+identical optimistic must dedupe to one user_message; got ${userMsgItems.length}`)
assert.equal(userMsgItems[0].id, 'u_real', 'deduped user_message must keep the PERSISTED id (authoritative)')

// A DIFFERENT content optimistic message is NOT deduped (it is a distinct turn's
// in-flight message), so it still prepends.
const distinctTimeline = buildDialogueTimeline(reloadedView, { id: 'opt_2', content: '另一个问题' })
const distinctUserMsgs = distinctTimeline.filter(item => item.type === 'user_message')
assert.equal(distinctUserMsgs.length, 2, 'a distinct-content optimistic message must NOT be deduped')
assert.equal(distinctUserMsgs[0].id, 'opt_2', 'distinct optimistic message prepends first')

// A null/empty optimistic message must be a no-op (no phantom user_message item).
const nullOptTimeline = buildDialogueTimeline(reloadedView, null)
assert.equal(nullOptTimeline.filter(item => item.type === 'user_message').length, 1, 'null optimistic message must not add a phantom item')

// ---- Static checks on the send path in useDialogueSessions.js ----------------

// The send path must set the optimistic message SYNCHRONOUSLY before the first
// network await (so the user message renders before any round-trip).
assert.match(dialogueHookJs, /optimisticUserMessage/, 'send must reference optimisticUserMessage state')
// Extract ONLY the send function body so the refresh-ordering assertion does not
// trip on the other mutating actions (selectRoute/openApp/...) which legitimately
// await refreshSessions before loadView.
const sendFnMatch = dialogueHookJs.match(/const send = useCallback\(async content => \{[\s\S]*?\}, \[loadView, refreshSessions, state\.view, submitting\]\)/)
assert.ok(sendFnMatch, 'could not locate the send useCallback body for static checks')
const sendBody = sendFnMatch[0]
assert.ok(
  /setOptimisticUserMessage\([^)]*\)[\s\S]*?await\s+factoryApi/.test(sendBody),
  'send must set the optimistic message BEFORE the first factoryApi await',
)
// refreshSessions must NOT be awaited before loadView in the send happy path —
// the history list refresh must not block the selected-view load. The hook still
// kicks the refresh (fire-and-forget) so the list updates on its own.
assert.doesNotMatch(
  sendBody,
  /await refreshSessions\(\)[\s\S]{0,120}await loadView\(/,
  'send must NOT await refreshSessions() before loadView() — the history refresh must not block the view load',
)
assert.match(
  sendBody,
  /refreshSessions\(\)\.catch/,
  'send must still kick the history refresh (fire-and-forget) so the list updates',
)
// On error the optimistic message must be rolled back (cleared). A finally block
// clearing it guarantees both the success and failure paths reconcile.
assert.match(
  dialogueHookJs,
  /setOptimisticUserMessage\(null\)/,
  'send must clear the optimistic message (rollback) — on error and once the persisted view loads',
)

// A failed parent dialogue may have NO child clarification (for example a route
// runner failure). In that case "重试本轮" must not call the child clarification
// retry endpoint, because the backend correctly 409s with "dialogue has no active
// clarification child". The hook falls back to creating a fresh dialogue from the
// original prompt; child clarification failures still use retryDialogueRound.
const retryFnMatch = dialogueHookJs.match(/const retry = useCallback\(async \(\) => \{[\s\S]*?\}, \[loadView, refreshSessions, state\.view, submitting\]\)/)
assert.ok(retryFnMatch, 'could not locate the retry useCallback body for static checks')
const retryBody = retryFnMatch[0]
assert.match(retryBody, /child && child\.status === 'failed'[\s\S]*retryDialogueRound/, 'retry must call child clarification retry only when a failed child exists')
assert.match(retryBody, /createDialogue\(\{ initialPrompt: prompt \}\)/, 'retry without a failed child must create a fresh dialogue from the original prompt')

console.log('check-dialogue-workbench: OK')
