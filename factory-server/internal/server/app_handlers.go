package server

import (
	"net/http"
	"sort"

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

// appGenerationStats handles GET /api/apps/generation-stats. It summarizes
// completed generation jobs for the same application set shown by GET /api/apps.
func (s *Server) appGenerationStats(w http.ResponseWriter, r *http.Request) {
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
	jobs := make([]model.Job, 0)
	for _, app := range visible {
		appJobs, err := s.store.ListJobsForApplication(r.Context(), app.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "list app jobs")
			return
		}
		jobs = append(jobs, appJobs...)
	}
	writeJSON(w, http.StatusOK, calculateApplicationGenerationStats(visible, jobs))
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
func calculateApplicationGenerationStats(apps []model.Application, jobs []model.Job) model.ApplicationGenerationStats {
	visibleAppIDs := make(map[string]bool, len(apps))
	jobsByAppID := make(map[string][]model.Job, len(apps))
	for _, app := range apps {
		visibleAppIDs[app.ID] = true
	}
	for _, job := range jobs {
		appID := ""
		switch {
		case visibleAppIDs[job.ApplicationID]:
			appID = job.ApplicationID
		case visibleAppIDs[job.CreatedAppID]:
			appID = job.CreatedAppID
		}
		if appID == "" {
			continue
		}
		jobsByAppID[appID] = append(jobsByAppID[appID], job)
	}

	applicationDurations := make([]int64, 0, len(apps))
	iterationDurations := make([]int64, 0, len(apps))
	for _, app := range apps {
		appJobs := jobsByAppID[app.ID]
		if len(appJobs) == 0 {
			continue
		}
		sort.SliceStable(appJobs, func(i, j int) bool {
			return appJobs[i].CreatedAt.Before(appJobs[j].CreatedAt)
		})

		completedJobs := make([]model.Job, 0, len(appJobs))
		for _, job := range appJobs {
			if _, ok := jobDurationMs(job); ok {
				completedJobs = append(completedJobs, job)
			}
		}
		if len(completedJobs) == 0 {
			continue
		}
		firstDuration, _ := jobDurationMs(completedJobs[0])
		applicationDurations = append(applicationDurations, firstDuration)
		if len(completedJobs) > 1 {
			latestDuration, _ := jobDurationMs(completedJobs[len(completedJobs)-1])
			iterationDurations = append(iterationDurations, latestDuration)
		}
	}

	return model.ApplicationGenerationStats{
		ApplicationAverageGenerationMs: averageInt64(applicationDurations),
		IterationAverageGenerationMs:   averageInt64(iterationDurations),
		ApplicationSampleCount:         len(applicationDurations),
		IterationSampleCount:           len(iterationDurations),
	}
}

func jobDurationMs(job model.Job) (int64, bool) {
	if job.Status != model.JobStatusCompleted || job.StartedAt == nil || job.EndedAt == nil || job.EndedAt.Before(*job.StartedAt) {
		return 0, false
	}
	return job.EndedAt.Sub(*job.StartedAt).Milliseconds(), true
}
func averageInt64(values []int64) *int64 {
	if len(values) == 0 {
		return nil
	}
	var total int64
	for _, value := range values {
		total += value
	}
	avg := total / int64(len(values))
	return &avg
}
