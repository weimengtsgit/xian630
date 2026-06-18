package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/agents"
	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/executor"
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

// New constructs a Server with its dependencies: the resolved config, the
// SQLite store, and the manifest scanner. The SSE hub and deploy runtime are
// owned by the server (initialized here) so callers don't need to supply them.
// The signature is stable: adding deploy wiring does not change it.
func New(cfg config.Config, st *store.Store, sc scanner.Scanner) *Server {
	execBusy := new(atomic.Bool)
	s := &Server{
		cfg:         cfg,
		store:       st,
		scanner:     sc,
		hub:         NewHub(),
		runner:      &deploy.OSRunner{},
		healthCheck: deploy.CheckHTTP,
		execBusy:    execBusy,
		cc:          &ccstatus.Client{BaseURL: cfg.CCStatusBaseURL}, // HTTP=nil → client uses its 2s short-timeout default so a hung cc-status can't block handlers
	}
	// Factory steps → FactoryRunner (npm + podman via the shared OSRunner).
	// Claude steps → ClaudeStepRunner by default. When FACTORY_FAKE_CLAUDE is
	// truthy the slot is the deterministic FakeClaudeRunner so the full pipeline
	// can run end-to-end locally for the MVP loop.
	factory := &executor.FactoryRunner{
		Store:        st,
		Cmds:         s.runner,
		Alloc:        deploy.DefaultAllocator(),
		Health:       deploy.CheckHTTP,
		Workspace:    cfg.WorkspaceRoot,
		ArtifactRoot: cfg.ArtifactRoot,
	}
	claudeCmd := claudeCommandAdapter{runner: s.runner, defaultDir: cfg.WorkspaceRoot}
	var claude executor.StepRunner = &executor.ClaudeStepRunner{
		Store:        st,
		Workspace:    cfg.WorkspaceRoot,
		ArtifactRoot: cfg.ArtifactRoot,
		Claude:       &runner.ClaudeRunner{Runner: claudeCmd},
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
	dispatch := executor.NewDispatcher(factory, claude)
	s.exec = executor.NewExecutor(st, dispatch, execBusy)
	s.exec.OnUpdate = func(ctx context.Context, update executor.ExecutionUpdate) {
		s.publishStepUpdated(ctx, update.StepID)
		s.publishJobUpdated(ctx, update.JobID)
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
	log.Printf("factory-server listening on http://%s", s.cfg.Addr)
	err = s.srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) routes() *Router {
	r := &Router{}
	r.Handle("GET", "/healthz", s.health)

	r.Handle("GET", "/api/apps", s.listApps)
	r.Handle("GET", "/api/apps/:id", s.getApp)
	r.Handle("POST", "/api/apps/:id/start", s.startApp)
	r.Handle("POST", "/api/apps/:id/stop", s.stopApp)
	r.Handle("POST", "/api/apps/:id/rebuild", s.rebuildApp)

	r.Handle("GET", "/api/agents", s.listAgents)
	r.Handle("POST", "/api/agents", s.createAgent)
	r.Handle("POST", "/api/agents/create", s.createAgent)
	r.Handle("PATCH", "/api/agents/:id", s.updateAgent)
	r.Handle("GET", "/api/agents/:id/runs", s.agentRuns)

	r.Handle("POST", "/api/jobs", s.createJob)
	r.Handle("GET", "/api/jobs", s.listJobs)
	r.Handle("GET", "/api/jobs/:id", s.getJob)
	r.Handle("GET", "/api/jobs/:id/steps", s.jobSteps)
	r.Handle("GET", "/api/jobs/:id/artifacts", s.jobArtifacts)
	r.Handle("POST", "/api/jobs/:id/cancel", s.cancelJob)
	r.Handle("POST", "/api/jobs/:id/answer", s.answerJob)
	r.Handle("POST", "/api/jobs/:id/retry-current-step", s.retryCurrentStep)

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
