package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func appNow(id, slug, manifestPath string, source model.AppSource) model.Application {
	return model.Application{
		ID:           id,
		Slug:         slug,
		Name:         slug,
		Source:       source,
		Path:         manifestPath,
		ManifestPath: manifestPath,
		Status:       model.AppStatusStopped,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
}

func getStatus(t *testing.T, st *Store, id string) model.AppStatus {
	t.Helper()
	apps, err := st.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, a := range apps {
		if a.ID == id {
			return a.Status
		}
	}
	t.Fatalf("app %s not found", id)
	return ""
}

func TestSyncApplicationsMarksMissing(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// One pre-existing preset app whose manifest will NOT be in the scanned set.
	if err := st.UpsertApplication(ctx, appNow("app-gone", "gone",
		"scene/gone/.factory/app.json", model.AppSourcePreset)); err != nil {
		t.Fatalf("seed gone: %v", err)
	}

	// Two scanned apps.
	scanned := []model.Application{
		appNow("app-a", "a", "scene/a/.factory/app.json", model.AppSourcePreset),
		appNow("app-b", "b", "scene/b/.factory/app.json", model.AppSourcePreset),
	}
	if err := st.SyncApplications(ctx, scanned); err != nil {
		t.Fatalf("sync: %v", err)
	}

	if got := getStatus(t, st, "app-a"); got != model.AppStatusStopped {
		t.Fatalf("app-a status = %q, want stopped", got)
	}
	if got := getStatus(t, st, "app-gone"); got != model.AppStatusMissing {
		t.Fatalf("app-gone status = %q, want missing", got)
	}
}

func TestSyncApplicationsEmptyScanDoesNotWipe(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// Pre-existing app that should NOT be touched by an empty scan.
	if err := st.UpsertApplication(ctx, appNow("app-keep", "keep",
		"scene/keep/.factory/app.json", model.AppSourcePreset)); err != nil {
		t.Fatalf("seed keep: %v", err)
	}

	if err := st.SyncApplications(ctx, nil); err != nil {
		t.Fatalf("sync empty: %v", err)
	}

	if got := getStatus(t, st, "app-keep"); got != model.AppStatusStopped {
		t.Fatalf("app-keep status = %q, want stopped (must not be marked missing)", got)
	}
}

func TestSyncApplicationsPreservesRunningRuntime(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	app := appNow("app-running", "running", "scene/running/.factory/app.json", model.AppSourcePreset)
	app.Path = "scene/running"
	if err := st.UpsertApplication(ctx, app); err != nil {
		t.Fatalf("seed running: %v", err)
	}
	if err := st.SetAppRuntime(ctx, app.ID, string(model.AppStatusRunning), "http://127.0.0.1:18080"); err != nil {
		t.Fatalf("set runtime: %v", err)
	}

	scanned := app
	scanned.Name = "running updated"
	scanned.Status = model.AppStatusStopped
	scanned.RuntimeURL = ""
	if err := st.SyncApplications(ctx, []model.Application{scanned}); err != nil {
		t.Fatalf("sync: %v", err)
	}

	got, err := st.GetApplication(ctx, app.ID)
	if err != nil || got == nil {
		t.Fatalf("get app: %#v %v", got, err)
	}
	if got.Name != "running updated" {
		t.Fatalf("name = %q, want scanned metadata refresh", got.Name)
	}
	if got.Status != model.AppStatusRunning {
		t.Fatalf("status = %q, want running preserved", got.Status)
	}
	if got.RuntimeURL != "http://127.0.0.1:18080" {
		t.Fatalf("runtime_url = %q, want preserved", got.RuntimeURL)
	}
}

func TestDeleteApplicationWithDeploymentsRollsBackWhenApplicationDeleteFails(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	app := appNow("app-fail-delete", "fail-delete",
		"generated-apps/fail-delete/.factory/app.json", model.AppSourceGenerated)
	app.Path = "generated-apps/fail-delete"
	if err := st.UpsertApplication(ctx, app); err != nil {
		t.Fatalf("seed app: %v", err)
	}
	dep := model.Deployment{ID: "dep-fail-delete", AppID: app.ID, Status: "running", CreatedAt: time.Now()}
	if err := st.CreateDeployment(ctx, dep); err != nil {
		t.Fatalf("seed deployment: %v", err)
	}
	if _, err := st.db.ExecContext(ctx, `
CREATE TRIGGER fail_app_delete BEFORE DELETE ON applications
WHEN OLD.id = 'app-fail-delete'
BEGIN
  SELECT RAISE(FAIL, 'forced app delete');
END`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	if err := st.DeleteApplicationWithDeployments(ctx, app.ID); err == nil {
		t.Fatal("DeleteApplicationWithDeployments succeeded, want forced failure")
	}
	got, err := st.GetApplication(ctx, app.ID)
	if err != nil || got == nil {
		t.Fatalf("application was not rolled back: got=%#v err=%v", got, err)
	}
	deps, err := st.ListDeploymentsByApp(ctx, app.ID)
	if err != nil {
		t.Fatalf("list deployments: %v", err)
	}
	if len(deps) != 1 || deps[0].ID != dep.ID {
		t.Fatalf("deployments = %#v, want original deployment after rollback", deps)
	}
}
