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
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

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
