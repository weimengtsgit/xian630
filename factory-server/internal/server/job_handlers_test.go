package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
	"github.com/weimengtsgit/xian630/factory-server/internal/collaboration"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// fakeStreamDeployRunner is a deploy.CommandRunner that also satisfies the
// streaming-with-input contract. It records the invocation and invokes the
// stdout/stderr line callbacks so the adapter's forwarding behavior can be
// asserted without spawning a real process.
type fakeStreamDeployRunner struct {
	dir     string
	input   string
	name    string
	args    []string
	stdout  []string
	stderr  []string
	exitRes deploy.CommandResult
}

func (f *fakeStreamDeployRunner) Run(_ context.Context, _ string, _ string, _ ...string) (deploy.CommandResult, error) {
	return deploy.CommandResult{ExitCode: 0}, nil
}

func (f *fakeStreamDeployRunner) RunStreamWithInput(_ context.Context, dir, input string, onStdout, onStderr func(string), name string, args ...string) (deploy.CommandResult, error) {
	f.dir, f.input, f.name, f.args = dir, input, name, args
	for _, l := range f.stdout {
		if onStdout != nil {
			onStdout(l)
		}
	}
	for _, l := range f.stderr {
		if onStderr != nil {
			onStderr(l)
		}
	}
	return f.exitRes, nil
}

// TestClaudeCommandAdapterSatisfiesRunnerStreamContract is a compile-time
// guarantee that the production Claude adapter satisfies runner's (unexported)
// streaming interface, so ClaudeRunner.Run takes the LIVE streaming path in
// production rather than falling back to RunWithInput + post-hoc parse.
func TestClaudeCommandAdapterSatisfiesRunnerStreamContract(t *testing.T) {
	var _ runnerStreamCommandRunnerContract = claudeCommandAdapter{}
}

// runnerStreamCommandRunnerContract mirrors runner.streamCommandRunner's
// method set (which is unexported) so this package can assert the adapter
// satisfies it at compile time.
type runnerStreamCommandRunnerContract interface {
	RunStreamWithInput(ctx context.Context, dir, input string, onStdout func(string), onStderr func(string), name string, args ...string) (runner.CommandResult, error)
}

// TestClaudeCommandAdapterRunStreamWithInputForwardsCallbacks constructs the
// adapter over a streaming deploy runner and confirms RunStreamWithInput
// forwards BOTH stdout and stderr line callbacks live (so ClaudeRunner.runStream
// receives per-line stream-json events as they happen), applies defaultDir,
// passes input/name/args through, and converts the deploy result into a runner
// result. This closes the production-Claude live-streaming test gap.
func TestClaudeCommandAdapterRunStreamWithInputForwardsCallbacks(t *testing.T) {
	fake := &fakeStreamDeployRunner{
		stdout:  []string{"line-out-1", "line-out-2"},
		stderr:  []string{"line-err-1"},
		exitRes: deploy.CommandResult{Stdout: "captured-out", Stderr: "captured-err", ExitCode: 0, DurationMs: 42},
	}
	a := claudeCommandAdapter{runner: fake, defaultDir: "/tmp/default-workspace"}

	var gotOut, gotErr []string
	res, err := a.RunStreamWithInput(context.Background(), "", "PROMPT",
		func(s string) { gotOut = append(gotOut, s) },
		func(s string) { gotErr = append(gotErr, s) },
		"claude", "--print", "--output-format", "stream-json")
	if err != nil {
		t.Fatalf("RunStreamWithInput err = %v", err)
	}
	if gotOut == nil || len(gotOut) != 2 || gotOut[0] != "line-out-1" || gotOut[1] != "line-out-2" {
		t.Fatalf("stdout callbacks = %v, want [line-out-1 line-out-2]", gotOut)
	}
	if gotErr == nil || len(gotErr) != 1 || gotErr[0] != "line-err-1" {
		t.Fatalf("stderr callbacks = %v, want [line-err-1]", gotErr)
	}
	if fake.dir != "/tmp/default-workspace" {
		t.Fatalf("dir forwarded = %q, want default workspace (empty dir should resolve to defaultDir)", fake.dir)
	}
	if fake.input != "PROMPT" {
		t.Fatalf("input forwarded = %q, want PROMPT", fake.input)
	}
	if fake.name != "claude" || len(fake.args) != 3 || fake.args[0] != "--print" {
		t.Fatalf("name/args forwarded = %q / %v", fake.name, fake.args)
	}
	if res.Stdout != "captured-out" || res.Stderr != "captured-err" || res.ExitCode != 0 || res.DurationMs != 42 {
		t.Fatalf("result conversion = %+v, want the deploy result mapped to runner.CommandResult", res)
	}
}

// TestClaudeCommandAdapterRunStreamWithInputFallsBackWhenNotStreaming
// verifies the safety net: when the underlying runner does NOT satisfy the
// deploy streaming contract, the adapter does not panic — it returns a
// non-zero result so ClaudeRunner.Run's caller sees a clear failure rather
// than a crash (mirroring the existing RunWithInput/RunStream fallback).
func TestClaudeCommandAdapterRunStreamWithInputFallsBackWhenNotStreaming(t *testing.T) {
	a := claudeCommandAdapter{runner: nonStreamingDeployRunner{}, defaultDir: "/tmp"}
	res, err := a.RunStreamWithInput(context.Background(), "", "P", nil, nil, "claude")
	if err == nil {
		t.Fatalf("err = nil, want non-nil (non-streaming runner should not silently succeed)")
	}
	if res.ExitCode == 0 {
		t.Fatalf("ExitCode = 0, want non-zero on streaming fallback")
	}
}

// nonStreamingDeployRunner implements only deploy.CommandRunner.
type nonStreamingDeployRunner struct{}

func (nonStreamingDeployRunner) Run(context.Context, string, string, ...string) (deploy.CommandResult, error) {
	return deploy.CommandResult{ExitCode: 0}, nil
}

// newJobsTestServer builds a Server backed by an in-memory store with the
// given config (so the artifact-root security test can point at a temp dir).
// No apps or agents are seeded — job creation does not require them.
func newJobsTestServer(t *testing.T, cfg config.Config) (*Server, *Router, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv := New(cfg, st, scanner.Scanner{})
	return srv, srv.routes(), st
}

// testConfirmedRequirement is a minimal valid confirmed requirement JSON the
// direct POST /api/jobs gate requires. As of Task 5 the gate rejects a bare
// prompt; tests that exercise job/step lifecycle create a valid job via this
// helper instead of the bare-prompt path.
const testConfirmedRequirement = `{"appType":"situation_replay","appName":"demo","generationProfile":{"base":["software-factory-app"]}}`

// createJobViaAPI POSTs to /api/jobs with a prompt + confirmed requirement,
// returning the recorder. Used by job-lifecycle tests so they exercise the
// real (gated) creation path.
func createJobViaAPI(t *testing.T, r *Router, prompt string) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{
		"prompt":                     prompt,
		"clarification_session_id":   "clar_test",
		"confirmed_requirement_json": testConfirmedRequirement,
	})
}

func stepByKindForTest(t *testing.T, steps []model.JobStep, kind model.StepKind) model.JobStep {
	t.Helper()
	for _, step := range steps {
		if step.Kind == kind {
			return step
		}
	}
	t.Fatalf("missing step %s in %+v", kind, steps)
	return model.JobStep{}
}

func doJSON(t *testing.T, r *Router, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// TestCreateJobCreatesFixedSteps verifies that POST /api/jobs seeds the default
// collaboration plan's agent steps (the testConfirmedRequirement carries no
// public-web/security trigger, so exactly the 12 base agents) in plan order,
// each with the right agent key, all pending. The first step is the plan head
// (collaboration_orchestration) and the job points its current_step_kind at it.
func TestCreateJobCreatesFixedSteps(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})

	rec := createJobViaAPI(t, r, "生成航母编队月度航迹复盘")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201 (body=%s)", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	if job.Status != model.JobStatusQueued {
		t.Fatalf("status = %q, want queued", job.Status)
	}
	if job.CurrentStepKind != model.StepKind("collaboration_orchestration") {
		t.Fatalf("current_step_kind = %q, want collaboration_orchestration", job.CurrentStepKind)
	}
	if job.UserPrompt != "生成航母编队月度航迹复盘" {
		t.Fatalf("user_prompt = %q", job.UserPrompt)
	}

	stepsRec := doJSON(t, r, http.MethodGet, "/api/jobs/"+job.ID+"/steps", nil)
	if stepsRec.Code != http.StatusOK {
		t.Fatalf("steps status = %d, want 200", stepsRec.Code)
	}
	var steps []model.JobStep
	if err := json.NewDecoder(stepsRec.Body).Decode(&steps); err != nil {
		t.Fatalf("decode steps: %v", err)
	}

	// The default plan's agent roles in order (no security reviewer: the test
	// confirmed requirement has no public_web / auth / upload trigger).
	wantKinds := []model.StepKind{
		model.StepKind("collaboration_orchestration"),
		model.StepKind("requirement_analysis"),
		model.StepKind("domain_analysis"),
		model.StepKind("design_contract"),
		model.StepKind("data_integration"),
		model.StepKind("solution_design"),
		model.StepKind("code_generation"),
		model.StepKind("code_review"),
		model.StepKind("test_verification"),
		model.StepKind("product_acceptance"),
		model.StepKind("image_build"),
		model.StepKind("deployment"),
	}
	if len(steps) != len(wantKinds) {
		t.Fatalf("len(steps) = %d, want %d", len(steps), len(wantKinds))
	}
	wantAgents := map[model.StepKind]string{
		model.StepKind("collaboration_orchestration"): "collaboration-orchestrator",
		model.StepKind("requirement_analysis"):        "requirement-analyst",
		model.StepKind("domain_analysis"):             "domain-analyst",
		model.StepKind("design_contract"):             "designer",
		model.StepKind("data_integration"):            "data-integration",
		model.StepKind("solution_design"):             "solution-designer",
		model.StepKind("code_generation"):             "code-generator",
		model.StepKind("code_review"):                 "code-reviewer",
		model.StepKind("test_verification"):           "tester",
		model.StepKind("product_acceptance"):          "product-acceptance",
		model.StepKind("image_build"):                 "image-builder",
		model.StepKind("deployment"):                  "deployer",
	}
	for i, s := range steps {
		if s.Kind != wantKinds[i] {
			t.Fatalf("step[%d].kind = %q, want %q", i, s.Kind, wantKinds[i])
		}
		if s.Seq != i+1 {
			t.Fatalf("step[%d].seq = %d, want %d", i, s.Seq, i+1)
		}
		if s.Status != model.StepStatusPending {
			t.Fatalf("step[%d].status = %q, want pending", i, s.Status)
		}
		if got := wantAgents[s.Kind]; s.AgentKey != got {
			t.Fatalf("step %q agent_key = %q, want %q", s.Kind, s.AgentKey, got)
		}
	}
}

// TestCreateJobSeedsCollaborationPlanSteps verifies that POST /api/jobs now
// seeds the dynamic collaboration plan (12 agents, 13 with security reviewer)
// instead of the legacy fixed 6 steps: the job carries a CollaborationPlanJSON,
// its steps carry agent snapshots, and the plan's dependency edges persist.
func TestCreateJobSeedsCollaborationPlanSteps(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})

	rec := createJobViaAPI(t, r, "生成公网数据研判智能体")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	if job.CollaborationPlanJSON == "" {
		t.Fatalf("CollaborationPlanJSON empty")
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	if len(steps) < 12 {
		t.Fatalf("steps = %d, want collaboration plan steps", len(steps))
	}
	if steps[0].AgentKey != "collaboration-orchestrator" || steps[0].SnapshotJSON == "" {
		t.Fatalf("first step = %+v, want collaboration orchestrator with snapshot", steps[0])
	}
	edges, err := st.ListJobStepEdges(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobStepEdges: %v", err)
	}
	if len(edges) == 0 {
		t.Fatalf("expected dependency edges")
	}
}

func TestCreateJobSeedsSnapshotsWithSelectedSkillFileContents(t *testing.T) {
	workspace := t.TempDir()
	skillPath := filepath.Join(workspace, ".claude", "skills", "software-factory-app", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skillPath), 0o755); err != nil {
		t.Fatalf("mkdir skill: %v", err)
	}
	if err := os.WriteFile(skillPath, []byte("# software factory app\n本次任务可查看的技能内容"), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	_, r, st := newJobsTestServer(t, config.Config{WorkspaceRoot: workspace})

	rec := createJobViaAPI(t, r, "生成复盘智能体")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	codeStep := stepByKindForTest(t, steps, model.StepCodeGeneration)
	for _, want := range []string{"\"name\":\"代码生成\"", "\"description\":\"写入应用代码并生成 manifest。\"", ".claude/skills/software-factory-app/SKILL.md", "本次任务可查看的技能内容"} {
		if !strings.Contains(codeStep.SnapshotJSON, want) {
			t.Fatalf("code-generator snapshot missing %q:\n%s", want, codeStep.SnapshotJSON)
		}
	}
}

func TestCreateJobRedactsAndCapsSelectedSkillFileContents(t *testing.T) {
	workspace := t.TempDir()
	skillPath := filepath.Join(workspace, ".claude", "skills", "software-factory-app", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skillPath), 0o755); err != nil {
		t.Fatalf("mkdir skill: %v", err)
	}
	content := "# software factory app\n" +
		"ANTHROPIC_API_KEY=sk-live-secret\n" +
		"Authorization: Bearer bearer-secret\n" +
		"password: hunter2\n" +
		strings.Repeat("界", maxSkillSnapshotContentBytes)
	if err := os.WriteFile(skillPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	_, r, st := newJobsTestServer(t, config.Config{WorkspaceRoot: workspace})

	rec := createJobViaAPI(t, r, "生成复盘智能体")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	codeStep := stepByKindForTest(t, steps, model.StepCodeGeneration)
	for _, leak := range []string{"sk-live-secret", "bearer-secret", "hunter2"} {
		if strings.Contains(codeStep.SnapshotJSON, leak) {
			t.Fatalf("snapshot leaked secret %q:\n%s", leak, codeStep.SnapshotJSON)
		}
	}
	for _, want := range []string{"ANTHROPIC_API_KEY=[REDACTED]", "Authorization: [REDACTED]", "password: [REDACTED]", "[TRUNCATED: skill content exceeds snapshot cap]"} {
		if !strings.Contains(codeStep.SnapshotJSON, want) {
			t.Fatalf("snapshot missing %q:\n%s", want, codeStep.SnapshotJSON)
		}
	}
}

func TestHydrateSnapshotSkillContentsRejectsUnsafeSkillKeys(t *testing.T) {
	workspace := t.TempDir()
	validPath := filepath.Join(workspace, ".claude", "skills", "software-factory-app", "SKILL.md")
	driveLikePath := filepath.Join(workspace, ".claude", "skills", "C:escape", "SKILL.md")
	for _, path := range []string{validPath, driveLikePath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir skill %s: %v", path, err)
		}
	}
	if err := os.WriteFile(validPath, []byte("valid skill content"), 0o644); err != nil {
		t.Fatalf("write valid skill: %v", err)
	}
	if err := os.WriteFile(driveLikePath, []byte("drive-like skill key must not load"), 0o644); err != nil {
		t.Fatalf("write drive-like skill: %v", err)
	}

	got := hydrateSnapshotSkillContents(collaboration.Snapshot{
		SelectedSkills: []string{"software-factory-app", "C:escape", "../secret", "nested/key", `nested\key`},
	}, workspace)
	if len(got.SkillOverrides) != 1 {
		t.Fatalf("skill overrides = %+v, want only the safe single-segment skill", got.SkillOverrides)
	}
	if got.SkillOverrides[0].Path != ".claude/skills/software-factory-app/SKILL.md" {
		t.Fatalf("skill override path = %q", got.SkillOverrides[0].Path)
	}
	if strings.Contains(got.SkillOverrides[0].Content, "drive-like") {
		t.Fatalf("unsafe drive-like skill content loaded: %+v", got.SkillOverrides)
	}
}

func TestGetJobCollaborationPlan(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})
	rec := createJobViaAPI(t, r, "生成公网数据研判智能体")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}

	planRec := doJSON(t, r, http.MethodGet, "/api/jobs/"+job.ID+"/collaboration-plan", nil)
	if planRec.Code != http.StatusOK {
		t.Fatalf("plan status = %d, body=%s", planRec.Code, planRec.Body.String())
	}
	var body struct {
		Plan  map[string]any      `json:"plan"`
		Edges []model.JobStepEdge `json:"edges"`
		Steps []model.JobStep     `json:"steps"`
	}
	if err := json.NewDecoder(planRec.Body).Decode(&body); err != nil {
		t.Fatalf("decode plan response: %v", err)
	}
	if body.Plan["schemaVersion"] == nil || len(body.Steps) == 0 || len(body.Edges) == 0 {
		t.Fatalf("unexpected plan response: %+v", body)
	}
}

func TestGetJobCollaborationPlanMissingJob(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})
	rec := doJSON(t, r, http.MethodGet, "/api/jobs/missing/collaboration-plan", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestCreateJobMissingPrompt verifies the 400 path.
func TestCreateJobMissingPrompt(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})
	rec := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": ""})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// TestCreateJobRequiresConfirmedRequirement verifies the Task-5 gate: a POST
// /api/jobs with a prompt but NO confirmed_requirement_json is rejected with
// 400 confirmed_requirement_required. Jobs must be created from a confirmed
// clarification requirement. (The internal confirmClarification path bypasses
// this gate by calling store.CreateJob directly.)
func TestCreateJobRequiresConfirmedRequirement(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})

	// Bare prompt, no confirmed requirement → 400 confirmed_requirement_required.
	rec := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "生成航母编队复盘"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bare-prompt status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["error_code"] != "confirmed_requirement_required" {
		t.Fatalf("error_code = %v, want confirmed_requirement_required", resp["error_code"])
	}

	// Prompt + confirmed requirement → 201 (the helper exercises this happy path).
	ok := createJobViaAPI(t, r, "生成航母编队复盘")
	if ok.Code != http.StatusCreated {
		t.Fatalf("gated create status = %d, want 201 (body=%s)", ok.Code, ok.Body.String())
	}
	var job model.Job
	_ = json.NewDecoder(ok.Body).Decode(&job)
	if job.ConfirmedRequirementJSON == "" || job.ClarificationSessionID == "" {
		t.Fatalf("job missing confirmed requirement wiring: %+v", job)
	}
}

// TestGetJob verifies GET /api/jobs/:id and the 404 path.
func TestGetJob(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})

	rec := createJobViaAPI(t, r, "p")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d", rec.Code)
	}
	var job model.Job
	_ = json.NewDecoder(rec.Body).Decode(&job)

	got := doJSON(t, r, http.MethodGet, "/api/jobs/"+job.ID, nil)
	if got.Code != http.StatusOK {
		t.Fatalf("get status = %d", got.Code)
	}

	miss := doJSON(t, r, http.MethodGet, "/api/jobs/nope", nil)
	if miss.Code != http.StatusNotFound {
		t.Fatalf("miss status = %d, want 404", miss.Code)
	}
}

// getJobResponse is the enriched shape of GET /api/jobs/:id: the full job plus a
// cc-status availability flag.
type getJobResponse struct {
	model.Job
	CCStatusAvailable bool      `json:"cc_status_available"`
	PendingQuestions  []getJobQ `json:"pending_questions"`
}

// getJobQ is the minimal shape of a persisted clarifying question.
type getJobQ struct {
	ID       string `json:"id"`
	Question string `json:"question"`
}

// TestGetJobSurfacesWaitingQuestions verifies that when a job is waiting_user,
// GET /api/jobs/:id returns the persisted clarifying questions so the UI can
// show WHAT the user must answer (not just that input is needed).
func TestGetJobSurfacesWaitingQuestions(t *testing.T) {
	srv, r, st := newJobsTestServer(t, config.Config{})
	srv.cc = nil

	create := createJobViaAPI(t, r, "p")
	var created model.Job
	_ = json.NewDecoder(create.Body).Decode(&created)

	// Mark the job's CURRENT step (whatever the seeded plan head is) waiting so
	// the pending-questions surface path exercises the real current_step_kind.
	step, err := st.GetStepByKind(context.Background(), created.ID, created.CurrentStepKind)
	if err != nil || step == nil {
		t.Fatalf("get step: %v", err)
	}
	qs := `[{"id":"data-source","question":"用演示数据还是真实API？"}]`
	if err := st.MarkStepWaitingUser(context.Background(), step.ID, qs); err != nil {
		t.Fatalf("mark step waiting: %v", err)
	}
	if err := st.MarkJobWaitingUser(context.Background(), created.ID); err != nil {
		t.Fatalf("mark job waiting: %v", err)
	}

	rec := doJSON(t, r, http.MethodGet, "/api/jobs/"+created.ID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d", rec.Code)
	}
	var resp getJobResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.PendingQuestions) != 1 {
		t.Fatalf("pending_questions = %+v, want 1 entry", resp.PendingQuestions)
	}
	if resp.PendingQuestions[0].ID != "data-source" {
		t.Fatalf("question id = %q, want data-source", resp.PendingQuestions[0].ID)
	}
}

// TestGetJobCCStatusAvailable verifies that GET /api/jobs/:id reports
// cc_status_available=true when cc-status is reachable, and never fails the
// endpoint even when cc-status is down.
func TestGetJobCCStatusAvailable(t *testing.T) {
	srv, r, _ := newJobsTestServer(t, config.Config{})
	cc := newCCStatusServer(t, "")
	srv.cc = &ccstatus.Client{BaseURL: cc.URL}

	create := createJobViaAPI(t, r, "p")
	var created model.Job
	_ = json.NewDecoder(create.Body).Decode(&created)

	rec := doJSON(t, r, http.MethodGet, "/api/jobs/"+created.ID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200", rec.Code)
	}
	var resp getJobResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID != created.ID {
		t.Fatalf("id = %q, want %q", resp.ID, created.ID)
	}
	if !resp.CCStatusAvailable {
		t.Fatalf("cc_status_available = false, want true")
	}
}

// TestGetJobCCStatusDown verifies graceful degradation: cc-status down yields
// cc_status_available=false but the job is still returned with 200.
func TestGetJobCCStatusDown(t *testing.T) {
	srv, r, _ := newJobsTestServer(t, config.Config{})
	srv.cc = &ccstatus.Client{
		BaseURL: "http://127.0.0.1:1",
		HTTP:    &http.Client{Timeout: 200 * time.Millisecond},
	}

	create := createJobViaAPI(t, r, "p")
	var created model.Job
	_ = json.NewDecoder(create.Body).Decode(&created)

	rec := doJSON(t, r, http.MethodGet, "/api/jobs/"+created.ID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200 (must degrade, not fail)", rec.Code)
	}
	var resp getJobResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID != created.ID {
		t.Fatalf("id = %q, want %q", resp.ID, created.ID)
	}
	if resp.CCStatusAvailable {
		t.Fatalf("cc_status_available = true, want false")
	}
}

// TestGetJobCCStatusNil verifies a nil client still degrades (no panic).
func TestGetJobCCStatusNil(t *testing.T) {
	srv, r, _ := newJobsTestServer(t, config.Config{})
	srv.cc = nil

	create := createJobViaAPI(t, r, "p")
	var created model.Job
	_ = json.NewDecoder(create.Body).Decode(&created)

	rec := doJSON(t, r, http.MethodGet, "/api/jobs/"+created.ID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200", rec.Code)
	}
	var resp getJobResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.CCStatusAvailable {
		t.Fatalf("cc_status_available = true, want false when cc is nil")
	}
}

func TestAnswerJobResumesWaitingUserJob(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})

	create := createJobViaAPI(t, r, "p")
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d", create.Code)
	}
	var job model.Job
	if err := json.NewDecoder(create.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	step, err := st.GetStepByKind(context.Background(), job.ID, job.CurrentStepKind)
	if err != nil || step == nil {
		t.Fatalf("get step: %#v %v", step, err)
	}
	if err := st.MarkStepWaitingUser(context.Background(), step.ID, ""); err != nil {
		t.Fatalf("mark step waiting: %v", err)
	}
	if err := st.MarkJobWaitingUser(context.Background(), job.ID); err != nil {
		t.Fatalf("mark job waiting: %v", err)
	}

	rec := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/answer", map[string]string{"answer": "确认按近一个月"})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var updated model.Job
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated job: %v", err)
	}
	if updated.Status != model.JobStatusQueued {
		t.Fatalf("job status = %s, want queued", updated.Status)
	}
	updatedStep, err := st.GetStepByKind(context.Background(), job.ID, job.CurrentStepKind)
	if err != nil || updatedStep == nil {
		t.Fatalf("get updated step: %#v %v", updatedStep, err)
	}
	if updatedStep.Status != model.StepStatusPending || updatedStep.NeedsUserInput {
		t.Fatalf("step after answer = %#v, want pending without needs_user_input", updatedStep)
	}
	// The user's answer MUST be persisted on step.UserPrompt so the re-run can
	// read it (generative-step prompts append it as [user_input]). Without this
	// the step re-runs blind and re-asks the same clarification.
	if updatedStep.UserPrompt != "确认按近一个月" {
		t.Fatalf("step.UserPrompt after answer = %q, want the user's answer", updatedStep.UserPrompt)
	}
}

func TestAnswerJobRoutesToProvidedWaitingStep(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	create := createJobViaAPI(t, r, "p")
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d", create.Code)
	}
	var job model.Job
	if err := json.NewDecoder(create.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil || len(steps) < 2 {
		t.Fatalf("ListJobSteps len=%d err=%v", len(steps), err)
	}
	target := steps[1]
	if err := st.MarkStepWaitingUser(context.Background(), target.ID, `{"questions":[{"id":"q"}]}`); err != nil {
		t.Fatalf("mark target waiting: %v", err)
	}
	if err := st.MarkJobWaitingUser(context.Background(), job.ID); err != nil {
		t.Fatalf("mark job waiting: %v", err)
	}

	rec := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/answer", map[string]any{
		"answer": "选择 B", "stepId": target.ID, "attempt": target.Attempt,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	updatedJob, err := st.GetJob(context.Background(), job.ID)
	if err != nil || updatedJob == nil {
		t.Fatalf("GetJob updated: %#v %v", updatedJob, err)
	}
	if updatedJob.CurrentStepKind != target.Kind {
		t.Fatalf("CurrentStepKind = %s, want target kind %s", updatedJob.CurrentStepKind, target.Kind)
	}
	updatedSteps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps updated: %v", err)
	}
	for _, step := range updatedSteps {
		if step.ID == target.ID {
			if step.Status != model.StepStatusPending || step.NeedsUserInput {
				t.Fatalf("target step after answer = %#v, want pending without needs_user_input", step)
			}
			if step.UserPrompt != "选择 B" {
				t.Fatalf("target UserPrompt = %q", step.UserPrompt)
			}
		} else if step.UserPrompt == "选择 B" {
			t.Fatalf("answer leaked to unrelated step %#v", step)
		}
	}
}

// TestAnswerJobBindsTaskInternalAttachmentRefs verifies F1: when a task-internal
// clarification answer carries attachmentIds, the backend binds each id to the
// freshly-appended dialogue answer message via createDialogueAttachmentRefs, so
// the attachments the user pinned in a 业务逻辑/界面解析/数据抓取 phase are not
// dropped. The job must carry a DialogueID for the binding branch to run.
func TestAnswerJobBindsTaskInternalAttachmentRefs(t *testing.T) {
	srv, r, st := newJobsTestServer(t, config.Config{})

	dialogueID := "dlg_f1"
	if err := st.CreateDialogueSession(context.Background(), model.DialogueSession{
		ID: dialogueID, Status: model.DialogueStatusTaskRunning,
		Intent: model.DialogueIntentApplicationGeneration, CreatedAt: testNow(), UpdatedAt: testNow(),
	}); err != nil {
		t.Fatalf("seed dialogue: %v", err)
	}
	// An active dialogue attachment the user uploaded earlier.
	attID := "att_f1"
	if err := st.CreateDialogueAttachment(context.Background(), model.DialogueAttachment{
		ID: attID, DialogueID: dialogueID, FocusKey: "business_logic",
		OriginalName: "spec.md", StoredPath: "dialogue-attachments/" + dialogueID + "/" + attID + "/spec.md",
		PreviewKind: model.AttachmentPreviewMarkdown, Status: model.AttachmentStatusActive, CreatedAt: testNow(),
	}); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}

	// Seed a job WITH a DialogueID so the task-internal binding branch runs.
	now := time.Now()
	jobID := "job_f1"
	job := model.Job{
		ID: jobID, UserPrompt: "p", Status: model.JobStatusWaitingUser,
		CurrentStepKind:          model.StepRequirementAnalysis,
		ConfirmedRequirementJSON: testConfirmedRequirement,
		DialogueID:               dialogueID, CreatedAt: now, UpdatedAt: now,
	}
	stepID := "step_f1"
	steps := []model.JobStep{{
		ID: stepID, JobID: jobID, Kind: model.StepRequirementAnalysis, Seq: 1,
		Status: model.StepStatusWaitingUser, NeedsUserInput: true, Attempt: 0,
	}}
	if err := st.SeedJob(context.Background(), job, steps); err != nil {
		t.Fatalf("seed job: %v", err)
	}

	rec := doJSON(t, r, http.MethodPost, "/api/jobs/"+jobID+"/answer", map[string]any{
		"answer":        "选 A 方案",
		"stepId":        stepID,
		"attempt":       0,
		"attachmentIds": []string{attID},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	refs, err := st.ListDialogueAttachmentRefs(context.Background(), dialogueID)
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("expected 1 attachment ref bound to the answer, got %d: %#v", len(refs), refs)
	}
	if refs[0].AttachmentID != attID {
		t.Fatalf("ref attachment id = %q, want %q", refs[0].AttachmentID, attID)
	}
	if refs[0].MessageID == "" || !strings.HasPrefix(refs[0].MessageID, "msg_") {
		t.Fatalf("ref message id = %q, want the task-internal answer's dlgMsg id (msg_...)", refs[0].MessageID)
	}
	_ = srv
}

func TestAnswerJobReroutesCompatibilityFailureToDesignContract(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	ctx := context.Background()
	now := time.Now()
	dialogueID := "dlg_compat_route"
	if err := st.CreateDialogueSession(ctx, model.DialogueSession{
		ID: dialogueID, Status: model.DialogueStatusTaskRunning,
		Intent: model.DialogueIntentApplicationGeneration, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed dialogue: %v", err)
	}
	jobID := "job_compat_route"
	job := model.Job{
		ID: jobID, UserPrompt: "p", Status: model.JobStatusWaitingUser,
		CurrentStepKind:          model.StepDataIntegration,
		ConfirmedRequirementJSON: testConfirmedRequirement,
		DialogueID:               dialogueID, CreatedAt: now, UpdatedAt: now,
	}
	steps := []model.JobStep{
		{ID: "step_req", JobID: jobID, Kind: model.StepRequirementAnalysis, Seq: 1, Status: model.StepStatusSucceeded, Attempt: 1},
		{ID: "step_design", JobID: jobID, Kind: model.StepDesignContract, Seq: 2, Status: model.StepStatusSucceeded, Attempt: 1},
		{ID: "step_data", JobID: jobID, Kind: model.StepDataIntegration, Seq: 3, Status: model.StepStatusWaitingUser, NeedsUserInput: true, Attempt: 1},
	}
	if err := st.SeedJob(ctx, job, steps); err != nil {
		t.Fatalf("seed job: %v", err)
	}
	if err := st.UpsertWorkbenchArtifactRef(ctx, model.WorkbenchArtifactRef{
		ID: "warf_compat", DialogueID: dialogueID, JobID: jobID, StepID: "step_data",
		CardKey: "data_capture", Kind: model.WorkbenchArtifactDataContract,
		Label: "界面兼容待确认", Status: "compatible_failed",
		Metadata:  `{"sourceBoundary":"internet","verification":{"ontology":{"status":"failed"},"internet":{"status":"passed"},"demo":{"status":"pending"}},"fallbackHistory":["ontology_failed"]}`,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed artifact: %v", err)
	}

	rec := doJSON(t, r, http.MethodPost, "/api/jobs/"+jobID+"/answer", map[string]any{
		"answer":  "请调整界面，不再展示审批状态字段",
		"stepId":  "step_data",
		"attempt": 1,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	updatedJob, err := st.GetJob(ctx, jobID)
	if err != nil || updatedJob == nil {
		t.Fatalf("GetJob: %#v %v", updatedJob, err)
	}
	if updatedJob.CurrentStepKind != model.StepDesignContract {
		t.Fatalf("CurrentStepKind = %s, want design_contract", updatedJob.CurrentStepKind)
	}
	if updatedJob.Status != model.JobStatusQueued {
		t.Fatalf("job status = %s, want queued", updatedJob.Status)
	}
	updatedSteps, err := st.ListJobSteps(ctx, jobID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	var design, data model.JobStep
	for _, step := range updatedSteps {
		if step.ID == "step_design" {
			design = step
		}
		if step.ID == "step_data" {
			data = step
		}
	}
	if design.Status != model.StepStatusPending || design.UserPrompt != "请调整界面，不再展示审批状态字段" {
		t.Fatalf("design step = %#v, want pending with user prompt", design)
	}
	if data.Status != model.StepStatusPending || data.NeedsUserInput {
		t.Fatalf("data step = %#v, want compatibility wait closed to pending", data)
	}
	refs, err := st.ListWorkbenchArtifactRefsByJob(ctx, jobID)
	if err != nil {
		t.Fatalf("ListWorkbenchArtifactRefsByJob: %v", err)
	}
	if len(refs) != 1 || refs[0].Status == "compatible_failed" {
		t.Fatalf("compatibility artifact status should no longer force interface revalidation after answer, got %#v", refs)
	}
}

func TestAnswerJobRejectsStaleStepAttempt(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	create := createJobViaAPI(t, r, "p")
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d", create.Code)
	}
	var job model.Job
	if err := json.NewDecoder(create.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil || len(steps) == 0 {
		t.Fatalf("ListJobSteps len=%d err=%v", len(steps), err)
	}
	target := steps[0]
	if err := st.IncrementStepAttempt(context.Background(), target.ID); err != nil {
		t.Fatalf("increment attempt: %v", err)
	}
	if err := st.IncrementStepAttempt(context.Background(), target.ID); err != nil {
		t.Fatalf("increment attempt again: %v", err)
	}
	steps, _ = st.ListJobSteps(context.Background(), job.ID)
	target = steps[0]
	if err := st.MarkStepWaitingUser(context.Background(), target.ID, `{"questions":[{"id":"q"}]}`); err != nil {
		t.Fatalf("mark target waiting: %v", err)
	}
	if err := st.MarkJobWaitingUser(context.Background(), job.ID); err != nil {
		t.Fatalf("mark job waiting: %v", err)
	}

	rec := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/answer", map[string]any{
		"answer": "stale", "stepId": target.ID, "attempt": target.Attempt - 1,
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("answer status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	updated, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps updated: %v", err)
	}
	if updated[0].Status != model.StepStatusWaitingUser || updated[0].UserPrompt != "" {
		t.Fatalf("stale answer mutated step: %#v", updated[0])
	}
}

// TestListJobsStatusFilter verifies the optional status filter narrows results.
func TestListJobsStatusFilter(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})
	for i := 0; i < 2; i++ {
		rec := createJobViaAPI(t, r, "p")
		if rec.Code != http.StatusCreated {
			t.Fatalf("create status = %d", rec.Code)
		}
	}

	all := doJSON(t, r, http.MethodGet, "/api/jobs", nil)
	var jobs []model.Job
	_ = json.NewDecoder(all.Body).Decode(&jobs)
	if len(jobs) != 2 {
		t.Fatalf("len(all) = %d, want 2", len(jobs))
	}

	queued := doJSON(t, r, http.MethodGet, "/api/jobs?status=queued", nil)
	var q []model.Job
	_ = json.NewDecoder(queued.Body).Decode(&q)
	if len(q) != 2 {
		t.Fatalf("len(queued) = %d, want 2", len(q))
	}

	none := doJSON(t, r, http.MethodGet, "/api/jobs?status=completed", nil)
	var n []model.Job
	_ = json.NewDecoder(none.Body).Decode(&n)
	if len(n) != 0 {
		t.Fatalf("len(completed) = %d, want 0", len(n))
	}
}

// TestCancelJob verifies the job is marked canceled.
func TestCancelJob(t *testing.T) {
	srv, r, _ := newJobsTestServer(t, config.Config{})

	rec := createJobViaAPI(t, r, "p")
	var job model.Job
	_ = json.NewDecoder(rec.Body).Decode(&job)

	cancel := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/cancel", nil)
	if cancel.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, want 200", cancel.Code)
	}
	var updated model.Job
	_ = json.NewDecoder(cancel.Body).Decode(&updated)
	if updated.Status != model.JobStatusCanceled {
		t.Fatalf("status = %q, want canceled", updated.Status)
	}
	if updated.EndedAt == nil {
		t.Fatalf("ended_at not set")
	}

	// The in-flight step (the seeded plan head) must also be canceled.
	stepsRec := doJSON(t, r, http.MethodGet, "/api/jobs/"+job.ID+"/steps", nil)
	var steps []model.JobStep
	_ = json.NewDecoder(stepsRec.Body).Decode(&steps)
	var cur model.JobStep
	for _, s := range steps {
		if s.Kind == job.CurrentStepKind {
			cur = s
		}
	}
	if cur.Status != model.StepStatusCanceled {
		t.Fatalf("current step status = %q, want canceled", cur.Status)
	}

	// Cancel of a missing job is a 404.
	miss := doJSON(t, r, http.MethodPost, "/api/jobs/missing/cancel", nil)
	if miss.Code != http.StatusNotFound {
		t.Fatalf("miss status = %d, want 404", miss.Code)
	}

	_ = srv // keep server in scope
}

// TestAnswerJob verifies a user answer is recorded and the job is returned.
func TestAnswerJob(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	rec := createJobViaAPI(t, r, "p")
	var job model.Job
	_ = json.NewDecoder(rec.Body).Decode(&job)

	ans := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/answer", map[string]string{"answer": "use podman"})
	if ans.Code != http.StatusOK {
		t.Fatalf("answer status = %d, want 200", ans.Code)
	}

	// Missing job → 404.
	miss := doJSON(t, r, http.MethodPost, "/api/jobs/missing/answer", map[string]string{"answer": "x"})
	if miss.Code != http.StatusNotFound {
		t.Fatalf("miss status = %d, want 404", miss.Code)
	}

	// Sanity: at least the seed + the answer were persisted (no public list
	// method exists for conversations, so we just ensure no panic above and
	// re-query the job).
	_ = st
}

// TestRetryCurrentStep exercises the retry-current-step route end to end. A
// missing job is 404; a non-failed job (the freshly-created queued job) is 409;
// once the job is driven to failed, retry flips it back to queued.
func TestRetryCurrentStep(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})

	// Missing job → 404.
	miss := doJSON(t, r, http.MethodPost, "/api/jobs/missing/retry-current-step", nil)
	if miss.Code != http.StatusNotFound {
		t.Fatalf("miss status = %d, want 404", miss.Code)
	}

	// Create a job; it starts queued. Retrying a non-failed job → 409.
	job := createQueuedJob(t, st)
	queued := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/retry-current-step", nil)
	if queued.Code != http.StatusConflict {
		t.Fatalf("queued-retry status = %d, want 409", queued.Code)
	}

	// Drive the job to failed directly in the store, then retry → 200/queued.
	if err := st.MarkJobFailed(context.Background(), job.ID); err != nil {
		t.Fatalf("mark failed: %v", err)
	}
	ok := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/retry-current-step", nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200, body=%s", ok.Code, ok.Body.String())
	}
	var updated model.Job
	if err := json.Unmarshal(ok.Body.Bytes(), &updated); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if updated.Status != model.JobStatusQueued {
		t.Fatalf("retried job status = %s, want queued", updated.Status)
	}
}

func TestRepairFromFailure(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})

	miss := doJSON(t, r, http.MethodPost, "/api/jobs/missing/repair-from-failure", nil)
	if miss.Code != http.StatusNotFound {
		t.Fatalf("miss status = %d, want 404", miss.Code)
	}

	job := createQueuedJob(t, st)
	queued := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/repair-from-failure", nil)
	if queued.Code != http.StatusConflict {
		t.Fatalf("queued repair status = %d, want 409", queued.Code)
	}

	if err := st.AdvanceJobStep(context.Background(), job.ID, model.StepTestVerification); err != nil {
		t.Fatalf("advance job: %v", err)
	}
	testStep, err := st.GetStepByKind(context.Background(), job.ID, model.StepTestVerification)
	if err != nil || testStep == nil {
		t.Fatalf("get test step: %v", err)
	}
	if err := st.IncrementStepAttempt(context.Background(), testStep.ID); err != nil {
		t.Fatalf("increment attempt: %v", err)
	}
	if err := st.MarkStepFailed(context.Background(), testStep.ID, model.ErrorBuildFailed, "build command failed"); err != nil {
		t.Fatalf("mark step failed: %v", err)
	}
	if err := st.MarkJobFailed(context.Background(), job.ID); err != nil {
		t.Fatalf("mark job failed: %v", err)
	}

	ok := doJSON(t, r, http.MethodPost, "/api/jobs/"+job.ID+"/repair-from-failure", nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("repair status = %d, want 200, body=%s", ok.Code, ok.Body.String())
	}
	var updated model.Job
	if err := json.Unmarshal(ok.Body.Bytes(), &updated); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if updated.Status != model.JobStatusQueued {
		t.Fatalf("repaired job status = %s, want queued", updated.Status)
	}
	if updated.CurrentStepKind != model.StepCodeGeneration {
		t.Fatalf("current step = %s, want code_generation", updated.CurrentStepKind)
	}
	codeStep, err := st.GetStepByKind(context.Background(), job.ID, model.StepCodeGeneration)
	if err != nil || codeStep == nil {
		t.Fatalf("get code step: %v", err)
	}
	if !strings.Contains(codeStep.UserPrompt, "build command failed") {
		t.Fatalf("code repair prompt missing failure context: %q", codeStep.UserPrompt)
	}
}

// createQueuedJob inserts a queued job + six pending steps and returns the job.
func createQueuedJob(t *testing.T, st *store.Store) model.Job {
	t.Helper()
	now := time.Now()
	job := model.Job{
		ID:              "job_test_" + now.Format("150405.000000"),
		UserPrompt:      "test",
		Status:          model.JobStatusQueued,
		CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	for i, sp := range stepPlan {
		step := model.JobStep{
			ID:       "step_test_" + string(sp.kind) + "_" + now.Format("150405.000000"),
			JobID:    job.ID,
			Kind:     sp.kind,
			Seq:      i + 1,
			AgentKey: sp.agentKey,
			Status:   model.StepStatusPending,
			Attempt:  0,
		}
		if err := st.CreateJobStep(context.Background(), step); err != nil {
			t.Fatalf("create step %s: %v", sp.kind, err)
		}
	}
	return job
}

// TestArtifactContentSecurity verifies that files inside the artifact root are
// served as text/plain and files outside (or traversal) are rejected with 403.
func TestArtifactContentSecurity(t *testing.T) {
	root := t.TempDir()
	_, r, st := newJobsTestServer(t, config.Config{ArtifactRoot: filepath.Join(root, ".factory-runs")})
	artRoot := filepath.Join(root, ".factory-runs")
	if err := os.MkdirAll(artRoot, 0o755); err != nil {
		t.Fatalf("mkdir art root: %v", err)
	}

	// Inside root: a real file under .factory-runs/jobs/j1.
	insideDir := filepath.Join(artRoot, "jobs", "j1")
	if err := os.MkdirAll(insideDir, 0o755); err != nil {
		t.Fatalf("mkdir inside: %v", err)
	}
	insidePath := filepath.Join(insideDir, "design.md")
	if err := os.WriteFile(insidePath, []byte("# design\n航母编队"), 0o644); err != nil {
		t.Fatalf("write inside: %v", err)
	}
	insideArt := model.Artifact{
		ID:        "art_inside",
		JobID:     "j1",
		StepID:    "s1",
		Kind:      "design",
		Path:      insidePath,
		Summary:   "design doc",
		CreatedAt: time.Now(),
	}
	if err := st.CreateArtifact(context.Background(), insideArt); err != nil {
		t.Fatalf("create artifact: %v", err)
	}
	okRec := doJSON(t, r, http.MethodGet, "/api/artifacts/art_inside/content", nil)
	if okRec.Code != http.StatusOK {
		t.Fatalf("inside status = %d, want 200", okRec.Code)
	}
	if ct := okRec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("content-type = %q, want text/plain", ct)
	}
	if !strings.Contains(okRec.Body.String(), "航母编队") {
		t.Fatalf("body = %q", okRec.Body.String())
	}

	// Outside root: a temp file NOT under the artifact root.
	outsidePath := filepath.Join(root, "secret.txt")
	if err := os.WriteFile(outsidePath, []byte("top secret"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	outsideArt := model.Artifact{
		ID:        "art_outside",
		JobID:     "j1",
		StepID:    "s2",
		Kind:      "secret",
		Path:      outsidePath,
		CreatedAt: time.Now(),
	}
	if err := st.CreateArtifact(context.Background(), outsideArt); err != nil {
		t.Fatalf("create artifact: %v", err)
	}
	denied := doJSON(t, r, http.MethodGet, "/api/artifacts/art_outside/content", nil)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("outside status = %d, want 403", denied.Code)
	}

	// Traversal: a relative Path with ".." that escapes root.
	travArt := model.Artifact{
		ID:        "art_trav",
		JobID:     "j1",
		StepID:    "s3",
		Kind:      "evil",
		Path:      filepath.Join("..", "..", "secret.txt"),
		CreatedAt: time.Now(),
	}
	if err := st.CreateArtifact(context.Background(), travArt); err != nil {
		t.Fatalf("create artifact: %v", err)
	}
	trav := doJSON(t, r, http.MethodGet, "/api/artifacts/art_trav/content", nil)
	if trav.Code != http.StatusForbidden {
		t.Fatalf("traversal status = %d, want 403", trav.Code)
	}

	// Missing artifact id → 404.
	miss := doJSON(t, r, http.MethodGet, "/api/artifacts/missing/content", nil)
	if miss.Code != http.StatusNotFound {
		t.Fatalf("miss status = %d, want 404", miss.Code)
	}

	// Inside-root row but file deleted from disk → 404.
	gonePath := filepath.Join(artRoot, "gone.txt")
	_ = os.WriteFile(gonePath, []byte("x"), 0o644)
	goneArt := model.Artifact{
		ID: "art_gone", JobID: "j1", StepID: "s4", Kind: "g", Path: gonePath, CreatedAt: time.Now(),
	}
	_ = st.CreateArtifact(context.Background(), goneArt)
	_ = os.Remove(gonePath)
	gone := doJSON(t, r, http.MethodGet, "/api/artifacts/art_gone/content", nil)
	if gone.Code != http.StatusNotFound {
		t.Fatalf("gone status = %d, want 404", gone.Code)
	}
}

// appendRecord is the server-package test helper that inserts a
// StepExecutionRecord with the fields the brief's tests care about filled in. It
// mirrors the store-package appendRecord (which is in package store and not
// directly reusable here) and calls the real Store.AppendStepExecutionRecord.
func appendRecord(t *testing.T, st *store.Store, jobID, stepID string, attempt, sequence int, kind model.ExecutionRecordKind, content string) {
	t.Helper()
	rec := model.StepExecutionRecord{
		ID:        fmt.Sprintf("%s:%s:%d:%d", jobID, stepID, attempt, sequence),
		JobID:     jobID,
		StepID:    stepID,
		Attempt:   attempt,
		Sequence:  sequence,
		Kind:      kind,
		Content:   content,
		CreatedAt: time.Now(),
	}
	if err := st.AppendStepExecutionRecord(context.Background(), rec); err != nil {
		t.Fatalf("append record %s:%s attempt=%d seq=%d: %v", jobID, stepID, attempt, sequence, err)
	}
}

// seedJobAndStep inserts a job + one step and returns their ids, so the
// execution-record/summary tests have a real job_steps row to validate ownership
// against (the handlers 404 when the step doesn't belong to the job).
func seedJobAndStep(t *testing.T, st *store.Store, jobID, stepID string) {
	t.Helper()
	now := time.Now()
	if err := st.CreateJob(context.Background(), model.Job{
		ID: jobID, UserPrompt: "p", Status: model.JobStatusQueued,
		CurrentStepKind: model.StepRequirementAnalysis, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := st.CreateJobStep(context.Background(), model.JobStep{
		ID: stepID, JobID: jobID, Kind: model.StepRequirementAnalysis, Seq: 1,
		AgentKey: "requirement-analyst", Status: model.StepStatusPending,
	}); err != nil {
		t.Fatalf("create step: %v", err)
	}
}

// TestStepExecutionSummary verifies GET /api/jobs/:id/execution-summary returns
// one summary per step with the latest attempt + latest record. A missing job
// yields 404.
func TestStepExecutionSummary(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	seedJobAndStep(t, st, "job_a", "step_a")
	appendRecord(t, st, "job_a", "step_a", 1, 1, model.ExecutionRecordSystem, "started")
	appendRecord(t, st, "job_a", "step_a", 2, 1, model.ExecutionRecordSystem, "retried")

	rec := doJSON(t, r, http.MethodGet, "/api/jobs/job_a/execution-summary", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got []model.StepExecutionSummary
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].StepID != "step_a" || got[0].LatestAttempt != 2 {
		t.Fatalf("got=%#v", got)
	}
	if got[0].LatestRecord == nil || got[0].LatestRecord.Content != "retried" {
		t.Fatalf("latest_record = %#v", got[0].LatestRecord)
	}

	// Missing job → 404.
	miss := doJSON(t, r, http.MethodGet, "/api/jobs/nope/execution-summary", nil)
	if miss.Code != http.StatusNotFound {
		t.Fatalf("miss status=%d want 404", miss.Code)
	}
}

// TestStepExecutionRecordPageReturnsOnlyRequestedStepAttempt verifies the page
// endpoint scopes by (job, step, attempt) — the brief's exact assertion.
func TestStepExecutionRecordPageReturnsOnlyRequestedStepAttempt(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	seedJobAndStep(t, st, "job_a", "step_a")
	appendRecord(t, st, "job_a", "step_a", 1, 1, model.ExecutionRecordSystem, "started")
	appendRecord(t, st, "job_a", "step_a", 2, 1, model.ExecutionRecordSystem, "retried")
	rec := doJSON(t, r, http.MethodGet, "/api/jobs/job_a/steps/step_a/execution-records?attempt=1&limit=200", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got []model.StepExecutionRecord
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if len(got) != 1 || got[0].Attempt != 1 {
		t.Fatalf("got=%#v", got)
	}
}

// TestStepExecutionRecordPageMissingJobAndStep verifies the 404 paths: a missing
// job, and a step that doesn't belong to the requested job.
func TestStepExecutionRecordPageMissingJobAndStep(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	seedJobAndStep(t, st, "job_a", "step_a")

	// Missing job → 404.
	miss := doJSON(t, r, http.MethodGet, "/api/jobs/nope/steps/step_a/execution-records?attempt=1", nil)
	if miss.Code != http.StatusNotFound {
		t.Fatalf("missing job status=%d want 404", miss.Code)
	}
	// Step that doesn't belong to the job → 404.
	badStep := doJSON(t, r, http.MethodGet, "/api/jobs/job_a/steps/step_other/execution-records?attempt=1", nil)
	if badStep.Code != http.StatusNotFound {
		t.Fatalf("unknown step status=%d want 404", badStep.Code)
	}
}

// TestStepExecutionRecordPageDefaultsAttempt verifies that omitting attempt
// defaults to the latest attempt for the step.
func TestStepExecutionRecordPageDefaultsAttempt(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	seedJobAndStep(t, st, "job_a", "step_a")
	appendRecord(t, st, "job_a", "step_a", 1, 1, model.ExecutionRecordSystem, "first")
	appendRecord(t, st, "job_a", "step_a", 2, 1, model.ExecutionRecordSystem, "second")

	// No attempt param → latest (attempt=2).
	rec := doJSON(t, r, http.MethodGet, "/api/jobs/job_a/steps/step_a/execution-records", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got []model.StepExecutionRecord
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if len(got) != 1 || got[0].Attempt != 2 || got[0].Content != "second" {
		t.Fatalf("default-attempt got=%#v", got)
	}
}

// TestStepRecordEventPublishedOnRecordCallback subscribes to the hub, invokes
// the server's OnRecord wiring with a stored record, and asserts an SSE event of
// type "step.record.appended" is emitted whose Data is the record itself.
func TestStepRecordEventPublishedOnRecordCallback(t *testing.T) {
	srv, _, _ := newJobsTestServer(t, config.Config{})
	if srv.exec.OnRecord == nil {
		t.Fatal("executor.OnRecord not wired (expected step.record.appended publisher)")
	}

	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	rec := model.StepExecutionRecord{
		ID: "rec_evt_1", JobID: "job_e", StepID: "step_e",
		Attempt: 1, Sequence: 7, Kind: model.ExecutionRecordActivity, Content: "tool call",
	}
	srv.exec.OnRecord(context.Background(), runner.ExecutionRecordUpdate{Record: rec})

	select {
	case ev := <-ch:
		if ev.Type != "step.record.appended" {
			t.Fatalf("event type = %q, want step.record.appended", ev.Type)
		}
		got, ok := ev.Data.(model.StepExecutionRecord)
		if !ok {
			t.Fatalf("event data = %#v, want model.StepExecutionRecord", ev.Data)
		}
		if got.ID != rec.ID || got.Sequence != rec.Sequence || got.Content != rec.Content {
			t.Fatalf("event record = %#v, want %#v", got, rec)
		}
	case <-time.After(time.Second):
		t.Fatal("no event received within 1s")
	}
}

// TestPatchJobStepSnapshotUpdatesOnlyTaskSnapshot verifies PATCH
// /api/jobs/:id/steps/:stepID/snapshot persists an edited snapshot to
// job_steps.snapshot_json (the per-task copy) without touching anything else.
func TestPatchJobStepSnapshotUpdatesOnlyTaskSnapshot(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	rec := createJobViaAPI(t, r, "生成复盘智能体")
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil || len(steps) == 0 {
		t.Fatalf("steps err=%v len=%d", err, len(steps))
	}
	body := map[string]any{
		"snapshot": map[string]any{
			"agentKey":       steps[0].AgentKey,
			"name":           "协作编排（本次调整）",
			"description":    "只影响本次任务",
			"lane":           "analysis",
			"instructions":   "本次任务使用调整后的说明",
			"selectedSkills": []string{},
			"skillOverrides": []map[string]string{},
		},
	}
	patch := doJSON(t, r, http.MethodPatch, "/api/jobs/"+job.ID+"/steps/"+steps[0].ID+"/snapshot", body)
	if patch.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body=%s", patch.Code, patch.Body.String())
	}
	updated, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	if !strings.Contains(updated[0].SnapshotJSON, "本次调整") {
		t.Fatalf("snapshot not updated: %s", updated[0].SnapshotJSON)
	}
}

// TestPatchJobStepSnapshotRejectsStartedStep verifies the server-side status
// gate: a snapshot is editable ONLY while its step is still pending. Once the
// step has started (running/succeeded/failed/waiting_user/canceled/skipped or
// any historical attempt), the snapshot is read-only and a PATCH must return
// 409 Conflict. This protects against a stale UI writing into an already-
// started or terminal step (data-integrity invariant from the plan).
func TestPatchJobStepSnapshotRejectsStartedStep(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	rec := createJobViaAPI(t, r, "生成复盘智能体")
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil || len(steps) == 0 {
		t.Fatalf("steps err=%v len=%d", err, len(steps))
	}
	// Flip the first step out of pending so it is read-only. MarkStepRunning is
	// the canonical transition into "started"; any non-pending status must be
	// rejected identically.
	if err := st.MarkStepRunning(context.Background(), steps[0].ID); err != nil {
		t.Fatalf("MarkStepRunning: %v", err)
	}
	body := map[string]any{
		"snapshot": map[string]any{
			"agentKey":       steps[0].AgentKey,
			"name":           "本次调整",
			"description":    "只影响本次任务",
			"selectedSkills": []string{},
		},
	}
	patch := doJSON(t, r, http.MethodPatch, "/api/jobs/"+job.ID+"/steps/"+steps[0].ID+"/snapshot", body)
	if patch.Code != http.StatusConflict {
		t.Fatalf("patch status = %d, want 409 (body=%s)", patch.Code, patch.Body.String())
	}
	// Confirm the write was NOT persisted.
	updated, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	if strings.Contains(updated[0].SnapshotJSON, "本次调整") {
		t.Fatalf("snapshot unexpectedly written for started step: %s", updated[0].SnapshotJSON)
	}
}
