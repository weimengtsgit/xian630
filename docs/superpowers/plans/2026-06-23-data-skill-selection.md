# Data Skill Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire intent-driven data-skill selection into the generation pipeline so that when a user's request implies a real-data app in a supported domain, the matching data skill (`tide-data-skill` / `deck-wind-data-skill` / `ais-density-data-skill`) is loaded for the code-generation agent.

**Architecture:** Add a `data` group to the confirmed requirement's `generationProfile`, make `selectedSkillPaths` read it (one-line change), and add a domain→data-skill rule to the `requirement-clarification` SKILL.md — gated by the existing `dataPolicy` field — so the clarification model populates that group.

**Tech Stack:** Go (factory-server executor + `testing`), Markdown skill doc.

**Spec:** `docs/superpowers/specs/2026-06-23-data-skill-selection-design.md`

## Global Constraints

- `dataPolicy` reuses existing values only: `live_api` / `mock_then_api` → load matching data skill; `mock_data` → do not. No new `dataPolicy` value is introduced.
- The `data` group is ordered last: `base → domain → pattern → data`.
- No changes to `blueprints.json`, `catalog.json`, the clarification runner prompt, or the data skills themselves.
- Commit on branch `feat-skills-app-template-config`. Each task is one commit. Do not stage `.factory/` (untracked local config).
- All paths are relative to the worktree root: `C:/idea/xian630/.claude/worktrees/feat-skills-app-template-config`.

---

## File Structure

- **Modify** `factory-server/internal/executor/claude_runner.go` — `selectedSkillPaths` (lines 413-444): read a `data` group; update the doc comment.
- **Modify** `factory-server/internal/executor/profile_skills_test.go` — add two tests proving the `data` group resolves and unsafe keys are dropped.
- **Modify** `.claude/skills/requirement-clarification/SKILL.md` — add `"data": []` to the `generationProfile` example and append a *Data Skill Mapping* section.

---

### Task 1: `selectedSkillPaths` reads the `data` group

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go:413-444`
- Test: `factory-server/internal/executor/profile_skills_test.go`

**Interfaces:**
- Consumes: existing `selectedSkillPaths(workspace string, profile map[string][]string) []string` signature, plus existing `SafeName`, `withinRoot` guards.
- Produces: `selectedSkillPaths` now resolves a `data` group (keys → `<workspace>/.claude/skills/<key>/SKILL.md`), ordered after `pattern`. No signature change.

- [ ] **Step 1: Write the failing tests**

Append these two tests to `factory-server/internal/executor/profile_skills_test.go` (after `TestSelectedSkillPathsOrderIgnoresUnknownGroups`, before `TestBlueprintRefPathsResolution`). No new imports needed (`os`, `path/filepath`, `testing` already imported).

```go
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd factory-server && go test ./internal/executor/ -run 'TestSelectedSkillPathsResolvesDataGroup|TestSelectedSkillPathsDropsUnsafeDataKeys' -v`
Expected: FAIL. `TestSelectedSkillPathsResolvesDataGroup` reports `want 5 entries` got 2 (the `data` group keys are currently ignored). `TestSelectedSkillPathsDropsUnsafeDataKeys` reports got 0 (the safe `tide-data-skill` key is also ignored today).

- [ ] **Step 3: Implement — read the `data` group + update the doc comment**

In `factory-server/internal/executor/claude_runner.go`, edit the `selectedSkillPaths` doc comment and the group slice.

Edit the comment block (currently lines 413-416). Replace:

```go
// selectedSkillPaths maps a confirmed requirement's generationProfile
// (base/domain/pattern → skill keys) to the concrete project-local SKILL.md
// file paths under <workspace>/.claude/skills/<key>/SKILL.md. The order is
// base → domain → pattern so downstream prompts list foundational skills first.
```

with:

```go
// selectedSkillPaths maps a confirmed requirement's generationProfile
// (base/domain/pattern/data → skill keys) to the concrete project-local
// SKILL.md file paths under <workspace>/.claude/skills/<key>/SKILL.md. The
// order is base → domain → pattern → data so downstream prompts list
// foundational/UI skills first and data-acquisition skills last.
```

Edit the group slice (currently line 428). Replace:

```go
	for _, group := range []string{"base", "domain", "pattern"} {
```

with:

```go
	for _, group := range []string{"base", "domain", "pattern", "data"} {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd factory-server && go test ./internal/executor/ -run 'TestSelectedSkillPaths' -v`
Expected: PASS for all four `TestSelectedSkillPaths*` tests (including the pre-existing `TestSelectedSkillPathsResolution` and `TestSelectedSkillPathsOrderIgnoresUnknownGroups`, which must remain green).

- [ ] **Step 5: Commit**

```bash
git add factory-server/internal/executor/claude_runner.go factory-server/internal/executor/profile_skills_test.go
git commit -m "feat(executor): selectedSkillPaths 读取 generationProfile.data 分组" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Document the data-skill selection rule in the clarification skill

**Files:**
- Modify: `.claude/skills/requirement-clarification/SKILL.md` (lines 69-73 example; append section after line 147)

**Interfaces:**
- Consumes: the `data` group produced by Task 1's `selectedSkillPaths`.
- Produces: written guidance the clarification model follows (it already reads this SKILL.md via `clarification/runner.go:345`) to populate `requirement.generationProfile.data` when `dataPolicy` is `live_api`/`mock_then_api` and a data domain matches.

- [ ] **Step 1: Add the `data` group to the Output Contract example**

In `.claude/skills/requirement-clarification/SKILL.md`, edit the `generationProfile` block inside the Output Contract JSON example. Replace:

```json
    "generationProfile": {
      "base": ["software-factory-app"],
      "domain": ["defense-operations-ui"],
      "pattern": ["map-timeline-replay"]
    }
```

with:

```json
    "generationProfile": {
      "base": ["software-factory-app"],
      "domain": ["defense-operations-ui"],
      "pattern": ["map-timeline-replay"],
      "data": []
    }
```

- [ ] **Step 2: Append the Data Skill Mapping section**

In the same file, append a new section after the *Generation Profile Mapping* (currently the last section, ending at the `command_dashboard` line). Replace:

```markdown
- `command_dashboard`: `software-factory-app`, `defense-operations-ui`, `command-dashboard`
```

with:

```markdown
- `command_dashboard`: `software-factory-app`, `defense-operations-ui`, `command-dashboard`

## Data Skill Mapping

When `dataPolicy` is `live_api` or `mock_then_api` (the app fetches real data)
**and** the requirement matches one of the data domains below, put the
corresponding skill into `requirement.generationProfile.data`. When `dataPolicy`
is `mock_data`, do not add any data skill.

- Tide / tidal height / departure window / draft threshold / port tide level: `tide-data-skill`
- 10 m wind / deck wind / wind speed & direction / launch or recovery conditions: `deck-wind-data-skill`
- AIS / merchant density / shipping density / grid alert / baseline comparison: `ais-density-data-skill`

These rules apply to **any** app whose intent matches a domain, including novel
apps that are not preset scenarios and regardless of `appType`. If no domain
matches, emit an empty `data` array. Set `dataPolicy` from intent: when the user
wants real-time / live data, use `live_api` or `mock_then_api`; otherwise
`mock_data`.
```

- [ ] **Step 3: Verify the edits landed**

Run these three checks from the worktree root; each must print at least one match:
```bash
grep -c "Data Skill Mapping" .claude/skills/requirement-clarification/SKILL.md
grep -n '"data": \[\]' .claude/skills/requirement-clarification/SKILL.md
grep -c "tide-data-skill\|deck-wind-data-skill\|ais-density-data-skill" .claude/skills/requirement-clarification/SKILL.md
```
Expected: first prints `1`; second prints one line (the example); third prints `3`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/requirement-clarification/SKILL.md
git commit -m "docs(skill): clarification 新增 数据 skill 选择规则 (dataPolicy 门控)" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Decision 1 (domain/keyword rule) → Task 2 (Data Skill Mapping section).
- Decision 2 (`dataPolicy` gating, reuse `live_api`/`mock_then_api`) → Task 2 rule text + Global Constraints.
- Decision 3 (new `data` group) → Task 1 (selectedSkillPaths) + Task 2 (example).
- Design A (SKILL.md) → Task 2. Design B (claude_runner.go) → Task 1. Design C (data flow) → emergent from A+B, no code. Design D (testing) → Task 1 Steps 1-2 + the two new tests.
- Out-of-scope items (no blueprints.json / catalog.json / prompt change) → enforced by Global Constraints; no task touches them.

**2. Placeholder scan** — no TBD/TODO/vague steps. Every code step shows exact code; every command shows expected output.

**3. Type consistency** — `selectedSkillPaths` signature is unchanged; the new tests call it exactly as the existing tests do (`selectedSkillPaths(ws, profile)` / `selectedSkillPaths("ws", profile)`). `repoWorkspace`, `SafeName`, `withinRoot`, `filepath.ToSlash`, `os.Stat` all pre-exist. The `data` group key is spelled identically (`"data"`) in the Go slice, the test profile maps, and the SKILL.md example/rule.

No issues found.
