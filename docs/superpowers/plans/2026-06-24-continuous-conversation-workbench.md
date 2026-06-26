# Continuous Conversation Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make one dialogue a continuing workbench for one versioned application, with concurrent independent generation and durable visible work traces.

**Architecture:** Dialogue owns one application lineage. Jobs create ordered versions and a bounded scheduler runs independent applications concurrently. Work-trace events persist before scoped SSE publishes them; REST replay restores the selected workbench after reconnect.

**Tech Stack:** Go, net/http, SQLite, React 18, Vite, EventSource, Claude stream-json, Podman/Docker.

---

## File structure

- Domain and migrations: factory-server/internal/model/model.go, internal/store/schema.sql, internal/store/store.go.
- New stores: internal/store/application_versions.go, dialogue_turns.go, work_traces.go.
- API and streaming: internal/server/dialogue_handlers.go, events.go, server.go.
- Execution/deployment: internal/executor/executor.go, factory_steps.go, claude_runner.go, internal/store/jobs.go, deployments.go.
- Portal: sf-portal-mvp/src/api/client.js, api/events.js, hooks/useDialogueSessions.js, hooks/useJobs.js, hooks/dialogueTimeline.js, new hooks/workTraceState.js, components/ConversationWorkbench.jsx and JobCenter.jsx.

### Task 1: Add lineage and version persistence

**Files:**

- Modify: factory-server/internal/model/model.go
- Modify: factory-server/internal/store/schema.sql
- Modify: factory-server/internal/store/store.go
- Create: factory-server/internal/store/application_versions.go
- Test: factory-server/internal/store/application_versions_test.go

- [ ] **Step 1: Write the failing parent-version test.**

~~~go
func TestCreateApplicationVersionKeepsParentBaseline(t *testing.T) {
  st := newTestStore(t)
  got, err := st.CreateApplicationVersion(context.Background(), model.ApplicationVersion{
    ID: "ver_2", ApplicationID: "app_1", ParentVersionID: "ver_1",
    JobID: "job_2", Status: model.ApplicationVersionQueued,
  })
  if err != nil || got.ParentVersionID != "ver_1" {
    t.Fatalf("version=%#v err=%v", got, err)
  }
}
~~~

- [ ] **Step 2: Run it and verify the type and store method are absent.**

~~~bash
cd factory-server && go test ./internal/store -run TestCreateApplicationVersionKeepsParentBaseline -count=1
~~~

- [ ] **Step 3: Add immutable version schema and migrations.**

Add ApplicationVersion with ID, ApplicationID, ParentVersionID, JobID, Status, SourcePath, DeploymentID, CreatedAt, and PromotedAt. Add jobs dialogue_id, application_id, base_version_id, and kind through ensureColumn migrations. Add:

~~~sql
CREATE TABLE IF NOT EXISTS application_versions (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, parent_version_id TEXT NOT NULL DEFAULT '',
  job_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, source_path TEXT NOT NULL DEFAULT '',
  deployment_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, promoted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_application_versions_app
ON application_versions(app_id, created_at DESC);
~~~

- [ ] **Step 4: Implement version store methods.**

Implement CreateApplicationVersion, GetEffectiveApplicationVersion, and ListApplicationVersions. Create the version and job in one transaction. Server code derives application_id and base_version_id; clients cannot supply them.

- [ ] **Step 5: Verify and commit.**

~~~bash
cd factory-server && go test ./internal/store -count=1
git add factory-server/internal/model factory-server/internal/store
git commit -m "feat: persist application version lineages"
~~~

### Task 2: Keep dialogues active and process turns in order

**Files:**

- Modify: factory-server/internal/model/model.go
- Modify: factory-server/internal/store/schema.sql
- Create: factory-server/internal/store/dialogue_turns.go
- Modify: factory-server/internal/store/dialogues.go
- Modify: factory-server/internal/server/dialogue_handlers.go
- Test: factory-server/internal/server/dialogue_handlers_test.go

- [ ] **Step 1: Write failing continuation and queueing tests.**

~~~go
func TestDialogueAcceptsModificationAfterDeployment(t *testing.T) {
  _, r, st := newDialogueTestServer(t, fakeRunner)
  seedContinuingDialogue(t, st, "dlg_1", "app_1", "ver_1")
  rec := doPost(t, r, http.MethodPost, "/api/dialogues/dlg_1/messages",
    map[string]string{"content": "把告警阈值改成 150 海里"})
  if rec.Code != http.StatusAccepted {
    t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
  }
}
~~~

- [ ] **Step 2: Run and confirm current terminal dialogue behavior fails.**

~~~bash
cd factory-server && go test ./internal/server -run 'TestDialogueAcceptsModificationAfterDeployment|TestDialogueQueuesSecondAnalysisTurn' -count=1
~~~

- [ ] **Step 3: Persist dialogue turns and continuing phases.**

Create dialogue_turns with id, dialogue_id, message_id, intent, status, created_at, started_at, ended_at. Add active, analyzing, waiting_user, change_confirmation, task_running, and archived phases. Existing resolved dialogues backfill to active.

- [ ] **Step 4: Return asynchronous acceptance and run one turn per dialogue.**

POST /api/dialogues/:id/messages persists a message and pending turn, signals a turn worker, and returns dialogueId, turnId, and acceptedAt. The worker claims one pending turn per dialogue. Later messages remain pending. A cancelled turn becomes terminal before the next turn begins.

- [ ] **Step 5: Implement validated turn routing.**

Allow application_modification, new_application, application_inquiry, task_control, and general_dialogue only. Modification creates a change summary. Inquiry and control create no job. New application creates a new dialogue draft and emits dialogue.forked.

- [ ] **Step 6: Verify and commit.**

~~~bash
cd factory-server && go test ./internal/server -run 'TestDialogueAcceptsModificationAfterDeployment|TestDialogueQueuesSecondAnalysisTurn|TestNewApplicationTurnForksDialogue|TestInquiryDoesNotCreateJob' -count=1
git add factory-server/internal/model factory-server/internal/store factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/dialogue_handlers_test.go
git commit -m "feat: keep application dialogues open"
~~~

### Task 3: Persist and stream visible work traces

**Files:**

- Modify: factory-server/internal/store/schema.sql
- Create: factory-server/internal/store/work_traces.go
- Modify: factory-server/internal/server/events.go
- Modify: factory-server/internal/server/server.go
- Modify: factory-server/internal/server/dialogue_handlers.go
- Test: factory-server/internal/store/work_traces_test.go
- Test: factory-server/internal/server/events_test.go

- [ ] **Step 1: Write a strict dialogue-sequence test.**

~~~go
func TestAppendDialogueTraceAssignsStrictSequence(t *testing.T) {
  first, _ := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
    ID: "trace_1", DialogueID: "dlg_1", Type: "intent.recognized", PayloadJSON: "{}",
  })
  second, _ := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
    ID: "trace_2", DialogueID: "dlg_1", Type: "tool.completed", PayloadJSON: "{}",
  })
  if first.Sequence != 1 || second.Sequence != 2 {
    t.Fatalf("%#v %#v", first, second)
  }
}
~~~

- [ ] **Step 2: Add trace storage and append/read APIs.**

~~~sql
CREATE TABLE IF NOT EXISTS work_trace_events (
  id TEXT PRIMARY KEY, dialogue_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  task_id TEXT NOT NULL DEFAULT '', application_id TEXT NOT NULL DEFAULT '',
  version_id TEXT NOT NULL DEFAULT '', step_id TEXT NOT NULL DEFAULT '', attempt INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(dialogue_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_work_trace_replay ON work_trace_events(dialogue_id, sequence);
~~~

AppendDialogueTrace allocates MAX(sequence)+1 and inserts in the same transaction. ListDialogueTrace is ascending and limits pages to 500.

- [ ] **Step 3: Add dialogue-scoped replay and SSE.**

Implement GET /api/dialogues/:id/work-trace?afterSequence=N and GET /api/dialogues/:id/work-trace/stream?afterSequence=N. Replay persisted rows before live subscription, use dialogue sequence as SSE id, honor Last-Event-ID, and filter on the server. Keep global /api/events only for legacy consumers.

- [ ] **Step 4: Record only allowlisted visible events.**

Record intent, approach, assumption, clarification, tool, data, validation, change confirmation, task, version, deployment, warning, error, and assistant output. Persist before publish. Reject headers, credentials, provider thinking, uncapped command output, and raw request or response bodies.

- [ ] **Step 5: Verify and commit.**

~~~bash
cd factory-server && go test ./internal/store ./internal/server -run 'Test.*DialogueTrace|Test.*TraceStream' -count=1
git add factory-server/internal/store/work_traces.go factory-server/internal/store/schema.sql factory-server/internal/server/events.go factory-server/internal/server/server.go factory-server/internal/server/dialogue_handlers.go
git commit -m "feat: persist and replay visible work traces"
~~~

### Task 4: Convert safe agent activity into trace events

**Files:**

- Modify: factory-server/internal/runner/stream.go
- Modify: factory-server/internal/runner/claude_runner.go
- Modify: factory-server/internal/executor/claude_runner.go
- Modify: factory-server/internal/model/model.go
- Test: factory-server/internal/runner/stream_test.go
- Test: factory-server/internal/executor/claude_runner_test.go

- [ ] **Step 1: Add a stream fixture containing assistant text, tool use, and thinking.**

~~~go
stream := strings.Join([]string{
  "{"type":"assistant","message":{"content":[{"type":"text","text":"需要先确认阈值范围"}]}}",
  "{"type":"tool_use","name":"Read","input":{"file_path":"src/rules.ts"}}",
  "{"type":"thinking","thinking":"private chain of thought"}",
}, "
")
~~~

Assert analysis.observation and path-sanitized tool.started appear, while no thinking text appears.

- [ ] **Step 2: Extract only public information.**

Assistant text becomes a redacted capped observation. Tool events show tool name, purpose, allowlisted input keys, duration, status, and capped result summary. Ignore thinking and thinking_delta unconditionally. Remove ExecutionRecordThinking from every UI-publishable path.

- [ ] **Step 3: Stop on high-impact uncertainty.**

Business meaning, data source, external interface, permission, deployment, or user-visible-behavior uncertainty emits clarification.required and leaves the turn waiting. Low-risk defaults emit assumption.recorded and appear in change.summary.

- [ ] **Step 4: Verify and commit.**

~~~bash
cd factory-server && go test ./internal/runner ./internal/executor -count=1
git add factory-server/internal/runner factory-server/internal/executor/claude_runner.go factory-server/internal/model/model.go
git commit -m "feat: expose safe agent work traces"
~~~

### Task 5: Schedule independent applications concurrently

**Files:**

- Modify: factory-server/internal/executor/executor.go
- Modify: factory-server/internal/store/jobs.go
- Modify: factory-server/internal/server/server.go
- Modify: factory-server/internal/server/app_operations.go
- Test: factory-server/internal/executor/executor_test.go
- Test: factory-server/internal/store/jobs_test.go

- [ ] **Step 1: Write the bounded-concurrency test.**

~~~go
func TestSchedulerRunsIndependentApplicationsButSerializesOneApplication(t *testing.T) {
  // Queue app_a/v1, app_b/v1, app_a/v2 with worker limit 3.
  // app_a/v1 and app_b/v1 start; app_a/v2 waits for app_a/v1 to terminate.
}
~~~

- [ ] **Step 2: Replace execBusy with bounded workers.**

Add FACTORY_MAX_CONCURRENT_JOBS with default 3 and valid range 1 to 16. Workers call ClaimNextRunnableJob(workerID). Claims exclude queued jobs with another running job for the same application_id. Replace single currentCancel/currentJobID with a locked per-job cancel map.

- [ ] **Step 3: Keep manual application operations scoped.**

Retain appLock for start, stop, and rebuild. These operations conflict only with generation or deployment of the same application; unrelated applications do not receive global executor-busy conflicts.

- [ ] **Step 4: Verify and commit.**

~~~bash
cd factory-server && go test ./internal/executor ./internal/store ./internal/server -count=1
git add factory-server/internal/executor factory-server/internal/store/jobs.go factory-server/internal/server/server.go factory-server/internal/server/app_operations.go
git commit -m "feat: schedule jobs concurrently by application"
~~~

### Task 6: Promote healthy versions and retain prior service on failure

**Files:**

- Modify: factory-server/internal/executor/claude_runner.go
- Modify: factory-server/internal/executor/factory_steps.go
- Modify: factory-server/internal/store/applications.go
- Modify: factory-server/internal/store/deployments.go
- Modify: factory-server/internal/store/application_versions.go
- Modify: factory-server/internal/server/app_operations.go
- Test: factory-server/internal/executor/factory_steps_test.go
- Test: factory-server/internal/server/app_operations_test.go

- [ ] **Step 1: Write the failure-preservation test.**

~~~go
func TestFailedDeploymentLeavesPreviousEffectiveVersionRunning(t *testing.T) {
  // Seed app_1 effective v1, fail v2 health check, and assert v1 remains effective/running.
}
~~~

- [ ] **Step 2: Build candidate versions in isolated paths.**

Use generated-apps/<application-id>/versions/<version-id> and immutable image tags localhost/software-factory/<slug>:<version-id>. Candidate generation cannot mutate effective source.

- [ ] **Step 3: Promote after health success and add rollback.**

After candidate health success, transactionally make it effective, supersede old version, update runtime URL, and stop the old container. Failure marks only the candidate failed. Add POST /api/apps/:id/rollback; it requires confirmation and promotes the previous successful version through the same health check.

- [ ] **Step 4: Verify and commit.**

~~~bash
cd factory-server && go test ./internal/executor ./internal/store ./internal/server -count=1
git add factory-server/internal/executor factory-server/internal/store factory-server/internal/server/app_operations.go
git commit -m "feat: promote healthy application versions"
~~~

### Task 7: Render scoped traces and focus tasks

**Files:**

- Modify: sf-portal-mvp/src/api/client.js
- Modify: sf-portal-mvp/src/api/events.js
- Create: sf-portal-mvp/src/hooks/workTraceState.js
- Modify: sf-portal-mvp/src/hooks/useDialogueSessions.js
- Modify: sf-portal-mvp/src/hooks/useJobs.js
- Modify: sf-portal-mvp/src/hooks/dialogueTimeline.js
- Modify: sf-portal-mvp/src/components/ConversationWorkbench.jsx
- Modify: sf-portal-mvp/src/components/JobCenter.jsx
- Create: sf-portal-mvp/scripts/check-visible-work-trace.mjs

- [ ] **Step 1: Write ordering and isolation reducer checks.**

~~~js
let state = initialWorkTraceState()
state = applyTraceEvent(state, { dialogueId: "dlg_1", sequence: 2, type: "tool.completed", payload: { tool: "Read" } })
state = applyTraceEvent(state, { dialogueId: "dlg_1", sequence: 1, type: "intent.recognized", payload: {} })
assert.deepEqual(state.items.map(item => item.sequence), [1, 2])
assert.equal(applyTraceEvent(state, { dialogueId: "dlg_2", sequence: 1, type: "task.started", payload: {} }), state)
~~~

- [ ] **Step 2: Subscribe only to selected dialogue trace.**

Add getDialogueTrace and subscribeDialogueTrace. Hydrate REST state, retain highest sequence, open one selected-dialogue EventSource, reconnect from that sequence, and reload on replay gap. Do not use global /api/events for detailed timeline events.

- [ ] **Step 3: Select and display focus task.**

For the selected dialogue choose newest queued/running/waiting job, otherwise newest terminal job. JobCenter shows started_at as 开始执行 separately from queue time. The cross-session overview receives only title, status, started time, and progress.

- [ ] **Step 4: Make the workbench continuous.**

Keep 新建会话 and 历史会话 in the header. After deployment render vN 已生效，可继续描述修改需求。 Keep composer active while jobs run. Render pending turns, cancel-current-turn, change-summary confirmation, archive, destructive deletion confirmation, and generated-app version/rollback controls.

- [ ] **Step 5: Verify and commit.**

~~~bash
cd sf-portal-mvp && npm run test:logic && npm run build
git add sf-portal-mvp/src sf-portal-mvp/scripts sf-portal-mvp/package.json
git commit -m "feat: render continuous workbench traces"
~~~

### Task 8: Verify migration, retention, and full behavior

**Files:**

- Modify: factory-server/internal/store/store_test.go
- Modify: factory-server/internal/server/dialogue_handlers_test.go
- Modify: factory-server/internal/server/events_test.go
- Modify: docs/software-factory-local-runbook.md

- [ ] **Step 1: Add legacy migration coverage.**

Open a database containing prior dialogue, job, application, and deployment rows. Assert lineage and trace upgrades succeed and old rows remain readable.

- [ ] **Step 2: Add one deterministic server scenario.**

Create dialogues A and B; stream only A trace; run A/v1 and B/v1 concurrently; hold A/v2 until A/v1 is terminal; promote A/v1; accept a modification; fail A/v2 health check; verify A/v1 stays active; archive and explicitly delete the dialogue while application deletion preserves audit history.

- [ ] **Step 3: Document retention and configuration.**

Add FACTORY_MAX_CONCURRENT_JOBS=3, trace replay endpoints, reconnect behavior, attachment caps, and explicit-delete retention to the runbook. Semantic trace, version, and deployment records remain until explicit dialogue deletion; attachments are redacted and capped.

- [ ] **Step 4: Run final verification and commit.**

~~~bash
cd factory-server && go test ./...
cd ../sf-portal-mvp && npm run test:logic && npm run build
git add factory-server sf-portal-mvp docs/software-factory-local-runbook.md
git commit -m "test: cover continuous conversation workbench"
~~~

## Self-review

- Coverage: Tasks 1–2 cover lineage, continuous session lifecycle, round intent, queueing, and confirmation. Tasks 3–4 cover durable visible traces, reconnect, safe tools/data/validation, and hidden-reasoning exclusion. Tasks 5–6 cover concurrent generation, same-app serialization, healthy promotion, and rollback. Task 7 covers central workbench, task switch, start time, history, and scoped streams. Task 8 covers migration, retention, and regression.
- Type consistency: server JSON uses dialogueId, taskId, applicationId, versionId, and sequence; Go fields use DialogueID, JobID, ApplicationID, VersionID, and Sequence.
- Placeholder scan: every task names target files, contracts, test commands, and commits.

