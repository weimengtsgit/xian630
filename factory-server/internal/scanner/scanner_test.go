package scanner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// writeManifest writes a manifest to relPath under root, creating parent dirs.
func writeManifest(t *testing.T, root, relPath, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", relPath, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", relPath, err)
	}
}

const presetManifest = `{
  "schemaVersion": 1,
  "slug": "east-sea-situation",
  "name": "东海目标态势演示",
  "type": "map-dashboard",
  "source": "preset",
  "description": "demo",
  "entry": "static-vite",
  "path": "scene/east-sea-situation",
  "build": {"command": "npm run build", "outputDir": "dist"},
  "runtime": {"devCommand": "npm run dev", "defaultPort": 5173},
  "docker": {"enabled": true, "dockerfile": "Dockerfile", "context": ".", "runtimePort": 80}
}`

func TestScanFindsPresetManifest(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "scene/east-sea-situation/.factory/app.json", presetManifest)

	s := Scanner{Root: root}
	apps, err := s.Scan(context.Background())
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d: %#v", len(apps), apps)
	}
	got := apps[0]
	if got.Source != model.AppSourcePreset {
		t.Fatalf("source = %q, want preset", got.Source)
	}
	if got.Slug != "east-sea-situation" {
		t.Fatalf("slug = %q", got.Slug)
	}
	if got.Status != model.AppStatusStopped {
		t.Fatalf("status = %q, want stopped", got.Status)
	}
	if got.ManifestPath != "scene/east-sea-situation/.factory/app.json" {
		t.Fatalf("manifest_path = %q", got.ManifestPath)
	}
	if got.Path != "scene/east-sea-situation" {
		t.Fatalf("path = %q", got.Path)
	}
	if got.ID != "app-east-sea-situation" {
		t.Fatalf("id = %q, want app-east-sea-situation", got.ID)
	}
}

func TestScanGeneratedManifest(t *testing.T) {
	root := t.TempDir()
	gen := `{
  "schemaVersion": 1,
  "slug": "my-gen",
  "name": "Generated",
  "type": "demo",
  "source": "generated",
  "entry": "static-vite",
  "path": "generated-apps/my-gen"
}`
	writeManifest(t, root, "generated-apps/my-gen/.factory/app.json", gen)

	s := Scanner{Root: root}
	apps, err := s.Scan(context.Background())
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(apps) != 1 || apps[0].Source != model.AppSourceGenerated {
		t.Fatalf("apps = %#v", apps)
	}
}

func TestScanDuplicateSlugErrors(t *testing.T) {
	root := t.TempDir()
	dup := `{"schemaVersion":1,"slug":"dup","name":"D","source":"preset","entry":"static-vite","path":"scene/dup"}`
	writeManifest(t, root, "scene/dup/.factory/app.json", dup)
	writeManifest(t, root, "generated-apps/dup/.factory/app.json",
		`{"schemaVersion":1,"slug":"dup","name":"D","source":"generated","entry":"static-vite","path":"generated-apps/dup"}`)

	s := Scanner{Root: root}
	if _, err := s.Scan(context.Background()); err == nil {
		t.Fatal("expected duplicate-slug error, got nil")
	}
}

func TestScanInvalidManifestFails(t *testing.T) {
	root := t.TempDir()
	// preset source but path does not start with scene/ — wait, it does. Use a bad schemaVersion.
	bad := `{"schemaVersion":2,"slug":"x","name":"X","source":"preset","entry":"static-vite","path":"scene/x"}`
	writeManifest(t, root, "scene/x/.factory/app.json", bad)

	s := Scanner{Root: root}
	if _, err := s.Scan(context.Background()); err == nil {
		t.Fatal("expected validation error, got nil")
	}
}

func TestScanNoManifests(t *testing.T) {
	root := t.TempDir()
	s := Scanner{Root: root}
	apps, err := s.Scan(context.Background())
	if err != nil {
		t.Fatalf("scan empty: %v", err)
	}
	if len(apps) != 0 {
		t.Fatalf("expected 0 apps, got %d", len(apps))
	}
}

func TestScanRespectsContextCancellation(t *testing.T) {
	root := t.TempDir()
	writeManifest(t, root, "scene/x/.factory/app.json", presetManifest)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	s := Scanner{Root: root}
	if _, err := s.Scan(ctx); err == nil {
		t.Fatal("expected cancelled context to error")
	}
}

func TestScannerHidesDisabledAppsFromUnifiedCatalog(t *testing.T) {
	root := t.TempDir()
	writeManifest := func(rel, source, slug string) {
		t.Helper()
		path := filepath.Join(root, rel, ".factory")
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatalf("mkdir manifest dir: %v", err)
		}
		raw := fmt.Sprintf(`{"schemaVersion":1,"slug":%q,"name":%q,"type":"command_dashboard","source":%q,"entry":"static-vite","path":%q}`, slug, slug, source, rel)
		if err := os.WriteFile(filepath.Join(path, "app.json"), []byte(raw), 0o644); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
	}
	writeManifest("scene/hidden-preset", "preset", "hidden-preset")
	writeManifest("scene/visible-preset", "preset", "visible-preset")
	writeManifest("generated-apps/generated-demo", "generated", "generated-demo")
	if err := os.MkdirAll(filepath.Join(root, ".factory"), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	config := `{"apps":{"hidden-preset":false,"visible-preset":true,"generated-demo":true}}`
	if err := os.WriteFile(filepath.Join(root, ".factory", "catalog.json"), []byte(config), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	apps, err := Scanner{Root: root}.Scan(context.Background())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	slugs := make([]string, 0, len(apps))
	for _, app := range apps {
		slugs = append(slugs, app.Slug)
	}
	if containsString(slugs, "hidden-preset") {
		t.Fatalf("hidden preset was returned: %v", slugs)
	}
	if !containsString(slugs, "visible-preset") || !containsString(slugs, "generated-demo") {
		t.Fatalf("visible apps missing: %v", slugs)
	}
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
