package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// srvRunner is the test double for deploy.CommandRunner, living in the server
// package so it can be wired into Server.runner. It records every invocation
// and returns success unless a result/err is preconfigured.
type srvRunner struct {
	calls   []srvCall
	failIdx int // negative = never fail; else fail the i-th call with runnerErr
	failErr error
}

type srvCall struct {
	dir  string
	name string
	args []string
}

func (r *srvRunner) Run(_ context.Context, dir, name string, args ...string) (deploy.CommandResult, error) {
	idx := len(r.calls)
	r.calls = append(r.calls, srvCall{dir: dir, name: name, args: append([]string(nil), args...)})
	if r.failIdx >= 0 && idx == r.failIdx {
		return deploy.CommandResult{ExitCode: 1, Stderr: "forced failure"}, r.failErr
	}
	return deploy.CommandResult{ExitCode: 0, Stdout: "ok"}, nil
}

// hasCall reports whether a recorded call matches name and contains every
// substring in wantSubs (checked against the joined argv).
func hasCall(calls []srvCall, name string, wantSubs ...string) bool {
	for _, c := range calls {
		if c.name != name {
			continue
		}
		joined := strings.Join(c.args, " ")
		ok := true
		for _, s := range wantSubs {
			if !strings.Contains(joined, s) {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// newOpsServer returns a Server wired with a fake runner and a succeeding
// health check, seeded with the canonical preset app.
func newOpsServer(t *testing.T, fr *srvRunner) (*Server, *Router) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.UpsertApplication(context.Background(), seedApp()); err != nil {
		t.Fatalf("seed app: %v", err)
	}

	srv := New(config.Config{WorkspaceRoot: t.TempDir()}, st, scanner.Scanner{})
	srv.runner = fr
	srv.runtime = deploy.NewPodman(fr)
	srv.healthCheck = func(context.Context, string, time.Duration) error { return nil }
	return srv, srv.routes()
}

func findCall(calls []srvCall, name string, firstArg string) *srvCall {
	for i := range calls {
		c := &calls[i]
		if c.name == name && len(c.args) > 0 && c.args[0] == firstArg {
			return c
		}
	}
	return nil
}

func expectEvent(t *testing.T, ch <-chan Event, want string) Event {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Type == want {
				return ev
			}
		case <-deadline:
			t.Fatalf("timeout waiting for event %q", want)
		}
	}
}

func TestStartBuildsRunsHealthchecksAndMarksRunning(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/start", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// argv assertions: build then run with the expected shape.
	if !hasCall(fr.calls, "podman", "build", "-t", "localhost/software-factory/east-sea-situation:preset", ".") {
		t.Errorf("missing build call; calls=%v", fr.calls)
	}
	buildCall := findCall(fr.calls, "podman", "build")
	if buildCall == nil {
		t.Fatalf("missing podman build call; calls=%v", fr.calls)
	}
	wantBuildDir := filepath.Join(srv.cfg.WorkspaceRoot, "scene", "east-sea-situation")
	if buildCall.dir != wantBuildDir {
		t.Fatalf("podman build dir = %q, want workspace-rooted %q", buildCall.dir, wantBuildDir)
	}
	if !hasCall(fr.calls, "podman", "run", "-d", "--name sf-east-sea-situation-", "-p ", ":80") {
		t.Errorf("missing run call; calls=%v", fr.calls)
	}

	var dep model.Deployment
	if err := json.NewDecoder(rec.Body).Decode(&dep); err != nil {
		t.Fatalf("decode deployment: %v", err)
	}
	if dep.Status != "running" {
		t.Errorf("dep status = %q, want running", dep.Status)
	}
	if dep.HostPort < 18000 || dep.HostPort > 18999 {
		t.Errorf("host_port = %d, want in [18000,18999]", dep.HostPort)
	}
	wantURL := containerHealthURL(dep.HostPort)
	if dep.URL != wantURL {
		t.Errorf("url = %q, want %q", dep.URL, wantURL)
	}
	if dep.ContainerPort != 80 {
		t.Errorf("container_port = %d, want 80", dep.ContainerPort)
	}

	// App status flipped to running in the store.
	app, err := srv.store.GetApplication(context.Background(), "app-east-sea-situation")
	if err != nil || app == nil {
		t.Fatalf("get app: %v %v", app, err)
	}
	if app.Status != model.AppStatusRunning {
		t.Errorf("app status = %q, want running", app.Status)
	}
	if app.RuntimeURL != wantURL {
		t.Errorf("app runtime_url = %q, want %q", app.RuntimeURL, wantURL)
	}
}

func TestStartUsesConfiguredContainerRuntime(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	srv.runtime = deploy.NewDocker(fr)

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/start", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if hasCall(fr.calls, "podman", "build") || hasCall(fr.calls, "podman", "run") {
		t.Fatalf("start app hardcoded podman despite configured docker runtime: calls=%v", fr.calls)
	}
	if !hasCall(fr.calls, "docker", "build", "-t", "localhost/software-factory/east-sea-situation:preset", ".") {
		t.Fatalf("missing docker build call; calls=%v", fr.calls)
	}
	if !hasCall(fr.calls, "docker", "run", "-d", "--name sf-east-sea-situation-", "-p ", ":80") {
		t.Fatalf("missing docker run call; calls=%v", fr.calls)
	}
}

func TestStartPublishesAppAndDeploymentEvents(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/start", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	expectEvent(t, ch, "deployment.updated")
	expectEvent(t, ch, "app.updated")
}

func TestStartExistingHealthyDeploymentSynchronizesAppRuntime(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	now := time.Now()
	seed := model.Deployment{
		ID:            "dep_active",
		AppID:         "app-east-sea-situation",
		ImageName:     "localhost/software-factory/east-sea-situation",
		ImageTag:      "preset",
		ContainerName: "sf-east-sea-situation-live",
		HostPort:      18000,
		ContainerPort: 80,
		URL:           "http://127.0.0.1:18000",
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}
	if err := srv.store.CreateDeployment(context.Background(), seed); err != nil {
		t.Fatalf("seed deployment: %v", err)
	}
	if err := srv.store.SetAppRuntime(context.Background(), "app-east-sea-situation", string(model.AppStatusStopped), ""); err != nil {
		t.Fatalf("seed stopped app: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/start", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if hasCall(fr.calls, "podman", "build") || hasCall(fr.calls, "podman", "run") {
		t.Fatalf("healthy active deployment should not rebuild/run; calls=%v", fr.calls)
	}
	app, err := srv.store.GetApplication(context.Background(), "app-east-sea-situation")
	if err != nil || app == nil {
		t.Fatalf("get app: %#v %v", app, err)
	}
	if app.Status != model.AppStatusRunning || app.RuntimeURL != seed.URL {
		t.Fatalf("app runtime = %s/%q, want running/%q", app.Status, app.RuntimeURL, seed.URL)
	}
}

func TestStartStaleActiveDeploymentIsClearedAndRecreated(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	now := time.Now()
	seed := model.Deployment{
		ID:            "dep_stale",
		AppID:         "app-east-sea-situation",
		ImageName:     "localhost/software-factory/east-sea-situation",
		ImageTag:      "preset",
		ContainerName: "sf-east-sea-situation-stale",
		HostPort:      18000,
		ContainerPort: 80,
		URL:           "http://127.0.0.1:18000",
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}
	if err := srv.store.CreateDeployment(context.Background(), seed); err != nil {
		t.Fatalf("seed deployment: %v", err)
	}
	healthCalls := 0
	srv.healthCheck = func(context.Context, string, time.Duration) error {
		healthCalls++
		if healthCalls == 1 {
			return errHealthFailed
		}
		return nil
	}

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/start", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !hasCall(fr.calls, "podman", "stop", seed.ContainerName) || !hasCall(fr.calls, "podman", "rm", seed.ContainerName) {
		t.Fatalf("stale deployment should be stopped and removed; calls=%v", fr.calls)
	}
	if !hasCall(fr.calls, "podman", "build") || !hasCall(fr.calls, "podman", "run") {
		t.Fatalf("stale deployment should be recreated; calls=%v", fr.calls)
	}
	old, err := srv.store.GetDeployment(context.Background(), seed.ID)
	if err != nil || old == nil {
		t.Fatalf("get old deployment: %#v %v", old, err)
	}
	if old.Status != "stopped" {
		t.Fatalf("old deployment status = %q, want stopped", old.Status)
	}
}

func TestStartHealthCheckFailureCleansUp(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	// Override the health check to always fail.
	srv.healthCheck = func(context.Context, string, time.Duration) error {
		return errHealthFailed
	}

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/start", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["error_code"] != string(model.ErrorHealthCheckFailed) {
		t.Errorf("error_code = %v, want health_check_failed", body["error_code"])
	}

	// After the failed run+healthcheck, the container must be stopped+removed.
	if !hasCall(fr.calls, "podman", "stop") {
		t.Errorf("missing stop call; calls=%v", fr.calls)
	}
	if !hasCall(fr.calls, "podman", "rm") {
		t.Errorf("missing rm call; calls=%v", fr.calls)
	}

	app, _ := srv.store.GetApplication(context.Background(), "app-east-sea-situation")
	if app.Status != model.AppStatusError {
		t.Errorf("app status = %q, want error", app.Status)
	}

	deps, _ := srv.store.ListDeploymentsByApp(context.Background(), "app-east-sea-situation")
	if len(deps) != 1 || deps[0].Status != "failed" {
		t.Fatalf("deployments = %#v", deps)
	}
}

func TestStopRemovesContainerAndMarksStopped(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)

	// Seed an active deployment so stop has work to do.
	now := time.Now()
	seed := model.Deployment{
		ID:            "dep_seed",
		AppID:         "app-east-sea-situation",
		ImageName:     "localhost/software-factory/east-sea-situation",
		ImageTag:      "preset",
		ContainerName: "sf-east-sea-situation-deadbeef",
		HostPort:      18000,
		ContainerPort: 80,
		URL:           "http://127.0.0.1:18000",
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}
	if err := srv.store.CreateDeployment(context.Background(), seed); err != nil {
		t.Fatalf("seed deployment: %v", err)
	}
	if err := srv.store.SetAppRuntime(context.Background(), "app-east-sea-situation", string(model.AppStatusRunning), seed.URL); err != nil {
		t.Fatalf("set runtime: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/stop", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !hasCall(fr.calls, "podman", "stop", "sf-east-sea-situation-deadbeef") {
		t.Errorf("missing stop call; calls=%v", fr.calls)
	}
	if !hasCall(fr.calls, "podman", "rm", "sf-east-sea-situation-deadbeef") {
		t.Errorf("missing rm call; calls=%v", fr.calls)
	}

	app, _ := srv.store.GetApplication(context.Background(), "app-east-sea-situation")
	if app.Status != model.AppStatusStopped {
		t.Errorf("app status = %q, want stopped", app.Status)
	}
	if app.RuntimeURL != "" {
		t.Errorf("app runtime_url = %q, want empty", app.RuntimeURL)
	}

	dep, _ := srv.store.GetDeployment(context.Background(), "dep_seed")
	if dep == nil || dep.Status != "stopped" {
		t.Fatalf("deployment = %#v", dep)
	}
}

func TestStopAlreadyStoppedIsIdempotent(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	_, r := newOpsServer(t, fr)

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/stop", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body["status"] != "already stopped" {
		t.Errorf("body = %v, want already stopped", body)
	}
	if len(fr.calls) != 0 {
		t.Errorf("expected no podman calls, got %v", fr.calls)
	}
}

func TestRebuildReturnsConflictWhenAppBusy(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	// Seed a RUNNING pipeline job for the app's slug: a rebuild conflicts with a
	// running job of the SAME app (they both write generated-apps/<slug>/ + the
	// same image tag). The executor-busy conflict is now per-app, not global —
	// so a job for an unrelated app must NOT block this rebuild.
	job := model.Job{
		ID:              "job_running_for_rebuild",
		AppSlug:         "east-sea-situation",
		Status:          model.JobStatusRunning,
		CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
	if err := srv.store.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("seed running job: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/rebuild", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body["error"] != "app busy" {
		t.Errorf("body = %v, want app busy", body)
	}
}

func TestRebuildBuildsImageAndReturnsBuilt(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)

	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/rebuild", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body["status"] != "built" {
		t.Errorf("body = %v, want status=built", body)
	}
	if body["image"] != "localhost/software-factory/east-sea-situation:preset" {
		t.Errorf("body image = %v", body["image"])
	}
	if !hasCall(fr.calls, "podman", "build", "-t", "localhost/software-factory/east-sea-situation:preset", ".") {
		t.Errorf("missing build call; calls=%v", fr.calls)
	}
	buildCall := findCall(fr.calls, "podman", "build")
	if buildCall == nil {
		t.Fatalf("missing podman build call; calls=%v", fr.calls)
	}
	wantBuildDir := filepath.Join(srv.cfg.WorkspaceRoot, "scene", "east-sea-situation")
	if buildCall.dir != wantBuildDir {
		t.Fatalf("podman build dir = %q, want workspace-rooted %q", buildCall.dir, wantBuildDir)
	}
	// Rebuild must NOT run a container.
	if hasCall(fr.calls, "podman", "run") {
		t.Errorf("rebuild should not run a container; calls=%v", fr.calls)
	}
}

func TestStartReturns404ForMissingApp(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	_, r := newOpsServer(t, fr)

	req := httptest.NewRequest(http.MethodPost, "/api/apps/missing/start", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestDeleteGeneratedAppRemovesDirectoryRowsAndPublishesEvent(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	root := srv.cfg.WorkspaceRoot
	appDir := filepath.Join(root, "generated-apps", "demo-delete")
	if err := os.MkdirAll(filepath.Join(appDir, ".factory"), 0o755); err != nil {
		t.Fatalf("mkdir app dir: %v", err)
	}
	now := time.Now()
	app := model.Application{
		ID: "app-demo-delete", Slug: "demo-delete", Name: "Demo Delete", Type: "command_dashboard",
		Source: model.AppSourceGenerated, Path: "generated-apps/demo-delete",
		ManifestPath: "generated-apps/demo-delete/.factory/app.json", Status: model.AppStatusRunning,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := srv.store.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("seed app: %v", err)
	}
	dep := model.Deployment{ID: "dep_delete", AppID: app.ID, ContainerName: "sf-demo-delete", Status: "running", CreatedAt: now}
	if err := srv.store.CreateDeployment(context.Background(), dep); err != nil {
		t.Fatalf("seed dep: %v", err)
	}
	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	req := httptest.NewRequest(http.MethodDelete, "/api/apps/app-demo-delete", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(appDir); !os.IsNotExist(err) {
		t.Fatalf("app dir still exists or stat failed differently: %v", err)
	}
	got, err := srv.store.GetApplication(context.Background(), app.ID)
	if err != nil {
		t.Fatalf("get app: %v", err)
	}
	if got != nil {
		t.Fatalf("app row still exists: %#v", got)
	}
	deps, err := srv.store.ListDeploymentsByApp(context.Background(), app.ID)
	if err != nil {
		t.Fatalf("list deps: %v", err)
	}
	if len(deps) != 0 {
		t.Fatalf("deployments still exist: %#v", deps)
	}
	if !hasCall(fr.calls, "podman", "rm", "sf-demo-delete") {
		t.Fatalf("expected podman rm for running container; calls=%v", fr.calls)
	}
	expectEvent(t, ch, "app.deleted")
}

func TestDeleteRejectsPresetApp(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	_, r := newOpsServer(t, fr)
	req := httptest.NewRequest(http.MethodDelete, "/api/apps/app-east-sea-situation", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409", rec.Code, rec.Body.String())
	}
}

func TestDeleteRejectsGeneratedAppOutsideGeneratedRoot(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	now := time.Now()
	app := model.Application{
		ID: "app-bad", Slug: "bad", Name: "Bad", Source: model.AppSourceGenerated,
		Type: "command_dashboard", Path: "../outside", ManifestPath: "generated-apps/bad/.factory/app.json",
		Status: model.AppStatusStopped, CreatedAt: now, UpdatedAt: now,
	}
	if err := srv.store.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("seed app: %v", err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/apps/app-bad", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s, want 403", rec.Code, rec.Body.String())
	}
	got, _ := srv.store.GetApplication(context.Background(), app.ID)
	if got == nil {
		t.Fatalf("unsafe app row was deleted")
	}
}

// TestRollbackPromotesPreviousVersionThroughHealth (Task 6): an explicit-confirm
// rollback re-builds, re-runs, and re-healths the previous (superseded)
// version's image, then promotes it to effective, superseding the current. The
// current effective container is stopped.
func TestRollbackPromotesPreviousVersionThroughHealth(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	ctx := context.Background()
	now := time.Now()

	// Current effective v2 (running).
	depV2 := model.Deployment{
		ID: "dep_v2", AppID: "app-east-sea-situation",
		ImageName: "localhost/software-factory/east-sea-situation", ImageTag: "ver_v2",
		ContainerName: "sf-v2", HostPort: 18000, ContainerPort: 80,
		URL: "http://127.0.0.1:18000", Status: "running", CreatedAt: now, StartedAt: &now,
	}
	if err := srv.store.CreateDeployment(ctx, depV2); err != nil {
		t.Fatalf("seed v2 dep: %v", err)
	}
	promoted := now
	if _, err := srv.store.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_v2", ApplicationID: "app-east-sea-situation", JobID: "job_v2",
		Status: model.ApplicationVersionEffective, DeploymentID: depV2.ID, SourcePath: "scene/east-sea-situation",
		CreatedAt: now, PromotedAt: &promoted,
	}); err != nil {
		t.Fatalf("seed v2: %v", err)
	}
	// Previous superseded v1 (the rollback target).
	depV1 := model.Deployment{
		ID: "dep_v1", AppID: "app-east-sea-situation",
		ImageName: "localhost/software-factory/east-sea-situation", ImageTag: "ver_v1",
		ContainerName: "sf-v1-dead", HostPort: 18001, ContainerPort: 80,
		URL: "http://127.0.0.1:18001", Status: "stopped", CreatedAt: now.Add(-time.Hour),
	}
	if err := srv.store.CreateDeployment(ctx, depV1); err != nil {
		t.Fatalf("seed v1 dep: %v", err)
	}
	v1Promoted := now.Add(-30 * time.Minute)
	if _, err := srv.store.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_v1", ApplicationID: "app-east-sea-situation", JobID: "job_v1",
		Status: model.ApplicationVersionSuperseded, DeploymentID: depV1.ID, SourcePath: "scene/east-sea-situation",
		CreatedAt: now.Add(-time.Hour), PromotedAt: &v1Promoted,
	}); err != nil {
		t.Fatalf("seed v1: %v", err)
	}
	if err := srv.store.SetAppRuntime(ctx, "app-east-sea-situation", string(model.AppStatusRunning), depV2.URL); err != nil {
		t.Fatalf("set runtime: %v", err)
	}

	body := strings.NewReader(`{"confirm":true,"version_id":"ver_v1"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/rollback", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// v1 is now effective; v2 superseded.
	eff, _ := srv.store.GetEffectiveApplicationVersion(ctx, "app-east-sea-situation")
	if eff == nil || eff.ID != "ver_v1" {
		t.Fatalf("effective = %#v, want ver_v1", eff)
	}
	v2, _ := srv.store.GetApplicationVersionByID(ctx, "ver_v2")
	if v2 == nil || v2.Status != model.ApplicationVersionSuperseded {
		t.Fatalf("v2 status = %#v, want superseded", v2)
	}
	// v2's container was stopped; a new container was run for v1.
	if !hasCall(fr.calls, "podman", "stop", "sf-v2") {
		t.Errorf("current container should be stopped; calls=%v", fr.calls)
	}
	if !hasCall(fr.calls, "podman", "run") {
		t.Errorf("rollback should run a container for v1; calls=%v", fr.calls)
	}
}

// TestRollbackRequiresConfirmation (Task 6): a rollback without confirm is
// rejected with 400.
func TestRollbackRequiresConfirmation(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	_, r := newOpsServer(t, fr)
	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/rollback",
		strings.NewReader(`{"confirm":false}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestRollbackRejectsWhenNoPreviousVersion (Task 6): a rollback with no
// superseded prior version is rejected with 409.
func TestRollbackRejectsWhenNoPreviousVersion(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	ctx := context.Background()
	now := time.Now()
	// Only an effective version, no superseded prior.
	dep := model.Deployment{
		ID: "dep_only", AppID: "app-east-sea-situation", ContainerName: "sf-only",
		HostPort: 18000, ContainerPort: 80, URL: "http://127.0.0.1:18000",
		Status: "running", CreatedAt: now, StartedAt: &now,
	}
	if err := srv.store.CreateDeployment(ctx, dep); err != nil {
		t.Fatalf("seed dep: %v", err)
	}
	promoted := now
	if _, err := srv.store.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_only", ApplicationID: "app-east-sea-situation", JobID: "job_only",
		Status: model.ApplicationVersionEffective, DeploymentID: dep.ID, CreatedAt: now, PromotedAt: &promoted,
	}); err != nil {
		t.Fatalf("seed version: %v", err)
	}
	body := strings.NewReader(`{"confirm":true}`)
	req := httptest.NewRequest(http.MethodPost, "/api/apps/app-east-sea-situation/rollback", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
}

// errHealthFailed is the canned error returned by the failing-health-check
// variant of the test server.
var errHealthFailed = deployErr("health_check_failed: forced")

type deployErr string

func (e deployErr) Error() string { return string(e) }

// itoaStr mirrors strconv.Itoa but keeps this test file import-light.
func itoaStr(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
