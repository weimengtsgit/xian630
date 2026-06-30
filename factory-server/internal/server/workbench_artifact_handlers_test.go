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
