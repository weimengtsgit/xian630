package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestJobInterfacePreviewServesRetainedManifest(t *testing.T) {
	srv, router, root := newTestServerWithStore(t)
	ctx := testCtx()
	_ = root
	job := model.Job{ID: "job_iface", AppSlug: "leave-approval-a1", AppName: "请假审批-A1", Status: model.JobStatusRunning, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	// Manifest written by createInterfacePreviewSnapshot at its canonical path.
	previewRel := filepath.ToSlash(filepath.Join("jobs", job.ID, "design_contract", "attempt-1", "interface-preview", "manifest.json"))
	full := filepath.Join(srv.cfg.ArtifactRoot, filepath.FromSlash(previewRel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir preview: %v", err)
	}
	manifest := []byte(`{"kind":"static_manifest","summary":"请假申请单页表单","designDocument":{"views":["申请表单","审批列表"]},"assumedDataFields":["applicant","startDate","endDate","reason"]}`)
	if err := os.WriteFile(full, manifest, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	ref := model.WorkbenchArtifactRef{
		ID: "warf_iface_1", JobID: job.ID, StepID: "step_1", CardKey: "interface_parsing",
		Kind: model.WorkbenchArtifactInterfacePreview, Label: "界面预览", Path: previewRel,
		SnapshotHash: "sha256:deadbeef", Status: "provisional", CreatedAt: testNow(), UpdatedAt: testNow(),
	}
	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID+"/interface-preview?artifactId=warf_iface_1", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	body := rec.Body.String()
	for _, want := range []string{"请假申请单页表单", "申请表单", "applicant", "sha256:deadbeef"} {
		if !strings.Contains(body, want) {
			t.Fatalf("manifest field missing %q in body: %s", want, body)
		}
	}

	// Unknown artifactId falls back to 404 (no match), NOT a raw manifest dump.
	req2 := httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID+"/interface-preview?artifactId=warf_unknown", nil)
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("unknown artifactId status = %d, want 404", rec2.Code)
	}
}

func TestJobInterfacePreviewRejectsTraversalAndMissingFile(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	ctx := testCtx()
	job := model.Job{ID: "job_iface2", AppSlug: "leave-approval-a1", AppName: "请假审批-A1", Status: model.JobStatusRunning, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	// Ref whose Path escapes the artifact root. The handler must reject this and 404
	// rather than serve an arbitrary file (defence-in-depth even though the writer
	// never produces such a path).
	ref := model.WorkbenchArtifactRef{
		ID: "warf_traverse", JobID: job.ID, CardKey: "interface_parsing",
		Kind: model.WorkbenchArtifactInterfacePreview, Label: "界面预览",
		Path: "../../../etc/passwd", SnapshotHash: "sha256:x", Status: "provisional",
		CreatedAt: testNow(), UpdatedAt: testNow(),
	}
	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID+"/interface-preview?artifactId=warf_traverse", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("traversal status = %d, want 404", rec.Code)
	}

	// Contained path but the manifest file is absent on disk -> 404.
	ref2 := model.WorkbenchArtifactRef{
		ID: "warf_missing", JobID: job.ID, CardKey: "interface_parsing",
		Kind: model.WorkbenchArtifactInterfacePreview, Label: "界面预览",
		Path:         "jobs/" + job.ID + "/design_contract/attempt-1/interface-preview/manifest.json",
		SnapshotHash: "sha256:y", Status: "provisional", CreatedAt: testNow(), UpdatedAt: testNow(),
	}
	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, ref2); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef (missing): %v", err)
	}
	req2 := httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID+"/interface-preview?artifactId=warf_missing", nil)
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("missing file status = %d, want 404", rec2.Code)
	}
}

func TestJobProjectDocumentPreviewReadsEarlyGeneratedDoc(t *testing.T) {
	srv, router, root := newTestServerWithStore(t)
	ctx := testCtx()
	appDir := filepath.Join(root, "generated-apps", "leave-approval-a1")
	if err := os.MkdirAll(filepath.Join(appDir, "docs"), 0o755); err != nil {
		t.Fatalf("mkdir docs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "docs", "01-requirements.md"), []byte("# 需求文档\n\n已确认需求。\n"), 0o644); err != nil {
		t.Fatalf("write doc: %v", err)
	}
	job := model.Job{ID: "job_doc", AppSlug: "leave-approval-a1", AppName: "请假审批-A1", Status: model.JobStatusRunning, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/job_doc/project-docs/file?path=docs/01-requirements.md", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "已确认需求") {
		t.Fatalf("document content missing: %s", rec.Body.String())
	}
}

func TestJobWorkbenchArtifactContentServesDataAccessPlan(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	ctx := testCtx()
	job := model.Job{ID: "job_data_plan", Status: model.JobStatusRunning, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	planRel := filepath.ToSlash(filepath.Join("jobs", job.ID, "data-access", "versions", "v1", "data-access.redacted.md"))
	full := filepath.Join(srv.cfg.ArtifactRoot, filepath.FromSlash(planRel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir plan: %v", err)
	}
	if err := os.WriteFile(full, []byte("# 数据获取方案\n\n参考需求文档和原型预览。\n"), 0o644); err != nil {
		t.Fatalf("write plan: %v", err)
	}
	ref := model.WorkbenchArtifactRef{
		ID: "warf_data_plan", JobID: job.ID, StepID: "step_data", CardKey: "data_capture",
		Kind: model.WorkbenchArtifactDataAccessPlan, Label: "数据方案", Path: planRel,
		Status: "pending_confirmation", CreatedAt: testNow(), UpdatedAt: testNow(),
	}
	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID+"/workbench-artifacts/warf_data_plan/content", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", rec.Header().Get("Content-Type"))
	}
	for _, want := range []string{"数据获取方案", "参考需求文档和原型预览", planRel} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("response missing %q: %s", want, rec.Body.String())
		}
	}
}

func TestJobWorkbenchArtifactContentRejectsWrongKindAndTraversal(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	ctx := testCtx()
	job := model.Job{ID: "job_data_plan_bad", Status: model.JobStatusRunning, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, model.WorkbenchArtifactRef{
		ID: "warf_proto", JobID: job.ID, CardKey: "interface_parsing",
		Kind: model.WorkbenchArtifactInterfacePreview, Label: "原型预览",
		Path:   "jobs/" + job.ID + "/design_contract/attempt-1/prototype/preview-manifest.json",
		Status: "active", CreatedAt: testNow(), UpdatedAt: testNow(),
	}); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef proto: %v", err)
	}
	recWrongKind := httptest.NewRecorder()
	router.ServeHTTP(recWrongKind, httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID+"/workbench-artifacts/warf_proto/content", nil))
	if recWrongKind.Code != http.StatusNotFound {
		t.Fatalf("wrong kind status = %d, want 404", recWrongKind.Code)
	}

	if err := srv.store.UpsertWorkbenchArtifactRef(ctx, model.WorkbenchArtifactRef{
		ID: "warf_traversal", JobID: job.ID, CardKey: "data_capture",
		Kind: model.WorkbenchArtifactDataAccessPlan, Label: "数据方案",
		Path: "../../../secret.md", Status: "active", CreatedAt: testNow(), UpdatedAt: testNow(),
	}); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef traversal: %v", err)
	}
	recTraversal := httptest.NewRecorder()
	router.ServeHTTP(recTraversal, httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.ID+"/workbench-artifacts/warf_traversal/content", nil))
	if recTraversal.Code != http.StatusNotFound {
		t.Fatalf("traversal status = %d, want 404", recTraversal.Code)
	}
}
