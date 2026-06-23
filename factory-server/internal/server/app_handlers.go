package server

import (
	"net/http"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
)

// listApps handles GET /api/apps — returns the catalog application-surface
// presets plus every generated application. Fail-closed: if the validated
// scene catalog cannot be loaded the endpoint errors rather than falling back
// to a permissive list.
func (s *Server) listApps(w http.ResponseWriter, r *http.Request) {
	apps, err := s.store.ListApplications(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list apps")
		return
	}
	visible, err := s.filterVisibleApplications(apps)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "load scene catalog")
		return
	}
	writeJSON(w, http.StatusOK, visible)
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

// filterVisibleApplications keeps only catalog application-surface presets and
// all generated apps. The scene catalog is validated against the preset slugs
// present in the store so a missing or malformed catalog is fail-closed.
func (s *Server) filterVisibleApplications(apps []model.Application) ([]model.Application, error) {
	presetSlugs := make(map[string]bool)
	for _, app := range apps {
		if app.Source == model.AppSourcePreset {
			presetSlugs[app.Slug] = true
		}
	}
	catalog, err := scanner.LoadSceneCatalog(s.cfg.WorkspaceRoot, presetSlugs)
	if err != nil {
		return nil, err
	}
	out := make([]model.Application, 0, len(apps))
	for _, app := range apps {
		if app.Source == model.AppSourcePreset {
			if !catalog.IsVisibleApplication(app.Slug) {
				continue
			}
		}
		out = append(out, app)
	}
	return out, nil
}
