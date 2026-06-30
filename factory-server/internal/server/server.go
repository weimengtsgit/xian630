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
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/agents"
	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/dialogue"
	"github.com/weimengtsgit/xian630/factory-server/internal/executor"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
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
	async   func(func(context.Context))

	// Deploy runtime. These are initialized by New to production defaults and
	// overridden by same-package tests to substitute fakes.
	runner      deploy.CommandRunner                                               // default: &deploy.OSRunner{}
	runtime     deploy.ContainerRuntime                                            // container runtime (Podman or Docker)
	healthCheck func(ctx context.Context, url string, timeout time.Duration) error // default: deploy.CheckHTTP
	appLocks    sync.Map                                                           // map[appID]*sync.Mutex, per-app start/stop/rebuild mutual exclusion
	// credentialSecrets is the in-memory registry of controlled credential
	// VALUES keyed by opaque handle ("secret_<id>"). Plaintext values live ONLY
	// here — never in DB rows, input.json, SSE payloads, logs, project docs,
	// attachments, or dialogue messages. The persisted ephemeral_credential_refs
	// row stores ONLY {id, dialogue_id, focus_key, label, scope, handle, expiry};
	// the value is resolved solely by a future server-side verifier accepting
	// the handle. Zero-value ready (no init needed); sync.Map is concurrency-safe.
	credentialSecrets sync.Map // map[string]runtimeCredentialSecret

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
	// dialogueRouter runs the two model-driven dialogue contracts (intent routing
	// + business-agent drafting) via the real Claude Code CLI. Mirrors clarifier:
	// product path is ALWAYS the real CLI; tests override this field with a fake.
	dialogueRouter dialogue.Runner
	// turnClassifier classifies one follow-up message on a CONTINUING dialogue
	// session into one of the five turn intents. Product path is the real CLI
	// (Runner.ClassifyTurn); tests override this field with a fake.
	turnClassifier dialogue.TurnClassifier
	// turnWorker drains pending dialogue turns (Task 2). It is started from
	// Start and is also startable from tests so they can drive it.
	turnWorker *TurnWorker
	runLog     *runlog.Logger

	// documentDraftConverter converts document drafts to user-facing change summaries.
	// In production, this is the deterministic converter. Tests may override this
	// with fakes or LLM-backed implementations.
	documentDraftConverter     dialogue.DocumentDraftConverter
	documentDraftConverterName string
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
		Runtime:      runtime,  // docker or podman, per FACTORY_CONTAINER_RUNTIME (defaults podman)
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
	// Dialogue routing + business-agent drafting run against the REAL Claude
	// Code CLI in production, mirroring clarifier. Tests override
	// s.dialogueRouter directly.
	s.dialogueRouter = dialogue.Runner{
		Cmd:           claudeCmd,
		WorkspaceRoot: cfg.WorkspaceRoot,
		ArtifactRoot:  cfg.ArtifactRoot,
	}
	// Turn classifier runs against the REAL Claude Code CLI in production (the
	// same dialogue.Runner implements TurnClassifier via ClassifyTurn). Tests
	// override s.turnClassifier directly with a fake.
	s.turnClassifier = s.dialogueRouter
	// Document draft converter uses the deterministic implementation in production.
	// Tests may override s.documentDraftConverter directly with fakes or
	// LLM-backed implementations.
	if cfg.EnableDocumentDraftLLMConverter {
		s.documentDraftConverter = dialogue.NewLLMDocumentDraftConverter(s.dialogueRouter)
		s.documentDraftConverterName = "llm"
	} else {
		s.documentDraftConverter = dialogue.NewDeterministicDocumentDraftConverter()
		s.documentDraftConverterName = "deterministic"
	}
	s.turnWorker = NewTurnWorker(s, st, s.turnClassifier)
	var claude executor.StepRunner = &executor.ClaudeStepRunner{
		Store:              st,
		Workspace:          cfg.WorkspaceRoot,
		ArtifactRoot:       cfg.ArtifactRoot,
		Claude:             &runner.ClaudeRunner{Runner: claudeCmd, WorkDir: cfg.WorkspaceRoot},
		AuditRunner:        claudeCmd,
		CredentialResolver: s,
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
	asyncLimit := cfg.MaxConcurrentJobs
	if asyncLimit < 1 {
		asyncLimit = 1
	}
	asyncSem := make(chan struct{}, asyncLimit)
	async := func(fn func(context.Context)) {
		go func() {
			asyncSem <- struct{}{}
			defer func() { <-asyncSem }()
			fn(context.Background())
		}()
	}
	dispatch := executor.NewDispatcher(factory, claude)
	s.exec = executor.NewExecutor(st, dispatch, cfg.MaxConcurrentJobs)
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
	// OnTrace routes every SAFE work-trace event the runner produces through the
	// centralized persist-before-publish gate (recordAndPublishWorkTrace). This
	// is the ONLY path a trace reaches the store/SSE: the gate enforces the
	// allowlist + cap + sensitive-key stripping, persists the row (allocating
	// its dialogue sequence) BEFORE publishing, and the SSE forwarder re-
	// validates persisted rows. The runner produces safe, allowlisted payloads;
	// raw hidden thinking never reaches here (dropped at the source in
	// stream.go:emitStreamLine). No trace data is published any other way.
	s.exec.OnTrace = func(ctx context.Context, ev model.WorkTraceEvent) (model.WorkTraceEvent, error) {
		return s.recordAndPublishWorkTrace(ctx, ev)
	}
	// OnTaskThinking routes every raw thinking delta the runner produces through
	// the centralized persist-before-publish gate (recordAndPublishTaskThinking).
	// This is the ONLY path that thinking ever takes; it MUST NEVER reach
	// StepRecordEmitter or TraceEmitter (Constraint #9). The gate enforces
	// persist-before-publish and sequence assignment; the SSE forwarder re-validates
	// persisted rows. Thinking never reaches any other path.
	s.exec.OnTaskThinking = func(ctx context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error) {
		return s.recordAndPublishTaskThinking(ctx, ev)
	}
	s.async = async
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
	// The conversation surface streams the model's raw thinking (思考过程).
	// Ensure spawned `claude` CLI subprocesses run with extended thinking enabled
	// so thinking_delta arrives — inherited via the process env by the runner.
	// Honor an explicit override; only default when unset. The executor/trace
	// pipeline's #9 boundary is the source-level drop in internal/runner and
	// internal/executor, not the absence of thinking data in the process env.
	if os.Getenv("MAX_THINKING_TOKENS") == "" {
		os.Setenv("MAX_THINKING_TOKENS", "16000")
	}
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

	// Idempotently backfill legacy clarification sessions into the new dialogue
	// parent resource: one application_generation dialogue per legacy session,
	// linked via clarification_session_id. Best-effort — a backfill failure
	// must not prevent the server from listening (re-running startup retries
	// any unbackfilled rows; FindDialogueByClarificationID prevents dups).
	if err := s.store.BackfillClarificationDialogues(ctx); err != nil {
		log.Printf("backfill clarification dialogues: %v", err)
	}
	// Idempotently transition legacy resolved dialogues into continuing active
	// sessions so a dialogue whose first application is deployed stays open for
	// follow-up modification/inquiry turns (Task 2). Best-effort, like the
	// clarification backfill above.
	if err := s.store.BackfillResolvedDialoguesToActive(ctx); err != nil {
		log.Printf("backfill resolved dialogues to active: %v", err)
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
	// Start the dialogue turn worker's drain loop; it exits when ctx is
	// cancelled (server shutdown).
	s.turnWorker.Start(ctx)
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
	r.Handle("GET", "/api/apps/generationstats", s.appGenerationStats)
	r.Handle("GET", "/api/apps/:id", s.getApp)
	r.Handle("GET", "/api/apps/:id/project-tree", s.applicationProjectTree)
	r.Handle("GET", "/api/apps/:id/project-file", s.applicationProjectFile)
	r.Handle("PUT", "/api/apps/:id/project-drafts", s.saveApplicationProjectDraft)
	r.Handle("DELETE", "/api/apps/:id/project-drafts", s.discardApplicationProjectDraft)
	r.Handle("POST", "/api/apps/:id/project-drafts/apply", s.applyApplicationProjectDraft)
	r.Handle("POST", "/api/apps/:id/start", s.startApp)
	r.Handle("POST", "/api/apps/:id/stop", s.stopApp)
	r.Handle("POST", "/api/apps/:id/rebuild", s.rebuildApp)
	r.Handle("POST", "/api/apps/:id/rollback", s.rollbackApp)
	r.Handle("DELETE", "/api/apps/:id", s.deleteApp)

	r.Handle("GET", "/api/agents", s.listAgents)
	r.Handle("POST", "/api/agents", s.createAgent)
	r.Handle("POST", "/api/agents/create", s.createAgent)
	r.Handle("PATCH", "/api/agents/:id", s.updateAgent)
	r.Handle("GET", "/api/agents/:id/runs", s.agentRuns)
	r.Handle("DELETE", "/api/agents/:id", s.deleteAgent)

	r.Handle("POST", "/api/jobs", s.createJob)
	r.Handle("GET", "/api/jobs", s.listJobs)
	r.Handle("GET", "/api/jobs/:id", s.getJob)
	r.Handle("GET", "/api/jobs/:id/steps", s.jobSteps)
	r.Handle("GET", "/api/jobs/:id/steps/:stepID/execution-records", s.jobStepExecutionRecords)
	r.Handle("POST", "/api/jobs/:id/steps/:stepID/confirm", s.confirmJobStep)
	r.Handle("PATCH", "/api/jobs/:id/steps/:stepID/snapshot", s.patchJobStepSnapshot)
	r.Handle("GET", "/api/jobs/:id/artifacts", s.jobArtifacts)
	r.Handle("GET", "/api/jobs/:id/execution-summary", s.jobExecutionSummary)
	r.Handle("GET", "/api/jobs/:id/project-docs/file", s.jobProjectDocumentFile)
	r.Handle("GET", "/api/jobs/:id/collaboration-plan", s.getJobCollaborationPlan)
	r.Handle("POST", "/api/jobs/:id/cancel", s.cancelJob)
	r.Handle("POST", "/api/jobs/:id/answer", s.answerJob)
	r.Handle("POST", "/api/jobs/:id/retry-current-step", s.retryCurrentStep)
	r.Handle("POST", "/api/jobs/:id/repair-from-failure", s.repairFromFailure)

	// Clarification session lifecycle (Task 4). A portal chat message creates a
	// clarification session (NOT a job) until the user confirms.
	r.Handle("POST", "/api/clarifications", s.createClarification)
	r.Handle("GET", "/api/clarifications", s.listClarifications)
	r.Handle("GET", "/api/clarifications/active", s.getActiveClarification)
	r.Handle("GET", "/api/clarifications/:id", s.getClarification)
	r.Handle("DELETE", "/api/clarifications/:id", s.deleteClarification)
	r.Handle("GET", "/api/clarifications/:id/messages", s.listClarificationMessages)
	r.Handle("POST", "/api/clarifications/:id/messages", s.addClarificationMessage)
	r.Handle("POST", "/api/clarifications/:id/answers", s.answerClarification)
	r.Handle("POST", "/api/clarifications/:id/answers/batch", s.answerClarificationBatch)
	r.Handle("PATCH", "/api/clarifications/:id/requirement", s.patchClarificationRequirement)
	r.Handle("POST", "/api/clarifications/:id/retry-current-round", s.retryClarificationRound)
	r.Handle("POST", "/api/clarifications/:id/confirm", s.confirmClarification)
	r.Handle("POST", "/api/clarifications/:id/abandon", s.abandonClarification)

	// Dialogue API (Task 4). A facade over intent routing, child clarification,
	// and business-agent drafting. The legacy /api/clarifications endpoints stay
	// readable for backfilled history; new chat goes through /api/dialogues.
	r.Handle("POST", "/api/dialogues", s.createDialogue)
	r.Handle("GET", "/api/dialogues", s.listDialogues)
	r.Handle("GET", "/api/dialogues/:id", s.getDialogue)
	r.Handle("DELETE", "/api/dialogues/:id", s.deleteDialogue)
	r.Handle("POST", "/api/dialogues/:id/archive", s.archiveDialogue)
	r.Handle("POST", "/api/dialogues/:id/messages", s.addDialogueMessage)
	r.Handle("POST", "/api/dialogues/:id/turns/:turnId/cancel", s.cancelDialogueTurn)
	r.Handle("POST", "/api/dialogues/:id/changes/confirm", s.confirmDialogueChange)
	r.Handle("POST", "/api/dialogues/:id/route", s.selectDialogueRoute)
	r.Handle("POST", "/api/dialogues/:id/applications/:applicationID/open", s.openDialogueApp)
	r.Handle("POST", "/api/dialogues/:id/clarification/answers", s.answerDialogueClarification)
	r.Handle("POST", "/api/dialogues/:id/clarification/answers/batch", s.answerDialogueClarificationBatch)
	r.Handle("PATCH", "/api/dialogues/:id/clarification/requirement", s.patchDialogueRequirement)
	r.Handle("POST", "/api/dialogues/:id/clarification/retry-current-round", s.retryDialogueClarificationRound)
	r.Handle("POST", "/api/dialogues/:id/clarification/confirm", s.confirmDialogueClarification)
	r.Handle("POST", "/api/dialogues/:id/clarification/abandon", s.abandonDialogue)
	r.Handle("POST", "/api/dialogues/:id/business-agent/confirm", s.confirmDialogueBusinessAgent)
	r.Handle("POST", "/api/dialogues/:id/business-agent/continue", s.continueDialogueBusinessAgent)
	r.Handle("POST", "/api/dialogues/:id/business-agent/consolidation", s.applyDialogueBusinessConsolidation)
	// Controlled credential input boundary (Task 12). The ONLY path a plaintext
	// credential value enters the server: it is swapped for an opaque handle,
	// stored solely in the in-memory registry, and persisted as metadata only.
	r.Handle("POST", "/api/dialogues/:id/credentials", s.submitDialogueCredential)

	// Dialogue-scoped visible work-trace transport (Task 3). REST hydration +
	// SSE stream, both filtered to :id, sequence-replayable. Constraint #7: the
	// model's process/conclusions/task status flow ONLY through this
	// dialogueId-filtered, sequence-replayable trace. The global /api/events
	// stream above stays for legacy consumers.
	r.Handle("GET", "/api/dialogues/:id/work-trace", s.dialogueTraceEvents)
	r.Handle("GET", "/api/dialogues/:id/work-trace/stream", s.dialogueTraceStream)

	// Dialogue-scoped task-thinking transport (Task 2). REST hydration + SSE
	// stream, both filtered to :id, sequence-replayable, persist-before-publish.
	r.Handle("GET", "/api/dialogues/:id/task-thinking", s.dialogueTaskThinkingEvents)
	r.Handle("GET", "/api/dialogues/:id/task-thinking/stream", s.dialogueTaskThinkingStream)

	// Dialogue session attachments (Task 3). Multipart upload only; credential
	// files are rejected at the boundary (use controlled credential input).
	r.Handle("POST", "/api/dialogues/:id/attachments", s.uploadDialogueAttachment)

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
