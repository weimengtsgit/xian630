# Software Factory Clarification Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Claude Code powered requirement clarification flow before job creation, with project-local skills, structured options, message-level SSE streaming, confirmed requirements, and generation profile injection.

**Architecture:** Introduce `ClarificationSession` as a separate resource from `Job`. The portal creates and drives clarification sessions; Factory stores structured requirement state, calls a real Claude Code clarification runner, normalizes runner output into SSE events, and only creates a generation job after `确认并生成`. Generated jobs keep the existing six-step pipeline, but `requirement_analysis` freezes and audits the confirmed requirement instead of doing multi-turn clarification.

**Tech Stack:** Go 1.21, SQLite, net/http REST + SSE, local Claude Code CLI, project-local `.claude/skills`, React/Vite portal.

---

## Source References

- Product design: `docs/software-factory-mvp-design.md`
- Domain language: `CONTEXT.md`
- Decision record: `docs/adr/0001-repo-local-generation-skills.md`
- Existing backend entry: `factory-server/internal/server/server.go`
- Existing job handlers: `factory-server/internal/server/job_handlers.go`
- Existing runner wrapper: `factory-server/internal/runner/claude.go`
- Existing portal chat: `sf-portal-mvp/src/components/ChatDialog.jsx`

## File Structure Map

Create:

```text
.claude/skills/requirement-clarification/SKILL.md
.claude/skills/software-factory-app/SKILL.md
.claude/skills/defense-operations-ui/SKILL.md
.claude/skills/map-timeline-replay/SKILL.md
.claude/skills/operations-management-console/SKILL.md
.claude/skills/command-dashboard/SKILL.md
factory-server/internal/store/clarifications.go
factory-server/internal/store/clarifications_test.go
factory-server/internal/clarification/contracts.go
factory-server/internal/clarification/runner.go
factory-server/internal/clarification/runner_test.go
factory-server/internal/server/clarification_handlers.go
factory-server/internal/server/clarification_handlers_test.go
sf-portal-mvp/src/hooks/useClarification.js
sf-portal-mvp/src/components/ClarificationPanel.jsx
sf-portal-mvp/src/components/ClarificationPanel.css
```

Modify:

```text
factory-server/internal/model/model.go
factory-server/internal/store/schema.sql
factory-server/internal/store/jobs.go
factory-server/internal/server/server.go
factory-server/internal/server/events.go
factory-server/internal/server/job_handlers.go
factory-server/internal/executor/claude_runner.go
factory-server/internal/runner/contracts.go
factory-server/internal/runner/contracts_test.go
sf-portal-mvp/src/api/client.js
sf-portal-mvp/src/api/events.js
sf-portal-mvp/src/App.jsx
sf-portal-mvp/src/components/ChatDialog.jsx
sf-portal-mvp/src/components/ChatDialog.css
sf-portal-mvp/src/hooks/useJobs.js
docs/software-factory-local-runbook.md
```

## Task 1: Add Project-Local Claude Code Skills

**Files:**
- Create: `.claude/skills/requirement-clarification/SKILL.md`
- Create: `.claude/skills/software-factory-app/SKILL.md`
- Create: `.claude/skills/defense-operations-ui/SKILL.md`
- Create: `.claude/skills/map-timeline-replay/SKILL.md`
- Create: `.claude/skills/operations-management-console/SKILL.md`
- Create: `.claude/skills/command-dashboard/SKILL.md`

- [ ] **Step 1: Create `requirement-clarification` skill**

Write `.claude/skills/requirement-clarification/SKILL.md`:

````md
---
name: requirement-clarification
description: Guide a user from an initial software factory request to a structured confirmed requirement before any generation job is created.
---

# Requirement Clarification

Use this skill when Factory asks you to run a clarification round for a software factory user request.

## Output Contract

You must write `output.json` with this shape:

```json
{
  "status": "waiting_user",
  "round": 1,
  "workLog": [
    {
      "type": "analysis",
      "content": "识别到这是态势复盘类应用。"
    }
  ],
  "questions": [
    {
      "id": "app_type",
      "label": "应用类型",
      "question": "请选择应用类型",
      "required": true,
      "recommendation": "situation_replay",
      "options": [
        {
          "value": "situation_replay",
          "label": "态势复盘类",
          "reason": "适合地图、轨迹、事件和时间轴"
        }
      ],
      "allowCustom": false
    }
  ],
  "requirement": {
    "appType": "situation_replay",
    "appName": "",
    "targetUsers": [],
    "coreScenario": "",
    "primaryView": "",
    "mainEntities": [],
    "dataPolicy": "mock_data",
    "acceptanceFocus": [],
    "generationProfile": {
      "base": ["software-factory-app"],
      "domain": ["defense-operations-ui"],
      "pattern": ["map-timeline-replay"]
    }
  }
}
```

## Rules

- Ask at most 3 questions per round.
- Do not exceed 3 rounds.
- Do not create a generation job.
- Do not generate code.
- Do not expose hidden chain-of-thought.
- Generate user-facing `workLog` entries that explain what you identified, why you recommend an option, and what remains unconfirmed.
- Treat “确认”, “可以”, “开始生成”, and “确认并生成” as confirmation intent when the required fields are complete.
- If the request is a new app while an active session exists, return an `intent_conflict` question with options to continue current requirement or abandon and start a new one.

## Required Confirmed Requirement Fields

- `appType`
- `appName`
- `targetUsers`
- `coreScenario`
- `mainEntities`
- `acceptanceFocus`
- `generationProfile`

`primaryView` and `dataPolicy` are deferred-stage fields. They may be present
when the user already supplied them, but missing values do not block business
requirement confirmation.

## Supported App Types

- `situation_replay`
- `operations_management`
- `command_dashboard`

## Generation Profile Mapping

- `situation_replay`: `software-factory-app`, `defense-operations-ui`, `map-timeline-replay`
- `operations_management`: `software-factory-app`, `defense-operations-ui`, `operations-management-console`
- `command_dashboard`: `software-factory-app`, `defense-operations-ui`, `command-dashboard`
````

- [ ] **Step 2: Create generation skills**

Write each generation skill as a focused constraint document. Use these exact required sections in every file:

````md
---
name: software-factory-app
description: Generate a deployable React/Vite static application for the software factory.
---

# Software Factory App

## Must Do

- Generate files only under `generated-apps/<slug>/`.
- Generate `.factory/app.json`, `package.json`, `Dockerfile`, `nginx.conf`, `src/`, and `README.md`.
- Use React and Vite.
- Keep the app static and self-contained with mock data.
- Ensure `npm run build` creates `dist/index.html`.
- Use `source: "generated"` in `.factory/app.json`.

## Must Not Do

- Do not modify `scene/`, `factory-server/`, `cc-status/`, or `.git/`.
- Do not require a backend service.
- Do not fetch real military data.
- Do not require login, external credentials, or cloud services.

## Output Checklist

- Buildable with `npm install` or `npm ci`.
- Deployable by Podman with the generated Dockerfile.
- Runtime page has meaningful non-empty content.
- Buttons and controls have visible feedback.
````

For the other five files, keep the same frontmatter pattern and use these specific `Must Do` bullets:

````md
# Defense Operations UI

## Must Do

- Use a dark operational interface inspired by `sf-portal-mvp` and `scene/`.
- Favor dense, scannable layouts over marketing pages.
- Use top status bars, side panels, compact controls, tables, maps, timelines, and alert strips when they match the confirmed app type.
- Avoid decorative-only gradients, oversized hero sections, and empty dashboard cards.
- Use Chinese operational labels.
````

````md
# Map Timeline Replay

## Must Do

- Use a map-like primary canvas, track polyline, event points, and timeline controls.
- Keep the map area in East China Sea or a user-confirmed maritime area when relevant.
- Provide selected object details and event detail panels.
- Link timeline selection to visible track/event state.
- Use mock coordinates and events when no real data source is confirmed.
````

```md
# Operations Management Console

## Must Do

- Use table/list, filters, status tags, detail panel, and summary metrics.
- Model domain entities such as equipment, logistics resources, personnel, plans, or support tasks.
- Provide at least one state transition control with visible UI feedback.
- Keep interactions local and mock-data based.
```

```md
# Command Dashboard

## Must Do

- Use command-level metrics, alerts, readiness status, trend panels, and task lists.
- Prioritize scanability and duty workflow.
- Show stale/urgent/normal states distinctly.
- Include drill-down details for at least one selected item.
```

- [ ] **Step 3: Verify skill files exist**

Run:

```bash
test -f .claude/skills/requirement-clarification/SKILL.md
test -f .claude/skills/software-factory-app/SKILL.md
test -f .claude/skills/defense-operations-ui/SKILL.md
test -f .claude/skills/map-timeline-replay/SKILL.md
test -f .claude/skills/operations-management-console/SKILL.md
test -f .claude/skills/command-dashboard/SKILL.md
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills
git commit -m "feat: add software factory generation skills"
```

## Task 2: Add Clarification Models, Schema, And Store

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Create: `factory-server/internal/store/clarifications.go`
- Create: `factory-server/internal/store/clarifications_test.go`

- [ ] **Step 1: Add model types**

Add to `factory-server/internal/model/model.go`:

```go
type ClarificationStatus string

const (
	ClarificationStatusActive         ClarificationStatus = "active"
	ClarificationStatusWaitingUser    ClarificationStatus = "waiting_user"
	ClarificationStatusReadyToConfirm ClarificationStatus = "ready_to_confirm"
	ClarificationStatusConfirmed      ClarificationStatus = "confirmed"
	ClarificationStatusFailed         ClarificationStatus = "failed"
	ClarificationStatusAbandoned      ClarificationStatus = "abandoned"
)

type ClarificationSession struct {
	ID              string              `json:"id"`
	Status          ClarificationStatus `json:"status"`
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

type ClarificationMessage struct {
	ID           string    `json:"id"`
	SessionID    string    `json:"session_id"`
	Role         string    `json:"role"`
	Kind         string    `json:"kind"`
	Content      string    `json:"content"`
	MetadataJSON string    `json:"metadata_json,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}
```

- [ ] **Step 2: Extend schema**

Add these tables to `factory-server/internal/store/schema.sql` after `jobs`:

```sql
CREATE TABLE IF NOT EXISTS clarification_sessions (
    id               TEXT    PRIMARY KEY,
    status           TEXT    NOT NULL,
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

CREATE TABLE IF NOT EXISTS clarification_messages (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT    NOT NULL,
    role          TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    content       TEXT    NOT NULL DEFAULT '',
    metadata_json TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);
```

Add fields to `jobs`:

```sql
    clarification_session_id TEXT NOT NULL DEFAULT '',
    confirmed_requirement_json TEXT NOT NULL DEFAULT '',
```

Use SQLite-compatible migration logic in `store.Open` if this codebase already runs `ALTER TABLE` for existing DBs. If no migration helper exists, add an idempotent helper in `store.go`:

```go
func (s *Store) ensureColumn(ctx context.Context, table, column, ddl string) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	_, err = s.db.ExecContext(ctx, ddl)
	return err
}
```

- [ ] **Step 3: Write store tests**

Create `factory-server/internal/store/clarifications_test.go`:

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestClarificationSessionLifecycle(t *testing.T) {
	st := newTestStore(t)
	now := time.Now()
	s := model.ClarificationSession{
		ID:              "clar_1",
		Status:          model.ClarificationStatusActive,
		InitialPrompt:   "生成一个航母编队复盘应用",
		Round:           1,
		MaxRounds:       3,
		RequirementJSON: `{"appType":"situation_replay"}`,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := st.CreateClarificationSession(context.Background(), s); err != nil {
		t.Fatalf("CreateClarificationSession: %v", err)
	}
	got, err := st.GetClarificationSession(context.Background(), "clar_1")
	if err != nil || got == nil {
		t.Fatalf("GetClarificationSession = %#v, %v", got, err)
	}
	if got.Status != model.ClarificationStatusActive || got.Round != 1 {
		t.Fatalf("session = %#v", got)
	}
	if err := st.UpdateClarificationRequirement(context.Background(), "clar_1", `{"appType":"command_dashboard"}`); err != nil {
		t.Fatalf("UpdateClarificationRequirement: %v", err)
	}
	got, _ = st.GetClarificationSession(context.Background(), "clar_1")
	if got.RequirementJSON != `{"appType":"command_dashboard"}` {
		t.Fatalf("RequirementJSON = %s", got.RequirementJSON)
	}
}

func TestClarificationMessages(t *testing.T) {
	st := newTestStore(t)
	now := time.Now()
	if err := st.CreateClarificationSession(context.Background(), model.ClarificationSession{
		ID: "clar_1", Status: model.ClarificationStatusActive, InitialPrompt: "x",
		Round: 1, MaxRounds: 3, RequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	msg := model.ClarificationMessage{
		ID: "msg_1", SessionID: "clar_1", Role: "agent", Kind: "analysis_work_log",
		Content: "识别到这是态势复盘类应用。", CreatedAt: now,
	}
	if err := st.AddClarificationMessage(context.Background(), msg); err != nil {
		t.Fatalf("AddClarificationMessage: %v", err)
	}
	msgs, err := st.ListClarificationMessages(context.Background(), "clar_1")
	if err != nil {
		t.Fatalf("ListClarificationMessages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Kind != "analysis_work_log" {
		t.Fatalf("messages = %#v", msgs)
	}
}
```

- [ ] **Step 4: Run tests and verify they fail**

Run:

```bash
cd factory-server && go test ./internal/store -run Clarification
```

Expected: FAIL because store methods are undefined.

- [ ] **Step 5: Implement store methods**

Create `factory-server/internal/store/clarifications.go` with:

```go
package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Store) CreateClarificationSession(ctx context.Context, cs model.ClarificationSession) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clarification_sessions(id,status,initial_prompt,round,max_rounds,requirement_json,created_job_id,error_code,error_message,created_at,updated_at,confirmed_at,abandoned_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		cs.ID, string(cs.Status), cs.InitialPrompt, cs.Round, cs.MaxRounds, cs.RequirementJSON,
		cs.CreatedJobID, cs.ErrorCode, cs.ErrorMessage, ms(cs.CreatedAt), ms(cs.UpdatedAt),
		nullableMs(cs.ConfirmedAt), nullableMs(cs.AbandonedAt))
	return err
}

func (s *Store) GetClarificationSession(ctx context.Context, id string) (*model.ClarificationSession, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id,status,initial_prompt,round,max_rounds,requirement_json,created_job_id,error_code,error_message,created_at,updated_at,confirmed_at,abandoned_at
FROM clarification_sessions WHERE id = ?`, id)
	return scanClarificationSession(row)
}

func (s *Store) GetActiveClarificationSession(ctx context.Context) (*model.ClarificationSession, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id,status,initial_prompt,round,max_rounds,requirement_json,created_job_id,error_code,error_message,created_at,updated_at,confirmed_at,abandoned_at
FROM clarification_sessions
WHERE status IN (?,?,?)
ORDER BY updated_at DESC LIMIT 1`,
		string(model.ClarificationStatusActive),
		string(model.ClarificationStatusWaitingUser),
		string(model.ClarificationStatusReadyToConfirm))
	return scanClarificationSession(row)
}

func (s *Store) UpdateClarificationRequirement(ctx context.Context, id, requirementJSON string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions SET requirement_json = ?, updated_at = ? WHERE id = ?`,
		requirementJSON, ms(time.Now()), id)
	return err
}

func (s *Store) SetClarificationStatus(ctx context.Context, id string, status model.ClarificationStatus, code, message string) error {
	now := time.Now()
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions
SET status = ?, error_code = ?, error_message = ?, updated_at = ?,
    confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
    abandoned_at = CASE WHEN ? = 'abandoned' THEN ? ELSE abandoned_at END
WHERE id = ?`,
		string(status), code, message, ms(now), string(status), ms(now), string(status), ms(now), id)
	return err
}

func (s *Store) LinkClarificationJob(ctx context.Context, id, jobID string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions SET created_job_id = ?, updated_at = ? WHERE id = ?`,
		jobID, ms(time.Now()), id)
	return err
}

func (s *Store) AddClarificationMessage(ctx context.Context, msg model.ClarificationMessage) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clarification_messages(id,session_id,role,kind,content,metadata_json,created_at)
VALUES(?,?,?,?,?,?,?)`,
		msg.ID, msg.SessionID, msg.Role, msg.Kind, msg.Content, msg.MetadataJSON, ms(msg.CreatedAt))
	return err
}

func (s *Store) ListClarificationMessages(ctx context.Context, sessionID string) ([]model.ClarificationMessage, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id,session_id,role,kind,content,metadata_json,created_at
FROM clarification_messages WHERE session_id = ? ORDER BY created_at ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ClarificationMessage{}
	for rows.Next() {
		var m model.ClarificationMessage
		var created int64
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Kind, &m.Content, &m.MetadataJSON, &created); err != nil {
			return nil, err
		}
		m.CreatedAt = time.UnixMilli(created)
		out = append(out, m)
	}
	return out, rows.Err()
}

func scanClarificationSession(sc scanner) (*model.ClarificationSession, error) {
	var s model.ClarificationSession
	var status string
	var created, updated int64
	var confirmed, abandoned sql.NullInt64
	err := sc.Scan(&s.ID, &status, &s.InitialPrompt, &s.Round, &s.MaxRounds,
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

- [ ] **Step 6: Verify store tests pass**

Run:

```bash
cd factory-server && go test ./internal/store -run Clarification
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/clarifications.go factory-server/internal/store/clarifications_test.go
git commit -m "feat: store clarification sessions"
```

## Task 3: Add Clarification Contracts And Real Claude Runner

**Files:**
- Create: `factory-server/internal/clarification/contracts.go`
- Create: `factory-server/internal/clarification/runner.go`
- Create: `factory-server/internal/clarification/runner_test.go`

- [ ] **Step 1: Define contracts**

Create `factory-server/internal/clarification/contracts.go`:

```go
package clarification

type Option struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Reason      string `json:"reason"`
	Recommended bool   `json:"recommended,omitempty"`
}

type Question struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	Question       string   `json:"question"`
	Required       bool     `json:"required"`
	Recommendation string   `json:"recommendation"`
	Options        []Option `json:"options"`
	AllowCustom    bool     `json:"allowCustom"`
}

type WorkLog struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

type Requirement struct {
	AppType           string              `json:"appType"`
	AppName           string              `json:"appName"`
	TargetUsers       []string            `json:"targetUsers"`
	CoreScenario      string              `json:"coreScenario"`
	PrimaryView       string              `json:"primaryView"`
	MainEntities      []string            `json:"mainEntities"`
	DataPolicy        string              `json:"dataPolicy"`
	AcceptanceFocus   []string            `json:"acceptanceFocus"`
	GenerationProfile map[string][]string `json:"generationProfile"`
}

type RoundInput struct {
	SessionID       string        `json:"sessionId"`
	Round           int           `json:"round"`
	MaxRounds       int           `json:"maxRounds"`
	InitialPrompt   string        `json:"initialPrompt"`
	Messages        []MessageView `json:"messages"`
	CurrentRequirement Requirement `json:"currentRequirement"`
}

type MessageView struct {
	Role    string `json:"role"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
}

type RoundOutput struct {
	Status      string      `json:"status"`
	Round       int         `json:"round"`
	WorkLog     []WorkLog   `json:"workLog"`
	Questions   []Question  `json:"questions"`
	Requirement Requirement `json:"requirement"`
}

type StreamEvent struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	MessageID string `json:"message_id,omitempty"`
	Delta     string `json:"delta,omitempty"`
	Data      any    `json:"data,omitempty"`
}
```

- [ ] **Step 2: Write runner tests**

Create `factory-server/internal/clarification/runner_test.go`:

```go
package clarification

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

type fakeCommandRunner struct {
	dir  string
	name string
	args []string
}

func (f *fakeCommandRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	f.dir, f.name, f.args = dir, name, args
	out := RoundOutput{
		Status: "ready_to_confirm",
		Round:  1,
		WorkLog: []WorkLog{{Type: "analysis", Content: "识别到这是态势复盘类应用。"}},
		Requirement: Requirement{
			AppType: "situation_replay", AppName: "航母编队月度航迹复盘",
			TargetUsers: []string{"态势分析人员"}, CoreScenario: "复盘近 1 个月航迹",
			PrimaryView: "地图 + 时间轴", MainEntities: []string{"编队", "事件"},
			DataPolicy: "mock_data", AcceptanceFocus: []string{"轨迹联动"},
			GenerationProfile: map[string][]string{
				"base":    []string{"software-factory-app"},
				"domain":  []string{"defense-operations-ui"},
				"pattern": []string{"map-timeline-replay"},
			},
		},
	}
	b, _ := json.Marshal(out)
	return runner.CommandResult{Stdout: string(b), ExitCode: 0}, nil
}

func TestRunnerWritesArtifactsAndNormalizesEvents(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_1", Round: 1, MaxRounds: 3, InitialPrompt: "生成航母复盘应用",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.Status != "ready_to_confirm" {
		t.Fatalf("status = %s", out.Status)
	}
	if fr.name != "claude" {
		t.Fatalf("command = %s", fr.name)
	}
	for _, rel := range []string{"input.json", "prompt.md", "output.json", "stdout.log", "stderr.log", "stream.jsonl"} {
		if _, err := os.Stat(filepath.Join(root, ".factory-runs", "clarifications", "clar_1", "round-1", rel)); err != nil {
			t.Fatalf("missing %s: %v", rel, err)
		}
	}
	if len(events) == 0 {
		t.Fatalf("expected normalized events")
	}
}
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
cd factory-server && go test ./internal/clarification
```

Expected: FAIL because package implementation is missing.

- [ ] **Step 4: Implement runner**

Create `factory-server/internal/clarification/runner.go`:

```go
package clarification

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

type Runner struct {
	Cmd           runner.CommandRunner
	Binary        string
	WorkspaceRoot string
	ArtifactRoot  string
}

func (r Runner) RunRound(ctx context.Context, input RoundInput, emit func(StreamEvent)) (RoundOutput, error) {
	dir := filepath.Join(r.artifactRoot(), "clarifications", input.SessionID, fmt.Sprintf("round-%d", input.Round))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return RoundOutput{}, err
	}
	in, _ := json.MarshalIndent(input, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "input.json"), in, 0o644); err != nil {
		return RoundOutput{}, err
	}
	prompt := r.prompt()
	if err := os.WriteFile(filepath.Join(dir, "prompt.md"), []byte(prompt), 0o644); err != nil {
		return RoundOutput{}, err
	}
	res, err := r.Cmd.Run(ctx, r.workspaceRoot(), r.binary(), "--print", "--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write")
	_ = os.WriteFile(filepath.Join(dir, "stdout.log"), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "stderr.log"), []byte(res.Stderr), 0o644)
	if err != nil {
		return RoundOutput{}, err
	}
	if res.ExitCode != 0 {
		return RoundOutput{}, fmt.Errorf("claude exit %d", res.ExitCode)
	}
	var out RoundOutput
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		return RoundOutput{}, fmt.Errorf("decode clarification output: %w", err)
	}
	outBytes, _ := json.MarshalIndent(out, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "output.json"), outBytes, 0o644); err != nil {
		return RoundOutput{}, err
	}
	events := normalizeEvents(input.SessionID, out)
	if err := writeStream(filepath.Join(dir, "stream.jsonl"), events); err != nil {
		return RoundOutput{}, err
	}
	for _, ev := range events {
		emit(ev)
	}
	return out, nil
}

func (r Runner) prompt() string {
	return "Use .claude/skills/requirement-clarification/SKILL.md. Read input.json from the clarification round artifact directory if needed. Output ONLY valid JSON matching the requirement clarification contract."
}

func normalizeEvents(sessionID string, out RoundOutput) []StreamEvent {
	events := []StreamEvent{}
	for i, wl := range out.WorkLog {
		id := fmt.Sprintf("worklog_%d", i+1)
		events = append(events,
			StreamEvent{Type: "clarification.message.started", SessionID: sessionID, MessageID: id, Data: wl},
			StreamEvent{Type: "clarification.message.delta", SessionID: sessionID, MessageID: id, Delta: wl.Content},
			StreamEvent{Type: "clarification.message.completed", SessionID: sessionID, MessageID: id, Data: wl},
		)
	}
	for _, q := range out.Questions {
		events = append(events, StreamEvent{Type: "clarification.question.created", SessionID: sessionID, Data: q})
	}
	events = append(events, StreamEvent{Type: "clarification.summary.updated", SessionID: sessionID, Data: out.Requirement})
	if out.Status == "ready_to_confirm" {
		events = append(events, StreamEvent{Type: "clarification.ready_to_confirm", SessionID: sessionID, Data: out.Requirement})
	}
	return events
}

func writeStream(path string, events []StreamEvent) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, ev := range events {
		b, _ := json.Marshal(ev)
		if _, err := w.Write(append(b, '\n')); err != nil {
			return err
		}
	}
	return w.Flush()
}

func (r Runner) binary() string {
	if r.Binary == "" {
		return "claude"
	}
	return r.Binary
}

func (r Runner) workspaceRoot() string {
	if r.WorkspaceRoot == "" {
		return "."
	}
	return r.WorkspaceRoot
}

func (r Runner) artifactRoot() string {
	if r.ArtifactRoot == "" {
		return ".factory-runs"
	}
	return r.ArtifactRoot
}
```

- [ ] **Step 5: Verify runner tests pass**

Run:

```bash
cd factory-server && go test ./internal/clarification
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/clarification
git commit -m "feat: run clarification rounds through claude"
```

## Task 4: Add Clarification REST API And SSE Events

**Files:**
- Create: `factory-server/internal/server/clarification_handlers.go`
- Create: `factory-server/internal/server/clarification_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/server/events.go`

- [ ] **Step 1: Add server dependency**

Add a field to `Server` in `factory-server/internal/server/server.go`:

```go
clarifier clarification.Runner
```

Import:

```go
github.com/weimengtsgit/xian630/factory-server/internal/clarification
```

Initialize in `New`:

```go
s.clarifier = clarification.Runner{
	Cmd:           claudeCmd,
	WorkspaceRoot: cfg.WorkspaceRoot,
	ArtifactRoot:  cfg.ArtifactRoot,
}
```

- [ ] **Step 2: Add routes**

In `routes()`:

```go
r.Handle("POST", "/api/clarifications", s.createClarification)
r.Handle("GET", "/api/clarifications/:id", s.getClarification)
r.Handle("GET", "/api/clarifications/:id/messages", s.listClarificationMessages)
r.Handle("POST", "/api/clarifications/:id/messages", s.addClarificationMessage)
r.Handle("POST", "/api/clarifications/:id/answers", s.answerClarification)
r.Handle("PATCH", "/api/clarifications/:id/requirement", s.patchClarificationRequirement)
r.Handle("POST", "/api/clarifications/:id/retry-current-round", s.retryClarificationRound)
r.Handle("POST", "/api/clarifications/:id/confirm", s.confirmClarification)
r.Handle("POST", "/api/clarifications/:id/abandon", s.abandonClarification)
```

- [ ] **Step 3: Write handler tests**

Create `factory-server/internal/server/clarification_handlers_test.go` with tests for:

```go
func TestCreateClarificationDoesNotCreateJob(t *testing.T)
func TestAnswerClarificationAddsMessageAndRunsRound(t *testing.T)
func TestConfirmClarificationCreatesQueuedJob(t *testing.T)
func TestFailedClarificationDoesNotCreateJob(t *testing.T)
```

The first test body must assert:

```go
req := httptest.NewRequest(http.MethodPost, "/api/clarifications", strings.NewReader(`{"prompt":"生成一个航母编队复盘应用"}`))
rec := httptest.NewRecorder()
router.ServeHTTP(rec, req)
if rec.Code != http.StatusCreated {
	t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
}
jobs, err := srv.store.ListJobs(context.Background(), "")
if err != nil {
	t.Fatalf("ListJobs: %v", err)
}
if len(jobs) != 0 {
	t.Fatalf("jobs = %#v, want none before confirmation", jobs)
}
```

- [ ] **Step 4: Run tests and verify they fail**

Run:

```bash
cd factory-server && go test ./internal/server -run Clarification
```

Expected: FAIL because handlers are missing.

- [ ] **Step 5: Implement handlers**

Create `factory-server/internal/server/clarification_handlers.go`. Implement these behaviors:

```go
type createClarificationBody struct {
	Prompt string `json:"prompt"`
}

type clarificationAnswerBody struct {
	Content string `json:"content"`
	Answer  string `json:"answer"`
}

type patchRequirementBody struct {
	Requirement json.RawMessage `json:"requirement"`
}
```

Required handler rules:

- `createClarification` rejects empty prompt.
- `createClarification` abandons any active clarification session before creating a new one only when request body includes `"abandonActive": true`; otherwise it returns `409`.
- `createClarification` creates a session and user message, publishes `clarification.created`, then runs round 1 through real clarifier.
- `addClarificationMessage` appends user input and runs the next round.
- `answerClarification` stores structured answer metadata and updates `requirement_json`.
- `patchClarificationRequirement` only accepts business fields and recomputes `generationProfile`.
- `retryClarificationRound` reruns the same round.
- `abandonClarification` sets status `abandoned`.
- `confirmClarification` validates required fields, creates Job + steps, links `created_job_id`, sets status `confirmed`, publishes `clarification.confirmed` and `job.created`, then calls `s.exec.Signal()`.

Use a helper:

```go
func (s *Server) publishClarificationEvent(ev clarification.StreamEvent) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(Event{Type: ev.Type, Data: ev})
}
```

- [ ] **Step 6: Extend SSE client event list**

No backend code change is needed for `events.go` because the Hub already supports arbitrary event types. Keep this step as a verification point: use `publishClarificationEvent` for every normalized event from the runner.

- [ ] **Step 7: Verify server tests pass**

Run:

```bash
cd factory-server && go test ./internal/server -run Clarification
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add factory-server/internal/server/server.go factory-server/internal/server/clarification_handlers.go factory-server/internal/server/clarification_handlers_test.go
git commit -m "feat: add clarification API"
```

## Task 5: Confirmed Requirement Job Creation And Step Contracts

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/jobs.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/runner/contracts.go`
- Modify: `factory-server/internal/runner/contracts_test.go`

- [ ] **Step 1: Extend Job model**

Add to `model.Job`:

```go
ClarificationSessionID  string `json:"clarification_session_id,omitempty"`
ConfirmedRequirementJSON string `json:"confirmed_requirement_json,omitempty"`
```

- [ ] **Step 2: Update job insert/select**

In `store.CreateJob`, include `clarification_session_id` and `confirmed_requirement_json`.

Update `jobSelectCols` and `scanJob` to read those fields.

- [ ] **Step 3: Restrict direct job creation**

Change `createJob` in `factory-server/internal/server/job_handlers.go`:

```go
if body.Prompt != "" && body.ConfirmedRequirementJSON == "" {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"error": "jobs must be created from confirmed clarification requirements",
		"error_code": "confirmed_requirement_required",
	})
	return
}
```

Add this request body:

```go
type createJobBody struct {
	Prompt string `json:"prompt"`
	ClarificationSessionID string `json:"clarification_session_id"`
	ConfirmedRequirementJSON string `json:"confirmed_requirement_json"`
}
```

Keep `confirmClarification` as the normal creation path.

- [ ] **Step 4: Update requirement analysis prompt**

Change `ClaudeStepRunner.prompt` for `StepRequirementAnalysis`:

```go
return "你是软件工厂的需求冻结 agent。读取 input.json 中的 confirmedRequirement，校验字段完整性、能力边界和 generationProfile。完整性只检查业务确认字段；primaryView 和 dataPolicy 属于后续界面解析/数据抓取阶段，可为空。输出 output.json，包含 confirmedRequirementId、summary、appType、appName、targetUsers、coreScenario、primaryView、mainEntities、dataPolicy、acceptanceFocus、generationProfile、constraints、risks、validation。不要进行多轮澄清，不要输出隐藏推理链。"
```

Update the input marshal in `ClaudeStepRunner.Run` to include:

```go
"confirmedRequirement": json.RawMessage(job.ConfirmedRequirementJSON),
```

- [ ] **Step 5: Update requirement contract validator**

In `runner/contracts.go`, replace `requirementAnalysisOutput` with:

```go
type requirementAnalysisOutput struct {
	ConfirmedRequirementID string              `json:"confirmedRequirementId"`
	Summary                string              `json:"summary"`
	AppType                string              `json:"appType"`
	AppName                string              `json:"appName"`
	TargetUsers            []string            `json:"targetUsers"`
	CoreScenario           string              `json:"coreScenario"`
	PrimaryView            string              `json:"primaryView"`
	MainEntities           []string            `json:"mainEntities"`
	DataPolicy             string              `json:"dataPolicy"`
	AcceptanceFocus        []string            `json:"acceptanceFocus"`
	GenerationProfile      map[string][]string `json:"generationProfile"`
	Constraints            []string            `json:"constraints"`
	Risks                  []string            `json:"risks"`
	Validation             struct {
		Complete            bool     `json:"complete"`
		Supported           bool     `json:"supported"`
		MissingFields       []string `json:"missingFields"`
		UnsupportedRequests []string `json:"unsupportedRequests"`
	} `json:"validation"`
}
```

Validation rules:

```go
if !raw.Validation.Complete || !raw.Validation.Supported {
	return StepOutput{}, fmt.Errorf("confirmed requirement rejected: %w", ErrSchemaValidationFailed)
}
if raw.AppType == "" || raw.AppName == "" || len(raw.GenerationProfile) == 0 {
	return StepOutput{}, fmt.Errorf("missing required requirement fields: %w", ErrSchemaValidationFailed)
}
```

- [ ] **Step 6: Update tests**

In `runner/contracts_test.go`, add:

```go
func TestValidateRequirementAnalysisRequiresFrozenRequirement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output.json")
	if err := os.WriteFile(path, []byte(`{
	  "confirmedRequirementId":"clar_1",
	  "summary":"复盘近 1 个月东海方向航母编队航迹",
	  "appType":"situation_replay",
	  "appName":"航母编队月度航迹复盘",
	  "targetUsers":["态势分析人员"],
	  "coreScenario":"复盘近 1 个月航迹",
	  "primaryView":"地图 + 时间轴",
	  "mainEntities":["编队","事件"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["轨迹联动"],
	  "generationProfile":{"base":["software-factory-app"],"domain":["defense-operations-ui"],"pattern":["map-timeline-replay"]},
	  "constraints":["React + Vite"],
	  "risks":["真实数据未接入"],
	  "validation":{"complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[]}
	}`), 0644); err != nil {
		t.Fatal(err)
	}
	out, err := ValidateRequirementAnalysis(path)
	if err != nil {
		t.Fatalf("ValidateRequirementAnalysis: %v", err)
	}
	if out.NeedsUserInput {
		t.Fatalf("NeedsUserInput = true, want false")
	}
}
```

- [ ] **Step 7: Verify backend tests**

Run:

```bash
cd factory-server && go test ./internal/runner ./internal/executor ./internal/server ./internal/store
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/jobs.go factory-server/internal/server/job_handlers.go factory-server/internal/executor/claude_runner.go factory-server/internal/runner/contracts.go factory-server/internal/runner/contracts_test.go
git commit -m "feat: create jobs from confirmed requirements"
```

## Task 6: Inject Generation Profile Into Solution And Code Generation

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/runner/contracts.go`
- Modify: `factory-server/internal/runner/contracts_test.go`

- [ ] **Step 1: Add skill catalog helper**

In `executor/claude_runner.go`, add:

```go
func selectedSkillPaths(workspace string, profile map[string][]string) []string {
	keys := []string{}
	for _, group := range []string{"base", "domain", "pattern"} {
		keys = append(keys, profile[group]...)
	}
	out := []string{}
	for _, key := range keys {
		out = append(out, filepath.ToSlash(filepath.Join(workspace, ".claude", "skills", key, "SKILL.md")))
	}
	return out
}
```

- [ ] **Step 2: Include skills in prompts**

For `solution_design` and `code_generation`, prompt text must include:

```text
Use the generationProfile from input.json. Load and follow these project-local skills before producing output:
- .claude/skills/software-factory-app/SKILL.md
- .claude/skills/defense-operations-ui/SKILL.md
- .claude/skills/<pattern>/SKILL.md

If a required skill is missing, report it in output.json warnings. Do not choose unrelated skills.
```

- [ ] **Step 3: Require usedSkills in output contracts**

Extend solution and code generation output structs:

```go
UsedSkills []string `json:"usedSkills"`
Warnings   []string `json:"warnings,omitempty"`
```

Validation rule:

```go
if len(raw.UsedSkills) == 0 {
	return StepOutput{}, fmt.Errorf("usedSkills required: %w", ErrSchemaValidationFailed)
}
```

- [ ] **Step 4: Add contract tests**

Add tests that a code generation output without `usedSkills` fails with `ErrSchemaValidationFailed`, and with `usedSkills` passes.

- [ ] **Step 5: Verify runner tests**

Run:

```bash
cd factory-server && go test ./internal/runner ./internal/executor
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/executor/claude_runner.go factory-server/internal/runner/contracts.go factory-server/internal/runner/contracts_test.go
git commit -m "feat: inject generation profile skills"
```

## Task 7: Update Portal API, SSE, And Clarification UI

**Files:**
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/api/events.js`
- Create: `sf-portal-mvp/src/hooks/useClarification.js`
- Create: `sf-portal-mvp/src/components/ClarificationPanel.jsx`
- Create: `sf-portal-mvp/src/components/ClarificationPanel.css`
- Modify: `sf-portal-mvp/src/components/ChatDialog.jsx`
- Modify: `sf-portal-mvp/src/components/ChatDialog.css`
- Modify: `sf-portal-mvp/src/App.jsx`

- [ ] **Step 1: Add client methods**

Add to `factoryApi`:

```js
createClarification: prompt => request('/api/clarifications', { method: 'POST', body: JSON.stringify({ prompt }) }),
getClarification: id => request(`/api/clarifications/${id}`),
getClarificationMessages: id => request(`/api/clarifications/${id}/messages`),
sendClarificationMessage: (id, content) => request(`/api/clarifications/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
answerClarification: (id, answer) => request(`/api/clarifications/${id}/answers`, { method: 'POST', body: JSON.stringify(answer) }),
patchClarificationRequirement: (id, requirement) => request(`/api/clarifications/${id}/requirement`, { method: 'PATCH', body: JSON.stringify({ requirement }) }),
retryClarificationRound: id => request(`/api/clarifications/${id}/retry-current-round`, { method: 'POST' }),
confirmClarification: id => request(`/api/clarifications/${id}/confirm`, { method: 'POST' }),
abandonClarification: id => request(`/api/clarifications/${id}/abandon`, { method: 'POST' }),
```

- [ ] **Step 2: Subscribe to clarification SSE types**

Update `src/api/events.js`:

```js
const types = [
  'app.updated',
  'job.created',
  'job.updated',
  'step.updated',
  'artifact.created',
  'deployment.updated',
  'clarification.created',
  'clarification.message.started',
  'clarification.message.delta',
  'clarification.message.completed',
  'clarification.question.created',
  'clarification.summary.updated',
  'clarification.ready_to_confirm',
  'clarification.confirmed',
]
```

- [ ] **Step 3: Add hook**

Create `sf-portal-mvp/src/hooks/useClarification.js`:

```js
import { useCallback, useEffect, useRef, useState } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'

export function useClarification() {
  const [session, setSession] = useState(null)
  const [messages, setMessages] = useState([])
  const [questions, setQuestions] = useState([])
  const [requirement, setRequirement] = useState(null)
  const [error, setError] = useState(null)
  const mounted = useRef(true)

  const create = useCallback(async prompt => {
    setError(null)
    const s = await factoryApi.createClarification(prompt)
    if (!mounted.current) return s
    setSession(s)
    return s
  }, [])

  const send = useCallback(async content => {
    if (!session) return create(content)
    return factoryApi.sendClarificationMessage(session.id, content)
  }, [session, create])

  const answer = useCallback(async (questionId, value) => {
    if (!session) return null
    return factoryApi.answerClarification(session.id, { questionId, value })
  }, [session])

  const confirm = useCallback(async () => {
    if (!session) return null
    const result = await factoryApi.confirmClarification(session.id)
    if (mounted.current) setSession(result.session || result)
    return result
  }, [session])

  const retry = useCallback(async () => {
    if (!session) return null
    return factoryApi.retryClarificationRound(session.id)
  }, [session])

  const abandon = useCallback(async () => {
    if (!session) return null
    const result = await factoryApi.abandonClarification(session.id)
    if (mounted.current) setSession(result)
    return result
  }, [session])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = subscribeFactoryEvents((type, ev) => {
      const data = ev.data || ev
      if (type === 'clarification.created') setSession(data)
      if (type === 'clarification.message.delta') {
        setMessages(prev => [...prev, { id: data.message_id, role: 'agent', kind: 'analysis_work_log', content: data.delta }])
      }
      if (type === 'clarification.question.created') setQuestions(prev => [...prev, data.data])
      if (type === 'clarification.summary.updated') setRequirement(data.data)
      if (type === 'clarification.ready_to_confirm') {
        setRequirement(data.data)
        setSession(prev => prev ? { ...prev, status: 'ready_to_confirm' } : prev)
      }
      if (type === 'clarification.confirmed') setSession(data)
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [])

  return { session, messages, questions, requirement, error, create, send, answer, confirm, retry, abandon }
}
```

- [ ] **Step 4: Add clarification panel**

Create `ClarificationPanel.jsx` with:

```jsx
import './ClarificationPanel.css'

export function ClarificationPanel({ session, messages, questions, requirement, onAnswer, onConfirm, onRetry, onAbandon }) {
  if (!session) {
    return (
      <section className="clar-panel empty">
        <span>输入需求后，需求分析 agent 会先进行澄清，不会立即生成任务。</span>
      </section>
    )
  }

  return (
    <section className="clar-panel">
      <header className="clar-header">
        <span>需求澄清</span>
        <strong>{statusText(session.status)}</strong>
      </header>

      <div className="clar-scroll">
        {messages.map((m, i) => (
          <div key={`${m.id || i}-${i}`} className={`clar-message ${m.kind || ''}`}>{m.content}</div>
        ))}

        {questions.map(q => (
          <div key={q.id} className="clar-question">
            <div className="clar-question-title">{q.label || q.question}</div>
            <div className="clar-options">
              {(q.options || []).map(opt => (
                <button key={opt.value} type="button" onClick={() => onAnswer(q.id, opt.value)}>
                  <span>{opt.label}</span>
                  {opt.recommended && <em>推荐</em>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {requirement && (
        <div className="clar-summary">
          <strong>确认需求摘要</strong>
          <span>应用类型：{requirement.appType || '待确认'}</span>
          <span>应用名称：{requirement.appName || '待确认'}</span>
          <span>核心场景：{requirement.coreScenario || '待确认'}</span>
        </div>
      )}

      <footer className="clar-actions">
        {session.status === 'failed' && <button type="button" onClick={onRetry}>重试本轮</button>}
        <button type="button" onClick={onAbandon}>放弃</button>
        <button type="button" className="primary" disabled={session.status !== 'ready_to_confirm'} onClick={onConfirm}>
          确认并生成
        </button>
      </footer>
    </section>
  )
}

function statusText(status) {
  return {
    active: '澄清中',
    waiting_user: '等待补充',
    ready_to_confirm: '待确认',
    confirmed: '已确认',
    failed: '已失败',
    abandoned: '已放弃',
  }[status] || status
}
```

- [ ] **Step 5: Wire App**

In `App.jsx`:

```jsx
const clarification = useClarification()

const submitChat = prompt => {
  return clarification.send(prompt)
}
```

Render `ClarificationPanel` between `JobCenter` and `ChatDialog`:

```jsx
<ClarificationPanel
  session={clarification.session}
  messages={clarification.messages}
  questions={clarification.questions}
  requirement={clarification.requirement}
  onAnswer={(id, value) => clarification.answer(id, value)}
  onConfirm={clarification.confirm}
  onRetry={clarification.retry}
  onAbandon={clarification.abandon}
/>
```

- [ ] **Step 6: CSS constraints**

In `ClarificationPanel.css`, keep the panel height bounded:

```css
.clar-panel {
  flex: 1;
  min-height: 0;
  max-height: 360px;
  display: flex;
  flex-direction: column;
  background: rgba(11, 29, 44, 0.82);
  border: 1px solid rgba(111, 218, 255, 0.2);
  border-radius: 8px;
  overflow: hidden;
}
.clar-scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}
.clar-summary {
  display: grid;
  gap: 4px;
  padding: 10px;
  border-top: 1px solid rgba(111, 218, 255, 0.18);
  font-size: 12px;
}
.clar-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 10px;
}
```

- [ ] **Step 7: Verify frontend build**

Run:

```bash
cd sf-portal-mvp && npm run test:logic && npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add sf-portal-mvp/src
git commit -m "feat: add clarification portal flow"
```

## Task 8: Runbook And End-To-End Verification

**Files:**
- Modify: `docs/software-factory-local-runbook.md`
- Modify: `factory-server/README.md`

- [ ] **Step 1: Update runbook**

Add a section to `docs/software-factory-local-runbook.md`:

````md
## Requirement Clarification Flow

The portal no longer creates a generation job from the first chat message. The first message creates a clarification session.

1. Start `cc-status`.
2. Start `factory-server` without `FACTORY_FAKE_CLAUDE=1` when testing the real clarification runner.
3. Start `sf-portal-mvp`.
4. In the chat input, enter: `生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用`.
5. Confirm that the center clarification panel streams analysis work logs and structured option cards.
6. Select or confirm the recommended options.
7. Click `确认并生成`.
8. Confirm that a Job appears only after confirmation.
9. Confirm that the generated app is deployed and shown in the application list.

Audit files:

```text
factory-server/.factory-runs/clarifications/<session-id>/round-1/
factory-server/.factory-runs/jobs/<job-id>/requirement_analysis/attempt-1/
```
````

- [ ] **Step 2: Update factory-server README**

Clarify:

```md
`FACTORY_FAKE_CLAUDE=1` still fakes the generation pipeline steps for local deterministic testing. The requirement clarification product path is intended to use the real local Claude Code CLI so streaming, option generation, and requirement summaries exercise the same runner shape used in production-like local runs.
```

- [ ] **Step 3: Full backend verification**

Run:

```bash
cd factory-server
gofmt -w internal
go test ./...
go vet ./...
go build -o bin/factory-server ./cmd/factory-server
```

Expected: all commands exit 0.

- [ ] **Step 4: Full frontend verification**

Run:

```bash
cd sf-portal-mvp
npm run test:logic
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Manual API verification**

Run with factory-server listening on `127.0.0.1:8787`:

```bash
curl -sS http://127.0.0.1:8787/api/clarifications \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用"}'
```

Expected:

```json
{
  "id": "clar_...",
  "status": "waiting_user"
}
```

Then confirm no job exists before confirmation:

```bash
curl -sS http://127.0.0.1:8787/api/jobs
```

Expected: no newly queued job for the prompt until `/confirm` is called.

- [ ] **Step 6: Commit**

```bash
git add docs/software-factory-local-runbook.md factory-server/README.md
git commit -m "docs: document clarification runner flow"
```

## Self-Review Checklist

- Clarification is separate from Job until confirmation: Task 2, Task 4, Task 5.
- Real Claude Code clarification runner is used in product path: Task 3, Task 4.
- Project-local skills and generation profile are documented and created: Task 1, Task 6.
- SSE events are normalized by Factory, not raw Claude stdout: Task 3, Task 4, Task 7.
- `.factory-runs/clarifications/<session-id>/` audit directory is implemented: Task 3.
- Failed clarification does not create Job or app card: Task 4.
- Manual requirement edit excludes direct `generationProfile` editing: Task 4.
- Portal first chat message creates clarification, not Job: Task 7.
- Full verification commands are listed: Task 8.
