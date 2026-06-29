# Task Thinking Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and stream generation-task agent `thinking_delta` into the matching conversation `task_execution_block` as **任务思考过程** while keeping it out of work trace, execution records, dialogue messages, and audit/export surfaces.

**Architecture:** Add a dedicated backend `task_thinking_events` table and persist-before-publish path, mirror the existing dialogue work-trace REST/SSE replay pattern, and add a dedicated executor/runner thinking emitter that never writes to execution records or work trace. The frontend hydrates/subscribes to task-thinking events, reduces them by dialogue sequence, groups them by `taskId/stepId/attempt`, and attaches joined content to `task_execution_block.taskThinking`.

**Tech Stack:** Go backend (`factory-server`), SQLite store, server-sent events via existing hub, React/Vite frontend (`sf-portal-mvp`), Node assertion logic tests, Go `testing` package.

## Global Constraints

- ADR 0009 is the authoritative architecture decision; this plan implements it.
- Do not store task thinking in `work_trace_events`.
- Do not store task thinking in `step_execution_records`.
- Do not store task thinking in ordinary dialogue messages.
- Use a dedicated `task_thinking_events` store.
- Apply credential redaction and byte caps before persistence and SSE publication.
- Do not summarize, translate, or semantically rewrite provider `thinking_delta`.
- Dialogue archive keeps task thinking replayable.
- Dialogue deletion removes task thinking together with dialogue messages and work traces.
- Task thinking remains excluded from audit/export surfaces.
- Preserve existing work-trace and execution-record tests proving thinking does not leak there.

---

## File structure

Backend:

- Create `factory-server/internal/model/task_thinking.go` or add to `factory-server/internal/model/model.go`: `TaskThinkingEvent` model.
- Modify `factory-server/internal/store/schema.sql`: add `task_thinking_events` table and indexes.
- Modify `factory-server/internal/store/store.go`: add migration/table creation if needed by existing `Open` flow.
- Create `factory-server/internal/store/task_thinking.go`: append/list/delete/row-exists helpers.
- Create `factory-server/internal/store/task_thinking_test.go`: sequence, replay, redaction/cap tests.
- Modify `factory-server/internal/server/events.go`: add persist-before-publish task-thinking helper, REST hydration, SSE stream, SSE writer/filter.
- Modify `factory-server/internal/server/server.go`: wire routes and executor callback.
- Modify `factory-server/internal/server/events_test.go`: REST/SSE replay/isolation/persisted-only tests.
- Modify `factory-server/internal/executor/executor.go`: add `stepEmitter.Think` and task-thinking callback plumbing.
- Modify `factory-server/internal/runner` stream parser files: route `thinking` / `thinking_delta` to `TaskThinkingEmitter` only.
- Modify runner/executor tests: prove thinking reaches the task-thinking emitter and still does not reach records/work trace.
- Modify dialogue deletion path (likely `factory-server/internal/store/dialogues.go` / server handlers): delete task thinking by dialogue.

Frontend:

- Modify `sf-portal-mvp/src/api/client.js`: add `getDialogueTaskThinking(dialogueId, afterSequence = 0)`.
- Modify `sf-portal-mvp/src/api/events.js`: add `subscribeDialogueTaskThinking` mirroring `subscribeDialogueTrace`.
- Create `sf-portal-mvp/src/hooks/taskThinkingState.js`: pure reducer and grouping helpers.
- Modify `sf-portal-mvp/src/hooks/useDialogueSessions.js`: manage task-thinking state, subscribe per selected dialogue, pass events into timeline builder.
- Modify `sf-portal-mvp/src/hooks/dialogueTimeline.js`: accept task-thinking events, attach `taskThinking` and redaction flag to matching task blocks.
- Modify `sf-portal-mvp/src/components/ConversationWorkbench.jsx`: render `任务思考过程` section and redaction/cap hint in `TaskExecutionBlock`.
- Modify `sf-portal-mvp/src/components/ConversationWorkbench.css`: style task-thinking section and redaction hint.
- Add/modify frontend logic tests in `sf-portal-mvp/scripts/check-dialogue-workbench.mjs` and a new `sf-portal-mvp/scripts/check-task-thinking-state.mjs`; update `package.json` `test:logic`.

---

### Task 1: Backend task-thinking model, schema, store

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Modify: `factory-server/internal/store/store.go`
- Create: `factory-server/internal/store/task_thinking.go`
- Create: `factory-server/internal/store/task_thinking_test.go`

**Interfaces:**
- Produces Go model:
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
- Produces store methods:
  ```go
  func (s *Store) AppendTaskThinking(ctx context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error)
  func (s *Store) ListTaskThinking(ctx context.Context, dialogueID string, afterDialogueSequence int64, limit int) ([]model.TaskThinkingEvent, error)
  func (s *Store) TaskThinkingRowExists(ctx context.Context, dialogueID string, dialogueSequence int64) bool
  func (s *Store) DeleteTaskThinkingByDialogue(ctx context.Context, dialogueID string) error
  ```

- [ ] **Step 1: Add failing store tests**

Create `factory-server/internal/store/task_thinking_test.go`:

```go
package store

import (
    "context"
    "strings"
    "testing"

    "github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestAppendTaskThinkingAllocatesDialogueAndStepSequences(t *testing.T) {
    st := newTestStore(t)
    ctx := context.Background()

    a, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
        ID: "think_1", DialogueID: "dlg_1", TaskID: "job_1", StepID: "step_1", Attempt: 2, AgentKey: "designer", Content: "first",
    })
    if err != nil {
        t.Fatalf("AppendTaskThinking first: %v", err)
    }
    b, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
        ID: "think_2", DialogueID: "dlg_1", TaskID: "job_1", StepID: "step_1", Attempt: 2, AgentKey: "designer", Content: "second",
    })
    if err != nil {
        t.Fatalf("AppendTaskThinking second: %v", err)
    }
    c, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
        ID: "think_3", DialogueID: "dlg_1", TaskID: "job_1", StepID: "step_2", Attempt: 1, AgentKey: "coder", Content: "third",
    })
    if err != nil {
        t.Fatalf("AppendTaskThinking third: %v", err)
    }

    if a.DialogueSequence != 1 || b.DialogueSequence != 2 || c.DialogueSequence != 3 {
        t.Fatalf("dialogue sequences = %d,%d,%d want 1,2,3", a.DialogueSequence, b.DialogueSequence, c.DialogueSequence)
    }
    if a.StepSequence != 1 || b.StepSequence != 2 || c.StepSequence != 1 {
        t.Fatalf("step sequences = %d,%d,%d want 1,2,1", a.StepSequence, b.StepSequence, c.StepSequence)
    }
}

func TestListTaskThinkingHonorsReplayCursor(t *testing.T) {
    st := newTestStore(t)
    ctx := context.Background()
    _, _ = st.AppendTaskThinking(ctx, model.TaskThinkingEvent{ID: "a", DialogueID: "dlg", TaskID: "job", StepID: "s", Content: "a"})
    _, _ = st.AppendTaskThinking(ctx, model.TaskThinkingEvent{ID: "b", DialogueID: "dlg", TaskID: "job", StepID: "s", Content: "b"})

    rows, err := st.ListTaskThinking(ctx, "dlg", 1, 500)
    if err != nil {
        t.Fatalf("ListTaskThinking: %v", err)
    }
    if len(rows) != 1 || rows[0].ID != "b" {
        t.Fatalf("rows after cursor = %#v, want only b", rows)
    }
}

func TestAppendTaskThinkingRedactsAndCapsContent(t *testing.T) {
    st := newTestStore(t)
    ctx := context.Background()
    huge := strings.Repeat("x", taskThinkingMaxContentBytes*2)
    row, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
        ID: "redact", DialogueID: "dlg", TaskID: "job", StepID: "s", Content: "Authorization: Bearer secret-token\n" + huge,
    })
    if err != nil {
        t.Fatalf("AppendTaskThinking: %v", err)
    }
    if strings.Contains(row.Content, "secret-token") {
        t.Fatalf("secret leaked in content: %q", row.Content)
    }
    if !strings.Contains(row.Content, "[REDACTED]") {
        t.Fatalf("redaction marker missing: %q", row.Content)
    }
    if !strings.Contains(row.Content, taskThinkingTruncationMarker) {
        t.Fatalf("truncation marker missing: len=%d content=%q", len(row.Content), row.Content)
    }
    if !row.Redacted {
        t.Fatalf("Redacted = false, want true")
    }
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/store -run 'TestAppendTaskThinking|TestListTaskThinking' -count=1
```

Expected: FAIL with undefined `TaskThinkingEvent` / `AppendTaskThinking` / constants.

- [ ] **Step 3: Add schema and model**

In `factory-server/internal/model/model.go`, add:

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

In `factory-server/internal/store/schema.sql`, add after `work_trace_events`:

```sql
CREATE TABLE IF NOT EXISTS task_thinking_events (
    id                TEXT    PRIMARY KEY,
    dialogue_id       TEXT    NOT NULL,
    task_id           TEXT    NOT NULL DEFAULT '',
    step_id           TEXT    NOT NULL DEFAULT '',
    attempt           INTEGER NOT NULL DEFAULT 0,
    agent_key         TEXT    NOT NULL DEFAULT '',
    dialogue_sequence INTEGER NOT NULL,
    step_sequence     INTEGER NOT NULL,
    content           TEXT    NOT NULL DEFAULT '',
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

No `ensureColumn` is needed for this first table creation because `schema.sql` is executed on `Open` with `CREATE TABLE IF NOT EXISTS`.

- [ ] **Step 4: Implement store**

Create `factory-server/internal/store/task_thinking.go`:

```go
package store

import (
    "context"
    "database/sql"
    "fmt"
    "strings"
    "time"

    "github.com/weimengtsgit/xian630/factory-server/internal/model"
)

const taskThinkingMaxContentBytes = 8 * 1024
const taskThinkingTruncationMarker = "…[truncated]"
const taskThinkingMaxPageSize = 500

const taskThinkingCols = `id,dialogue_id,task_id,step_id,attempt,agent_key,dialogue_sequence,step_sequence,content,redacted,created_at`

func (s *Store) AppendTaskThinking(ctx context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error) {
    if strings.TrimSpace(ev.DialogueID) == "" {
        return model.TaskThinkingEvent{}, fmt.Errorf("task thinking: missing dialogue_id")
    }
    if ev.ID == "" {
        ev.ID = newTraceID()
    }
    if ev.CreatedAt.IsZero() {
        ev.CreatedAt = time.Now()
    }
    content, redacted := sanitizeTaskThinkingContent(ev.Content)
    ev.Content = content
    ev.Redacted = ev.Redacted || redacted

    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return model.TaskThinkingEvent{}, fmt.Errorf("task thinking begin tx: %w", err)
    }
    defer tx.Rollback() //nolint:errcheck

    var maxDialogue sql.NullInt64
    if err := tx.QueryRowContext(ctx,
        `SELECT MAX(dialogue_sequence) FROM task_thinking_events WHERE dialogue_id = ?`, ev.DialogueID).Scan(&maxDialogue); err != nil {
        return model.TaskThinkingEvent{}, fmt.Errorf("task thinking dialogue seq: %w", err)
    }
    ev.DialogueSequence = maxDialogue.Int64 + 1

    var maxStep sql.NullInt64
    if err := tx.QueryRowContext(ctx,
        `SELECT MAX(step_sequence) FROM task_thinking_events WHERE task_id = ? AND step_id = ? AND attempt = ?`,
        ev.TaskID, ev.StepID, ev.Attempt).Scan(&maxStep); err != nil {
        return model.TaskThinkingEvent{}, fmt.Errorf("task thinking step seq: %w", err)
    }
    ev.StepSequence = int(maxStep.Int64 + 1)

    redactedInt := 0
    if ev.Redacted {
        redactedInt = 1
    }
    if _, err := tx.ExecContext(ctx, `
INSERT INTO task_thinking_events(id,dialogue_id,task_id,step_id,attempt,agent_key,dialogue_sequence,step_sequence,content,redacted,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        ev.ID, ev.DialogueID, ev.TaskID, ev.StepID, ev.Attempt, ev.AgentKey,
        ev.DialogueSequence, ev.StepSequence, ev.Content, redactedInt, ms(ev.CreatedAt)); err != nil {
        return model.TaskThinkingEvent{}, fmt.Errorf("task thinking insert: %w", err)
    }
    if err := tx.Commit(); err != nil {
        return model.TaskThinkingEvent{}, fmt.Errorf("task thinking commit: %w", err)
    }
    return ev, nil
}

func (s *Store) ListTaskThinking(ctx context.Context, dialogueID string, afterDialogueSequence int64, limit int) ([]model.TaskThinkingEvent, error) {
    if limit <= 0 || limit > taskThinkingMaxPageSize {
        limit = taskThinkingMaxPageSize
    }
    rows, err := s.db.QueryContext(ctx, `
SELECT `+taskThinkingCols+` FROM task_thinking_events
WHERE dialogue_id = ? AND dialogue_sequence > ?
ORDER BY dialogue_sequence ASC
LIMIT ?`, dialogueID, afterDialogueSequence, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    out := []model.TaskThinkingEvent{}
    for rows.Next() {
        ev, err := scanTaskThinking(rows)
        if err != nil {
            return nil, err
        }
        if ev != nil {
            out = append(out, *ev)
        }
    }
    return out, rows.Err()
}

func (s *Store) TaskThinkingRowExists(ctx context.Context, dialogueID string, dialogueSequence int64) bool {
    var one int
    err := s.db.QueryRowContext(ctx,
        `SELECT 1 FROM task_thinking_events WHERE dialogue_id = ? AND dialogue_sequence = ? LIMIT 1`,
        dialogueID, dialogueSequence).Scan(&one)
    return err == nil
}

func (s *Store) DeleteTaskThinkingByDialogue(ctx context.Context, dialogueID string) error {
    _, err := s.db.ExecContext(ctx, `DELETE FROM task_thinking_events WHERE dialogue_id = ?`, dialogueID)
    return err
}

func scanTaskThinking(sc scanner) (*model.TaskThinkingEvent, error) {
    var ev model.TaskThinkingEvent
    var redacted int
    var created int64
    err := sc.Scan(&ev.ID, &ev.DialogueID, &ev.TaskID, &ev.StepID, &ev.Attempt, &ev.AgentKey,
        &ev.DialogueSequence, &ev.StepSequence, &ev.Content, &redacted, &created)
    if err == sql.ErrNoRows {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }
    ev.Redacted = redacted != 0
    ev.CreatedAt = time.UnixMilli(created)
    return &ev, nil
}

func sanitizeTaskThinkingContent(content string) (string, bool) {
    original := content
    content = redactExecutionText(content)
    redacted := content != original
    if len([]byte(content)) > taskThinkingMaxContentBytes {
        b := []byte(content)
        marker := []byte(taskThinkingTruncationMarker)
        keep := taskThinkingMaxContentBytes - len(marker)
        if keep < 0 {
            keep = 0
        }
        content = string(b[:keep]) + taskThinkingTruncationMarker
        redacted = true
    }
    return content, redacted
}
```

- [ ] **Step 5: Run store tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/store -run 'TestAppendTaskThinking|TestListTaskThinking' -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/task_thinking.go factory-server/internal/store/task_thinking_test.go
git commit -m "feat: add task thinking store"
```

---

### Task 2: Backend task-thinking REST/SSE transport

**Files:**
- Modify: `factory-server/internal/server/events.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/server/events_test.go`

**Interfaces:**
- Consumes store methods from Task 1.
- Produces routes:
  - `GET /api/dialogues/:id/task-thinking?afterSequence=N`
  - `GET /api/dialogues/:id/task-thinking/stream?afterSequence=N`
- Produces server helper:
  ```go
  func (s *Server) recordAndPublishTaskThinking(ctx context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error)
  ```

- [ ] **Step 1: Add failing server tests**

In `factory-server/internal/server/events_test.go`, add tests next to work-trace SSE tests:

```go
func TestDialogueTaskThinkingEventsHydratesAfterCursor(t *testing.T) {
    srv, r, st := newTraceTestServer(t)
    _ = srv
    ctx := context.Background()
    _, _ = st.AppendTaskThinking(ctx, model.TaskThinkingEvent{ID: "t1", DialogueID: "dlg_1", TaskID: "job", StepID: "s", Content: "a"})
    _, _ = st.AppendTaskThinking(ctx, model.TaskThinkingEvent{ID: "t2", DialogueID: "dlg_1", TaskID: "job", StepID: "s", Content: "b"})

    req := httptest.NewRequest("GET", "/api/dialogues/dlg_1/task-thinking?afterSequence=1", nil)
    rec := httptest.NewRecorder()
    r.ServeHTTP(rec, req)
    if rec.Code != http.StatusOK {
        t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
    }
    var body struct{ Events []model.TaskThinkingEvent `json:"events"` }
    if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
        t.Fatalf("decode: %v", err)
    }
    if len(body.Events) != 1 || body.Events[0].ID != "t2" {
        t.Fatalf("events=%#v, want only t2", body.Events)
    }
}

func TestRecordAndPublishTaskThinkingPersistsBeforePublish(t *testing.T) {
    srv, _, st := newTraceTestServer(t)
    ctx := context.Background()
    ev, err := srv.recordAndPublishTaskThinking(ctx, model.TaskThinkingEvent{
        ID: "think_pub", DialogueID: "dlg_pub", TaskID: "job", StepID: "s", Content: "visible",
    })
    if err != nil {
        t.Fatalf("recordAndPublishTaskThinking: %v", err)
    }
    if ev.DialogueSequence == 0 {
        t.Fatalf("DialogueSequence not assigned: %#v", ev)
    }
    rows, err := st.ListTaskThinking(ctx, "dlg_pub", 0, 500)
    if err != nil || len(rows) != 1 || rows[0].ID != "think_pub" {
        t.Fatalf("persisted rows=%#v err=%v", rows, err)
    }
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/server -run 'TestDialogueTaskThinking|TestRecordAndPublishTaskThinking' -count=1
```

Expected: FAIL with missing route/helper.

- [ ] **Step 3: Add routes**

In `factory-server/internal/server/server.go`, near work-trace routes, add:

```go
r.Handle("GET", "/api/dialogues/:id/task-thinking", s.dialogueTaskThinkingEvents)
r.Handle("GET", "/api/dialogues/:id/task-thinking/stream", s.dialogueTaskThinkingStream)
```

- [ ] **Step 4: Add helper and REST handler**

In `factory-server/internal/server/events.go`, add:

```go
const taskThinkingEventType = "task.thinking.appended"

func (s *Server) recordAndPublishTaskThinking(ctx context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error) {
    persisted, err := s.store.AppendTaskThinking(ctx, ev)
    if err != nil {
        return model.TaskThinkingEvent{}, err
    }
    if s.hub != nil {
        s.hub.Publish(Event{Type: taskThinkingEventType, Data: persisted})
    }
    return persisted, nil
}

func (s *Server) dialogueTaskThinkingEvents(w http.ResponseWriter, r *http.Request) {
    dialogueID := Param(r, "id")
    if dialogueID == "" {
        http.Error(w, "missing dialogue id", http.StatusBadRequest)
        return
    }
    afterSequence := parseSequenceQuery(r.URL.Query().Get("afterSequence"))
    rows, err := s.store.ListTaskThinking(r.Context(), dialogueID, afterSequence, 0)
    if err != nil {
        http.Error(w, "list task thinking: "+err.Error(), http.StatusInternalServerError)
        return
    }
    if rows == nil {
        rows = []model.TaskThinkingEvent{}
    }
    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(struct {
        Events []model.TaskThinkingEvent `json:"events"`
    }{Events: rows})
}
```

- [ ] **Step 5: Add SSE stream**

In `factory-server/internal/server/events.go`, mirror `dialogueTraceStream`:

```go
func (s *Server) dialogueTaskThinkingStream(w http.ResponseWriter, r *http.Request) {
    dialogueID := Param(r, "id")
    if dialogueID == "" {
        http.Error(w, "missing dialogue id", http.StatusBadRequest)
        return
    }
    fl, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming unsupported", http.StatusInternalServerError)
        return
    }
    startAfter := parseSequenceQuery(r.URL.Query().Get("afterSequence"))
    if lid := r.Header.Get("Last-Event-ID"); lid != "" {
        if v, ok := parseSequence(lid); ok {
            startAfter = v
        }
    }
    ch := s.hub.Subscribe()
    defer s.hub.Unsubscribe(ch)

    rows, err := s.store.ListTaskThinking(r.Context(), dialogueID, startAfter, 0)
    if err != nil {
        http.Error(w, "list task thinking: "+err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no")
    if _, err := w.Write([]byte(": connected\n\n")); err != nil {
        return
    }
    fl.Flush()

    lastEmitted := startAfter
    for _, row := range rows {
        if row.DialogueSequence <= lastEmitted {
            continue
        }
        if err := writeTaskThinkingSSE(w, row); err != nil {
            return
        }
        fl.Flush()
        lastEmitted = row.DialogueSequence
    }

    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    ctx := r.Context()
    for {
        select {
        case <-ctx.Done():
            return
        case ev := <-ch:
            row, ok := taskThinkingRowForDialogue(ev, dialogueID)
            if !ok || row.DialogueSequence <= lastEmitted {
                continue
            }
            if !s.store.TaskThinkingRowExists(ctx, dialogueID, row.DialogueSequence) {
                continue
            }
            if err := writeTaskThinkingSSE(w, row); err != nil {
                return
            }
            lastEmitted = row.DialogueSequence
            fl.Flush()
        case <-ticker.C:
            if _, err := w.Write([]byte(": ping\n\n")); err != nil {
                return
            }
            fl.Flush()
        }
    }
}

func writeTaskThinkingSSE(w http.ResponseWriter, row model.TaskThinkingEvent) error {
    payload, err := json.Marshal(row)
    if err != nil {
        return err
    }
    out := []byte("event: " + taskThinkingEventType + "\n")
    out = append(out, []byte("id: ")...)
    out = strconv.AppendInt(out, row.DialogueSequence, 10)
    out = append(out, '\n')
    out = append(out, []byte("data: ")...)
    out = append(out, payload...)
    out = append(out, '\n', '\n')
    _, err = w.Write(out)
    return err
}

func taskThinkingRowForDialogue(ev Event, dialogueID string) (model.TaskThinkingEvent, bool) {
    if ev.Type != taskThinkingEventType {
        return model.TaskThinkingEvent{}, false
    }
    row, ok := ev.Data.(model.TaskThinkingEvent)
    if !ok || row.DialogueID != dialogueID {
        return model.TaskThinkingEvent{}, false
    }
    return row, true
}
```

- [ ] **Step 6: Run server tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/server -run 'TestDialogueTaskThinking|TestRecordAndPublishTaskThinking' -count=1
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/server/events.go factory-server/internal/server/server.go factory-server/internal/server/events_test.go
git commit -m "feat: add task thinking transport"
```

---

### Task 3: Executor and runner thinking capture

**Files:**
- Modify: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/runner/stream.go`
- Modify: runner contracts/interfaces as needed (`factory-server/internal/runner/*.go`)
- Modify: `factory-server/internal/executor/executor_test.go`
- Modify: `factory-server/internal/runner/stream_test.go`

**Interfaces:**
- Consumes `Server.recordAndPublishTaskThinking` from Task 2.
- Produces dedicated emitter path:
  ```go
  type TaskThinkingEmitter interface {
      Think(ctx context.Context, content string) error
  }
  func (s *stepEmitter) Think(ctx context.Context, content string) error
  ```

- [ ] **Step 1: Add failing runner test**

In `factory-server/internal/runner/stream_test.go`, add a test using the existing stream parser helper. If the file already has a fake emitter type, extend it; otherwise add:

```go
type capturingThinkingEmitter struct {
    thoughts []string
}

func (c *capturingThinkingEmitter) Think(_ context.Context, content string) error {
    c.thoughts = append(c.thoughts, content)
    return nil
}
```

Then add:

```go
func TestClaudeStreamThinkingDeltaGoesOnlyToTaskThinkingEmitter(t *testing.T) {
    records := &recordingEmitter{}
    thinking := &capturingThinkingEmitter{}
    lines := []string{
        `{"type":"thinking_delta","thinking_delta":"private reasoning"}`,
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"public"}]}}`,
    }

    // Use the existing stream processing entry point. If its signature currently
    // lacks a thinking emitter, this test should fail to compile until Step 3.
    runClaudeStreamTest(t, lines, records, thinking)

    if len(thinking.thoughts) != 1 || thinking.thoughts[0] != "private reasoning" {
        t.Fatalf("thinking emitter got %#v", thinking.thoughts)
    }
    for _, rec := range records.records {
        if strings.Contains(rec.Content, "private reasoning") {
            t.Fatalf("thinking leaked into execution record: %#v", rec)
        }
    }
    for _, tr := range records.traces {
        if strings.Contains(tr.PayloadJSON, "private reasoning") {
            t.Fatalf("thinking leaked into work trace: %#v", tr)
        }
    }
}
```

If the existing helpers differ, adapt only the helper invocation; keep the assertions exactly: thinking reaches `Think`, and does not reach records/traces.

- [ ] **Step 2: Add failing executor test**

In `factory-server/internal/executor/executor_test.go`, add:

```go
func TestStepEmitterThinkStampsTaskAttribution(t *testing.T) {
    var got model.TaskThinkingEvent
    emit := &stepEmitter{
        jobID:      "job_t",
        stepID:     "step_t",
        agentKey:   "designer",
        dialogueID: "dlg_t",
        attempt:    4,
        onThinking: func(_ context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error) {
            got = ev
            return ev, nil
        },
    }
    if err := emit.Think(context.Background(), "private"); err != nil {
        t.Fatalf("Think: %v", err)
    }
    if got.DialogueID != "dlg_t" || got.TaskID != "job_t" || got.StepID != "step_t" || got.Attempt != 4 || got.AgentKey != "designer" || got.Content != "private" {
        t.Fatalf("thinking attribution = %#v", got)
    }
}
```

- [ ] **Step 3: Extend emitter interfaces and parser path**

In runner package, add interface:

```go
type TaskThinkingEmitter interface {
    Think(ctx context.Context, content string) error
}
```

Where the Claude stream parser currently drops `thinking` / `thinking_delta`, change it to:

```go
if thinkingDelta != "" && thinkingEmitter != nil {
    _ = thinkingEmitter.Think(ctx, thinkingDelta)
}
continue
```

Do not call execution-record emitters or trace emitters for thinking.

- [ ] **Step 4: Add `stepEmitter.Think`**

In `factory-server/internal/executor/executor.go`, add fields:

```go
onThinking func(context.Context, model.TaskThinkingEvent) (model.TaskThinkingEvent, error)
```

Set it in `newStepEmitter` from executor:

```go
onThinking: e.OnTaskThinking,
```

Add method:

```go
func (s *stepEmitter) Think(ctx context.Context, content string) error {
    if s.onThinking == nil || s.dialogueID == "" || content == "" {
        return nil
    }
    ev := model.TaskThinkingEvent{
        DialogueID: s.dialogueID,
        TaskID:     s.jobID,
        StepID:     s.stepID,
        Attempt:    s.attempt,
        AgentKey:   s.agentKey,
        Content:    content,
    }
    _, _ = s.onThinking(ctx, ev)
    return nil
}
```

Add executor field:

```go
OnTaskThinking func(context.Context, model.TaskThinkingEvent) (model.TaskThinkingEvent, error)
```

- [ ] **Step 5: Wire server callback**

In `factory-server/internal/server/server.go`, where `Executor` is constructed, set:

```go
exec.OnTaskThinking = s.recordAndPublishTaskThinking
```

Use the actual construction style in the file; do not create a second executor.

- [ ] **Step 6: Run runner/executor tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/runner ./internal/executor -run 'Thinking|StepEmitterThink' -count=1
```

Expected: PASS.

- [ ] **Step 7: Run hard security tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/runner ./internal/executor -run 'thinking|Thinking|Redacts' -count=1
```

Expected: PASS; existing tests proving no thinking leaks into records/traces remain green.

- [ ] **Step 8: Commit**

```bash
git add factory-server/internal/executor factory-server/internal/runner factory-server/internal/server/server.go
git commit -m "feat: capture task thinking from executor"
```

---

### Task 4: Frontend task-thinking API, SSE helper, reducer

**Files:**
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/api/events.js`
- Create: `sf-portal-mvp/src/hooks/taskThinkingState.js`
- Create: `sf-portal-mvp/scripts/check-task-thinking-state.mjs`
- Modify: `sf-portal-mvp/package.json`

**Interfaces:**
- Produces API:
  ```js
  factoryApi.getDialogueTaskThinking(dialogueId, afterSequence = 0)
  subscribeDialogueTaskThinking(dialogueId, { afterSequence, getDialogueTaskThinking, onEvent, onError })
  ```
- Produces reducer helpers:
  ```js
  initialTaskThinkingState(selectedDialogueId = null)
  normalizeTaskThinkingEvent(raw)
  applyTaskThinkingEvent(state, event)
  applyTaskThinkingEvents(state, events)
  resetTaskThinkingState(selectedDialogueId)
  buildThinkingByStepAttempt(items)
  ```

- [ ] **Step 1: Add failing reducer tests**

Create `sf-portal-mvp/scripts/check-task-thinking-state.mjs`:

```js
import assert from 'node:assert/strict'
import {
  initialTaskThinkingState,
  normalizeTaskThinkingEvent,
  applyTaskThinkingEvents,
  buildThinkingByStepAttempt,
} from '../src/hooks/taskThinkingState.js'

const raw = normalizeTaskThinkingEvent({
  id: 'think_1', dialogue_id: 'dlg_1', task_id: 'job_1', step_id: 'step_1', attempt: 2,
  agent_key: 'designer', dialogue_sequence: 1, step_sequence: 1, content: 'hello', redacted: true, created_at: '2026-06-28T00:00:00Z',
})
assert.equal(raw.dialogueId, 'dlg_1')
assert.equal(raw.taskId, 'job_1')
assert.equal(raw.stepId, 'step_1')
assert.equal(raw.attempt, 2)
assert.equal(raw.agentKey, 'designer')
assert.equal(raw.dialogueSequence, 1)
assert.equal(raw.stepSequence, 1)
assert.equal(raw.redacted, true)

let state = initialTaskThinkingState('dlg_1')
state = applyTaskThinkingEvents(state, [
  { ...raw, id: 'think_2', dialogueSequence: 2, stepSequence: 2, content: ' world', redacted: false },
  raw,
  raw, // duplicate sequence ignored
])
assert.deepEqual(state.items.map(i => i.id), ['think_1', 'think_2'])
assert.equal(state.highestSequence, 2)

const grouped = buildThinkingByStepAttempt(state.items)
const key = 'job_1::step_1::2'
assert.equal(grouped[key].content, 'hello world')
assert.equal(grouped[key].redacted, true)
assert.equal(grouped[key].agentKey, 'designer')

console.log('check-task-thinking-state: OK')
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-task-thinking-state.mjs
```

Expected: FAIL because `taskThinkingState.js` does not exist.

- [ ] **Step 3: Implement reducer**

Create `sf-portal-mvp/src/hooks/taskThinkingState.js`:

```js
export const initialTaskThinkingState = (selectedDialogueId = null) => ({
  selectedDialogueId,
  highestSequence: 0,
  items: [],
})

export function resetTaskThinkingState(selectedDialogueId) {
  return initialTaskThinkingState(selectedDialogueId)
}

export function normalizeTaskThinkingEvent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const dialogueId = raw.dialogueId || raw.dialogue_id
  const dialogueSequence = Number(raw.dialogueSequence ?? raw.dialogue_sequence)
  if (!dialogueId || !Number.isFinite(dialogueSequence)) return null
  return {
    id: raw.id || `${dialogueId}:${dialogueSequence}`,
    dialogueId: String(dialogueId),
    taskId: raw.taskId || raw.task_id || '',
    stepId: raw.stepId || raw.step_id || '',
    attempt: Number(raw.attempt || 0) || 0,
    agentKey: raw.agentKey || raw.agent_key || '',
    dialogueSequence,
    stepSequence: Number(raw.stepSequence ?? raw.step_sequence) || 0,
    content: String(raw.content || ''),
    redacted: !!raw.redacted,
    createdAt: raw.createdAt || raw.created_at || '',
  }
}

export function applyTaskThinkingEvent(state, event) {
  const ev = normalizeTaskThinkingEvent(event)
  if (!ev) return state
  if (state.selectedDialogueId && ev.dialogueId !== state.selectedDialogueId) return state
  if ((state.items || []).some(item => item.dialogueSequence === ev.dialogueSequence)) {
    return { ...state, highestSequence: Math.max(state.highestSequence || 0, ev.dialogueSequence) }
  }
  const items = [...(state.items || []), ev].sort((a, b) => a.dialogueSequence - b.dialogueSequence)
  return {
    ...state,
    highestSequence: Math.max(state.highestSequence || 0, ev.dialogueSequence),
    items,
  }
}

export function applyTaskThinkingEvents(state, events) {
  return (Array.isArray(events) ? events : []).reduce(applyTaskThinkingEvent, state)
}

export function thinkingKey(taskId, stepId, attempt) {
  return `${taskId || ''}::${stepId || ''}::${Number(attempt || 0) || 0}`
}

export function buildThinkingByStepAttempt(items) {
  const grouped = {}
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.stepId) continue
    const key = thinkingKey(item.taskId, item.stepId, item.attempt)
    if (!grouped[key]) {
      grouped[key] = { content: '', redacted: false, agentKey: item.agentKey || '' }
    }
    grouped[key].content += item.content || ''
    grouped[key].redacted = grouped[key].redacted || !!item.redacted
    if (!grouped[key].agentKey && item.agentKey) grouped[key].agentKey = item.agentKey
  }
  return grouped
}
```

- [ ] **Step 4: Add API methods**

In `sf-portal-mvp/src/api/client.js`, add:

```js
getDialogueTaskThinking: (id, afterSequence = 0) =>
  request(`/api/dialogues/${id}/task-thinking?afterSequence=${encodeURIComponent(afterSequence)}`),
```

Return body shape is `{ events }`; callers handle both `body.events` and array defensively.

- [ ] **Step 5: Add SSE helper**

In `sf-portal-mvp/src/api/events.js`, copy the structure of `subscribeDialogueTrace` and adapt names:

```js
export function subscribeDialogueTaskThinking(dialogueId, {
  afterSequence = 0,
  getDialogueTaskThinking,
  onEvent,
  onError,
} = {}) {
  let closed = false
  let highest = Number(afterSequence) || 0
  const emit = row => {
    if (!row || closed) return
    const seq = Number(row.dialogue_sequence ?? row.dialogueSequence)
    if (Number.isFinite(seq) && seq <= highest) return
    if (Number.isFinite(seq)) highest = seq
    if (onEvent) onEvent(row)
  }
  if (getDialogueTaskThinking) {
    getDialogueTaskThinking(dialogueId, highest)
      .then(data => {
        const rows = Array.isArray(data) ? data : data && Array.isArray(data.events) ? data.events : []
        rows.forEach(emit)
      })
      .catch(err => { if (onError) onError(err) })
  }
  const es = new EventSource(`/api/dialogues/${dialogueId}/task-thinking/stream?afterSequence=${encodeURIComponent(highest)}`)
  es.addEventListener('task.thinking.appended', event => {
    try { emit(JSON.parse(event.data)) } catch (err) { if (onError) onError(err) }
  })
  es.onerror = err => { if (onError) onError(err) }
  return () => { closed = true; es.close() }
}
```

If `events.js` uses a base URL helper for EventSource, follow that existing helper instead of the literal path.

- [ ] **Step 6: Add test script to package**

In `sf-portal-mvp/package.json`, insert `node scripts/check-task-thinking-state.mjs` after `check-visible-work-trace.mjs` in `test:logic`.

- [ ] **Step 7: Run reducer tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-task-thinking-state.mjs
npm run test:logic
```

Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add sf-portal-mvp/src/api/client.js sf-portal-mvp/src/api/events.js sf-portal-mvp/src/hooks/taskThinkingState.js sf-portal-mvp/scripts/check-task-thinking-state.mjs sf-portal-mvp/package.json
git commit -m "feat: add task thinking frontend state"
```

---

### Task 5: Frontend task-thinking timeline integration and UI

**Files:**
- Modify: `sf-portal-mvp/src/hooks/useDialogueSessions.js`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`

**Interfaces:**
- Consumes Task 4 reducer helpers.
- Extends `buildDialogueTimeline(..., taskThinkingItems = [])` to attach:
  ```js
  block.taskThinking = 'joined raw thinking deltas'
  block.taskThinkingRedacted = true|false
  ```

- [ ] **Step 1: Add failing timeline test**

In `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`, add near task execution block tests:

```js
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
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-dialogue-workbench.mjs
```

Expected: FAIL because eighth param is ignored.

- [ ] **Step 3: Extend `buildDialogueTimeline`**

In `sf-portal-mvp/src/hooks/dialogueTimeline.js`:

1. Import grouping helper:
   ```js
   import { buildThinkingByStepAttempt, thinkingKey } from './taskThinkingState.js'
   ```
2. Change signature:
   ```js
   export function buildDialogueTimeline(view, optimisticUserMessage = null, liveAnalysis = null, liveThinking = null, workTraceItems = [], pendingTurn = null, jobStepBlocks = [], taskThinkingItems = [])
   ```
3. Before pushing task blocks:
   ```js
   const thinkingByStepAttempt = buildThinkingByStepAttempt(taskThinkingItems)
   ```
4. When cloning block:
   ```js
   const thinking = thinkingByStepAttempt[thinkingKey(rawBlock.jobId, rawBlock.stepId, rawBlock.attempt)] || null
   const block = {
     ...rawBlock,
     safeExecution: ...,
     taskThinking: thinking ? thinking.content : '',
     taskThinkingRedacted: !!(thinking && thinking.redacted),
   }
   ```

- [ ] **Step 4: Wire `useDialogueSessions` subscription**

In `sf-portal-mvp/src/hooks/useDialogueSessions.js`:

1. Import reducer and SSE helper:
   ```js
   import { subscribeDialogueTaskThinking } from '../api/events'
   import { initialTaskThinkingState, applyTaskThinkingEvent, resetTaskThinkingState } from './taskThinkingState'
   ```
2. Add state:
   ```js
   const [taskThinking, setTaskThinking] = useState(initialTaskThinkingState())
   ```
3. Pass `taskThinking.items` into both `buildDialogueTimeline` calls as eighth param.
4. Add `taskThinking.items` to the timeline rebuild effect dependency via a stable low-frequency key:
   ```js
   const taskThinkingSeqKey = useMemo(() => (taskThinking.items || []).map(it => it.dialogueSequence).join(','), [taskThinking.items])
   ```
   Use `taskThinkingSeqKey` in deps, not the array object.
5. Add selected-dialogue subscription effect mirroring work trace:
   ```js
   useEffect(() => {
     const dialogueId = state.selectedDialogueId
     if (!dialogueId) {
       setTaskThinking(initialTaskThinkingState())
       return undefined
     }
     let unsubscribe = () => {}
     setTaskThinking(resetTaskThinkingState(dialogueId))
     unsubscribe = subscribeDialogueTaskThinking(dialogueId, {
       afterSequence: 0,
       getDialogueTaskThinking: factoryApi.getDialogueTaskThinking,
       onEvent: row => {
         if (!mountedRef.current) return
         setTaskThinking(prev => applyTaskThinkingEvent(prev, row))
       },
       onError: () => {},
     })
     return () => unsubscribe()
   }, [state.selectedDialogueId])
   ```

- [ ] **Step 5: Render task thinking section**

In `sf-portal-mvp/src/components/ConversationWorkbench.jsx`, in `TaskExecutionBlock`, add:

```jsx
const taskThinking = String(item.taskThinking || '')
...
{taskThinking ? (
  <section className="cw-task-section cw-task-thinking-section">
    <h5>任务思考过程{item.taskThinkingRedacted ? <em className="cw-redacted-note">已脱敏/截断</em> : null}</h5>
    <pre className="cw-live-text">{taskThinking}</pre>
  </section>
) : null}
```

Include `taskThinking` in copied text.

- [ ] **Step 6: Add CSS**

In `sf-portal-mvp/src/components/ConversationWorkbench.css`, add:

```css
.cw-task-thinking-section h5 { color: #c9a7ff; }
.cw-redacted-note { margin-left: 6px; color: rgba(255, 196, 87, 0.85); font-style: normal; font-size: 10px; }
```

- [ ] **Step 7: Run focused frontend tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-task-thinking-state.mjs
node scripts/check-dialogue-workbench.mjs
npm run test:logic
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add sf-portal-mvp/src/hooks/useDialogueSessions.js sf-portal-mvp/src/hooks/dialogueTimeline.js sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/scripts/check-dialogue-workbench.mjs
git commit -m "feat: render task thinking in task blocks"
```

---

### Task 6: Dialogue deletion cleanup

**Files:**
- Modify: backend dialogue deletion store/server file that currently removes dialogue messages and work traces.
- Modify: corresponding backend tests.

**Interfaces:**
- Consumes `Store.DeleteTaskThinkingByDialogue(ctx, dialogueID)` from Task 1.

- [ ] **Step 1: Locate deletion path**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
grep -R "Delete.*Dialogue\|deleteDialogue\|work_trace_events" -n factory-server/internal/store factory-server/internal/server | head -80
```

Expected: identify the exact function that deletes dialogue messages/work traces.

- [ ] **Step 2: Add failing deletion test**

In the existing dialogue deletion test file, add a test that:

```go
func TestDeleteDialogueRemovesTaskThinking(t *testing.T) {
    // Use the existing test server/store helper for dialogue deletion.
    // Create a dialogue id "dlg_del" using the existing helper.
    // Append one task thinking event: st.AppendTaskThinking(ctx, model.TaskThinkingEvent{DialogueID:"dlg_del", TaskID:"job", StepID:"s", Content:"thinking"})
    // Delete the dialogue through the same public path existing tests use.
    // Assert st.ListTaskThinking(ctx, "dlg_del", 0, 500) returns len 0.
}
```

Use the actual helper names from the located test file; do not create a new deletion API.

- [ ] **Step 3: Run test and verify it fails**

Run the exact test with `go test ./internal/server -run TestDeleteDialogueRemovesTaskThinking -count=1` or store package if deletion is store-level.

Expected: FAIL because task thinking rows remain.

- [ ] **Step 4: Implement cleanup**

In the dialogue deletion path, call:

```go
if err := s.DeleteTaskThinkingByDialogue(ctx, dialogueID); err != nil {
    return err
}
```

Place it next to existing work-trace/message cleanup so deletion semantics stay grouped.

- [ ] **Step 5: Run deletion test**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/store factory-server/internal/server
git commit -m "fix: delete task thinking with dialogues"
```

---

### Task 7: Full verification and final review

**Files:**
- No code files unless verification reveals a defect.

**Interfaces:**
- Verifies all prior tasks.

- [ ] **Step 1: Run full backend verification**

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/store ./internal/server ./internal/executor ./internal/runner
```

Expected: PASS.

- [ ] **Step 2: Run full frontend verification**

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run test:logic
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run whitespace diff check**

```bash
cd /Users/mengwei/ww/Developer/xian630
git diff --check
```

Expected: no output.

- [ ] **Step 4: Inspect security invariants**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
grep -R "TaskThinking\|task_thinking" -n factory-server/internal | grep -E "work_trace|execution_record" || true
```

Expected: no evidence that task thinking is written into work-trace or execution-record storage. Mentions in tests/comments are acceptable; data writes must only go through `AppendTaskThinking`.

- [ ] **Step 5: Final commit if needed**

If verification-only fixes were made:

```bash
git add <changed-files>
git commit -m "test: verify task thinking persistence"
```

Otherwise no commit is needed.

---

## Self-review

- Spec coverage: model/schema/store, REST/SSE, executor/runner capture, frontend API/SSE/reducer, timeline UI, deletion cleanup, security invariants, and verification are each covered by a task.
- Placeholder scan: no `TBD`, `TODO`, or unspecified “add tests” placeholders remain. Task 6 references locating the existing deletion path because the plan cannot safely name a single file without overfitting; it gives the exact command and required code once located.
- Type consistency: `TaskThinkingEvent`, `AppendTaskThinking`, `ListTaskThinking`, `subscribeDialogueTaskThinking`, `task.thinking.appended`, `dialogue_sequence`, `step_sequence`, `taskThinking`, and `taskThinkingRedacted` are consistently named across backend, frontend, and tests.
