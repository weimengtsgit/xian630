package scanner

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// Surface is the runtime assignment for a preset scene: whether it shows as an
// application, is an internal blueprint reference, or is hidden.
type Surface string

const (
	// SurfaceApplication: the preset is listed in the app list and is a routing
	// candidate. Must carry a unique order.
	SurfaceApplication Surface = "application"
	// SurfaceBlueprint: the preset is an internal reference (blueprint catalog)
	// and must never be returned by GET /api/apps.
	SurfaceBlueprint Surface = "blueprint"
	// SurfaceHidden: the preset exists on disk but is excluded from both the app
	// list and the blueprint catalog.
	SurfaceHidden Surface = "hidden"
)

// catalogVersion is the single supported scene-catalog.json schema version.
const catalogVersion = 1

// catalogEntry is one row of the on-disk .factory/scene-catalog.json scenes map.
type catalogEntry struct {
	Surface Surface `json:"surface"`
	// Order is required iff Surface == SurfaceApplication. Zero otherwise.
	Order int `json:"order,omitempty"`
}

type catalogFile struct {
	Version int                     `json:"version"`
	Scenes  map[string]catalogEntry `json:"scenes"`
}

// SceneCatalog is the validated, in-memory view of .factory/scene-catalog.json.
// It is the single runtime source for which preset scenes are visible
// applications, which are internal blueprints, and in what order application
// surfaces appear. Generated apps are never part of the catalog.
type SceneCatalog struct {
	entries map[string]catalogEntry
}

// LoadSceneCatalog reads and validates .factory/scene-catalog.json under root AND
// enforces that every catalog key is a discovered preset slug. knownPresetSlugs
// is the discovered set of preset scene slugs (collected from
// scene/*/.factory/app.json manifests); every catalog key must appear in it.
//
// This is the SCAN-TIME loader: the scanner has the full preset set on disk
// (application + blueprint + hidden surfaces) so it can fail-closed against a
// catalog that references a scene dir that does not exist.
//
// Fail-closed: a missing file, malformed JSON, an unsupported version, an
// invalid surface, an application entry without an order, a duplicate
// application order, or a catalog key that is not a discovered preset slug all
// produce an error rather than a permissive empty catalog.
func LoadSceneCatalog(root string, knownPresetSlugs map[string]bool) (SceneCatalog, error) {
	cat, err := loadSceneCatalogFile(root)
	if err != nil {
		return cat, err
	}
	for slug := range cat.entries {
		if !knownPresetSlugs[slug] {
			return SceneCatalog{}, fmt.Errorf("load scene catalog: scene %q is not a discovered preset slug", slug)
		}
	}
	return cat, nil
}

// LoadSceneCatalogForSurface reads + structurally validates
// .factory/scene-catalog.json WITHOUT requiring every catalog key to be a
// discovered preset slug. It is the RUNTIME loader for GET /api/apps filtering
// and dialogue candidate building, where the catalog has already been
// disk-validated at scan time and the application store does NOT carry the
// blueprint-surface presets (the scanner drops them). Requiring the full preset
// set there would 500 every fresh-database GET /api/apps and starve dialogue
// routing of blueprint candidates.
//
// Fail-closed is preserved for the structural invariants only: a missing file,
// malformed JSON, an unsupported version, an invalid surface, and a missing or
// duplicate application order still error.
func LoadSceneCatalogForSurface(root string) (SceneCatalog, error) {
	return loadSceneCatalogFile(root)
}

// loadSceneCatalogFile reads + structurally validates the catalog file. It does
// NOT check disk-membership of catalog keys; that check is LoadSceneCatalog's
// scan-time responsibility (it has the on-disk preset set; runtime callers do
// not).
func loadSceneCatalogFile(root string) (SceneCatalog, error) {
	path := filepath.Join(root, ".factory", "scene-catalog.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return SceneCatalog{}, fmt.Errorf("load scene catalog: read %s: %w", path, err)
	}

	var cf catalogFile
	if err := json.Unmarshal(raw, &cf); err != nil {
		return SceneCatalog{}, fmt.Errorf("load scene catalog: parse %s: %w", path, err)
	}
	if cf.Version != catalogVersion {
		return SceneCatalog{}, fmt.Errorf("load scene catalog: unsupported version %d (want %d)", cf.Version, catalogVersion)
	}
	if cf.Scenes == nil {
		return SceneCatalog{}, fmt.Errorf("load scene catalog: missing scenes map")
	}

	seenOrder := make(map[int]string) // order -> first slug claiming it
	cat := SceneCatalog{entries: make(map[string]catalogEntry, len(cf.Scenes))}
	for slug, entry := range cf.Scenes {
		// Validate surface value.
		switch entry.Surface {
		case SurfaceApplication, SurfaceBlueprint, SurfaceHidden:
		default:
			return SceneCatalog{}, fmt.Errorf("load scene catalog: scene %q has invalid surface %q (want application|blueprint|hidden)", slug, entry.Surface)
		}
		// Application surfaces require a positive, unique order.
		if entry.Surface == SurfaceApplication {
			if entry.Order <= 0 {
				return SceneCatalog{}, fmt.Errorf("load scene catalog: scene %q is an application surface but has no valid order (%d)", slug, entry.Order)
			}
			if first, dup := seenOrder[entry.Order]; dup {
				return SceneCatalog{}, fmt.Errorf("load scene catalog: duplicate application order %d (scenes %q and %q)", entry.Order, first, slug)
			}
			seenOrder[entry.Order] = slug
		}
		cat.entries[slug] = entry
	}

	return cat, nil
}

// VisibleApplications returns the application-surface presets, ordered by their
// catalog order ascending. It is the source of GET /api/apps preset membership.
func (c SceneCatalog) VisibleApplications() []VisibleApplication {
	type pair struct {
		slug  string
		order int
	}
	pairs := make([]pair, 0, len(c.entries))
	for slug, e := range c.entries {
		if e.Surface == SurfaceApplication {
			pairs = append(pairs, pair{slug: slug, order: e.Order})
		}
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].order < pairs[j].order })
	out := make([]VisibleApplication, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, VisibleApplication{Slug: p.slug, Order: p.order})
	}
	return out
}

// VisibleApplication is one application-surface preset and its display order.
type VisibleApplication struct {
	Slug  string
	Order int
}

// ApplicationOrder returns the catalog display order for an application-surface
// slug, or 0 if the slug is not an application surface.
func (c SceneCatalog) ApplicationOrder(slug string) int {
	e, ok := c.entries[slug]
	if !ok || e.Surface != SurfaceApplication {
		return 0
	}
	return e.Order
}

// SurfaceFor returns the catalog surface for a slug. A slug absent from the
// catalog defaults to SurfaceHidden (fail-closed: unlisted presets never show).
func (c SceneCatalog) SurfaceFor(slug string) Surface {
	e, ok := c.entries[slug]
	if !ok {
		return SurfaceHidden
	}
	return e.Surface
}

// IsBlueprint reports whether the slug is an internal blueprint surface.
func (c SceneCatalog) IsBlueprint(slug string) bool {
	e, ok := c.entries[slug]
	return ok && e.Surface == SurfaceBlueprint
}

// BlueprintSlugs returns all blueprint-surface slugs, sorted by slug for
// deterministic downstream consumption (e.g. the requirement-clarification
// blueprint catalog).
func (c SceneCatalog) BlueprintSlugs() []string {
	out := make([]string, 0)
	for slug, e := range c.entries {
		if e.Surface == SurfaceBlueprint {
			out = append(out, slug)
		}
	}
	sort.Strings(out)
	return out
}

// IsVisibleApplication reports whether the slug is an application surface.
func (c SceneCatalog) IsVisibleApplication(slug string) bool {
	e, ok := c.entries[slug]
	return ok && e.Surface == SurfaceApplication
}
