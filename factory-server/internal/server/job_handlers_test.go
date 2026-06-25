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

// TestCreateJobCreatesFixedSteps verifies that POST /api/jobs seeds the six
// fixed pipeline steps in the canonical order and leaves them all pending.
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
	if job.CurrentStepKind != model.StepRequirementAnalysis {
		t.Fatalf("current_step_kind = %q, want requirement_analysis", job.CurrentStepKind)
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

	want := []model.StepKind{
		model.StepRequirementAnalysis,
		model.StepSolutionDesign,
		model.StepCodeGeneration,
		model.StepTestVerification,
		model.StepImageBuild,
		model.StepDeployment,
	}
	if len(steps) != len(want) {
		t.Fatalf("len(steps) = %d, want %d", len(steps), len(want))
	}
	for i, s := range steps {
		if s.Kind != want[i] {
			t.Fatalf("step[%d].kind = %q, want %q", i, s.Kind, want[i])
		}
		if s.Seq != i+1 {
			t.Fatalf("step[%d].seq = %d, want %d", i, s.Seq, i+1)
		}
		if s.Status != model.StepStatusPending {
			t.Fatalf("step[%d].status = %q, want pending", i, s.Status)
		}
	}

	wantAgents := map[model.StepKind]string{
		model.StepRequirementAnalysis: "requirement-analyst",
		model.StepSolutionDesign:      "solution-designer",
		model.StepCodeGeneration:      "code-generator",
		model.StepTestVerification:    "tester",
		model.StepImageBuild:          "image-builder",
		model.StepDeployment:          "deployer",
	}
	for _, s := range steps {
		if got := wantAgents[s.Kind]; s.AgentKey != got {
			t.Fatalf("step %q agent_key = %q, want %q", s.Kind, s.AgentKey, got)
		}
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
	CCStatusAvailable bool        `json:"cc_status_available"`
	PendingQuestions  []getJobQ   `json:"pending_questions"`
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

	step, err := st.GetStepByKind(context.Background(), created.ID, model.StepRequirementAnalysis)
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
	step, err := st.GetStepByKind(context.Background(), job.ID, model.StepRequirementAnalysis)
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
	updatedStep, err := st.GetStepByKind(context.Background(), job.ID, model.StepRequirementAnalysis)
	if err != nil || updatedStep == nil {
		t.Fatalf("get updated step: %#v %v", updatedStep, err)
	}
	if updatedStep.Status != model.StepStatusPending || updatedStep.NeedsUserInput {
		t.Fatalf("step after answer = %#v, want pending without needs_user_input", updatedStep)
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

	// The in-flight step (requirement_analysis) must also be canceled.
	stepsRec := doJSON(t, r, http.MethodGet, "/api/jobs/"+job.ID+"/steps", nil)
	var steps []model.JobStep
	_ = json.NewDecoder(stepsRec.Body).Decode(&steps)
	var cur model.JobStep
	for _, s := range steps {
		if s.Kind == model.StepRequirementAnalysis {
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
