// Pure-logic + static checks for the conversation agent streaming + clarification
// gate (Task 2: high-impact confirmation gate, D3 / ADR 0006). Runs under node
// with NO React import. Tasks 3 and 5 extend this file later; this seed asserts
// the high-impact / confirm-gate contract:
//   - the backend RoundOutput contract carries an `openHighImpact` list
//   - the workbench keeps the 确认并生成 (confirm) action gated on
//     childStatus === 'ready_to_confirm' (the backend now withholds that status
//     while any openHighImpact item remains open)
//   - the blocking high-impact item flows through the existing question_group /
//     QuestionCard path (no new render component)
//
// The dialogueTimeline mapper contract mirrors the backend DialogueView.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildDialogueTimeline,
  applyDialogueEvent,
  initialDialogueState,
  applyLiveAnalysisEvent,
  applyLiveThinkingEvent,
  foldTraceIntoLiveAnalysis,
} from '../src/hooks/dialogueTimeline.js'
import { liveStepFromTrace } from '../src/hooks/workTraceState.js'

// ---- 0. D5: optimistic user message renders before the first view lands -----
//
// On the first message of a brand-new dialogue there is no persisted view yet
// (createDialogue is still in flight). buildDialogueTimeline must still surface
// the optimistic user message — and any streaming live analysis beneath it — so
// the composer is not visually stuck. The prior `if (!view) return []` dropped
// the optimistic entry entirely, which is why the first input appeared late.
{
  const optimisticTimeline = buildDialogueTimeline(null, { id: 'opt_1', content: '做一个图书馆借阅管理系统' }, null)
  const opt = optimisticTimeline.find(it => it.type === 'user_message')
  assert.ok(opt, 'optimistic user message must render even before the first persisted view lands (D5)')
  assert.equal(opt.optimistic, true, 'the pre-view user message is the optimistic transient')
  assert.equal(opt.content, '做一个图书馆借阅管理系统', 'optimistic content is preserved verbatim')

  // A null view with no optimistic message stays empty (no spurious items).
  assert.deepEqual(buildDialogueTimeline(null, null, null), [], 'null view with no optimistic message yields an empty timeline')

  // A streaming live analysis also surfaces beneath the optimistic message pre-view.
  const withLive = buildDialogueTimeline(null, { id: 'opt_2', content: 'hi' }, { key: 't1', content: '识别需求', kind: 'round' })
  assert.ok(withLive.some(it => it.type === 'user_message'), 'optimistic message still leads when a live analysis streams pre-view')
  const withLiveItem = withLive.find(it => it.type === 'live_analysis')
  assert.ok(withLiveItem, 'streaming live analysis renders beneath the optimistic message before the view lands')
  assert.equal(withLiveItem.pending, false, 'a real streaming live item is not pending')

  // In-flight "thinking" indicator: with no view AND no streaming yet, a send
  // just accepted must still show a pending live_analysis ("正在理解你的需求…")
  // so the workbench never looks frozen during the routing CLI wait.
  const pending = buildDialogueTimeline(null, { id: 'opt_3', content: 'hi' }, null).find(it => it.type === 'live_analysis')
  assert.ok(pending, 'a pending live_analysis indicator renders before the view lands and before any stream')
  assert.equal(pending.pending, true, 'the pre-stream indicator is marked pending (spinner)')
  assert.equal(pending.content, '正在理解你的需求…', 'pending indicator copy')
}

// ---- 1. Static check: ConversationWorkbench keeps the confirm action gated --
//
// D3/ADR 0006: the 确认并生成 button may only appear when the child clarification
// status is ready_to_confirm. The backend now refuses to reach ready_to_confirm
// while openHighImpact is non-empty, so this gate is the frontend backstop. We
// assert the source still derives canConfirm from childStatus === 'ready_to_confirm'.
const workbenchSrc = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
assert.ok(
  workbenchSrc.includes("childStatus === 'ready_to_confirm'"),
  'ConversationWorkbench must keep the confirm action gated on childStatus === ready_to_confirm',
)
assert.ok(
  workbenchSrc.includes('canConfirmClarification'),
  'ConversationWorkbench must expose the canConfirmClarification derived flag',
)

// ---- 2. The blocking high-impact item renders via the existing question path --
//
// While the child status is waiting_user (the D3 gate holds it here while
// openHighImpact is open), the round's blocking high-impact question — persisted
// as an agent `question` message and surfaced as questions[0] — must appear as a
// question_group item carrying recommendation badges + options. No new component.
const childOpenHighImpact = {
  id: 'clar_hi', status: 'waiting_user', round: 1, max_rounds: 6,
  requirement: { appType: 'command_dashboard', appName: '潮汐窗口', coreScenario: '监控' },
  // High-impact items are delivered as normal question messages in the child
  // thread, ALL AT ONCE in a single round (not one per round) so the user
  // confirms them in one batch. openHighImpact itself is backend-only gating
  // metadata; it does not need a new UI element.
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '生成潮汐窗口应用' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '需求已收敛，但仍有高影响确认项' },
    {
      id: 'a2', role: 'agent', kind: 'question',
      metadata_json: JSON.stringify({
        id: 'data_policy', label: '数据来源策略',
        question: '数据从哪里来?',
        recommendation: ['mock_data'],
        options: [
          { value: 'mock_data', label: 'Mock 数据优先', recommended: true },
          { value: 'api_first', label: '接口优先' },
        ],
      }),
    },
    {
      id: 'a3', role: 'agent', kind: 'question',
      metadata_json: JSON.stringify({
        id: 'primary_user_role', label: '主要使用角色',
        question: '主要给谁用?',
        recommendation: ['operator'],
        options: [
          { value: 'operator', label: '操作员', recommended: true },
          { value: 'viewer', label: '只读查看' },
        ],
      }),
    },
  ],
}
const openView = {
  session: { id: 'dlg_hi', status: 'drafting_application', intent: 'application_generation', route_locked: true, initial_prompt: '生成潮汐窗口应用' },
  messages: [],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  child: childOpenHighImpact,
}
const openTimeline = buildDialogueTimeline(openView)
const qGroup = openTimeline.find(it => it.type === 'question_group')
assert.ok(qGroup, 'blocking high-impact item must surface as a question_group while child status is waiting_user')
assert.equal(qGroup.questions.length, 2, 'ALL open high-impact questions surface in one round (batch, not one per round)')
const byId = Object.fromEntries(qGroup.questions.map(q => [q.id, q]))
assert.ok(byId.data_policy && byId.primary_user_role, 'both high-impact questions are present in the single group')
assert.equal(byId.data_policy.options.length, 2, 'options must be preserved for the user to pick')
assert.equal(byId.data_policy.options[0].recommended, true, 'recommendation badge must mark the recommended option')

// ---- 2b. The child's persisted analysis (thinking process) is retained -------
//
// A persisted agent thinking message should replay as a Chinese 思考摘要 item,
// using the following safe Chinese analysis as the summary while keeping the raw
// thinking available for the original view.
const replayedThinkingView = {
  session: { id: 'dlg_thinking_replay', status: 'drafting_application', intent: 'application_generation', route_locked: true, initial_prompt: '做一个员工请假审批流程' },
  messages: [],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  child: {
    id: 'clar_thinking_replay', status: 'waiting_user', round: 1, max_rounds: 6,
    requirement: { appType: 'operations_management', appName: '员工请假审批', coreScenario: '请假申请与审批' },
    messages: [
      { id: 'rt_u1', role: 'user', kind: 'prompt', content: '做一个员工请假审批流程' },
      { id: 'rt_t1', role: 'agent', kind: 'thinking', content: 'The model is reasoning in English about leave approval.' },
      { id: 'rt_a1', role: 'agent', kind: 'analysis_work_log', content: '已识别为员工请假审批流程，需要确认审批层级。' },
      { id: 'rt_q1', role: 'agent', kind: 'question', metadata_json: JSON.stringify({
        id: 'approval_level', label: '审批层级', options: [{ value: 'manager', label: '直属主管' }], recommendation: ['manager'],
      }) },
    ],
  },
}
const replayedThinkingTimeline = buildDialogueTimeline(replayedThinkingView)
const replayedThinkingIndex = replayedThinkingTimeline.findIndex(it => it.type === 'thinking_summary')
const replayedAnalysisIndex = replayedThinkingTimeline.findIndex(it => it.type === 'analysis_stream' && it.content === '已识别为员工请假审批流程，需要确认审批层级。')
assert.ok(replayedThinkingIndex >= 0, 'persisted thinking must render as a thinking_summary item')
assert.ok(replayedThinkingIndex < replayedAnalysisIndex, 'persisted thinking summary must stay before the following analysis')
assert.equal(replayedThinkingTimeline[replayedThinkingIndex].content, 'The model is reasoning in English about leave approval.')
assert.equal(replayedThinkingTimeline[replayedThinkingIndex].summary, '已识别为员工请假审批流程，需要确认审批层级。')

const orphanThinkingTimeline = buildDialogueTimeline({
  session: { id: 'dlg_orphan_thinking', status: 'drafting_application', intent: 'application_generation', route_locked: true },
  messages: [], route: {},
  child: {
    id: 'clar_orphan_thinking', status: 'waiting_user', round: 1, max_rounds: 6,
    requirement: {},
    messages: [
      { id: 'ot_u1', role: 'user', kind: 'prompt', content: '生成智能体' },
      { id: 'ot_t1', role: 'agent', kind: 'thinking', content: 'Final reasoning without analysis.' },
      { id: 'ot_q1', role: 'agent', kind: 'question', metadata_json: JSON.stringify({ id: 'q', label: '确认项', options: [{ value: 'yes', label: '是' }] }) },
    ],
  },
})
const orphanThinking = orphanThinkingTimeline.find(it => it.type === 'thinking_summary')
assert.ok(orphanThinking, 'persisted thinking without following analysis must still render')
assert.equal(orphanThinking.content, 'Final reasoning without analysis.')
assert.equal(orphanThinking.summary, '', 'orphan thinking must not fabricate a Chinese summary')

// The application-generation flow persists its analysis_work_log in the CHILD
// clarification thread (not the parent). Without surfacing it, the streaming
// live block is cleared on every reload and the thinking process vanishes. The
// child analysis_work_log must render as a FOLDED analysis_stream item above the
// question/conclusion (D6 retention), one collapsed block per entry.
const retainedChildAnalysis = openTimeline.find(
  it => it.type === 'analysis_stream' && it.content === '需求已收敛，但仍有高影响确认项',
)
assert.ok(retainedChildAnalysis, 'child analysis_work_log must render as an analysis_stream item (thinking process retained)')
assert.equal(retainedChildAnalysis.folded, true, 'retained child analysis renders FOLDED (collapsed) above the conclusion (D6)')
assert.equal(retainedChildAnalysis.expanded, true, 'analysis defaults to EXPANDED so the reasoning is visible without an extra click')
// waiting_user boundary: analysis + open questions, NO answer yet, must still
// flush the round-1 analysis block (labeled 第1轮) above the question group.
assert.equal(retainedChildAnalysis.label, '分析过程 · 第1轮', 'round-1 analysis flushes as 第1轮 before any answer (waiting_user boundary)')

// ---- 2c. Child analysis groups into ONE folded block per round --------------
//
// A multi-round dialogue emits several analysis_work_log entries per round
// (one per clarifier observation). Rendering one block per entry was too noisy
// (~10 blocks). Entries now fold by round — a user answer (not the initial
// prompt) starts a new round — into a single 分析过程 · 第N轮 block whose content
// is the round's entries joined by a blank line. The thread is walked
// chronologically, so each round's analysis block sits above the user's reply.
// The user's clarification answer renders the SELECTED OPTION LABEL (mapped from
// the preceding question's options), not the raw value slug.
const childMultiRound = {
  id: 'clar_mr', status: 'ready_to_confirm', round: 2, max_rounds: 6,
  requirement: { appType: 'operations_management', appName: '图书借阅', coreScenario: '借还' },
  messages: [
    // Round 1: analysis + TWO high-impact questions in ONE batch.
    { id: 'mr_a1', role: 'agent', kind: 'analysis_work_log', content: 'R1第一句' },
    { id: 'mr_a2', role: 'agent', kind: 'analysis_work_log', content: 'R1第二句' },
    { id: 'mr_q1', role: 'agent', kind: 'question', metadata_json: JSON.stringify({
      id: 'mr_q1', label: 'Q1',
      options: [{ value: 'v1', label: '选项甲' }, { value: 'v2', label: '选项乙' }],
    }) },
    { id: 'mr_q2', role: 'agent', kind: 'question', metadata_json: JSON.stringify({
      id: 'mr_q2', label: 'Q2',
      options: [{ value: 'x', label: '选项丙' }, { value: 'y', label: '选项丁' }],
    }) },
    // User answers BOTH in one batch — two consecutive answer messages, each
    // carrying metadata_json {questionId, value} (the real persisted shape).
    { id: 'mr_u1', role: 'user', kind: 'answer', content: 'v2', metadata_json: JSON.stringify({ questionId: 'mr_q1', value: 'v2' }) },
    { id: 'mr_u2', role: 'user', kind: 'answer', content: 'y', metadata_json: JSON.stringify({ questionId: 'mr_q2', value: 'y' }) },
    // Round 2: analysis (no more questions → ready_to_confirm).
    { id: 'mr_a3', role: 'agent', kind: 'analysis_work_log', content: 'R2第一句' },
    { id: 'mr_a4', role: 'agent', kind: 'analysis_work_log', content: 'R2第二句' },
  ],
}
const mrTimeline = buildDialogueTimeline({
  session: { id: 'dlg_mr', status: 'drafting_application', intent: 'application_generation', route_locked: true },
  messages: [], route: {}, child: childMultiRound,
})
const mrAnalysis = mrTimeline.filter(it => it.type === 'analysis_stream')
// 2 batched answers must NOT inflate the round counter: still 2 rounds → 2 blocks.
assert.equal(mrAnalysis.length, 2, '2 batched answers count as ONE user turn → 2 round blocks, not 4')
assert.equal(mrAnalysis[0].label, '分析过程 · 第1轮', 'first round block labeled 第1轮 (batch answers do not inflate it)')
assert.equal(mrAnalysis[0].content, 'R1第一句\n\nR1第二句', 'round-1 entries concatenate with a blank line')
assert.equal(mrAnalysis[1].label, '分析过程 · 第2轮', 'a user turn starts round 2')
assert.equal(mrAnalysis[1].content, 'R2第一句\n\nR2第二句', 'round-2 entries concatenate')
// Each answer resolves against its OWN question (via metadata.questionId), so a
// batch labels every answer correctly — not all against the last question.
const mrAnswers = mrTimeline.filter(it => it.type === 'user_message')
assert.equal(mrAnswers.length, 2, 'both batched answers render as user replies')
assert.equal(mrAnswers[0].content, 'Q1：选项乙', 'answer 1 resolves value v2 → 选项乙 via its own question mr_q1')
assert.equal(mrAnswers[1].content, 'Q2：选项丁', 'answer 2 resolves value y → 选项丁 via its own question mr_q2 (not mr_q1)')
assert.ok(mrTimeline.indexOf(mrAnalysis[0]) < mrTimeline.indexOf(mrAnswers[0]), 'round-1 analysis sits above the answers')
assert.ok(mrTimeline.indexOf(mrAnswers[1]) < mrTimeline.indexOf(mrAnalysis[1]), 'round-2 analysis sits below the answers')


// ---- 3. No confirm button leaks while high-impact items are open -------------
//
// Because child.status is waiting_user (not ready_to_confirm), the workbench
// derived canConfirmClarification is false — the 确认并生成 button does not
// render. This is asserted indirectly via the status gate above; the open
// question group is the visible affordance instead.
assert.notEqual(openView.child.status, 'ready_to_confirm', 'precondition: open high-impact keeps status off ready_to_confirm')

console.log('check-conversation-agent-streaming: high-impact/confirm gate OK')

// ============================================================================
// Task 3: Live analysis-process streaming in the conversation (D1/D2/D6)
//
// One transient live-analysis item folds the safe analysis work log (NOT raw
// thinking) token-by-token, positioned right after the user message. On the
// round/step completion it is REPLACED by the persisted analysis item rendered
// FOLDED (collapsed) above the conclusion. The check exercises the pure
// dialogueTimeline reducers/builders directly.
// ============================================================================

// ---- 3a. A *.delta event folds incrementally into a live analysis item ------
//
// The delta payload carries the FULL-so-far text (set-not-append, mirroring
// clarificationLogic). applyDialogueEvent for a selected dialogue must NOT
// merely set needsRefresh for a delta — it must fold into liveAnalysis so the
// per-token reload is gone.
const baseState = { ...initialDialogueState(), selectedDialogueId: 'dlg_live' }

// delta 1: "识别需求"
let st = applyDialogueEvent(baseState, 'dialogue.route.delta', {
  dialogue_id: 'dlg_live', turn_id: 't1', delta: '识别需求',
})
assert.ok(st.liveAnalysis, 'a *.delta event for the selected dialogue must fold a liveAnalysis item')
assert.equal(st.liveAnalysis.kind, 'round', 'liveAnalysis kind is round for a turn delta')
assert.equal(st.liveAnalysis.content, '识别需求', 'delta content is the full-so-far text (set)')
assert.ok(st.liveAnalysis.key, 'liveAnalysis carries a key identifying the running turn')
assert.notEqual(st.needsRefresh, 'dlg_live', 'a *.delta must NOT set needsRefresh (no per-token reload)')

// delta 2: full-so-far text grows. SET not append.
st = applyDialogueEvent(st, 'dialogue.route.delta', {
  dialogue_id: 'dlg_live', turn_id: 't1', delta: '识别需求中：匹配已有应用',
})
assert.equal(st.liveAnalysis.content, '识别需求中：匹配已有应用', 'delta is set (full-so-far), not appended')

// draft.delta folds into the same surface, keyed by turn.
st = applyDialogueEvent(st, 'dialogue.draft.delta', {
  dialogue_id: 'dlg_live', turn_id: 't2', delta: '生成草稿',
})
assert.equal(st.liveAnalysis.content, '生成草稿', 'a new turn key replaces the live analysis content')
assert.equal(st.liveAnalysis.key && String(st.liveAnalysis.key).indexOf('t2') >= 0, true, 'key identifies the new turn t2')

// ---- 3b. A dialogue.work_trace pipeline step folds into the same surface ----
//
// workTraceState folds the step rows; liveStepFromTrace derives the in-flight
// step's accrued safe text. The timeline builder folds that into liveAnalysis
// (kind 'step'), keyed by step.
const traceItems = [
  {
    id: 'r1', sequence: 1, type: 'step.text', dialogueId: 'dlg_live',
    stepId: 'step_1', jobId: 'job_1',
    payload: { summary: '正在生成前端组件' },
  },
]
const stepLive = liveStepFromTrace(traceItems)
assert.ok(stepLive, 'liveStepFromTrace derives an in-flight step item when a step row exists')
assert.ok(stepLive.key && String(stepLive.key).indexOf('step_1') >= 0, 'step key identifies the step')
assert.equal(stepLive.kind, 'step', 'step-derived live item has kind step')
assert.ok(String(stepLive.content).includes('正在生成前端组件'), 'step text is folded from the payload summary')

// foldTraceIntoLiveAnalysis merges a step-derived item into state.liveAnalysis.
const stepState = foldTraceIntoLiveAnalysis(baseState, stepLive)
assert.ok(stepState.liveAnalysis, 'foldTraceIntoLiveAnalysis sets a liveAnalysis item')
assert.equal(stepState.liveAnalysis.kind, 'step', 'folded step live item has kind step')

// ---- 3c. On round/step completion the live item is replaced by the persisted
// analysis item rendered FOLDED above the conclusion --------------------------
//
// After a completed event + reload, buildDialogueTimeline emits an
// analysis_stream item from the persisted analysis_work_log message. That item
// must render COLLAPSED (folded) — we assert via the `folded` flag on the item.
const completedView = {
  session: { id: 'dlg_live', status: 'drafting_application', intent: 'application_generation', route_locked: true, initial_prompt: '生成潮汐窗口应用' },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '生成潮汐窗口应用' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '需求已识别，匹配命令面板应用' },
  ],
  route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
}
const completedTimeline = buildDialogueTimeline(completedView, null, null)
const persistedAnalysis = completedTimeline.find(it => it.type === 'analysis_stream')
assert.ok(persistedAnalysis, 'the persisted analysis_work_log maps to an analysis_stream item')
assert.equal(persistedAnalysis.folded, true, 'persisted analysis_stream must render FOLDED (collapsible) above the conclusion (D6)')
assert.equal(persistedAnalysis.expanded, true, 'analysis defaults to EXPANDED (visible without an extra click)')

// The live item must NOT appear when a persisted analysis for the turn exists.
const liveAfterPersist = buildDialogueTimeline(completedView, null, {
  key: 't1', content: 'live text still here', kind: 'round',
})
assert.ok(
  !liveAfterPersist.some(it => it.type === 'live_analysis'),
  'when the persisted analysis for the turn lands, the transient live item is suppressed',
)

// ---- 3d. The folded analysis is replayable from persisted state -------------
//
// The folded analysis_stream item is produced purely from the persisted view
// (no transient state), so a reload replays it identically.
const replayed = buildDialogueTimeline(completedView, null, null)
const replayedAnalysis = replayed.find(it => it.type === 'analysis_stream')
assert.deepEqual(
  { content: replayedAnalysis.content, folded: replayedAnalysis.folded },
  { content: persistedAnalysis.content, folded: persistedAnalysis.folded },
  'folded analysis is replayed identically from persisted state after reload',
)

// ---- 3e. Safe analysis (.delta) vs raw reasoning (.thinking) are separate channels
//
// Policy: the conversation surface streams the model's thinking (思考过程) via a
// DEDICATED *.thinking event into a parallel liveThinking item. #9 still applies
// to the executor/trace pipeline (a different surface). The *.delta path still
// folds ONLY the safe analysis: a (malicious/buggy) .delta payload carrying
// stray thinking_delta/thinking FIELDS must not leak them into the analysis item.
const guardedSt = applyLiveAnalysisEvent(baseState, 'dialogue.route.delta', {
  dialogue_id: 'dlg_live', turn_id: 't1', delta: '安全分析文本',
  thinking_delta: 'RAW HIDDEN REASONING',
  thinking: 'MORE RAW REASONING',
})
assert.ok(guardedSt.liveAnalysis, 'liveAnalysis folded from a safe delta')
assert.equal(
  guardedSt.liveAnalysis.content.includes('RAW'), false,
  'no stray thinking_delta/thinking field content may reach the analysis item',
)
assert.equal(guardedSt.liveAnalysis.content, '安全分析文本', 'only the safe delta text is folded into liveAnalysis')

// The model's raw reasoning streams via a dedicated *.thinking event into a
// parallel liveThinking item (rendered as a 思考过程 block). The two channels
// never cross-populate.
const thinkSt = applyLiveThinkingEvent(baseState, 'dialogue.route.thinking', {
  dialogue_id: 'dlg_live', turn_id: 't1', delta: '模型正在思考需求…',
})
assert.ok(thinkSt.liveThinking, 'a *.thinking event folds into liveThinking')
assert.equal(thinkSt.liveThinking.content, '模型正在思考需求…', 'thinking text is folded (full-so-far)')
assert.equal(thinkSt.liveAnalysis, null, 'a .thinking event must NOT populate liveAnalysis')
assert.equal(guardedSt.liveThinking, null, 'a .delta event must NOT populate liveThinking')

// buildDialogueTimeline renders a live_thinking 思考过程 block when liveThinking
// is present (above the analysis), parallel to the live_analysis block.
const liveThinkTimeline = buildDialogueTimeline(
  null,
  { id: 'opt_t', content: 'hi' },
  { key: 'turn:t1', content: '已识别为员工请假审批流程，需要确认审批层级。', kind: 'round' },
  { key: 'thinking:t1', content: 'The model is reasoning in English...', kind: 'round' },
)
const liveThinkItem = liveThinkTimeline.find(it => it.type === 'live_thinking')
assert.ok(liveThinkItem, 'liveThinking renders a live_thinking item')
assert.equal(liveThinkItem.content, 'The model is reasoning in English...', 'raw thinking content is preserved')
assert.equal(liveThinkItem.summary, '已识别为员工请假审批流程，需要确认审批层级。', 'live_thinking exposes a Chinese summary from safe analysis')

// Static guard: the live item is rendered as plaintext, never dangerouslySetInnerHTML.
// Strip comments so a doc comment mentioning the forbidden API does not trip it.
const workbenchSrc3 = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const workbenchCss = readFileSync(new URL('../src/components/ConversationWorkbench.css', import.meta.url), 'utf8')
assert.equal(
  /dangerouslySetInnerHTML/.test(workbenchSrc3.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  false,
  'ConversationWorkbench must never use dangerouslySetInnerHTML',
)
assert.match(workbenchSrc3, /ThinkingSummary/, 'ConversationWorkbench must render thinking through ThinkingSummary')
assert.match(workbenchSrc3, /思考摘要/, 'thinking summary UI must use the 思考摘要 label')
assert.match(workbenchSrc3, /原始思考过程/, 'raw thinking must be behind an 原始思考过程 disclosure')
// The composer must stay active when a job pauses for clarification (waiting_user),
// so the user can answer the job-step clarification prompt via free text.
assert.match(workbenchSrc3, /waiting_user/, 'continuousLoop must include waiting_user so the composer stays active during job-step clarification')
// Live (pending) thinking must be expanded by default with a fixed-height scroll
// area; completed thinking_summary must collapse raw thinking by default.
assert.match(workbenchSrc3, /item\.pending/, 'ThinkingSummary must branch on item.pending for live vs completed state')
assert.match(workbenchCss, /\.cw-raw-thinking-stream/, 'streaming raw thinking must use a fixed-height scroll container')
assert.match(workbenchCss, /max-height:\s*200px/, 'streaming raw thinking container must have a fixed max-height')

console.log('check-conversation-agent-streaming: live analysis streaming + fold OK')

// ============================================================================
// D2 fix: clarification delta reachability in the dialogue flow
//
// The child clarification round's work-log deltas MUST stream live in the
// application-generation dialogue. The backend mirrors each child
// clarification.message.delta as a dialogue-attributed dialogue.clarification.delta
// (carrying the parent dialogue_id). This block asserts:
//   - the new type is registered on the global SSE bus (events.js)
//   - the dispatcher routes it (DIALOGUE_TYPES in useDialogueSessions.js)
//   - the timeline folds it into liveAnalysis (LIVE_DELTA_EVENTS)
//   - the reducer folds a dialogue.clarification.delta exactly like a draft delta
//   - the bare clarification.message.delta is NOT folded by the dialogue timeline
//     (the legacy standalone clarification surface handles it via clarificationLogic)
// ============================================================================

// ---- Static: the new type is wired end-to-end -------------------------------
const eventsSrc = readFileSync(new URL('../src/api/events.js', import.meta.url), 'utf8')
assert.ok(
  eventsSrc.includes("'dialogue.clarification.delta'"),
  'events.js must register dialogue.clarification.delta on the global SSE bus',
)
// *.thinking events must be registered on the global SSE bus so the workbench
// folds live thinking incrementally — without these, thinking only appears after
// the persisted analysis lands (the bug where thinking is batched, not streamed).
assert.ok(
  eventsSrc.includes("'dialogue.route.thinking'") &&
    eventsSrc.includes("'dialogue.draft.thinking'") &&
    eventsSrc.includes("'dialogue.clarification.thinking'"),
  'events.js must register all dialogue *.thinking events on the global SSE bus',
)
// Legacy bare clarification.message.delta must STILL be registered so the
// standalone clarification surface (useClarification / ClarificationPanel) keeps
// streaming — we must not break it.
assert.ok(
  eventsSrc.includes("'clarification.message.delta'"),
  'events.js must keep the bare clarification.message.delta for the legacy standalone surface',
)

const dispatcherSrc = readFileSync(new URL('../src/hooks/useDialogueSessions.js', import.meta.url), 'utf8')
assert.ok(
  dispatcherSrc.includes("'dialogue.clarification.delta'"),
  'useDialogueSessions DIALOGUE_TYPES must include dialogue.clarification.delta so the dispatcher routes it',
)

const timelineSrc = readFileSync(new URL('../src/hooks/dialogueTimeline.js', import.meta.url), 'utf8')
assert.ok(
  timelineSrc.includes("'dialogue.clarification.delta'"),
  'dialogueTimeline LIVE_DELTA_EVENTS must include dialogue.clarification.delta so it folds live',
)

// ---- Behavioral: a dialogue.clarification.delta folds into liveAnalysis -----
//
// The wire shape mirrors dialogue.draft.delta (top-level dialogue_id/message_id/delta).
// applyLiveAnalysisEvent reads ev.delta and ev.message_id; applyDialogueEvent
// extracts the dialogue id from ev.dialogue_id. The delta is set-not-append
// (full-so-far text), keyed by the running message/turn.
const clarifyBase = { ...initialDialogueState(), selectedDialogueId: 'dlg_clar' }

let cSt = applyDialogueEvent(clarifyBase, 'dialogue.clarification.delta', {
  dialogue_id: 'dlg_clar', message_id: 'worklog_1', delta: '正在分析需求',
})
assert.ok(cSt.liveAnalysis, 'a dialogue.clarification.delta for the selected dialogue must fold a liveAnalysis item')
assert.equal(cSt.liveAnalysis.content, '正在分析需求', 'clarification delta content is the full-so-far text (set)')
assert.notEqual(cSt.needsRefresh, 'dlg_clar', 'a clarification delta must NOT set needsRefresh (no per-token reload)')

// A subsequent full-so-far delta replaces (set, not append).
cSt = applyDialogueEvent(cSt, 'dialogue.clarification.delta', {
  dialogue_id: 'dlg_clar', message_id: 'worklog_1', delta: '正在分析需求：收敛场景',
})
assert.equal(cSt.liveAnalysis.content, '正在分析需求：收敛场景', 'clarification delta is set (full-so-far), not appended')

// Raw reasoning must never ride along even via this path (security #9).
const cGuarded = applyLiveAnalysisEvent(clarifyBase, 'dialogue.clarification.delta', {
  dialogue_id: 'dlg_clar', message_id: 'worklog_1', delta: '安全澄清文本',
  thinking_delta: 'RAW REASONING',
})
assert.equal(cGuarded.liveAnalysis.content, '安全澄清文本', 'only the safe clarification delta text is folded')
assert.equal(cGuarded.liveAnalysis.content.includes('RAW'), false, 'no thinking_delta reaches the live fold')

console.log('check-conversation-agent-streaming: dialogue clarification delta reachability OK')

// ============================================================================
// Task 5: User-facing 智能体 label (D4)
//
// The user-facing noun for the produced product is 智能体; the internal entity
// stays 应用. We assert the workbench's RENDERED (user-facing) product strings
// use 智能体, while leaving internal identifiers (appType, appName,
// resolvedApplication, onOpenApp, ...), API paths, and code comments that refer
// to the internal 应用 entity untouched.
//
// Strategy: scan the workbench source, strip line/block comments so an internal
// reference in a comment never trips the check, then assert that none of the
// known user-facing product phrases (the route card, empty hint, app list
// heading, open-app action, delete-confirm copy, history fallback, requirement
// summary field labels) still carry the old 应用 noun.
// ============================================================================
const wbRaw = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
// Strip // line comments and /* */ block comments so only executable/rendered
// source remains. A user-facing string still present after stripping means it
// is actually rendered, not merely mentioned in a doc comment.
const wbRendered = wbRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

// The renamed user-facing phrases MUST be present (proves the rename happened).
const expectedUserFacing = [
  '生成新智能体',
  '通过需求澄清生成助手智能体或业务智能体',
  '复用已有智能体',
  '推荐智能体',
]
for (const phrase of expectedUserFacing) {
  assert.ok(
    wbRendered.includes(phrase),
    `ConversationWorkbench must use the user-facing noun 智能体 for the produced product (missing: "${phrase}")`,
  )
}

// The old user-facing product phrases MUST be gone from rendered source.
const forbiddenUserFacing = [
  '生成新应用',
  '助手应用或业务应用',
  '复用已有应用',
  '打开匹配的现有应用',
  '<strong>推荐应用</strong>',
]
for (const phrase of forbiddenUserFacing) {
  assert.equal(
    wbRendered.includes(phrase), false,
    `ConversationWorkbench must not show the old product noun 应用 to users (still present: "${phrase}")`,
  )
}

console.log('check-conversation-agent-streaming: user-facing 智能体 label OK')

// ============================================================================
// Live thinking streaming: tail append + pending placeholder
//
// Two defects in the new-agent (child clarification) flow:
//   1. Streamed thinking/analysis appeared after the FIRST user message (inserted
//      before the child thread) instead of at the tail. Now live_thinking /
//      live_analysis append at the END of buildDialogueTimeline, after all
//      persisted child content, before resolved_outcome.
//   2. No "thinking…" placeholder after send when no live content has streamed
//      yet. Now a pending live_thinking item ("正在思考…") renders when a turn
//      is in flight (pendingTurn truthy) and no live content exists.
// ============================================================================

// ---- 1. Live items appear at the TAIL, after child persisted content -------
//
// A view with a child clarification thread (user prompt + analysis + question)
// AND live thinking/analysis must place the live items AFTER the last child
// persisted item, not before the child thread.
{
  const tailView = {
    session: {
      id: 'dlg_tail', status: 'drafting_application', intent: 'application_generation',
      route_locked: true, initial_prompt: '生成智能体',
    },
    messages: [
      { id: 'tu1', role: 'user', kind: 'prompt', content: '生成智能体' },
    ],
    route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
    child: {
      id: 'clar_tail', status: 'waiting_user', round: 1, max_rounds: 6,
      requirement: { appType: 'command_dashboard', appName: '测试应用', coreScenario: '测试' },
      messages: [
        { id: 'tcu1', role: 'user', kind: 'prompt', content: '生成智能体' },
        { id: 'tca1', role: 'agent', kind: 'analysis_work_log', content: '分析已完成，等待确认' },
        {
          id: 'tcq1', role: 'agent', kind: 'question',
          metadata_json: JSON.stringify({
            id: 'tq1', label: '确认项',
            options: [{ value: 'yes', label: '是' }],
          }),
        },
      ],
    },
  }
  const tailTimeline = buildDialogueTimeline(
    tailView,
    null,
    { key: 't1', content: '实时分析内容', kind: 'round' },
    { key: 'think:t1', content: '实时思考内容', kind: 'round' },
  )
  // The child's last persisted item is the question group.
  const questionGroupIndex = tailTimeline.findIndex(it => it.type === 'question_group')
  const liveThinkingIdx = tailTimeline.findIndex(it => it.type === 'live_thinking' && !it.pending)
  const liveAnalysisIdx = tailTimeline.findIndex(it => it.type === 'live_analysis')
  assert.ok(questionGroupIndex >= 0, 'precondition: child question group exists')
  assert.ok(liveThinkingIdx > questionGroupIndex, 'live_thinking must appear AFTER the child question group (tail append)')
  assert.ok(liveAnalysisIdx > questionGroupIndex, 'live_analysis must appear AFTER the child question group (tail append)')
  // Live items must appear before resolved_outcome / system_status (which are
  // the very last items). For a non-resolved, non-terminal session there are
  // none, so the live items are at the actual tail.
  const resolvedIdx = tailTimeline.findIndex(it => it.type === 'resolved_outcome')
  if (resolvedIdx >= 0) {
    assert.ok(liveThinkingIdx < resolvedIdx, 'live_thinking before resolved_outcome')
    assert.ok(liveAnalysisIdx < resolvedIdx, 'live_analysis before resolved_outcome')
  }
}

// ---- 2. Pending placeholder when pendingTurn exists, no live content --------
//
// When a turn is in flight (pendingTurn truthy) and no liveThinking /
// liveAnalysis content has streamed yet, the builder must append a pending
// live_thinking item with content "正在思考…" so the workbench never looks
// frozen between send and the first delta.
{
  const pendingView = {
    session: {
      id: 'dlg_pending', status: 'drafting_application', intent: 'application_generation',
      route_locked: true, initial_prompt: 'hi',
    },
    messages: [{ id: 'pu1', role: 'user', content: 'hi' }],
    route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  }
  const pendingTimeline = buildDialogueTimeline(
    pendingView, null, null, null, [], { turnId: 't1', dialogueId: 'dlg_pending' },
  )
  const pendingItem = pendingTimeline.find(it => it.type === 'live_thinking' && it.pending)
  assert.ok(pendingItem, 'a pending live_thinking item must render when pendingTurn exists and no live content')
  assert.equal(pendingItem.content, '正在思考…', 'pending placeholder copy is 正在思考…')
  assert.equal(pendingItem.summary, '', 'pending placeholder has empty summary')
  assert.equal(pendingItem.pending, true, 'pending flag is true')
  assert.equal(pendingItem.kind, 'round', 'pending placeholder is round kind')
}

// ---- 3. No pending placeholder when real live content exists ----------------
//
// Once real thinking OR analysis streams, the pending placeholder must NOT
// appear (it is naturally replaced by the real content).
{
  const liveView = {
    session: {
      id: 'dlg_live_repl', status: 'drafting_application', intent: 'application_generation',
      route_locked: true, initial_prompt: 'hi',
    },
    messages: [{ id: 'lu1', role: 'user', content: 'hi' }],
    route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  }
  // Real thinking present → no pending placeholder.
  const withThinking = buildDialogueTimeline(
    liveView, null, null,
    { key: 'think:t1', content: '思考中…', kind: 'round' },
    [], { turnId: 't1' },
  )
  const pendingWithThinking = withThinking.find(it => it.type === 'live_thinking' && it.pending)
  assert.ok(!pendingWithThinking, 'no pending placeholder when real liveThinking content exists')
  const realThink = withThinking.find(it => it.type === 'live_thinking' && !it.pending)
  assert.ok(realThink, 'real live_thinking renders instead of the placeholder')

  // Real analysis present → no pending placeholder.
  const withAnalysis = buildDialogueTimeline(
    liveView, null,
    { key: 't1', content: '分析中…', kind: 'round' },
    null, [], { turnId: 't1' },
  )
  const pendingWithAnalysis = withAnalysis.find(it => it.type === 'live_thinking' && it.pending)
  assert.ok(!pendingWithAnalysis, 'no pending placeholder when real liveAnalysis content exists')

  // No pendingTurn → no placeholder even without live content.
  const noPending = buildDialogueTimeline(liveView, null, null, null, [], null)
  const pendingNoTurn = noPending.find(it => it.type === 'live_thinking' && it.pending)
  assert.ok(!pendingNoTurn, 'no pending placeholder when pendingTurn is absent')
}

// ---- 4. Backward compatibility: pendingTurn defaults to null ----------------
//
// Existing callers that do not pass pendingTurn must not break, and must not
// see a spurious placeholder.
{
  const compatView = {
    session: {
      id: 'dlg_compat', status: 'drafting_application', intent: 'application_generation',
      route_locked: true, initial_prompt: 'hi',
    },
    messages: [{ id: 'cu1', role: 'user', content: 'hi' }],
    route: { intent: 'application_generation', confidence: 'high', needsRouteConfirmation: false, userFacingReason: '' },
  }
  const compatTimeline = buildDialogueTimeline(compatView)
  const compatPending = compatTimeline.find(it => it.type === 'live_thinking' && it.pending)
  assert.ok(!compatPending, 'no pending placeholder when pendingTurn is omitted (backward compatible)')
}

console.log('check-conversation-agent-streaming: live thinking tail + pending placeholder OK')
