package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// defaultContainerPort is the in-container port every preset app listens on
// (design §5.6). Manifest wiring of a custom port is a later task.
const defaultContainerPort = 80

// healthCheckTimeout caps the post-start readiness probe (design §5.6: 10s).
const healthCheckTimeout = 10 * time.Second

const activeDeploymentProbeTimeout = 1500 * time.Millisecond

// errResponse pairs an HTTP status with a structured error_code, written as
// {"error": <message>, "error_code": <code>}.
type errResponse struct {
	status int
	code   model.ErrorCode
	msg    string
}

func (e errResponse) write(w http.ResponseWriter) {
	writeJSON(w, e.status, map[string]any{"error": e.msg, "error_code": string(e.code)})
}

// startApp handles POST /api/apps/:id/start. It is idempotent: if a running
// deployment already exists for the app it is returned with 200. Otherwise it
// builds the image, allocates a host port, runs the container and probes the
// health endpoint. On any failure it marks the app `error` and rolls back any
// partially-created container (stop+remove on health-check failure).
func (s *Server) startApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")

	// Per-app mutual exclusion (TryLock → 409 if another op is in flight).
	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	ctx := r.Context()
	pod := deploy.NewPodman(s.runner)
	// Idempotent fast path, but only after confirming the recorded deployment is
	// reachable. The DB can be stale after a manual podman stop or a server
	// restart, so a blind return would show "running" while nothing is usable.
	if active, _ := s.store.GetActiveDeployment(ctx, appID); active != nil {
		if err := s.healthCheck(ctx, active.URL, activeDeploymentProbeTimeout); err == nil {
			if err := s.store.SetAppRuntime(ctx, appID, string(model.AppStatusRunning), active.URL); err != nil {
				writeError(w, http.StatusInternalServerError, "set app runtime")
				return
			}
			s.publishDeploymentUpdated(ctx, active.ID)
			s.publishAppUpdated(ctx, appID)
			writeJSON(w, http.StatusOK, active)
			return
		}
		_, _ = pod.StopContainer(ctx, active.ContainerName)
		_, _ = pod.RemoveContainer(ctx, active.ContainerName)
		_ = s.store.UpdateDeploymentStatus(ctx, active.ID, "stopped")
		_ = s.store.SetAppRuntime(ctx, appID, string(model.AppStatusStopped), "")
		s.publishDeploymentUpdated(ctx, active.ID)
		s.publishAppUpdated(ctx, appID)
	}

	tag := string(app.Source)
	buildApp := s.workspaceApp(*app)

	// 1. Build image.
	img, _, err := pod.BuildImage(ctx, buildApp, tag)
	if err != nil {
		s.markAppError(ctx, appID)
		errResponse{http.StatusBadGateway, model.ErrorImageBuildFailed, "image build failed"}.write(w)
		return
	}

	// 2. Allocate host port from the design-default pool 18000-18999.
	hostPort, err := deploy.DefaultAllocator().Choose(s.portInUse(ctx))
	if err != nil {
		s.markAppError(ctx, appID)
		errResponse{http.StatusBadGateway, model.ErrorPortUnavailable, "port unavailable"}.write(w)
		return
	}

	// 3. Run container.
	cr, _, err := pod.RunContainer(ctx, img, app.Slug, hostPort, defaultContainerPort)
	if err != nil {
		if cr.Name != "" {
			_, _ = pod.RemoveContainer(ctx, cr.Name)
		}
		s.markAppError(ctx, appID)
		errResponse{http.StatusBadGateway, model.ErrorPodmanRunFailed, "podman run failed"}.write(w)
		return
	}

	url := "http://127.0.0.1:" + strconv.Itoa(hostPort)

	// 4. Health check. On failure, stop+remove the container (best-effort) and
	// record a failed deployment so the app is not left in a half-state.
	if err := s.healthCheck(ctx, url, healthCheckTimeout); err != nil {
		_, _ = pod.StopContainer(ctx, cr.Name)
		_, _ = pod.RemoveContainer(ctx, cr.Name)
		now := time.Now()
		failedDep := model.Deployment{
			ID:            "dep_" + idpkg.New(),
			AppID:         appID,
			ImageName:     stripTag(img.FullName, tag),
			ImageTag:      tag,
			ContainerName: cr.Name,
			HostPort:      hostPort,
			ContainerPort: defaultContainerPort,
			URL:           url,
			Status:        "failed",
			CreatedAt:     now,
		}
		_ = s.store.CreateDeployment(ctx, failedDep)
		s.publishDeploymentUpdated(ctx, failedDep.ID)
		s.markAppError(ctx, appID)
		errResponse{http.StatusBadGateway, model.ErrorHealthCheckFailed, "health check failed"}.write(w)
		return
	}

	// 5. Success: persist the running deployment and flip the app to running.
	now := time.Now()
	dep := model.Deployment{
		ID:            "dep_" + idpkg.New(),
		AppID:         appID,
		ImageName:     stripTag(img.FullName, tag),
		ImageTag:      tag,
		ContainerName: cr.Name,
		HostPort:      hostPort,
		ContainerPort: defaultContainerPort,
		URL:           url,
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}
	if err := s.store.CreateDeployment(ctx, dep); err != nil {
		writeError(w, http.StatusInternalServerError, "create deployment")
		return
	}
	if err := s.store.SetAppRuntime(ctx, appID, string(model.AppStatusRunning), url); err != nil {
		writeError(w, http.StatusInternalServerError, "set app runtime")
		return
	}
	s.publishDeploymentUpdated(ctx, dep.ID)
	s.publishAppUpdated(ctx, appID)

	writeJSON(w, http.StatusOK, dep)
}

// stopApp handles POST /api/apps/:id/stop. It is idempotent: no active
// deployment → 200 {"status":"already stopped"}. Otherwise it stops and
// removes the container (best-effort, ignoring not-found) and flips both the
// deployment and the app to stopped.
func (s *Server) stopApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")

	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	ctx := r.Context()
	active, err := s.store.GetActiveDeployment(ctx, appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get deployment")
		return
	}
	if active == nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "already stopped"})
		return
	}

	pod := deploy.NewPodman(s.runner)
	// Best-effort cleanup: a missing container must not fail the stop.
	_, _ = pod.StopContainer(ctx, active.ContainerName)
	_, _ = pod.RemoveContainer(ctx, active.ContainerName)

	if err := s.store.UpdateDeploymentStatus(ctx, active.ID, "stopped"); err != nil {
		writeError(w, http.StatusInternalServerError, "update deployment")
		return
	}
	if err := s.store.SetAppRuntime(ctx, appID, string(model.AppStatusStopped), ""); err != nil {
		writeError(w, http.StatusInternalServerError, "set app runtime")
		return
	}

	// Re-read so the response reflects the stopped timestamp.
	dep, _ := s.store.GetDeployment(ctx, active.ID)
	s.publishDeploymentUpdated(ctx, active.ID)
	s.publishAppUpdated(ctx, appID)
	writeJSON(w, http.StatusOK, dep)
}

// rebuildApp handles POST /api/apps/:id/rebuild. It rebuilds the app's image
// (tag = app.Source) but does NOT re-run the container — start must be invoked
// separately. It holds the global executor lock so it conflicts with any
// in-flight job (Task 10 will share this lock).
func (s *Server) rebuildApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")

	// Global executor lock: only one job/rebuild at a time across the server.
	if !s.execBusy.CompareAndSwap(false, true) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "executor busy"})
		return
	}
	defer s.execBusy.Store(false)

	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	ctx := r.Context()
	tag := string(app.Source)
	buildApp := s.workspaceApp(*app)
	img, _, err := deploy.NewPodman(s.runner).BuildImage(ctx, buildApp, tag)
	if err != nil {
		s.markAppError(ctx, appID)
		errResponse{http.StatusBadGateway, model.ErrorImageBuildFailed, "image build failed"}.write(w)
		return
	}

	s.publishAppUpdated(ctx, appID)
	writeJSON(w, http.StatusOK, map[string]any{"status": "built", "image": img.FullName})
}

// markAppError flips an app to error status, swallowing the error (callers have
// already decided on their response status and just want the DB to reflect the
// failure for diagnostics).
func (s *Server) markAppError(ctx context.Context, appID string) {
	_ = s.store.SetAppRuntime(ctx, appID, string(model.AppStatusError), "")
	s.publishAppUpdated(ctx, appID)
}

func (s *Server) workspaceApp(app model.Application) model.Application {
	if app.Path != "" && !filepath.IsAbs(app.Path) {
		root := s.cfg.WorkspaceRoot
		if root == "" {
			root = "."
		}
		app.Path = filepath.Join(root, app.Path)
	}
	return app
}

// portInUse returns an isUsed predicate for the port Allocator that reports a
// port as taken when any running deployment already binds it.
func (s *Server) portInUse(ctx context.Context) func(int) bool {
	return func(port int) bool {
		apps, err := s.store.ListApplications(ctx)
		if err != nil {
			return false
		}
		for _, a := range apps {
			if dep, _ := s.store.GetActiveDeployment(ctx, a.ID); dep != nil && dep.HostPort == port {
				return true
			}
		}
		return false
	}
}

// stripTag removes the trailing ":<tag>" from a full image name, returning the
// bare image name stored separately in the deployments table.
func stripTag(fullName, tag string) string {
	suffix := ":" + tag
	if len(fullName) > len(suffix) && fullName[len(fullName)-len(suffix):] == suffix {
		return fullName[:len(fullName)-len(suffix)]
	}
	return fullName
}

// deleteApp handles DELETE /api/apps/:id for generated apps only. It removes the
// container, tombstones the app directory under the artifact root (so audit
// records survive), then deletes the deployment and application rows. The
// directory is moved-aside first and only removed after the DB rows are gone,
// so a DB failure rolls the directory back to its original location.
func (s *Server) deleteApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")
	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if app.Source != model.AppSourceGenerated {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "only generated apps can be deleted"})
		return
	}
	appDir, err := s.safeGeneratedAppDir(*app)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": err.Error()})
		return
	}

	ctx := r.Context()
	deps, err := s.store.ListDeploymentsByApp(ctx, appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list deployments")
		return
	}
	pod := deploy.NewPodman(s.runner)
	for _, dep := range deps {
		if dep.ContainerName == "" {
			continue
		}
		_, _ = pod.StopContainer(ctx, dep.ContainerName)
		_, _ = pod.RemoveContainer(ctx, dep.ContainerName)
	}

	tombstone := ""
	if _, err := os.Stat(appDir); err == nil {
		tombstone = filepath.Join(s.cfg.ArtifactRoot, "deleted-apps", app.ID+"-"+app.Slug)
		if !filepath.IsAbs(tombstone) {
			tombstone = filepath.Join(s.cfg.WorkspaceRoot, tombstone)
		}
		_ = os.RemoveAll(tombstone)
		if err := os.MkdirAll(filepath.Dir(tombstone), 0o755); err != nil {
			writeError(w, http.StatusInternalServerError, "prepare tombstone")
			return
		}
		if err := os.Rename(appDir, tombstone); err != nil {
			writeError(w, http.StatusInternalServerError, "move app directory")
			return
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusInternalServerError, "stat app directory")
		return
	}

	if err := s.store.DeleteDeploymentsByApp(ctx, appID); err != nil {
		restoreTombstone(tombstone, appDir)
		writeError(w, http.StatusInternalServerError, "delete deployments")
		return
	}
	if err := s.store.DeleteApplication(ctx, appID); err != nil {
		restoreTombstone(tombstone, appDir)
		writeError(w, http.StatusInternalServerError, "delete app")
		return
	}
	if tombstone != "" {
		_ = os.RemoveAll(tombstone)
	}
	s.hub.Publish(Event{Type: "app.deleted", Data: map[string]string{"id": app.ID, "slug": app.Slug}})
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": app.ID, "slug": app.Slug})
}

// safeGeneratedAppDir resolves an app's workspace-relative path to an absolute
// directory under <WorkspaceRoot>/generated-apps and rejects anything that
// escapes that root (absolute paths, parent traversal, or a slug/path mismatch).
func (s *Server) safeGeneratedAppDir(app model.Application) (string, error) {
	if app.Slug == "" {
		return "", errors.New("generated app has no slug")
	}
	root := s.cfg.WorkspaceRoot
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	path := app.Path
	if path == "" {
		path = filepath.Join("generated-apps", app.Slug)
	}
	if filepath.IsAbs(path) {
		return "", errors.New("generated app path must be workspace-relative")
	}
	cleanRel := filepath.Clean(path)
	wantRel := filepath.Join("generated-apps", app.Slug)
	if cleanRel != wantRel {
		return "", errors.New("generated app path does not match generated-apps slug")
	}
	absDir, err := filepath.Abs(filepath.Join(absRoot, cleanRel))
	if err != nil {
		return "", err
	}
	prefix := filepath.Join(absRoot, "generated-apps") + string(os.PathSeparator)
	if !strings.HasPrefix(absDir+string(os.PathSeparator), prefix) {
		return "", errors.New("generated app path escapes generated-apps root")
	}
	return absDir, nil
}

// restoreTombstone moves a tombstoned directory back to its original location on
// DB-delete failure so the filesystem and DB stay consistent. Best-effort.
func restoreTombstone(tombstone, appDir string) {
	if tombstone == "" || appDir == "" {
		return
	}
	_ = os.Rename(tombstone, appDir)
}
