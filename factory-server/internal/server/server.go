package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/agents"
	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/executor"
	"github.com/weimengtsgit/xian630/factory-server/internal/runlog"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

type Server struct {
	cfg     config.Config
	store   *store.Store
	scanner scanner.Scanner
	hub     *Hub
	srv     *http.Server

	// Deploy runtime. These are initialized by New to production defaults and
	// overridden by same-package tests to substitute fakes.
	runner      deploy.CommandRunner                                               // default: &deploy.OSRunner{}
	runtime     deploy.ContainerRuntime                                             // container runtime (Podman or Docker)
	healthCheck func(ctx context.Context, url string, timeout time.Duration) error // default: deploy.CheckHTTP
	execBusy    *atomic.Bool                                                       // global executor lock (Task 10 holds it during jobs)
	appLocks    sync.Map                                                           // map[appID]*sync.Mutex, per-app start/stop/rebuild mutual exclusion

	// Job pipeline executor (Task 10). Runs the fixed six-step factory pipeline
	// one step at a time; the real step runners land in Tasks 11/12, so New
	// injects an unimplemented stub for now.
	exec *executor.Executor

	// cc-status observation client (Task 13). Optional dependency: handlers
	// degrade gracefully (record cc_status_unavailable) when this is nil or the
	// service is unreachable. Injectable for tests.
	cc *ccstatus.Client

	// clarifier runs the multi-round requirement-clarification conversation via
	// the real Claude Code CLI (Task 4). Product path is ALWAYS the real CLI —
	// it is NOT gated on FACTORY_FAKE_CLAUDE (that flag only swaps the step
	// pipeline's ClaudeStepRunner). Tests override this field with a fake
	// runner.CommandRunner to avoid invoking claude.
	clarifier clarification.Runner
	runLog    *runlog.Logger
}

type claudeCommandAdapter struct {
	runner     deploy.CommandRunner
	defaultDir string
}

func (a claudeCommandAdapter) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	if dir == "" {
		dir = a.defaultDir
	}
	res, err := a.runner.Run(ctx, dir, name, args...)
	return runner.CommandResult{
		Stdout:     res.Stdout,
		Stderr:     res.Stderr,
		ExitCode:   res.ExitCode,
		DurationMs: res.DurationMs,
	}, err
}

type deployInputCommandRunner interface {
	RunWithInput(ctx context.Context, dir string, input string, name string, args ...string) (deploy.CommandResult, error)
}

type deployStreamCommandRunner interface {
	RunStream(ctx context.Context, dir string, name string, onStdoutLine func(string), args ...string) (deploy.CommandResult, error)
}

// deployStreamWithInputCommandRunner is the deploy-side streaming-with-stdin
// capability that *deploy.OSRunner satisfies in production. It mirrors
// deploy.StreamCommandRunner but is declared locally (next to
// deployInputCommandRunner / deployStreamCommandRunner) so the adapter can
// type-assert its underlying runner with the same delegation style as the
// other methods. When the underlying runner does NOT satisfy it (e.g. a
// non-streaming test fake), RunStreamWithInput returns a non-zero result so
// ClaudeRunner.Run's caller sees a clear failure rather than a panic — and
// ClaudeRunner.Run itself never reaches this method with such a runner
// because its own streamCommandRunner assertion would already have failed,
// routing to the RunWithInput + post-hoc-parse fallback.
type deployStreamWithInputCommandRunner interface {
	RunStreamWithInput(ctx context.Context, dir, input string, onStdout func(string), onStderr func(string), name string, args ...string) (deploy.CommandResult, error)
}

func (a claudeCommandAdapter) RunWithInput(ctx context.Context, dir, input, name string, args ...string) (runner.CommandResult, error) {
	if dir == "" {
		dir = a.defaultDir
	}
	inputRunner, ok := a.runner.(deployInputCommandRunner)
	if !ok {
		return runner.CommandResult{ExitCode: 1}, runner.ErrRunnerExitNonzero
	}
	res, err := inputRunner.RunWithInput(ctx, dir, input, name, args...)
	return runner.CommandResult{
		Stdout:     res.Stdout,
		Stderr:     res.Stderr,
		ExitCode:   res.ExitCode,
		DurationMs: res.DurationMs,
	}, err
}

func (a claudeCommandAdapter) RunStream(ctx context.Context, dir, name string, onStdoutLine func(string), args ...string) (runner.CommandResult, error) {
	if dir == "" {
		dir = a.defaultDir
	}
	streamRunner, ok := a.runner.(deployStreamCommandRunner)
	if !ok {
		return runner.CommandResult{ExitCode: 1}, runner.ErrRunnerExitNonzero
	}
	res, err := streamRunner.RunStream(ctx, dir, name, onStdoutLine, args...)
	return runner.CommandResult{
		Stdout:     res.Stdout,
		Stderr:     res.Stderr,
		ExitCode:   res.ExitCode,
		DurationMs: res.DurationMs,
	}, err
}

// RunStreamWithInput is the streaming-with-stdin variant. It is the method
// runner.streamCommandRunner requires, so implementing it makes the production
// claudeCommandAdapter (whose runner is *deploy.OSRunner) satisfy that
// interface — which means ClaudeRunner.Run's streamCommandRunner assertion
// SUCCEEDS in production and Claude tool activity (activity records) streams
// LIVE as tool calls happen, instead of only after the agent exits.
//
// onStdout / onStderr are forwarded verbatim so ClaudeRunner.runStream
// receives each stream-json line in real time. The fallback (underlying runner
// is not a deployStreamWithInputCommandRunner) returns a non-zero result,
// matching the existing RunStream/RunWithInput fallback style; in practice
// this branch is unreachable for the production adapter because *deploy.OSRunner
// always satisfies the interface.
func (a claudeCommandAdapter) RunStreamWithInput(ctx context.Context, dir, input string, onStdout func(string), onStderr func(string), name string, args ...string) (runner.CommandResult, error) {
	if dir == "" {
		dir = a.defaultDir
	}
	streamRunner, ok := a.runner.(deployStreamWithInputCommandRunner)
	if !ok {
		return runner.CommandResult{ExitCode: 1}, runner.ErrRunnerExitNonzero
	}
	res, err := streamRunner.RunStreamWithInput(ctx, dir, input, onStdout, onStderr, name, args...)
	return runner.CommandResult{
		Stdout:     res.Stdout,
		Stderr:     res.Stderr,
		ExitCode:   res.ExitCode,
		DurationMs: res.DurationMs,
	}, err
}

// New constructs a Server with its dependencies: the resolved config, the
// SQLite store, and the manifest scanner. The SSE hub and deploy runtime are
// owned by the server (initialized here) so callers don't need to supply them.
// The signature is stable: adding deploy wiring does not change it.
func New(cfg config.Config, st *store.Store, sc scanner.Scanner) *Server {
	execBusy := new(atomic.Bool)
	runLogger := runlog.New(cfg.LogPath, cfg.LogMaxBytes, cfg.LogMaxBackups)
	osRunner := &deploy.OSRunner{}

	// Select container runtime based on configuration
	var runtime deploy.ContainerRuntime
	switch cfg.ContainerRuntime {
	case "docker":
		runtime = deploy.NewDocker(osRunner)
		log.Printf("Container runtime: docker")
	default: // "podman" or any invalid value (fallback to podman)
		runtime = deploy.NewPodman(osRunner)
		log.Printf("Container runtime: podman")
	}
	// Fail-fast visibility: if the selected runtime's binary is not on PATH,
	// every image_build / container run will fail after a long generation run.
	// Surface this at startup (not 12 minutes later at image_build) with the
	// one-line fix. Does not block startup — the operator may install the
	// binary before triggering a build.
	if _, err := exec.LookPath(runtime.Name()); err != nil {
		log.Printf("WARNING: container runtime %q not found on PATH (FACTORY_CONTAINER_RUNTIME=%s); image_build will fail until it is installed or you switch runtimes", runtime.Name(), cfg.ContainerRuntime)
	}

	s := &Server{
		cfg:         cfg,
		store:       st,
		scanner:     sc,
		hub:         NewHub(),
		runner:      osRunner,
		runtime:     runtime,
		healthCheck: deploy.CheckHTTP,
		execBusy:    execBusy,
		cc:          &ccstatus.Client{BaseURL: cfg.CCStatusBaseURL}, // HTTP=nil → client uses its 2s short-timeout default so a hung cc-status can't block handlers
		runLog:      runLogger,
	}
	// Factory steps → FactoryRunner (npm + podman via the shared OSRunner).
	// Claude steps → ClaudeStepRunner by default. When FACTORY_FAKE_CLAUDE is
	// truthy the slot is the deterministic FakeClaudeRunner so the full pipeline
	// can run end-to-end locally for the MVP loop.
	factory := &executor.FactoryRunner{
		Store:        st,
		Cmds:         osRunner,
		Runtime:      runtime, // docker or podman, per FACTORY_CONTAINER_RUNTIME (defaults podman)
		StreamCmds:   osRunner, // *deploy.OSRunner satisfies deploy.StreamCommandRunner → npm/container emit live command_stdout/command_stderr records
		Alloc:        deploy.DefaultAllocator(),
		Health:       deploy.CheckHTTP,
		Workspace:    cfg.WorkspaceRoot,
		ArtifactRoot: cfg.ArtifactRoot,
	}
	claudeCmd := claudeCommandAdapter{runner: s.runner, defaultDir: cfg.WorkspaceRoot}
	// Clarification runs against the REAL Claude Code CLI in production. It is
	// intentionally NOT gated on FACTORY_FAKE_CLAUDE — only the step-pipeline
	// ClaudeStepRunner slot is. Tests override s.clarifier directly.
	s.clarifier = clarification.Runner{
		Cmd:           claudeCmd,
		WorkspaceRoot: cfg.WorkspaceRoot,
		ArtifactRoot:  cfg.ArtifactRoot,
	}
	var claude executor.StepRunner = &executor.ClaudeStepRunner{
		Store:        st,
		Workspace:    cfg.WorkspaceRoot,
		ArtifactRoot: cfg.ArtifactRoot,
		Claude:       &runner.ClaudeRunner{Runner: claudeCmd, WorkDir: cfg.WorkspaceRoot},
		AuditRunner:  claudeCmd,
	}
	if truthy(os.Getenv("FACTORY_FAKE_CLAUDE")) {
		claude = &executor.FakeClaudeRunner{
			Store:        st,
			Workspace:    cfg.WorkspaceRoot,
			ArtifactRoot: cfg.ArtifactRoot,
		}
		log.Printf("FACTORY_FAKE_CLAUDE=1: claude steps use the deterministic FakeClaudeRunner")
	}
	if runner.LLMConsoleEnabled() {
		log.Printf("FACTORY_LLM_CONSOLE=1: claude request/response traces stream to stderr")
	}
	dispatch := executor.NewDispatcher(factory, claude)
	s.exec = executor.NewExecutor(st, dispatch, execBusy)
	s.exec.RunLog = runLogger
	s.exec.OnUpdate = func(ctx context.Context, update executor.ExecutionUpdate) {
		s.publishStepUpdated(ctx, update.StepID)
		s.publishJobUpdated(ctx, update.JobID)
	}
	// OnRecord fans out each persisted StepExecutionRecord to SSE subscribers as
	// a "step.record.appended" event. The executor invokes this ONLY after a
	// successful store append, so the record is durable and already carries the
	// executor-assigned (attempt, sequence). The record content is restricted to
	// safe kinds (system/activity/summary/command_stdout/command_stderr/error) by
	// the emitter upstream — never file bytes or hidden reasoning — so publishing
	// it verbatim over SSE does not leak artifact content.
	s.exec.OnRecord = func(ctx context.Context, u runner.ExecutionRecordUpdate) {
		s.hub.Publish(Event{Type: "step.record.appended", Data: u.Record})
	}
	return s
}

// truthy reports whether an env value selects an enabled boolean flag. It treats
// 1/true/yes/yes/on (case-insensitive) as true; everything else — including the
// empty string — as false.
func truthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// appLock returns the per-app mutex, creating it on first use. It is held with
// TryLock for start/stop/rebuild so a concurrent operation on the same app
// returns 409 instead of queuing.
func (s *Server) appLock(appID string) *sync.Mutex {
	v, _ := s.appLocks.LoadOrStore(appID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

func (s *Server) Start(ctx context.Context) error {
	// Startup scan: best-effort. A scan failure (e.g. a misconfigured workspace
	// root) must NOT prevent the server from listening — log and continue.
	apps, err := s.scanner.Scan(ctx)
	if err != nil {
		log.Printf("scan apps: %v", err)
	} else if err := s.store.SyncApplications(ctx, apps); err != nil {
		log.Printf("sync apps: %v", err)
	}

	// Upsert the fixed agent registry: a failure to seed one agent must not
	// prevent the server from listening (same best-effort policy as the scan).
	for _, a := range agents.DefaultRegistry() {
		if err := s.store.UpsertAgent(ctx, a); err != nil {
			log.Printf("upsert agent %s: %v", a.Key, err)
		}
	}

	s.srv = &http.Server{Addr: s.cfg.Addr, Handler: corsMiddleware(s.routes())}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
		defer cancel()
		_ = s.srv.Shutdown(c)
	}()
	// Start the pipeline executor's drain loop; it exits when ctx is cancelled
	// (server shutdown).
	s.exec.Start(ctx)
	s.logEvent("server_started", map[string]any{
		"pid":                os.Getpid(),
		"addr":               s.cfg.Addr,
		"db_path":            s.cfg.DBPath,
		"artifact_root":      s.cfg.ArtifactRoot,
		"workspace_root":     s.cfg.WorkspaceRoot,
		"cc_status_base_url": s.cfg.CCStatusBaseURL,
		"container_runtime":  s.cfg.ContainerRuntime,
	})
	log.Printf("factory-server listening on http://%s", s.cfg.Addr)
	err = s.srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) logEvent(name string, fields map[string]any) {
	if s.runLog != nil {
		s.runLog.Event(name, fields)
	}
}

func (s *Server) routes() *Router {
	r := &Router{}
	r.Handle("GET", "/healthz", s.health)

	r.Handle("GET", "/api/apps", s.listApps)
	r.Handle("GET", "/api/apps/:id", s.getApp)
	r.Handle("POST", "/api/apps/:id/start", s.startApp)
	r.Handle("POST", "/api/apps/:id/stop", s.stopApp)
	r.Handle("POST", "/api/apps/:id/rebuild", s.rebuildApp)
	r.Handle("DELETE", "/api/apps/:id", s.deleteApp)

	r.Handle("GET", "/api/agents", s.listAgents)
	r.Handle("POST", "/api/agents", s.createAgent)
	r.Handle("POST", "/api/agents/create", s.createAgent)
	r.Handle("PATCH", "/api/agents/:id", s.updateAgent)
	r.Handle("GET", "/api/agents/:id/runs", s.agentRuns)

	r.Handle("POST", "/api/jobs", s.createJob)
	r.Handle("GET", "/api/jobs", s.listJobs)
	r.Handle("GET", "/api/jobs/:id", s.getJob)
	r.Handle("GET", "/api/jobs/:id/steps", s.jobSteps)
	r.Handle("GET", "/api/jobs/:id/steps/:stepID/execution-records", s.jobStepExecutionRecords)
	r.Handle("GET", "/api/jobs/:id/artifacts", s.jobArtifacts)
	r.Handle("GET", "/api/jobs/:id/execution-summary", s.jobExecutionSummary)
	r.Handle("POST", "/api/jobs/:id/cancel", s.cancelJob)
	r.Handle("POST", "/api/jobs/:id/answer", s.answerJob)
	r.Handle("POST", "/api/jobs/:id/retry-current-step", s.retryCurrentStep)

	// Clarification session lifecycle (Task 4). A portal chat message creates a
	// clarification session (NOT a job) until the user confirms.
	r.Handle("POST", "/api/clarifications", s.createClarification)
	r.Handle("GET", "/api/clarifications", s.listClarifications)
	r.Handle("GET", "/api/clarifications/active", s.getActiveClarification)
	r.Handle("GET", "/api/clarifications/:id", s.getClarification)
	r.Handle("GET", "/api/clarifications/:id/messages", s.listClarificationMessages)
	r.Handle("POST", "/api/clarifications/:id/messages", s.addClarificationMessage)
	r.Handle("POST", "/api/clarifications/:id/answers", s.answerClarification)
	r.Handle("POST", "/api/clarifications/:id/answers/batch", s.answerClarificationBatch)
	r.Handle("PATCH", "/api/clarifications/:id/requirement", s.patchClarificationRequirement)
	r.Handle("POST", "/api/clarifications/:id/retry-current-round", s.retryClarificationRound)
	r.Handle("POST", "/api/clarifications/:id/confirm", s.confirmClarification)
	r.Handle("POST", "/api/clarifications/:id/abandon", s.abandonClarification)

	r.Handle("GET", "/api/artifacts/:id/content", s.artifactContent)
	r.Handle("GET", "/api/events", s.events)
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

// corsMiddleware injects permissive CORS headers so the portal (served by Vite
// on localhost:3001) can call factory-server (127.0.0.1:8787) from the browser
// for the local MVP. Preflight OPTIONS requests are answered 204 directly; all
// other requests pass through to the wrapped handler with the headers set.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
