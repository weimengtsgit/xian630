# Conversation Agent Streaming and Clarification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Keep existing worktree changes intact;
> inspect a shared file before editing and never `reset`/`checkout` unrelated
> work.
>
> **Execution preference:** Execute with
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`.
>
> Decisions D1–D7 are locked in ADR 0006, ADR 0007, CONTEXT.md, and the
> adaptive clarification spec; do not re-litigate them.

**Goal:** Make the conversation workbench behave like a live general-purpose
agent (Codex / Claude Code): a user message appears instantly, Claude Code
CLI's raw 思考过程 streams token-by-token beneath it, the safe analysis work log
and the round's conclusion follow, and the streamed thinking/analysis folds
above the conclusion. Requirement
clarification no longer jumps straight to a generate button - high-impact
decisions are surfaced as business-specific question batches and must be
confirmed before the confirm-and-generate action appears. The produced product
is labelled 智能体 in every user-facing surface while the internal entity stays
应用, and internal enum values such as `operations_management` / `live_api` are
translated to Chinese labels before they reach the user.

**Architecture:** The backend streaming plumbing for pipeline steps already
exists (dialogue-attributed work-trace events stream token-by-token through
`dialogue.work_trace`). The frontend must (a) fold `*.delta` (routing /
clarification / business-draft rounds) and `dialogue.work_trace` (pipeline
steps) incrementally into live thinking and live analysis items in the
conversation timeline, and (b) render them folded above each conclusion. A new
server-side gate makes
`ready_to_confirm` impossible while any high-impact confirmation item remains
open. A new contract field carries open high-impact items; the
`requirement-clarification` skill surfaces them as one batch per round so the
user can answer multiple related clarification items together. The previous
security constraint #9 is relaxed for the conversation workbench: Claude Code
CLI `thinking` / `thinking_delta` is forwarded, displayed, and retained as a
dedicated 思考过程 channel, separate from analysis logs, work-trace audit rows,
tool output, raw stdout/stderr, and attachments. User-facing requirement
summaries use a small frontend display-label mapper so internal contract enums
remain stable while the UI shows Chinese business terms.

**Tech stack:** Go, SQLite, `net/http`, Server-Sent Events, local Claude Code
CLI, React 18, Vite, project-local Claude skills.

## Accepted Product Decisions (locked)

- **D1 — "思考过程" = Claude Code CLI raw thinking stream, displayed live.**
  `thinking` / `thinking_delta` is forwarded through a dedicated conversation
  channel and rendered separately from 分析过程. 分析过程 remains the safe
  analysis work log; 思考过程 is the raw Claude Code CLI thinking block.
- **D2 — Live stream covers intent routing + clarification + all six pipeline
  steps.** The conversation workbench is the primary live surface; the step
  matrix and execution drawer stay as secondary detail/overview.
- **D3 — High-impact confirmation items are non-skippable** (ADR 0006). A
  requirement cannot reach `ready_to_confirm` while any 高影响确认事项 (a
  decision that can change business meaning, data source, external interface,
  permission, deployment, or user-visible behavior) remains open, regardless of
  how detailed the first message is. Non-high-impact details may still be
  assumed adaptively; a field filled from a blueprint assumption is not a
  confirmed high-impact decision. Open clarification items are shown as a
  multi-question batch in a round and submitted together. The six-round flow is
  an upper bound, not a minimum: the model may converge earlier once every
  high-impact item is explicitly confirmed, but round 1 must not jump directly
  to confirm from assumptions. "All clarification items" means all currently
  identified high-impact / must-confirm decisions; low-impact inferred details
  are recorded as assumptions in the analysis log and reviewed in the final
  requirement summary rather than rendered as extra questions.
- **D4 — User-facing noun is 智能体; internal entity stays 应用.** (CONTEXT.md
  updated.)
- **D5 — Optimistic user-message insert + failure rollback**, and drop the
  redundant serial `refreshSessions()` before `loadView()`.
- **D6 — Streamed thinking and analysis fold above each conclusion** (Claude
  Code thinking-block style) and remain replayable from persisted events.
- **D7 — User-facing summaries translate internal enums to Chinese.**
  `operations_management`, `live_api`, `mock_data`, `mock_then_api`, and other
  known contract enum values stay unchanged in backend contracts but are never
  shown raw in conversation summaries or clarification summaries.

## Source References

- Locked decisions: `docs/adr/0006-high-impact-confirmation-non-skippable.md`,
  `docs/adr/0007-show-claude-code-thinking-in-conversation.md`,
  `CONTEXT.md` (`应用`, `高影响确认事项`, `模型分析过程`, `分析工作日志`,
  `模型思考过程`, `路由选择回显`, `智能体打开回显`, `澄清答案回显`,
  `可见工作轨迹`), adaptive spec
  `docs/superpowers/specs/2026-06-23-adaptive-requirement-clarification-design.md`.
- Send path: `sf-portal-mvp/src/hooks/useDialogueSessions.js` (`send` ~175-218,
  SSE reconcile ~520-580).
- Event reducer: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
  (`applyDialogueEvent` ~398-407 sets `needsRefresh`; `buildDialogueTimeline`
  ~80-192; requirement scrubber ~378-390).
- Reference delta-fold: `sf-portal-mvp/src/hooks/clarificationLogic.js` (~50-87,
  full-so-far `delta` set-not-append).
- SSE: `sf-portal-mvp/src/api/events.js` (`subscribeFactoryEvents` dialogue.*
  + clarification.* types; `subscribeDialogueTrace` work-trace hydrate→live→gap).
- Workbench render: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
  (composer `submitText` ~108-113; `pendingTurn` banner ~199-202;
  `analysis_stream` branch ~283-290; route card ~327-345; confirm gate ~73-83;
  `RequirementSummary` currently renders raw `appType` / `dataPolicy` values).
- Legacy clarification render: `sf-portal-mvp/src/components/ClarificationPanel.jsx`
  (`SummaryRow` currently renders raw `appType` / `dataPolicy` values).
- Clarification contract: `factory-server/internal/clarification/contracts.go`
  (`RoundOutput` ~130-138; `Question` ~51-60; `Requirement` ~73-84).
- Ready-to-confirm convergence: `factory-server/internal/server/clarification_handlers.go`
  `runRoundAndPersist` ~949-957; `advanceAfterUserTurn` ~998-1011;
  `normalizeClarificationReadiness` ~1039; confirm gates ~674-682.
- Dialogue confirm gate: `factory-server/internal/server/dialogue_handlers.go`
  ~1628-1631.
- Pipeline step streaming (already dialogue-attributed for safe analysis/tool
  traces; must be extended with a dedicated thinking channel):
  `factory-server/internal/executor/executor.go` (`newStepEmitter` ~440,
  `stepEmitter.Trace` ~229-249 drops when `dialogueID==""`), `claude_runner.go`
  `emitWorkLog` ~144-152, `internal/runner/stream.go` ~35-240 (currently drops
  `thinking_delta` at source and must be changed for dialogue-attributed CLI
  runs), `internal/server/events.go`
  `recordAndPublishWorkTrace` ~190-199.
- Skill: `.claude/skills/requirement-clarification/SKILL.md` (no high-impact
  concept today).

## Target File Map

Create:

```text
docs/adr/0007-show-claude-code-thinking-in-conversation.md
sf-portal-mvp/src/displayLabels.js
sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs
```

Modify:

```text
CONTEXT.md
.claude/skills/requirement-clarification/SKILL.md
factory-server/internal/clarification/contracts.go
factory-server/internal/clarification/runner.go
factory-server/internal/clarification/runner_test.go
factory-server/internal/server/clarification_handlers.go
factory-server/internal/server/clarification_handlers_test.go
factory-server/internal/server/dialogue_handlers.go
factory-server/internal/server/dialogue_handlers_test.go
factory-server/internal/executor/claude_runner.go
factory-server/internal/executor/executor.go
factory-server/internal/executor/executor_test.go
sf-portal-mvp/src/hooks/useDialogueSessions.js
sf-portal-mvp/src/hooks/dialogueTimeline.js
sf-portal-mvp/src/hooks/workTraceState.js
sf-portal-mvp/src/components/ClarificationPanel.jsx
sf-portal-mvp/src/components/ConversationWorkbench.jsx
sf-portal-mvp/src/components/ConversationWorkbench.css
sf-portal-mvp/scripts/check-dialogue-workbench.mjs
```

`check-dialogue-workbench.mjs` is extended; the new
`check-conversation-agent-streaming.mjs` owns the streaming + optimistic +
high-impact + rename assertions so the old check keeps its scope.

## Global Constraints

- Claude Code CLI `thinking` / `thinking_delta` MUST be forwarded to the
  conversation workbench when it is produced by a dialogue-attributed routing,
  clarification, business-draft, or generation-step run. It is shown as
  思考过程, not as 分析过程.
- 思考过程 MUST use a dedicated event/message path (`*.thinking` or equivalent)
  and MUST NOT be merged into analysis work logs, tool summaries, stdout/stderr,
  audit attachments, or generic work-trace event types. The boundary is
  separation and attribution, not suppression.
- 思考过程 MUST be attributed to the triggering dialogue turn, clarification
  answer, route selection, or generation step so the conversation timeline can
  append it under the user action that caused it.
- A route selection MUST append one user-visible 路由选择回显 message, such as
  `我选择：新建智能体` or `我选择：复用「员工请假助手」`. Any following 思考过程,
  分析过程, reuse recommendation, or clarification session must appear beneath
  that choice in chronological order.
- Opening a recommended reusable 智能体 MUST append one user-visible
  智能体打开回显 message, such as `我打开：员工请假助手` or
  `我启动并打开：员工请假助手`, before the resolved/open result appears.
- A submitted clarification batch MUST append one user-visible 澄清答案回显
  message using Chinese question labels and selected option labels (for example
  `审批层级：直属主管 + HR；假期余额来源：真实接口`). The following 思考过程 and
  分析过程 must be anchored under that reply, not under the original prompt.
- User-facing summaries and confirmation views MUST NOT render known internal
  enum values raw. Examples: `operations_management` -> `业务管理类智能体`,
  `command_dashboard` -> `指挥看板类智能体`, `situation_replay` ->
  `态势复盘类智能体`, `affiliation_assessment` -> `归属研判类智能体`,
  `live_api` -> `真实接口优先`, `mock_data` -> `演示 / Mock 数据`,
  `mock_then_api` -> `真实接口优先（失败时明确提示，不回退 Mock）`.
- 确认需求摘要 MUST be appended as an agent message in the chronological
  conversation flow after the final clarification analysis. The
  确认并生成智能体 action belongs to that summary message, not to a fixed global
  footer or floating bottom bar.
- Persist event-equivalent records BEFORE publishing any SSE event, including
  thinking events that are retained for replay.
- Preserve existing user changes and unrelated files (the carrier-affiliation
  scene work, the AgentsPanel/协作智能体 tab owned by the collaborating branch).
  No `git reset` / `checkout --hard`.
- Tool I/O / API / command logs remain allowlisted, redacted, length-capped.
  Raw Claude stdout/stderr is still not exposed as an attachment merely to
  obtain thinking; parse and publish the thinking stream explicitly.
- A new version of an application becomes effective only after build + deploy +
  health succeed; rollback is explicit-confirm (unchanged by this plan).

## Task 1: Optimistic user-message insert and faster send (D5)

**Files:**
- Modify: `sf-portal-mvp/src/hooks/useDialogueSessions.js`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`

- [ ] **Step 1: Write a failing logic check.**

  Assert the send path inserts a transient optimistic user message into the
  timeline state synchronously (before any `await`), that it is reconciled
  (dropped) once the persisted view reload contains a user message with the same
  content, and that a send failure clears the optimistic message and surfaces an
  error. Assert `send` no longer awaits a full `refreshSessions()` before
  `loadView()` (the history list refresh must not block the selected-view load).

- [ ] **Step 2: Add the optimistic item to the timeline builder.**

  In `dialogueTimeline.js`, support a transient optimistic user message in state
  (e.g. `optimisticUserMessage: { id, content }`). `buildDialogueTimeline` must
  prepend it as a `user_message` item when present, and must dedupe it against a
  persisted user message with identical content for the same turn (so the reload
  does not render the user twice). Keep the persisted message authoritative on
  reload.

- [ ] **Step 3: Insert optimistically and reconcile in `send`.**

  In `useDialogueSessions.send`, set the optimistic message synchronously at the
  top of the happy path (before the first `await`) and clear it in a `finally`
  once a persisted user message for the turn is visible, or on error (rollback +
  `setError`). Move `refreshSessions()` so it does not block the selected-view
  load: kick the history refresh without `await`-ing it before `loadView()` (it
  may run concurrently or after; the history list updates on its own). Keep the
  202-ack continuation path optimistic too — the message shows immediately and
  the live stream (Task 3) fills in beneath it.

- [ ] **Step 4: Append route selections as user replies.**

  In `useDialogueSessions.selectRoute` / `dialogueTimeline.js`, add an
  optimistic and persisted 路由选择回显 so clicking `复用已有智能体` or
  `生成新智能体` appends one `user_message` such as `我选择：新建智能体` or
  `我选择：复用「<智能体名>」`. The next route-confirmation analysis,
  recommendation, or clarification stream must anchor below this message. Add a
  logic check that route-confirmed follow-up content is ordered after the route
  choice, not after the original prompt.

- [ ] **Step 5: Append reusable-agent open actions as user replies.**

  In `useDialogueSessions.openApp` / `dialogueTimeline.js`, add an optimistic
  and persisted 智能体打开回显 so clicking `打开智能体` appends
  `我打开：<智能体名>` and clicking `启动并打开` appends
  `我启动并打开：<智能体名>`. The `resolved_outcome` / open result must appear
  after this user action, not as a silent state jump. Add a logic check that the
  open result follows the open-action message in replayed history.

- [ ] **Step 6: Run the portal check.**

  `node scripts/check-dialogue-workbench.mjs` from `sf-portal-mvp`.

## Task 2: High-impact confirmation gate (D3)

**Files:**
- Modify: `.claude/skills/requirement-clarification/SKILL.md`
- Modify: `factory-server/internal/clarification/contracts.go`
- Modify: `factory-server/internal/clarification/runner.go`, `runner_test.go`
- Modify: `factory-server/internal/server/clarification_handlers.go`, `clarification_handlers_test.go`
- Modify: `factory-server/internal/server/dialogue_handlers.go`, `dialogue_handlers_test.go`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`

- [ ] **Step 1: Write failing runner + handler tests first.**

  Runner: assert the round output carries an `openHighImpact` list whose entries
  are redacted/validated (each entry: id, label, recommended option) and that
  malformed entries are rejected. Handler: with a fake runner returning
  `openHighImpact` non-empty, assert the round persists as a question round
  (status stays `waiting_user`/`active`) and NEVER `ready_to_confirm`, even when
  `out.Status == ready_to_confirm` and all required fields are filled; once the
  runner returns `openHighImpact` empty, assert it promotes to
  `ready_to_confirm`. Assert the dialogue `/clarification/confirm` gate still
  rejects (409) unless `ready_to_confirm`.

- [ ] **Step 2: Extend the contract.**

  Add to `RoundOutput` a field, e.g. `OpenHighImpact []HighImpactItem` with
  `HighImpactItem{ ID, Label, Recommendation, Options []Option }`. Keep it
  user-facing only: no internal blueprint/catalog references. Add the dialogue
  `BusinessDraftOutput` analogue only if business drafting needs it (default:
  leave business drafting unchanged in this task unless a question surfaces).

- [ ] **Step 3: Parse and validate in the runner.**

  In `clarification/runner.go`, parse `openHighImpact` from the skill JSON,
  validate each entry (non-empty id/label, ≤3 options, no invented internal
  names), and drop/redact anything disallowed. Mirror the existing artifact
  discipline. Add a unit test asserting a round returning both a complete
  requirement and a non-empty `openHighImpact` does NOT short-circuit.

- [ ] **Step 4: Enforce the gate at the single convergence point.**

  In `clarification_handlers.go` `runRoundAndPersist` (~949-957), change the
  readiness condition so `ready_to_confirm` requires
  `len(out.OpenHighImpact) == 0` in addition to the existing
  `IsReadyToConfirmStatus(out.Status) || (no questions && no missing required
  fields)`. Apply the same condition in `normalizeClarificationReadiness`
  (~1039) and `advanceAfterUserTurn` (~998-1011): a session that still has open
  high-impact items stays question/active even at the MaxRounds cap. Persist the
  open high-impact items with the round so history replays the same gate.

- [ ] **Step 5: Teach the skill to surface high-impact items as a batch.**

  Update `.claude/skills/requirement-clarification/SKILL.md`: identify open
  高影响确认事项 each round; while any remain, round output returns all
  currently open, business-relevant blocking questions in `questions[]` (each
  with recommendation) AND lists the same set in `openHighImpact`; only when
  `openHighImpact` is empty may it return `ready_to_confirm`. A
  blueprint-assumed field is explicitly NOT a confirmed high-impact decision.
  Output-contract example updated with `openHighImpact`. The skill must avoid
  generic fixed triplets and instead derive the batch from the user's business
  description. Six rounds is a maximum, not a quota; the flow may enter
  `ready_to_confirm` earlier once no high-impact item remains open. Low-impact
  fields that can be inferred should be documented as assumptions in `workLog`
  and the confirmation summary instead of being asked as questions.

- [ ] **Step 6: Render open high-impact items in the workbench.**

  In `dialogueTimeline.js`, map each round's blocking high-impact questions to
  the existing `question_group`/`QuestionCard` path (it already supports
  multiple cards, recommendation badges, and options), so the user answers a
  batch and submits it once. In `ConversationWorkbench.jsx`, keep the
  confirm action gated on `ready_to_confirm` (already the case) — it now cannot
  appear while high-impact items are open. Step 8 moves that action into the
  summary timeline item.

- [ ] **Step 7: Append submitted clarification answers as one user reply.**

  Update `dialogueTimeline.js` so a batch of persisted clarification answer
  messages is rendered as a SINGLE `user_message` containing Chinese
  `问题标签：选项标签` segments joined by `；`, not as one bubble per answer and
  not as raw option values. The next round's live `live_thinking` and
  `live_analysis` items must anchor immediately after this 澄清答案回显. Add a
  check in `check-conversation-agent-streaming.mjs` that round 2 analysis
  appears below the submitted answer summary, not below the original prompt.

- [ ] **Step 8: Render the requirement summary as the final agent message.**

  Keep `requirement_summary` in the ordered timeline immediately after the last
  persisted 思考过程 / 分析过程 for the clarification flow. Move the
  `确认并生成智能体` affordance into the `RequirementSummary` timeline item
  (or render it directly adjacent to that item) so the action is visually tied
  to the summary, not a fixed answer bar at the bottom of the workbench. Add a
  check that the summary and its confirm action remain in order after history
  reload.

- [ ] **Step 9: Run focused tests.**

  `go test ./internal/clarification ./internal/server` from `factory-server`;
  `node scripts/check-conversation-agent-streaming.mjs` from `sf-portal-mvp`.

## Task 3: Live thinking + analysis streaming in the conversation (D1, D2, D6)

**Files:**
- Modify: `sf-portal-mvp/src/hooks/useDialogueSessions.js`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/src/hooks/workTraceState.js`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`

- [ ] **Step 1: Write a failing logic check.**

  Assert: (a) a `*.delta` event for the selected dialogue folds incrementally
  into a live analysis item (does NOT only set `needsRefresh`); (b) a
  `*.thinking` event for the selected dialogue folds incrementally into a live
  thinking item; (c) a dialogue-attributed generation-step thinking event
  appears in the same conversation surface for pipeline steps; (d) on the
  round/step completion event the live items are replaced by persisted thinking
  and analysis items rendered FOLDED above the conclusion; (e) folded thinking
  and analysis are replayable from persisted state after a reload.

- [ ] **Step 2: Add transient live-thinking and live-analysis items to the timeline state.**

  In `dialogueTimeline.js` add reducers that, for the selected dialogue, fold
  `*.thinking` into `live_thinking` and `*.delta` / `dialogue.work_trace` into
  `live_analysis`, keyed by the triggering user action / turn / step. Payloads
  carry the full-so-far text (set-not-append). The items sit directly after the
  optimistic / persisted user message, 路由选择回显, or 澄清答案回显 that caused
  the model call.

- [ ] **Step 3: Stop using needsRefresh for live deltas.**

  In `applyDialogueEvent`, route `*.delta` and `dialogue.work_trace` (for the
  selected dialogue) to the incremental fold from Step 2 instead of setting
  `needsRefresh`. Keep `needsRefresh` for completion/lifecycle events
  (`*.completed`, `*.updated` that change persisted structure, route
  confirmation, ready_to_confirm) so the authoritative persisted view still
  reconciles. This removes the per-token full reload.

- [ ] **Step 4: Render the live items and fold on completion.**

  In `ConversationWorkbench.jsx`, render `live_thinking` as a streaming
  "思考过程" block and `live_analysis` as a streaming "分析过程" block
  (monospace, plaintext `<pre>`-safe, never `dangerouslySetInnerHTML`). When
  persisted items land (post-completion reload), replace transient blocks with
  persisted folded thinking + analysis above the conclusion, with expand
  controls (D6). The step matrix and execution drawer remain as secondary
  detail.

- [ ] **Step 5: Inline pipeline thinking and work-trace into the conversation.**

  The pipeline already streams dialogue-attributed `dialogue.work_trace`
  (assistant text, tool use). Ensure `workTraceState` exposes the in-flight
  traces for the selected dialogue's current job/step so the conversation's
  live analysis item shows the build phase token-by-token. Add a dedicated
  dialogue-attributed thinking stream for real Claude Code CLI pipeline steps,
  so `thinking_delta` appears in the same turn/step as 思考过程. On step
  completion, the step's thinking and analysis summary fold above the step
  result (D6). In fake mode the step is batch (no token stream) — it lands as a
  completed block; acceptable per D2.

- [ ] **Step 6: Run the portal checks and build.**

  `node scripts/check-conversation-agent-streaming.mjs`,
  `node scripts/check-dialogue-workbench.mjs`, and `npm run build` from
  `sf-portal-mvp`.

## Task 4: Surface structured pipeline workLog in the dialogue trace (D2 backend)

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/executor/executor_test.go`

- [ ] **Step 1: Write failing executor tests.**

  Assert that a structured workLog summary entry decoded from `output.json` is
  emitted as a dialogue-attributed trace (so it reaches the conversation), not
  only as a job-scoped `step_execution_records` row. Assert real CLI
  `thinking_delta` from a dialogue-attributed pipeline step is emitted through
  the dedicated thinking channel and never through tool/stdout/work-log fields.

- [ ] **Step 2: Emit the workLog summary as a trace.**

  In `claude_runner.go` `emitWorkLog` (~144-152), in addition to emitting
  `ExecutionRecordSummary` records, emit the safe summary text through the
  dialogue-scoped trace emitter (the same path `stepEmitter.Trace` uses, which
  stamps `DialogueID` and drops when empty). Separately parse and forward
  `thinking_delta` through a dialogue-attributed thinking emitter. Do not store
  thinking as a `step_execution_records` summary and do not expose raw stdout.

- [ ] **Step 3: Run focused tests.**

  `go test ./internal/executor ./internal/server` from `factory-server`.

## Task 5: User-facing 智能体 label and Chinese enum display (D4, D7)

**Files:**
- Create: `sf-portal-mvp/src/displayLabels.js`
- Modify: `sf-portal-mvp/src/components/ClarificationPanel.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`

- [ ] **Step 1: Rename the user-facing product strings.**

  In the workbench route card and confirm affordances, change user-facing
  product nouns to 智能体: `生成新应用` → `生成新智能体`; the route card
  subtitle `通过需求澄清生成助手应用或业务应用` → `…生成助手智能体或业务智能体`;
  frame the `确认并生成` action in 智能体 terms. Leave internal identifiers,
  API paths, and the collaborating-branch-owned `AgentsPanel` / 协作智能体 tab
  untouched. (The left 应用列表 → 业务智能体 rename is already done.)

- [ ] **Step 2: Add a centralized enum display mapper.**

  Create `sf-portal-mvp/src/displayLabels.js` with pure functions used by both
  `ConversationWorkbench.jsx` and `ClarificationPanel.jsx`. Keep backend enum
  values unchanged; only the UI display layer translates them.

  ```js
  const APP_TYPE_LABELS = {
    operations_management: '业务管理类智能体',
    command_dashboard: '指挥看板类智能体',
    situation_replay: '态势复盘类智能体',
    timeline_replay: '态势复盘类智能体',
    'timeline-replay': '态势复盘类智能体',
    affiliation_assessment: '归属研判类智能体',
    assistant: '助手智能体',
  }

  const DATA_POLICY_LABELS = {
    live_api: '真实接口优先',
    mock_data: '演示 / Mock 数据',
    mock_then_api: '真实接口优先（失败时明确提示，不回退 Mock）',
  }

  const FIELD_LABEL_MAPS = {
    appType: APP_TYPE_LABELS,
    dataPolicy: DATA_POLICY_LABELS,
  }

  export function displayRequirementValue(field, value) {
    if (Array.isArray(value)) {
      return value.map(item => displayRequirementValue(field, item)).join('、')
    }
    if (value == null || value === '') return ''
    const raw = String(value)
    const map = FIELD_LABEL_MAPS[field]
    if (map && map[raw]) return map[raw]
    if (map) return `未识别值：${raw}`
    return raw
  }
  ```

- [ ] **Step 3: Use the mapper in requirement summaries.**

  In `ConversationWorkbench.jsx`, import `displayRequirementValue` and render:

  ```js
  const rows = [
    ['智能体类型', displayRequirementValue('appType', requirement.appType)],
    ['智能体名称', requirement.appName],
    ['核心场景', requirement.coreScenario],
    ['主视图', requirement.primaryView],
    ['数据策略', displayRequirementValue('dataPolicy', requirement.dataPolicy)],
  ].filter(([, value]) => value)
  ```

  In `ClarificationPanel.jsx`, apply the same mapper to `SummaryRow` values for
  `appType` and `dataPolicy` so older clarification surfaces do not leak raw
  enums while the conversation workbench migration is in progress.

- [ ] **Step 4: Assert rename and enum localization in the logic check.**

  The check must fail if a user-facing product string still says 应用 where it
  should say 智能体, while still allowing internal entity names in code. Add
  fixture assertions that a requirement summary with
  `appType: "operations_management"` and `dataPolicy: "live_api"` renders
  `业务管理类智能体` and `真实接口优先`, and does not render the raw enum strings.
  Add a second fixture for `mock_then_api` to verify the honest-data label
  remains explicit.

- [ ] **Step 5: Run the portal check and build.**

  `node scripts/check-conversation-agent-streaming.mjs` and `npm run build`.

## Task 6: Full Verification and Focused Review

- [ ] **Step 1: Run all deterministic gates.**

  ```bash
  cd factory-server && gofmt -w $(git diff --name-only | grep '\.go$') && go test ./...
  cd sf-portal-mvp && npm run test:logic && npm run build
  git diff --check
  ```

  Scope `gofmt -w` to touched files only (avoid reformatting concurrent
  unrelated changes).

- [ ] **Step 2: Fake-backed end-to-end smoke.**

  With fake dialogue/clarification runners and `FACTORY_FAKE_CLAUDE=1`, drive:
  a concrete first message that previously produced 确认并生成 immediately now
  yields at least one high-impact question round before ready_to_confirm; live
  thinking and analysis streams fold above each conclusion; the user message
  appears optimistically. Confirm `thinking_delta` appears only in the dedicated
  thinking channel and internal blueprint names do not appear in user-facing
  payloads.

- [ ] **Step 3: Real-CLI manual acceptance.**

  Start `factory-server` with `FACTORY_FAKE_CLAUDE` unset, then the portal.
  Drive one application-generation conversation: confirm high-impact items are
  asked as one multi-question batch per round, Claude Code CLI 思考过程 and the
  analysis work log stream live and fold above the conclusion, and only after
  all high-impact items are resolved does 确认并生成（智能体） appear. Confirm raw
  thinking is not mixed into analysis, tool, stdout/stderr, or attachment
  channels.

- [ ] **Step 4: Final diff review.**

  `git status`, `git diff --check`. Verify no collaborator-owned agent-tab UI
  changed, no unrelated scene work reverted, raw reasoning reaches only the
  dedicated 思考过程 channel, and every external resource (job, agent) is created
  only after explicit user action.

## Completion Criteria

- A sent user message appears in the conversation instantly (optimistic) and
  rolls back on failure; the history refresh no longer blocks the view load.
- A route choice appends one Chinese 路由选择回显 message, and subsequent
  recommendation / clarification / 思考过程 / 分析过程 appears beneath that choice.
- Opening a recommended reusable 智能体 appends one Chinese 智能体打开回显
  message before the resolved/open result.
- Claude Code CLI thinking and the analysis work log stream token-by-token
  beneath the triggering user action for routing, clarification, and every
  pipeline step, then fold above each conclusion; both are replayable after
  reconnect.
- A concrete first message no longer jumps to 确认并生成: high-impact decisions
  are all shown as one business-specific batch per round and the confirm action
  cannot appear while any remains open (server-enforced). Low-impact inferred
  details appear as assumptions for final review, not as required questions.
- When the user submits a clarification batch, the conversation appends one
  Chinese 澄清答案回显 message and the next round's 思考过程 / 分析过程 appears
  beneath that message in chronological order.
- 确认需求摘要 appears as the final agent message in the conversation timeline,
  and `确认并生成智能体` is attached to that message rather than a fixed bottom
  area.
- The produced product is labelled 智能体 in every user-facing surface; the
  internal entity and API stay 应用.
- Claude Code CLI `thinking` / `thinking_delta` is forwarded, displayed, and
  replayable through the dedicated 思考过程 channel only; existing user changes
  and unrelated files are preserved; all backend and portal gates pass.
