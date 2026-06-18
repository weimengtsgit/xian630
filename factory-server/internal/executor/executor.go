package executor

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync/atomic"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// StepRunner executes a single pipeline step. Implementations live outside the
// executor package: the Claude runner (Task 11) and the factory build/deploy
// runner (Task 12). Until then the server injects an unimplemented stub.
type StepRunner interface {
	// Run executes one step. ctx is cancelled if the user cancels the job.
	Run(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error)
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

	// cancel of the currently-running step (if any), so Cancel can kill it.
	currentCancel atomic.Value // func()
	currentJobID  atomic.Value // string
}

type ExecutionUpdate struct {
	JobID  string
	StepID string
}

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

	// Cancellable context for this run, stored so Cancel can interrupt it.
	runCtx, cancel := context.WithCancel(ctx)
	e.currentCancel.Store(cancelFunc(cancel))
	e.currentJobID.Store(job.ID)
	defer func() {
		e.currentCancel.Store(cancelFunc(func() {}))
		e.currentJobID.Store("")
	}()

	res, runErr := e.runner.Run(runCtx, *current, currentStep)

	// Cancellation during Run wins over any result.
	switch {
	case errors.Is(runErr, context.Canceled), errors.Is(runErr, context.DeadlineExceeded):
		return e.finalizeCanceled(ctx, job.ID, step.ID)
	case runErr != nil && res.Status == "":
		// Non-result error with no status → unknown failure.
		res = StepResult{
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorUnknown,
			ErrorMessage: runErr.Error(),
		}
	}

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
		if next, ok, err := e.nextFailureHandlerStepKind(ctx, jobID, stepID); err != nil {
			return err
		} else if ok {
			if err := e.store.AdvanceJobStep(ctx, jobID, next); err != nil {
				return err
			}
			if err := e.store.MarkJobQueued(ctx, jobID); err != nil {
				return err
			}
			e.notify(ctx, jobID, stepID)
			return nil
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
	next, ok, err := e.nextStepKind(ctx, jobID, job.CurrentStepKind)
	if err != nil {
		return err
	}
	if !ok {
		failed, err := e.hasFailedStep(ctx, jobID)
		if err != nil {
			return err
		}
		if failed {
			return e.store.MarkJobFailed(ctx, jobID)
		}
		return e.store.MarkJobCompleted(ctx, jobID)
	}
	if err := e.store.AdvanceJobStep(ctx, jobID, next); err != nil {
		return err
	}
	// Re-queue so the drain loop runs the next step. started_at is preserved
	// (MarkJobQueued only flips status + updated_at).
	return e.store.MarkJobQueued(ctx, jobID)
}

func (e *Executor) nextFailureHandlerStepKind(ctx context.Context, jobID, failedStepID string) (model.StepKind, bool, error) {
	steps, err := e.store.ListJobSteps(ctx, jobID)
	if err != nil {
		return "", false, err
	}
	var failedSeq int
	for _, step := range steps {
		if step.ID == failedStepID {
			if !isFixedStepKind(step.Kind) {
				return "", false, nil
			}
			failedSeq = step.Seq
			break
		}
	}
	if failedSeq == 0 {
		return "", false, nil
	}
	for _, step := range steps {
		if step.Seq > failedSeq && !isFixedStepKind(step.Kind) && step.Status == model.StepStatusPending {
			return step.Kind, true, nil
		}
	}
	return "", false, nil
}

func (e *Executor) nextStepKind(ctx context.Context, jobID string, current model.StepKind) (model.StepKind, bool, error) {
	steps, err := e.store.ListJobSteps(ctx, jobID)
	if err != nil {
		return "", false, err
	}
	for i, step := range steps {
		if step.Kind == current {
			if i+1 < len(steps) {
				return steps[i+1].Kind, true, nil
			}
			return "", false, nil
		}
	}
	return nextStepKind(current)
}

func (e *Executor) hasFailedStep(ctx context.Context, jobID string) (bool, error) {
	steps, err := e.store.ListJobSteps(ctx, jobID)
	if err != nil {
		return false, err
	}
	for _, step := range steps {
		if step.Status == model.StepStatusFailed {
			return true, nil
		}
	}
	return false, nil
}

// nextStepKind returns the step kind that follows k in FixedSteps order, or
// (kind, false) if k is the last step.
func nextStepKind(k model.StepKind) (model.StepKind, bool, error) {
	steps := FixedSteps()
	for i, s := range steps {
		if s.Kind == k && i+1 < len(steps) {
			return steps[i+1].Kind, true, nil
		}
	}
	return "", false, nil
}

func isFixedStepKind(k model.StepKind) bool {
	for _, step := range FixedSteps() {
		if step.Kind == k {
			return true
		}
	}
	return false
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
func (d *Dispatcher) Run(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	mode := modeForKind(step.Kind)
	switch mode {
	case ModeFactory, ModeFactoryWithOptionalClaudeAnalysis:
		if d.factory != nil {
			return d.factory.Run(ctx, job, step)
		}
	case ModeClaude:
		if d.claude != nil {
			return d.claude.Run(ctx, job, step)
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
