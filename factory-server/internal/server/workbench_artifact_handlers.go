package server

import (
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
