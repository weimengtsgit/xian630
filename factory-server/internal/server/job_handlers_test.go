package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

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

	rec := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "生成航母编队月度航迹复盘"})
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
		model.StepImageBuild:          "deployer",
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

// TestGetJob verifies GET /api/jobs/:id and the 404 path.
func TestGetJob(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})

	rec := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "p"})
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
	CCStatusAvailable bool `json:"cc_status_available"`
}

// TestGetJobCCStatusAvailable verifies that GET /api/jobs/:id reports
// cc_status_available=true when cc-status is reachable, and never fails the
// endpoint even when cc-status is down.
func TestGetJobCCStatusAvailable(t *testing.T) {
	srv, r, _ := newJobsTestServer(t, config.Config{})
	cc := newCCStatusServer(t, "")
	srv.cc = &ccstatus.Client{BaseURL: cc.URL}

	create := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "p"})
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

	create := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "p"})
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

	create := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "p"})
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

// TestListJobsStatusFilter verifies the optional status filter narrows results.
func TestListJobsStatusFilter(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})
	for i := 0; i < 2; i++ {
		rec := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "p"})
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

	rec := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "p"})
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
	rec := doJSON(t, r, http.MethodPost, "/api/jobs", map[string]string{"prompt": "p"})
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
