# Generation Task Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generation-task step observable through durable execution records, safe live SSE updates, inspectable artifacts, six status cards, and a right-side detail drawer.

**Architecture:** Persist append-only, bounded `StepExecutionRecord` chunks keyed by `(step_id, attempt, sequence)` and retain sanitized audit artifacts under the existing `.factory-runs` root. The executor emits lifecycle records and passes a scoped reporter into the Claude and factory runners; the server persists records and publishes them over SSE. The portal hydrates task summaries and artifacts from REST before applying SSE deltas, detects dropped SSE sequence numbers, and pages detailed records only for the selected step attempt.

**Tech Stack:** Go 1.21, SQLite (`modernc.org/sqlite`), existing SSE Hub, Claude Code CLI stream-json, Podman/npm command runners, React 18, Vite 6, Lucide React, Node assertion scripts.

**Constraints:** Do not expose model hidden reasoning. Render all artifacts as text, never HTML. Keep the six fixed pipeline steps. Do not make git commits in this plan because the worktree contains unrelated changes.

---

## File Map

| Path | Responsibility |
| --- | --- |
| `factory-server/internal/model/model.go` | Execution-record types and JSON contract. |
| `factory-server/internal/store/schema.sql` | Durable `step_execution_records` table and lookup index. |
| `factory-server/internal/store/execution_records.go` | Append execution records, return latest-per-step summaries, and page records by step attempt. |
| `factory-server/internal/executor/execution_records.go` | Scoped reporter, secret redaction, 10 MiB capped artifact write, artifact registration. |
| `factory-server/internal/executor/executor.go` | Step lifecycle records and reporter delivery to runners. |
| `factory-server/internal/executor/claude_runner.go` | Safe Claude stream events, explicit public work-log contract, artifact capture. |
| `factory-server/internal/runner/execution_records.go` | Package-neutral reporter interface used by executor and Claude runner. |
| `factory-server/internal/runner/contracts.go` | Decodes the explicit public `workLog` output field without accepting hidden reasoning. |
| `factory-server/internal/executor/factory_steps.go` | Real npm/podman stdout/stderr streaming and artifact capture. |
| `factory-server/internal/deploy/podman.go` | Optional streamed stdout/stderr command adapter for Podman operations. |
| `factory-server/internal/server/job_handlers.go` | Per-step execution summaries and paged record endpoints. |
| `factory-server/internal/server/events.go` | `step.record.appended` SSE publisher. |
| `factory-server/internal/server/server.go` | Record callback wiring and new route. |
| `sf-portal-mvp/src/api/client.js` | Record/artifact REST and text-content clients. |
| `sf-portal-mvp/src/api/events.js` | `step.record.appended` subscription. |
| `sf-portal-mvp/src/hooks/useJobs.js` | Summary hydration, SSE-gap resync, selected-step and unread state. |
| `sf-portal-mvp/src/hooks/executionRecordState.js` | Pure grouping, ordering, unread, and attempt-selection functions. |
| `sf-portal-mvp/src/components/JobCenter.jsx` | 3 x 2 task-card matrix and drawer integration. |
| `sf-portal-mvp/src/components/StepCard.jsx` | Compact, accessible single-step card. |
| `sf-portal-mvp/src/components/StepExecutionDrawer.jsx` | Right drawer with overview, record, and artifact/audit tabs. |
| `sf-portal-mvp/src/components/JobCenter.css` | Matrix, status states, and drawer styling. |
| `sf-portal-mvp/scripts/check-execution-record-state.mjs` | Frontend state regression harness. |
| `sf-portal-mvp/scripts/check-task-observability-layout.mjs` | Static layout/interaction regression harness. |
| `docs/software-factory-local-runbook.md` | Operator instructions for records, artifacts, truncation, and retry inspection. |

### Task 1: Persist Step Execution Records

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Create: `factory-server/internal/store/execution_records.go`
- Create: `factory-server/internal/store/execution_records_test.go`
- Modify: `factory-server/internal/store/store_test.go`

- [ ] **Step 1: Write failing store tests for ordering, attempt isolation, and job isolation.**

```go
func TestStepExecutionSummaryAndPageAreAttemptScoped(t *testing.T) {
    st := newTestStore(t)
    appendRecord(t, st, "job_1", "step_1", 2, 2, "command_stdout", "second")
    appendRecord(t, st, "job_1", "step_1", 1, 1, "system", "started")
    appendRecord(t, st, "job_2", "step_2", 1, 1, "system", "other job")

    got, err := st.ListStepExecutionRecordPage(context.Background(), "job_1", "step_1", 1, 0, 200)
    if err != nil { t.Fatal(err) }
    if len(got) != 1 || got[0].Attempt != 1 || got[0].Sequence != 1 {
        t.Fatalf("records = %#v", got)
    }
    summaries, _ := st.ListStepExecutionSummaries(context.Background(), "job_1")
    if len(summaries) != 1 || summaries[0].LatestAttempt != 2 || summaries[0].LatestRecord.Content != "second" {
        t.Fatalf("summaries = %#v", summaries)
    }
}
```

- [ ] **Step 2: Run the new test and verify it fails because the model/store API does not exist.**

Run: `cd factory-server && go test ./internal/store -run TestStepExecutionSummaryAndPageAreAttemptScoped -count=1`

Expected: compile failure for `StepExecutionRecord`, `AppendStepExecutionRecord`, or `ListStepExecutionRecordPage`.

- [ ] **Step 3: Define the immutable record contract and SQLite schema.**

Add the following model types and table. `sequence` is per `(step_id, attempt)` and is assigned by the executor-side reporter, not by the browser.

```go
type ExecutionRecordKind string

const (
    ExecutionRecordSystem        ExecutionRecordKind = "system"
    ExecutionRecordActivity      ExecutionRecordKind = "activity"
    ExecutionRecordSummary       ExecutionRecordKind = "summary"
    ExecutionRecordCommandStdout ExecutionRecordKind = "command_stdout"
    ExecutionRecordCommandStderr ExecutionRecordKind = "command_stderr"
    ExecutionRecordError         ExecutionRecordKind = "error"
)

type StepExecutionRecord struct {
    ID        string              `json:"id"`
    JobID     string              `json:"job_id"`
    StepID    string              `json:"step_id"`
    Attempt   int                 `json:"attempt"`
    Sequence  int                 `json:"sequence"`
    Kind      ExecutionRecordKind `json:"kind"`
    Content   string              `json:"content"`
    Truncated bool                `json:"truncated"`
    CreatedAt time.Time           `json:"created_at"`
}

type StepExecutionSummary struct {
    StepID        string               `json:"step_id"`
    LatestAttempt int                  `json:"latest_attempt"`
    LatestRecord  *StepExecutionRecord `json:"latest_record,omitempty"`
}
```

```sql
CREATE TABLE IF NOT EXISTS step_execution_records (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    truncated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(step_id, attempt, sequence)
);
CREATE INDEX IF NOT EXISTS idx_step_execution_records_job
ON step_execution_records(job_id, step_id, attempt, sequence);
```

Implement `AppendStepExecutionRecord(ctx, record)`, `ListStepExecutionSummaries(ctx, jobID)`, and `ListStepExecutionRecordPage(ctx, jobID, stepID, attempt, beforeSequence, limit)`. Cap `limit` at 200 and return records in ascending sequence order, even when the SQL query selects newest-first for pagination. Add a migration smoke test opening an existing temporary database before re-opening it with the updated schema. Add `ErrorExecutionRecordPersistenceFailed` to the model error codes so failed audit persistence is visible rather than silently ignored.

- [ ] **Step 4: Re-run the focused store tests.**

Run: `cd factory-server && go test ./internal/store -run 'Test(ListStepExecution|Open)' -count=1`

Expected: PASS.

### Task 2: Add Safe, Bounded Artifact Capture

**Files:**
- Create: `factory-server/internal/executor/execution_records.go`
- Create: `factory-server/internal/executor/execution_records_test.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/executor/factory_steps.go`
- Modify: `factory-server/internal/executor/claude_runner_test.go`
- Modify: `factory-server/internal/executor/factory_steps_test.go`

- [ ] **Step 1: Write failing tests for redaction and 10 MiB tail retention.**

```go
func TestRedactExecutionTextMasksCredentials(t *testing.T) {
    got := redactExecutionText("ANTHROPIC_API_KEY=secret Authorization: Bearer abc")
    if strings.Contains(got, "secret") || strings.Contains(got, "abc") {
        t.Fatalf("credential leaked: %q", got)
    }
    if !strings.Contains(got, "[REDACTED]") { t.Fatalf("got %q", got) }
}

func TestWriteCappedArtifactKeepsNewestBytes(t *testing.T) {
    path := filepath.Join(t.TempDir(), "stdout.log")
    result, err := writeCappedArtifact(path, []byte(strings.Repeat("a", maxTextArtifactBytes)+"tail"))
    if err != nil { t.Fatal(err) }
    raw, _ := os.ReadFile(path)
    if !result.Truncated || !bytes.Contains(raw, []byte("tail")) { t.Fatalf("result=%+v", result) }
}
```

- [ ] **Step 2: Run these tests and verify they fail because the helpers do not exist.**

Run: `cd factory-server && go test ./internal/executor -run 'Test(RedactExecutionText|WriteCappedArtifactKeepsNewestBytes)' -count=1`

Expected: compile failure for `redactExecutionText`, `writeCappedArtifact`, and `maxTextArtifactBytes`.

- [ ] **Step 3: Implement the shared execution-record helper.**

Create `execution_records.go` with:

```go
const maxTextArtifactBytes int64 = 10 * 1024 * 1024

func redactExecutionText(text string) string
func writeCappedArtifact(path string, content []byte) (artifactWriteResult, error)
func (r *artifactRegistrar) register(ctx context.Context, kind, path, summary string) error
```

`redactExecutionText` must mask values for case-insensitive `api_key`, `token`, `secret`, `password`, and `authorization` key/value or header forms. `writeCappedArtifact` must write UTF-8-safe tail content prefixed with `[TRUNCATED: retained latest 10485760 bytes]` when the cap is exceeded.

Keep operational `input.json`, `prompt.md`, and `output.json` intact because Claude execution and output validation depend on their exact bytes. Create separate redacted audit copies under `attempt-N/audit/` and register only those copies as `input_json`, `prompt_markdown`, and `output_json` artifacts. Command `stdout.log` and `stderr.log` are audit-only and may be written directly as redacted capped files. Never register a raw operational input/output file through the artifact-content API.

- [ ] **Step 4: Re-run helper and existing executor tests.**

Run: `cd factory-server && go test ./internal/executor -count=1`

Expected: PASS, including existing code-generation and factory-step tests.

### Task 3: Emit Durable Lifecycle, Claude, and Command Records

**Files:**
- Modify: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/executor/executor_test.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/runner/claude.go`
- Create: `factory-server/internal/runner/execution_records.go`
- Modify: `factory-server/internal/runner/contracts.go`
- Modify: `factory-server/internal/runner/claude_test.go`
- Modify: `factory-server/internal/runner/contracts_test.go`
- Modify: `factory-server/internal/executor/factory_steps.go`
- Modify: `factory-server/internal/deploy/podman.go`
- Modify: `factory-server/internal/deploy/podman_test.go`
- Modify: `factory-server/internal/executor/fake_claude.go`

- [ ] **Step 1: Write failing executor tests for append-only lifecycle records.**

```go
func TestExecutorWritesStartedAndFinishedRecords(t *testing.T) {
    e, st := newExecutorForTest(t, &fakeRunner{byKind: map[model.StepKind]StepResult{
        model.StepRequirementAnalysis: {Status: model.StepStatusSucceeded},
    }})
    job := createQueuedJob(t, st)
    if err := e.RunOnce(context.Background()); err != nil { t.Fatal(err) }
    steps, _ := st.ListJobSteps(context.Background(), job.ID)
    records, _ := st.ListStepExecutionRecordPage(context.Background(), job.ID, steps[0].ID, 1, 0, 200)
    if len(records) < 2 || records[0].Kind != model.ExecutionRecordSystem || records[len(records)-1].Content != "步骤已完成" {
        t.Fatalf("records = %#v", records)
    }
}
```

- [ ] **Step 2: Run the test and verify it fails because `Executor` has no record emission path.**

Run: `cd factory-server && go test ./internal/executor -run TestExecutorWritesStartedAndFinishedRecords -count=1`

Expected: assertion failure or missing execution-record persistence integration.

- [ ] **Step 3: Add a reporter to the execution contract.**

Extend the runner contract so every step receives a scoped reporter while the executor remains the only component assigning job/step/attempt/sequence and persisting records. Define the reporter in `internal/runner` (which already imports `model`), not `executor`, so `runner.ClaudeRunner` can use it without an import cycle:

```go
type StepRunner interface {
    Run(context.Context, model.Job, model.JobStep, runner.StepRecordEmitter) (StepResult, error)
}

type StepRecordEmitter interface {
    Emit(context.Context, model.ExecutionRecordKind, string) error
}

type ExecutionRecordUpdate struct {
    Record model.StepExecutionRecord
}

type Executor struct {
    // existing fields
    OnRecord func(context.Context, ExecutionRecordUpdate)
}
```

Emit `system` records for started, completed, failed, waiting for input, canceled, and retry. The record callback runs only after a successful store append. Update dispatcher, fake runners, and all test fakes to forward the reporter rather than duplicating persistence logic.

Implement the executor-side emitter with a mutex so concurrent stdout/stderr callbacks cannot duplicate or reorder `(attempt, sequence)`. It stores the first append error; after the child process exits, the runner returns that error and the executor marks the step with `execution_record_persistence_failed` rather than claiming a fully auditable success.

- [ ] **Step 4: Stream safe Claude and command activity.**

Add optional `RunStreamWithInput` support to `deploy.OSRunner` and `claudeCommandAdapter`. For Claude stages, invoke:

```text
claude --print --output-format stream-json --include-partial-messages --verbose ...
```

Parse only safe events:

- `tool_use` Read/Grep/Glob/Edit/Write becomes an `activity` record with a redacted relative path.
- Explicit public `workLog` entries in the final output contract become `summary` records.
- `thinking` and all hidden-reasoning fields are ignored.

Extend the three stage-output decoders with a narrow public field such as `workLog: [{"content":"..."}]`. Reject neither unknown fields nor an absent `workLog`, but never map `thinking`, `reasoning`, or provider-specific hidden fields into records. Add contract tests with both a valid `workLog` and a `thinking` field to lock this boundary.

For npm and Podman, add an enhanced stream runner that accepts both stdout and stderr callbacks and uses a 10 MiB UTF-8-safe tail buffer instead of unbounded `bytes.Buffer` accumulation. Batch adjacent output lines into records no larger than 4 KiB or older than 100 ms, emit `command_stdout`/`command_stderr` chunks, then store the capped final artifacts. Preserve the existing `CommandResult` exit-code behavior and error-code mapping.

- [ ] **Step 5: Add failing then passing runner tests for stream policy.**

Use a fake stream line sequence containing one tool-use event, one `thinking_delta`, one public `workLog`, and one stderr line. Assert that tool activity, public summary, and stderr appear; assert that the hidden value never appears. Add a Podman test that verifies stderr is forwarded as a record and an artifact is still written on a non-zero command exit.

Run: `cd factory-server && go test ./internal/executor ./internal/runner ./internal/deploy -count=1`

Expected: PASS.

### Task 4: Expose Snapshots and SSE Deltas

**Files:**
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/server/events.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Modify: `factory-server/internal/server/job_handlers_test.go`
- Modify: `factory-server/internal/server/server_test.go`

- [ ] **Step 1: Write failing HTTP tests for summaries, record pages, and SSE publishing.**

```go
func TestStepExecutionRecordPageReturnsOnlyRequestedStepAttempt(t *testing.T) {
    _, r, st := newJobsTestServer(t, config.Config{})
    appendRecord(t, st, "job_a", "step_a", 1, 1, "system", "started")
    appendRecord(t, st, "job_a", "step_a", 2, 1, "system", "retried")
    rec := doJSON(t, r, http.MethodGet, "/api/jobs/job_a/steps/step_a/execution-records?attempt=1&limit=200", nil)
    if rec.Code != http.StatusOK { t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String()) }
    var got []model.StepExecutionRecord
    _ = json.NewDecoder(rec.Body).Decode(&got)
    if len(got) != 1 || got[0].Attempt != 1 { t.Fatalf("got=%#v", got) }
}
```

Create a Hub subscriber, invoke the server record callback with a stored record, and assert the emitted event type is `step.record.appended` with the record as its `data` payload.

- [ ] **Step 2: Run the HTTP tests and verify they fail with 404 or missing publisher wiring.**

Run: `cd factory-server && go test ./internal/server -run 'Test(StepExecutionRecordPage|StepExecutionSummary|StepRecordEvent)' -count=1`

Expected: FAIL because the route and publisher do not yet exist.

- [ ] **Step 3: Implement the snapshot and delta contract.**

Register `GET /api/jobs/:id/execution-summary` for six-card hydration and `GET /api/jobs/:id/steps/:stepID/execution-records?attempt=N&before_sequence=N&limit=N` for drawer pagination. Both endpoints verify that the job and step exist and that the step belongs to the requested job. Wire `Executor.OnRecord` in `server.New` to publish:

```go
s.hub.Publish(Event{Type: "step.record.appended", Data: record})
```

Keep `GET /api/jobs/:id/artifacts` and `GET /api/artifacts/:id/content` as the artifact snapshot/read APIs. Refresh artifacts after `step.updated` and when a record stream reaches a terminal lifecycle event. Do not publish file content in SSE.

- [ ] **Step 4: Verify transport and security contracts.**

Run: `cd factory-server && go test ./internal/server ./internal/store -count=1`

Expected: PASS. Confirm artifact-content tests still reject path traversal and outside-root paths.

### Task 5: Add Portal State for Snapshots, Attempts, and Unread Records

**Files:**
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/api/events.js`
- Modify: `sf-portal-mvp/src/hooks/useJobs.js`
- Create: `sf-portal-mvp/src/hooks/executionRecordState.js`
- Create: `sf-portal-mvp/scripts/check-execution-record-state.mjs`
- Modify: `sf-portal-mvp/package.json`

- [ ] **Step 1: Write the pure frontend state harness.**

```js
import { appendExecutionRecord, recordsForAttempt, unreadCountForStep } from '../src/hooks/executionRecordState.js'

let state = []
state = appendExecutionRecord(state, { id: 'r2', step_id: 's1', attempt: 2, sequence: 2, content: 'two' })
state = appendExecutionRecord(state, { id: 'r1', step_id: 's1', attempt: 2, sequence: 1, content: 'one' })
state = appendExecutionRecord(state, { id: 'r1', step_id: 's1', attempt: 2, sequence: 1, content: 'duplicate' })
assert.deepEqual(recordsForAttempt(state, 's1', 2).map(r => r.id), ['r1', 'r2'])
assert.equal(unreadCountForStep(state, 's1', 2, 1), 1)
```

- [ ] **Step 2: Run the harness and verify it fails because the state helpers do not exist.**

Run: `cd sf-portal-mvp && node scripts/check-execution-record-state.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement REST hydration and SSE merging.**

Add these client methods:

```js
getJobExecutionSummary: id => request(`/api/jobs/${id}/execution-summary`),
getStepExecutionRecords: (jobId, stepId, attempt, beforeSequence) =>
  request(`/api/jobs/${jobId}/steps/${stepId}/execution-records?attempt=${attempt}&before_sequence=${beforeSequence || ''}&limit=200`),
getJobArtifacts: id => request(`/api/jobs/${id}/artifacts`),
getArtifactContent: async id => requestText(`/api/artifacts/${id}/content`),
```

`requestText` must use `response.text()` and retain the same typed error fields as `request`. Extend `subscribeFactoryEvents(onEvent, { onError } = {})` without breaking existing one-argument callers. Subscribe to `step.record.appended`; on task selection or refresh, fetch steps, summaries, and artifacts together with `Promise.all`; fetch detailed pages only when the drawer opens. Merge a delta by `record.id`; never append duplicates. Track the SSE envelope `seq`; a gap, `onError`, or a visibility-restoration event schedules a debounced snapshot refresh. Keep selection and unread state local to the selected task view so a new active step increments its card unread count without replacing the selected card.

- [ ] **Step 4: Update `test:logic` and verify frontend state behavior.**

Append `node scripts/check-execution-record-state.mjs` to `test:logic`.

Run: `cd sf-portal-mvp && npm run test:logic`

Expected: PASS.

### Task 6: Render Six Cards and the Step Execution Drawer

**Files:**
- Modify: `sf-portal-mvp/src/App.jsx`
- Modify: `sf-portal-mvp/src/components/JobCenter.jsx`
- Create: `sf-portal-mvp/src/components/StepCard.jsx`
- Create: `sf-portal-mvp/src/components/StepExecutionDrawer.jsx`
- Modify: `sf-portal-mvp/src/components/JobCenter.css`
- Create: `sf-portal-mvp/scripts/check-task-observability-layout.mjs`
- Modify: `sf-portal-mvp/package.json`

- [ ] **Step 1: Write failing static layout assertions.**

Assert all of the following from source/CSS:

```js
assert.match(jobCenterCss, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
assert.match(jobCenterJsx, /<StepCard/)
assert.match(jobCenterJsx, /<StepExecutionDrawer/)
assert.match(drawerJsx, /概览/)
assert.match(drawerJsx, /执行记录/)
assert.match(drawerJsx, /产物与审计/)
assert.match(drawerJsx, /自动跟随/)
assert.match(drawerJsx, /高级审计/)
```

- [ ] **Step 2: Run the layout harness and verify it fails before UI implementation.**

Run: `cd sf-portal-mvp && node scripts/check-task-observability-layout.mjs`

Expected: assertion failure because the current task area is a vertical `jc-step` list.

- [ ] **Step 3: Implement `StepCard`.**

Render exactly one fixed stage with Lucide status icon, stage name, agent key/role, status, duration, latest-summary excerpt, attempt label, and unread badge. Use a `<button>` with `aria-pressed` and `aria-label`; do not use a text-filled rounded control where an icon button is sufficient. Preserve the existing color mapping but include text labels so color is not the only signal.

- [ ] **Step 4: Implement `StepExecutionDrawer`.**

Use a fixed right-side `aside` with a close icon button, selected-step heading, attempt selector, and tabs. The overview tab exposes cancel only for the current running step and retry only for the latest current failed step. The record tab loads the newest 200 records, supports loading older pages with `before_sequence`, and uses a scroll ref: follow new entries only while the viewport is at bottom; otherwise show a `N 条新记录` button. The artifact tab lists registered artifacts and loads content only after the user selects one. Render every content string in `<pre>` or text nodes, never `dangerouslySetInnerHTML`. Keep advanced audit collapsed with `<details>`.

- [ ] **Step 5: Replace the vertical task list with the 3 x 2 matrix.**

Keep the task header, global state, failure banner, and completed application link. Pass `records`, `artifacts`, selected-step state, and retry/cancel handlers from `App.jsx` through `JobCenter`. Do not change the height allocations for `ClarificationPanel` or `ChatDialog`; the drawer overlays the right side instead of consuming center-column space.

- [ ] **Step 6: Re-run logic, build, and visual checks.**

Run:

```bash
cd sf-portal-mvp
npm run test:logic
npm run build
```

Expected: both commands PASS. Manually verify at `http://localhost:3001` that six cards fit in the task area, the drawer does not resize the clarification/chat regions, and a long record scrolls without overlap.

### Task 7: Document Operations and Run the Cross-Service Gate

**Files:**
- Modify: `docs/software-factory-local-runbook.md`
- Modify: `docs/software-factory-task-observability-design.md`
- Test: `factory-server/internal/...`
- Test: `sf-portal-mvp/scripts/...`

- [ ] **Step 1: Update operator documentation.**

Add the execution-record endpoint, artifact-content endpoint, 10 MiB tail-retention behavior, redaction rule, retry-history behavior, and the distinction between public summaries and hidden reasoning. Document that a browser reload rehydrates REST snapshots before SSE updates.

- [ ] **Step 2: Add a design-to-implementation traceability section.**

In `software-factory-task-observability-design.md`, list the implemented record kinds (`system`, `activity`, `summary`, `command_stdout`, `command_stderr`, `error`), REST endpoints, and SSE event type without changing the approved user-experience decisions.

- [ ] **Step 3: Run the full verification gate.**

Run:

```bash
cd factory-server && gofmt -w internal cmd && go test ./... && go vet ./... && go build -o bin/factory-server ./cmd/factory-server
cd ../sf-portal-mvp && npm run test:logic && npm run build
cd .. && git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Perform an end-to-end local observation.**

Start the three services using the documented runbook. Create a confirmed generation task, observe at least one Claude stage and one command stage live, refresh the portal mid-stage, inspect a completed/failed artifact, retry one failed stage when available, and confirm that raw hidden-reasoning content and credential-shaped values are absent from the drawer.

## Plan Self-Review

- [x] All approved design requirements map to tasks: six cards, drawer tabs, attempts, unread/follow behavior, snapshots/SSE, artifacts, 10 MiB cap, redaction, and action constraints.
- [x] The plan keeps existing path-traversal protection and does not weaken artifact-content serving.
- [x] Every behavior change has a focused test before implementation and a concrete command for red/green verification.
- [x] No task relies on fake percent progress or hidden model reasoning.
