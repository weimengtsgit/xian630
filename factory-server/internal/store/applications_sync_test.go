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
