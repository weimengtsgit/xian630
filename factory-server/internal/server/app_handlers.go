package server

import (
	"net/http"

	"github.com/weimengtsgit/xian630/factory-server/internal/catalog"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// listApps handles GET /api/apps — returns every known application as JSON.
func (s *Server) listApps(w http.ResponseWriter, r *http.Request) {
	apps, err := s.store.ListApplications(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list apps")
		return
	}
	writeJSON(w, http.StatusOK, s.filterVisibleApplications(apps))
}

// getApp handles GET /api/apps/:id — returns a single application or 404.
func (s *Server) getApp(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	app, err := s.store.GetApplication(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, app)
}

func (s *Server) filterVisibleApplications(apps []model.Application) []model.Application {
	cfg := catalog.Load(s.cfg.WorkspaceRoot)
	out := make([]model.Application, 0, len(apps))
	for _, app := range apps {
		if !catalog.AppEnabled(cfg, app.Slug) {
			continue
		}
		if !catalog.AppVisibleInList(cfg, app.Slug) {
			continue
		}
		out = append(out, app)
	}
	return out
}
