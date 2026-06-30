package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

// errAttachmentCredential signals the uploaded file looks like a credential
// payload (.env/.pem/token/...) and must never be persisted. Callers map it to
// 400 "controlled credential input" so the user is routed to the credential
// boundary instead of storing a secret on disk.
var errAttachmentCredential = errors.New("controlled credential input")

// errAttachmentUnsupported signals the uploaded file is not one of the
// previewable attachment kinds (image/markdown/text/json/csv/pdf/office). No
// content is persisted.
var errAttachmentUnsupported = errors.New("unsupported attachment type")

// errAttachmentTooLarge signals the uploaded file exceeded the 10MiB cap. The
// partially-written file is removed by saveAttachment before returning.
var errAttachmentTooLarge = errors.New("attachment too large")

// saveAttachment is the shared file-persisting core behind dialogue attachment
// uploads: it sanitizes the name, rejects credential-like names, classifies the
// preview kind, enforces the 10MiB cap, writes the file under
// ArtifactRoot/dialogue-attachments/<dialogueID>/<id>/<name>, computes the
// sha256, and persists the metadata row. It is used by BOTH the follow-up
// upload endpoint (uploadDialogueAttachment) and the first-message multipart
// create (createDialogue) so credential + size + classification rules are
// enforced at the single point files enter the system. It returns a typed
// sentinel error (errAttachmentCredential / errAttachmentUnsupported /
// errAttachmentTooLarge) so callers can map it to the right HTTP status.
//
// src is consumed but NOT closed by this helper — the caller owns the reader's
// lifetime (it may be a multipart.File the caller closes via defer).
func (s *Server) saveAttachment(ctx context.Context, dialogueID, focusKey, filename, contentType string, src io.Reader) (model.DialogueAttachment, error) {
	name := safeAttachmentName(filename)
	if looksLikeCredentialFile(name) {
		return model.DialogueAttachment{}, errAttachmentCredential
	}
	previewKind, ext, mimeType, ok := classifyAttachment(name, contentType)
	if !ok {
		return model.DialogueAttachment{}, errAttachmentUnsupported
	}
	id := "att_" + idpkg.New()
	rel := filepath.ToSlash(filepath.Join("dialogue-attachments", dialogueID, id, name))
	full := filepath.Join(s.cfg.ArtifactRoot, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return model.DialogueAttachment{}, err
	}
	out, err := os.Create(full)
	if err != nil {
		return model.DialogueAttachment{}, err
	}
	defer out.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(src, maxDialogueAttachmentBytes+1))
	if err != nil {
		_ = os.Remove(full)
		return model.DialogueAttachment{}, err
	}
	if n > maxDialogueAttachmentBytes {
		_ = os.Remove(full)
		return model.DialogueAttachment{}, errAttachmentTooLarge
	}
	att := model.DialogueAttachment{
		ID: id, DialogueID: dialogueID, FocusKey: focusKey,
		OriginalName: name, StoredPath: rel, Mime: mimeType, Extension: ext,
		SizeBytes: n, SHA256: "sha256:" + hex.EncodeToString(h.Sum(nil)),
		PreviewKind: previewKind, Status: model.AttachmentStatusActive, CreatedAt: time.Now(),
	}
	if err := s.store.CreateDialogueAttachment(ctx, att); err != nil {
		_ = os.Remove(full)
		return model.DialogueAttachment{}, err
	}
	return att, nil
}

// uploadDialogueAttachment handles POST /api/dialogues/:id/attachments — the
// follow-up message attachment upload. It persists exactly one file via the
// shared saveAttachment core and returns 201 {attachment}. Credential-like and
// unsupported payloads are rejected with 400 before any file is written.
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
	att, serr := s.saveAttachment(r.Context(), dialogueID, r.FormValue("focusKey"), header.Filename, header.Header.Get("Content-Type"), f)
	if serr != nil {
		switch {
		case errors.Is(serr, errAttachmentCredential):
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "credentials must use controlled credential input"})
		case errors.Is(serr, errAttachmentUnsupported):
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported attachment type"})
		case errors.Is(serr, errAttachmentTooLarge):
			writeError(w, http.StatusBadRequest, "attachment too large")
		default:
			writeError(w, http.StatusInternalServerError, "save attachment")
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"attachment": att})
}

// getDialogueAttachmentContent handles GET
// /api/dialogues/:id/attachments/:attachmentId/content — the click-to-preview
// content route (F3). It serves the stored attachment's own file bytes under
// ArtifactRoot with strict path containment: the resolved path MUST stay under
// ArtifactRoot, rejecting any `..` or absolute traversal (404). The content-type
// is derived from the attachment's PreviewKind: text kinds (markdown/text/json/
// csv) are served as text/* so the frontend's text fetch renders them; image
// kinds as image/<sub>; pdf as application/pdf. Kinds with no inline preview body
// (metadata/office, blocked, missing-file) yield 404. Only StoredPath is ever
// read; credential files never reach this table (rejected at upload), and the
// handler serves nothing outside the attachment's own file.
func (s *Server) getDialogueAttachmentContent(w http.ResponseWriter, r *http.Request) {
	dialogueID := Param(r, "id")
	attachmentID := Param(r, "attachmentId")
	att, err := s.store.GetDialogueAttachment(r.Context(), dialogueID, attachmentID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get attachment")
		return
	}
	if att == nil || att.Status != model.AttachmentStatusActive {
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	}
	contentType, ok := attachmentContentContentType(att.PreviewKind, att.Mime)
	if !ok {
		// metadata/office/blocked: no inline preview body to serve.
		writeError(w, http.StatusNotFound, "no preview content for this attachment kind")
		return
	}
	full, ok := resolveAttachmentPath(s.cfg.ArtifactRoot, att.StoredPath)
	if !ok {
		// StoredPath escaped ArtifactRoot (traversal) or was absolute: never serve.
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	}
	f, err := os.Open(full)
	if err != nil {
		// Missing file on disk: degrade to 404 rather than surfacing FS errors.
		writeError(w, http.StatusNotFound, "attachment content unavailable")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", contentType)
	if _, err := io.Copy(w, f); err != nil {
		// Best-effort: a partial write after headers is unwinnable; just return.
		return
	}
}

// resolveAttachmentPath resolves StoredPath (slash-relative under ArtifactRoot)
// to an absolute on-disk path and enforces strict containment: the cleaned,
// joined path MUST remain under ArtifactRoot. A StoredPath containing `..` or an
// absolute segment yields ok=false. ok is also false when StoredPath is empty.
func resolveAttachmentPath(artifactRoot, storedPath string) (string, bool) {
	if strings.TrimSpace(storedPath) == "" {
		return "", false
	}
	root := filepath.Clean(artifactRoot)
	full := filepath.Clean(filepath.Join(root, filepath.FromSlash(storedPath)))
	rel, err := filepath.Rel(root, full)
	if err != nil {
		return "", false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return full, true
}

// attachmentContentContentType maps a preview kind to the HTTP Content-Type the
// content route serves it as, returning ok=false for kinds with no inline
// preview body (metadata/blocked). image sub-type is derived from Mime when
// available, defaulting to jpeg.
func attachmentContentContentType(kind model.AttachmentPreviewKind, mime string) (string, bool) {
	switch kind {
	case model.AttachmentPreviewMarkdown:
		return "text/markdown; charset=utf-8", true
	case model.AttachmentPreviewText:
		return "text/plain; charset=utf-8", true
	case model.AttachmentPreviewJSON:
		return "application/json; charset=utf-8", true
	case model.AttachmentPreviewCSV:
		return "text/csv; charset=utf-8", true
	case model.AttachmentPreviewPDF:
		return "application/pdf", true
	case model.AttachmentPreviewImage:
		sub := "jpeg"
		if strings.HasPrefix(mime, "image/") {
			sub = strings.TrimPrefix(mime, "image/")
		}
		return "image/" + sub, true
	default:
		// metadata/blocked: no inline content to preview.
		return "", false
	}
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
