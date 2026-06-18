package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// newFakeClaudeTestStore returns an in-memory store (no seeded app — the fake
// runner is expected to upsert the generated app itself).
func newFakeClaudeTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// fakeClaudeJobStep builds a job + a single running step of the given kind. The
// job has no CreatedAppID: code_generation must populate it.
func fakeClaudeJobStep(kind model.StepKind) (model.Job, model.JobStep) {
	job := model.Job{
		ID:              "job_fake_1",
		UserPrompt:      "x",
		Status:          model.JobStatusRunning,
		CurrentStepKind: kind,
	}
	step := model.JobStep{
		ID:      "step_" + string(kind),
		JobID:   "job_fake_1",
		Kind:    kind,
		Seq:     1,
		Status:  model.StepStatusRunning,
		Attempt: 1,
	}
	return job, step
}

// readOutputJSON reads the output.json for the given job/step from the artifact
// root and unmarshals it into *m.
func readOutputJSON(t *testing.T, artifactRoot string, job model.Job, step model.JobStep, m *map[string]any) {
	t.Helper()
	w := runner.AttemptWorkspace{Root: artifactRoot, JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	raw, err := os.ReadFile(w.OutputPath())
	if err != nil {
		t.Fatalf("read output.json %s: %v", w.OutputPath(), err)
	}
	if err := json.Unmarshal(raw, m); err != nil {
		t.Fatalf("parse output.json: %v", err)
	}
}

// TestFakeClaudeRequirementAnalysisWritesOutput: requirement_analysis writes a
// valid output.json (with appType/questions) and returns succeeded.
func TestFakeClaudeRequirementAnalysisWritesOutput(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepRequirementAnalysis)
	res, err := r.Run(context.Background(), job, step)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}
	var out map[string]any
	readOutputJSON(t, art, job, step, &out)
	if out["appType"] != "timeline-replay" {
		t.Fatalf("appType = %v, want timeline-replay", out["appType"])
	}
	if _, ok := out["questions"]; !ok {
		t.Fatalf("output missing questions field")
	}
	if out["needsUserInput"] != false {
		t.Fatalf("needsUserInput = %v, want false", out["needsUserInput"])
	}
}

func TestFakeClaudeCustomAgentWritesOutput(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepKind("log_analysis"))
	step.AgentKey = "log-analyst"
	res, err := r.Run(context.Background(), job, step)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}
	var out map[string]any
	readOutputJSON(t, art, job, step, &out)
	if out["needsUserInput"] != false {
		t.Fatalf("needsUserInput = %v, want false", out["needsUserInput"])
	}
	if out["summary"] == "" {
		t.Fatalf("summary is empty")
	}
}

// TestFakeClaudeSolutionDesignWritesOutput: solution_design writes output.json
// declaring the generated app slug/type/source and returns succeeded.
func TestFakeClaudeSolutionDesignWritesOutput(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepSolutionDesign)
	res, err := r.Run(context.Background(), job, step)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}
	var out map[string]any
	readOutputJSON(t, art, job, step, &out)
	app, _ := out["app"].(map[string]any)
	if app == nil || app["slug"] != "factory-demo" || app["type"] != "timeline-replay" || app["source"] != "generated" {
		t.Fatalf("app block = %v, want slug=factory-demo type=timeline-replay source=generated", app)
	}
}

// TestFakeClaudeCodeGenerationWritesApp: code_generation writes output.json, lays
// down a real buildable generated app (package.json, .factory/app.json,
// Dockerfile, nginx.conf, src), upserts the app in the store and links the job
// to it (CreatedAppID/slug/name set).
func TestFakeClaudeCodeGenerationWritesApp(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepCodeGeneration)
	// Seed the job row so SetJobCreatedApp/GetJob reflect the link the runner
	// writes — the real executor creates the job before any step runs.
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	res, err := r.Run(context.Background(), job, step)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}

	// output.json present with the projectDir.
	var out map[string]any
	readOutputJSON(t, art, job, step, &out)
	if out["projectDir"] != "generated-apps/factory-demo" {
		t.Fatalf("projectDir = %v, want generated-apps/factory-demo", out["projectDir"])
	}

	appDir := filepath.Join(ws, "generated-apps", "factory-demo")
	for _, rel := range []string{
		"package.json",
		"vite.config.js",
		"index.html",
		filepath.Join("src", "main.jsx"),
		filepath.Join("src", "App.jsx"),
		filepath.Join(".factory", "app.json"),
		"Dockerfile",
		"nginx.conf",
	} {
		if _, err := os.Stat(filepath.Join(appDir, rel)); err != nil {
			t.Fatalf("generated app missing %s: %v", rel, err)
		}
	}

	// The generated app must be present in ListApplications.
	apps, err := st.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("list apps: %v", err)
	}
	var found *model.Application
	for i := range apps {
		if apps[i].Slug == "factory-demo" {
			found = &apps[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("generated app factory-demo not in store after code_generation")
	}
	if found.Source != model.AppSourceGenerated {
		t.Fatalf("app source = %s, want generated", found.Source)
	}
	if found.Path != "generated-apps/factory-demo" {
		t.Fatalf("app path = %s, want generated-apps/factory-demo", found.Path)
	}
	if found.ManifestPath != "generated-apps/factory-demo/.factory/app.json" {
		t.Fatalf("app manifest_path = %s, want generated-apps/factory-demo/.factory/app.json", found.ManifestPath)
	}

	// Job must be linked to the app.
	got, err := st.GetJob(context.Background(), job.ID)
	if err != nil || got == nil {
		t.Fatalf("get job: %v (%v)", err, got)
	}
	if got.CreatedAppID != "app-factory-demo" {
		t.Fatalf("job.created_app_id = %q, want app-factory-demo", got.CreatedAppID)
	}
	if got.AppSlug != "factory-demo" || got.AppName != "Factory Demo" {
		t.Fatalf("job app slug/name = %q/%q, want factory-demo/Factory Demo", got.AppSlug, got.AppName)
	}
}

// TestFakeClaudeCodeGenerationIsIdempotent: running code_generation twice does
// not error (UpsertApplication + repeated writes are idempotent). The job link
// is still set on the second run.
func TestFakeClaudeCodeGenerationIsIdempotent(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepCodeGeneration)
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	for i := 0; i < 2; i++ {
		res, err := r.Run(context.Background(), job, step)
		if err != nil {
			t.Fatalf("Run %d: %v", i+1, err)
		}
		if res.Status != model.StepStatusSucceeded {
			t.Fatalf("Run %d status = %s (%s), want succeeded", i+1, res.Status, res.ErrorMessage)
		}
	}
	apps, err := st.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("list apps: %v", err)
	}
	count := 0
	for _, a := range apps {
		if a.Slug == "factory-demo" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one factory-demo app row after 2 runs, got %d", count)
	}
}

// TestFakeClaudeUnhandledStepFails: a non-claude step kind fails fast with
// ErrorUnknown rather than being silently accepted.
func TestFakeClaudeUnhandledStepFails(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"), Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepDeployment) // a factory step kind
	res, err := r.Run(context.Background(), job, step)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed || res.ErrorCode != model.ErrorUnknown {
		t.Fatalf("status/error = %s/%s, want failed/unknown", res.Status, res.ErrorCode)
	}
}

// TestFakeClaudeSlugDefaultsToFactoryDemo: an empty Slug field defaults to the
// generated-app slug "factory-demo".
func TestFakeClaudeSlugDefaultsToFactoryDemo(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"), Slug: ""}

	if got, want := r.slug(), "factory-demo"; got != want {
		t.Fatalf("slug() = %q, want %q", got, want)
	}
	// And code_generation uses the default slug end-to-end.
	job, step := fakeClaudeJobStep(model.StepCodeGeneration)
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	res, err := r.Run(context.Background(), job, step)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}
	if _, err := os.Stat(filepath.Join(ws, "generated-apps", "factory-demo", "package.json")); err != nil {
		t.Fatalf("default-slug app not written: %v", err)
	}
}
