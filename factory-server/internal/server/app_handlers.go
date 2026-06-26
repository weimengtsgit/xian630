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

// listManagedAgents handles GET /api/managed-agents. Managed agents are
// catalog-configured external/static links and do not participate in app
// lifecycle operations.
func (s *Server) listManagedAgents(w http.ResponseWriter, r *http.Request) {
	catalog, err := scanner.LoadSceneCatalogForSurface(s.cfg.WorkspaceRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "load scene catalog")
		return
	}
	writeJSON(w, http.StatusOK, catalog.ManagedAgents())
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
// all generated apps. The scene catalog is loaded with the structural
// (surface-only) loader: blueprint-surface presets are never stored (the scanner
// drops them), so requiring the full preset set here would 500 every
// fresh-database GET /api/apps. Structural fail-closed still applies: a missing
// or malformed catalog errors rather than falling back to a permissive list.
func (s *Server) filterVisibleApplications(apps []model.Application) ([]model.Application, error) {
	catalog, err := scanner.LoadSceneCatalogForSurface(s.cfg.WorkspaceRoot)
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
