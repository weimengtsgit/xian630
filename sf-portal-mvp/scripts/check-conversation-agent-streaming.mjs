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
  foldTraceIntoLiveAnalysis,
} from '../src/hooks/dialogueTimeline.js'
import { liveStepFromTrace } from '../src/hooks/workTraceState.js'

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
  // The blocking high-impact item is delivered as a normal question message in
  // the child thread (one per round). openHighImpact itself is backend-only
  // gating metadata; it does not need a new UI element.
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
assert.equal(qGroup.questions.length, 1, 'exactly one blocking question per round (adaptive invariant)')
const rendered = qGroup.questions[0]
assert.equal(rendered.id, 'data_policy', 'question id must be preserved')
assert.equal(rendered.options.length, 2, 'options must be preserved for the user to pick')
assert.equal(rendered.options[0].recommended, true, 'recommendation badge must mark the recommended option')

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
assert.equal(persistedAnalysis.folded, true, 'persisted analysis_stream must render FOLDED (collapsed) above the conclusion (D6)')
assert.equal(persistedAnalysis.expanded, false, 'folded item defaults to collapsed (expanded false)')

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

// ---- 3e. No thinking_delta / raw-reasoning field is ever read into the timeline
//
// Security constraint #9: raw hidden reasoning never reaches the frontend. The
// reducer must ignore any thinking_delta field even if a (malicious/buggy)
// payload carries one. We feed a delta whose `delta` is the safe text but which
// also carries thinking_delta — only the safe text survives.
const guardedSt = applyLiveAnalysisEvent(baseState, 'dialogue.route.delta', {
  dialogue_id: 'dlg_live', turn_id: 't1', delta: '安全分析文本',
  thinking_delta: 'RAW HIDDEN REASONING',
  thinking: 'MORE RAW REASONING',
})
assert.ok(guardedSt.liveAnalysis, 'liveAnalysis folded from a safe delta')
assert.equal(
  guardedSt.liveAnalysis.content.includes('RAW'), false,
  'no thinking_delta / thinking field content may reach the live analysis item',
)
assert.equal(guardedSt.liveAnalysis.content, '安全分析文本', 'only the safe delta text is folded')

// Static guard: the mapper source must never reference thinking fields.
const mapperSrc = readFileSync(new URL('../src/hooks/dialogueTimeline.js', import.meta.url), 'utf8')
assert.equal(
  /thinking_delta|thinking\b/i.test(mapperSrc.replace(/\/\/[^\n]*/g, '')),
  false,
  'dialogueTimeline source must never read thinking_delta/thinking fields (security #9)',
)

// Static guard: the live item is rendered as plaintext, never dangerouslySetInnerHTML.
// Strip comments so a doc comment mentioning the forbidden API does not trip it.
const workbenchSrc3 = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
assert.equal(
  /dangerouslySetInnerHTML/.test(workbenchSrc3.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  false,
  'ConversationWorkbench must never use dangerouslySetInnerHTML',
)

console.log('check-conversation-agent-streaming: live analysis streaming + fold OK')
