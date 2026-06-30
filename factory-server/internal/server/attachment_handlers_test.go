package server

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
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
