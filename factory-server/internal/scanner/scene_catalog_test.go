package scanner

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
)

// writeCatalog writes raw bytes to .factory/scene-catalog.json under root.
func writeCatalog(t *testing.T, root, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, ".factory"), 0o755); err != nil {
		t.Fatalf("mkdir .factory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".factory", "scene-catalog.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
}

func writeSceneManifest(t *testing.T, root, slug string) {
	t.Helper()
	dir := filepath.Join(root, "scene", slug, ".factory")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir scene manifest dir: %v", err)
	}
	raw := `{
  "schemaVersion": 1,
  "slug": "` + slug + `",
  "name": "` + slug + `",
  "type": "command_dashboard",
  "source": "preset",
  "description": "` + slug + `",
  "entry": "static-vite",
  "path": "scene/` + slug + `",
  "build": { "command": "npm run build", "outputDir": "dist" },
  "runtime": { "devCommand": "npm run dev", "defaultPort": 5173 }
}`
	if err := os.WriteFile(filepath.Join(dir, "app.json"), []byte(raw), 0o644); err != nil {
		t.Fatalf("write scene manifest: %v", err)
	}
}

func writeCanonicalSceneManifests(t *testing.T, root string) {
	t.Helper()
	for slug := range canonicalKnownSlugs() {
		writeSceneManifest(t, root, slug)
	}
}

// canonicalKnownSlugs is the 8 preset slugs that the real workspace ships.
func canonicalKnownSlugs() map[string]bool {
	return map[string]bool{
		"carrier-formation-replay":              true,
		"aircraft-carrier-track":                true,
		"east-sea-situation":                    true,
		"carrier-homeport-tide-window":          true,
		"carrier-deck-wind-calculator":          true,
		"merchant-density-grid-alert":           true,
		"social-sighting-cluster-alert":         true,
		"carrier-air-wing-affiliation-inference": true,
	}
}

const canonicalCatalog = `{
  "version": 1,
  "scenes": {
    "carrier-formation-replay": { "surface": "application", "order": 1 },
    "aircraft-carrier-track": { "surface": "application", "order": 2 },
    "east-sea-situation": { "surface": "application", "order": 3 },
    "carrier-homeport-tide-window": { "surface": "blueprint" },
    "carrier-deck-wind-calculator": { "surface": "blueprint" },
    "merchant-density-grid-alert": { "surface": "blueprint" },
    "social-sighting-cluster-alert": { "surface": "blueprint" },
    "carrier-air-wing-affiliation-inference": { "surface": "blueprint" }
  }
}`

func TestLoadSceneCatalogCanonical(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, canonicalCatalog)

	cat, err := LoadSceneCatalog(root, canonicalKnownSlugs())
	if err != nil {
		t.Fatalf("LoadSceneCatalog: %v", err)
	}

	apps := cat.VisibleApplications()
	if len(apps) != 3 {
		t.Fatalf("VisibleApplications = %d, want 3: %+v", len(apps), apps)
	}
	// VisibleApplications must be ordered by catalog order.
	want := []string{"carrier-formation-replay", "aircraft-carrier-track", "east-sea-situation"}
	got := make([]string, 0, len(apps))
	for _, e := range apps {
		got = append(got, e.Slug)
	}
	for i, w := range want {
		if i >= len(got) || got[i] != w {
			t.Fatalf("VisibleApplications[%d] = %v, want %v", i, got, want)
		}
	}
}

func TestLoadSceneCatalogSurfaceAndOrderHelpers(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, canonicalCatalog)

	cat, err := LoadSceneCatalog(root, canonicalKnownSlugs())
	if err != nil {
		t.Fatalf("LoadSceneCatalog: %v", err)
	}

	if got := cat.SurfaceFor("carrier-formation-replay"); got != SurfaceApplication {
		t.Fatalf("SurfaceFor application slug = %q, want %q", got, SurfaceApplication)
	}
	if got := cat.SurfaceFor("carrier-homeport-tide-window"); got != SurfaceBlueprint {
		t.Fatalf("SurfaceFor blueprint slug = %q, want %q", got, SurfaceBlueprint)
	}
	// A slug absent from the catalog defaults to hidden (fail-closed).
	if got := cat.SurfaceFor("not-in-catalog-at-all"); got != SurfaceHidden {
		t.Fatalf("SurfaceFor absent slug = %q, want %q", got, SurfaceHidden)
	}
	if got := cat.ApplicationOrder("carrier-formation-replay"); got != 1 {
		t.Fatalf("ApplicationOrder = %d, want 1", got)
	}
	if got := cat.ApplicationOrder("east-sea-situation"); got != 3 {
		t.Fatalf("ApplicationOrder = %d, want 3", got)
	}
	if got := cat.ApplicationOrder("carrier-homeport-tide-window"); got != 0 {
		t.Fatalf("ApplicationOrder for non-application = %d, want 0", got)
	}
	if !cat.IsBlueprint("carrier-deck-wind-calculator") {
		t.Fatalf("IsBlueprint(carrier-deck-wind-calculator) = false, want true")
	}
	if cat.IsBlueprint("east-sea-situation") {
		t.Fatalf("IsBlueprint(east-sea-situation) = true, want false")
	}
}

func TestLoadSceneCatalogMissingFileErrors(t *testing.T) {
	root := t.TempDir()
	if _, err := LoadSceneCatalog(root, canonicalKnownSlugs()); err == nil {
		t.Fatal("expected error for missing catalog, got nil")
	}
}

func TestLoadSceneCatalogMalformedJSONErrors(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, `{not valid json`)
	if _, err := LoadSceneCatalog(root, canonicalKnownSlugs()); err == nil {
		t.Fatal("expected error for malformed JSON, got nil")
	}
}

func TestLoadSceneCatalogInvalidSurfaceErrors(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, `{
  "version": 1,
  "scenes": {
    "east-sea-situation": { "surface": "bogus-surface" }
  }
}`)
	if _, err := LoadSceneCatalog(root, canonicalKnownSlugs()); err == nil {
		t.Fatal("expected error for invalid surface, got nil")
	}
}

func TestLoadSceneCatalogUnknownSlugErrors(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, `{
  "version": 1,
  "scenes": {
    "this-slug-does-not-exist": { "surface": "blueprint" }
  }
}`)
	if _, err := LoadSceneCatalog(root, canonicalKnownSlugs()); err == nil {
		t.Fatal("expected error for unknown slug, got nil")
	}
}

func TestLoadSceneCatalogApplicationMissingOrderErrors(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, `{
  "version": 1,
  "scenes": {
    "east-sea-situation": { "surface": "application" }
  }
}`)
	if _, err := LoadSceneCatalog(root, canonicalKnownSlugs()); err == nil {
		t.Fatal("expected error for application without order, got nil")
	}
}

func TestLoadSceneCatalogUnknownVersionErrors(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, `{
  "version": 99,
  "scenes": {
    "east-sea-situation": { "surface": "application", "order": 1 }
  }
}`)
	if _, err := LoadSceneCatalog(root, canonicalKnownSlugs()); err == nil {
		t.Fatal("expected error for unknown schema version, got nil")
	}
}

func TestLoadSceneCatalogDuplicateOrderErrors(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, `{
  "version": 1,
  "scenes": {
    "east-sea-situation": { "surface": "application", "order": 1 },
    "aircraft-carrier-track": { "surface": "application", "order": 1 }
  }
}`)
	if _, err := LoadSceneCatalog(root, canonicalKnownSlugs()); err == nil {
		t.Fatal("expected error for duplicate application order, got nil")
	}
}

func TestSceneCatalogBlueprintSlugsSorted(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, canonicalCatalog)

	cat, err := LoadSceneCatalog(root, canonicalKnownSlugs())
	if err != nil {
		t.Fatalf("LoadSceneCatalog: %v", err)
	}
	bps := cat.BlueprintSlugs()
	if len(bps) != 5 {
		t.Fatalf("BlueprintSlugs = %d, want 5: %+v", len(bps), bps)
	}
	// Deterministic order (sorted by slug) for stable downstream consumers.
	sortedCopy := append([]string(nil), bps...)
	sort.Strings(sortedCopy)
	for i := range bps {
		if bps[i] != sortedCopy[i] {
			t.Fatalf("BlueprintSlugs not sorted: %+v", bps)
		}
	}
}

// TestLoadSceneCatalogForSurfaceIgnoresPresetMembership is the regression for the
// fresh-database 500: the runtime loaders (GET /api/apps filter + dialogue
// candidate building) must NOT require blueprint-surface catalog keys to be in
// the store, because the scanner drops blueprints from the store. The scan-time
// LoadSceneCatalog still enforces disk membership; the runtime loader only
// structurally validates.
func TestLoadSceneCatalogForSurfaceIgnoresPresetMembership(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, canonicalCatalog)
	writeCanonicalSceneManifests(t, root)

	// Runtime must succeed without consulting the application store and still
	// validate membership against the scene manifests on disk. This is exactly the
	// runtime condition: store has only application-surface presets, while the
	// blueprint-surface presets exist on disk but are not stored as app rows.
	cat, err := LoadSceneCatalogForSurface(root)
	if err != nil {
		t.Fatalf("LoadSceneCatalogForSurface with no preset context: %v", err)
	}
	bps := cat.BlueprintSlugs()
	if len(bps) != 5 {
		t.Fatalf("BlueprintSlugs = %d, want 5 (blueprints must resolve without store membership): %+v", len(bps), bps)
	}
	apps := cat.VisibleApplications()
	if len(apps) != 3 {
		t.Fatalf("VisibleApplications = %d, want 3: %+v", len(apps), apps)
	}
	// The scan-time loader still rejects an unknown key (membership invariant
	// preserved for the scanner, which has the full on-disk preset set).
	if _, err := LoadSceneCatalog(root, map[string]bool{}); err == nil {
		t.Fatal("LoadSceneCatalog must still reject catalog keys not in the known preset set")
	}
}

func TestLoadSceneCatalogForSurfaceRejectsCatalogSlugMissingOnDisk(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, `{"version":1,"scenes":{"ghost-blueprint":{"surface":"blueprint"}}}`)

	if _, err := LoadSceneCatalogForSurface(root); err == nil {
		t.Fatal("expected runtime catalog loader to reject a slug with no scene manifest on disk")
	}
}

// TestLoadSceneCatalogForSurfaceStructuralFailClosed ensures the runtime loader
// keeps the structural fail-closed guarantees (the security property that a
// malformed/missing catalog errors rather than silently returning a permissive
// list) even though it no longer checks disk membership.
func TestLoadSceneCatalogForSurfaceStructuralFailClosed(t *testing.T) {
	t.Run("missing file errors", func(t *testing.T) {
		if _, err := LoadSceneCatalogForSurface(t.TempDir()); err == nil {
			t.Fatal("expected error for missing catalog file")
		}
	})
	t.Run("invalid surface errors", func(t *testing.T) {
		root := t.TempDir()
		writeCatalog(t, root, `{"version":1,"scenes":{"east-sea-situation":{"surface":"nope","order":1}}}`)
		if _, err := LoadSceneCatalogForSurface(root); err == nil {
			t.Fatal("expected error for invalid surface")
		}
	})
	t.Run("duplicate order errors", func(t *testing.T) {
		root := t.TempDir()
		writeCatalog(t, root, `{"version":1,"scenes":{"east-sea-situation":{"surface":"application","order":1},"aircraft-carrier-track":{"surface":"application","order":1}}}`)
		if _, err := LoadSceneCatalogForSurface(root); err == nil {
			t.Fatal("expected error for duplicate application order")
		}
	})
}

// TestCarrierAirWingIsBlueprintNotApplication pins the new scene's surface: it
// is a catalog blueprint (a generation seed), never an app-list entry.
func TestCarrierAirWingIsBlueprintNotApplication(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, canonicalCatalog)

	cat, err := LoadSceneCatalog(root, canonicalKnownSlugs())
	if err != nil {
		t.Fatalf("LoadSceneCatalog: %v", err)
	}
	if !cat.IsBlueprint("carrier-air-wing-affiliation-inference") {
		t.Fatalf("IsBlueprint(carrier-air-wing-affiliation-inference) = false, want true")
	}
	for _, app := range cat.VisibleApplications() {
		if app.Slug == "carrier-air-wing-affiliation-inference" {
			t.Fatalf("carrier-air-wing-affiliation-inference must not appear in VisibleApplications, got %+v", app)
		}
	}
}

// TestRealRepoSceneCatalogLoads is the regression for the GET /api/apps startup
// 500 {"error":"load scene catalog"}. It runs the EXACT runtime loader
// (LoadSceneCatalogForSurface — the function app_handlers.go calls) against the
// REAL workspace. The unit tests above use synthetic temp dirs in which a scene
// manifest's slug always equals its directory name, so they cannot detect a real
// manifest whose declared slug drifts from its catalog key. That is what happened
// with carrier-homeport-tide-window: its manifest slug was
// "carrier-homeport-tide-window-preset" while the catalog key and directory were
// "carrier-homeport-tide-window", so discoverPresetSceneSlugs never registered
// the key LoadSceneCatalog then fail-closed on — 500ing every catalog-dependent
// endpoint. Only a real-repo load can catch this class of drift.
func TestRealRepoSceneCatalogLoads(t *testing.T) {
	root := findRepoRoot(t)
	cat, err := LoadSceneCatalogForSurface(root)
	if err != nil {
		t.Fatalf("LoadSceneCatalogForSurface against real repo root %s: %v", root, err)
	}
	if len(cat.VisibleApplications()) == 0 {
		t.Fatalf("real repo catalog resolved no visible applications at %s", root)
	}
}

// findRepoRoot walks up from this test file to the workspace root: the nearest
// ancestor directory containing .factory/scene-catalog.json. This keeps the
// real-repo regression independent of the package's install path.
func findRepoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) failed")
	}
	dir := filepath.Dir(file)
	for {
		if _, err := os.Stat(filepath.Join(dir, ".factory", "scene-catalog.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not locate repo root (.factory/scene-catalog.json) above the scanner test")
		}
		dir = parent
	}
}
