# Task Thinking Persistence and Streaming Design

Date: 2026-06-28

## Context

Phase 3 introduced task execution blocks in the conversation timeline. The remaining requirement is to show each generation-task agent's raw `thinking_delta` as **任务思考过程** in the matching task execution block, while keeping the security boundary recorded in ADR 0009:

- do not store task thinking in `work_trace_events`;
- do not store task thinking in `step_execution_records`;
- persist task thinking in a dedicated task-attributed event stream;
- support history replay and SSE gap recovery;
- redact credentials and cap bytes before persistence and publication;
- do not summarize, translate, or semantically rewrite provider thinking.

This design implements the full end-to-end path: backend persistence, executor capture, REST hydration, SSE streaming, and frontend task-block rendering.

## Goals

1. Persist raw task-agent thinking deltas for replay.
2. Stream live task thinking into the conversation timeline while a task step runs.
3. Attach thinking to the correct `task_execution_block` by `dialogueId`, `taskId`, `stepId`, `attempt`, and `agentKey`.
4. Keep task thinking out of work trace, execution records, audit/export surfaces, and ordinary dialogue messages.
5. Preserve existing work-trace and execution-record security tests.

## Non-goals

- No audit/export support for task thinking.
- No summarization or translation of task thinking.
- No storage of task thinking in `work_trace_events` or `step_execution_records`.
- No UI for editing or deleting individual thinking events.
- No cross-dialogue transfer of task thinking.

## Backend data model

Add a dedicated table `task_thinking_events`:

```sql
CREATE TABLE IF NOT EXISTS task_thinking_events (
  id                TEXT PRIMARY KEY,
  dialogue_id       TEXT NOT NULL,
  task_id           TEXT NOT NULL DEFAULT '',
  step_id           TEXT NOT NULL DEFAULT '',
  attempt           INTEGER NOT NULL DEFAULT 0,
  agent_key         TEXT NOT NULL DEFAULT '',
  dialogue_sequence INTEGER NOT NULL,
  step_sequence     INTEGER NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  redacted          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  UNIQUE(dialogue_id, dialogue_sequence),
  UNIQUE(task_id, step_id, attempt, step_sequence)
);

CREATE INDEX IF NOT EXISTS idx_task_thinking_replay
ON task_thinking_events(dialogue_id, dialogue_sequence);

CREATE INDEX IF NOT EXISTS idx_task_thinking_step
ON task_thinking_events(task_id, step_id, attempt, step_sequence);
```

Model shape:

```go
type TaskThinkingEvent struct {
  ID               string    `json:"id"`
  DialogueID       string    `json:"dialogue_id"`
  TaskID           string    `json:"task_id,omitempty"`
  StepID           string    `json:"step_id,omitempty"`
  Attempt          int       `json:"attempt,omitempty"`
  AgentKey         string    `json:"agent_key,omitempty"`
  DialogueSequence int64     `json:"dialogue_sequence"`
  StepSequence     int       `json:"step_sequence"`
  Content          string    `json:"content"`
  Redacted         bool      `json:"redacted"`
  CreatedAt        time.Time `json:"created_at"`
}
```

Sequence allocation:

- `dialogue_sequence = MAX(dialogue_sequence)+1` per dialogue inside one store transaction.
- `step_sequence = MAX(step_sequence)+1` per `(task_id, step_id, attempt)` inside the same transaction.
- The existing SQLite pool is single-connection, and uniqueness constraints fail closed on collisions.

## Backend store

Add `internal/store/task_thinking.go` with:

- `AppendTaskThinking(ctx, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error)`
- `ListTaskThinking(ctx, dialogueID string, afterDialogueSequence int64, limit int) ([]model.TaskThinkingEvent, error)`
- `DeleteTaskThinkingByDialogue(ctx, dialogueID string) error`

`AppendTaskThinking` must:

1. reject missing `dialogue_id`;
2. allocate both sequences;
3. redact/cap `Content` before insert;
4. set `Redacted` when content changed by redaction or truncation;
5. return the persisted row.

Byte cap:

- cap a single thinking delta at 8 KiB, matching work trace's defensive payload cap.
- append `…[truncated]` when truncated.

Credential redaction:

- reuse the same credential text redaction behavior used by execution records (`redactExecutionText`) or move a shared redaction helper into a package both executor/store can use.
- Redact before persistence and before publication.

## Backend server API and SSE

Add REST hydration:

```http
GET /api/dialogues/:id/task-thinking?afterSequence=N
```

Response:

```json
{
  "events": [TaskThinkingEvent...]
}
```

Add SSE stream:

```http
GET /api/dialogues/:id/task-thinking/stream?afterSequence=N
```

Behavior mirrors `dialogue.work_trace` stream:

1. hydrate from `afterSequence` first;
2. then subscribe to hub events;
3. only forward events matching the selected `dialogue_id`;
4. set SSE `id:` to `dialogue_sequence`;
5. publish event type `task.thinking.appended`.

Hub event:

```go
Event{Type: "task.thinking.appended", Data: persistedTaskThinkingEvent}
```

Security invariant:

- SSE forwarder only publishes events that were persisted by the store.
- No unpersisted raw provider thinking may be forwarded.

## Executor and runner capture

Current task runner code intentionally drops thinking from execution records and work traces. Keep that behavior.

Add a new dedicated emitter path:

```go
type TaskThinkingEmitter interface {
  Think(ctx context.Context, content string) error
}
```

or extend the existing step emitter with a dedicated method:

```go
func (s *stepEmitter) Think(ctx context.Context, content string) error
```

`stepEmitter.Think` stamps:

- `dialogue_id` from job;
- `task_id` from job id;
- `step_id` from current step;
- `attempt` from current attempt;
- `agent_key` from current step;
- raw thinking delta content after redaction/cap in the store.

Runner parsing changes:

- Keep `thinking` / `thinking_delta` ignored for execution records and work trace.
- When a thinking delta is seen and a `TaskThinkingEmitter` exists, call `Think(ctx, delta)`.
- Text/tool/workLog paths remain unchanged.

This keeps the previous hard security tests valid: thinking still never reaches records or work trace.

## Frontend API and event plumbing

Add API methods in `sf-portal-mvp/src/api/client.js`:

```js
getDialogueTaskThinking(dialogueId, afterSequence = 0)
```

Add SSE helper in `sf-portal-mvp/src/api/events.js`:

```js
subscribeDialogueTaskThinking(dialogueId, { afterSequence, getDialogueTaskThinking, onEvent, onError })
```

Behavior mirrors `subscribeDialogueTrace`:

- REST hydrate first;
- dedupe by `dialogue_sequence`;
- maintain cursor;
- recover gaps using `afterSequence`.

## Frontend state and timeline integration

Add a pure reducer, likely `src/hooks/taskThinkingState.js`:

```js
initialTaskThinkingState(dialogueId)
normalizeTaskThinkingEvent(raw)
applyTaskThinkingEvent(state, event)
applyTaskThinkingEvents(state, events)
resetTaskThinkingState(dialogueId)
buildThinkingByStepAttempt(items)
```

State shape:

```js
{
  selectedDialogueId,
  highestSequence,
  items: [
    {
      id,
      dialogueId,
      taskId,
      stepId,
      attempt,
      agentKey,
      dialogueSequence,
      stepSequence,
      content,
      redacted,
      createdAt,
    }
  ]
}
```

`useDialogueSessions` additions:

- maintain `taskThinking` state scoped to selected dialogue;
- subscribe to `subscribeDialogueTaskThinking` when selected dialogue changes;
- reset on session switch;
- pass `taskThinking.items` into `buildDialogueTimeline`.

`buildDialogueTimeline` additions:

- accept an eighth param `taskThinkingItems = []`;
- group task thinking by `taskId/stepId/attempt`;
- attach joined content to matching `task_execution_block.taskThinking`;
- do not create a standalone timeline item for task thinking.

`TaskExecutionBlock` UI:

- restore the `任务思考过程` section when `item.taskThinking` is non-empty;
- show redaction indicator when any source event had `redacted: true`;
- keep folded/expanded behavior unchanged.

## Deletion, archive, and export behavior

- Dialogue archive: no deletion; task thinking remains replayable.
- Dialogue deletion: remove `task_thinking_events` for that `dialogue_id` with dialogue messages and work trace cleanup.
- Audit/export: no inclusion in current export surfaces.

## Error handling

Backend:

- Store append errors are captured as emitter first error if this should fail the step, or logged best-effort if product chooses non-blocking thinking persistence. Recommended: **best-effort but fail closed for publication**. A task can finish even if thinking persistence fails, because thinking is UI/replay metadata, not the execution contract.
- Invalid/missing dialogue id: drop thinking event, matching current work-trace behavior for legacy jobs.

Frontend:

- Task thinking SSE errors trigger best-effort resync.
- Missing task thinking does not block task execution blocks.
- Redacted/capped content displays as-is with a redaction note.

## Testing

Backend store tests:

- append allocates dialogue and step sequences;
- list by dialogue after sequence returns ascending events;
- content redaction/cap sets `redacted`;
- dialogue deletion removes task thinking.

Backend runner/executor tests:

- thinking delta reaches `TaskThinkingEmitter`;
- thinking delta still does not reach execution records;
- thinking delta still does not reach work trace;
- emitted event carries task/step/attempt/agent attribution.

Backend server tests:

- REST hydration returns persisted events after cursor;
- SSE publishes only persisted matching-dialogue task thinking events;
- non-matching dialogue event is ignored.

Frontend logic tests:

- task thinking reducer orders/dedupes by `dialogueSequence`;
- buildDialogueTimeline attaches thinking to the matching task block;
- no matching block means thinking is not rendered elsewhere;
- redaction flag propagates to task block;
- existing `live_thinking` round behavior still works.

Verification commands:

```bash
cd factory-server
go test ./internal/store ./internal/server ./internal/executor ./internal/runner

cd ../sf-portal-mvp
npm run test:logic
npm run build

cd ..
git diff --check
```

## Rollout plan

1. Add model/store/schema and tests.
2. Add server REST/SSE and tests.
3. Add executor/runner thinking capture and tests.
4. Add frontend API/SSE/reducer and tests.
5. Attach thinking to task execution blocks and restore the UI section.
6. Run full backend/frontend verification.

## Open decisions resolved

- Use a dedicated store and stream, not work trace.
- Live UI uses the same persisted event path; no unpersisted thinking is forwarded.
- Thinking persistence is best-effort for task success, but publication is persist-before-publish only.
- Task thinking remains excluded from export/audit.
