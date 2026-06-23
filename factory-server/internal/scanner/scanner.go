package scanner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/catalog"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// Scanner walks a workspace root for `.factory/app.json` manifests and converts
// them into model.Application rows.
type Scanner struct {
	Root string
}

// manifestGlobs are the directories scanned for application manifests.
var manifestGlobs = []string{
	"scene/*/.factory/app.json",
	"generated-apps/*/.factory/app.json",
}

// Scan reads every manifest under Root's scene/ and generated-apps/ trees,
// validates each, and returns the resulting applications. It returns an error
// (rather than silently dropping) if any manifest fails to parse or validate,
// or if two manifests declare the same slug. The returned application IDs are
// deterministic ("app-<slug>") so re-scans upsert instead of duplicating.
func (s Scanner) Scan(ctx context.Context) ([]model.Application, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	apps := make([]model.Application, 0)

	cfg := catalog.Load(s.Root)

	for _, pattern := range manifestGlobs {
		matches, err := filepath.Glob(filepath.Join(s.Root, pattern))
		if err != nil {
			return nil, fmt.Errorf("scan glob %s: %w", pattern, err)
		}

		for _, abs := range matches {
			if err := ctx.Err(); err != nil {
				return nil, err
			}

			rel, err := filepath.Rel(s.Root, abs)
			if err != nil {
				return nil, fmt.Errorf("scan rel %s: %w", abs, err)
			}
			relPath := filepath.ToSlash(rel)

			raw, err := os.ReadFile(abs)
			if err != nil {
				return nil, fmt.Errorf("read manifest %s: %w", relPath, err)
			}

			m, err := ParseManifest(raw)
			if err != nil {
				return nil, fmt.Errorf("manifest %s: %w", relPath, err)
			}

			if err := ValidateManifest(relPath, m); err != nil {
				return nil, err
			}

			if seen[m.Slug] {
				return nil, fmt.Errorf("duplicate slug %q (from manifest %s)", m.Slug, relPath)
			}
			seen[m.Slug] = true

			if !catalog.AppEnabled(cfg, m.Slug) {
				continue
			}

			apps = append(apps, manifestToApp(m, relPath))
		}
	}

	// Keep output stable and deterministic for callers / tests.
	sortAppsBySlug(apps)
	return apps, nil
}

// manifestToApp converts a validated manifest into a model.Application. The ID
// is derived deterministically from the slug so that repeated scans upsert the
// same row instead of creating duplicates.
func manifestToApp(m Manifest, manifestPath string) model.Application {
	now := time.Now()
	return model.Application{
		ID:           appID(m.Slug),
		Slug:         m.Slug,
		Name:         m.Name,
		Type:         m.Type,
		Source:       model.AppSource(m.Source),
		Description:  m.Description,
		Path:         m.Path,
		ManifestPath: manifestPath,
		Status:       model.AppStatusStopped,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

// appID returns the deterministic row id for a given slug.
func appID(slug string) string {
	return "app-" + slug
}

// sortAppsBySlug orders apps alphabetically by slug for stable output. Uses a
// simple insertion sort to avoid importing sort just for a tiny slice; the scan
// is a startup-time operation over tens of apps at most.
func sortAppsBySlug(apps []model.Application) {
	for i := 1; i < len(apps); i++ {
		for j := i; j > 0 && strings.Compare(apps[j-1].Slug, apps[j].Slug) > 0; j-- {
			apps[j-1], apps[j] = apps[j], apps[j-1]
		}
	}
}
