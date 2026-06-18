package executor

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// fakeRunner is a configurable StepRunner used by the executor tests. ByKind
// maps a step kind to the result it should return; BlockKinds holds kinds whose
// Run blocks until the passed ctx is cancelled (then returns a canceled
// result). The runner records each Run call's ctx separately for the cancel
// test.
type fakeRunner struct {
	mu         sync.Mutex
	byKind     map[model.StepKind]StepResult
	blockKinds map[model.StepKind]bool
	lastCtx    context.Context
	ctxCh      chan context.Context // if non-nil, receives every Run ctx
}

func (f *fakeRunner) Run(ctx context.Context, _ model.Job, step model.JobStep) (StepResult, error) {
	f.mu.Lock()
	f.lastCtx = ctx
	if f.ctxCh != nil {
		select {
		case f.ctxCh <- ctx:
		default:
		}
	}
	res, hasRes := f.byKind[step.Kind]
	block := f.blockKinds[step.Kind]
	f.mu.Unlock()

	if block {
		<-ctx.Done()
		return StepResult{Status: model.StepStatusCanceled, ErrorCode: model.ErrorCanceled}, ctx.Err()
	}
	if !hasRes {
		return StepResult{Status: model.StepStatusSucceeded}, nil
	}
	return res, nil
}

func (f *fakeRunner) setResult(k model.StepKind, r StepResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.byKind == nil {
		f.byKind = map[model.StepKind]StepResult{}
	}
	f.byKind[k] = r
}

// seedJob creates a queued job with all six FixedSteps seeded as pending and
// returns its id. It mirrors the createJob handler but is self-contained so the
// executor tests don't need the server package.
func seedJob(t *testing.T, st *store.Store) string {
	t.Helper()
	now := time.Now()
	jobID := "job_test_" + itoa(int(randCounter.Add(1)))
	job := model.Job{
		ID:              jobID,
		UserPrompt:      "build me a thing",
		Status:          model.JobStatusQueued,
		CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	for _, def := range FixedSteps() {
		step := model.JobStep{
			ID:       "step_test_" + string(def.Kind) + "_" + itoa(int(randCounter.Add(1))),
			JobID:    jobID,
			Kind:     def.Kind,
			Seq:      def.Seq,
			AgentKey: def.AgentKey,
			Status:   model.StepStatusPending,
			Attempt:  0,
		}
		if err := st.CreateJobStep(context.Background(), step); err != nil {
			t.Fatalf("create step %s: %v", def.Kind, err)
		}
	}
	return jobID
}

// randCounter keeps test ids unique within a process.
var randCounter atomic.Int64

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	b := []byte{}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func newTestExecutor(t *testing.T, runner StepRunner) (*Executor, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	busy := new(atomic.Bool)
	return NewExecutor(st, runner, busy), st
}

// drain runs RunOnce until no queued job remains (or attempts exceed 32).
func drain(t *testing.T, ctx context.Context, e *Executor) {
	t.Helper()
	for i := 0; i < 32; i++ {
		if err := e.RunOnce(ctx); err != nil {
			t.Fatalf("RunOnce[%d]: %v", i, err)
		}
		j, err := e.store.GetOldestQueuedJob(ctx)
		if err != nil {
			t.Fatalf("oldest queued: %v", err)
		}
		if j == nil {
			return
		}
	}
}

func mustJob(t *testing.T, st *store.Store, id string) model.Job {
	t.Helper()
	j, err := st.GetJob(context.Background(), id)
	if err != nil {
		t.Fatalf("get job: %v", err)
	}
	if j == nil {
		t.Fatalf("job %s missing", id)
	}
	return *j
}

func mustSteps(t *testing.T, st *store.Store, id string) []model.JobStep {
	t.Helper()
	steps, err := st.ListJobSteps(context.Background(), id)
	if err != nil {
		t.Fatalf("list steps: %v", err)
	}
	return steps
}

func stepByKind(t *testing.T, steps []model.JobStep, k model.StepKind) model.JobStep {
	t.Helper()
	for _, s := range steps {
		if s.Kind == k {
			return s
		}
	}
	t.Fatalf("step %s not found", k)
	return model.JobStep{}
}

// TestExecutorCompletesAllSteps drives a fake runner that succeeds every step
// and asserts the job reaches completed with all six steps succeeded.
func TestExecutorCompletesAllSteps(t *testing.T) {
	runner := &fakeRunner{}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	ctx := context.Background()
	drain(t, ctx, e)

	job := mustJob(t, st, id)
	if job.Status != model.JobStatusCompleted {
		t.Fatalf("job status = %s, want completed", job.Status)
	}
	if job.CurrentStepKind != model.StepDeployment {
		t.Fatalf("current step = %s, want deployment", job.CurrentStepKind)
	}
	steps := mustSteps(t, st, id)
	if len(steps) != 6 {
		t.Fatalf("len steps = %d, want 6", len(steps))
	}
	for _, s := range steps {
		if s.Status != model.StepStatusSucceeded {
			t.Fatalf("step %s status = %s, want succeeded", s.Kind, s.Status)
		}
	}
}

func TestExecutorNotifiesWhenStepAndJobStateChange(t *testing.T) {
	runner := &fakeRunner{}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	var updatesMu sync.Mutex
	var updates []ExecutionUpdate
	e.OnUpdate = func(_ context.Context, update ExecutionUpdate) {
		updatesMu.Lock()
		defer updatesMu.Unlock()
		updates = append(updates, update)
	}

	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	updatesMu.Lock()
	defer updatesMu.Unlock()
	if len(updates) < 2 {
		t.Fatalf("updates = %#v, want at least running and finalized updates", updates)
	}
	for i, update := range updates {
		if update.JobID != id {
			t.Fatalf("update[%d].JobID = %q, want %q", i, update.JobID, id)
		}
		if update.StepID == "" {
			t.Fatalf("update[%d].StepID is empty", i)
		}
	}
}

// TestExecutorFailureMarksJobFailed fails step 2 (solution_design) and asserts
// the job is failed, step 2 is failed with the given error, and steps 3-6 stay
// pending.
func TestExecutorFailureMarksJobFailed(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepSolutionDesign: {Status: model.StepStatusFailed, ErrorCode: model.ErrorRunnerExitNonzero, ErrorMessage: "boom"},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce #1 (step1): %v", err)
	}
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce #2 (step2): %v", err)
	}

	job := mustJob(t, st, id)
	if job.Status != model.JobStatusFailed {
		t.Fatalf("job status = %s, want failed", job.Status)
	}
	if job.CurrentStepKind != model.StepSolutionDesign {
		t.Fatalf("current step = %s, want solution_design", job.CurrentStepKind)
	}
	steps := mustSteps(t, st, id)
	sd := stepByKind(t, steps, model.StepSolutionDesign)
	if sd.Status != model.StepStatusFailed {
		t.Fatalf("step2 status = %s, want failed", sd.Status)
	}
	if sd.ErrorCode != model.ErrorRunnerExitNonzero || sd.ErrorMessage != "boom" {
		t.Fatalf("step2 err = %q/%q, want runner_exit_nonzero/boom", sd.ErrorCode, sd.ErrorMessage)
	}
	for _, k := range []model.StepKind{model.StepCodeGeneration, model.StepTestVerification, model.StepImageBuild, model.StepDeployment} {
		if s := stepByKind(t, steps, k); s.Status != model.StepStatusPending {
			t.Fatalf("step %s = %s, want pending", k, s.Status)
		}
	}
}

// TestExecutorWaitingUser asserts a waiting_user result pauses job + step.
func TestExecutorWaitingUser(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepRequirementAnalysis: {Status: model.StepStatusWaitingUser, NeedsUserInput: true},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	job := mustJob(t, st, id)
	if job.Status != model.JobStatusWaitingUser {
		t.Fatalf("job = %s, want waiting_user", job.Status)
	}
	steps := mustSteps(t, st, id)
	ra := stepByKind(t, steps, model.StepRequirementAnalysis)
	if ra.Status != model.StepStatusWaitingUser {
		t.Fatalf("step = %s, want waiting_user", ra.Status)
	}
	if !ra.NeedsUserInput {
		t.Fatalf("needs_user_input = false, want true")
	}
}

// TestExecutorRetryCurrentStep drives the job to failed on step 2, retries,
// then re-runs step 2 (now succeeding) and asserts the pipeline advances.
func TestExecutorRetryCurrentStep(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepSolutionDesign: {Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "first"},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	// Drive to failed on step 2.
	_ = e.RunOnce(context.Background()) // step 1 succeeds
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce step2: %v", err)
	}
	if j := mustJob(t, st, id); j.Status != model.JobStatusFailed {
		t.Fatalf("pre-retry job = %s, want failed", j.Status)
	}

	// Retry must reject a non-failed transition? No — job IS failed here, so it
	// should succeed and flip back to queued.
	updated, err := e.RetryCurrentStep(context.Background(), id)
	if err != nil {
		t.Fatalf("RetryCurrentStep: %v", err)
	}
	if updated.Status != model.JobStatusQueued {
		t.Fatalf("retry job = %s, want queued", updated.Status)
	}
	steps := mustSteps(t, st, id)
	if s := stepByKind(t, steps, model.StepSolutionDesign); s.Status != model.StepStatusPending {
		t.Fatalf("step2 after retry = %s, want pending", s.Status)
	}

	// Make step 2 succeed now and re-run.
	runner.setResult(model.StepSolutionDesign, StepResult{Status: model.StepStatusSucceeded})
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce after retry: %v", err)
	}
	job := mustJob(t, st, id)
	if job.CurrentStepKind != model.StepCodeGeneration {
		t.Fatalf("current step after retry = %s, want code_generation", job.CurrentStepKind)
	}
	if job.Status == model.JobStatusFailed {
		t.Fatalf("job still failed after successful retry")
	}
}

// TestExecutorRetryRejectsNonFailed asserts retry on a completed job errors.
func TestExecutorRetryRejectsNonFailed(t *testing.T) {
	runner := &fakeRunner{}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)
	drain(t, context.Background(), e) // → completed
	if _, err := e.RetryCurrentStep(context.Background(), id); err == nil {
		t.Fatalf("retry on completed job should error")
	}
}

// TestExecutorCancel starts a step that blocks until ctx is cancelled, then
// cancels the job concurrently and asserts both step and job reach canceled and
// the runner's ctx was cancelled.
func TestExecutorCancel(t *testing.T) {
	runner := &fakeRunner{blockKinds: map[model.StepKind]bool{model.StepRequirementAnalysis: true}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	// Run the blocking step in a goroutine; cancel once the runner is in-flight.
	ctxCh := make(chan context.Context, 1)
	runner.ctxCh = ctxCh
	doneCh := make(chan error, 1)
	go func() { doneCh <- e.RunOnce(context.Background()) }()

	var runCtx context.Context
	select {
	case runCtx = <-ctxCh:
	case <-time.After(2 * time.Second):
		t.Fatalf("runner did not start")
	}

	if err := e.Cancel(context.Background(), id); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	select {
	case <-runCtx.Done():
	case <-time.After(2 * time.Second):
		t.Fatalf("runner ctx not cancelled")
	}
	if err := <-doneCh; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("RunOnce returned %v, want nil or context.Canceled", err)
	}

	job := mustJob(t, st, id)
	if job.Status != model.JobStatusCanceled {
		t.Fatalf("job = %s, want canceled", job.Status)
	}
	steps := mustSteps(t, st, id)
	if s := stepByKind(t, steps, model.StepRequirementAnalysis); s.Status != model.StepStatusCanceled {
		t.Fatalf("step = %s, want canceled", s.Status)
	}
}

// TestExecutorRunOnceBusySkipped asserts that when busy is already held,
// RunOnce is a no-op (returns nil without picking a job) — the single-active-job
// invariant.
func TestExecutorRunOnceBusySkipped(t *testing.T) {
	runner := &fakeRunner{}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)
	if !e.busy.CompareAndSwap(false, true) {
		t.Fatalf("preset busy")
	}
	defer e.busy.Store(false)
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce while busy: %v", err)
	}
	// Job should remain queued, untouched.
	if j := mustJob(t, st, id); j.Status != model.JobStatusQueued {
		t.Fatalf("job = %s, want queued (busy held)", j.Status)
	}
}
