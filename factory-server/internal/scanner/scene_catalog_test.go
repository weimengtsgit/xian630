package scanner

import (
	"os"
	"path/filepath"
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

// canonicalKnownSlugs is the 7 preset slugs that the real workspace ships.
func canonicalKnownSlugs() map[string]bool {
	return map[string]bool{
		"carrier-formation-replay":      true,
		"aircraft-carrier-track":        true,
		"east-sea-situation":            true,
		"carrier-homeport-tide-window":  true,
		"carrier-deck-wind-calculator":  true,
		"merchant-density-grid-alert":   true,
		"social-sighting-cluster-alert": true,
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
    "social-sighting-cluster-alert": { "surface": "blueprint" }
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
	if len(bps) != 4 {
		t.Fatalf("BlueprintSlugs = %d, want 4: %+v", len(bps), bps)
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
