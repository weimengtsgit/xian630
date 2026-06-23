# Agent Authoring via Conversation Workbench — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move business agent creation from a modal dialog in AgentsPanel into the center ConversationWorkbench, using an extended clarification session with `mode: "agent_authoring"`.

**Architecture:** The backend clarification session gains a `mode` field. When `mode === "agent_authoring"`, the clarification handler generates agent drafts instead of requirement documents, and `confirm` marks the session complete without creating a job. The frontend ConversationWorkbench detects this mode to show a "Save Agent" button and inline draft preview cards instead of the standard confirmation flow.

**Tech Stack:** Go (factory-server backend), React/JSX (sf-portal-mvp frontend), SQLite (storage), SSE (real-time events), Node.js scripts (frontend logic tests)

## Global Constraints

- Preserve backward compatibility: existing clarification sessions (mode `""`) must be unaffected
- Preserve backward compatibility: existing `/api/business-agent-authoring` endpoints remain untouched
- Use the existing `ensureColumn` migration pattern for schema changes (see `store.go:56-85`)
- All UI text must be in Chinese (matching existing portal conventions)
- Frontend logic tests are Node.js scripts in `sf-portal-mvp/scripts/` using `node:assert/strict`
- Backend tests use `httptest` + in-memory SQLite store with fake runners

---

## File Structure

### Backend files to modify

| File | Change |
|---|---|
| `factory-server/internal/model/model.go:305-319` | Add `Mode` field to `ClarificationSession` |
| `factory-server/internal/store/schema.sql:114-128` | Add `mode` column to `clarification_sessions` |
| `factory-server/internal/store/store.go:56-86` | Add `ensureColumn` migration for `mode` |
| `factory-server/internal/store/clarifications.go:14,17-25,173-193` | Update cols, INSERT, and scanner for `mode` |
| `factory-server/internal/server/clarification_handlers.go:31-34,120-193,624-780` | Add `Mode` to request body, branch `createClarification` and `confirmClarification` for agent_authoring |

### Backend files to create

| File | Purpose |
|---|---|
| `factory-server/internal/server/clarification_agent_authoring.go` | Agent-authoring-specific logic: draft generation, guided questions, SSE events |

### Frontend files to modify

| File | Change |
|---|---|
| `sf-portal-mvp/src/api/client.js:86` | Update `createClarification` to accept options |
| `sf-portal-mvp/src/api/events.js:12-32` | Register `agent_authoring.draft.updated` SSE event |
| `sf-portal-mvp/src/hooks/conversationTimeline.js:19-63,65-96` | Add `agent_draft` message type and SSE handler |
| `sf-portal-mvp/src/hooks/useConversationSessions.js:12-24,235-256` | Add `startAuthoring`, `saveAuthoringAgent`, register SSE type |
| `sf-portal-mvp/src/components/ConversationWorkbench.jsx:15-34,105-148` | Add mode awareness, AgentDraftCard, save button |
| `sf-portal-mvp/src/components/ConversationWorkbench.css` | Add `.cw-agent-draft` styles |
| `sf-portal-mvp/src/components/AgentsPanel.jsx:52-66,205-311,567-656` | Remove authoring modal, wire `onStartAuthoring` |
| `sf-portal-mvp/src/App.jsx:72-116` | Wire authoring callbacks |

### Frontend files to create

| File | Purpose |
|---|---|
| `sf-portal-mvp/scripts/check-agent-authoring-conversation.mjs` | Logic test for agent_draft timeline and SSE handling |

---

### Task 1: Backend — Add Mode to Clarification Model, Schema, and Store

**Files:**
- Modify: `factory-server/internal/model/model.go:305-319`
- Modify: `factory-server/internal/store/schema.sql:114-128`
- Modify: `factory-server/internal/store/store.go:56-86`
- Modify: `factory-server/internal/store/clarifications.go:14,17-25,173-193`

**Interfaces:**
- Consumes: existing `ClarificationSession` struct
- Produces: `ClarificationSession` with `Mode string` field; store operations read/write `mode` column

- [ ] **Step 1: Add Mode field to ClarificationSession model**

In `factory-server/internal/model/model.go`, add `Mode` field to the `ClarificationSession` struct after `AbandonedAt`:

```go
type ClarificationSession struct {
	ID              string              `json:"id"`
	Status          ClarificationStatus `json:"status"`
	Mode            string              `json:"mode"`
	InitialPrompt   string              `json:"initial_prompt"`
	Round           int                 `json:"round"`
	MaxRounds       int                 `json:"max_rounds"`
	RequirementJSON string              `json:"requirement_json"`
	CreatedJobID    string              `json:"created_job_id,omitempty"`
	ErrorCode       string              `json:"error_code,omitempty"`
	ErrorMessage    string              `json:"error_message,omitempty"`
	CreatedAt       time.Time           `json:"created_at"`
	UpdatedAt       time.Time           `json:"updated_at"`
	ConfirmedAt     *time.Time          `json:"confirmed_at,omitempty"`
	AbandonedAt     *time.Time          `json:"abandoned_at,omitempty"`
}
```

Note: `Mode` is placed as the 3rd field (after Status) because it logically defines what kind of session this is. The JSON tag `json:"mode"` means it serializes as `"mode"` in API responses.

- [ ] **Step 2: Add mode column to schema.sql**

In `factory-server/internal/store/schema.sql`, add `mode` column to the `clarification_sessions` table definition after `status`:

```sql
CREATE TABLE IF NOT EXISTS clarification_sessions (
    id               TEXT    PRIMARY KEY,
    status           TEXT    NOT NULL,
    mode             TEXT    NOT NULL DEFAULT '',
    initial_prompt   TEXT    NOT NULL DEFAULT '',
    round            INTEGER NOT NULL DEFAULT 0,
    max_rounds       INTEGER NOT NULL DEFAULT 3,
    requirement_json TEXT    NOT NULL DEFAULT '{}',
    created_job_id   TEXT    NOT NULL DEFAULT '',
    error_code       TEXT    NOT NULL DEFAULT '',
    error_message    TEXT    NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    confirmed_at     INTEGER,
    abandoned_at     INTEGER
);
```

- [ ] **Step 3: Add ensureColumn migration in store.go**

In `factory-server/internal/store/store.go`, add the migration after the existing `business_agent_snapshots_json` migration (after line 85, before `return s, nil`):

```go
	if err := s.ensureColumn(ctx, "clarification_sessions", "mode",
		`ALTER TABLE clarification_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate clarification_sessions.mode: %w", err)
	}
```

- [ ] **Step 4: Update clarificationSessionCols constant**

In `factory-server/internal/store/clarifications.go`, update the column list constant to include `mode` after `status`:

```go
const clarificationSessionCols = `id,status,mode,initial_prompt,round,max_rounds,requirement_json,created_job_id,error_code,error_message,created_at,updated_at,confirmed_at,abandoned_at`
```

- [ ] **Step 5: Update CreateClarificationSession INSERT**

In `factory-server/internal/store/clarifications.go`, update the INSERT statement to include `mode`:

```go
func (s *Store) CreateClarificationSession(ctx context.Context, cs model.ClarificationSession) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clarification_sessions(id,status,mode,initial_prompt,round,max_rounds,requirement_json,created_job_id,error_code,error_message,created_at,updated_at,confirmed_at,abandoned_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		cs.ID, string(cs.Status), cs.Mode, cs.InitialPrompt, cs.Round, cs.MaxRounds, cs.RequirementJSON,
		cs.CreatedJobID, cs.ErrorCode, cs.ErrorMessage, ms(cs.CreatedAt), ms(cs.UpdatedAt),
		nullableMs(cs.ConfirmedAt), nullableMs(cs.AbandonedAt))
	return err
}
```

Key change: 13 placeholders → 14 placeholders, added `cs.Mode` after `string(cs.Status)`.

- [ ] **Step 6: Update scanClarificationSession to read mode**

In `factory-server/internal/store/clarifications.go`, update the scanner to include `mode`:

```go
func scanClarificationSession(sc scanner) (*model.ClarificationSession, error) {
	var s model.ClarificationSession
	var status string
	var created, updated int64
	var confirmed, abandoned sql.NullInt64
	err := sc.Scan(&s.ID, &status, &s.Mode, &s.InitialPrompt, &s.Round, &s.MaxRounds,
		&s.RequirementJSON, &s.CreatedJobID, &s.ErrorCode, &s.ErrorMessage,
		&created, &updated, &confirmed, &abandoned)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Status = model.ClarificationStatus(status)
	s.CreatedAt = time.UnixMilli(created)
	s.UpdatedAt = time.UnixMilli(updated)
	s.ConfirmedAt = ptrFromMs(confirmed)
	s.AbandonedAt = ptrFromMs(abandoned)
	return &s, nil
}
```

Key change: added `&s.Mode` after `&status` in the Scan call.

- [ ] **Step 7: Run existing tests to verify no regressions**

Run: `cd factory-server && go test ./internal/store/ ./internal/server/ -run Clarification -v -count=1`
Expected: All existing clarification tests PASS (mode defaults to `""`, no behavior change)

- [ ] **Step 8: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/store.go factory-server/internal/store/clarifications.go
git commit -m "feat: add mode field to clarification_sessions for agent_authoring support"
```

---

### Task 2: Backend — Branch Handlers for Agent Authoring Mode

**Files:**
- Modify: `factory-server/internal/server/clarification_handlers.go:31-34,120-193,624-780`
- Create: `factory-server/internal/server/clarification_agent_authoring.go`

**Interfaces:**
- Consumes: `ClarificationSession.Mode` from Task 1
- Produces: `createClarification` accepts `mode` in request body; `confirmClarification` skips job creation when `mode === "agent_authoring"`; new `generateAgentDraft` function; new `agent_authoring.draft.updated` SSE event

- [ ] **Step 1: Add Mode to createClarificationBody**

In `factory-server/internal/server/clarification_handlers.go`, update the request body struct:

```go
type createClarificationBody struct {
	Prompt        string `json:"prompt"`
	Mode          string `json:"mode"`
	AbandonActive bool   `json:"abandonActive"`
}
```

- [ ] **Step 2: Branch createClarification to set Mode on session**

In `factory-server/internal/server/clarification_handlers.go`, in the `createClarification` handler, after `reqJSON := "{}"` (line 151), set Mode on the session:

```go
	now := time.Now()
	sessID := "clar_" + idpkg.New()
	reqJSON := "{}"
	mode := strings.TrimSpace(body.Mode)
	maxRounds := 3
	if mode == "agent_authoring" {
		maxRounds = 4 // Allow more rounds for guided agent creation
	}
	sess := model.ClarificationSession{
		ID:              sessID,
		Status:          model.ClarificationStatusActive,
		Mode:            mode,
		InitialPrompt:   body.Prompt,
		Round:           0,
		MaxRounds:       maxRounds,
		RequirementJSON: reqJSON,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
```

Key changes:
- Extract `mode` from request body
- Set `sess.Mode`
- Use 4 max rounds for agent_authoring (more conversation turns needed)

- [ ] **Step 3: Create clarification_agent_authoring.go with draft generation**

Create `factory-server/internal/server/clarification_agent_authoring.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// agentDraftBody is the structured agent draft embedded in agent_draft messages.
type agentDraftBody struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
	Enabled     bool   `json:"enabled"`
}

// generateAgentDraft builds an agent draft from the conversation messages.
// It concatenates all user messages and derives a structured draft using
// template-based heuristics (same approach as the existing authoring API).
func generateAgentDraft(messages []model.ClarificationMessage) agentDraftBody {
	parts := make([]string, 0, len(messages))
	for _, msg := range messages {
		if msg.Role == "user" && strings.TrimSpace(msg.Content) != "" {
			parts = append(parts, strings.TrimSpace(msg.Content))
		}
	}
	content := strings.Join(parts, "\n")
	return draftAgentFromConversation(content)
}

// draftAgentFromConversation generates an agent draft from concatenated user
// messages. Uses the same template approach as draftBusinessAgentFromText in
// business_agent_authoring_handlers.go.
func draftAgentFromConversation(content string) agentDraftBody {
	name := "业务智能体"
	key := "business-agent"
	if strings.Contains(content, "海事") {
		name = "海事预警专家"
		key = "maritime-alert-expert"
	} else if strings.Contains(content, "报表") {
		name = "报表生成专家"
		key = "report-writer"
	} else if strings.Contains(content, "态势") {
		name = "态势分析专家"
		key = "situation-analyst"
	}
	description := firstLine(content, 80)
	prompt := "你是" + name + "。请在需求分析、方案设计和代码生成时关注以下业务要求：" + content + "。不得覆盖软件工厂安全、文件、测试、构建和部署规则。"
	return agentDraftBody{
		Key:         key,
		Name:        name,
		Description: description,
		Prompt:      prompt,
		Enabled:     true,
	}
}

// persistAgentDraft creates an agent_draft message and publishes the SSE event.
// Called by runRoundAndPersist when the session mode is agent_authoring.
func (s *Server) persistAgentDraft(ctx context.Context, sessionID string, draft agentDraftBody) error {
	draftBytes, _ := json.Marshal(draft)
	now := time.Now()
	if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
		ID:           "cmsg_" + idpkg.New(),
		SessionID:    sessionID,
		Role:         "agent",
		Kind:         "agent_draft",
		Content:      "已根据对话更新智能体预览",
		MetadataJSON: string(draftBytes),
		CreatedAt:    now,
	}); err != nil {
		return err
	}
	if s.hub != nil {
		s.hub.Publish(Event{
			Type: "agent_authoring.draft.updated",
			Data: map[string]any{
				"session_id": sessionID,
				"data":       draft,
			},
		})
	}
	return nil
}

// isAgentAuthoringMode checks whether a clarification session is in agent
// authoring mode.
func isAgentAuthoringMode(sess *model.ClarificationSession) bool {
	return sess != nil && sess.Mode == "agent_authoring"
}

// agentAuthoringGuidedQuestions returns the structured questions for agent
// authoring mode. Used by the clarification runner when mode is agent_authoring.
func agentAuthoringGuidedQuestions(round int) []clarification.Question {
	switch round {
	case 1:
		return []clarification.Question{
			{
				ID:       "agent_scenario",
				Label:    "业务场景",
				Question: "这个业务智能体关注什么业务场景？请描述核心关注点和应用场景。",
				Options:  nil,
			},
		}
	case 2:
		return []clarification.Question{
			{
				ID:       "agent_name",
				Label:    "智能体名称",
				Question: "你希望这个智能体叫什么名字？",
				Options:  nil,
			},
		}
	case 3:
		return []clarification.Question{
			{
				ID:       "agent_rules",
				Label:    "判断标准",
				Question: "这个智能体的判断标准和输出边界是什么？有哪些禁忌和约束？",
				Options:  nil,
			},
		}
	default:
		return nil
	}
}
```

Note: `persistAgentDraft` uses `nil` context — this will be fixed in Step 5 to accept a context parameter.

- [ ] **Step 4: Hook agent draft generation into runRoundAndPersist**

In `factory-server/internal/server/clarification_handlers.go`, in the `runRoundAndPersist` function, after the questions are persisted (after the `for _, q := range out.Questions` loop, around line 891) and before the status is set (line 895), add agent draft generation for agent_authoring mode:

```go
	// In agent_authoring mode, generate and persist an agent draft from the
	// conversation so the frontend can show an inline preview card.
	if isAgentAuthoringMode(sess) && len(msgs) > 0 {
		// Re-read messages to include the just-persisted work log and questions
		allMsgs, err := s.store.ListClarificationMessages(ctx, sessID)
		if err == nil && len(allMsgs) > 0 {
			draft := generateAgentDraft(allMsgs)
			if draft.Name != "" && draft.Key != "" {
				_ = s.persistAgentDraft(ctx, sessID, draft)
			}
		}
	}
```

Insert this block after line 891 (end of question persistence) and before line 893 (status mapping comment).

- [ ] **Step 5: Branch confirmClarification for agent_authoring mode**

In `factory-server/internal/server/clarification_handlers.go`, in the `confirmClarification` handler, after the status gate check (line 644, after `if sess.Status != model.ClarificationStatusReadyToConfirm`), add an early-return branch for agent_authoring mode:

```go
	// In agent_authoring mode, confirm just marks the session as complete.
	// The actual agent is created by the frontend calling POST /api/business-agents.
	// No job is created, no requirement validation is needed.
	if isAgentAuthoringMode(sess) {
		if err := s.store.SetClarificationStatus(r.Context(), id, model.ClarificationStatusConfirmed, "", ""); err != nil {
			writeError(w, http.StatusInternalServerError, "set confirmed")
			return
		}
		updated, err := s.store.GetClarificationSession(r.Context(), id)
		if err != nil || updated == nil {
			writeError(w, http.StatusInternalServerError, "get session")
			return
		}
		s.publishClarificationEvent(clarification.StreamEvent{
			Type:      "clarification.confirmed",
			SessionID: id,
			Data:      updated,
		})
		writeJSON(w, http.StatusOK, s.viewFromSession(updated))
		return
	}
```

Insert this block after line 644 (after the status gate) and before `var body confirmClarificationBody` (line 646).

- [ ] **Step 6: Run backend tests to verify**

Run: `cd factory-server && go build ./...`
Expected: Build succeeds with no errors.

Run: `cd factory-server && go test ./internal/server/ -run Clarification -v -count=1`
Expected: All existing clarification tests PASS.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/server/clarification_handlers.go factory-server/internal/server/clarification_agent_authoring.go
git commit -m "feat: branch clarification handlers for agent_authoring mode"
```

---

### Task 3: Backend — Add Tests for Agent Authoring Mode

**Files:**
- Modify: `factory-server/internal/server/clarification_handlers_test.go`

**Interfaces:**
- Consumes: `createClarification` with `mode: "agent_authoring"` from Task 2
- Produces: test coverage for agent_authoring mode behavior

- [ ] **Step 1: Add agent authoring fake runner output**

In `factory-server/internal/server/clarification_handlers_test.go`, add a new fake runner output constant after the existing outputs (after `waitingNoQuestionsCompleteOutput`):

```go
// agentAuthoringRound1Output simulates round 1 of an agent authoring session:
// the clarifier asks about the business scenario.
const agentAuthoringRound1Output = `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"analysis","content":"正在分析业务场景需求"}],
  "questions": [{"id":"agent_scenario","label":"业务场景","question":"这个业务智能体关注什么业务场景？"}],
  "requirement": {}
}`

// agentAuthoringRound2Output simulates round 2: the clarifier asks for the name.
const agentAuthoringRound2Output = `{
  "status": "waiting_user",
  "round": 2,
  "workLog": [{"type":"analysis","content":"业务场景已明确"}],
  "questions": [{"id":"agent_name","label":"智能体名称","question":"你希望这个智能体叫什么名字？"}],
  "requirement": {}
}`

// agentAuthoringReadyOutput simulates the final round: draft is ready.
const agentAuthoringReadyOutput = `{
  "status": "ready_to_confirm",
  "round": 3,
  "workLog": [{"type":"analysis","content":"智能体草稿已生成"}],
  "questions": [],
  "requirement": {}
}`
```

- [ ] **Step 2: Write test for creating agent_authoring session**

Add this test function:

```go
// TestCreateAgentAuthoringClarification verifies that POST /api/clarifications
// with mode: "agent_authoring" creates a session with the correct mode, does
// NOT create a job, and runs round 1 successfully.
func TestCreateAgentAuthoringClarification(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: agentAuthoringRound1Output})

	rec := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{
		"prompt": "请帮我创建一个业务智能体",
		"mode":   "agent_authoring",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Mode != "agent_authoring" {
		t.Fatalf("session mode = %q, want agent_authoring", sess.Mode)
	}
	if sess.Status != model.ClarificationStatusWaitingUser {
		t.Fatalf("session status = %q, want waiting_user", sess.Status)
	}

	// No job should be created
	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %d, want 0 before save", len(jobs))
	}
}
```

- [ ] **Step 3: Write test for confirm in agent_authoring mode (no job creation)**

```go
// TestConfirmAgentAuthoringDoesNotCreateJob verifies that confirming an
// agent_authoring session marks it as confirmed but does NOT create a job.
func TestConfirmAgentAuthoringDoesNotCreateJob(t *testing.T) {
	_, r, st := newClarTestServer(t, &sequenceClarRunner{
		outputs: []string{
			agentAuthoringRound1Output,
			agentAuthoringRound2Output,
			agentAuthoringReadyOutput,
		},
	})

	// Create the session
	rec := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{
		"prompt": "请帮我创建一个海事预警智能体",
		"mode":   "agent_authoring",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Answer round 1 question
	rec = doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers/batch", map[string]any{
		"answers": []map[string]string{{"questionId": "agent_scenario", "value": "海事异常航迹监控"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer1 status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Answer round 2 question
	rec = doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers/batch", map[string]any{
		"answers": []map[string]string{{"questionId": "agent_name", "value": "海事预警专家"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer2 status = %d body=%s", rec.Code, rec.Body.String())
	}

	// Confirm the session
	rec = doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", rec.Code, rec.Body.String())
	}

	var confirmed model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&confirmed); err != nil {
		t.Fatalf("decode confirmed: %v", err)
	}
	if confirmed.Status != model.ClarificationStatusConfirmed {
		t.Fatalf("status = %q, want confirmed", confirmed.Status)
	}
	if confirmed.CreatedJobID != "" {
		t.Fatalf("created_job_id = %q, want empty (no job in agent_authoring mode)", confirmed.CreatedJobID)
	}

	// Verify no jobs were created
	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %d, want 0 (agent_authoring must not create jobs)", len(jobs))
	}
}
```

- [ ] **Step 4: Write test for agent_draft message creation**

```go
// TestAgentAuthoringGeneratesDraftMessage verifies that after a user turn in
// agent_authoring mode, an agent_draft message is created in the session.
func TestAgentAuthoringGeneratesDraftMessage(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: agentAuthoringRound1Output})

	// Create the session
	rec := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{
		"prompt": "创建海事预警智能体",
		"mode":   "agent_authoring",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d", rec.Code)
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Check that an agent_draft message was created during round 1
	msgs, err := st.ListClarificationMessages(context.Background(), sess.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	var hasDraft bool
	for _, msg := range msgs {
		if msg.Kind == "agent_draft" {
			hasDraft = true
			var draft agentDraftBody
			if err := json.Unmarshal([]byte(msg.MetadataJSON), &draft); err != nil {
				t.Fatalf("parse draft: %v", err)
			}
			if draft.Name == "" {
				t.Fatal("draft name is empty")
			}
			if draft.Key == "" {
				t.Fatal("draft key is empty")
			}
			if draft.Prompt == "" {
				t.Fatal("draft prompt is empty")
			}
			break
		}
	}
	if !hasDraft {
		t.Fatal("expected agent_draft message in session, got none")
	}
}
```

- [ ] **Step 5: Write test for normal mode unaffected (regression)**

```go
// TestNormalClarificationUnaffectedByMode verifies that creating a clarification
// without mode (or with empty mode) behaves exactly as before.
func TestNormalClarificationUnaffectedByMode(t *testing.T) {
	_, r, _ := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	rec := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{
		"prompt": "生成一个航母编队复盘应用",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if sess.Mode != "" {
		t.Fatalf("mode = %q, want empty for normal clarification", sess.Mode)
	}
	if sess.Status != model.ClarificationStatusWaitingUser {
		t.Fatalf("status = %q, want waiting_user", sess.Status)
	}
}
```

- [ ] **Step 6: Run all tests**

Run: `cd factory-server && go test ./... -count=1`
Expected: ALL tests pass, including the 4 new tests above.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/server/clarification_handlers_test.go
git commit -m "test: add agent_authoring mode tests for clarification handlers"
```

---

### Task 4: Frontend — Update API Client and Register SSE Event

**Files:**
- Modify: `sf-portal-mvp/src/api/client.js:86`
- Modify: `sf-portal-mvp/src/api/events.js:12-32`

**Interfaces:**
- Consumes: backend `POST /api/clarifications` with `mode` field from Task 2
- Produces: `factoryApi.createClarification(prompt, options)` accepting optional `mode`; SSE subscription includes `agent_authoring.draft.updated`

- [ ] **Step 1: Update createClarification in API client**

In `sf-portal-mvp/src/api/client.js`, change the `createClarification` method (line 86) from:

```js
createClarification: prompt => request('/api/clarifications', { method: 'POST', body: JSON.stringify({ prompt }) }),
```

to:

```js
createClarification: (prompt, options = {}) => request('/api/clarifications', { method: 'POST', body: JSON.stringify({ prompt, ...options }) }),
```

- [ ] **Step 2: Register agent_authoring.draft.updated SSE event**

In `sf-portal-mvp/src/api/events.js`, add `'agent_authoring.draft.updated'` to the `types` array (after `'clarification.abandoned'`, line 31):

```js
  const types = [
    'app.updated',
    'app.deleted',
    'job.created',
    'job.updated',
    'step.updated',
    'artifact.created',
    'deployment.updated',
    'step.record.appended',
    'clarification.created',
    'clarification.message.started',
    'clarification.message.delta',
    'clarification.message.completed',
    'clarification.question.created',
    'clarification.summary.updated',
    'clarification.blueprint.recommended',
    'clarification.ready_to_confirm',
    'clarification.confirmed',
    'clarification.failed',
    'clarification.abandoned',
    'agent_authoring.draft.updated',
  ]
```

- [ ] **Step 3: Run build to verify**

Run: `cd sf-portal-mvp && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add sf-portal-mvp/src/api/client.js sf-portal-mvp/src/api/events.js
git commit -m "feat: update API client for mode option and register agent_authoring SSE event"
```

---

### Task 5: Frontend — Add agent_draft to Conversation Timeline

**Files:**
- Modify: `sf-portal-mvp/src/hooks/conversationTimeline.js:19-63,65-96`

**Interfaces:**
- Consumes: `agent_draft` message kind from backend (Task 2); `agent_authoring.draft.updated` SSE event (Task 4)
- Produces: `buildTimelineFromMessages` returns `{ type: 'agent_draft', draft }` items; `applyConversationEvent` handles `agent_authoring.draft.updated`

- [ ] **Step 1: Add agent_draft message type to buildTimelineFromMessages**

In `sf-portal-mvp/src/hooks/conversationTimeline.js`, in the `buildTimelineFromMessages` function, add a new branch inside the `for` loop, after the existing `question` check (around line 52) and before the requirement/blueprint blocks:

```js
    if (msg.role === 'agent' && msg.kind === 'agent_draft') {
      const draft = parseJSON(msg.metadata_json)
      if (draft) {
        items.push({
          id: msg.id,
          type: 'agent_draft',
          draft,
        })
      }
      continue
    }
```

Insert this between the `question_group` block (line 52) and the closing `}` of the for loop (line 53).

- [ ] **Step 2: Add applyAgentDraftEvent function**

Add a new function at the bottom of `conversationTimeline.js` (before the `parseJSON` helper):

```js
function applyAgentDraftEvent(state, ev) {
  const draft = ev && ev.data
  if (!draft || !draft.name) return state
  // Replace or append the latest agent_draft in the timeline.
  // Use a stable id based on session so only the latest draft shows.
  const draftId = `${ev.session_id || 'draft'}_agent_draft_live`
  const existing = state.timeline.findIndex(item => item.id === draftId)
  const item = { id: draftId, type: 'agent_draft', draft, live: true }
  if (existing === -1) {
    return { ...state, timeline: [...state.timeline, item] }
  }
  const next = state.timeline.slice()
  next[existing] = item
  return { ...state, timeline: next }
}
```

- [ ] **Step 3: Register the SSE event in applyConversationEvent**

In `sf-portal-mvp/src/hooks/conversationTimeline.js`, in the `applyConversationEvent` function's switch statement, add a new case before the `default` case:

```js
    case 'agent_authoring.draft.updated':
      return applyAgentDraftEvent(state, ev)
```

- [ ] **Step 4: Write logic test script**

Create `sf-portal-mvp/scripts/check-agent-authoring-conversation.mjs`:

```js
import assert from 'node:assert/strict'
import {
  buildTimelineFromMessages,
  applyConversationEvent,
  initialConversationState,
} from '../src/hooks/conversationTimeline.js'

// --- agent_draft message type in timeline ---
const messages = [
  { id: 'u1', role: 'user', kind: 'prompt', content: '创建海事预警智能体' },
  { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '正在分析业务场景' },
  {
    id: 'd1',
    role: 'agent',
    kind: 'agent_draft',
    content: '已根据对话更新智能体预览',
    metadata_json: JSON.stringify({
      key: 'maritime-alert-expert',
      name: '海事预警专家',
      description: '海事异常航迹监控',
      prompt: '你是海事预警专家。请关注以下业务要求...',
      enabled: true,
    }),
  },
]
const timeline = buildTimelineFromMessages(messages, null)
assert.deepEqual(
  timeline.map(item => item.type),
  ['user_message', 'analysis_stream', 'agent_draft'],
  'timeline must include agent_draft items'
)
const draftItem = timeline.find(item => item.type === 'agent_draft')
assert.equal(draftItem.draft.name, '海事预警专家')
assert.equal(draftItem.draft.key, 'maritime-alert-expert')
assert.equal(draftItem.draft.prompt, '你是海事预警专家。请关注以下业务要求...')

// --- agent_draft without valid metadata is skipped ---
const badMessages = [
  {
    id: 'd2',
    role: 'agent',
    kind: 'agent_draft',
    content: '',
    metadata_json: 'not valid json',
  },
]
const badTimeline = buildTimelineFromMessages(badMessages, null)
assert.equal(badTimeline.length, 0, 'invalid agent_draft metadata must be skipped')

// --- SSE event applyAgentDraftEvent ---
let state = initialConversationState()
state = { ...state, selectedSessionId: 'clar_1' }

state = applyConversationEvent(state, 'agent_authoring.draft.updated', {
  type: 'agent_authoring.draft.updated',
  session_id: 'clar_1',
  data: {
    key: 'report-writer',
    name: '报表生成专家',
    description: '自动生成业务报表',
    prompt: '你是报表生成专家...',
    enabled: true,
  },
})
assert.equal(state.timeline.length, 1, 'SSE draft event must add timeline item')
assert.equal(state.timeline[0].type, 'agent_draft')
assert.equal(state.timeline[0].draft.name, '报表生成专家')
assert.equal(state.timeline[0].live, true, 'live SSE draft must have live flag')

// --- SSE event replaces existing live draft ---
state = applyConversationEvent(state, 'agent_authoring.draft.updated', {
  type: 'agent_authoring.draft.updated',
  session_id: 'clar_1',
  data: {
    key: 'report-writer',
    name: '报表生成专家 v2',
    description: '更新后的描述',
    prompt: '更新后的提示词...',
    enabled: true,
  },
})
assert.equal(state.timeline.length, 1, 'updated draft must replace, not append')
assert.equal(state.timeline[0].draft.name, '报表生成专家 v2')

// --- SSE event for foreign session does not enter current timeline ---
state = applyConversationEvent(state, 'agent_authoring.draft.updated', {
  type: 'agent_authoring.draft.updated',
  session_id: 'clar_999',
  data: { name: 'foreign', key: 'foreign' },
})
assert.equal(state.timeline.length, 1, 'foreign session draft must not enter current timeline')

console.log('check-agent-authoring-conversation: OK')
```

- [ ] **Step 5: Register test in package.json**

In `sf-portal-mvp/package.json`, add the new test to the `test:logic` script. Append `&& node scripts/check-agent-authoring-conversation.mjs` to the existing chain:

```json
"test:logic": "node scripts/check-job-selection.mjs && node scripts/check-application-ordering.mjs && node scripts/check-agent-creation.mjs && node scripts/check-clarification.mjs && node scripts/check-chat-input-sizing.mjs && node scripts/check-clarification-layout.mjs && node scripts/check-execution-record-state.mjs && node scripts/check-task-observability-layout.mjs && node scripts/check-conversation-workbench.mjs && node scripts/check-business-agents.mjs && node scripts/check-agent-authoring-dialog.mjs && node scripts/check-agent-authoring-conversation.mjs"
```

- [ ] **Step 6: Run the new logic test**

Run: `cd sf-portal-mvp && node scripts/check-agent-authoring-conversation.mjs`
Expected: `check-agent-authoring-conversation: OK`

- [ ] **Step 7: Commit**

```bash
git add sf-portal-mvp/src/hooks/conversationTimeline.js sf-portal-mvp/scripts/check-agent-authoring-conversation.mjs sf-portal-mvp/package.json
git commit -m "feat: add agent_draft timeline item type and SSE event handler"
```

---

### Task 6: Frontend — Add startAuthoring and saveAuthoringAgent to Hook

**Files:**
- Modify: `sf-portal-mvp/src/hooks/useConversationSessions.js:12-24,235-256`

**Interfaces:**
- Consumes: `factoryApi.createClarification(prompt, options)` from Task 4; `factoryApi.createBusinessAgent(agent)` (existing); `factoryApi.confirmClarification(id)` (existing)
- Produces: `startAuthoring()` and `saveAuthoringAgent()` methods on the hook return value

- [ ] **Step 1: Add agent_authoring.draft.updated to CLARIFICATION_TYPES**

In `sf-portal-mvp/src/hooks/useConversationSessions.js`, add the new event type to the `CLARIFICATION_TYPES` set (after `'clarification.abandoned'`, line 23):

```js
const CLARIFICATION_TYPES = new Set([
  'clarification.created',
  'clarification.message.started',
  'clarification.message.delta',
  'clarification.message.completed',
  'clarification.question.created',
  'clarification.summary.updated',
  'clarification.blueprint.recommended',
  'clarification.ready_to_confirm',
  'clarification.confirmed',
  'clarification.failed',
  'clarification.abandoned',
  'agent_authoring.draft.updated',
])
```

- [ ] **Step 2: Add startAuthoring method**

In `sf-portal-mvp/src/hooks/useConversationSessions.js`, add the `startAuthoring` function after the `abandon` callback (around line 213) and before the `useEffect`:

```js
  const startAuthoring = useCallback(async () => {
    setError(null)
    setSelectedBusinessAgents([])
    setSubmitting(true)
    try {
      const session = await factoryApi.createClarification(
        '请帮我创建一个业务智能体',
        { mode: 'agent_authoring' }
      )
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession])
```

- [ ] **Step 3: Add saveAuthoringAgent method**

Add the `saveAuthoringAgent` function right after `startAuthoring`:

```js
  const saveAuthoringAgent = useCallback(async () => {
    if (!state.session || submitting) return null
    // Extract the latest draft from timeline (last agent_draft item)
    const draftItems = state.timeline.filter(item => item.type === 'agent_draft')
    const latestDraft = draftItems[draftItems.length - 1]?.draft
    if (!latestDraft?.key || !latestDraft?.name || !latestDraft?.prompt) {
      throw new Error('Draft is missing required fields (name, key, prompt)')
    }
    setSubmitting(true)
    setError(null)
    try {
      const created = await factoryApi.createBusinessAgent({
        key: latestDraft.key,
        name: latestDraft.name,
        description: latestDraft.description || '',
        prompt: latestDraft.prompt,
        enabled: true,
      })
      // Mark session as complete (no job creation in agent_authoring mode)
      await factoryApi.confirmClarification(state.session.id)
      await refreshSessions()
      return created
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, state.session, state.timeline, submitting])
```

- [ ] **Step 4: Expose new methods in return value**

In the `return` object at the bottom of `useConversationSessions`, add `startAuthoring` and `saveAuthoringAgent`:

```js
  return {
    ...state,
    selectedBusinessAgents,
    selectedBusinessAgentIds: selectedBusinessAgents.map(agent => agent.id),
    error,
    submitting,
    historyOpen,
    setHistoryOpen,
    refreshSessions,
    selectSession,
    newSession,
    send,
    answerBatch,
    confirm,
    retry,
    abandon,
    startAuthoring,
    saveAuthoringAgent,
    addBusinessAgent,
    removeBusinessAgent,
    moveBusinessAgent,
    replaceBusinessAgents,
  }
```

- [ ] **Step 5: Run build to verify**

Run: `cd sf-portal-mvp && npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add sf-portal-mvp/src/hooks/useConversationSessions.js
git commit -m "feat: add startAuthoring and saveAuthoringAgent to conversation hook"
```

---

### Task 7: Frontend — Add Mode Awareness and AgentDraftCard to ConversationWorkbench

**Files:**
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`

**Interfaces:**
- Consumes: `session.mode` from backend response; `timeline` items with `type: 'agent_draft'` from Task 5; `onSaveAuthoring` and `onRefreshAgents` props
- Produces: AgentDraftCard rendered inline; "Save Agent" button in footer; business agent chips hidden in authoring mode

- [ ] **Step 1: Add new props to ConversationWorkbench**

In `sf-portal-mvp/src/components/ConversationWorkbench.jsx`, add `onSaveAuthoring` and `onRefreshAgents` to the destructured props:

```jsx
export function ConversationWorkbench({
  session,
  sessions,
  timeline,
  questions,
  error,
  submitting,
  selectedBusinessAgents = [],
  onRemoveBusinessAgent,
  onMoveBusinessAgent,
  historyOpen,
  setHistoryOpen,
  onNewSession,
  onSelectSession,
  onSend,
  onAnswerBatch,
  onConfirm,
  onRetry,
  onAbandon,
  onSaveAuthoring,
  onRefreshAgents,
}) {
```

- [ ] **Step 2: Add mode detection and canSaveDraft computation**

After the existing `canSubmitAnswers` computation (line 42), add:

```jsx
  const isAuthoringMode = session?.mode === 'agent_authoring'
  const draftItems = timeline.filter(item => item.type === 'agent_draft')
  const latestDraft = draftItems.length > 0 ? draftItems[draftItems.length - 1].draft : null
  const canSaveDraft = isAuthoringMode
    && session?.status === 'ready_to_confirm'
    && latestDraft?.name
    && latestDraft?.key
    && latestDraft?.prompt
```

- [ ] **Step 3: Add Save Agent handler**

After the existing `submitAnswers` function (line 63), add:

```jsx
  const handleSaveAuthoring = async () => {
    if (!onSaveAuthoring || submitting) return
    try {
      await onSaveAuthoring()
      if (onRefreshAgents) await onRefreshAgents()
    } catch {
      // Error is surfaced by the hook's setError
    }
  }
```

- [ ] **Step 4: Hide business agent chips in authoring mode**

Change the business agents section (line 80) from:

```jsx
      {businessAgents.length > 0 ? (
```

to:

```jsx
      {!isAuthoringMode && businessAgents.length > 0 ? (
```

- [ ] **Step 5: Add AgentDraftCard to TimelineItem**

In the `TimelineItem` function (line 151), add a new branch:

```jsx
  if (item.type === 'agent_draft') return <AgentDraftCard draft={item.draft} />
```

Insert this before the `return null` at the end of the function.

- [ ] **Step 6: Create AgentDraftCard component**

Add the `AgentDraftCard` function component after the existing `RequirementSummary` component (around line 242):

```jsx
function AgentDraftCard({ draft }) {
  if (!draft) return null
  return (
    <div className="cw-agent-draft">
      <strong>智能体预览</strong>
      <dl className="cw-agent-draft-grid">
        <div><dt>名称</dt><dd>{draft.name || '-'}</dd></div>
        <div><dt>标识</dt><dd>{draft.key || '-'}</dd></div>
        <div><dt>描述</dt><dd>{draft.description || '-'}</dd></div>
        <div><dt>状态</dt><dd>{draft.enabled === false ? '停用' : '启用'}</dd></div>
      </dl>
      <h4>最终提示词</h4>
      <pre className="cw-agent-draft-prompt">{draft.prompt || '待生成...'}</pre>
    </div>
  )
}
```

- [ ] **Step 7: Update footer for authoring mode**

Replace the existing footer content (lines 126-142) to add authoring mode branching. The key change is in the `canConfirm` button area:

```jsx
      <footer className="cw-composer">
        {session && session.status === 'failed' ? <button type="button" onClick={onRetry} disabled={submitting}>重试本轮</button> : null}
        {session && session.status !== 'confirmed' && session.status !== 'abandoned' ? <button type="button" onClick={onAbandon} disabled={submitting}>放弃</button> : null}
        {isAuthoringMode ? (
          canSaveDraft ? (
            <button type="button" className="primary" onClick={handleSaveAuthoring} disabled={submitting}>
              保存智能体
            </button>
          ) : session && session.status !== 'confirmed' && session.status !== 'abandoned' ? (
            <p className="cw-terminal-hint">请回答上方的引导问题，生成智能体草稿后可以保存。</p>
          ) : null
        ) : (
          canConfirm ? <button type="button" className="primary" onClick={onConfirm} disabled={submitting}>确认并生成</button> : null
        )}
        {terminal ? (
          <p className="cw-terminal-hint">
            {session.status === 'failed' ? '会话已结束。失败会话可重试本轮，或新建会话开始新需求。' : isAuthoringMode ? '智能体创建会话已结束，点击右上角「新建会话」开始新的需求。' : '会话已结束，点击右上角「新建会话」开始新的需求澄清。'}
          </p>
        ) : (
          <>
            <textarea value={input} onChange={e => setInput(e.target.value)} placeholder={isAuthoringMode ? '描述业务场景、规则或补充说明' : '输入新需求或补充说明'} disabled={submitting || canConfirm || terminal} />
            <button type="button" className="cw-send" onClick={submitText} disabled={!input.trim() || submitting || canConfirm || terminal}>
              {submitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            </button>
          </>
        )}
      </footer>
```

- [ ] **Step 8: Add AgentDraftCard CSS styles**

In `sf-portal-mvp/src/components/ConversationWorkbench.css`, add these styles at the end of the file:

```css
/* Agent draft preview card (agent_authoring mode) */
.cw-agent-draft {
  align-self: stretch;
  background: rgba(104, 221, 255, 0.06);
  border: 1px solid rgba(104, 221, 255, 0.22);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: #d7eef8;
}
.cw-agent-draft strong {
  display: block;
  color: #68ddff;
  font-size: 12px;
  margin-bottom: 8px;
}
.cw-agent-draft-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
}
.cw-agent-draft-grid dt {
  color: #8fb0bf;
  font-size: 12px;
}
.cw-agent-draft-grid dd {
  margin: 0;
  color: #edfaff;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cw-agent-draft h4 {
  color: #8fb0bf;
  font-size: 11px;
  margin: 8px 0 4px;
  font-weight: normal;
}
.cw-agent-draft-prompt {
  background: rgba(3, 17, 29, 0.6);
  border: 1px solid rgba(111, 218, 255, 0.12);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 11.5px;
  line-height: 1.4;
  color: #d7eef8;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
  margin: 0;
}
```

- [ ] **Step 9: Run build to verify**

Run: `cd sf-portal-mvp && npm run build`
Expected: Build succeeds.

- [ ] **Step 10: Commit**

```bash
git add sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css
git commit -m "feat: add mode awareness and AgentDraftCard to ConversationWorkbench"
```

---

### Task 8: Frontend — Remove Authoring Modal from AgentsPanel

**Files:**
- Modify: `sf-portal-mvp/src/components/AgentsPanel.jsx`

**Interfaces:**
- Consumes: `onStartAuthoring` prop (replaces `onCreateAuthoringSession` and `onSendAuthoringMessage`)
- Produces: AgentsPanel without authoring modal; create button calls `onStartAuthoring`

- [ ] **Step 1: Remove authoring-related state and constants**

In `sf-portal-mvp/src/components/AgentsPanel.jsx`, remove the following:

1. Remove `emptyAuthoringState` constant (lines 13-21)
2. Remove `parseDraft` function (lines 35-42)
3. Remove these state variables from the component (lines 74-76):
   ```js
   const [authoringOpen, setAuthoringOpen] = useState(false)
   const [authoring, setAuthoring] = useState(emptyAuthoringState)
   ```
4. Remove `parseDraft` usage and derived variables (lines 99-112):
   ```js
   const draft = parseDraft(authoring.session)
   const canFinalize = ...
   const authoringBusy = ...
   const hasAuthoringInput = ...
   const canSaveAuthoring = ...
   const sendAuthoringDisabled = ...
   const authoringFieldRows = ...
   ```

- [ ] **Step 2: Remove authoring-related functions**

Remove these functions from AgentsPanel:
- `openAuthoringDialog` (lines 205-209)
- `closeAuthoringDialog` (lines 211-214)
- `ensureAuthoringSession` (lines 216-223)
- `sendAuthoringContent` (lines 225-245)
- `buildBusinessAgentPayload` (lines 247-262)
- `submitAuthoringMessage` (lines 264-278)
- `finalizeAuthoring` (lines 280-311)

- [ ] **Step 3: Update props**

Remove `onCreateAuthoringSession` and `onSendAuthoringMessage` from the destructured props. Add `onStartAuthoring`:

```jsx
export function AgentsPanel({
  agents,
  softwareAgents,
  businessAgents,
  loading,
  error,
  selectedBusinessAgentIds = [],
  onAddBusinessAgent,
  onRemoveBusinessAgent,
  onCreateBusinessAgent,
  onUpdateBusinessAgent,
  onSetBusinessAgentEnabled,
  onStartAuthoring,
}) {
```

- [ ] **Step 4: Update the create button handler**

Replace the `openAuthoringDialog` call in the create button's `onClick`:

```jsx
  const handleCreateBusinessAgent = () => {
    setPanelError('')
    onStartAuthoring?.()
  }
```

Update the button JSX (around line 326):

```jsx
            <button
              type="button"
              className="agent-icon-button"
              onClick={handleCreateBusinessAgent}
              title="创建业务智能体"
              aria-label="创建业务智能体"
            >
              <Plus size={16} />
            </button>
```

- [ ] **Step 5: Remove the authoring dialog JSX**

Delete the entire `{authoringOpen && (...)}` block (lines 567-656).

- [ ] **Step 6: Remove unused imports**

Remove `Check`, `Save`, `Send` from the lucide-react import (line 2) since they were only used by the authoring modal:

```jsx
import { Bot, Pencil, Plus, Power, X } from 'lucide-react'
```

Wait — `Save` is still used by the edit form's save button (line 557). Keep `Save`. Remove only `Check` and `Send`:

```jsx
import { Bot, Pencil, Plus, Power, Save, X } from 'lucide-react'
```

- [ ] **Step 7: Run build to verify**

Run: `cd sf-portal-mvp && npm run build`
Expected: Build succeeds.

- [ ] **Step 8: Run logic tests**

Run: `cd sf-portal-mvp && npm run test:logic`
Expected: All tests pass. Note: `check-agent-authoring-dialog.mjs` may need updating if it asserts on the authoring modal — check and fix in the next step if needed.

- [ ] **Step 9: Commit**

```bash
git add sf-portal-mvp/src/components/AgentsPanel.jsx
git commit -m "refactor: remove authoring modal from AgentsPanel, delegate to ConversationWorkbench"
```

---

### Task 9: Frontend — Update App.jsx Wiring

**Files:**
- Modify: `sf-portal-mvp/src/App.jsx`

**Interfaces:**
- Consumes: `conversation.startAuthoring`, `conversation.saveAuthoringAgent` from Task 6; `agents.refresh` from existing hook
- Produces: Correct props passed to AgentsPanel and ConversationWorkbench

- [ ] **Step 1: Update AgentsPanel props**

In `sf-portal-mvp/src/App.jsx`, update the `<AgentsPanel>` JSX to remove `onCreateAuthoringSession` and `onSendAuthoringMessage`, and add `onStartAuthoring`:

```jsx
          <AgentsPanel
            agents={agents.agents}
            softwareAgents={agents.softwareAgents}
            businessAgents={agents.businessAgents}
            loading={agents.loading}
            error={agents.error}
            selectedBusinessAgentIds={conversation.selectedBusinessAgentIds}
            onAddBusinessAgent={conversation.addBusinessAgent}
            onRemoveBusinessAgent={conversation.removeBusinessAgent}
            onCreateBusinessAgent={agents.createBusinessAgent}
            onUpdateBusinessAgent={agents.updateBusinessAgent}
            onSetBusinessAgentEnabled={agents.setBusinessAgentEnabled}
            onStartAuthoring={conversation.startAuthoring}
          />
```

Key changes:
- Removed: `onCreateAgent`, `onCreateAuthoringSession`, `onSendAuthoringMessage`
- Added: `onStartAuthoring={conversation.startAuthoring}`

- [ ] **Step 2: Update ConversationWorkbench props**

Add `onSaveAuthoring` and `onRefreshAgents` to the `<ConversationWorkbench>` JSX:

```jsx
          <ConversationWorkbench
            session={conversation.session}
            sessions={conversation.sessions}
            timeline={conversation.timeline}
            questions={conversation.questions}
            error={conversation.error || jobs.error}
            submitting={conversation.submitting}
            selectedBusinessAgents={conversation.selectedBusinessAgents}
            onRemoveBusinessAgent={conversation.removeBusinessAgent}
            onMoveBusinessAgent={conversation.moveBusinessAgent}
            historyOpen={conversation.historyOpen}
            setHistoryOpen={conversation.setHistoryOpen}
            onNewSession={conversation.newSession}
            onSelectSession={conversation.selectSession}
            onSend={prompt => {
              if (jobs.activeJob && jobs.activeJob.status === 'waiting_user') {
                return jobs.answerJob(jobs.activeJob.id, prompt)
              }
              return conversation.send(prompt)
            }}
            onAnswerBatch={conversation.answerBatch}
            onConfirm={conversation.confirm}
            onRetry={conversation.retry}
            onAbandon={conversation.abandon}
            onSaveAuthoring={conversation.saveAuthoringAgent}
            onRefreshAgents={agents.refresh}
          />
```

Key changes: added `onSaveAuthoring` and `onRefreshAgents` props.

- [ ] **Step 3: Run build to verify**

Run: `cd sf-portal-mvp && npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Run all logic tests**

Run: `cd sf-portal-mvp && npm run test:logic`
Expected: All tests pass.

If `check-agent-authoring-dialog.mjs` fails (because it asserts on the old authoring modal), update it to assert the modal is removed and the new flow is in place. Check what it asserts and fix accordingly.

- [ ] **Step 5: Commit**

```bash
git add sf-portal-mvp/src/App.jsx
git commit -m "feat: wire agent authoring callbacks through App.jsx"
```

---

### Task 10: Build Verification and Final Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run full backend test suite**

Run: `cd factory-server && go test ./... -count=1`
Expected: ALL tests pass.

- [ ] **Step 2: Run full frontend build**

Run: `cd sf-portal-mvp && npm run build`
Expected: Build succeeds with no errors or warnings.

- [ ] **Step 3: Run full frontend logic test suite**

Run: `cd sf-portal-mvp && npm run test:logic`
Expected: ALL test scripts output `OK`.

- [ ] **Step 4: Fix any issues found**

If any test or build step fails, diagnose and fix the issue. Common issues:
- Import mismatches (removed functions still imported)
- Prop name mismatches between App.jsx and components
- Missing context import in `persistAgentDraft`

- [ ] **Step 5: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix: resolve build/test issues from agent authoring integration"
```
