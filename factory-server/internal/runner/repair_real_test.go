package runner

import (
	"os"
	"path/filepath"
	"testing"
)

// TestReadAndDecodeToleratesObjectShapedUsedSkills is the regression test for
// job_fb9b8586864a6fe52876d4c8, where code_generation failed every retry with
// output_invalid_json. The real cause was NOT malformed JSON: the agent emitted
// usedSkills as an array of objects [{path, purpose}] while the contract struct
// declared UsedSkills []string, so json.Unmarshal failed with a type mismatch
// that ReadAndDecode misreported as output_invalid_json. The decoder must
// normalize object-shaped usedSkills to their path strings (the contract prompt
// asks for paths; the agent sometimes documents purpose too).
func TestReadAndDecodeToleratesObjectShapedUsedSkills(t *testing.T) {
	const doc = `{
  "projectDir": "generated-apps/global-carrier-deck-wind",
  "createdFiles": ["generated-apps/global-carrier-deck-wind/.factory/app.json"],
  "needsUserInput": false,
  "questions": [],
  "usedSkills": [
    {"path": "/repo/.claude/skills/software-factory-app/SKILL.md", "purpose": "base"},
    {"path": "/repo/.claude/skills/deck-wind-data-skill/SKILL.md", "purpose": "data"}
  ],
  "warnings": ["dataPolicy=live_api"],
  "dataPolicy": "live_api"
}`
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	if err := os.WriteFile(p, []byte(doc), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var raw codeGenerationOutput
	if err := ReadAndDecode(p, &raw); err != nil {
		t.Fatalf("ReadAndDecode failed on object-shaped usedSkills: %v", err)
	}
	if len(raw.UsedSkills) != 2 {
		t.Fatalf("UsedSkills len = %d, want 2 (%v)", len(raw.UsedSkills), raw.UsedSkills)
	}
	want0 := "/repo/.claude/skills/software-factory-app/SKILL.md"
	if string(raw.UsedSkills[0]) != want0 {
		t.Fatalf("UsedSkills[0] = %q, want %q", raw.UsedSkills[0], want0)
	}
	if string(raw.UsedSkills[1]) != "/repo/.claude/skills/deck-wind-data-skill/SKILL.md" {
		t.Fatalf("UsedSkills[1] = %q", raw.UsedSkills[1])
	}
}

// TestReadAndDecodeAcceptsStringShapedUsedSkills locks the documented contract
// shape (an array of path strings) so the object-tolerance fix does not regress
// the original behavior.
func TestReadAndDecodeAcceptsStringShapedUsedSkills(t *testing.T) {
	const doc = `{
  "needsUserInput": false,
  "usedSkills": ["/repo/.claude/skills/software-factory-app/SKILL.md"]
}`
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	if err := os.WriteFile(p, []byte(doc), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	var raw codeGenerationOutput
	if err := ReadAndDecode(p, &raw); err != nil {
		t.Fatalf("ReadAndDecode failed on string-shaped usedSkills: %v", err)
	}
	if len(raw.UsedSkills) != 1 || string(raw.UsedSkills[0]) != "/repo/.claude/skills/software-factory-app/SKILL.md" {
		t.Fatalf("UsedSkills = %v", raw.UsedSkills)
	}
}
