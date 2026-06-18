# Software Factory MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local single-user software factory MVP described in `docs/software-factory-mvp-design.md`: scan preset apps, run/deploy apps with Podman, create generation jobs, execute fixed steps, and wire `sf-portal` to real Factory APIs.

**Architecture:** Add a new `factory-server` Go service modeled after `cc-status`: small `cmd` entrypoint, SQLite store, net/http REST + SSE server, focused internal packages for scanning, jobs, runners, deployment, and `cc-status` integration. Keep `cc-status` as a separate observation service and keep `sf-portal` as the React/Vite UI client.

**Tech Stack:** Go 1.21-compatible server code, `modernc.org/sqlite`, standard-library HTTP/SSE, React/Vite portal, local Podman CLI, local Claude Code CLI, SQLite.

---

## Execution Rules

- Do not mix this work with existing unrelated dirty files.
- Before executing tasks, create an isolated branch or worktree through `superpowers:using-git-worktrees`, or stage only exact files listed in each task.
- Keep `cc-status` independent; do not move Factory orchestration code into `cc-status`.
- Do not edit `scene/**` application source while implementing Factory. Only read manifests and run app build/deploy operations.
- Use `docs/software-factory-mvp-design.md` as the source of truth when a field name or state is unclear.
- Run the verification command listed in each task before moving to the next task.
- Commit after each task only when the working tree contains exactly that task's intended files.

## File Structure Map

Create these new backend files:

```text
factory-server/
  go.mod
  Makefile
  README.md
  cmd/factory-server/main.go
  internal/config/config.go
  internal/model/model.go
  internal/store/schema.sql
  internal/store/store.go
  internal/store/applications.go
  internal/store/agents.go
  internal/store/jobs.go
  internal/store/deployments.go
  internal/server/router.go
  internal/server/server.go
  internal/server/events.go
  internal/server/app_handlers.go
  internal/server/agent_handlers.go
  internal/server/job_handlers.go
  internal/server/artifact_handlers.go
  internal/scanner/manifest.go
  internal/scanner/scanner.go
  internal/agents/registry.go
  internal/executor/executor.go
  internal/executor/steps.go
  internal/runner/claude.go
  internal/runner/artifacts.go
  internal/runner/contracts.go
  internal/deploy/ports.go
  internal/deploy/podman.go
  internal/deploy/health.go
  internal/ccstatus/client.go
```

Modify these frontend files:

```text
sf-portal/
  src/api/client.js
  src/api/events.js
  src/hooks/useApplications.js
  src/hooks/useAgents.js
  src/hooks/useJobs.js
  src/components/ApplicationsPanel.jsx
  src/components/AgentsPanel.jsx
  src/components/ChatDialog.jsx
  src/App.jsx
  src/App.css
  README.md
```

Update project docs:

```text
README.md
docs/software-factory-mvp-design.md
```

## Task 1: Factory Server Skeleton

**Files:**
- Create: `factory-server/go.mod`
- Create: `factory-server/Makefile`
- Create: `factory-server/README.md`
- Create: `factory-server/cmd/factory-server/main.go`
- Create: `factory-server/internal/config/config.go`
- Create: `factory-server/internal/server/router.go`
- Create: `factory-server/internal/server/server.go`
- Test: `factory-server/internal/config/config_test.go`
- Test: `factory-server/internal/server/router_test.go`

- [ ] **Step 1: Write config tests**

Create `factory-server/internal/config/config_test.go`:

```go
package config

import (
	"path/filepath"
	"testing"
	"time"
)

func TestResolveDefaults(t *testing.T) {
	cfg := Resolve(nil)
	if cfg.Addr != "127.0.0.1:8787" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	if filepath.Base(filepath.Dir(cfg.DBPath)) != ".software-factory" {
		t.Fatalf("DBPath = %q", cfg.DBPath)
	}
	if cfg.CCStatusBaseURL != "http://127.0.0.1:8765" {
		t.Fatalf("CCStatusBaseURL = %q", cfg.CCStatusBaseURL)
	}
	if cfg.ArtifactRoot != ".factory-runs" {
		t.Fatalf("ArtifactRoot = %q", cfg.ArtifactRoot)
	}
	if cfg.WorkspaceRoot != "." {
		t.Fatalf("WorkspaceRoot = %q", cfg.WorkspaceRoot)
	}
	if cfg.ShutdownTimeout != 5*time.Second {
		t.Fatalf("ShutdownTimeout = %s", cfg.ShutdownTimeout)
	}
}

func TestResolveEnvOverrides(t *testing.T) {
	env := map[string]string{
		"FACTORY_ADDR":              "127.0.0.1:9999",
		"FACTORY_DBPATH":            "/tmp/factory.db",
		"FACTORY_CC_STATUS_BASE_URL": "http://127.0.0.1:7777",
		"FACTORY_ARTIFACT_ROOT":     "/tmp/factory-runs",
		"FACTORY_WORKSPACE_ROOT":    "/tmp/xian630",
	}
	cfg := Resolve(func(k string) string { return env[k] })
	if cfg.Addr != "127.0.0.1:9999" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	if cfg.DBPath != "/tmp/factory.db" {
		t.Fatalf("DBPath = %q", cfg.DBPath)
	}
	if cfg.CCStatusBaseURL != "http://127.0.0.1:7777" {
		t.Fatalf("CCStatusBaseURL = %q", cfg.CCStatusBaseURL)
	}
	if cfg.ArtifactRoot != "/tmp/factory-runs" {
		t.Fatalf("ArtifactRoot = %q", cfg.ArtifactRoot)
	}
	if cfg.WorkspaceRoot != "/tmp/xian630" {
		t.Fatalf("WorkspaceRoot = %q", cfg.WorkspaceRoot)
	}
}
```

- [ ] **Step 2: Run config tests and verify they fail**

Run:

```bash
cd factory-server && go test ./internal/config
```

Expected: FAIL because `Resolve` and `Config` are not defined.

- [ ] **Step 3: Implement config**

Create `factory-server/internal/config/config.go` with:

```go
package config

import (
	"os"
	"path/filepath"
	"time"
)

type Config struct {
	Addr            string
	DBPath          string
	CCStatusBaseURL string
	ArtifactRoot    string
	WorkspaceRoot   string
	ShutdownTimeout time.Duration
}

func Resolve(getenv func(string) string) Config {
	if getenv == nil {
		getenv = os.Getenv
	}
	home, _ := os.UserHomeDir()
	cfg := Config{
		Addr:            "127.0.0.1:8787",
		DBPath:          filepath.Join(home, ".software-factory", "state.db"),
		CCStatusBaseURL: "http://127.0.0.1:8765",
		ArtifactRoot:    ".factory-runs",
		WorkspaceRoot:   ".",
		ShutdownTimeout: 5 * time.Second,
	}
	if v := getenv("FACTORY_ADDR"); v != "" {
		cfg.Addr = v
	}
	if v := getenv("FACTORY_DBPATH"); v != "" {
		cfg.DBPath = v
	}
	if v := getenv("FACTORY_CC_STATUS_BASE_URL"); v != "" {
		cfg.CCStatusBaseURL = v
	}
	if v := getenv("FACTORY_ARTIFACT_ROOT"); v != "" {
		cfg.ArtifactRoot = v
	}
	if v := getenv("FACTORY_WORKSPACE_ROOT"); v != "" {
		cfg.WorkspaceRoot = v
	}
	return cfg
}
```

- [ ] **Step 4: Write router tests**

Create `factory-server/internal/server/router_test.go`:

```go
package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRouterMatchesMethodAndParams(t *testing.T) {
	r := &Router{}
	r.Handle("GET", "/api/apps/:id", func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(Param(req, "id")))
	})

	req := httptest.NewRequest("GET", "/api/apps/app_1", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Body.String() != "app_1" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}
```

- [ ] **Step 5: Implement router and health server**

Copy the tiny method-aware router pattern from `cc-status/internal/server/router.go` into `factory-server/internal/server/router.go`, changing only the package path. Create `factory-server/internal/server/server.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
)

type Server struct {
	cfg config.Config
	srv *http.Server
}

func New(cfg config.Config) *Server {
	return &Server{cfg: cfg}
}

func (s *Server) Start(ctx context.Context) error {
	s.srv = &http.Server{Addr: s.cfg.Addr, Handler: s.routes()}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
		defer cancel()
		_ = s.srv.Shutdown(c)
	}()
	log.Printf("factory-server listening on http://%s", s.cfg.Addr)
	err := s.srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) routes() *Router {
	r := &Router{}
	r.Handle("GET", "/healthz", s.health)
	return r
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}
```

- [ ] **Step 6: Implement command entrypoint and module files**

Create `factory-server/cmd/factory-server/main.go`:

```go
package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg := config.Resolve(nil)
	if err := server.New(cfg).Start(ctx); err != nil {
		log.Fatal(err)
	}
}
```

Create `factory-server/go.mod`:

```go
module github.com/weimengtsgit/xian630/factory-server

go 1.21
```

Create `factory-server/Makefile`:

```make
BINARY := factory-server
PKG    := github.com/weimengtsgit/xian630/factory-server

.PHONY: test vet build fmt

test:
	go test ./...

vet:
	go vet ./...

build:
	go build -o bin/$(BINARY) ./cmd/factory-server

fmt:
	gofmt -w cmd internal
```

Create `factory-server/README.md`:

```markdown
# factory-server

Local orchestration API for the intelligent software factory MVP.

```bash
make test
make build
./bin/factory-server
```

Default API:

- `GET http://127.0.0.1:8787/healthz`
```

- [ ] **Step 7: Verify**

Run:

```bash
cd factory-server && gofmt -w cmd internal && go test ./... && go build -o bin/factory-server ./cmd/factory-server
```

Expected: all tests pass and `factory-server/bin/factory-server` is created.

- [ ] **Step 8: Commit**

```bash
git add factory-server
git commit -m "feat: add factory server skeleton"
```

## Task 2: SQLite Schema And Store

**Files:**
- Create: `factory-server/internal/model/model.go`
- Create: `factory-server/internal/store/schema.sql`
- Create: `factory-server/internal/store/store.go`
- Create: `factory-server/internal/store/applications.go`
- Create: `factory-server/internal/store/agents.go`
- Create: `factory-server/internal/store/jobs.go`
- Create: `factory-server/internal/store/deployments.go`
- Test: `factory-server/internal/store/store_test.go`

- [ ] **Step 1: Add SQLite dependency**

Run:

```bash
cd factory-server && go get modernc.org/sqlite
```

Expected: `go.mod` and `go.sum` include `modernc.org/sqlite`.

- [ ] **Step 2: Write store tests**

Create `factory-server/internal/store/store_test.go` with table-level tests:

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestApplicationUpsertAndList(t *testing.T) {
	st := newTestStore(t)
	app := model.Application{
		ID:           "app_1",
		Slug:         "east-sea-situation",
		Name:         "东海目标态势演示",
		Type:         "map-dashboard",
		Source:       model.AppSourcePreset,
		Description:  "preset scene",
		Path:         "scene/east-sea-situation",
		ManifestPath: "scene/east-sea-situation/.factory/app.json",
		Status:       model.AppStatusStopped,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
	if err := st.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	apps, err := st.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(apps) != 1 || apps[0].Slug != "east-sea-situation" {
		t.Fatalf("apps = %#v", apps)
	}
}

func TestJobWithSteps(t *testing.T) {
	st := newTestStore(t)
	job := model.Job{
		ID:              "job_1",
		UserPrompt:      "生成航母编队月度航迹复盘",
		Status:          model.JobStatusQueued,
		CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	step := model.JobStep{
		ID:       "step_1",
		JobID:    "job_1",
		Kind:     model.StepRequirementAnalysis,
		Seq:      1,
		AgentKey: "requirement-analyst",
		Status:   model.StepStatusPending,
		Attempt:  0,
	}
	if err := st.CreateJobStep(context.Background(), step); err != nil {
		t.Fatalf("create step: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), "job_1")
	if err != nil {
		t.Fatalf("list steps: %v", err)
	}
	if len(steps) != 1 || steps[0].Kind != model.StepRequirementAnalysis {
		t.Fatalf("steps = %#v", steps)
	}
}
```

- [ ] **Step 3: Run store tests and verify they fail**

Run:

```bash
cd factory-server && go test ./internal/store
```

Expected: FAIL because model/store types are not implemented.

- [ ] **Step 4: Implement model types**

Create `factory-server/internal/model/model.go` with enums from the design:

```go
package model

import "time"

type AppSource string
const (
	AppSourcePreset    AppSource = "preset"
	AppSourceGenerated AppSource = "generated"
)

type AppStatus string
const (
	AppStatusStopped AppStatus = "stopped"
	AppStatusRunning AppStatus = "running"
	AppStatusError   AppStatus = "error"
	AppStatusBuilding AppStatus = "building"
	AppStatusMissing AppStatus = "missing"
)

type JobStatus string
const (
	JobStatusDraft       JobStatus = "draft"
	JobStatusQueued      JobStatus = "queued"
	JobStatusRunning     JobStatus = "running"
	JobStatusWaitingUser JobStatus = "waiting_user"
	JobStatusFailed      JobStatus = "failed"
	JobStatusCompleted   JobStatus = "completed"
	JobStatusCanceled    JobStatus = "canceled"
)

type StepKind string
const (
	StepRequirementAnalysis StepKind = "requirement_analysis"
	StepSolutionDesign      StepKind = "solution_design"
	StepCodeGeneration      StepKind = "code_generation"
	StepTestVerification    StepKind = "test_verification"
	StepImageBuild          StepKind = "image_build"
	StepDeployment          StepKind = "deployment"
)

type StepStatus string
const (
	StepStatusPending     StepStatus = "pending"
	StepStatusRunning     StepStatus = "running"
	StepStatusWaitingUser StepStatus = "waiting_user"
	StepStatusSucceeded   StepStatus = "succeeded"
	StepStatusFailed      StepStatus = "failed"
	StepStatusSkipped     StepStatus = "skipped"
	StepStatusCanceled    StepStatus = "canceled"
)

type ErrorCode string
const (
	ErrorRunnerExitNonzero      ErrorCode = "runner_exit_nonzero"
	ErrorRunnerTimeout          ErrorCode = "runner_timeout"
	ErrorOutputMissing          ErrorCode = "output_missing"
	ErrorOutputInvalidJSON      ErrorCode = "output_invalid_json"
	ErrorSchemaValidationFailed ErrorCode = "schema_validation_failed"
	ErrorFileConstraintViolated ErrorCode = "file_constraint_violated"
	ErrorDependencyInstallFailed ErrorCode = "dependency_install_failed"
	ErrorBuildFailed            ErrorCode = "build_failed"
	ErrorImageBuildFailed       ErrorCode = "image_build_failed"
	ErrorPodmanRunFailed        ErrorCode = "podman_run_failed"
	ErrorPortUnavailable        ErrorCode = "port_unavailable"
	ErrorHealthCheckFailed      ErrorCode = "health_check_failed"
	ErrorCCStatusUnavailable    ErrorCode = "cc_status_unavailable"
	ErrorCanceled               ErrorCode = "canceled"
	ErrorUnknown                ErrorCode = "unknown"
)

type Application struct {
	ID           string    `json:"id"`
	Slug         string    `json:"slug"`
	Name         string    `json:"name"`
	Type         string    `json:"type"`
	Source       AppSource `json:"source"`
	Description  string    `json:"description"`
	Path         string    `json:"path"`
	ManifestPath string    `json:"manifest_path"`
	Status       AppStatus `json:"status"`
	RuntimeURL   string    `json:"runtime_url,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Agent struct {
	ID              string    `json:"id"`
	Key             string    `json:"key"`
	Name            string    `json:"name"`
	Role            string    `json:"role"`
	Description     string    `json:"description"`
	ClaudeAgentName string    `json:"claude_agent_name"`
	SkillsJSON      string    `json:"skills_json"`
	Enabled         bool      `json:"enabled"`
	SortOrder       int       `json:"sort_order"`
}

type Job struct {
	ID              string    `json:"id"`
	UserPrompt      string    `json:"user_prompt"`
	NormalizedPrompt string  `json:"normalized_prompt"`
	AppSlug         string    `json:"app_slug"`
	AppName         string    `json:"app_name"`
	Status          JobStatus `json:"status"`
	CurrentStepKind StepKind  `json:"current_step_kind"`
	CreatedAppID    string    `json:"created_app_id,omitempty"`
	LockOwner       string    `json:"lock_owner,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type JobStep struct {
	ID                string     `json:"id"`
	JobID             string     `json:"job_id"`
	Kind              StepKind   `json:"kind"`
	Seq               int        `json:"seq"`
	AgentKey          string     `json:"agent_key"`
	Status            StepStatus `json:"status"`
	Attempt           int        `json:"attempt"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	EndedAt           *time.Time `json:"ended_at,omitempty"`
	NeedsUserInput    bool       `json:"needs_user_input"`
	UserPrompt         string     `json:"user_prompt,omitempty"`
	ErrorCode          ErrorCode  `json:"error_code,omitempty"`
	ErrorMessage       string     `json:"error_message,omitempty"`
	ClaudeSessionID    string     `json:"claude_session_id,omitempty"`
	CCStatusSessionID  string     `json:"cc_status_session_id,omitempty"`
}
```

- [ ] **Step 5: Implement schema and store**

Create `factory-server/internal/store/schema.sql` with the seven core tables from the design, using INTEGER unix milliseconds for timestamps and TEXT for enum fields. Create `factory-server/internal/store/store.go` with `Open`, `Close`, `Ping`, and helper timestamp functions. Implement application/job/step methods used by tests in focused files.

The `Open` function must execute embedded `schema.sql`:

```go
//go:embed schema.sql
var schema string
```

- [ ] **Step 6: Verify**

Run:

```bash
cd factory-server && gofmt -w internal && go test ./internal/model ./internal/store
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add factory-server/go.mod factory-server/go.sum factory-server/internal/model factory-server/internal/store
git commit -m "feat: add factory sqlite store"
```

## Task 3: Application Manifest Scanner

**Files:**
- Create: `factory-server/internal/scanner/manifest.go`
- Create: `factory-server/internal/scanner/scanner.go`
- Test: `factory-server/internal/scanner/manifest_test.go`
- Test: `factory-server/internal/scanner/scanner_test.go`
- Modify: `factory-server/internal/store/applications.go`

- [ ] **Step 1: Write manifest parsing tests**

Create `factory-server/internal/scanner/manifest_test.go`:

```go
package scanner

import "testing"

func TestParseManifest(t *testing.T) {
	raw := []byte(`{
	  "schemaVersion": 1,
	  "slug": "east-sea-situation",
	  "name": "东海目标态势演示",
	  "type": "map-dashboard",
	  "source": "preset",
	  "description": "demo",
	  "entry": "static-vite",
	  "path": "scene/east-sea-situation",
	  "tags": ["map"],
	  "build": {"command": "npm run build", "outputDir": "dist"},
	  "runtime": {"devCommand": "npm run dev", "defaultPort": 5173},
	  "docker": {"enabled": true, "dockerfile": "Dockerfile", "context": ".", "runtimePort": 80}
	}`)
	m, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if m.Slug != "east-sea-situation" || m.Entry != "static-vite" || !m.Docker.Enabled {
		t.Fatalf("manifest = %#v", m)
	}
}

func TestValidateManifestSourceAndPath(t *testing.T) {
	m := Manifest{SchemaVersion: 1, Slug: "x", Name: "x", Source: "generated", Entry: "static-vite"}
	if err := ValidateManifest("scene/x/.factory/app.json", m); err == nil {
		t.Fatal("expected generated manifest under scene to fail")
	}
}
```

- [ ] **Step 2: Implement manifest parser**

Create `manifest.go` with structs matching `.factory/app.json`. `ValidateManifest` must enforce:

```text
schemaVersion == 1
slug != ""
name != ""
source is preset or generated
entry == static-vite
source=preset path starts with scene/
source=generated path starts with generated-apps/
docker.enabled requires dockerfile, context, runtimePort > 0
```

- [ ] **Step 3: Write scanner integration test**

Create `scanner_test.go` that copies a fixture manifest into a temp `scene/demo/.factory/app.json`, scans it, and asserts one app with `Source=preset`.

- [ ] **Step 4: Implement scanner**

Create `scanner.go` with:

```go
type Scanner struct {
	Root string
}

func (s Scanner) Scan(ctx context.Context) ([]model.Application, error)
```

The scanner must read both:

```text
scene/*/.factory/app.json
generated-apps/*/.factory/app.json
```

It must return slug conflict errors instead of silently overwriting.

- [ ] **Step 5: Add store helper for scan import**

Add `MarkMissingApplications` and `SyncApplications` helpers in `applications.go`. `SyncApplications` must upsert scanned apps and mark previously known apps as `missing` if their manifest is no longer present.

- [ ] **Step 6: Verify against real scene manifests**

Run:

```bash
cd factory-server && go test ./internal/scanner ./internal/store
```

Expected: scanner tests pass. Manual validation against the real `scene/` manifests happens in Task 4 after the server can run with `FACTORY_WORKSPACE_ROOT=..`.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/scanner factory-server/internal/store/applications.go
git commit -m "feat: scan software factory app manifests"
```

## Task 4: Applications API And Startup Scan

**Files:**
- Modify: `factory-server/internal/server/server.go`
- Create: `factory-server/internal/server/app_handlers.go`
- Modify: `factory-server/cmd/factory-server/main.go`
- Test: `factory-server/internal/server/app_handlers_test.go`

- [ ] **Step 1: Write API handler tests**

Create `app_handlers_test.go` using `httptest`:

```go
func TestListApplications(t *testing.T) {
	// Build a test server with an in-memory store containing one preset app.
	// Request GET /api/apps.
	// Assert 200 and JSON array containing slug east-sea-situation.
}
```

The concrete assertion must decode:

```go
var apps []model.Application
if err := json.NewDecoder(rec.Body).Decode(&apps); err != nil {
	t.Fatalf("decode: %v", err)
}
if len(apps) != 1 || apps[0].Slug != "east-sea-situation" {
	t.Fatalf("apps = %#v", apps)
}
```

- [ ] **Step 2: Modify server constructor**

Change `server.New` to accept dependencies:

```go
func New(cfg config.Config, st *store.Store, sc scanner.Scanner) *Server
```

Add fields:

```go
store *store.Store
scanner scanner.Scanner
hub *Hub
```

- [ ] **Step 3: Add routes**

Add application routes:

```text
GET  /api/apps
GET  /api/apps/:id
POST /api/apps/:id/start
POST /api/apps/:id/stop
POST /api/apps/:id/rebuild
```

For this task, implement `GET` routes fully. Return `501` for start/stop/rebuild until deploy tasks implement them.

- [ ] **Step 4: Startup scan**

In `Start`, run manifest scan before listening:

```go
apps, err := s.scanner.Scan(ctx)
if err != nil {
	log.Printf("scan apps: %v", err)
} else if err := s.store.SyncApplications(ctx, apps); err != nil {
	log.Printf("sync apps: %v", err)
}
```

- [ ] **Step 5: Wire main**

In `cmd/factory-server/main.go`, open the SQLite store and construct scanner:

```go
st, err := store.Open(cfg.DBPath)
if err != nil {
	log.Fatal(err)
}
defer st.Close()

sc := scanner.Scanner{Root: cfg.WorkspaceRoot}
if err := server.New(cfg, st, sc).Start(ctx); err != nil {
	log.Fatal(err)
}
```

- [ ] **Step 6: Verify**

Run:

```bash
cd factory-server && gofmt -w cmd internal && go test ./... && go build -o bin/factory-server ./cmd/factory-server
```

Expected: all tests pass and binary builds.

- [ ] **Step 7: Manual API check**

Run in one terminal:

```bash
cd factory-server && FACTORY_WORKSPACE_ROOT=.. FACTORY_DBPATH=/tmp/software-factory-test.db ./bin/factory-server
```

Run in another terminal:

```bash
curl -s http://127.0.0.1:8787/api/apps
```

Expected: JSON includes the three scene slugs:

```text
east-sea-situation
carrier-formation-replay
aircraft-carrier-track
```

- [ ] **Step 8: Commit**

```bash
git add factory-server
git commit -m "feat: expose factory applications api"
```

## Task 5: Agent Registry And API

**Files:**
- Create: `factory-server/internal/agents/registry.go`
- Modify: `factory-server/internal/store/agents.go`
- Create: `factory-server/internal/server/agent_handlers.go`
- Test: `factory-server/internal/agents/registry_test.go`
- Test: `factory-server/internal/server/agent_handlers_test.go`

- [ ] **Step 1: Write registry tests**

Create `registry_test.go`:

```go
func TestDefaultRegistryContainsFixedAgents(t *testing.T) {
	agents := DefaultRegistry()
	keys := map[string]bool{}
	for _, agent := range agents {
		keys[agent.Key] = true
	}
	for _, key := range []string{"requirement-analyst", "solution-designer", "code-generator", "tester", "deployer"} {
		if !keys[key] {
			t.Fatalf("missing agent key %s", key)
		}
	}
}
```

- [ ] **Step 2: Implement registry**

Create five default agents with stable IDs and sort order:

```text
agent_requirement_analyst
agent_solution_designer
agent_code_generator
agent_tester
agent_deployer
```

`ClaudeAgentName` values must match the intended Claude Code CLI agent names:

```text
requirement-analyst
solution-designer
code-generator
tester
deployer
```

- [ ] **Step 3: Add store upsert/list/update**

Implement:

```go
UpsertAgent(ctx context.Context, a model.Agent) error
ListAgents(ctx context.Context) ([]model.Agent, error)
SetAgentEnabled(ctx context.Context, id string, enabled bool) error
```

- [ ] **Step 4: Add Agents API**

Implement:

```text
GET   /api/agents
PATCH /api/agents/:id
GET   /api/agents/:id/runs
```

`PATCH` accepts:

```json
{"enabled": true}
```

`GET /api/agents/:id/runs` returns an empty array until `cc-status` integration is added.

- [ ] **Step 5: Startup upsert**

During server startup, call:

```go
for _, a := range agents.DefaultRegistry() {
	if err := s.store.UpsertAgent(ctx, a); err != nil {
		log.Printf("upsert agent %s: %v", a.Key, err)
	}
}
```

- [ ] **Step 6: Verify**

Run:

```bash
cd factory-server && gofmt -w internal && go test ./...
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/agents factory-server/internal/store/agents.go factory-server/internal/server/agent_handlers.go
git commit -m "feat: add factory agent registry"
```

## Task 6: Jobs, Steps, Artifacts API

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/jobs.go`
- Create: `factory-server/internal/server/job_handlers.go`
- Create: `factory-server/internal/server/artifact_handlers.go`
- Test: `factory-server/internal/server/job_handlers_test.go`

- [ ] **Step 1: Add artifact and conversation models**

Extend `model.go` with:

```go
type Artifact struct {
	ID        string    `json:"id"`
	JobID     string    `json:"job_id"`
	StepID    string    `json:"step_id"`
	Attempt   int       `json:"attempt"`
	Kind      string    `json:"kind"`
	Path      string    `json:"path"`
	Summary   string    `json:"summary"`
	CreatedAt time.Time `json:"created_at"`
}

type ConversationMessage struct {
	ID           string    `json:"id"`
	JobID        string    `json:"job_id,omitempty"`
	Role         string    `json:"role"`
	Content      string    `json:"content"`
	MetadataJSON string    `json:"metadata_json,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}
```

- [ ] **Step 2: Write create job API test**

Create `job_handlers_test.go` with:

```go
func TestCreateJobCreatesFixedSteps(t *testing.T) {
	// POST /api/jobs with {"prompt":"生成航母编队月度航迹复盘"}
	// Assert response status 201.
	// Fetch /api/jobs/:id/steps.
	// Assert six steps in fixed order.
}
```

Expected step order:

```go
[]model.StepKind{
	model.StepRequirementAnalysis,
	model.StepSolutionDesign,
	model.StepCodeGeneration,
	model.StepTestVerification,
	model.StepImageBuild,
	model.StepDeployment,
}
```

- [ ] **Step 3: Implement job creation**

`POST /api/jobs` accepts:

```json
{"prompt":"生成航母编队月度航迹复盘"}
```

It creates:

- one `jobs` row with `status=queued`
- six `job_steps` rows with `status=pending`
- one `conversations` user message

It returns the created `model.Job`.

- [ ] **Step 4: Implement job routes**

Add:

```text
GET  /api/jobs
GET  /api/jobs/:id
GET  /api/jobs/:id/steps
GET  /api/jobs/:id/artifacts
POST /api/jobs/:id/cancel
POST /api/jobs/:id/retry-current-step
POST /api/jobs/:id/answer
```

For this task:

- `cancel` updates job and current step to `canceled`.
- `answer` stores a conversation message and returns the job.
- `retry-current-step` returns `409 Conflict` until executor is implemented.

- [ ] **Step 5: Implement artifact content route**

`GET /api/artifacts/:id/content` reads the artifact file path if it is inside `.factory-runs` and returns `text/plain`. Reject paths outside `.factory-runs` with `403`.

- [ ] **Step 6: Verify**

Run:

```bash
cd factory-server && gofmt -w internal && go test ./...
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/jobs.go factory-server/internal/server/job_handlers.go factory-server/internal/server/artifact_handlers.go
git commit -m "feat: add factory job APIs"
```

## Task 7: SSE Event Hub

**Files:**
- Create: `factory-server/internal/server/events.go`
- Modify: `factory-server/internal/server/server.go`
- Test: `factory-server/internal/server/events_test.go`

- [ ] **Step 1: Write event hub test**

Create `events_test.go`:

```go
func TestHubPublishesToSubscriber(t *testing.T) {
	h := NewHub()
	ch := h.Subscribe()
	defer h.Unsubscribe(ch)
	h.Publish(Event{Type: "job.updated", Data: map[string]any{"id": "job_1"}})
	select {
	case ev := <-ch:
		if ev.Type != "job.updated" {
			t.Fatalf("event = %#v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for event")
	}
}
```

- [ ] **Step 2: Implement event hub**

Create:

```go
type Event struct {
	Seq  int64       `json:"seq"`
	Type string      `json:"type"`
	Data any         `json:"data"`
	At   time.Time   `json:"at"`
}
```

`Hub.Publish` increments `Seq` and broadcasts non-blockingly.

- [ ] **Step 3: Add SSE route**

Implement:

```text
GET /api/events
```

Response format:

```text
event: job.updated
data: {"seq":1,"type":"job.updated","data":{"id":"job_1"},"at":"2026-06-18T10:00:00Z"}
```

- [ ] **Step 4: Publish app/job/step events**

After API mutations in prior handlers, publish:

```text
app.updated
job.created
job.updated
step.updated
artifact.created
deployment.updated
```

- [ ] **Step 5: Verify**

Run:

```bash
cd factory-server && gofmt -w internal && go test ./...
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/server/events.go factory-server/internal/server/server.go
git commit -m "feat: add factory sse events"
```

## Task 8: Port Allocation And Health Checks

**Files:**
- Create: `factory-server/internal/deploy/ports.go`
- Create: `factory-server/internal/deploy/health.go`
- Test: `factory-server/internal/deploy/ports_test.go`
- Test: `factory-server/internal/deploy/health_test.go`

- [ ] **Step 1: Write port allocator tests**

Create `ports_test.go`:

```go
func TestAllocatorSkipsUsedPorts(t *testing.T) {
	a := Allocator{Start: 18000, End: 18002}
	used := map[int]bool{18000: true}
	port, err := a.Choose(func(p int) bool { return used[p] })
	if err != nil {
		t.Fatalf("choose: %v", err)
	}
	if port == 18000 {
		t.Fatalf("allocated used port %d", port)
	}
}
```

- [ ] **Step 2: Implement port allocator**

`Allocator.Choose` must try at most 20 candidates and return `model.ErrorPortUnavailable` as a typed error when no port is free.

- [ ] **Step 3: Write health checker tests**

Create `health_test.go` using `httptest.Server`:

```go
func TestHealthCheckAccepts2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := CheckHTTP(context.Background(), srv.URL, time.Second); err != nil {
		t.Fatalf("check: %v", err)
	}
}
```

- [ ] **Step 4: Implement health check**

`CheckHTTP` must poll until timeout and accept `200-399`. On timeout, return an error containing `health_check_failed`.

- [ ] **Step 5: Verify**

Run:

```bash
cd factory-server && gofmt -w internal/deploy && go test ./internal/deploy
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/deploy/ports.go factory-server/internal/deploy/health.go factory-server/internal/deploy/*_test.go
git commit -m "feat: add deployment port and health checks"
```

## Task 9: Podman Runner And App Operations

**Files:**
- Create: `factory-server/internal/deploy/podman.go`
- Modify: `factory-server/internal/store/deployments.go`
- Modify: `factory-server/internal/server/app_handlers.go`
- Test: `factory-server/internal/deploy/podman_test.go`
- Test: `factory-server/internal/server/app_operations_test.go`

- [ ] **Step 1: Define command runner interface**

In `podman.go`:

```go
type CommandRunner interface {
	Run(ctx context.Context, dir string, name string, args ...string) (CommandResult, error)
}

type CommandResult struct {
	Stdout     string
	Stderr     string
	ExitCode   int
	DurationMs int64
}
```

- [ ] **Step 2: Write unit tests with fake runner**

Test that `BuildImage` calls:

```text
podman build -t localhost/software-factory/east-sea-situation:preset .
```

Test that `RunContainer` calls:

```text
podman run -d --name sf-east-sea-situation-<suffix> -p <hostPort>:80 <image>
```

- [ ] **Step 3: Implement Podman methods**

Implement:

```go
BuildImage(ctx context.Context, app model.Application, tag string) (ImageRef, CommandResult, error)
RunContainer(ctx context.Context, image ImageRef, appSlug string, hostPort int, containerPort int) (ContainerRef, CommandResult, error)
StopContainer(ctx context.Context, containerName string) (CommandResult, error)
RemoveContainer(ctx context.Context, containerName string) (CommandResult, error)
```

- [ ] **Step 4: Implement application start/stop/rebuild handlers**

Rules:

- `start`: if app has no current image, build first, then run.
- `stop`: stop and remove active container, mark deployment stopped and app stopped.
- `rebuild`: require global executor lock; if lock unavailable, return `409 Conflict`.
- `start`: run health check before setting app status `running`.

- [ ] **Step 5: Verify with unit tests**

Run:

```bash
cd factory-server && gofmt -w internal && go test ./...
```

Expected: tests pass.

- [ ] **Step 6: Manual Podman check on one preset app**

Run:

```bash
cd factory-server && go build -o bin/factory-server ./cmd/factory-server
FACTORY_DBPATH=/tmp/software-factory-test.db ./bin/factory-server
```

Then:

```bash
curl -X POST http://127.0.0.1:8787/api/apps/<east-sea-app-id>/start
curl http://127.0.0.1:<allocated-port>
curl -X POST http://127.0.0.1:8787/api/apps/<east-sea-app-id>/stop
```

Expected: start returns a deployment URL, the URL returns HTML, stop marks the app stopped.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/deploy factory-server/internal/store/deployments.go factory-server/internal/server/app_handlers.go
git commit -m "feat: add podman app operations"
```

## Task 10: Executor State Machine

**Files:**
- Create: `factory-server/internal/executor/steps.go`
- Create: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Test: `factory-server/internal/executor/executor_test.go`

- [ ] **Step 1: Write step mapping test**

Create `steps_test.go`:

```go
func TestFixedSteps(t *testing.T) {
	steps := FixedSteps()
	if len(steps) != 6 {
		t.Fatalf("len = %d", len(steps))
	}
	if steps[0].Kind != model.StepRequirementAnalysis || steps[0].AgentKey != "requirement-analyst" {
		t.Fatalf("first step = %#v", steps[0])
	}
	if steps[5].Kind != model.StepDeployment || steps[5].AgentKey != "deployer" {
		t.Fatalf("last step = %#v", steps[5])
	}
}
```

- [ ] **Step 2: Implement fixed steps**

Create a struct:

```go
type StepDefinition struct {
	Kind     model.StepKind
	Seq      int
	AgentKey string
	Mode     string
}
```

Modes:

```text
claude
factory
factory_with_optional_claude_analysis
```

- [ ] **Step 3: Write executor transition test**

Test that when a queued job runs and a fake step runner returns success for all six steps:

- job ends `completed`
- all steps end `succeeded`
- deployment step was invoked last

- [ ] **Step 4: Implement executor**

Executor responsibilities:

- acquire global lock
- pick oldest queued job
- mark job running
- run current pending/failed step
- increment attempt on run
- handle `needsUserInput`
- handle failure with `error_code`
- mark job completed after deployment
- expose `RetryCurrentStep(jobID)` for failed jobs
- expose `Cancel(jobID)` and kill active runner if present

- [ ] **Step 5: Wire executor to job APIs**

After `POST /api/jobs`, signal executor loop. `POST /api/jobs/:id/retry-current-step` must call executor retry and return updated job.

- [ ] **Step 6: Verify**

Run:

```bash
cd factory-server && gofmt -w internal && go test ./...
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```bash
git add factory-server/internal/executor factory-server/internal/server/job_handlers.go
git commit -m "feat: add factory job executor"
```

## Task 11: Claude Runner Artifact Contract

**Files:**
- Create: `factory-server/internal/runner/artifacts.go`
- Create: `factory-server/internal/runner/contracts.go`
- Create: `factory-server/internal/runner/claude.go`
- Test: `factory-server/internal/runner/artifacts_test.go`
- Test: `factory-server/internal/runner/contracts_test.go`
- Test: `factory-server/internal/runner/claude_test.go`

- [ ] **Step 1: Write artifact path tests**

Test that:

```text
job_1 requirement_analysis attempt 1
```

creates:

```text
.factory-runs/jobs/job_1/requirement_analysis/attempt-1/input.json
.factory-runs/jobs/job_1/requirement_analysis/attempt-1/prompt.md
.factory-runs/jobs/job_1/requirement_analysis/attempt-1/output.json
```

- [ ] **Step 2: Implement artifact workspace**

Create:

```go
type AttemptWorkspace struct {
	Root       string
	JobID      string
	StepKind   model.StepKind
	Attempt    int
}

func (w AttemptWorkspace) Dir() string
func (w AttemptWorkspace) InputPath() string
func (w AttemptWorkspace) PromptPath() string
func (w AttemptWorkspace) OutputPath() string
func (w AttemptWorkspace) StdoutPath() string
func (w AttemptWorkspace) StderrPath() string
```

- [ ] **Step 3: Write contract validation tests**

Tests must cover:

- missing `output.json` -> `output_missing`
- invalid JSON -> `output_invalid_json`
- `needsUserInput=true` -> returned contract state waiting user
- manifest missing after code generation -> `schema_validation_failed`

- [ ] **Step 4: Implement contracts**

Implement one validator per Claude step:

```go
ValidateRequirementAnalysis(path string) (StepOutput, error)
ValidateSolutionDesign(path string) (StepOutput, error)
ValidateCodeGeneration(path string, projectDir string) (StepOutput, error)
```

Use `encoding/json.Decoder.DisallowUnknownFields()` for strictness where practical.

- [ ] **Step 5: Implement Claude runner wrapper**

`ClaudeRunner.Run` writes `input.json` and `prompt.md`, then invokes read-only steps with:

```text
claude --print --permission-mode plan --allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write
```

It invokes `code_generation` with:

```text
claude --print --permission-mode plan --allowedTools Read,Grep,Glob,Edit,Write --disallowedTools Bash
```

- [ ] **Step 6: Implement post-run file audit**

After Runner exits:

- run `git status --porcelain`
- reject modifications under `scene/`, `factory-server/`, `cc-status/`, `.git/`
- reject output-declared file paths outside `generated-apps/<slug>` and `.factory-runs/jobs/<job-id>`

- [ ] **Step 7: Verify**

Run:

```bash
cd factory-server && gofmt -w internal/runner && go test ./internal/runner
```

Expected: tests pass.

- [ ] **Step 8: Commit**

```bash
git add factory-server/internal/runner
git commit -m "feat: add claude runner contract"
```

## Task 12: Test Verification, Image Build, Deployment Steps

**Files:**
- Modify: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/deploy/podman.go`
- Modify: `factory-server/internal/store/deployments.go`
- Test: `factory-server/internal/executor/factory_steps_test.go`

- [ ] **Step 1: Write factory step tests**

Use fake command runner and fake health checker to verify:

- `test_verification` runs dependency install then `npm run build`
- `image_build` runs `podman build`
- `deployment` runs container then health check
- health check failure sets `health_check_failed`

- [ ] **Step 2: Implement dependency install rule**

In `test_verification`:

```text
if package-lock.json exists -> npm ci
else -> npm install
```

Then run:

```text
npm run build
```

Write stdout/stderr artifacts for each command.

- [ ] **Step 3: Implement image build step**

Read app manifest `docker` section and execute:

```text
podman build -t localhost/software-factory/<slug>:job-<job-id> .
```

- [ ] **Step 4: Implement deployment step**

Allocate port, run container, run health check, write deployment row, mark app running.

- [ ] **Step 5: Verify**

Run:

```bash
cd factory-server && gofmt -w internal && go test ./...
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/executor factory-server/internal/deploy factory-server/internal/store
git commit -m "feat: execute factory build and deployment steps"
```

## Task 13: cc-status Integration

**Files:**
- Create: `factory-server/internal/ccstatus/client.go`
- Modify: `factory-server/internal/server/agent_handlers.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Test: `factory-server/internal/ccstatus/client_test.go`

- [ ] **Step 1: Write client tests**

Use `httptest.Server` to return:

```json
{"ok":true,"version":"test"}
```

for `/healthz`, and assert `Client.Health` succeeds.

- [ ] **Step 2: Implement cc-status client**

Create:

```go
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func (c Client) Health(ctx context.Context) error
func (c Client) ListAgents(ctx context.Context, status string) ([]Subagent, error)
func (c Client) ListSkills(ctx context.Context, status string) ([]Skill, error)
```

If request fails, return an error that callers convert to `cc_status_unavailable` warning.

- [ ] **Step 3: Add agent runs endpoint**

`GET /api/agents/:id/runs` queries `cc-status` and filters by the Factory agent's `claude_agent_name` when possible. If `cc-status` is down, return:

```json
{"available":false,"runs":[],"warning":"cc-status unavailable"}
```

- [ ] **Step 4: Add job detail enrichment**

`GET /api/jobs/:id` can include a `cc_status_available` boolean. Do not fail the job endpoint if `cc-status` is down.

- [ ] **Step 5: Verify**

Run:

```bash
cd factory-server && gofmt -w internal/ccstatus internal/server && go test ./...
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add factory-server/internal/ccstatus factory-server/internal/server
git commit -m "feat: integrate cc-status observations"
```

## Task 14: Portal API Client And Hooks

**Files:**
- Create: `sf-portal/src/api/client.js`
- Create: `sf-portal/src/api/events.js`
- Modify: `sf-portal/src/hooks/useApplications.js`
- Modify: `sf-portal/src/hooks/useAgents.js`
- Create: `sf-portal/src/hooks/useJobs.js`
- Modify: `sf-portal/README.md`

- [ ] **Step 1: Add API client**

Create `client.js`:

```js
const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL || 'http://127.0.0.1:8787'

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${response.status} ${body}`)
  }
  return response.json()
}

export const factoryApi = {
  listApps: () => request('/api/apps'),
  startApp: id => request(`/api/apps/${id}/start`, { method: 'POST' }),
  stopApp: id => request(`/api/apps/${id}/stop`, { method: 'POST' }),
  rebuildApp: id => request(`/api/apps/${id}/rebuild`, { method: 'POST' }),
  listAgents: () => request('/api/agents'),
  createJob: prompt => request('/api/jobs', { method: 'POST', body: JSON.stringify({ prompt }) }),
  listJobs: () => request('/api/jobs'),
  getJobSteps: id => request(`/api/jobs/${id}/steps`),
  cancelJob: id => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  retryCurrentStep: id => request(`/api/jobs/${id}/retry-current-step`, { method: 'POST' }),
}
```

- [ ] **Step 2: Add SSE helper**

Create `events.js`:

```js
const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL || 'http://127.0.0.1:8787'

export function subscribeFactoryEvents(onEvent) {
  const source = new EventSource(`${API_BASE_URL}/api/events`)
  const types = ['app.updated', 'job.created', 'job.updated', 'step.updated', 'artifact.created', 'deployment.updated']
  types.forEach(type => {
    source.addEventListener(type, event => {
      onEvent(type, JSON.parse(event.data))
    })
  })
  return () => source.close()
}
```

- [ ] **Step 3: Replace mock application hook**

Modify `useApplications.js` to fetch real apps on mount and refetch on app events. Keep a local loading/error state.

- [ ] **Step 4: Replace mock agent hook**

Modify `useAgents.js` to fetch `GET /api/agents`. Remove random progress simulation.

- [ ] **Step 5: Add jobs hook**

Create `useJobs.js` with:

```js
export function useJobs() {
  const [jobs, setJobs] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [steps, setSteps] = useState([])
  // fetch listJobs, createJob, cancelJob, retryCurrentStep, refresh on SSE
}
```

Use explicit implementations, not mock timers.

- [ ] **Step 6: Verify**

Run:

```bash
cd sf-portal && npm run build
```

Expected: Vite production build succeeds.

- [ ] **Step 7: Commit**

```bash
git add sf-portal/src/api sf-portal/src/hooks sf-portal/README.md
git commit -m "feat: connect portal hooks to factory api"
```

## Task 15: Portal Workbench UI

**Files:**
- Modify: `sf-portal/src/App.jsx`
- Modify: `sf-portal/src/App.css`
- Modify: `sf-portal/src/components/ApplicationsPanel.jsx`
- Modify: `sf-portal/src/components/AgentsPanel.jsx`
- Modify: `sf-portal/src/components/ChatDialog.jsx`
- Create: `sf-portal/src/components/JobCenter.jsx`
- Create: `sf-portal/src/components/JobCenter.css`

- [ ] **Step 1: Add JobCenter component**

Create `JobCenter.jsx` that renders:

- active job prompt
- status badge
- six fixed step rows
- waiting user questions
- failure message and retry button
- deployment URL when completed

- [ ] **Step 2: Update layout**

Change `App.jsx` from vertical mock panels to three-column workbench:

```text
left: applications
center: JobCenter + fixed chat input
right: agents
```

- [ ] **Step 3: Wire chat submit**

`ChatDialog` or fixed input must call `createJob(prompt)`. While a job is running, submit new prompt as queued job and show it in job list.

- [ ] **Step 4: Wire app actions**

Applications panel buttons call:

```js
startApp(app.id)
stopApp(app.id)
rebuildApp(app.id)
```

Open button uses `window.open(app.runtime_url, '_blank')`.

- [ ] **Step 5: Preserve visual style**

Use existing `sf-portal` and `scene` design language:

- dark blue-black background
- cyan borders
- compact operational panels
- red failed state
- yellow waiting state
- no landing page hero

- [ ] **Step 6: Verify**

Run:

```bash
cd sf-portal && npm run build
```

Expected: build succeeds.

- [ ] **Step 7: Browser smoke check**

Run:

```bash
cd sf-portal && npm run dev
```

Open the Vite URL and verify:

- three-column workbench renders
- application cards load from Factory API
- agent cards load from Factory API
- submitting chat creates a job
- no text overlaps at desktop width

- [ ] **Step 8: Commit**

```bash
git add sf-portal/src
git commit -m "feat: add software factory workbench ui"
```

## Task 16: End-To-End Local MVP Verification

**Files:**
- Modify: `README.md`
- Modify: `factory-server/README.md`
- Modify: `sf-portal/README.md`
- Create: `docs/software-factory-local-runbook.md`

- [ ] **Step 1: Write runbook**

Create `docs/software-factory-local-runbook.md` with exact commands:

```bash
cd cc-status
make build
./bin/cc-status install

cd ../factory-server
make build
FACTORY_DBPATH=/tmp/software-factory.db ./bin/factory-server

cd ../sf-portal
npm run dev
```

Include API checks:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/api/apps
curl http://127.0.0.1:8787/api/agents
```

- [ ] **Step 2: Verify preset app start/stop**

Use API or portal to start one preset app. Expected:

- `POST /api/apps/:id/start` returns deployment URL.
- Deployment URL returns HTML.
- App status becomes `running`.
- Stop marks app `stopped`.

- [ ] **Step 3: Verify generation job dry run**

Before real Claude generation is enabled, add a temporary fake runner test mode controlled by:

```text
FACTORY_FAKE_CLAUDE=1
```

It must write valid `output.json` files and a minimal generated app under `generated-apps/<slug>/`. Use this mode only for automated local acceptance tests.

- [ ] **Step 4: Verify full generated app flow**

Run:

```bash
FACTORY_FAKE_CLAUDE=1 FACTORY_DBPATH=/tmp/software-factory.db ./bin/factory-server
```

Submit prompt:

```text
生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用
```

Expected:

- job completes
- generated app manifest has `source=generated`
- npm build passes
- Podman image builds
- deployment health check passes
- portal app card opens generated app URL

- [ ] **Step 5: Verify real Claude mode manually**

With `FACTORY_FAKE_CLAUDE` unset, submit a small prompt and verify:

- `.factory-runs/jobs/<job-id>/requirement_analysis/attempt-1/output.json` exists
- no protected paths are modified
- failed Claude output produces an explicit error code

- [ ] **Step 6: Final verification commands**

Run:

```bash
cd factory-server && make test && make build
cd ../sf-portal && npm run build
cd ../cc-status && make test
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add README.md factory-server/README.md sf-portal/README.md docs/software-factory-local-runbook.md
git commit -m "docs: add software factory local runbook"
```

## Coverage Checklist

- `scene/*/.factory/app.json` scan: Tasks 3-4.
- `generated-apps/*/.factory/app.json` scan: Tasks 3-4 and Task 16.
- Applications API: Task 4.
- App start/stop/rebuild with Podman: Tasks 8-9.
- Agents registry/API: Task 5.
- Jobs/steps/artifacts/conversations: Task 6.
- SSE: Task 7.
- Single active job executor: Task 10.
- Claude Runner file contract and soft security boundary: Task 11.
- Test verification, image build, deployment: Task 12.
- `cc-status` degradation and enrichment: Task 13.
- Portal API integration: Task 14.
- Portal UI in existing visual style: Task 15.
- Local acceptance loop: Task 16.

## Known Execution Constraints

- The current repository already has unrelated dirty and staged files. Do not run broad `git add .`.
- Podman verification requires local Podman to be available and running.
- Real Claude Runner verification requires local Claude Code CLI authentication.
- Network access may be needed once when `factory-server` downloads `modernc.org/sqlite`.
- `FACTORY_FAKE_CLAUDE=1` is required for deterministic automated end-to-end tests before real agent prompts are tuned.
