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

// writeServerCatalog writes the validated scene catalog under a workspace root.
func writeServerCatalog(t *testing.T, root, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, ".factory"), 0o755); err != nil {
		t.Fatalf("mkdir .factory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".factory", "scene-catalog.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
}

// newTestServer builds a Server backed by an in-memory store seeded with one
// preset app, returning the server and its configured router for httptest. The
// workspace root carries a catalog that marks the seed preset as an application
// surface so GET /api/apps is fail-closed-consistent.
func newTestServer(t *testing.T) (*Server, *Router) {
	t.Helper()
	root := t.TempDir()
	writeServerCatalog(t, root, `{"version":1,"scenes":{"east-sea-situation":{"surface":"application","order":1}}}`)

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	if err := st.UpsertApplication(context.Background(), seedApp()); err != nil {
		t.Fatalf("seed app: %v", err)
	}

	srv := New(config.Config{WorkspaceRoot: root}, st, scanner.Scanner{})
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

// TestListApplicationsFiltersBlueprintPresetAndKeepsGenerated is the catalog-
// driven server integration test: a blueprint/hidden preset is dropped, a
// generated app is returned, and the exact application/blueprint split holds.
func TestListApplicationsFiltersBlueprintPresetAndKeepsGenerated(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	blueprint := seedApp()
	blueprint.ID = "app-blueprint-preset"
	blueprint.Slug = "blueprint-preset"
	blueprint.Name = "Blueprint Preset"
	blueprint.ManifestPath = "scene/blueprint-preset/.factory/app.json"
	blueprint.Path = "scene/blueprint-preset"
	visible := seedApp()
	visible.ID = "app-visible-preset"
	visible.Slug = "visible-preset"
	visible.Name = "Visible Preset"
	visible.ManifestPath = "scene/visible-preset/.factory/app.json"
	visible.Path = "scene/visible-preset"
	visible.DisplayOrder = 1
	gen := seedApp()
	gen.ID = "app-generated-demo"
	gen.Slug = "generated-demo"
	gen.Name = "Generated Demo"
	gen.Source = model.AppSourceGenerated
	gen.ManifestPath = "generated-apps/generated-demo/.factory/app.json"
	gen.Path = "generated-apps/generated-demo"
	for _, a := range []model.Application{blueprint, visible, gen} {
		if err := st.UpsertApplication(context.Background(), a); err != nil {
			t.Fatalf("seed %s: %v", a.Slug, err)
		}
	}

	root := t.TempDir()
	writeServerCatalog(t, root, `{
  "version": 1,
  "scenes": {
    "blueprint-preset": { "surface": "blueprint" },
    "visible-preset": { "surface": "application", "order": 1 }
  }
}`)

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
	slugs := make([]string, 0, len(apps))
	for _, app := range apps {
		slugs = append(slugs, app.Slug)
		if app.Slug == "blueprint-preset" {
			t.Fatalf("blueprint preset returned: %#v", apps)
		}
	}
	// Generated app visible even though absent from catalog; visible preset kept.
	if !contains(slugs, "visible-preset") || !contains(slugs, "generated-demo") {
		t.Fatalf("apps = %#v, want visible-preset + generated-demo", apps)
	}
	if len(apps) != 2 {
		t.Fatalf("app count = %d, want 2 (visible-preset + generated-demo)", len(apps))
	}
}

// TestListApplicationsFailClosedOnMissingCatalog asserts a missing catalog
// produces an error rather than a permissive full list.
func TestListApplicationsFailClosedOnMissingCatalog(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.UpsertApplication(context.Background(), seedApp()); err != nil {
		t.Fatalf("seed app: %v", err)
	}

	// No .factory/scene-catalog.json under the (temp) root.
	srv := New(config.Config{WorkspaceRoot: t.TempDir()}, st, scanner.Scanner{})
	req := httptest.NewRequest(http.MethodGet, "/api/apps", nil)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (fail-closed)", rec.Code)
	}
}

func contains(items []string, want string) bool {
	for _, s := range items {
		if s == want {
			return true
		}
	}
	return false
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
