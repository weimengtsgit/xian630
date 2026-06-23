package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// seedApp returns a model.Application matching the canonical preset scene used
// across the factory-server test suite.
func seedApp() model.Application {
	now := time.Now()
	return model.Application{
		ID:           "app-east-sea-situation",
		Slug:         "east-sea-situation",
		Name:         "东海目标态势演示",
		Type:         "map-dashboard",
		Source:       model.AppSourcePreset,
		Description:  "preset scene",
		Path:         "scene/east-sea-situation",
		ManifestPath: "scene/east-sea-situation/.factory/app.json",
		Status:       model.AppStatusStopped,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

// newTestServer builds a Server backed by an in-memory store seeded with one
// preset app, returning the server and its configured router for httptest.
func newTestServer(t *testing.T) (*Server, *Router) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	if err := st.UpsertApplication(context.Background(), seedApp()); err != nil {
		t.Fatalf("seed app: %v", err)
	}

	srv := New(config.Config{}, st, scanner.Scanner{})
	return srv, srv.routes()
}

func TestListApplications(t *testing.T) {
	_, r := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/apps", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var apps []model.Application
	if err := json.NewDecoder(rec.Body).Decode(&apps); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(apps) != 1 || apps[0].Slug != "east-sea-situation" {
		t.Fatalf("apps = %#v", apps)
	}
}

func TestListApplicationsFiltersConfiguredHiddenPresetAlreadyInStore(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	hidden := seedApp()
	hidden.ID = "app-hidden-preset"
	hidden.Slug = "hidden-preset"
	hidden.Name = "Hidden Preset"
	hidden.ManifestPath = "scene/hidden-preset/.factory/app.json"
	hidden.Path = "scene/hidden-preset"
	visible := seedApp()
	visible.ID = "app-visible-preset"
	visible.Slug = "visible-preset"
	visible.Name = "Visible Preset"
	visible.ManifestPath = "scene/visible-preset/.factory/app.json"
	visible.Path = "scene/visible-preset"
	if err := st.UpsertApplication(context.Background(), hidden); err != nil {
		t.Fatalf("seed hidden: %v", err)
	}
	if err := st.UpsertApplication(context.Background(), visible); err != nil {
		t.Fatalf("seed visible: %v", err)
	}

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".factory"), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	rawConfig := `{"presetApps":{"hidden-preset":{"showInAppList":false},"visible-preset":{"showInAppList":true}}}`
	if err := os.WriteFile(filepath.Join(root, ".factory", "preset-apps.json"), []byte(rawConfig), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	srv := New(config.Config{WorkspaceRoot: root}, st, scanner.Scanner{})
	req := httptest.NewRequest(http.MethodGet, "/api/apps", nil)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	var apps []model.Application
	if err := json.NewDecoder(rec.Body).Decode(&apps); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, app := range apps {
		if app.Slug == "hidden-preset" {
			t.Fatalf("hidden preset still listed: %#v", apps)
		}
	}
	if len(apps) != 1 || apps[0].Slug != "visible-preset" {
		t.Fatalf("apps = %#v, want only visible-preset", apps)
	}
}

func TestGetApplication(t *testing.T) {
	_, r := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/apps/app-east-sea-situation", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var app model.Application
	if err := json.NewDecoder(rec.Body).Decode(&app); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if app.Slug != "east-sea-situation" {
		t.Fatalf("slug = %q, want east-sea-situation", app.Slug)
	}
}

func TestGetApplicationNotFound(t *testing.T) {
	_, r := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/apps/missing", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// The start/stop/rebuild handlers used to return 501 stubs; Task 9 replaced
// them with real implementations exercised in app_operations_test.go.
