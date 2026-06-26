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
// The application-generation flow persists its analysis_work_log in the CHILD
// clarification thread (not the parent). Without surfacing it, the streaming
// live block is cleared on every reload and the thinking process vanishes. The
// child analysis_work_log must render as a FOLDED analysis_stream item above the
// question/conclusion (D6 retention), one collapsed block per entry.
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
const replayedUserIndex = replayedThinkingTimeline.findIndex(it => it.type === 'user_message' && it.content === '做一个员工请假审批流程')
const replayedThinkingIndex = replayedThinkingTimeline.findIndex(it => it.type === 'thinking_summary')
const replayedAnalysisIndex = replayedThinkingTimeline.findIndex(it => it.type === 'analysis_stream' && it.content === '已识别为员工请假审批流程，需要确认审批层级。')
assert.ok(replayedThinkingIndex > replayedUserIndex, 'persisted thinking must append after the latest related user message')
assert.ok(replayedThinkingIndex < replayedAnalysisIndex, 'persisted thinking summary must remain in chronological flow before the following analysis')
const replayedThinkingItem = replayedThinkingTimeline[replayedThinkingIndex]
assert.equal(replayedThinkingItem.content, 'The model is reasoning in English about leave approval.', 'persisted raw thinking is preserved for the original view')
assert.equal(replayedThinkingItem.summary, '已识别为员工请假审批流程，需要确认审批层级。', 'persisted thinking summary uses the following safe Chinese analysis')

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
assert.equal(mrAnswers.length, 1, 'batched answers render as ONE user reply')
assert.equal(mrAnswers[0].content, 'Q1：选项乙；Q2：选项丁', 'batched answer echo joins each 问题：选项 segment with ；')
assert.ok(mrTimeline.indexOf(mrAnalysis[0]) < mrTimeline.indexOf(mrAnswers[0]), 'round-1 analysis sits above the answers')
assert.ok(mrTimeline.indexOf(mrAnswers[0]) < mrTimeline.indexOf(mrAnalysis[1]), 'round-2 analysis sits below the batched answer echo')


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

const thinkingTraceItems = [
  {
    id: 'think_1', sequence: 2, type: 'thinking', dialogueId: 'dlg_live',
    stepId: 'step_1', jobId: 'job_1',
    payload: { text: '正在推理生成方案' },
  },
]
assert.equal(
  liveStepFromTrace(thinkingTraceItems),
  null,
  'pipeline step thinking must not be treated as step analysis in the conversation',
)
const dialogueHookSrc = readFileSync(new URL('../src/hooks/useDialogueSessions.js', import.meta.url), 'utf8')
assert.equal(
  /liveThinkingFromTrace\(|foldTraceIntoLiveThinking\(/.test(dialogueHookSrc),
  false,
  'task/pipeline step thinking must not be bridged into the conversation liveThinking surface',
)

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
  { key: 'turn:t1', content: '已识别为员工请假审批流程，需要确认审批层级和假期余额来源。', kind: 'round' },
  { key: 'thinking:t1', content: 'The model is reasoning in English...', kind: 'round' },
)
const liveThinkItem = liveThinkTimeline.find(it => it.type === 'live_thinking')
assert.ok(liveThinkItem, 'liveThinking renders a live_thinking item')
assert.equal(liveThinkItem.content, 'The model is reasoning in English...', 'raw thinking content is preserved for original view')
assert.equal(
  liveThinkItem.summary,
  '已识别为员工请假审批流程，需要确认审批层级和假期余额来源。',
  'live_thinking exposes a Chinese summary from the safe live analysis text',
)
const noSummaryTimeline = buildDialogueTimeline(
  null,
  { id: 'opt_t2', content: 'hi' },
  null,
  { key: 'thinking:t2', content: 'Still thinking in English...', kind: 'round' },
)
const noSummaryThinking = noSummaryTimeline.find(it => it.type === 'live_thinking')
assert.equal(noSummaryThinking.summary, '', 'no analysis means no fabricated Chinese summary')

// Static guard: the live item is rendered as plaintext, never dangerouslySetInnerHTML.
// Strip comments so a doc comment mentioning the forbidden API does not trip it.
const workbenchSrc3 = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
assert.equal(
  /dangerouslySetInnerHTML/.test(workbenchSrc3.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  false,
  'ConversationWorkbench must never use dangerouslySetInnerHTML',
)
assert.match(workbenchSrc3, /ThinkingSummary/, 'ConversationWorkbench must render live_thinking through ThinkingSummary')
assert.match(workbenchSrc3, /思考摘要/, 'thinking summary UI must use the 思考摘要 label')
assert.match(workbenchSrc3, /原始思考过程/, 'raw thinking must be behind an 原始思考过程 disclosure')
assert.match(workbenchSrc3, /<details[\s\S]*<summary[\s\S]*原始思考过程/, 'raw thinking should be collapsed by default in a details disclosure')

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
// Task 5 (continued): Enum display mapping (D7)
//
// Create displayLabels.js with pure functions that map backend enum values to
// user-facing Chinese labels, use it in both ConversationWorkbench and
// ClarificationPanel requirement summaries.
// ============================================================================

// ---- 5a. displayLabels.js must exist and export the expected API -----------
const displayLabelsSrc = readFileSync(new URL('../src/displayLabels.js', import.meta.url), 'utf8')
assert.ok(
  displayLabelsSrc.includes('export function displayRequirementValue'),
  'displayLabels.js must export displayRequirementValue function',
)
assert.ok(
  displayLabelsSrc.includes('APP_TYPE_LABELS'),
  'displayLabels.js must define APP_TYPE_LABELS mapping',
)
assert.ok(
  displayLabelsSrc.includes('DATA_POLICY_LABELS'),
  'displayLabels.js must define DATA_POLICY_LABELS mapping',
)

// Import the module to verify it works.
const { displayRequirementValue } = await import('../src/displayLabels.js')

// ---- 5b. Basic enum mapping works correctly --------------------------------
assert.equal(
  displayRequirementValue('appType', 'operations_management'),
  '业务管理类智能体',
  'operations_management maps to 业务管理类智能体',
)
assert.equal(
  displayRequirementValue('appType', 'command_dashboard'),
  '指挥看板类智能体',
  'command_dashboard maps to 指挥看板类智能体',
)
assert.equal(
  displayRequirementValue('appType', 'timeline_replay'),
  '态势复盘类智能体',
  'timeline_replay maps to 态势复盘类智能体',
)
assert.equal(
  displayRequirementValue('appType', 'affiliation_assessment'),
  '归属研判类智能体',
  'affiliation_assessment maps to 归属研判类智能体',
)
assert.equal(
  displayRequirementValue('dataPolicy', 'live_api'),
  '真实接口优先',
  'live_api maps to 真实接口优先',
)
assert.equal(
  displayRequirementValue('dataPolicy', 'mock_data'),
  '演示 / Mock 数据',
  'mock_data maps to 演示 / Mock 数据',
)
assert.equal(
  displayRequirementValue('dataPolicy', 'mock_then_api'),
  '真实接口优先（失败时明确提示，不回退 Mock）',
  'mock_then_api maps to the explicit honest label',
)

// ---- 5c. Edge cases handled -------------------------------------------------
assert.equal(
  displayRequirementValue('appType', 'unknown_type'),
  '未识别值：unknown_type',
  'unknown enum values get the 未识别值: prefix',
)
assert.equal(
  displayRequirementValue('appType', null),
  '',
  'null yields empty string',
)
assert.equal(
  displayRequirementValue('appType', undefined),
  '',
  'undefined yields empty string',
)
assert.equal(
  displayRequirementValue('appType', ''),
  '',
  'empty string yields empty string',
)
assert.equal(
  displayRequirementValue('coreScenario', '图书借阅'),
  '图书借阅',
  'fields without a mapping pass through unchanged',
)
assert.equal(
  displayRequirementValue('appType', ['operations_management', 'command_dashboard']),
  '业务管理类智能体、指挥看板类智能体',
  'arrays are mapped item-wise and joined with 、',
)

// ---- 5d. Both panels import and use displayRequirementValue ----------------
assert.ok(
  workbenchSrc.includes('displayRequirementValue'),
  'ConversationWorkbench must import displayRequirementValue',
)
assert.ok(
  workbenchSrc.includes("displayRequirementValue('appType'"),
  'ConversationWorkbench must map appType in requirement summary',
)
assert.ok(
  workbenchSrc.includes("displayRequirementValue('dataPolicy'"),
  'ConversationWorkbench must map dataPolicy in requirement summary',
)

const clarPanelSrc = readFileSync(new URL('../src/components/ClarificationPanel.jsx', import.meta.url), 'utf8')
assert.ok(
  clarPanelSrc.includes('displayRequirementValue'),
  'ClarificationPanel must import displayRequirementValue',
)
assert.ok(
  clarPanelSrc.includes("displayRequirementValue('appType'"),
  'ClarificationPanel must map appType in requirement summary',
)
assert.ok(
  clarPanelSrc.includes("displayRequirementValue('dataPolicy'"),
  'ClarificationPanel must map dataPolicy in requirement summary',
)

// ---- 5e. Raw enum strings must NOT appear in user-facing summaries ---------
// In the requirement summary rows, we must NOT render the raw backend enum
// strings. The display mapper must always be used for appType and dataPolicy.
const clarRendered = clarPanelSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

// Verify the old raw enum display is gone and the mapper is used instead.
assert.ok(
  clarRendered.includes('智能体类型') && !clarRendered.includes('应用类型'),
  'ClarificationPanel requirement summary must use 智能体类型, not 应用类型',
)

// Verify "确认并生成" becomes "确认并生成智能体" in both panels.
assert.ok(
  workbenchSrc.includes('确认并生成智能体'),
  'ConversationWorkbench confirm button must say 确认并生成智能体',
)
assert.ok(
  workbenchSrc.includes('function RequirementSummary({ requirement, canConfirm, onConfirm, submitting })') &&
    workbenchSrc.includes('cw-summary-confirm'),
  'ConversationWorkbench must attach 确认并生成智能体 to the RequirementSummary item',
)
assert.equal(
  /canConfirm \? \(\s*<div className="cw-answer-bar">/.test(workbenchSrc),
  false,
  'ConversationWorkbench must not render application confirm in a fixed cw-answer-bar',
)
assert.ok(
  clarPanelSrc.includes('确认并生成智能体'),
  'ClarificationPanel confirm button must say 确认并生成智能体',
)

console.log('check-conversation-agent-streaming: enum display mapping OK')
