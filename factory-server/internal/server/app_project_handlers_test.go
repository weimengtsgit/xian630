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

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

func newProjectTestServer(t *testing.T) (*Router, *store.Store, string, model.Application) {
	t.Helper()
	root := t.TempDir()
	appDir := filepath.Join(root, "generated-apps", "demo")
	mustWrite(t, filepath.Join(appDir, "docs", "overview.md"), "# Overview\nHello")
	mustWrite(t, filepath.Join(appDir, "src", "App.jsx"), "export default function App() { return <div/> }\n")
	mustWrite(t, filepath.Join(appDir, "tests", "app.test.js"), "test('ok', () => {})\n")
	mustWrite(t, filepath.Join(appDir, "package.json"), `{"scripts":{"build":"vite build"}}`)
	mustWrite(t, filepath.Join(appDir, "vite.config.js"), "export default {}\n")
	mustWrite(t, filepath.Join(appDir, "index.html"), "<div id=\"root\"></div>\n")
	mustWrite(t, filepath.Join(appDir, "Dockerfile"), "FROM nginx\n")
	mustWrite(t, filepath.Join(appDir, "nginx.conf"), "server {}\n")
	mustWrite(t, filepath.Join(appDir, ".factory", "app.json"), `{"id":"app_demo"}`)
	mustWrite(t, filepath.Join(appDir, ".factory", "project-docs.json"), `{"documents":[]}`)
	mustWrite(t, filepath.Join(appDir, "dist", "bundle.js"), "hidden")
	mustWrite(t, filepath.Join(appDir, "node_modules", "pkg", "index.js"), "hidden")
	mustWrite(t, filepath.Join(appDir, ".factory-runs", "run", "output.json"), "hidden")
	mustWrite(t, filepath.Join(appDir, "output.json"), "hidden")
	mustWriteBytes(t, filepath.Join(appDir, "src", "logo.png"), []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	mustWrite(t, filepath.Join(appDir, "src", "large.txt"), string(make([]byte, projectPreviewLimitBytes+1)))

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	app := model.Application{ID: "app_demo", Slug: "demo", Name: "Demo", Source: model.AppSourceGenerated, Path: "generated-apps/demo", ManifestPath: "generated-apps/demo/.factory/app.json", Status: model.AppStatusStopped}
	if err := st.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("upsert app: %v", err)
	}
	preset := model.Application{ID: "app_preset", Slug: "preset", Name: "Preset", Source: model.AppSourcePreset, Path: "scene/preset", Status: model.AppStatusStopped}
	if err := st.UpsertApplication(context.Background(), preset); err != nil {
		t.Fatalf("upsert preset: %v", err)
	}
	srv := New(config.Config{WorkspaceRoot: root}, st, scanner.Scanner{})
	return srv.routes(), st, root, app
}

func TestApplicationProjectTreeReturnsGroupsAndHidesDeniedPaths(t *testing.T) {
	r, _, _, _ := newProjectTestServer(t)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-tree", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got appProjectTreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Groups) != 4 || got.Groups[0].ID != "docs" || !got.Groups[0].DefaultExpanded || got.Groups[3].DefaultExpanded {
		t.Fatalf("groups = %#v", got.Groups)
	}
	body := rec.Body.String()
	for _, hidden := range []string{"dist", "node_modules", ".factory-runs", "output.json"} {
		if contains := jsonContains(body, hidden); contains {
			t.Fatalf("tree leaked denied path %q: %s", hidden, body)
		}
	}
}

func TestApplicationProjectFileRejectsUnsafePaths(t *testing.T) {
	r, _, root, _ := newProjectTestServer(t)
	_ = os.WriteFile(filepath.Join(root, "generated-apps", "secret.txt"), []byte("secret"), 0o644)
	_ = os.Symlink(filepath.Join(root, "generated-apps", "secret.txt"), filepath.Join(root, "generated-apps", "demo", "src", "leak.txt"))
	for _, path := range []string{"", "../secret.txt", "/etc/passwd", "output.json", "src/leak.txt"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-file?path="+path, nil)
		r.ServeHTTP(rec, req)
		if rec.Code < 400 {
			t.Fatalf("path %q status=%d want error body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestApplicationProjectFilePreviewsTextJsonBinaryAndLarge(t *testing.T) {
	r, _, _, _ := newProjectTestServer(t)
	cases := []struct{ path, kind string }{
		{"docs/overview.md", "markdown"},
		{"package.json", "json"},
		{"src/App.jsx", "text"},
		{"src/logo.png", "binary"},
		{"src/large.txt", "large"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/apps/app_demo/project-file?path="+tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", tc.path, rec.Code, rec.Body.String())
		}
		var got appProjectFileResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("decode %s: %v", tc.path, err)
		}
		if got.Kind != tc.kind {
			t.Fatalf("%s kind=%q want %q", tc.path, got.Kind, tc.kind)
		}
		if tc.kind == "json" && got.Formatted == "" {
			t.Fatalf("json formatted empty: %#v", got)
		}
		if (tc.kind == "binary" || tc.kind == "large") && got.Content != "" {
			t.Fatalf("%s returned content for %s", tc.path, tc.kind)
		}
	}
}

func TestApplicationProjectRejectsPresetAndMissingApps(t *testing.T) {
	r, _, _, _ := newProjectTestServer(t)
	for _, target := range []struct {
		path string
		code int
	}{{"/api/apps/app_preset/project-tree", http.StatusForbidden}, {"/api/apps/missing/project-tree", http.StatusNotFound}} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target.path, nil))
		if rec.Code != target.code {
			t.Fatalf("%s status=%d want %d", target.path, rec.Code, target.code)
		}
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	mustWriteBytes(t, path, []byte(content))
}

func mustWriteBytes(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func jsonContains(body, s string) bool { return strings.Contains(body, s) }
