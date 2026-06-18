package server

import (
	"net/http"
)

// listApps handles GET /api/apps — returns every known application as JSON.
func (s *Server) listApps(w http.ResponseWriter, r *http.Request) {
	apps, err := s.store.ListApplications(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list apps")
		return
	}
	writeJSON(w, http.StatusOK, apps)
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
