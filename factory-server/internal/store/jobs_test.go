package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// seedQueuedJobWithSlug inserts a queued job row for a given app_slug with all
// six FixedSteps pending (mirrors the executor test's seedJob but lives in the
// store package so it can drive ClaimNextRunnableJob directly).
func seedQueuedJobWithSlug(t *testing.T, st *Store, jobID, appSlug string, created time.Time) {
	t.Helper()
	job := model.Job{
		ID:              jobID,
		AppSlug:         appSlug,
		UserPrompt:      "p",
		Status:          model.JobStatusQueued,
		CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt:       created,
		UpdatedAt:       created,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job %s: %v", jobID, err)
	}
	for _, def := range fixedStepsForSeed() {
		step := model.JobStep{
			ID:       "st_" + jobID + "_" + string(def.Kind),
			JobID:    jobID,
			Kind:     def.Kind,
			Seq:      def.Seq,
			AgentKey: def.AgentKey,
			Status:   model.StepStatusPending,
		}
		if err := st.CreateJobStep(context.Background(), step); err != nil {
			t.Fatalf("create step %s: %v", def.Kind, err)
		}
	}
}

// fixedStepsForSeed mirrors executor.FixedSteps ordering for seeding test steps
// without importing the executor package (avoid a test import cycle).
func fixedStepsForSeed() []model.JobStep {
	return []model.JobStep{
		{Kind: model.StepRequirementAnalysis, Seq: 1},
		{Kind: model.StepSolutionDesign, Seq: 2},
		{Kind: model.StepCodeGeneration, Seq: 3},
		{Kind: model.StepTestVerification, Seq: 4},
		{Kind: model.StepImageBuild, Seq: 5},
		{Kind: model.StepDeployment, Seq: 6},
	}
}

// TestClaimNextRunnableJobSerializesByAppSlug asserts the claim excludes queued
// jobs whose app_slug already has a running job: the second claim for the same
// slug returns nil, while a queued job for a different slug is still claimable.
func TestClaimNextRunnableJobSerializesByAppSlug(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	t0 := time.UnixMilli(1000)
	t1 := time.UnixMilli(2000)
	t2 := time.UnixMilli(3000)
	seedQueuedJobWithSlug(t, st, "job_a1", "app-a", t0) // oldest, app-a
	seedQueuedJobWithSlug(t, st, "job_b1", "app-b", t1) // app-b
	seedQueuedJobWithSlug(t, st, "job_a2", "app-a", t2) // app-a, queued after

	// First claim: oldest runnable = job_a1 (app-a).
	got, err := st.ClaimNextRunnableJob(context.Background(), "w1")
	if err != nil {
		t.Fatalf("claim #1: %v", err)
	}
	if got == nil {
		t.Fatalf("claim #1 returned nil, want job_a1")
	}
	if got.ID != "job_a1" {
		t.Fatalf("claim #1 = %s, want job_a1", got.ID)
	}
	if got.Status != model.JobStatusRunning {
		t.Fatalf("claim #1 status = %s, want running", got.Status)
	}

	// Second claim: job_a2 is queued but app-a now has a running job → skipped.
	// job_b1 (app-b) has no running job → claimed.
	got, err = st.ClaimNextRunnableJob(context.Background(), "w2")
	if err != nil {
		t.Fatalf("claim #2: %v", err)
	}
	if got == nil {
		t.Fatalf("claim #2 returned nil, want job_b1")
	}
	if got.ID != "job_b1" {
		t.Fatalf("claim #2 = %s, want job_b1 (app-a still serialized)", got.ID)
	}

	// Third claim: both app-a and app-b have running jobs → nothing runnable.
	got, err = st.ClaimNextRunnableJob(context.Background(), "w3")
	if err != nil {
		t.Fatalf("claim #3: %v", err)
	}
	if got != nil {
		t.Fatalf("claim #3 = %s, want nil (both apps busy)", got.ID)
	}

	// job_a1 still queued-pending-app-a-running: confirm it is NOT running.
	if j, _ := st.GetJob(context.Background(), "job_a2"); j == nil || j.Status != model.JobStatusQueued {
		t.Fatalf("job_a2 status = %v, want queued (same-app serialization)", j)
	}
}

// TestClaimNextRunnableJobReleasesOnTerminal asserts that once a running job for
// an app reaches a terminal state, the next queued job for the same slug becomes
// claimable again (the running-job exclusion is live, not sticky).
func TestClaimNextRunnableJobReleasesOnTerminal(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	t0 := time.UnixMilli(1000)
	t1 := time.UnixMilli(2000)
	seedQueuedJobWithSlug(t, st, "job_a1", "app-a", t0)
	seedQueuedJobWithSlug(t, st, "job_a2", "app-a", t1)

	if _, err := st.ClaimNextRunnableJob(context.Background(), "w1"); err != nil {
		t.Fatalf("claim #1: %v", err)
	}
	if got, _ := st.ClaimNextRunnableJob(context.Background(), "w2"); got != nil {
		t.Fatalf("claim #2 = %s, want nil while app-a running", got.ID)
	}

	// job_a1 completes → its app slot frees.
	if err := st.MarkJobCompleted(context.Background(), "job_a1"); err != nil {
		t.Fatalf("complete job_a1: %v", err)
	}

	got, err := st.ClaimNextRunnableJob(context.Background(), "w3")
	if err != nil {
		t.Fatalf("claim #3: %v", err)
	}
	if got == nil || got.ID != "job_a2" {
		t.Fatalf("claim #3 = %v, want job_a2 after app-a freed", got)
	}
}

// TestClaimNextRunnableJobStartsAtTimestamp asserts the claim stamps started_at
// (first run only) so it is distinct from the queue time created_at.
func TestClaimNextRunnableJobStartsAtTimestamp(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	created := time.UnixMilli(1000)
	seedQueuedJobWithSlug(t, st, "job_x", "app-x", created)

	got, err := st.ClaimNextRunnableJob(context.Background(), "w1")
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if got == nil {
		t.Fatalf("claim returned nil")
	}
	if got.StartedAt == nil {
		t.Fatalf("started_at not set on claim")
	}
	// created_at is the queue time (1000ms); started_at is the execution start
	// and must be >= created_at and distinct from it.
	if got.StartedAt.Before(got.CreatedAt) {
		t.Fatalf("started_at %v < created_at %v", *got.StartedAt, got.CreatedAt)
	}
}

// TestCountRunningJobsByAppSlug asserts the running-job check used by rebuildApp
// to scope executor-busy per app.
func TestCountRunningJobsByAppSlug(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	seedQueuedJobWithSlug(t, st, "job_a1", "app-a", time.UnixMilli(1000))
	seedQueuedJobWithSlug(t, st, "job_b1", "app-b", time.UnixMilli(2000))

	if _, err := st.ClaimNextRunnableJob(context.Background(), "w1"); err != nil {
		t.Fatalf("claim a1: %v", err)
	}

	if n, _ := st.CountRunningJobsByAppSlug(context.Background(), "app-a"); n != 1 {
		t.Fatalf("running app-a = %d, want 1", n)
	}
	if n, _ := st.CountRunningJobsByAppSlug(context.Background(), "app-b"); n != 0 {
		t.Fatalf("running app-b = %d, want 0", n)
	}
	if n, _ := st.CountRunningJobsByAppSlug(context.Background(), "app-z"); n != 0 {
		t.Fatalf("running app-z = %d, want 0", n)
	}
}
