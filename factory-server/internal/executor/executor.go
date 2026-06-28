package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runlog"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// StepRunner executes a single pipeline step. Implementations live outside the
// executor package: the Claude runner (Task 11) and the factory build/deploy
// runner (Task 12). Until then the server injects an unimplemented stub.
//
// The emitter is a scoped reporter: the runner forwards safe activity/summary/
// command records through it, and the executor persists them with a
// job/step/attempt/sequence stamped on each. Runners must NEVER touch the store
// or compute sequence themselves.
type StepRunner interface {
	// Run executes one step. ctx is cancelled if the user cancels the job.
	Run(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error)
}

// StepResult is what a StepRunner returns for one step.
type StepResult struct {
	Status         model.StepStatus // succeeded | failed | waiting_user
	ErrorCode      model.ErrorCode  // set when failed
	ErrorMessage   string
	NeedsUserInput bool
	// Questions is the clarifying questions a step raised when pausing for user
	// input (waiting_user). Persisted on the step so the job detail can surface
	// them; empty for non-waiting results.
	Questions []runner.Question
}

// Executor drives the fixed pipeline forward: it runs up to MaxConcurrentJobs
// jobs at once across DIFFERENT applications, serializing jobs of the SAME
// application (ClaimNextRunnableJob excludes a queued job whose app_slug already
// has a running job). Jobs are claimed atomically by N worker goroutines; the
// per-job cancel map lets Cancel interrupt the in-flight step of any running job.
type Executor struct {
	store  *store.Store
	runner StepRunner
	// maxConcurrent bounds the worker pool. Workers loop: claim a runnable job →
	// run one step → loop. When no job is claimable a worker blocks on signal
	// until Signaled (on queue/retry/advance) or ctx is cancelled.
	maxConcurrent int

	// wakeL/wakeC broadcast idle workers on Signal. A single Signal() must be
	// able to wake multiple idle workers at once (a queued batch may have N
	// runnable jobs across different apps), so a buffered-1 channel is not
	// enough. sync.Cond Broadcast wakes every worker waiting on wakeC; workers
	// that find nothing claimable go back to waiting. For N≤16 workers the
	// thundering-herd is harmless — ClaimNextRunnableJob serializes losers to
	// nil under the single-connection pool.
	wakeL sync.Mutex
	wakeC *sync.Cond

	OnUpdate func(context.Context, ExecutionUpdate)
	// OnRecord is invoked AFTER a step_execution_record is successfully
	// appended to the store, carrying the fully-populated record (with the
	// executor-assigned attempt+sequence). Task 4 wires it to the SSE fan-out.
	OnRecord func(context.Context, runner.ExecutionRecordUpdate)
	// OnTrace is invoked for every SAFE work-trace event the runner produces
	// (Task 4). The server wires it to recordAndPublishWorkTrace, which
	// PERSISTS the trace (through the security gate) BEFORE publishing it over
	// SSE. This is the ONLY path a trace event reaches the store/SSE: the runner
	// produces safe, allowlisted, redacted payloads; the gate enforces
	// allowlist + cap + sensitive-key stripping + persist-before-publish; and
	// the SSE forwarder re-validates persisted rows. Thinking never reaches here
	// (dropped at the source in stream.go).
	OnTrace func(context.Context, model.WorkTraceEvent) (model.WorkTraceEvent, error)
	RunLog  *runlog.Logger

	// cancels maps a running jobID → the CancelFunc of its in-flight step's ctx,
	// guarded by cancelsMu. runJobStep adds on start and removes on end (defer);
	// Cancel looks up + invokes under the lock. A mutex is required because N
	// workers now run concurrently, each touching the map.
	cancelsMu sync.Mutex
	cancels   map[string]context.CancelFunc
}

type ExecutionUpdate struct {
	JobID  string
	StepID string
}

// stepEmitter is the runner.StepRecordEmitter handed to one step attempt. It is
// the ONLY component that assigns (attempt, sequence) and persists records, so
// concurrent stdout/stderr callbacks from a streaming runner cannot duplicate or
// reorder sequences. Emit holds s.mu across sequence assignment, the store
// append, AND the OnRecord fan-out, so all three are one atomic-ordered
// critical section: records persist and publish in strictly ascending sequence
// order, and the first-error slot stays consistent with what was published.
//
// First-error policy: the FIRST append error is stored and later surfaced by the
// runner via ErrExecutionRecordPersistenceFailed; subsequent errors are dropped
// (we keep the first because it is the most diagnostic — the constraint that
// failed, the disk-full, etc.). Emit never returns an error to the runner
// mid-stream (that would abort the run on a transient DB blip); the runner keeps
// streaming and the executor inspects FirstError() after the child exits.
// recordAppender is the persistence seam the stepEmitter depends on. *store.Store
// satisfies it in production; tests substitute an instrumented appender to
// assert ordering invariants without depending on SQLite timing.
type recordAppender interface {
	AppendStepExecutionRecord(ctx context.Context, rec model.StepExecutionRecord) error
}

type stepEmitter struct {
	store    recordAppender
	onRecord func(context.Context, runner.ExecutionRecordUpdate)

	jobID  string
	stepID string

	// Trace-attribution context: the dialogue the job belongs to (the gate's
	// sequence-partition key) + the task id (job id) + attempt, stamped onto
	// every WorkTraceEvent so recordAndPublishWorkTrace can partition and the
	// dialogue-scoped SSE can filter. dialogueID is "" for legacy jobs with no
	// dialogue link; in that case the trace is dropped (no partition key).
	dialogueID string
	attempt    int
	onTrace    func(context.Context, model.WorkTraceEvent) (model.WorkTraceEvent, error)

	mu       sync.Mutex
	nextSeq  int
	firstErr error
}

// newStepEmitter builds a scoped emitter for one (job, step, attempt). attempt
// is the step's CURRENT attempt number (already incremented by the executor
// before the runner runs), so records are tagged with the same attempt the
// job_steps row carries. dialogueID is the job's dialogue link (the trace
// sequence-partition key); empty for legacy jobs.
func (e *Executor) newStepEmitter(jobID, stepID, dialogueID string, attempt int) *stepEmitter {
	return &stepEmitter{
		store:      e.store,
		onRecord:   e.OnRecord,
		jobID:      jobID,
		stepID:     stepID,
		dialogueID: dialogueID,
		attempt:    attempt,
		onTrace:    e.OnTrace,
		nextSeq:    1,
	}
}

// Emit assigns the next sequence, appends the record to the store, and (on
// success) fires the OnRecord callback — ALL under s.mu. Holding the lock across
// the append AND the publish makes sequence assignment, persistence, and
// fan-out one atomic-ordered critical section: concurrent stdout/stderr
// callbacks therefore persist and publish records in strictly ascending
// sequence order, never 2-then-1. Volume per step is low (stdout/stderr lines),
// so serializing emits is acceptable.
//
// First-error policy: the FIRST append error is stored and later surfaced via
// FirstError(); subsequent errors are dropped. Emit never returns an error
// mid-stream (that would abort the run on a transient DB blip); the runner
// keeps streaming and the executor inspects FirstError() after the child exits.
//
// Redaction chokepoint: credentials in the content are masked HERE, before the
// record is built, so the SAME redacted content reaches BOTH the persisted store
// row and the OnRecord (SSE) payload. This is the single point every record —
// command_stdout, command_stderr, activity, summary, system lifecycle — passes
// through before persistence, which is exactly where the design ("写入执行记录前
// 脱敏") and runbook ("Before any record or artifact is persisted") require it.
// Redaction is content-based (regex on api_key/token/secret/password/authorization
// values), so it never alters fixed status strings or non-secret prose. Asserted
// by TestStepEmitterEmitRedactsBeforePersistAndPublish.
func (s *stepEmitter) Emit(ctx context.Context, kind model.ExecutionRecordKind, content string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// If an earlier emit already failed persisting, do not keep hammering the
	// store — the run will be marked execution_record_persistence_failed at the
	// end. We still return nil so the runner keeps streaming.
	if s.firstErr != nil {
		return nil
	}
	// Mask credentials before persist+publish (design: redact before writing the
	// record). Single chokepoint — callers (factory stream batcher, Claude stderr
	// callback, system lifecycle, activity parser) all hand raw content here and
	// cannot leak a secret into the DB or the SSE fan-out.
	content = redactExecutionText(content)
	seq := s.nextSeq
	s.nextSeq++
	rec := model.StepExecutionRecord{
		ID:        "rec_" + id.New(),
		JobID:     s.jobID,
		StepID:    s.stepID,
		Attempt:   s.attempt,
		Sequence:  seq,
		Kind:      kind,
		Content:   content,
		CreatedAt: time.Now(),
	}
	if err := s.store.AppendStepExecutionRecord(ctx, rec); err != nil {
		if s.firstErr == nil {
			s.firstErr = err
		}
		return nil
	}
	if s.onRecord != nil {
		s.onRecord(ctx, runner.ExecutionRecordUpdate{Record: rec})
	}
	return nil
}

// FirstError returns the first store-append error observed during this attempt,
// or nil if every record persisted. The executor checks it after the runner
// returns to decide success vs execution_record_persistence_failed.
func (s *stepEmitter) FirstError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.firstErr
}

// Trace is the runner.TraceEmitter implementation: it forwards one SAFE trace
// event (already redacted/capped/allowlisted by the producer) to the server's
// recordAndPublishWorkTrace gate via OnTrace, stamped with this step's dialogue
// + task + step + attempt attribution. This is the SINGLE path a trace event
// reaches the store/SSE: persist-before-publish + the security gate apply here.
// It is idempotent-safe: a nil OnTrace, an empty dialogue id (legacy job), or a
// gate error never aborts the agent run (best-effort, like Emit). The producer
// is responsible for never passing disallowed types (thinking etc.); the gate
// rejects them anyway.
func (s *stepEmitter) Trace(ctx context.Context, traceType, payload string) error {
	if s.onTrace == nil {
		return nil
	}
	if s.dialogueID == "" {
		// No dialogue partition key: the trace cannot be sequenced or streamed.
		// Drop it rather than emit an unattributable row. This preserves the
		// invariant that every persisted trace is dialogue-scoped.
		return nil
	}
	ev := model.WorkTraceEvent{
		DialogueID:  s.dialogueID,
		TaskID:      s.jobID,
		StepID:      s.stepID,
		Attempt:     s.attempt,
		Type:        traceType,
		PayloadJSON: payload,
	}
	_, _ = s.onTrace(ctx, ev) // best-effort: a gate error never aborts the run
	return nil
}

// emit is a helper that runs under the executor's own (non-scoped) system
// lifecycle path — system records are emitted by the executor itself, not by
// the runner, so they use the same stepEmitter the runner used. This keeps
// system records interleaved correctly with activity records by sequence.
func (s *stepEmitter) emit(ctx context.Context, kind model.ExecutionRecordKind, content string) {
	_ = s.Emit(ctx, kind, content)
}

// System lifecycle record contents. The completed-step content is verbatim
// "步骤已完成" (asserted by TestExecutorWritesStartedAndFinishedRecords); the
// others are short, consistent Chinese strings.
const (
	systemRecordStarted     = "步骤已开始"
	systemRecordCompleted   = "步骤已完成"
	systemRecordFailed      = "步骤执行失败"
	systemRecordWaitingUser = "步骤等待用户输入"
	systemRecordCanceled    = "步骤已取消"
	systemRecordRetry       = "步骤已重试"
)

// NewExecutor builds an Executor over st using runner with a worker pool of
// maxConcurrent workers. maxConcurrent must be >= 1; the caller (config.Resolve)
// clamps it to [1,16]. The Executor is idle until Start is called (or RunOnce is
// driven by a test).
func NewExecutor(st *store.Store, runner StepRunner, maxConcurrent int) *Executor {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	e := &Executor{
		store:         st,
		runner:        runner,
		maxConcurrent: maxConcurrent,
		cancels:       make(map[string]context.CancelFunc),
	}
	e.wakeC = sync.NewCond(&e.wakeL)
	return e
}

// Start launches the worker pool. Up to MaxConcurrent workers run concurrently;
// each loops claiming a runnable job (one whose app has no running job),
// running one step, and re-looping. When no job is claimable a worker waits on
// wakeC until Signaled (on queue/retry/advance) — a single Signal Broadcasts to
// all idle workers so a queued batch can fan out across apps. A watcher goroutine
// Broadcasts on ctx cancellation so idle workers exit promptly at shutdown.
// Start returns immediately; workers exit when ctx is cancelled.
func (e *Executor) Start(ctx context.Context) {
	// Watcher: Broadcast on ctx cancel so idle workers stuck in Wait wake and
	// observe ctx.Err(). This is the standard sync.Cond + cancellation pattern.
	go func() {
		<-ctx.Done()
		e.Signal()
	}()
	for i := 0; i < e.maxConcurrent; i++ {
		workerID := fmt.Sprintf("executor-%d", i)
		go e.worker(ctx, workerID)
	}
}

// worker is one pool goroutine. It drains runnable jobs until none remain, then
// waits on wakeC for the next wake. On every wake it drains again.
func (e *Executor) worker(ctx context.Context, workerID string) {
	for {
		if ctx.Err() != nil {
			return
		}
		// Drain: claim+run until no job is claimable. This keeps a worker busy
		// across a multi-step job's queued→advance→queued cycle without an
		// extra signal round-trip, and naturally stops when every queued job's
		// app is busy (or nothing is queued).
		ran := false
		for {
			if ctx.Err() != nil {
				return
			}
			claimed, err := e.store.ClaimNextRunnableJob(ctx, workerID)
			if err != nil {
				log.Printf("executor: claim: %v", err)
				break
			}
			if claimed == nil {
				break // nothing runnable right now; await next signal
			}
			if err := e.runJobStep(ctx, *claimed); err != nil {
				log.Printf("executor: run job step %s: %v", claimed.ID, err)
			}
			ran = true
		}
		if ran {
			// A finished step may have queued another job (advanceOrComplete
			// re-queues) whose app is now free — re-check before waiting.
			continue
		}
		// Nothing runnable: wait for the next Signal (new work) or the watcher's
		// shutdown Broadcast (ctx cancel). The claim loop above re-checks
		// ctx.Err() on every wake, so a spurious wake at shutdown exits cleanly.
		e.wakeL.Lock()
		if ctx.Err() == nil {
			e.wakeC.Wait()
		}
		e.wakeL.Unlock()
	}
}

// Signal is a non-blocking notify that wakes ALL idle workers (Broadcast), so a
// queued batch of independent-app jobs can fan out across the pool. A worker
// that finds nothing claimable goes back to waiting.
func (e *Executor) Signal() {
	e.wakeL.Lock()
	e.wakeC.Broadcast()
	e.wakeL.Unlock()
}

// ErrNoQueuedJob is returned by RunOnce when there is no queued job to process.
var ErrNoQueuedJob = errors.New("executor: no queued job")

// RunOnce claims and runs the next runnable job by exactly one step. It returns
// nil (no-op) when no job is claimable — every queued job's app already has a
// running job, or nothing is queued. It is the main entry point used by tests;
// the worker pool drives the same runJobStep path.
func (e *Executor) RunOnce(ctx context.Context) error {
	claimed, err := e.store.ClaimNextRunnableJob(ctx, "runonce")
	if err != nil {
		return fmt.Errorf("claim next runnable job: %w", err)
	}
	if claimed == nil {
		return nil
	}
	return e.runJobStep(ctx, *claimed)
}

// runJobStep runs one step for the given (already-claimed/running) job. The
// caller (worker/RunOnce) has already flipped the job to running via the claim;
// this function runs the step, records the transition, and finalizes.
func (e *Executor) runJobStep(ctx context.Context, job model.Job) error {
	// Find the step the job is currently pointing at.
	step, err := e.store.GetStepByKind(ctx, job.ID, job.CurrentStepKind)
	if err != nil {
		return fmt.Errorf("get step %s: %w", job.CurrentStepKind, err)
	}
	if step == nil {
		// Defensive: a malformed job with no matching step fails fast.
		_ = e.store.MarkJobFailed(ctx, job.ID)
		return fmt.Errorf("job %s has no step for current kind %s", job.ID, job.CurrentStepKind)
	}

	// The claim already flipped the job to running + stamped started_at, so we
	// only bump the step attempt + flip the step to running here.
	if err := e.store.IncrementStepAttempt(ctx, step.ID); err != nil {
		return fmt.Errorf("increment attempt: %w", err)
	}
	if err := e.store.MarkStepRunning(ctx, step.ID); err != nil {
		return fmt.Errorf("mark step running: %w", err)
	}
	e.notify(ctx, job.ID, step.ID)
	current, err := e.store.GetJob(ctx, job.ID)
	if err != nil || current == nil {
		if err == nil {
			err = fmt.Errorf("job %s vanished", job.ID)
		}
		return err
	}
	currentStep := *step
	currentStep.Status = model.StepStatusRunning
	currentStep.Attempt = step.Attempt + 1
	e.logEvent("step_started", map[string]any{
		"job_id":    job.ID,
		"step_id":   step.ID,
		"step_kind": string(job.CurrentStepKind),
		"attempt":   currentStep.Attempt,
	})

	// Cancellable context for this run, stored in the per-job cancel map so
	// Cancel can interrupt it. Added on start, removed on end (defer) — the map
	// is guarded by cancelsMu because N workers run concurrently.
	runCtx, cancel := context.WithCancel(ctx)
	e.cancelsMu.Lock()
	e.cancels[job.ID] = cancel
	e.cancelsMu.Unlock()
	defer func() {
		cancel()
		e.cancelsMu.Lock()
		delete(e.cancels, job.ID)
		e.cancelsMu.Unlock()
	}()

	// Build the scoped reporter for this attempt. The executor owns sequence +
	// persistence; the runner only forwards safe records through it. System
	// lifecycle records are emitted through the same emitter so they interleave
	// with activity records by sequence.
	emitter := e.newStepEmitter(job.ID, step.ID, job.DialogueID, currentStep.Attempt)
	emitter.emit(runCtx, model.ExecutionRecordSystem, systemRecordStarted)

	res, runErr := e.runner.Run(runCtx, *current, currentStep, emitter)

	// Cancellation during Run wins over any result.
	switch {
	case errors.Is(runErr, context.Canceled), errors.Is(runErr, context.DeadlineExceeded):
		emitter.emit(ctx, model.ExecutionRecordSystem, systemRecordCanceled)
		e.logEvent("step_finished", map[string]any{
			"job_id":    job.ID,
			"step_id":   step.ID,
			"step_kind": string(job.CurrentStepKind),
			"attempt":   currentStep.Attempt,
			"status":    string(model.StepStatusCanceled),
		})
		return e.finalizeCanceled(ctx, job.ID, step.ID)
	case runErr != nil && res.Status == "":
		// Non-result error with no status → unknown failure.
		res = StepResult{
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorUnknown,
			ErrorMessage: runErr.Error(),
		}
	}

	// If the runner's record persistence failed, the audit trail is incomplete —
	// surface that as execution_record_persistence_failed rather than claiming a
	// fully-auditable success. The step's own outcome (succeeded/failed) is still
	// recorded on the job_steps row; this error code is additive diagnostics.
	if perr := emitter.FirstError(); perr != nil && res.Status == model.StepStatusSucceeded {
		res = StepResult{
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorExecutionRecordPersistenceFailed,
			ErrorMessage: fmt.Sprintf("execution record persistence failed: %v", perr),
		}
	}

	// Emit the terminal system record matching the step outcome.
	switch res.Status {
	case model.StepStatusSucceeded:
		emitter.emit(ctx, model.ExecutionRecordSystem, systemRecordCompleted)
	case model.StepStatusFailed:
		emitter.emit(ctx, model.ExecutionRecordSystem, systemRecordFailed)
	case model.StepStatusWaitingUser:
		emitter.emit(ctx, model.ExecutionRecordSystem, systemRecordWaitingUser)
	}

	e.logEvent("step_finished", map[string]any{
		"job_id":        job.ID,
		"step_id":       step.ID,
		"step_kind":     string(job.CurrentStepKind),
		"attempt":       currentStep.Attempt,
		"status":        string(res.Status),
		"error_code":    string(res.ErrorCode),
		"error_message": res.ErrorMessage,
	})

	return e.finalize(ctx, job.ID, step.ID, res)
}

// finalize records a non-canceled step result and advances the job.
func (e *Executor) finalize(ctx context.Context, jobID, stepID string, res StepResult) error {
	switch res.Status {
	case model.StepStatusSucceeded:
		if err := e.store.MarkStepSucceeded(ctx, stepID); err != nil {
			return err
		}
		// Find the succeeded step's kind to decide advance vs complete.
		if err := e.advanceOrComplete(ctx, jobID); err != nil {
			return err
		}
		e.notify(ctx, jobID, stepID)
		return nil
	case model.StepStatusFailed:
		if err := e.store.MarkStepFailed(ctx, stepID, res.ErrorCode, res.ErrorMessage); err != nil {
			return err
		}
		if err := e.store.MarkJobFailed(ctx, jobID); err != nil {
			return err
		}
		e.notify(ctx, jobID, stepID)
		return nil
	case model.StepStatusWaitingUser:
		questionsJSON := ""
		if len(res.Questions) > 0 {
			if b, err := json.Marshal(res.Questions); err == nil {
				questionsJSON = string(b)
			}
		}
		if err := e.store.MarkStepWaitingUser(ctx, stepID, questionsJSON); err != nil {
			return err
		}
		if err := e.store.MarkJobWaitingUser(ctx, jobID); err != nil {
			return err
		}
		e.notify(ctx, jobID, stepID)
		return nil
	default:
		// Treat an unexpected status as unknown failure.
		if err := e.store.MarkStepFailed(ctx, stepID, model.ErrorUnknown, fmt.Sprintf("runner returned status %s", res.Status)); err != nil {
			return err
		}
		if err := e.store.MarkJobFailed(ctx, jobID); err != nil {
			return err
		}
		e.notify(ctx, jobID, stepID)
		return nil
	}
}

// finalizeCanceled records the canceled terminal state for both step and job.
func (e *Executor) finalizeCanceled(ctx context.Context, jobID, stepID string) error {
	if err := e.store.MarkStepCanceled(ctx, stepID); err != nil {
		return err
	}
	if err := e.store.MarkJobCanceled(ctx, jobID); err != nil {
		return err
	}
	e.notify(ctx, jobID, stepID)
	return nil
}

// advanceOrComplete moves the job to the next step or to completed, based on
// which step just succeeded (looked up from the store, since the executor is
// stateless across calls). The deployment step is the terminal step. After
// advancing, the job is re-queued so the drain loop picks up the next step.
func (e *Executor) advanceOrComplete(ctx context.Context, jobID string) error {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil {
		return err
	}
	if job == nil {
		return fmt.Errorf("job %s vanished after step success", jobID)
	}
	if job.CurrentStepKind == model.StepDeployment {
		return e.store.MarkJobCompleted(ctx, jobID)
	}
	next, ok := nextStepKind(job.CurrentStepKind)
	if !ok {
		// Current step is somehow beyond deployment — complete defensively.
		return e.store.MarkJobCompleted(ctx, jobID)
	}
	if err := e.store.AdvanceJobStep(ctx, jobID, next); err != nil {
		return err
	}
	// Re-queue so the drain loop runs the next step. started_at is preserved
	// (MarkJobQueued only flips status + updated_at).
	return e.store.MarkJobQueued(ctx, jobID)
}

// nextStepKind returns the step kind that follows k in FixedSteps order, or
// (kind, false) if k is the last step.
func nextStepKind(k model.StepKind) (model.StepKind, bool) {
	steps := FixedSteps()
	for i, s := range steps {
		if s.Kind == k && i+1 < len(steps) {
			return steps[i+1].Kind, true
		}
	}
	return "", false
}

// RetryCurrentStep resets the job's current failed step to pending and re-queues
// the job. The job must currently be failed; otherwise an error is returned
// (the handler maps that to 409).
func (e *Executor) RetryCurrentStep(ctx context.Context, jobID string) (model.Job, error) {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil {
		return model.Job{}, fmt.Errorf("get job: %w", err)
	}
	if job == nil {
		return model.Job{}, errors.New("job not found")
	}
	if job.Status != model.JobStatusFailed {
		return model.Job{}, fmt.Errorf("job is %s, only failed jobs can be retried", job.Status)
	}
	step, err := e.store.GetStepByKind(ctx, jobID, job.CurrentStepKind)
	if err != nil {
		return model.Job{}, fmt.Errorf("get step: %w", err)
	}
	if step == nil {
		return model.Job{}, fmt.Errorf("no step for current kind %s", job.CurrentStepKind)
	}
	if err := e.store.ResetStepToPending(ctx, step.ID); err != nil {
		return model.Job{}, fmt.Errorf("reset step: %w", err)
	}
	if err := e.store.MarkJobQueued(ctx, jobID); err != nil {
		return model.Job{}, fmt.Errorf("requeue job: %w", err)
	}
	// Emit a retry system record on the step's prior attempt so the audit trail
	// shows the retry decision inline. Best-effort: a failure here does not block
	// the retry (the job is already re-queued).
	if step != nil {
		emitter := e.newStepEmitter(jobID, step.ID, job.DialogueID, step.Attempt)
		emitter.emit(ctx, model.ExecutionRecordSystem, systemRecordRetry)
	}
	updated, err := e.store.GetJob(ctx, jobID)
	if err != nil || updated == nil {
		if err == nil {
			err = fmt.Errorf("job %s vanished after retry", jobID)
		}
		return model.Job{}, err
	}
	e.Signal()
	return *updated, nil
}

// RepairFromFailure rewinds a failed test_verification, image_build, or
// health-check-failed deployment step to code_generation with a tightly-scoped
// repair prompt. It is intentionally separate from RetryCurrentStep: retry
// re-runs the failed command, repair asks code_generation to change only the
// generated code needed for the failure.
func (e *Executor) RepairFromFailure(ctx context.Context, jobID string) (model.Job, error) {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil {
		return model.Job{}, fmt.Errorf("get job: %w", err)
	}
	if job == nil {
		return model.Job{}, errors.New("job not found")
	}
	if job.Status != model.JobStatusFailed {
		return model.Job{}, fmt.Errorf("job is %s, only failed jobs can be repaired", job.Status)
	}
	failedStep, err := e.store.GetStepByKind(ctx, jobID, job.CurrentStepKind)
	if err != nil {
		return model.Job{}, fmt.Errorf("get failed step: %w", err)
	}
	if failedStep == nil {
		return model.Job{}, fmt.Errorf("no step for current kind %s", job.CurrentStepKind)
	}
	if failedStep.Status != model.StepStatusFailed {
		return model.Job{}, fmt.Errorf("current step is %s, only failed steps can be repaired", failedStep.Status)
	}
	if !repairableFailureKind(failedStep.Kind, failedStep.ErrorCode) {
		return model.Job{}, fmt.Errorf("step %s (%s) cannot be repaired by code_generation", failedStep.Kind, failedStep.ErrorCode)
	}

	repairPrompt := e.buildRepairPrompt(ctx, *job, *failedStep)
	codeStep, err := e.store.GetStepByKind(ctx, jobID, model.StepCodeGeneration)
	if err != nil {
		return model.Job{}, fmt.Errorf("get code_generation step: %w", err)
	}
	if codeStep == nil {
		return model.Job{}, errors.New("no code_generation step")
	}

	for _, def := range FixedSteps() {
		if def.Seq < 3 {
			continue
		}
		step, err := e.store.GetStepByKind(ctx, jobID, def.Kind)
		if err != nil {
			return model.Job{}, fmt.Errorf("get step %s: %w", def.Kind, err)
		}
		if step == nil {
			continue
		}
		if err := e.store.ResetStepToPending(ctx, step.ID); err != nil {
			return model.Job{}, fmt.Errorf("reset step %s: %w", def.Kind, err)
		}
	}
	if err := e.store.SetStepUserPrompt(ctx, codeStep.ID, repairPrompt); err != nil {
		return model.Job{}, fmt.Errorf("set repair prompt: %w", err)
	}
	if err := e.store.AdvanceJobStep(ctx, jobID, model.StepCodeGeneration); err != nil {
		return model.Job{}, fmt.Errorf("rewind job: %w", err)
	}
	if err := e.store.MarkJobQueued(ctx, jobID); err != nil {
		return model.Job{}, fmt.Errorf("requeue job: %w", err)
	}

	emitter := e.newStepEmitter(jobID, failedStep.ID, job.DialogueID, failedStep.Attempt)
	if maxSeq, err := e.store.MaxStepExecutionRecordSequence(ctx, jobID, failedStep.ID, failedStep.Attempt); err == nil {
		emitter.nextSeq = maxSeq + 1
	}
	emitter.emit(ctx, model.ExecutionRecordSystem, "repair_from_failure: sent failure context to code_generation")

	updated, err := e.store.GetJob(ctx, jobID)
	if err != nil || updated == nil {
		if err == nil {
			err = fmt.Errorf("job %s vanished after repair", jobID)
		}
		return model.Job{}, err
	}
	e.Signal()
	return *updated, nil
}

func repairableFailureKind(kind model.StepKind, code model.ErrorCode) bool {
	if kind == model.StepCodeGeneration && code == model.ErrorSchemaValidationFailed {
		return true
	}
	if kind == model.StepTestVerification || kind == model.StepImageBuild {
		return true
	}
	// A deployment health-check failure usually means the generated code/config
	// makes the container start but not serve (e.g. a runtime startup error that
	// image_build's nginx -t did not catch). That is fixable by regenerating, so
	// let the user repair it instead of getting stuck retrying a doomed deploy.
	// Port/run infrastructure errors (ErrorPortUnavailable, ErrorPodmanRunFailed)
	// are NOT repairable — regenerating won't free a port or fix a runtime outage
	// — so they are excluded to avoid retry loops.
	if kind == model.StepDeployment && code == model.ErrorHealthCheckFailed {
		return true
	}
	return false
}

func (e *Executor) buildRepairPrompt(ctx context.Context, job model.Job, failedStep model.JobStep) string {
	var b strings.Builder
	b.WriteString("repair_from_failure\n")
	b.WriteString("本次不是重新生成应用，而是定向修复失败。只修复导致当前失败的问题，不要重写应用，不要改变原需求、方案、业务逻辑、数据来源、页面结构或无关样式。\n")
	b.WriteString("如果失败来自 schema_validation_failed，注意 audit scans the entire generated project，而不只扫描本次 createdFiles；必须修复 error_message 里列出的每一个 offending file。若旧产物中有过时的数据层文件（例如 src/data/ontology.js）仍包含违规字段，请直接覆盖为合规实现或安全 re-export，overwrite stale data-layer files，不要让旧文件残留继续触发审计。\n")
	b.WriteString("修复完成后，在 output.json 的 warnings 或 output.md 中简要说明修改文件和修复摘要。\n\n")
	b.WriteString("failed_step: ")
	b.WriteString(string(failedStep.Kind))
	b.WriteString("\nfailed_attempt: ")
	b.WriteString(fmt.Sprintf("%d", failedStep.Attempt))
	b.WriteString("\nerror_code: ")
	b.WriteString(string(failedStep.ErrorCode))
	b.WriteString("\nerror_message:\n")
	b.WriteString(limitRepairContext(failedStep.ErrorMessage, 4000))
	b.WriteString("\n\ncommand_output_tail:\n")
	records, err := e.store.ListStepExecutionRecordPage(ctx, job.ID, failedStep.ID, failedStep.Attempt, 0, 80)
	if err != nil {
		b.WriteString("读取失败记录失败: ")
		b.WriteString(err.Error())
		return b.String()
	}
	for _, rec := range records {
		switch rec.Kind {
		case model.ExecutionRecordCommandStdout, model.ExecutionRecordCommandStderr, model.ExecutionRecordError, model.ExecutionRecordSummary:
			b.WriteString("\n--- ")
			b.WriteString(string(rec.Kind))
			b.WriteString(" #")
			b.WriteString(fmt.Sprintf("%d", rec.Sequence))
			b.WriteString(" ---\n")
			b.WriteString(limitRepairContext(rec.Content, 8000))
			b.WriteString("\n")
		}
	}
	return limitRepairContext(b.String(), 24000)
}

func limitRepairContext(s string, maxBytes int) string {
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s
	}
	marker := "\n...[truncated]\n"
	keep := maxBytes - len(marker)
	if keep <= 0 {
		return marker
	}
	cut := 0
	for i := range s {
		if i > keep {
			break
		}
		cut = i
	}
	if cut <= 0 {
		return marker
	}
	return s[:cut] + marker
}

// Cancel marks the job (and its current step) canceled. If the job is the
// actively-running job, the in-flight step's runner ctx is cancelled too.
func (e *Executor) Cancel(ctx context.Context, jobID string) error {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil {
		return fmt.Errorf("get job: %w", err)
	}
	if job == nil {
		return errors.New("job not found")
	}
	// If this job has an in-flight step, cancel its runner ctx first. The lookup
	// + invocation happen under cancelsMu so a worker removing the entry (on
	// step end) and Cancel (on user request) never race on the map.
	e.cancelsMu.Lock()
	if cancel, ok := e.cancels[jobID]; ok {
		cancel()
	}
	e.cancelsMu.Unlock()
	// Record the canceled state for both job and current step. Using the store
	// helper keeps the queued/active cases consistent.
	if err := e.store.CancelJob(ctx, jobID); err != nil {
		return fmt.Errorf("cancel job: %w", err)
	}
	return nil
}

func (e *Executor) notify(ctx context.Context, jobID, stepID string) {
	if e.OnUpdate == nil {
		return
	}
	e.OnUpdate(ctx, ExecutionUpdate{JobID: jobID, StepID: stepID})
}

func (e *Executor) logEvent(name string, fields map[string]any) {
	if e.RunLog != nil {
		e.RunLog.Event(name, fields)
	}
}

// Dispatcher routes one step to the right StepRunner by step mode. Factory steps
// go to the factory runner; claude steps go to the claude fallback (Task 16
// wires the real claude runner; until then the fallback returns a failed
// ErrorUnknown result so the pipeline fails fast rather than hanging).
type Dispatcher struct {
	factory StepRunner
	claude  StepRunner
}

// NewDispatcher builds a Dispatcher over the two runners.
func NewDispatcher(factory, claude StepRunner) StepRunner {
	return &Dispatcher{factory: factory, claude: claude}
}

// Run routes the step. The mode lookup mirrors FixedSteps: claude steps
// (requirement_analysis / solution_design / code_generation) → claude; the
// factory steps (test_verification / image_build / deployment) and the
// factory_with_optional_claude_analysis step → factory.
func (d *Dispatcher) Run(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	mode := modeForKind(step.Kind)
	switch mode {
	case ModeFactory, ModeFactoryWithOptionalClaudeAnalysis:
		if d.factory != nil {
			return d.factory.Run(ctx, job, step, emit)
		}
	case ModeClaude:
		if d.claude != nil {
			return d.claude.Run(ctx, job, step, emit)
		}
	}
	return StepResult{
		Status:       model.StepStatusFailed,
		ErrorCode:    model.ErrorUnknown,
		ErrorMessage: "no runner wired for step " + string(step.Kind),
	}, nil
}

// modeForKind returns the dispatch mode for a step kind by scanning FixedSteps.
func modeForKind(k model.StepKind) string {
	for _, s := range FixedSteps() {
		if s.Kind == k {
			return s.Mode
		}
	}
	return ModeClaude
}
