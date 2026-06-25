# Conversation Agent Streaming and Clarification Implementation Plan

> **For implementation agents:** Execute with
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Keep existing worktree changes intact; inspect
> a shared file before editing and never `reset`/`checkout` unrelated work.
> Decisions D1–D6 are locked in ADR 0006, CONTEXT.md, and the adaptive
> clarification spec; do not re-litigate them.

**Goal:** Make the conversation workbench behave like a live general-purpose
agent (Codex / Claude Code): a user message appears instantly, the agent's
analysis work log streams token-by-token beneath it, the round's conclusion
follows, and the streamed analysis folds above the conclusion. Requirement
clarification no longer jumps straight to a generate button — high-impact
decisions are surfaced one per round and must be confirmed before the
confirm-and-generate action appears. The produced product is labelled 智能体 in
every user-facing surface while the internal entity stays 应用.

**Architecture:** The backend streaming plumbing for pipeline steps already
exists (dialogue-attributed work-trace events stream token-by-token through
`dialogue.work_trace`). The frontend must (a) fold `*.delta` (routing /
clarification / business-draft rounds) and `dialogue.work_trace` (pipeline
steps) incrementally into a live analysis item in the conversation timeline,
and (b) render them folded above each conclusion. A new server-side gate makes
`ready_to_confirm` impossible while any high-impact confirmation item remains
open. A new contract field carries open high-impact items; the
`requirement-clarification` skill surfaces them one per round. Raw hidden
reasoning / `thinking_delta` remains hard-dropped at every layer (security
constraint #9, unchanged).

**Tech stack:** Go, SQLite, `net/http`, Server-Sent Events, local Claude Code
CLI, React 18, Vite, project-local Claude skills.

## Accepted Product Decisions (locked)

- **D1 — "思考过程" = 分析工作日志, streamed live, not raw chain-of-thought.**
  Hidden reasoning / `thinking_delta` is never forwarded (CONTEXT.md glossary
  + security constraint #9 unchanged). The live "thinking" feel is achieved by
  streaming the safe analysis work log.
- **D2 — Live stream covers intent routing + clarification + all six pipeline
  steps.** The conversation workbench is the primary live surface; the step
  matrix and execution drawer stay as secondary detail/overview.
- **D3 — High-impact confirmation items are non-skippable** (ADR 0006). A
  requirement cannot reach `ready_to_confirm` while any 高影响确认事项 (a
  decision that can change business meaning, data source, external interface,
  permission, deployment, or user-visible behavior) remains open, regardless of
  how detailed the first message is. Non-high-impact details may still be
  assumed adaptively; a field filled from a blueprint assumption is not a
  confirmed high-impact decision.
- **D4 — User-facing noun is 智能体; internal entity stays 应用.** (CONTEXT.md
  updated.)
- **D5 — Optimistic user-message insert + failure rollback**, and drop the
  redundant serial `refreshSessions()` before `loadView()`.
- **D6 — The streamed analysis folds above each conclusion** (Claude Code
  thinking-block style) and remains replayable from persisted events.

## Source References

- Locked decisions: `docs/adr/0006-high-impact-confirmation-non-skippable.md`,
  `CONTEXT.md` (`应用`, `高影响确认事项`, `模型分析过程`, `分析工作日志`,
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
  `analysis_stream` branch ~283-290; route card ~327-345; confirm gate ~73-83).
- Clarification contract: `factory-server/internal/clarification/contracts.go`
  (`RoundOutput` ~130-138; `Question` ~51-60; `Requirement` ~73-84).
- Ready-to-confirm convergence: `factory-server/internal/server/clarification_handlers.go`
  `runRoundAndPersist` ~949-957; `advanceAfterUserTurn` ~998-1011;
  `normalizeClarificationReadiness` ~1039; confirm gates ~674-682.
- Dialogue confirm gate: `factory-server/internal/server/dialogue_handlers.go`
  ~1628-1631.
- Pipeline step streaming (already dialogue-attributed):
  `factory-server/internal/executor/executor.go` (`newStepEmitter` ~440,
  `stepEmitter.Trace` ~229-249 drops when `dialogueID==""`), `claude_runner.go`
  `emitWorkLog` ~144-152, `internal/runner/stream.go` ~35-240 (drops
  `thinking_delta` at source), `internal/server/events.go`
  `recordAndPublishWorkTrace` ~190-199.
- Skill: `.claude/skills/requirement-clarification/SKILL.md` (no high-impact
  concept today).

## Target File Map

Create:

```text
sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs
```

Modify:

```text
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
sf-portal-mvp/src/components/ConversationWorkbench.jsx
sf-portal-mvp/src/components/ConversationWorkbench.css
sf-portal-mvp/scripts/check-dialogue-workbench.mjs
```

`check-dialogue-workbench.mjs` is extended; the new
`check-conversation-agent-streaming.mjs` owns the streaming + optimistic +
high-impact + rename assertions so the old check keeps its scope.

## Global Constraints

- Raw hidden reasoning / `thinking_delta` / chain-of-thought is NEVER forwarded
  to the frontend, SSE, or DB attachments (security constraint #9). Streaming
  only ever carries the safe analysis work log (`text_delta` content).
- Persist event-equivalent records BEFORE publishing any SSE event.
- Preserve existing user changes and unrelated files (the carrier-affiliation
  scene work, the AgentsPanel/协作智能体 tab owned by the collaborating branch).
  No `git reset` / `checkout --hard`.
- Tool I/O / API / command logs remain allowlisted, redacted, length-capped.
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

- [ ] **Step 4: Run the portal check.**

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

- [ ] **Step 5: Teach the skill to surface high-impact items one per round.**

  Update `.claude/skills/requirement-clarification/SKILL.md`: identify open
  高影响确认事项 each round; while any remain, round output returns exactly one
  of them as the blocking question (with recommendation) AND lists the rest in
  `openHighImpact`; only when `openHighImpact` is empty may it return
  `ready_to_confirm`. A blueprint-assumed field is explicitly NOT a confirmed
  high-impact decision. Output-contract example updated with `openHighImpact`.

- [ ] **Step 6: Render open high-impact items in the workbench.**

  In `dialogueTimeline.js`, map each round's blocking high-impact question to
  the existing `question_group`/`QuestionCard` path (it already supports
  recommendation badges and options), so the user answers one per round. In
  `ConversationWorkbench.jsx`, keep the 确认并生成 button gated on
  `ready_to_confirm` (already the case) — it now cannot appear while
  high-impact items are open. No new component is required.

- [ ] **Step 7: Run focused tests.**

  `go test ./internal/clarification ./internal/server` from `factory-server`;
  `node scripts/check-conversation-agent-streaming.mjs` from `sf-portal-mvp`.

## Task 3: Live analysis-process streaming in the conversation (D1, D2, D6)

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
  `dialogue.work_trace` event for a pipeline step folds into the same live
  surface; (c) on the round/step completion event the live item is replaced by
  the persisted analysis item rendered FOLDED above the conclusion; (d) the
  folded analysis is replayable from persisted state after a reload; (e) no
  `thinking_delta` / raw-reasoning field is ever read into the timeline.

- [ ] **Step 2: Add a transient live-analysis item to the timeline state.**

  In `dialogueTimeline.js` add a reducer that, for the selected dialogue, folds
  `*.delta` (route / clarification / business-draft) and `dialogue.work_trace`
  into a single transient `live_analysis` item keyed by the running turn / step.
  Delta payloads carry the full-so-far text (mirror `clarificationLogic.js:67`,
  set-not-append). The item sits in the timeline right after the optimistic /
  persisted user message. Unknown or internal metadata keys are still dropped.

- [ ] **Step 3: Stop using needsRefresh for live deltas.**

  In `applyDialogueEvent`, route `*.delta` and `dialogue.work_trace` (for the
  selected dialogue) to the incremental fold from Step 2 instead of setting
  `needsRefresh`. Keep `needsRefresh` for completion/lifecycle events
  (`*.completed`, `*.updated` that change persisted structure, route
  confirmation, ready_to_confirm) so the authoritative persisted view still
  reconciles. This removes the per-token full reload.

- [ ] **Step 4: Render the live item and fold on completion.**

  In `ConversationWorkbench.jsx`, render `live_analysis` as a streaming
  "分析过程" block (monospace, plaintext `<pre>`-safe, never
  `dangerouslySetInnerHTML`). When the persisted analysis item lands
  (post-completion reload), replace the transient block with the persisted
  analysis rendered COLLAPSED above its conclusion, with an expand control
  (D6). The step matrix and execution drawer remain as secondary detail.

- [ ] **Step 5: Inline pipeline work-trace into the conversation.**

  The pipeline already streams dialogue-attributed `dialogue.work_trace`
  (assistant text, tool use). Ensure `workTraceState` exposes the in-flight
  traces for the selected dialogue's current job/step so the conversation's live
  item shows the build phase token-by-token. On step completion, the step's
  analysis summary folds above the step result (D6). In fake mode the step is
  batch (no token stream) — it lands as a completed block; acceptable per D2.

- [ ] **Step 6: Run the portal checks and build.**

  `node scripts/check-conversation-agent-streaming.mjs`,
  `node scripts/check-dialogue-workbench.mjs`, and `npm run build` from
  `sf-portal-mvp`.

## Task 4: Surface structured pipeline workLog in the dialogue trace (D2 backend)

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/executor/executor_test.go`

- [ ] **Step 1: Write a failing executor test.**

  Assert that a structured workLog summary entry decoded from `output.json` is
  emitted as a dialogue-attributed trace (so it reaches the conversation), not
  only as a job-scoped `step_execution_records` row. Assert the trace is
  redacted/capped like every other trace, and that `thinking_delta` is still
  never emitted.

- [ ] **Step 2: Emit the workLog summary as a trace.**

  In `claude_runner.go` `emitWorkLog` (~144-152), in addition to emitting
  `ExecutionRecordSummary` records, emit the safe summary text through the
  dialogue-scoped trace emitter (the same path `stepEmitter.Trace` uses, which
  stamps `DialogueID` and drops when empty). Keep redaction/cap identical to
  `recordAndPublishWorkTrace`. Do not change job-scoped record persistence.

- [ ] **Step 3: Run focused tests.**

  `go test ./internal/executor ./internal/server` from `factory-server`.

## Task 5: User-facing 智能体 label (D4)

**Files:**
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`

- [ ] **Step 1: Rename the user-facing product strings.**

  In the workbench route card and confirm affordances, change user-facing
  product nouns to 智能体: `生成新应用` → `生成新智能体`; the route card
  subtitle `通过需求澄清生成助手应用或业务应用` → `…生成助手智能体或业务智能体`;
  frame the `确认并生成` action in 智能体 terms. Leave internal identifiers,
  API paths, and the collaborating-branch-owned `AgentsPanel` / 协作智能体 tab
  untouched. (The left 应用列表 → 业务智能体 rename is already done.)

- [ ] **Step 2: Assert the rename in the logic check.**

  The check must fail if a user-facing product string still says 应用 where it
  should say 智能体, while still allowing internal entity names in code.

- [ ] **Step 3: Run the portal check and build.**

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
  yields at least one high-impact question round before ready_to_confirm; a live
  analysis stream folds above each conclusion; the user message appears
  optimistically. Confirm no `thinking_delta` / internal blueprint name appears
  in any SSE payload.

- [ ] **Step 3: Real-CLI manual acceptance.**

  Start `factory-server` with `FACTORY_FAKE_CLAUDE` unset, then the portal.
  Drive one application-generation conversation: confirm high-impact items are
  asked one per round, the analysis work log streams live and folds above the
  conclusion, and only after all high-impact items are resolved does
  确认并生成（智能体） appear. Confirm the CLI never forwards hidden reasoning.

- [ ] **Step 4: Final diff review.**

  `git status`, `git diff --check`. Verify no collaborator-owned agent-tab UI
  changed, no unrelated scene work reverted, raw reasoning never reaches the
  frontend/SSE/DB, and every external resource (job, agent) is created only
  after explicit user action.

## Completion Criteria

- A sent user message appears in the conversation instantly (optimistic) and
  rolls back on failure; the history refresh no longer blocks the view load.
- The analysis work log streams token-by-token beneath the user message for
  routing, clarification, and every pipeline step, then folds above each
  conclusion; it is replayable after reconnect.
- A concrete first message no longer jumps to 确认并生成: high-impact decisions
  are asked one per round and the confirm action cannot appear while any remains
  open (server-enforced).
- The produced product is labelled 智能体 in every user-facing surface; the
  internal entity and API stay 应用.
- Raw hidden reasoning / `thinking_delta` is never forwarded at any layer;
  existing user changes and unrelated files are preserved; all backend and
  portal gates pass.
