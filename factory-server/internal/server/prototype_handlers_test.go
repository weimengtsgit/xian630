package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func setupPrototypeFixture(t *testing.T) (*Server, *Router, string, model.Job, model.JobStep) {
	t.Helper()
	srv, router, root := newTestServerWithStore(t)
	ctx := testCtx()
	job := model.Job{ID: "job_proto", AppSlug: "proto-app", AppName: "Proto", Status: model.JobStatusRunning, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	step := model.JobStep{ID: "step_design", JobID: job.ID, Kind: model.StepDesignContract, Seq: 1, Status: model.StepStatusSucceeded, Attempt: 1}
	if err := srv.store.CreateJobStep(ctx, step); err != nil {
		t.Fatalf("CreateJobStep: %v", err)
	}
	protoDir := filepath.Join(srv.cfg.ArtifactRoot, "jobs", job.ID, "design_contract", "attempt-1", "prototype")
	if err := os.MkdirAll(protoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(protoDir, "index.html"), "<!doctype html><title>首页</title><p>原型</p>")
	writeFixture(t, filepath.Join(protoDir, "styles.css"), "body{margin:0}")
	writeFixture(t, filepath.Join(protoDir, "preview-manifest.json"), `{"mode":"static","defaultPage":"home","fidelity":"static","pages":[{"id":"home","title":"首页","file":"prototype/index.html","generated":true,"visibleByDefault":true}]}`)
	writeFixture(t, filepath.Join(protoDir, "prototype-contract.json"), `{"prototypeStatus":"unconfirmed","downstreamConstraintLevel":"reference","immutable":false,"prototype":{"style":"ued_review","targetAudience":"ued","targetPlatform":"responsive","fidelity":"static","defaultPage":"home","confirmationPolicy":"unconfirmed_reference","pages":[{"id":"home","title":"首页","generated":true,"visibleByDefault":true}]}}`)
	previewRel := "jobs/job_proto/design_contract/attempt-1/prototype/preview-manifest.json"
	ref := model.WorkbenchArtifactRef{
		ID: "warf_proto_1", JobID: job.ID, StepID: step.ID, CardKey: "interface_parsing",
		Kind: model.WorkbenchArtifactInterfacePreview, Label: "原型预览", Path: previewRel,
		PreviewURL:   "/api/jobs/job_proto/steps/step_design/prototype/preview",
		SnapshotHash: "sha256:abc", Status: "unconfirmed",
		CreatedAt: testNow(), UpdatedAt: testNow(),
	}
	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef: %v", err)
	}
	return srv, router, root, job, step
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestJobPrototypeSummaryReturnsLatestPrototypeRef(t *testing.T) {
	srv, router, _, _, step := setupPrototypeFixture(t)
	_ = srv
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/job_proto/steps/"+step.ID+"/prototype", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"artifactId", "warf_proto_1", "unconfirmed", "manifest", "contract"} {
		if !strings.Contains(body, want) {
			t.Fatalf("summary missing %q: %s", want, body)
		}
	}
}

func TestJobPrototypePreviewServesIndexWithNoStore(t *testing.T) {
	_, router, _, _, step := setupPrototypeFixture(t)
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/job_proto/steps/"+step.ID+"/prototype/preview", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("content-type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
	if !strings.Contains(rec.Body.String(), "原型") {
		t.Fatalf("preview body missing prototype content: %s", rec.Body.String())
	}
}

func TestJobPrototypePreviewRejectsTraversalPage(t *testing.T) {
	srv, router, _, job, step := setupPrototypeFixture(t)
	ctx := testCtx()
	evilRef := model.WorkbenchArtifactRef{
		ID: "warf_evil", JobID: job.ID, StepID: step.ID, CardKey: "interface_parsing",
		Kind: model.WorkbenchArtifactInterfacePreview, Label: "原型预览",
		Path: "../../../etc/passwd", Status: "unconfirmed",
		CreatedAt: testNow(), UpdatedAt: testNow().Add(time.Second),
	}
	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, evilRef); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/job_proto/steps/"+step.ID+"/prototype/preview", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for traversal ref", rec.Code)
	}
}

func TestConfirmPrototypeMarksArtifactConfirmed(t *testing.T) {
	srv, router, _, _, step := setupPrototypeFixture(t)
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/job_proto/steps/"+step.ID+"/prototype/confirm", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "confirmed") {
		t.Fatalf("confirm body missing confirmed status: %s", rec.Body.String())
	}
	// Verify via summary
	req2 := httptest.NewRequest(http.MethodGet, "/api/jobs/job_proto/steps/"+step.ID+"/prototype", nil)
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if !strings.Contains(rec2.Body.String(), "confirmed") {
		t.Fatalf("summary after confirm missing confirmed: %s", rec2.Body.String())
	}
	_ = srv
}

func TestConfirmPrototypeAdvancesJobToNextStep(t *testing.T) {
	srv, router, _, job, step := setupPrototypeFixture(t)
	ctx := testCtx()
	if err := srv.store.AdvanceJobStep(ctx, job.ID, model.StepDesignContract); err != nil {
		t.Fatalf("point job to design step: %v", err)
	}
	if err := srv.store.MarkJobWaitingUser(ctx, job.ID); err != nil {
		t.Fatalf("mark job waiting: %v", err)
	}
	if err := srv.store.MarkStepWaitingUser(ctx, step.ID, `[{"id":"prototype_confirmation"}]`); err != nil {
		t.Fatalf("mark step waiting: %v", err)
	}
	if err := srv.store.CreateJobStep(ctx, model.JobStep{ID: "step_solution", JobID: job.ID, Kind: model.StepSolutionDesign, Seq: 2, Status: model.StepStatusPending}); err != nil {
		t.Fatalf("create next step: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/jobs/job_proto/steps/"+step.ID+"/prototype/confirm", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body = %s", rec.Code, rec.Body.String())
	}
	updated, err := srv.store.GetJob(ctx, job.ID)
	if err != nil || updated == nil {
		t.Fatalf("get job after confirm: %v", err)
	}
	if updated.Status != model.JobStatusQueued || updated.CurrentStepKind != model.StepSolutionDesign {
		t.Fatalf("job after confirm = %s/%s, want queued/solution_design", updated.Status, updated.CurrentStepKind)
	}
	updatedStep, err := srv.store.GetStepByKind(ctx, job.ID, model.StepDesignContract)
	if err != nil || updatedStep == nil {
		t.Fatalf("get design step after confirm: %v", err)
	}
	if updatedStep.Status != model.StepStatusSucceeded {
		t.Fatalf("design step status = %s, want succeeded", updatedStep.Status)
	}
}

func TestAnswerJobPrototypeConfirmationAdvancesInsteadOfRerunningDesign(t *testing.T) {
	srv, router, _, job, step := setupPrototypeFixture(t)
	ctx := testCtx()
	if err := srv.store.AdvanceJobStep(ctx, job.ID, model.StepDesignContract); err != nil {
		t.Fatalf("point job to design step: %v", err)
	}
	if err := srv.store.MarkJobWaitingUser(ctx, job.ID); err != nil {
		t.Fatalf("mark job waiting: %v", err)
	}
	if err := srv.store.MarkStepWaitingUser(ctx, step.ID, `[{"id":"prototype_confirmation","options":[{"value":"confirm","label":"确定原型并继续"}]}]`); err != nil {
		t.Fatalf("mark step waiting: %v", err)
	}
	if err := srv.store.CreateJobStep(ctx, model.JobStep{ID: "step_solution", JobID: job.ID, Kind: model.StepSolutionDesign, Seq: 2, Status: model.StepStatusPending}); err != nil {
		t.Fatalf("create next step: %v", err)
	}

	rec := doJSON(t, router, http.MethodPost, "/api/jobs/"+job.ID+"/answer", map[string]any{
		"answer": "确定原型并继续", "stepId": step.ID, "attempt": step.Attempt,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer status = %d body = %s", rec.Code, rec.Body.String())
	}
	updated, err := srv.store.GetJob(ctx, job.ID)
	if err != nil || updated == nil {
		t.Fatalf("get job after answer: %v", err)
	}
	if updated.Status != model.JobStatusQueued || updated.CurrentStepKind != model.StepSolutionDesign {
		t.Fatalf("job after answer = %s/%s, want queued/solution_design", updated.Status, updated.CurrentStepKind)
	}
	updatedStep, err := srv.store.GetStepByKind(ctx, job.ID, model.StepDesignContract)
	if err != nil || updatedStep == nil {
		t.Fatalf("get design step after answer: %v", err)
	}
	if updatedStep.Status != model.StepStatusSucceeded || updatedStep.UserPrompt != "" {
		t.Fatalf("design step after answer = status %s user_prompt %q, want succeeded without rerun prompt", updatedStep.Status, updatedStep.UserPrompt)
	}
	refs, err := srv.store.ListWorkbenchArtifactRefsByJob(ctx, job.ID)
	if err != nil {
		t.Fatalf("ListWorkbenchArtifactRefsByJob: %v", err)
	}
	if len(refs) != 1 || refs[0].Status != "confirmed" {
		t.Fatalf("prototype ref after answer = %#v, want confirmed", refs)
	}
}

func TestContinuePrototypeMarksReference(t *testing.T) {
	_, router, _, _, step := setupPrototypeFixture(t)
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/job_proto/steps/"+step.ID+"/prototype/continue-without-confirmation", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("continue status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "continued_without_confirmation") {
		t.Fatalf("continue body missing status: %s", rec.Body.String())
	}
}
