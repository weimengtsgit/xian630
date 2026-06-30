package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestUploadDialogueAttachmentRejectsCredentials(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	_ = srv.store.CreateDialogueSession(testCtx(), model.DialogueSession{ID: "dlg_1", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	body, contentType := multipartBody(t, "file", "token.env", "API_KEY=secret\n", map[string]string{"focusKey": "data_capture"})
	req := httptest.NewRequest(http.MethodPost, "/api/dialogues/dlg_1/attachments", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "controlled credential input") {
		t.Fatalf("credential rejection message missing: %s", rec.Body.String())
	}
}

func TestUploadDialogueAttachmentStoresPreviewableFile(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	_ = srv.store.CreateDialogueSession(testCtx(), model.DialogueSession{ID: "dlg_2", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	body, contentType := multipartBody(t, "file", "requirements.md", "# 需求\n", map[string]string{"focusKey": "business_logic"})
	req := httptest.NewRequest(http.MethodPost, "/api/dialogues/dlg_2/attachments", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	refs, err := srv.store.ListDialogueAttachmentRefs(testCtx(), "dlg_2")
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs: %v", err)
	}
	if len(refs) != 0 {
		t.Fatalf("upload alone must not create message refs: %#v", refs)
	}
	files, _ := filepath.Glob(filepath.Join(srv.cfg.ArtifactRoot, "dialogue-attachments", "dlg_2", "*", "requirements.md"))
	if len(files) != 1 {
		t.Fatalf("stored file count = %d", len(files))
	}
}

// TestDialogueAttachmentContentServesTextBody verifies F3: after uploading a
// markdown file, GET /api/dialogues/:id/attachments/:attachmentId/content
// returns the stored bytes with a text content-type so the frontend's text
// fetch (getDialogueAttachmentContent) renders it in the preview modal.
func TestDialogueAttachmentContentServesTextBody(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	_ = srv.store.CreateDialogueSession(testCtx(), model.DialogueSession{ID: "dlg_md", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	const want = "# 需求\n这是一份可预览的需求说明。\n"
	body, contentType := multipartBody(t, "file", "requirements.md", want, map[string]string{"focusKey": "business_logic"})
	req := httptest.NewRequest(http.MethodPost, "/api/dialogues/dlg_md/attachments", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var uploadResp struct {
		Attachment model.DialogueAttachment `json:"attachment"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&uploadResp); err != nil {
		t.Fatalf("decode upload resp: %v", err)
	}
	attID := uploadResp.Attachment.ID

	getReq := httptest.NewRequest(http.MethodGet, "/api/dialogues/dlg_md/attachments/"+attID+"/content", nil)
	getRec := httptest.NewRecorder()
	router.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("content status = %d, want 200; body=%s", getRec.Code, getRec.Body.String())
	}
	if getRec.Body.String() != want {
		t.Fatalf("content body = %q, want %q", getRec.Body.String(), want)
	}
	if ct := getRec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/markdown") && !strings.HasPrefix(ct, "text/") {
		t.Fatalf("content-type = %q, want a text/* content-type", ct)
	}
}

// TestDialogueAttachmentContentRejectsPathTraversal verifies the F3 security
// boundary: a StoredPath that escapes ArtifactRoot (via ..) MUST be rejected
// (404) rather than serving a file outside the attachment root. The attachment
// row is seeded directly with a traversal path to exercise the containment
// check on the read path.
func TestDialogueAttachmentContentRejectsPathTraversal(t *testing.T) {
	srv, router, root := newTestServerWithStore(t)
	_ = srv.store.CreateDialogueSession(testCtx(), model.DialogueSession{ID: "dlg_tr", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	// Drop a secret file OUTSIDE the artifact root that the traversal would target.
	secretDir := filepath.Dir(root)
	secretPath := filepath.Join(secretDir, "secret.txt")
	if err := os.WriteFile(secretPath, []byte("TOPSECRET"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(secretPath) })
	// Resolve the traversal path relative to ArtifactRoot so it lands on secretPath.
	traversalRel, err := filepath.Rel(srv.cfg.ArtifactRoot, secretPath)
	if err != nil {
		t.Fatalf("rel: %v", err)
	}
	attID := "att_tr"
	if err := srv.store.CreateDialogueAttachment(testCtx(), model.DialogueAttachment{
		ID: attID, DialogueID: "dlg_tr", FocusKey: "business_logic",
		OriginalName: "evil.md", StoredPath: filepath.ToSlash(traversalRel),
		PreviewKind: model.AttachmentPreviewMarkdown, Status: model.AttachmentStatusActive, CreatedAt: testNow(),
	}); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/dialogues/dlg_tr/attachments/"+attID+"/content", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("content status = %d, want 404 (path traversal rejected); body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "TOPSECRET") {
		t.Fatalf("traversal served the out-of-root secret file: %s", rec.Body.String())
	}
}

// TestDialogueAttachmentContentRejectsMetadataOnlyKind verifies that an
// attachment kind with no inline preview body (metadata/office) yields 404
// rather than an error 500, matching the spec.
func TestDialogueAttachmentContentRejectsMetadataOnlyKind(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	_ = srv.store.CreateDialogueSession(testCtx(), model.DialogueSession{ID: "dlg_meta", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	attID := "att_meta"
	if err := srv.store.CreateDialogueAttachment(testCtx(), model.DialogueAttachment{
		ID: attID, DialogueID: "dlg_meta", FocusKey: "production_delivery",
		OriginalName: "report.docx", StoredPath: "dialogue-attachments/dlg_meta/att_meta/report.docx",
		PreviewKind: model.AttachmentPreviewMetadata, Status: model.AttachmentStatusActive, CreatedAt: testNow(),
	}); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dialogues/dlg_meta/attachments/"+attID+"/content", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("content status = %d, want 404 for metadata-only kind", rec.Code)
	}
}

func multipartBody(t *testing.T, field, filename, content string, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatalf("WriteField: %v", err)
		}
	}
	fw, err := w.CreateFormFile(field, filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write([]byte(content)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return &body, w.FormDataContentType()
}
