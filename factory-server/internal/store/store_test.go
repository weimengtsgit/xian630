package store

import (
	"context"
	"path/filepath"
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

// TestOpenMigratesStepExecutionRecordsIdempotently proves the CREATE TABLE IF
// NOT EXISTS migration is safe to run against an existing database that already
// has the table (e.g. a real ~/.software-factory/state.db across versions).
func TestOpenMigratesStepExecutionRecordsIdempotently(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "state.db")

	// First open: schema applied, table created.
	st1, err := Open(dbPath)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	appendRecord(t, st1, "job_m", "step_m", 1, 1, "system", "seed")
	if err := st1.Close(); err != nil {
		t.Fatalf("close st1: %v", err)
	}

	// Second open against the SAME on-disk database: must not error and must
	// preserve the seeded row.
	st2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("second open (migration): %v", err)
	}
	t.Cleanup(func() { _ = st2.Close() })

	got, err := st2.ListStepExecutionRecordPage(context.Background(), "job_m", "step_m", 1, 0, 200)
	if err != nil {
		t.Fatalf("list after reopen: %v", err)
	}
	if len(got) != 1 || got[0].Content != "seed" {
		t.Fatalf("seed row lost across reopen: %#v", got)
	}
}
