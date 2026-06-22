package executor

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
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
}

// Executor drives the fixed pipeline forward: it picks the oldest queued job,
// runs its current step, and records the transition. At most one job runs at a
// time — the busy flag is shared with the server (rebuild CAS-409s while held).
type Executor struct {
	store  *store.Store
	runner StepRunner
	busy   *atomic.Bool

	signal chan struct{}

	OnUpdate func(context.Context, ExecutionUpdate)
	// OnRecord is invoked AFTER a step_execution_record is successfully
	// appended to the store, carrying the fully-populated record (with the
	// executor-assigned attempt+sequence). Task 4 wires it to the SSE fan-out.
	OnRecord func(context.Context, runner.ExecutionRecordUpdate)
	RunLog   *runlog.Logger

	// cancel of the currently-running step (if any), so Cancel can kill it.
	currentCancel atomic.Value // func()
	currentJobID  atomic.Value // string
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

	mu       sync.Mutex
	attempt  int
	nextSeq  int
	firstErr error
}

// newStepEmitter builds a scoped emitter for one (job, step, attempt). attempt
// is the step's CURRENT attempt number (already incremented by the executor
// before the runner runs), so records are tagged with the same attempt the
// job_steps row carries.
func (e *Executor) newStepEmitter(jobID, stepID string, attempt int) *stepEmitter {
	return &stepEmitter{
		store:    e.store,
		onRecord: e.OnRecord,
		jobID:    jobID,
		stepID:   stepID,
		attempt:  attempt,
		nextSeq:  1,
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

// NewExecutor builds an Executor over st using runner and sharing busy with the
// server. The Executor is idle until Start is called (or RunOnce is driven by a
// test).
func NewExecutor(st *store.Store, runner StepRunner, busy *atomic.Bool) *Executor {
	return &Executor{
		store:  st,
		runner: runner,
		busy:   busy,
		signal: make(chan struct{}, 1),
	}
}

// Start launches the drain loop that processes queued jobs whenever Signaled.
// It returns immediately; the loop exits when ctx is cancelled.
func (e *Executor) Start(ctx context.Context) {
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-e.signal:
				for {
					if ctx.Err() != nil {
						return
					}
					if err := e.RunOnce(ctx); err != nil {
						log.Printf("executor: run once: %v", err)
						break
					}
					// Stop draining when nothing is queued.
					if j, _ := e.store.GetOldestQueuedJob(ctx); j == nil {
						break
					}
				}
			}
		}
	}()
}

// Signal is a non-blocking notify that wakes the drain loop.
func (e *Executor) Signal() {
	select {
	case e.signal <- struct{}{}:
	default:
	}
}

// ErrNoQueuedJob is returned by RunOnce when there is no queued job to process.
var ErrNoQueuedJob = errors.New("executor: no queued job")

// RunOnce processes the oldest queued job by exactly one step. It is a no-op
// (nil return) when the busy flag is already held — the single-active-job
// invariant. It is the main entry point used by both the drain loop and tests.
func (e *Executor) RunOnce(ctx context.Context) error {
	// Acquire the single execution slot.
	if !e.busy.CompareAndSwap(false, true) {
		return nil
	}
	defer e.busy.Store(false)

	job, err := e.store.GetOldestQueuedJob(ctx)
	if err != nil {
		return fmt.Errorf("get oldest queued job: %w", err)
	}
	if job == nil {
		return nil
	}
	return e.runJobStep(ctx, *job)
}

// runJobStep runs one step for the given (queued) job. The caller has already
// acquired the busy flag.
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

	// Flip job+step to running. Reload the job so the runner sees its current
	// state; the MarkStepRunning call clears prior error fields and bumps the
	// attempt below.
	if err := e.store.MarkJobRunning(ctx, job.ID, "executor"); err != nil {
		return fmt.Errorf("mark job running: %w", err)
	}
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

	// Cancellable context for this run, stored so Cancel can interrupt it.
	runCtx, cancel := context.WithCancel(ctx)
	e.currentCancel.Store(cancelFunc(cancel))
	e.currentJobID.Store(job.ID)
	defer func() {
		e.currentCancel.Store(cancelFunc(func() {}))
		e.currentJobID.Store("")
	}()

	// Build the scoped reporter for this attempt. The executor owns sequence +
	// persistence; the runner only forwards safe records through it. System
	// lifecycle records are emitted through the same emitter so they interleave
	// with activity records by sequence.
	emitter := e.newStepEmitter(job.ID, step.ID, currentStep.Attempt)
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
		if err := e.store.MarkStepWaitingUser(ctx, stepID); err != nil {
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
		emitter := e.newStepEmitter(jobID, step.ID, step.Attempt)
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
	// If this is the active job, kill its runner first.
	if active, _ := e.currentJobID.Load().(string); active == jobID {
		if fn, ok := e.currentCancel.Load().(func()); ok && fn != nil {
			fn()
		}
	}
	// Record the canceled state for both job and current step. Using the store
	// helper keeps the queued/active cases consistent.
	if err := e.store.CancelJob(ctx, jobID); err != nil {
		return fmt.Errorf("cancel job: %w", err)
	}
	return nil
}

// cancelFunc adapts context.CancelFunc (func()) to the empty func() stored in
// an atomic.Value; storing a typed nil CancelFunc would surprise Load.
func cancelFunc(f context.CancelFunc) func() {
	return func() { f() }
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
