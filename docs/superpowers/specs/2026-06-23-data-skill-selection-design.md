# Data Skill Selection Design

Date: 2026-06-23

## Status

Approved for implementation planning.

## Context

The repo ships three data-acquisition skills under `.claude/skills/`:

- `tide-data-skill` — real tide forecast data (port tidal height, departure
  window, draft threshold)
- `deck-wind-data-skill` — real 10 m wind data (carrier operating regions,
  launch/recovery conditions)
- `ais-density-data-skill` — real AIS data, normalized into merchant-density
  grid results with baseline comparison

Each skill follows the same contract: use real data by default; skip only when
the user explicitly asks for `mock` / `demo` / `sample`; return failure when
every real source fails and never fabricate data.

These skills are currently dead weight. The generation pipeline only surfaces a
skill to the code-generation agent when its key appears in the confirmed
requirement's `generationProfile`, and `selectedSkillPaths`
(`factory-server/internal/executor/claude_runner.go:426`) resolves
`generationProfile` keys to `<workspace>/.claude/skills/<key>/SKILL.md`. Nothing
ever puts a data-skill key into `generationProfile`:

- The clarification model fills `generationProfile` from the **Generation
  Profile Mapping** in `requirement-clarification/SKILL.md:143-147`, which maps
  `appType` → base/domain/pattern skills. No data skill is listed there.
- A full-repo search confirms the three data-skill names are referenced nowhere
  outside their own `SKILL.md` files.
- `blueprints.json` does not mention them.

The user's intended behavior: after the user describes what they want to build,
the system recognizes whether the app needs real data and, if so, loads the
matching data skill — including for **novel ("其他") apps** the user describes
that are not preset scenarios.

Two constraints shape the design:

1. The three data domains (tide / deck-wind / merchant-density) are all
   `appType: command_dashboard` in `blueprints.json` (lines 54, 69, 84).
   `appType` therefore cannot distinguish which data skill applies; selection
   must be driven by something finer-grained — the app's **data domain**.
2. The confirmed requirement already carries a free-form `dataPolicy` string
   (`contracts.go:85`; required at `clarification_handlers.go:1260`; no enum
   validation). Values already in use are `mock_data`, `mock_then_api`, and
   `live_api`. This is a natural, pre-existing gate for "does this app fetch
   real data".

## Decisions Confirmed

1. **Selection mechanism: domain/keyword rule.** A data-domain → data-skill
   mapping is added to `requirement-clarification/SKILL.md`. The clarification
   model applies it from user intent + keywords. This works for novel apps and
   requires no change to `blueprints.json`. (Rejected: blueprint-inherited
   `dataSkills`, which only fires when a preset blueprint matches; rejected:
   hybrid, as unnecessary for the current scope.)
2. **Gating: by `dataPolicy`.** A data skill is added to `generationProfile`
   only when `dataPolicy` indicates real-data fetching (`live_api` or
   `mock_then_api`) **and** the data domain matches. `mock_data` apps do not
   load a data skill. The existing `dataPolicy` values are reused; no new value
   is introduced.
3. **Grouping: new `data` group in `generationProfile`.** Data-acquisition is a
   distinct concern from the existing UI-oriented `base` / `domain` / `pattern`
   groups. `selectedSkillPaths` is extended to read a `data` group. (Rejected:
   reusing an existing group, which would muddy semantics.)

## Goals

- When a user's request implies a real-data app in a supported data domain, the
  matching data skill is loaded into the generation pipeline and the generated
  app fetches real data per that skill.
- Selection is intent/domain-driven, so it works for both preset scenarios and
  novel apps the user describes.
- Mock-data apps are unaffected (no data skill loaded).
- Minimal, declarative change: one doc file + one line of Go.

## Design

### A. `requirement-clarification/SKILL.md` (documentation — primary change)

1. Add a new section **Data Skill Mapping** immediately after the existing
   *Generation Profile Mapping* (after line 147):

   > When `dataPolicy` is `live_api` or `mock_then_api` (the app fetches real
   > data) **and** the requirement matches one of the data domains below, put
   > the corresponding skill into `requirement.generationProfile.data`. When
   > `dataPolicy` is `mock_data`, do not add any data skill.
   >
   > - Tide / tidal height / departure window / draft threshold / port tide
   >   level → `tide-data-skill`
   > - 10 m wind / deck wind / wind speed & direction / launch or recovery
   >   conditions → `deck-wind-data-skill`
   > - AIS / merchant density / shipping density / grid alert / baseline
   >   comparison → `ais-density-data-skill`
   >
   > These rules apply to **any** app whose intent matches a domain, including
   > novel apps that are not preset scenarios and regardless of `appType`. If no
   > domain matches, emit an empty `data` array.

2. Update the Output Contract `generationProfile` example (around lines 69-73)
   to include the `data` group:
   ```json
   "generationProfile": {
     "base": ["software-factory-app"],
     "domain": ["defense-operations-ui"],
     "pattern": ["map-timeline-replay"],
     "data": []
   }
   ```

3. The model infers `dataPolicy` from intent: when the user wants real/live
   data (mentions real-time, live sources, actual forecasts, etc.) set
   `live_api` or `mock_then_api`; otherwise `mock_data`. This mirrors the
   data skills' own "real by default, mock on explicit request" rule.

### B. `factory-server/internal/executor/claude_runner.go` (one-line code change)

`selectedSkillPaths` (line 426) iterates a fixed list of groups. Extend it to
include `data`, and update the doc comment above it (lines 413-425) to mention
the `data` group:

```go
for _, group := range []string{"base", "domain", "pattern", "data"} {
    keys = append(keys, profile[group]...)
}
```

`skillsPromptBlock` (line 356) already lists every resolved skill path
regardless of group, so no further code change is needed for the data skills to
reach the code-generation agent's prompt. Order remains base → domain →
pattern → data (foundational skills first, data skills last).

### C. Data flow

1. User submits a request in the conversation workbench.
2. The clarification model runs a round, reading
   `requirement-clarification/SKILL.md` (per the runner prompt at
   `clarification/runner.go:345`).
3. The model sets `dataPolicy` from intent and, when `dataPolicy` is
   `live_api`/`mock_then_api` and a data domain matches, places the matching
   skill key(s) in `requirement.generationProfile.data`.
4. On confirm, the requirement is frozen and a generation job is created.
5. During `code_generation`, `selectedSkillPaths` resolves the `data` group keys
   to `.claude/skills/<key>/SKILL.md`.
6. `skillsPromptBlock` injects those paths into the code-generation prompt; the
   agent loads and follows the data skill, so the generated app fetches real
   data from the skill's declared sources.

## Testing

- **Unit (`profile_skills_test.go`):** extend to assert `selectedSkillPaths`
  resolves a `data` group key to `<workspace>/.claude/skills/<key>/SKILL.md`,
  and that base/domain/pattern/data ordering is preserved. Also assert unsafe
  `data` keys (e.g. `..`) are still dropped by the existing `SafeName` /
  `withinRoot` guards.
- **Domain selection is model behavior**, constrained by the `SKILL.md` rule
  the same way the existing `appType` → skills mapping is. It is not unit-tested
  deterministically (consistent with how the current generation-profile mapping
  is specified only in documentation).

## Out of scope (YAGNI)

- No change to `blueprints.json` (decision 1 chose the keyword rule, not
  blueprint-inherited `dataSkills`).
- No `catalog.json` gating of data skills. The unified config currently
  controls `apps` / `blueprints` show-hide; data-skill selection stays
  intent-driven and decoupled. Centralized gating can be revisited later.
- No change to the clarification runner prompt (`runner.go:345`, `:740`); the
  model already reads `SKILL.md`, so placing the rule there is sufficient.

## File-level change summary

| File | Change |
|---|---|
| `.claude/skills/requirement-clarification/SKILL.md` | Add *Data Skill Mapping* section; add `data` group to the `generationProfile` example |
| `factory-server/internal/executor/claude_runner.go` | `selectedSkillPaths`: add `"data"` to the group list + update doc comment |
| `factory-server/internal/executor/profile_skills_test.go` | Add `data` group resolution + ordering + safety test |
