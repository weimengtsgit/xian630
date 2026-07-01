package server

import (
	"encoding/json"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Server) jobProjectDocumentFile(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.GetJob(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	root, ok := resolveJobProjectRoot(s.cfg.WorkspaceRoot, *job)
	if !ok {
		writeError(w, http.StatusNotFound, "project root not found")
		return
	}
	full, cleanRel, ok := resolveProjectFilePath(root, r.URL.Query().Get("path"))
	if !ok || !strings.HasPrefix(cleanRel, "docs/") || filepath.Ext(cleanRel) != ".md" {
		writeError(w, http.StatusForbidden, "unsupported project document path")
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "stat document")
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read document")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":     cleanRel,
		"name":     filepath.Base(cleanRel),
		"kind":     "markdown",
		"mime":     mime.TypeByExtension(filepath.Ext(cleanRel)),
		"size":     info.Size(),
		"content":  string(data),
		"checksum": contentChecksum(data),
	})
}

// jobInterfacePreview handles GET /api/jobs/:id/interface-preview?artifactId=...
// It serves the retained interface-preview manifest a successful design_contract
// step wrote (Task 8 createInterfacePreviewSnapshot). The manifest is stored-only
// otherwise; this endpoint makes it inspectable end-to-end so the user can review
// the proposed interface as spec #7 requires (the retained snapshot also serves as
// acceptance evidence per #38).
//
// Resolution: load the job's workbench artifact refs, find the interface_preview
// ref matching artifactId (or, when artifactId is omitted, the latest interface_preview
// by UpdatedAt), and read its manifest.json under ArtifactRoot with STRICT path
// containment (clean; reject `..`/absolute/symlink-escape — mirrors the attachment
// content handler's resolveAttachmentPath). The manifest is JSON-decoded and
// returned as { summary, designDocument, assumedDataFields, snapshotHash, path }.
// Missing job/ref/file all yield 404; a traversal path is treated as 404 (never
// served). X-Content-Type-Options: nosniff is set because the body is JSON served
// for inspection, not an executable preview.
func (s *Server) jobInterfacePreview(w http.ResponseWriter, r *http.Request) {
	jobID := Param(r, "id")
	job, err := s.store.GetJob(r.Context(), jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	refs, err := s.store.ListWorkbenchArtifactRefsByJob(r.Context(), jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list workbench artifacts")
		return
	}
	artifactID := strings.TrimSpace(r.URL.Query().Get("artifactId"))
	var match *model.WorkbenchArtifactRef
	for i := range refs {
		ref := &refs[i]
		if ref.Kind != model.WorkbenchArtifactInterfacePreview {
			continue
		}
		if artifactID != "" {
			if ref.ID == artifactID {
				match = ref
				break
			}
			continue
		}
		// No artifactId: pick the latest interface_preview by UpdatedAt.
		if match == nil || ref.UpdatedAt.After(match.UpdatedAt) {
			match = ref
		}
	}
	if match == nil {
		writeError(w, http.StatusNotFound, "interface preview not found")
		return
	}
	full, ok := resolveAttachmentPath(s.cfg.ArtifactRoot, match.Path)
	if !ok {
		// Path escaped ArtifactRoot (traversal) or was absolute: never serve.
		writeError(w, http.StatusNotFound, "interface preview not found")
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		// Missing/unreadable file on disk: degrade to 404, never surface FS errors.
		writeError(w, http.StatusNotFound, "interface preview unavailable")
		return
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		writeError(w, http.StatusNotFound, "interface preview unavailable")
		return
	}
	resp := map[string]any{
		"summary":           manifest["summary"],
		"designDocument":    manifest["designDocument"],
		"assumedDataFields": manifest["assumedDataFields"],
		"snapshotHash":      match.SnapshotHash,
		"path":              match.Path,
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) jobWorkbenchArtifactContent(w http.ResponseWriter, r *http.Request) {
	jobID := Param(r, "id")
	artifactID := strings.TrimSpace(Param(r, "artifactID"))
	if artifactID == "" {
		writeError(w, http.StatusNotFound, "workbench artifact not found")
		return
	}
	refs, err := s.store.ListWorkbenchArtifactRefsByJob(r.Context(), jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list workbench artifacts")
		return
	}
	var match *model.WorkbenchArtifactRef
	for i := range refs {
		ref := &refs[i]
		if ref.ID == artifactID && ref.Kind == model.WorkbenchArtifactDataAccessPlan {
			match = ref
			break
		}
	}
	if match == nil {
		writeError(w, http.StatusNotFound, "workbench artifact not found")
		return
	}
	full, ok := resolveAttachmentPath(s.cfg.ArtifactRoot, match.Path)
	if !ok || filepath.Ext(match.Path) != ".md" || filepath.Base(match.Path) != "data-access.redacted.md" {
		// 数据方案页面只允许打开脱敏 Markdown，内部版可能包含鉴权信息。
		writeError(w, http.StatusNotFound, "workbench artifact unavailable")
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "workbench artifact unavailable")
			return
		}
		writeError(w, http.StatusInternalServerError, "stat workbench artifact")
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read workbench artifact")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":     match.Path,
		"name":     filepath.Base(match.Path),
		"kind":     "markdown",
		"mime":     mime.TypeByExtension(filepath.Ext(match.Path)),
		"size":     info.Size(),
		"content":  string(data),
		"checksum": contentChecksum(data),
	})
}

func resolveJobProjectRoot(workspace string, job model.Job) (string, bool) {
	if job.AppSlug == "" {
		return "", false
	}
	root := filepath.Join(workspace, "generated-apps", filepath.FromSlash(job.AppSlug))
	if !strings.HasPrefix(filepath.Clean(root), filepath.Join(filepath.Clean(workspace), "generated-apps")+string(filepath.Separator)) {
		return "", false
	}
	return root, true
}
