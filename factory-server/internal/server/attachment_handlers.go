package server

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

const maxDialogueAttachmentBytes = 10 * 1024 * 1024

func (s *Server) uploadDialogueAttachment(w http.ResponseWriter, r *http.Request) {
	dialogueID := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), dialogueID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "dialogue not found")
		return
	}
	if err := r.ParseMultipartForm(maxDialogueAttachmentBytes); err != nil {
		writeError(w, http.StatusBadRequest, "attachment too large")
		return
	}
	f, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing file")
		return
	}
	defer f.Close()
	name := safeAttachmentName(header.Filename)
	if looksLikeCredentialFile(name) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "credentials must use controlled credential input"})
		return
	}
	previewKind, ext, mimeType, ok := classifyAttachment(name, header.Header.Get("Content-Type"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported attachment type"})
		return
	}
	id := "att_" + idpkg.New()
	rel := filepath.ToSlash(filepath.Join("dialogue-attachments", dialogueID, id, name))
	full := filepath.Join(s.cfg.ArtifactRoot, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "create attachment dir")
		return
	}
	out, err := os.Create(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create attachment")
		return
	}
	defer out.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(f, maxDialogueAttachmentBytes+1))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "write attachment")
		return
	}
	if n > maxDialogueAttachmentBytes {
		_ = os.Remove(full)
		writeError(w, http.StatusBadRequest, "attachment too large")
		return
	}
	now := time.Now()
	att := model.DialogueAttachment{
		ID: id, DialogueID: dialogueID, FocusKey: r.FormValue("focusKey"),
		OriginalName: name, StoredPath: rel, Mime: mimeType, Extension: ext,
		SizeBytes: n, SHA256: "sha256:" + hex.EncodeToString(h.Sum(nil)),
		PreviewKind: previewKind, Status: model.AttachmentStatusActive, CreatedAt: now,
	}
	if err := s.store.CreateDialogueAttachment(r.Context(), att); err != nil {
		writeError(w, http.StatusInternalServerError, "save attachment")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"attachment": att})
}

func safeAttachmentName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.ReplaceAll(name, string(os.PathSeparator), "_")
	if name == "." || name == "" {
		return "attachment"
	}
	return name
}

func looksLikeCredentialFile(name string) bool {
	lower := strings.ToLower(name)
	for _, suffix := range []string{".env", ".pem", ".key", ".p12", ".pfx"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	for _, needle := range []string{"token", "password", "passwd", "secret", "apikey", "api-key"} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

func classifyAttachment(name, contentType string) (model.AttachmentPreviewKind, string, string, bool) {
	ext := strings.ToLower(filepath.Ext(name))
	mimeType := contentType
	if mimeType == "" {
		mimeType = mime.TypeByExtension(ext)
	}
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif":
		return model.AttachmentPreviewImage, ext, mimeType, true
	case ".md", ".markdown":
		return model.AttachmentPreviewMarkdown, ext, "text/markdown", true
	case ".txt", ".log":
		return model.AttachmentPreviewText, ext, "text/plain", true
	case ".json":
		return model.AttachmentPreviewJSON, ext, "application/json", true
	case ".csv":
		return model.AttachmentPreviewCSV, ext, "text/csv", true
	case ".pdf":
		return model.AttachmentPreviewPDF, ext, "application/pdf", true
	case ".doc", ".docx", ".xls", ".xlsx":
		return model.AttachmentPreviewMetadata, ext, mimeType, true
	default:
		return model.AttachmentPreviewBlocked, ext, mimeType, false
	}
}
