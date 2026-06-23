package executor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestSelectedSkillPathsResolution proves selectedSkillPaths resolves a sample
// generationProfile (the one carried by the carrier-formation-replay confirmed
// requirement) to the concrete project-local SKILL.md paths under the repo
// root, in base→domain→pattern order. The brief's verification block asks for
// this exact proof.
func TestSelectedSkillPathsResolution(t *testing.T) {
	ws := repoWorkspace(t)
	profile := map[string][]string{
		"base":    {"software-factory-app"},
		"domain":  {"defense-operations-ui"},
		"pattern": {"map-timeline-replay"},
	}
	got := selectedSkillPaths(ws, profile)
	want := []string{
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "software-factory-app", "SKILL.md")),
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "defense-operations-ui", "SKILL.md")),
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "map-timeline-replay", "SKILL.md")),
	}
	if len(got) != len(want) {
		t.Fatalf("selectedSkillPaths = %v, want %d entries", got, len(want))
	}
	for i, p := range got {
		if p != want[i] {
			t.Errorf("selectedSkillPaths[%d] = %q, want %q", i, p, want[i])
		}
		// Every resolved path must point at a real SKILL.md the agent can Read.
		if _, err := os.Stat(filepath.FromSlash(p)); err != nil {
			t.Errorf("resolved skill path %q does not exist on disk: %v", p, err)
		}
	}
}

// TestSelectedSkillPathsOrderIgnoresUnknownGroups proves only base/domain/pattern
// are read (no accidental inclusion of an arbitrary key) and that empty keys are
// skipped.
func TestSelectedSkillPathsOrderIgnoresUnknownGroups(t *testing.T) {
	profile := map[string][]string{
		"pattern": {"map-timeline-replay"},
		"base":    {"software-factory-app"},
		"extra":   {"should-be-ignored"},
		"domain":  {"defense-operations-ui", ""},
	}
	got := selectedSkillPaths("ws", profile)
	want := []string{
		"ws/.claude/skills/software-factory-app/SKILL.md",
		"ws/.claude/skills/defense-operations-ui/SKILL.md",
		"ws/.claude/skills/map-timeline-replay/SKILL.md",
	}
	if len(got) != len(want) {
		t.Fatalf("selectedSkillPaths = %v, want %v (empty + extra groups filtered)", got, want)
	}
	for i, p := range got {
		if p != want[i] {
			t.Errorf("selectedSkillPaths[%d] = %q, want %q", i, p, want[i])
		}
	}
}

// TestSelectedSkillPathsResolvesDataGroup proves selectedSkillPaths reads the
// `data` group (added so data-acquisition skills can be surfaced to the
// code-generation agent) and orders it after base/domain/pattern. The three
// data skills are real checked-in skills, so the resolved paths must exist.
func TestSelectedSkillPathsResolvesDataGroup(t *testing.T) {
	ws := repoWorkspace(t)
	profile := map[string][]string{
		"base":    {"software-factory-app"},
		"pattern": {"map-timeline-replay"},
		"data":    {"tide-data-skill", "deck-wind-data-skill", "ais-density-data-skill"},
	}
	got := selectedSkillPaths(ws, profile)
	want := []string{
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "software-factory-app", "SKILL.md")),
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "map-timeline-replay", "SKILL.md")),
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "tide-data-skill", "SKILL.md")),
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "deck-wind-data-skill", "SKILL.md")),
		filepath.ToSlash(filepath.Join(ws, ".claude", "skills", "ais-density-data-skill", "SKILL.md")),
	}
	if len(got) != len(want) {
		t.Fatalf("selectedSkillPaths = %v, want %d entries (data group read)", got, len(want))
	}
	for i, p := range got {
		if p != want[i] {
			t.Errorf("selectedSkillPaths[%d] = %q, want %q", i, p, want[i])
		}
		if _, err := os.Stat(filepath.FromSlash(p)); err != nil {
			t.Errorf("resolved skill path %q does not exist on disk: %v", p, err)
		}
	}
}

// TestSelectedSkillPathsDropsUnsafeDataKeys proves defense-in-depth: `data`
// group keys failing SafeName (parent-directory traversal) are dropped, never
// surfaced as paths the agent could Read outside .claude/skills.
func TestSelectedSkillPathsDropsUnsafeDataKeys(t *testing.T) {
	profile := map[string][]string{
		"data": {"tide-data-skill", "..", "../evil"},
	}
	got := selectedSkillPaths("ws", profile)
	want := []string{"ws/.claude/skills/tide-data-skill/SKILL.md"}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("selectedSkillPaths = %v, want only the safe data key resolved: %v", got, want)
	}
}

// TestBlueprintRefPathsResolution proves blueprintRefPaths maps the
// carrier-formation-replay slug to its scene README.md (the scene has no
// scene.md, so the README.md fallback must apply) and that the resolved path is
// real on disk.
func TestBlueprintRefPathsResolution(t *testing.T) {
	ws := repoWorkspace(t)
	got := blueprintRefPaths(ws, []string{"carrier-formation-replay"})
	want := []string{filepath.ToSlash(filepath.Join(ws, "scene", "carrier-formation-replay", "README.md"))}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("blueprintRefPaths = %v, want %v", got, want)
	}
	if _, err := os.Stat(filepath.FromSlash(got[0])); err != nil {
		t.Errorf("resolved blueprint path %q does not exist on disk: %v", got[0], err)
	}
}

// TestBlueprintRefPathsPrefersSceneMD proves scene.md is preferred over README.md
// when both exist.
func TestBlueprintRefPathsPrefersSceneMD(t *testing.T) {
	dir := t.TempDir()
	sceneDir := filepath.Join(dir, "scene", "demo-slug")
	if err := os.MkdirAll(sceneDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sceneDir, "README.md"), []byte("readme"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sceneDir, "scene.md"), []byte("scene"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := blueprintRefPaths(dir, []string{"demo-slug"})
	if len(got) != 1 || got[0] != filepath.ToSlash(filepath.Join(dir, "scene", "demo-slug", "scene.md")) {
		t.Fatalf("blueprintRefPaths = %v, want scene.md", got)
	}
}

// TestParseGenerationProfile proves the confirmed-requirement projection is
// defensive: a well-formed confirmed requirement yields the profile + refs, and
// blank/garbage input yields empty values without error.
func TestParseGenerationProfile(t *testing.T) {
	profile, refs := parseGenerationProfile(json.RawMessage(`{
		"generationProfile":{"base":["software-factory-app"],"pattern":["map-timeline-replay"]},
		"blueprintRefs":["carrier-formation-replay"]
	}`))
	if len(profile) != 2 || len(profile["base"]) != 1 || profile["base"][0] != "software-factory-app" {
		t.Fatalf("profile = %#v", profile)
	}
	if len(refs) != 1 || refs[0] != "carrier-formation-replay" {
		t.Fatalf("refs = %v", refs)
	}

	// Blank and garbage must not panic or return partial junk.
	if p, r := parseGenerationProfile(nil); p != nil || r != nil {
		t.Errorf("nil input: profile=%v refs=%v, want nil/nil", p, r)
	}
	if p, r := parseGenerationProfile(json.RawMessage("not json")); p != nil || r != nil {
		t.Errorf("garbage input: profile=%v refs=%v, want nil/nil", p, r)
	}
}

// repoWorkspace resolves the repo root from the test binary's location so the
// path-resolution proof tests run against the real checked-in skills + scene
// dirs rather than a temp fixture.
func repoWorkspace(t *testing.T) string {
	t.Helper()
	// Test binary lives at <repo>/factory-server/internal/executor/<pkg>.test;
	// walk up four dirs to reach the repo root.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, ".claude", "skills")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Skip("could not locate repo root with .claude/skills from test cwd; skipping path-resolution proof")
	return ""
}
