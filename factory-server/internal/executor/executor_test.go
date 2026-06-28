package executor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// fakeRunner is a configurable StepRunner used by the executor tests. ByKind
// maps a step kind to the result it should return; BlockKinds holds kinds whose
// Run blocks until the passed ctx is cancelled (then returns a canceled
// result). The runner records each Run call's ctx separately for the cancel
// test. The emitter is accepted to satisfy the StepRunner contract but is a
// no-op here — the fake does not duplicate real persistence logic.
type fakeRunner struct {
	mu         sync.Mutex
	byKind     map[model.StepKind]StepResult
	blockKinds map[model.StepKind]bool
	lastCtx    context.Context
	ctxCh      chan context.Context // if non-nil, receives every Run ctx
}

func (f *fakeRunner) Run(ctx context.Context, _ model.Job, step model.JobStep, _ runner.StepRecordEmitter) (StepResult, error) {
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
	return newTestExecutorWithConcurrency(t, runner, 1)
}

// newTestExecutorWithConcurrency builds an executor whose worker pool runs up to
// maxConcurrent jobs at once. maxConcurrent defaults to 1 to keep the legacy
// single-step-at-a-time tests deterministic; the scheduler test uses 3.
func newTestExecutorWithConcurrency(t *testing.T, runner StepRunner, maxConcurrent int) (*Executor, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return NewExecutor(st, runner, maxConcurrent), st
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

func TestExecutorRepairFromFailureRewindsTestFailureToCodeGeneration(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepTestVerification: {
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorBuildFailed,
			ErrorMessage: "build command failed",
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	drain(t, context.Background(), e)
	job := mustJob(t, st, id)
	if job.Status != model.JobStatusFailed || job.CurrentStepKind != model.StepTestVerification {
		t.Fatalf("pre-repair job = %s/%s, want failed/test_verification", job.Status, job.CurrentStepKind)
	}
	failedStep := stepByKind(t, mustSteps(t, st, id), model.StepTestVerification)
	if err := st.AppendStepExecutionRecord(context.Background(), model.StepExecutionRecord{
		ID:        "rec_repair_test",
		JobID:     id,
		StepID:    failedStep.ID,
		Attempt:   failedStep.Attempt,
		Sequence:  99,
		Kind:      model.ExecutionRecordCommandStderr,
		Content:   "src/App.tsx(1,8): error TS6133: React is declared but never used",
		CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("append failed record: %v", err)
	}

	updated, err := e.RepairFromFailure(context.Background(), id)
	if err != nil {
		t.Fatalf("RepairFromFailure: %v", err)
	}
	if updated.Status != model.JobStatusQueued {
		t.Fatalf("updated status = %s, want queued", updated.Status)
	}
	if updated.CurrentStepKind != model.StepCodeGeneration {
		t.Fatalf("current step = %s, want code_generation", updated.CurrentStepKind)
	}
	steps := mustSteps(t, st, id)
	code := stepByKind(t, steps, model.StepCodeGeneration)
	if code.Status != model.StepStatusPending {
		t.Fatalf("code_generation status = %s, want pending", code.Status)
	}
	for _, want := range []string{
		"repair_from_failure",
		"test_verification",
		"build command failed",
		"TS6133",
		"只修复导致当前失败的问题",
	} {
		if !strings.Contains(code.UserPrompt, want) {
			t.Fatalf("repair prompt missing %q:\n%s", want, code.UserPrompt)
		}
	}
	records, err := st.ListStepExecutionRecordPage(context.Background(), id, failedStep.ID, failedStep.Attempt, 0, 200)
	if err != nil {
		t.Fatalf("list failed-step records: %v", err)
	}
	foundRepairRecord := false
	for _, rec := range records {
		if rec.Kind == model.ExecutionRecordSystem && strings.Contains(rec.Content, "repair_from_failure") {
			foundRepairRecord = true
			if rec.Sequence <= 99 {
				t.Fatalf("repair record sequence = %d, want appended after existing records", rec.Sequence)
			}
		}
	}
	if !foundRepairRecord {
		t.Fatalf("missing repair_from_failure system record in failed-step attempt records: %+v", records)
	}
}

func TestExecutorRepairFromFailureRejectsNonRepairableFailure(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepSolutionDesign: {Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "bad design"},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	_ = e.RunOnce(context.Background())
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce step2: %v", err)
	}
	if _, err := e.RepairFromFailure(context.Background(), id); err == nil {
		t.Fatalf("RepairFromFailure should reject solution_design failures")
	}
}

// TestExecutorRepairFromFailureAllowsDeploymentHealthCheck: a deployment that
// fails with health_check_failed is repairable — the container started but did
// not serve (e.g. a runtime startup error image_build's nginx -t did not catch),
// which regenerating can fix. RepairFromFailure rewinds to code_generation.
func TestExecutorRepairFromFailureAllowsDeploymentHealthCheck(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepDeployment: {
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorHealthCheckFailed,
			ErrorMessage: "health check timeout\nnginx: [emerg] pcre2_compile() failed",
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	drain(t, context.Background(), e)
	job := mustJob(t, st, id)
	if job.Status != model.JobStatusFailed || job.CurrentStepKind != model.StepDeployment {
		t.Fatalf("pre-repair job = %s/%s, want failed/deployment", job.Status, job.CurrentStepKind)
	}

	updated, err := e.RepairFromFailure(context.Background(), id)
	if err != nil {
		t.Fatalf("RepairFromFailure should allow health_check_failed deploy: %v", err)
	}
	if updated.Status != model.JobStatusQueued || updated.CurrentStepKind != model.StepCodeGeneration {
		t.Fatalf("updated = %s/%s, want queued/code_generation", updated.Status, updated.CurrentStepKind)
	}
}

// TestExecutorRepairFromFailureRejectsDeploymentPortError: a deployment that
// fails with a port/run infrastructure error is NOT repairable — regenerating
// code will not free a port, so allowing it would loop.
func TestExecutorRepairFromFailureRejectsDeploymentPortError(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepDeployment: {
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorPortUnavailable,
			ErrorMessage: "no free port in pool",
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)

	drain(t, context.Background(), e)
	job := mustJob(t, st, id)
	if job.Status != model.JobStatusFailed || job.CurrentStepKind != model.StepDeployment {
		t.Fatalf("pre-repair job = %s/%s, want failed/deployment", job.Status, job.CurrentStepKind)
	}
	if _, err := e.RepairFromFailure(context.Background(), id); err == nil {
		t.Fatalf("RepairFromFailure should reject port_unavailable deploy failures")
	}
}

// seedJobWithSlug creates a queued job bound to a specific app_slug (the per-app
// serialization key) with all six FixedSteps seeded as pending and returns its id.
func seedJobWithSlug(t *testing.T, st *store.Store, appSlug string) string {
	t.Helper()
	now := time.Now()
	jobID := "job_test_" + itoa(int(randCounter.Add(1)))
	job := model.Job{
		ID:              jobID,
		AppSlug:         appSlug,
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

// TestSchedulerRunsIndependentApplicationsButSerializesOneApplication is the
// Task-5 concurrency test. With a 3-worker pool it queues app_a/v1, app_b/v1,
// app_a/v2 and asserts: app_a/v1 and app_b/v1 start CONCURRENTLY (two different
// apps), while app_a/v2 (same app as v1) stays QUEUED until app_a/v1 reaches a
// terminal state. Determinism comes from a blocking fake runner: the two
// first-app jobs block inside Run until released, holding their app slots so the
// claim for app_a/v2 returns nil; releasing app_a/v1 frees its slot so the next
// worker claim picks app_a/v2.
func TestSchedulerRunsIndependentApplicationsButSerializesOneApplication(t *testing.T) {
	// runner blocks every step until the test closes its release channel.
	releaseA1 := make(chan struct{})
	releaseB1 := make(chan struct{})
	runner := &blockingRunner{
		releases: map[string]chan struct{}{"a1": releaseA1, "b1": releaseB1},
		started:  make(chan string, 4),
	}
	e, st := newTestExecutorWithConcurrency(t, runner, 3)

	// Seed three jobs across two apps. created_at ordering: a1 < b1 < a2.
	idA1 := seedJobWithSlug(t, st, "app-a")
	idB1 := seedJobWithSlug(t, st, "app-b")
	idA2 := seedJobWithSlug(t, st, "app-a")
	runner.bindJob(idA1, "a1")
	runner.bindJob(idB1, "b1")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.Start(ctx)
	e.Signal()

	// app_a/v1 and app_b/v1 must both start (concurrent different-app runs).
	// Order is non-deterministic, so collect two starts into a set.
	collectStarted := func(n int) map[string]bool {
		got := map[string]bool{}
		for i := 0; i < n; i++ {
			select {
			case s := <-runner.started:
				got[s] = true
			case <-time.After(2 * time.Second):
				t.Fatalf("timeout waiting for start #%d; got %v", i+1, got)
			}
		}
		return got
	}
	first := collectStarted(2)
	if !first["a1"] || !first["b1"] {
		t.Fatalf("expected a1 AND b1 to start concurrently; got %v", first)
	}

	// app_a/v2 must NOT start while app_a/v1 is running (same-app serialization).
	timer := time.NewTimer(300 * time.Millisecond)
loopA2Blocked:
	for {
		select {
		case got := <-runner.started:
			if got != "a1" && got != "b1" {
				t.Fatalf("app_a/v2 (or another job) started while app_a/v1 running: got %q (same-app race)", got)
			}
		case <-timer.C:
			break loopA2Blocked
		}
	}
	timer.Stop()
	// And it must still be queued, not running.
	if j := mustJob(t, st, idA2); j.Status != model.JobStatusQueued {
		t.Fatalf("app_a/v2 = %s, want queued (same-app serialization held)", j.Status)
	}

	// Free app-a's slot by completing app_a/v1. Once a1 is no longer running,
	// app-a's slot is free and a2 MUST eventually become runnable (serialization
	// is live, not sticky). a1 runs through its remaining steps first (same-app
	// FIFO), so we wait for a2 to LEAVE the queued state within a generous bound.
	close(releaseA1)
	waitForNotQueued := func(jobID string) {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if j := mustJob(t, st, jobID); j.Status != model.JobStatusQueued {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("job %s never left queued (app-a slot never freed)", jobID)
	}
	waitForNotQueued(idA2)

	// Tear down: release b1 and cancel so workers exit cleanly.
	close(releaseB1)
	cancel()
}

// blockingRunner is a StepRunner that blocks each Run until a per-job release
// channel is closed, then returns a succeeded result. It reports each start on
// the started channel keyed by the bound label (so the test can distinguish the
// three jobs). It is the deterministic oracle for the scheduler concurrency test.
type blockingRunner struct {
	mu       sync.Mutex
	releases map[string]chan struct{}
	bindings map[string]string // jobID -> label
	started  chan string
}

func (b *blockingRunner) bindJob(jobID, label string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.bindings == nil {
		b.bindings = map[string]string{}
	}
	b.bindings[jobID] = label
}

func (b *blockingRunner) Run(ctx context.Context, job model.Job, _ model.JobStep, _ runner.StepRecordEmitter) (StepResult, error) {
	b.mu.Lock()
	label := b.bindings[job.ID]
	ch := b.releases[label]
	b.mu.Unlock()

	// Announce start (non-blocking; the channel is buffered to 4).
	if label != "" {
		select {
		case b.started <- label:
		default:
		}
	}

	// Block until the test releases this job, OR the run ctx is cancelled (tear
	// down). The select on ctx.Done() prevents a goroutine leak at test end.
	if ch != nil {
		select {
		case <-ch:
		case <-ctx.Done():
			return StepResult{Status: model.StepStatusCanceled, ErrorCode: model.ErrorCanceled}, ctx.Err()
		}
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

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

// TestExecutorRunOnceSerializesSameApp asserts the per-app serialization invariant
// that replaces the old single-global-slot design: once one job for an app is
// running, a second RunOnce for a DIFFERENT queued job of the SAME app claims
// nothing (nil) until the running job's app slot frees. This is the same-app
// serialization guarantee the destructive race (two jobs writing
// generated-apps/<slug>/ + the same image tag) requires. Determinism: a blocking
// fake holds a1 in running so the claim for a2 returns nil; completing a1 frees
// the slot so a2 becomes claimable.
func TestExecutorRunOnceSerializesSameApp(t *testing.T) {
	release := make(chan struct{})
	runner := &blockingRunner{releases: map[string]chan struct{}{}, started: make(chan string, 4)}
	e, st := newTestExecutorWithConcurrency(t, runner, 2)

	a1 := seedJobWithSlug(t, st, "app-a")
	a2 := seedJobWithSlug(t, st, "app-a")
	runner.bindJob(a1, "a1")
	runner.releases["a1"] = release

	// RunOnce #1 claims a1 and runs its requirement_analysis step, which blocks
	// in the fake runner until `release` is closed — holding a1 in running.
	doneCh := make(chan error, 1)
	go func() { doneCh <- e.RunOnce(context.Background()) }()
	select {
	case <-runner.started:
	case <-time.After(2 * time.Second):
		t.Fatalf("a1 never started")
	}
	if j := mustJob(t, st, a1); j.Status != model.JobStatusRunning {
		t.Fatalf("a1 = %s, want running", j.Status)
	}

	// RunOnce #2: a2 is queued but app-a has a running job → claim returns nil
	// → RunOnce is a no-op. a2 must stay queued.
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce #2: %v", err)
	}
	if j := mustJob(t, st, a2); j.Status != model.JobStatusQueued {
		t.Fatalf("a2 = %s, want queued (same-app serialization held while a1 runs)", j.Status)
	}

	// Release a1 → its step completes, advanceOrComplete re-queues a1 for the
	// next step. a1 is no longer running, so app-a's slot frees.
	close(release)
	if err := <-doneCh; err != nil {
		t.Fatalf("RunOnce #1 returned %v", err)
	}
	if j := mustJob(t, st, a1); j.Status != model.JobStatusQueued {
		t.Fatalf("a1 = %s, want queued (re-queued for next step)", j.Status)
	}

	// RunOnce #3: a1 (re-queued) and a2 are both app-a; only one may run. The
	// oldest runnable is claimed. a2 must still NOT be running concurrently.
	runner.releases["a1"] = nil // let subsequent a1 steps run without blocking
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce #3: %v", err)
	}
	// Exactly one of {a1, a2} may be non-queued; the other must stay queued.
	s1, s2 := mustJob(t, st, a1).Status, mustJob(t, st, a2).Status
	if s1 != model.JobStatusQueued && s2 != model.JobStatusQueued {
		t.Fatalf("both app-a jobs advanced (a1=%s a2=%s) — same-app serialization broken", s1, s2)
	}
}

// TestExecutorWritesStartedAndFinishedRecords is the Task-3 Step-1 lifecycle
// test: a succeeded step must persist at least a started + a completed system
// record, with the completed record's content EXACTLY "步骤已完成". The executor
// owns sequence + persistence; the runner is a no-op fake that just succeeds.
func TestExecutorWritesStartedAndFinishedRecords(t *testing.T) {
	e, st := newTestExecutor(t, &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepRequirementAnalysis: {Status: model.StepStatusSucceeded},
	}})
	jobID := seedJob(t, st)
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	steps, _ := st.ListJobSteps(context.Background(), jobID)
	step := stepByKind(t, steps, model.StepRequirementAnalysis)
	records, err := st.ListStepExecutionRecordPage(context.Background(), jobID, step.ID, 1, 0, 200)
	if err != nil {
		t.Fatalf("list records: %v", err)
	}
	if len(records) < 2 {
		t.Fatalf("records = %#v, want at least 2 (started + completed)", records)
	}
	if records[0].Kind != model.ExecutionRecordSystem {
		t.Fatalf("first record kind = %s, want system", records[0].Kind)
	}
	last := records[len(records)-1]
	if last.Kind != model.ExecutionRecordSystem || last.Content != "步骤已完成" {
		t.Fatalf("last record = {Kind:%s Content:%q}, want system/步骤已完成", last.Kind, last.Content)
	}
	// Sequences must be strictly ascending and contiguous (executor-assigned).
	for i, r := range records {
		if r.Sequence != i+1 {
			t.Fatalf("record[%d].Sequence = %d, want %d", i, r.Sequence, i+1)
		}
	}
}

// TestExecutorWritesFailedAndWaitingRecords covers the other terminal system
// records: a failed step emits "步骤执行失败" and a waiting_user step emits
// "步骤等待用户输入".
func TestExecutorWritesFailedAndWaitingRecords(t *testing.T) {
	t.Run("failed", func(t *testing.T) {
		e, st := newTestExecutor(t, &fakeRunner{byKind: map[model.StepKind]StepResult{
			model.StepRequirementAnalysis: {Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "boom"},
		}})
		jobID := seedJob(t, st)
		_ = e.RunOnce(context.Background())
		steps, _ := st.ListJobSteps(context.Background(), jobID)
		step := stepByKind(t, steps, model.StepRequirementAnalysis)
		records, _ := st.ListStepExecutionRecordPage(context.Background(), jobID, step.ID, 1, 0, 200)
		var lastContent string
		if len(records) > 0 {
			lastContent = records[len(records)-1].Content
		}
		if lastContent != "步骤执行失败" {
			t.Fatalf("last record content = %q, want 步骤执行失败", lastContent)
		}
	})
	t.Run("waiting_user", func(t *testing.T) {
		e, st := newTestExecutor(t, &fakeRunner{byKind: map[model.StepKind]StepResult{
			model.StepRequirementAnalysis: {Status: model.StepStatusWaitingUser, NeedsUserInput: true},
		}})
		jobID := seedJob(t, st)
		_ = e.RunOnce(context.Background())
		steps, _ := st.ListJobSteps(context.Background(), jobID)
		step := stepByKind(t, steps, model.StepRequirementAnalysis)
		records, _ := st.ListStepExecutionRecordPage(context.Background(), jobID, step.ID, 1, 0, 200)
		var lastContent string
		if len(records) > 0 {
			lastContent = records[len(records)-1].Content
		}
		if lastContent != "步骤等待用户输入" {
			t.Fatalf("last record content = %q, want 步骤等待用户输入", lastContent)
		}
	})
}

// TestExecutorMarksPersistenceFailedWhenStoreErrors verifies the mutex-guarded
// first-error logic: if the store rejects a record append, the executor surfaces
// execution_record_persistence_failed rather than claiming a fully-auditable
// success. We force the failure by inserting a duplicate (step_id, attempt,
// sequence) row before the run so the UNIQUE constraint trips on the first
// system record.
func TestExecutorMarksPersistenceFailedWhenStoreErrors(t *testing.T) {
	e, st := newTestExecutor(t, &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepRequirementAnalysis: {Status: model.StepStatusSucceeded},
	}})
	jobID := seedJob(t, st)
	steps, _ := st.ListJobSteps(context.Background(), jobID)
	step := stepByKind(t, steps, model.StepRequirementAnalysis)
	// Pre-insert a record at sequence 1 so the executor's first system record
	// (also sequence 1) collides on the UNIQUE(step_id, attempt, sequence).
	_ = st.AppendStepExecutionRecord(context.Background(), model.StepExecutionRecord{
		ID: "rec_pre", JobID: jobID, StepID: step.ID, Attempt: 1, Sequence: 1,
		Kind: model.ExecutionRecordSystem, Content: "pre-existing",
	})
	if err := e.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	updated := mustJob(t, st, jobID)
	if updated.Status != model.JobStatusFailed {
		t.Fatalf("job status = %s, want failed (persistence failed should fail the step)", updated.Status)
	}
	s := stepByKind(t, mustSteps(t, st, jobID), model.StepRequirementAnalysis)
	if s.ErrorCode != model.ErrorExecutionRecordPersistenceFailed {
		t.Fatalf("step error_code = %s, want execution_record_persistence_failed", s.ErrorCode)
	}
}

// blockingAppender is an instrumented recordAppender whose AppendStepExecutionRecord
// blocks until releaseCh is closed, then records the append in the orderObserved
// slice. It is the deterministic oracle for TestStepEmitterEmitHoldsLockAcrossAppendAndPublish:
// it proves the stepEmitter keeps s.mu held across BOTH the store append AND the
// OnRecord publish, so the second Emit cannot even ENTER the append until the
// first Emit's publish has completed.
type blockingAppender struct {
	mu            sync.Mutex
	enterCh       chan struct{} // signalled once when the first append enters
	releaseCh     chan struct{} // closed to let the first append return
	orderObserved []int         // append enter order by sequence, guarded by mu
	enteredCount  int32
}

func (b *blockingAppender) AppendStepExecutionRecord(_ context.Context, rec model.StepExecutionRecord) error {
	b.mu.Lock()
	b.orderObserved = append(b.orderObserved, rec.Sequence)
	b.mu.Unlock()
	// First append blocks until the test releases it; this is what lets the
	// test observe whether a second append can start concurrently.
	if atomic.AddInt32(&b.enteredCount, 1) == 1 {
		select {
		case <-b.releaseCh:
		default:
			close(b.enterCh)
			<-b.releaseCh
		}
	}
	return nil
}

// TestStepEmitterEmitHoldsLockAcrossAppendAndPublish is the F6 regression: it
// proves s.mu spans the store append AND the OnRecord publish. With the lock
// held across both, the SECOND Emit's append cannot start until the FIRST Emit
// has returned from its publish — so the published order strictly matches
// ascending sequence. With the pre-fix code (unlock before append), two
// concurrent emits could persist+publish 2-then-1.
//
// Deterministic approach: blockingAppender makes the first append block on
// releaseCh. The second Emit is started concurrently; it MUST still be blocked
// (mu held) while the first is stalled in append. We then release the first;
// after both finish we assert the publish order equals [1, 2, 3, ...] ascending.
func TestStepEmitterEmitHoldsLockAcrossAppendAndPublish(t *testing.T) {
	app := &blockingAppender{
		enterCh:   make(chan struct{}, 1),
		releaseCh: make(chan struct{}),
	}

	var (
		pubMu    sync.Mutex
		pubOrder []int // sequence numbers in publish order
	)
	onRecord := func(_ context.Context, u runner.ExecutionRecordUpdate) {
		pubMu.Lock()
		pubOrder = append(pubOrder, u.Record.Sequence)
		pubMu.Unlock()
	}
	emit := &stepEmitter{
		store:    app,
		onRecord: onRecord,
		jobID:    "job_f6",
		stepID:   "step_f6",
		attempt:  1,
		nextSeq:  1,
	}

	ctx := context.Background()
	// Emit seq 1 (blocks in the appender).
	go func() { _ = emit.Emit(ctx, model.ExecutionRecordActivity, "first") }()
	<-app.enterCh // first append has entered and is now blocked

	// While seq 1 is blocked inside the append, start seq 2 and seq 3. With the
	// lock spanning append+publish, these MUST be queued behind s.mu and cannot
	// enter the appender yet.
	done2 := make(chan struct{})
	done3 := make(chan struct{})
	go func() { defer close(done2); _ = emit.Emit(ctx, model.ExecutionRecordActivity, "second") }()
	go func() { defer close(done3); _ = emit.Emit(ctx, model.ExecutionRecordActivity, "third") }()

	// Give the second/third emitters a chance to race ahead if the lock were NOT
	// held across append+publish. Under the fix they stay blocked on s.mu.
	time.Sleep(50 * time.Millisecond)
	app.mu.Lock()
	entered := len(app.orderObserved)
	app.mu.Unlock()
	if entered != 1 {
		t.Fatalf("lock not held across append: %d appends entered while first was blocked (want 1)", entered)
	}

	// Release the first append. Now 2 then 3 proceed strictly in order.
	close(app.releaseCh)
	<-done2
	<-done3

	pubMu.Lock()
	got := append([]int(nil), pubOrder...)
	pubMu.Unlock()

	if len(got) != 3 {
		t.Fatalf("published %d records, want 3: %v", len(got), got)
	}
	for i, seq := range got {
		if seq != i+1 {
			t.Fatalf("publish order not ascending: %v (want [1 2 3])", got)
		}
	}
}

// TestStepEmitterEmitRedactsBeforePersistAndPublish is the P1 regression for the
// live-record credential leak. The stepEmitter is the SINGLE chokepoint every
// record — command_stdout, command_stderr, activity, summary, system lifecycle —
// passes through before it is appended to the store and published over SSE. A
// credential in command output must therefore be masked in BOTH the persisted
// store row AND the OnRecord payload, never raw. The design
// (software-factory-task-observability-design.md "写入执行记录前脱敏") and the
// runbook ("Before any record or artifact is persisted") require redaction at
// exactly this point. Before the fix the factory stream batcher and the Claude
// stderr callback emitted raw output, and a test even asserted the raw secret
// survived — credentials then reached the DB and the SSE fan-out.
//
// Deterministic: capturingAppender records exactly what stepEmitter handed it,
// and the onRecord closure records exactly what was published, so both halves of
// the invariant are checked directly. It also asserts a plain system record is
// left untouched, proving redaction is content-based (not kind-based): fixed
// Chinese status strings never carry credentials and so are never altered.
func TestStepEmitterTraceStampsAgentKey(t *testing.T) {
	var got model.WorkTraceEvent
	emit := &stepEmitter{
		jobID:      "job_trace",
		stepID:     "step_trace",
		agentKey:   "designer",
		dialogueID: "dlg_trace",
		attempt:    3,
		onTrace: func(_ context.Context, ev model.WorkTraceEvent) (model.WorkTraceEvent, error) {
			got = ev
			return ev, nil
		},
	}
	if err := emit.Trace(context.Background(), string(model.WorkTraceClarification), `{"questions":[]}`); err != nil {
		t.Fatalf("Trace: %v", err)
	}
	if got.TaskID != "job_trace" || got.StepID != "step_trace" || got.Attempt != 3 || got.AgentKey != "designer" {
		t.Fatalf("trace attribution = %#v", got)
	}
}

func TestStepEmitterEmitRedactsBeforePersistAndPublish(t *testing.T) {
	app := &capturingAppender{}
	var pubMu sync.Mutex
	var published model.StepExecutionRecord
	onRecord := func(_ context.Context, u runner.ExecutionRecordUpdate) {
		pubMu.Lock()
		published = u.Record
		pubMu.Unlock()
	}
	emit := &stepEmitter{
		store:    app,
		onRecord: onRecord,
		jobID:    "job_p1",
		stepID:   "step_p1",
		attempt:  1,
		nextSeq:  1,
	}
	ctx := context.Background()

	// A command_stderr carrying both the Authorization header form and a
	// key=value env-dump form of a secret (mirrors npm/podman/Claude output).
	if err := emit.Emit(ctx, model.ExecutionRecordCommandStderr,
		"Authorization: Bearer leak-xyz\nDB_PASSWORD=hunter2"); err != nil {
		t.Fatalf("Emit: %v", err)
	}

	if len(app.records) != 1 {
		t.Fatalf("appended %d records, want 1", len(app.records))
	}
	persisted := app.records[0].Content

	// Both the persisted row and the published payload must be redacted.
	for _, secret := range []string{"leak-xyz", "hunter2"} {
		if strings.Contains(persisted, secret) {
			t.Errorf("persisted record leaked secret %q:\n%s", secret, persisted)
		}
		if strings.Contains(published.Content, secret) {
			t.Errorf("published record leaked secret %q:\n%s", secret, published.Content)
		}
	}
	if !strings.Contains(persisted, "[REDACTED]") {
		t.Errorf("persisted record missing [REDACTED]:\n%s", persisted)
	}
	if !strings.Contains(published.Content, "[REDACTED]") {
		t.Errorf("published record missing [REDACTED]:\n%s", published.Content)
	}

	// A plain system lifecycle record must pass through verbatim — redaction is
	// content-based, so fixed status strings are never altered.
	if err := emit.Emit(ctx, model.ExecutionRecordSystem, systemRecordCompleted); err != nil {
		t.Fatalf("Emit system: %v", err)
	}
	pubMu.Lock()
	lastPersisted := app.records[len(app.records)-1].Content
	lastPublished := published.Content
	pubMu.Unlock()
	if lastPersisted != systemRecordCompleted {
		t.Errorf("system record altered by redaction: got %q want %q", lastPersisted, systemRecordCompleted)
	}
	if lastPublished != systemRecordCompleted {
		t.Errorf("published system record altered by redaction: got %q want %q", lastPublished, systemRecordCompleted)
	}
}

// capturingAppender is an instrumented recordAppender that records every appended
// record verbatim. It is the oracle for
// TestStepEmitterEmitRedactsBeforePersistAndPublish: it proves the content the
// stepEmitter persisted was already redacted (the security-critical half — the
// store row is what the audit trail and REST endpoint serve).
type capturingAppender struct {
	mu      sync.Mutex
	records []model.StepExecutionRecord
}

func (c *capturingAppender) AppendStepExecutionRecord(_ context.Context, rec model.StepExecutionRecord) error {
	c.mu.Lock()
	c.records = append(c.records, rec)
	c.mu.Unlock()
	return nil
}

// minimalCollaborationPlanJSON is a minimal valid collaboration plan carrying
// the repair policy {2,1}. seedCollaborationJob persists it on the job so the
// executor's plan-aware traversal + bounded-repair policy activate.
func minimalCollaborationPlanJSON() string {
	plan := map[string]any{
		"schemaVersion": 1,
		"mode":          "topological_serial",
		"repairPolicy": map[string]any{
			"maxAutomaticRepairs":                  2,
			"maxAutomaticRepairsPerBlockingReason": 1,
		},
		"lanes": []map[string]any{
			{"id": "generation", "label": "生成"},
			{"id": "delivery", "label": "交付"},
		},
		"agents": []map[string]any{},
		"edges":  []map[string]any{},
	}
	b, _ := json.Marshal(plan)
	return string(b)
}

// seedCollaborationJob seeds a queued job whose CollaborationPlanJSON is set (so
// the plan-aware traversal path activates) with a representative topological
// step sequence INCLUDING code_review right after code_generation:
//
//	1 requirement_analysis → 2 code_generation → 3 code_review →
//	4 test_verification → 5 image_build → 6 deployment
//
// It does NOT use the legacy six FixedSteps (there is no solution_design, and
// code_review is inserted) — this is the collaboration-plan topology. The first
// step is the CurrentStepKind so the executor starts at the head. This helper is
// used ONLY by the collaboration-gate tests; the legacy seedJob (used by dozens
// of executor tests) is unchanged.
func seedCollaborationJob(t *testing.T, st *store.Store) string {
	t.Helper()
	now := time.Now()
	jobID := "job_collab_" + itoa(int(randCounter.Add(1)))
	job := model.Job{
		ID:                    jobID,
		UserPrompt:            "build me a collaboration thing",
		Status:                model.JobStatusQueued,
		CurrentStepKind:       model.StepRequirementAnalysis,
		CollaborationPlanJSON: minimalCollaborationPlanJSON(),
		CreatedAt:             now,
		UpdatedAt:             now,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create collaboration job: %v", err)
	}
	defs := []struct {
		kind     model.StepKind
		seq      int
		agentKey string
	}{
		{model.StepRequirementAnalysis, 1, "requirement-analyst"},
		{model.StepCodeGeneration, 2, "code-generator"},
		{model.StepCodeReview, 3, "code-reviewer"},
		{model.StepTestVerification, 4, "tester"},
		{model.StepImageBuild, 5, "image-builder"},
		{model.StepDeployment, 6, "deployer"},
	}
	for _, def := range defs {
		step := model.JobStep{
			ID:       "step_collab_" + string(def.kind) + "_" + itoa(int(randCounter.Add(1))),
			JobID:    jobID,
			Kind:     def.kind,
			Seq:      def.seq,
			AgentKey: def.agentKey,
			Status:   model.StepStatusPending,
			Attempt:  0,
		}
		if err := st.CreateJobStep(context.Background(), step); err != nil {
			t.Fatalf("create step %s: %v", def.kind, err)
		}
	}
	return jobID
}

// repairStateJSON is the executor's repairState projection persisted inside the
// job's CollaborationPlanJSON. It is decoded here only by the collaboration-gate
// tests to assert the bounded-repair counters.
type repairStateJSON struct {
	TotalAutomaticRepairs int            `json:"totalAutomaticRepairs"`
	ByReason              map[string]int `json:"byReason"`
}

func decodeRepairState(t *testing.T, planJSON string) repairStateJSON {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(planJSON), &doc); err != nil {
		t.Fatalf("unmarshal collaboration_plan_json: %v", err)
	}
	var rs repairStateJSON
	if raw, ok := doc["repairState"]; ok {
		if err := json.Unmarshal(raw, &rs); err != nil {
			t.Fatalf("unmarshal repairState: %v", err)
		}
	}
	return rs
}

// runUntil blocks drive the executor one RunOnce at a time until cond(job)
// returns true or attempts is exhausted. Unlike drain (which only stops when NO
// queued job remains), runUntil lets a test observe a NON-terminal intermediate
// state — e.g. the post-repair "queued/code_generation" state that a looping
// drain would skip past by immediately re-running the repaired step. This is the
// exact mechanic the dispatch asked for: drive step-by-step and snapshot mustJob
// at the observation point rather than rely on drain's terminal-only stopping.
func runUntil(t *testing.T, ctx context.Context, e *Executor, id string, maxAttempts int, cond func(model.Job) bool) model.Job {
	t.Helper()
	for i := 0; i < maxAttempts; i++ {
		if err := e.RunOnce(ctx); err != nil {
			t.Fatalf("RunOnce[%d]: %v", i, err)
		}
		job := mustJob(t, e.store, id)
		if cond(job) {
			return job
		}
	}
	return mustJob(t, e.store, id)
}

// TestExecutorAutoRepairFromBlockingReviewOnce proves the bounded-repair policy
// allows EXACTLY ONE auto-repair for a repairable blocking-review failure. The
// fake runner blocks code_review with ErrorBlockingReview and succeeds every
// other step. We expect: when code_review fails, the executor (instead of
// MarkJobFailed) rewinds to code_generation, re-queues the job, and persists
// repairState.totalAutomaticRepairs==1 with byReason keyed on the blocking
// reason.
//
// MECHANIC (adapted from the brief's literal drain-count form): the brief's
// tests called drain and asserted "queued/code_generation after 1 drain." But a
// looping drain re-runs the rewound code_generation → code_review within the
// SAME drain and hits the per-reason limit, so the literal "1 drain → queued"
// assertion is impossible. Instead we drive the executor step-by-step with
// runUntil and stop at the FIRST time the job is observed re-queued at
// code_generation after a repair — the unambiguous post-repair checkpoint. This
// isolates the "one repair allowed" property from the "repeated reason stops"
// property proven by the next test.
func TestExecutorAutoRepairFromBlockingReviewOnce(t *testing.T) {
	blockingMsg := "数据接入契约未被代码使用"
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepCodeReview: {
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorBlockingReview,
			ErrorMessage: blockingMsg,
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedCollaborationJob(t, st)

	ctx := context.Background()
	// Drive until the job has been repaired back to code_generation (the first
	// re-queue), or until it terminates. 20 RunOnce steps is more than enough to
	// reach code_review from requirement_analysis even with a repair rewind.
	job := runUntil(t, ctx, e, id, 20, func(j model.Job) bool {
		// Stop at the post-repair checkpoint: re-queued at code_generation AFTER
		// the code_review step has already run at least once (so the failure was
		// observed and repaired, not the initial seed state).
		if j.Status != model.JobStatusQueued || j.CurrentStepKind != model.StepCodeGeneration {
			return false
		}
		cr := stepByKindOrNil(st, id, model.StepCodeReview)
		return cr.Status == model.StepStatusPending && cr.Attempt >= 1
	})

	if job.Status != model.JobStatusQueued || job.CurrentStepKind != model.StepCodeGeneration {
		t.Fatalf("job after blocking review = %s/%s, want queued/code_generation", job.Status, job.CurrentStepKind)
	}
	rs := decodeRepairState(t, job.CollaborationPlanJSON)
	if rs.TotalAutomaticRepairs != 1 {
		t.Fatalf("repairState.totalAutomaticRepairs = %d, want 1", rs.TotalAutomaticRepairs)
	}
	wantKey := "code_review:blocking_review:" + blockingMsg
	if got := rs.ByReason[wantKey]; got != 1 {
		t.Fatalf("byReason[%q] = %d, want 1", wantKey, got)
	}
}

func TestExecutorAutoRepairPassesBlockingReasonToCodeGeneration(t *testing.T) {
	blockingMsg := "数据接入契约未被代码使用"
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepCodeReview: {
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorBlockingReview,
			ErrorMessage: blockingMsg,
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedCollaborationJob(t, st)

	job := runUntil(t, context.Background(), e, id, 20, func(j model.Job) bool {
		if j.Status != model.JobStatusQueued || j.CurrentStepKind != model.StepCodeGeneration {
			return false
		}
		cr := stepByKindOrNil(st, id, model.StepCodeReview)
		return cr.Status == model.StepStatusPending && cr.Attempt >= 1
	})
	if job.Status != model.JobStatusQueued || job.CurrentStepKind != model.StepCodeGeneration {
		t.Fatalf("job after blocking review = %s/%s, want queued/code_generation", job.Status, job.CurrentStepKind)
	}
	code := stepByKind(t, mustSteps(t, st, id), model.StepCodeGeneration)
	for _, want := range []string{"repair_from_failure", "failed_step: code_review", "error_code: blocking_review", blockingMsg} {
		if !strings.Contains(code.UserPrompt, want) {
			t.Fatalf("code_generation repair prompt missing %q:\n%s", want, code.UserPrompt)
		}
	}
}

// stepByKindOrNil returns the step for kind, or a zero JobStep if absent. Unlike
// stepByKind it does not fatal on a miss — used for conditional observation.
func stepByKindOrNil(st *store.Store, id string, k model.StepKind) model.JobStep {
	steps, err := st.ListJobSteps(context.Background(), id)
	if err != nil {
		return model.JobStep{}
	}
	for _, s := range steps {
		if s.Kind == k {
			return s
		}
	}
	return model.JobStep{}
}

// TestExecutorStopsAfterRepeatedBlockingReason proves that when the SAME
// blocking reason recurs (byReason already at the per-reason limit of 1), the
// job is NOT repaired again and ends Failed. The fake runner always blocks
// code_review with the identical reason, so after the first repair the second
// code_review failure must trip the per-reason cap and fail the job terminally.
// We also assert totalAutomaticRepairs never exceeds the policy cap (2).
func TestExecutorStopsAfterRepeatedBlockingReason(t *testing.T) {
	blockingMsg := "same:blocking-review:data-contract"
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepCodeReview: {
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorBlockingReview,
			ErrorMessage: blockingMsg,
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedCollaborationJob(t, st)

	ctx := context.Background()
	// Drain to terminal. With the per-reason cap at 1, the recurring identical
	// blocking reason is repaired at most once, then the second occurrence fails
	// the job terminally — so drain (which stops at no-queued-job) DOES terminate
	// here, at status Failed. This is the case where drain's terminal-only
	// stopping is correct: the job ends, it is not re-queued forever.
	drain(t, ctx, e)
	job := mustJob(t, st, id)
	if job.Status != model.JobStatusFailed {
		t.Fatalf("job status = %s, want failed after repeated blocking reason", job.Status)
	}
	rs := decodeRepairState(t, job.CollaborationPlanJSON)
	if rs.TotalAutomaticRepairs > 2 {
		t.Fatalf("totalAutomaticRepairs = %d, want <= cap 2", rs.TotalAutomaticRepairs)
	}
	// The first repair incremented byReason[key] to 1; the second identical
	// failure must NOT have been repaired (per-reason cap hit), so byReason[key]
	// stays at 1 even though code_review failed twice with the same message.
	wantKey := "code_review:blocking_review:" + blockingMsg
	if got := rs.ByReason[wantKey]; got != 1 {
		t.Fatalf("byReason[%q] = %d, want 1 (per-reason cap stops the 2nd)", wantKey, got)
	}
}

	func TestStepEmitterThinkStampsTaskAttribution(t *testing.T) {
		var got model.TaskThinkingEvent
		emit := &stepEmitter{
			jobID:      "job_t",
			stepID:     "step_t",
			agentKey:   "designer",
			dialogueID: "dlg_t",
			attempt:    4,
			onThinking: func(_ context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error) {
				got = ev
				return ev, nil
			},
		}
		if err := emit.Think(context.Background(), "private"); err != nil {
			t.Fatalf("Think: %v", err)
		}
		if got.DialogueID != "dlg_t" || got.TaskID != "job_t" || got.StepID != "step_t" || got.Attempt != 4 || got.AgentKey != "designer" || got.Content != "private" {
			t.Fatalf("thinking attribution = %#v", got)
		}
	}
