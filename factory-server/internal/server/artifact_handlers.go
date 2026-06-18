package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// artifactContent handles GET /api/artifacts/:id/content. It streams the file
// referenced by an artifact's Path as text/plain, but only after verifying the
// resolved path is inside the configured artifact root. A path that escapes the
// root (via ".." traversal or an absolute path elsewhere) yields 403 so a
// malicious or buggy Path value can never read arbitrary host files.
func (s *Server) artifactContent(w http.ResponseWriter, r *http.Request) {
	art, err := s.store.GetArtifact(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get artifact")
		return
	}
	if art == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	root, err := filepath.Abs(s.cfg.ArtifactRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve artifact root")
		return
	}
	// Resolve both candidate forms: the Path may be absolute (inside root) or
	// relative to root. Whichever we pick, the cleaned+abs'd result must still
	// live under root.
	cand := art.Path
	if !filepath.IsAbs(cand) {
		cand = filepath.Join(root, cand)
	}
	clean, err := filepath.Abs(filepath.Clean(cand))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve artifact path")
		return
	}

	// Reject anything not under root. The trailing separator guarantees we match
	// the directory itself, not a sibling that merely shares a prefix
	// (e.g. /tmp/.factory-runs-evil vs /tmp/.factory-runs).
	if !strings.HasPrefix(clean+string(filepath.Separator), root+string(filepath.Separator)) && clean != root {
		writeError(w, http.StatusForbidden, "artifact path outside root")
		return
	}

	data, err := os.ReadFile(clean)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "artifact file missing")
			return
		}
		writeError(w, http.StatusInternalServerError, "read artifact")
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
