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
  buildTaskBlocks,
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

// ---- job-step clarification surfaces as a structured conversation card -------

// When a pipeline step (solution_design / code_generation) pauses for user
// input, the backend emits a clarification work trace. buildDialogueTimeline
// must turn it into a visible clarification_prompt card in the conversation
// flow (not just the folded trace panel), carrying the question text AND the
// structured options so the UI can render pickable choices.
const clarTimeline = buildDialogueTimeline(
  {
    session: { id: 'dlg_clar', status: 'active', intent: 'application_generation', route_locked: true },
    messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '做一个请假审批系统' }],
    route: {},
  },
  null, null, null,
  [
    { type: 'assistant_output', sequence: 1, payload: { text: '分析中' }, dialogueId: 'dlg_clar', id: 't1' },
    {
      type: 'clarification',
      sequence: 2,
      payload: {
        questions: [{
          id: 'data-source',
          // Agents emit the prompt under `text` OR `question`; honor both.
          text: '用演示数据还是真实API？',
          defaultAnswer: '演示数据',
          options: [
            // Options may use `id` OR `value`; the mapper must fall back.
            { id: 'use-mock-data', label: '使用演示数据模式', recommended: true },
            { id: 'provide-real-api', label: '提供真实后端API' },
          ],
        }],
      },
      dialogueId: 'dlg_clar',
      id: 't2',
    },
  ],
)
const clarCard = clarTimeline.find(it => it.type === 'clarification_prompt')
assert.ok(clarCard, 'a clarification work trace must surface as a clarification_prompt card')
assert.equal(clarCard.questions.length, 1, 'card carries one question')
assert.equal(clarCard.questions[0].question, '用演示数据还是真实API？')
assert.equal(clarCard.questions[0].options.length, 2, 'card carries the structured options')
assert.equal(clarCard.questions[0].options[0].value, 'use-mock-data')
assert.equal(clarCard.questions[0].options[0].recommended, true, 'recommended flag is preserved')

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
      judgementBoundary: {
        dataSources: ['ontology', 'public_web_search'],
        summary: '基于航母轨迹数据判断事件关联',
      },
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
const draftRequirementSummary = draftTimeline.find(item => item.type === 'requirement_summary')
assert.equal(draftRequirementSummary.requirement.judgementBoundary.summary, '基于航母轨迹数据判断事件关联', 'requirement summary must retain judgement boundary summary')
assert.deepEqual(draftRequirementSummary.requirement.judgementBoundary.dataSources, ['ontology', 'public_web_search'], 'requirement summary must retain safe data-source families')

// Batched multi-select answers must render selected option labels, not the raw
// JSON array value, so data-source answers read like business language.
const multiAnswerTimeline = buildDialogueTimeline({
  session: { id: 'dlg_multi_answer', status: 'drafting_application', intent: 'application_generation', route_locked: true },
  messages: [],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  child: {
    id: 'clar_multi_answer', status: 'active', round: 2, max_rounds: 6,
    requirement: {},
    messages: [
      { id: 'qds', role: 'agent', kind: 'question', metadata_json: JSON.stringify({
        id: 'judgementBoundary.dataSources',
        label: '数据来源边界',
        multiSelect: true,
        options: [
          { value: 'ontology', label: '本体数据源' },
          { value: 'public_web_search', label: '网络公开搜索' },
        ],
      }) },
      { id: 'ads', role: 'user', kind: 'answer', metadata_json: JSON.stringify({
        questionId: 'judgementBoundary.dataSources',
        value: JSON.stringify(['ontology', 'public_web_search']),
      }) },
    ],
  },
})
const multiAnswerMessage = multiAnswerTimeline.find(item => item.id === 'ads')
assert.equal(multiAnswerMessage.content, '数据来源边界：本体数据源、网络公开搜索')

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

// A job.updated event for the selected dialogue must also flag a targeted refresh:
// deployment completion updates the job/app first, and the workbench must reload
// the composed view immediately so resolvedApplication.runtime_url appears without
// requiring a browser refresh.
state = applyDialogueEvent({ ...state, needsRefresh: null }, 'job.updated', {
  data: { id: 'job_1', dialogue_id: 'dlg_1', status: 'completed', created_app_id: 'app_1' },
})
assert.equal(state.needsRefresh, 'dlg_1', 'selected dialogue job.updated must request a targeted refresh by id')

// A wrapped clarification event (dialogue.clarification.updated) must also key by dialogue_id.
state = applyDialogueEvent(state, 'dialogue.clarification.updated', {
  dialogue_id: 'dlg_1', data: { child_id: 'clar_1' },
})
assert.equal(state.needsRefresh, 'dlg_1', 'wrapped clarification event must request a targeted refresh by dialogue id')

// ---- title + status text ----------------------------------------------------

assert.equal(titleForDialogue(recommendingView.session), '我想看航母编队态势')
assert.equal(statusText('routing'), '识别需求中')
assert.equal(statusText('recommending'), '推荐应用中')
assert.equal(statusText('drafting_application'), '需求澄清中')
assert.equal(statusText('drafting_business_agent'), '配置 Agent 中')
assert.equal(statusText('resolved'), '已完成')
assert.equal(statusText('failed'), '已失败')
assert.equal(statusText('abandoned'), '已放弃')
assert.equal(statusText('active'), '进行中')
assert.equal(statusText('analyzing'), '分析中')
assert.equal(statusText('waiting_user'), '等待补充')
assert.equal(statusText('change_confirmation'), '变更确认中')
assert.equal(statusText('task_running'), '任务执行中')
assert.equal(statusText('archived'), '已归档')
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
assert.match(dialogueHookJs, /job\.updated/, 'useDialogueSessions must route job.updated events into targeted refresh handling')
assert.match(dialogueHookJs, /dialogue\.draft\.delta/, 'useDialogueSessions must route dialogue.draft.delta events into targeted refresh handling')
assert.match(workbenchJsx, /agentDraftStatus/, 'business confirm button must be gated by agentDraftStatus')
assert.match(workbenchJsx, /formatDataPolicy/, 'ConversationWorkbench must format dataPolicy labels')
assert.match(workbenchJsx, /import.*formatDataPolicy.*from.*utils\/formatLabels/, 'ConversationWorkbench must import formatDataPolicy from shared utils, not define its own')
const formatLabelsSrc = readFileSync(new URL('../src/utils/formatLabels.js', import.meta.url), 'utf8')
assert.match(formatLabelsSrc, /live_api:\s*'真实接口'/, 'formatLabels must label live_api as 真实接口')
assert.match(formatLabelsSrc, /mock_data:\s*'演示数据'/, 'formatLabels must label mock_data as 演示数据')
assert.match(workbenchJsx, /function CopyableBlock\(/, 'workbench must define CopyableBlock for Codex-style copy actions')
assert.match(workbenchJsx, /navigator\.clipboard\.writeText/, 'copy action must use navigator.clipboard.writeText when available')
assert.match(workbenchJsx, /document\.execCommand\('copy'\)/, 'copy action must include a textarea fallback')
assert.match(workbenchJsx, /return document\.execCommand\('copy'\)/, 'copy fallback must return execCommand success instead of always reporting copied')
assert.match(workbenchJsx, /cw-copy-row/, 'copy action must render below message content')
assert.match(workbenchCss, /\.cw-copy-row/, 'copy action row must have dedicated styling')
assert.match(workbenchCss, /\.cw-copy-button/, 'copy button must have dedicated styling')

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

// App recommendation cards: running => 打开应用; stopped => 启动并打开.
assert.match(workbenchJsx, /打开应用/, 'running recommendation card must offer 打开应用')
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
assert.match(workbenchJsx, /复用已有应用/, 'route choices must still offer existing-application reuse')
assert.match(workbenchJsx, /生成新应用/, 'route choices must still offer application generation')
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

// ---- Static: workbench renders the pending "正在思考…" placeholder copy ------
//
// The pending live_thinking placeholder ("正在思考…") is emitted by
// buildDialogueTimeline when a turn is in flight but no live content has
// streamed. The workbench renders live_thinking via ThinkingSummary, so the
// copy must be present in the timeline source (not hardcoded in the workbench).
// Assert the timeline mapper produces the copy and the workbench renders the
// live_thinking type through ThinkingSummary.
{
  const placeholderView = {
    session: {
      id: 'dlg_placeholder_static', status: 'drafting_application',
      intent: 'application_generation', route_locked: true, initial_prompt: 'hi',
    },
    messages: [{ id: 'ps1', role: 'user', content: 'hi' }],
    route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  }
  const placeholderTimeline = buildDialogueTimeline(placeholderView, null, null, null, [], { turnId: 't1' })
  const placeholderItem = placeholderTimeline.find(it => it.type === 'live_thinking' && it.pending)
  assert.ok(placeholderItem, 'buildDialogueTimeline emits a pending live_thinking item for an in-flight turn')
  assert.equal(placeholderItem.content, '正在思考…', 'placeholder copy is 正在思考…')

  const workbenchSource = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
  assert.match(
    workbenchSource,
    /item\.type === 'live_thinking'/,
    'ConversationWorkbench must render the live_thinking item type',
  )
  assert.match(
    workbenchSource,
    /ThinkingSummary/,
    'ConversationWorkbench must render live_thinking through ThinkingSummary',
  )
}

// ---- task execution blocks (Phase 3 §Conversation Task Blocks) ------------

// buildTaskBlocks derives one descriptor per step of the active task: name from
// the stage label, status + step-level summary from the StepExecutionSummary,
// and a display-policy fold state (running/waiting/failed expand, terminal
// folds). Ordered by step.seq.
{
  const steps = [
    { id: 's1', job_id: 'j1', kind: 'code_generation', seq: 1, agent_key: 'coder', status: 'running', started_at: '2026-06-01T00:00:00Z' },
    { id: 's2', job_id: 'j1', kind: 'deployment', seq: 2, agent_key: 'deploy', status: 'succeeded' },
  ]
  const summary = [
    { step_id: 's1', latest_attempt: 1, latest_record: { content: '生成中…' } },
  ]
  const blocks = buildTaskBlocks(steps, summary)
  assert.equal(blocks.length, 2, 'one task_execution_block per step')
  assert.equal(blocks[0].type, 'task_execution_block')
  assert.equal(blocks[0].stepId, 's1', 'ordered by seq — code_generation first')
  assert.equal(blocks[0].name, '代码生成', 'name comes from the stage label')
  assert.equal(blocks[0].summary, '生成中…', 'summary joined from latest_record.content')
  assert.equal(blocks[0].folded, false, 'running step expands')
  assert.equal(blocks[0].expanded, true, 'running step expands')
  assert.equal(blocks[1].folded, true, 'succeeded step folds')
  assert.equal(blocks[1].expanded, false, 'succeeded step folds')
}

// buildDialogueTimeline threads the blocks into the flow after the persisted
// content, and reconstructs EACH step attempt's safe-execution process by
// grouping ALL persisted work-trace rows by stepId+attempt (history replay), not
// just the latest live step. The input blocks are hook state, so the builder must
// clone/enrich them without mutating the original array or objects.
{
  const steps = [
    { id: 's1', job_id: 'j1', kind: 'solution_design', seq: 1, agent_key: 'arch', status: 'succeeded', attempt: 1 },
    { id: 's2', job_id: 'j1', kind: 'code_generation', seq: 2, agent_key: 'coder', status: 'running', attempt: 2 },
  ]
  const blocks = buildTaskBlocks(steps, [])
  const before = JSON.stringify(blocks)
  const workTrace = [
    { type: 'step', jobId: 'j1', stepId: 's1', attempt: 1, sequence: 1, payload: { summary: '分析约束' } },
    { type: 'step', jobId: 'j1', stepId: 's2', attempt: 1, sequence: 2, payload: { summary: '旧尝试生成组件' } },
    { type: 'step', jobId: 'j1', stepId: 's2', attempt: 2, sequence: 3, payload: { summary: '生成组件' } },
    { type: 'step', jobId: 'j1', stepId: 's1', attempt: 1, sequence: 4, payload: { message: '确认方案' } },
  ]
  const view = {
    session: { id: 'dlg_t', status: 'task_running', intent: 'application_generation', route_locked: true },
    messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成一个应用' }],
    route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  }
  const liveAnalysis = { key: 'step:j1:s2', content: '生成组件', kind: 'step' }
  const liveThinking = { key: 'thinking:t1', content: 'round thinking stays independent', kind: 'round' }
  const timeline = buildDialogueTimeline(view, null, liveAnalysis, liveThinking, workTrace, null, blocks)
  const block1 = timeline.find(it => it.type === 'task_execution_block' && it.stepId === 's1')
  const block2 = timeline.find(it => it.type === 'task_execution_block' && it.stepId === 's2')
  assert.ok(block1 && block2, 'timeline contains one task_execution_block per step')
  assert.equal(block1.safeExecution, '分析约束\n确认方案', 'history replay reconstructs earlier step safeExecution from all rows')
  assert.equal(block2.safeExecution, '生成组件', 'running step gets only the safeExecution for its current attempt')
  assert.equal(JSON.stringify(blocks), before, 'buildDialogueTimeline must not mutate the input jobStepBlocks')
  // No standalone live_analysis(kind:'step') duplicating the safeExecution already
  // attached to the matching block.
  const dupStepAnalysis = timeline.find(it => it.type === 'live_analysis' && it.kind === 'step')
  assert.equal(dupStepAnalysis, undefined, 'absorbed step stream is NOT re-emitted as a standalone live_analysis')
  // Task thinking is now part of Phase 4, task blocks always have the fields
  const thinking = timeline.find(it => it.type === 'live_thinking')
  assert.ok(thinking, 'round-level live_thinking remains independent')
  assert.equal(block2.taskThinking, '', 'taskThinking is empty when no taskThinkingItems provided')
  assert.equal(block2.taskThinkingRedacted, false, 'taskThinkingRedacted is false when no taskThinkingItems provided')
}

// Task-internal clarification cards preserve provenance and are placed
// immediately after their related task_execution_block. Waiting step => open;
// non-waiting/stale step => answered/read-only folded.
{
  const waitingBlock = {
    id: 'taskblock_j1_s_wait', type: 'task_execution_block', taskId: 'j1', jobId: 'j1', stepId: 's_wait', attempt: 2,
    agentKey: 'designer', name: '方案设计', status: 'waiting_user', expanded: true, folded: false,
  }
  const doneBlock = {
    id: 'taskblock_j1_s_done', type: 'task_execution_block', taskId: 'j1', jobId: 'j1', stepId: 's_done', attempt: 1,
    agentKey: 'coder', name: '代码生成', status: 'succeeded', expanded: false, folded: true,
  }
  const view = {
    session: { id: 'dlg_scope', status: 'task_running', intent: 'application_generation', route_locked: true },
    messages: [
      { id: 'ans_done', role: 'user', kind: 'task_clarification_answer', content: '最终选择历史方案', metadata_json: JSON.stringify({ taskId: 'j1', stepId: 's_done', attempt: 1, agentKey: 'coder' }) },
    ],
    route: {},
  }
  const timeline = buildDialogueTimeline(view, null, null, null, [
    { type: 'clarification', sequence: 1, dialogueId: 'dlg_scope', id: 'cw1', taskId: 'j1', stepId: 's_wait', attempt: 2, agentKey: 'designer', payload: { questions: [{ id: 'q1', question: '选 A 还是 B？', options: [{ value: 'a', label: 'A' }] }] } },
    { type: 'clarification', sequence: 2, dialogueId: 'dlg_scope', id: 'cw2', taskId: 'j1', stepId: 's_done', attempt: 1, agentKey: 'coder', payload: { questions: [{ id: 'q2', question: '历史问题？' }] } },
  ], null, [waitingBlock, doneBlock])
  const waitIdx = timeline.findIndex(it => it.type === 'task_execution_block' && it.stepId === 's_wait')
  const waitClar = timeline[waitIdx + 1]
  assert.equal(waitClar.type, 'clarification_prompt', 'open clarification must appear immediately after matching task block')
  assert.equal(waitClar.taskId, 'j1')
  assert.equal(waitClar.stepId, 's_wait')
  assert.equal(waitClar.attempt, 2)
  assert.equal(waitClar.agentKey, 'designer')
  assert.equal(waitClar.stepName, '方案设计')
  assert.equal(waitClar.status, 'open')
  assert.equal(waitClar.expanded, true)
  const doneIdx = timeline.findIndex(it => it.type === 'clarification_prompt' && it.stepId === 's_done')
  const doneClar = timeline[doneIdx]
  assert.equal(doneClar.status, 'answered', 'non-waiting step clarification is read-only/answered')
  assert.equal(doneClar.folded, true)
  assert.equal(doneClar.finalAnswer, '最终选择历史方案', 'answered clarification carries the final answer')
  assert.equal(timeline[doneIdx + 1].id, 'ans_done', 'task clarification answer user_message renders immediately after its card')
  assert.equal(timeline[0].id === 'ans_done', false, 'task clarification answer must not render above the task block as a generic parent message')
}

// ---- Task 5: task thinking in task blocks ----------------------------
{
  const block = {
    id: 'taskblock_job_step', type: 'task_execution_block', jobId: 'job_1', stepId: 'step_1', attempt: 2,
    agentKey: 'designer', name: '方案设计', status: 'running', expanded: true, folded: false,
  }
  const view = { session: { id: 'dlg_think', status: 'task_running', intent: 'application_generation' }, messages: [], route: {} }
  const timeline = buildDialogueTimeline(view, null, null, null, [], null, [block], [
    { id: 'think_1', dialogueId: 'dlg_think', taskId: 'job_1', stepId: 'step_1', attempt: 2, agentKey: 'designer', dialogueSequence: 1, stepSequence: 1, content: '先分析', redacted: false },
    { id: 'think_2', dialogueId: 'dlg_think', taskId: 'job_1', stepId: 'step_1', attempt: 2, agentKey: 'designer', dialogueSequence: 2, stepSequence: 2, content: '再实现', redacted: true },
  ])
  const got = timeline.find(item => item.type === 'task_execution_block')
  assert.equal(got.taskThinking, '先分析再实现')
  assert.equal(got.taskThinkingRedacted, true)
}

// Existing 1–2-arg callers stay green: no blocks ⇒ no task_execution_block items.
{
  const view = { session: { id: 'dlg_x', status: 'active', intent: 'application_generation' }, messages: [], route: { intent: 'application_generation', needsRouteConfirmation: false } }
  const timeline = buildDialogueTimeline(view)
  assert.equal(timeline.some(it => it.type === 'task_execution_block'), false, 'no jobStepBlocks arg ⇒ no task_execution_block items')
}

// Static: the workbench renders the new item type + component, the CSS exists,
// App wires the builder, and the dialogue hook bridges the blocks.
assert.match(workbenchJsx, /item\.type === 'task_execution_block'/, 'ConversationWorkbench must render the task_execution_block item type')
assert.match(workbenchJsx, /TaskExecutionBlock/, 'ConversationWorkbench must have a TaskExecutionBlock component')
assert.match(workbenchCss, /\.cw-task-block/, 'ConversationWorkbench.css must style .cw-task-block')
assert.match(workbenchJsx, /const \[userExpandedOverride, setUserExpandedOverride\]/, 'TaskExecutionBlock must track explicit user fold overrides')
assert.match(workbenchJsx, /const expanded = userExpandedOverride \?\? !!item\.expanded/, 'TaskExecutionBlock must follow builder default expansion after status changes until the user toggles')
assert.match(appJsx, /buildTaskBlocks\(jobs\.steps, jobs\.summary\)/, 'App must build task blocks from useJobs steps+summary and feed them to the dialogue hook')
assert.match(appJsx, /setJobStepBlocks/, 'App must bridge the task blocks into the dialogue hook via setJobStepBlocks')
assert.match(dialogueHookJs, /setJobStepBlocks/, 'useDialogueSessions must expose setJobStepBlocks')
assert.match(dialogueHookJs, /jobStepBlocks.*\)/, 'useDialogueSessions must pass jobStepBlocks into buildDialogueTimeline')
assert.match(apiClientJs, /answerJob:\s*\(id, answer, scope = \{\}\)/, 'factoryApi.answerJob must accept optional clarification scope')
assert.match(apiClientJs, /stepId:\s*scope\.stepId/, 'factoryApi.answerJob must send stepId when scope is provided')
assert.match(appJsx, /selectedClarificationScope/, 'App must remember the clarification card the user selected')
assert.match(appJsx, /activeClarification/, 'App must compute an open task clarification scope')
assert.match(appJsx, /jobs\.answerJob\(activeClarification\.taskId/, 'App must route open clarification answers by taskId/stepId before generic send')
assert.match(workbenchJsx, /onSelectClarificationScope/, 'ConversationWorkbench must report which clarification card the user picked')
assert.match(workbenchJsx, /onFocusCapture=\{selectScope\}/, 'ClarificationPromptCard focus must select card scope for no-option manual replies')
assert.match(workbenchJsx, /onMouseDown=\{selectScope\}/, 'ClarificationPromptCard click must select card scope for no-option manual replies')
assert.match(workbenchJsx, /onPick\(scope, value\)/, 'ClarificationPromptCard option clicks must pass the card scope, not only the value')
assert.match(workbenchJsx, /finalAnswer/, 'ClarificationPromptCard must render the final answer for answered cards')
assert.match(workbenchJsx, /clarificationScope/, 'ConversationWorkbench must receive a clarificationScope for composer scoping')

console.log('check-dialogue-workbench: OK')
