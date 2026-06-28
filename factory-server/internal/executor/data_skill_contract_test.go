package executor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRealDataSkillFetchAdaptersDocumentFastTimeout(t *testing.T) {
	root := findRepoRootForSkillContract(t)
	for _, rel := range []string{
		"tide-data-skill/SKILL.md",
		"deck-wind-data-skill/SKILL.md",
	} {
		path := filepath.Join(root, ".claude", "skills", rel)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		body := string(raw)
		for _, want := range []string{"AbortController", "timeoutMs", "clearTimeout"} {
			if !strings.Contains(body, want) {
				t.Fatalf("%s missing %q in fetch adapter example", rel, want)
			}
		}
	}
}

func findRepoRootForSkillContract(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, ".claude", "skills")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("repo root with .claude/skills not found from %s", dir)
		}
		dir = parent
	}
}
