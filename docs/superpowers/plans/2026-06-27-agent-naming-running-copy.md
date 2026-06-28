# Agent Naming Running Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean the currently running Software Factory user-facing copy so product nouns say “智能体” instead of “应用” where the generated product or reusable product is shown to users.

**Architecture:** This is a focused copy migration. Keep internal API names, Go/React type names, database fields, route IDs, and `app/application` technical identifiers unchanged; only update user-facing Chinese strings and the tests/scripts that assert them.

**Tech Stack:** React/Vite (`sf-portal-mvp`), Node logic scripts, Go factory server tests.

## Global Constraints

- Scope is “运行口径优先”: update current runtime UI copy, backend user-facing route fallback reasons, and related assertions only.
- Product nouns: left-side product list is “业务智能体”; generated/reused/recommended products are “智能体”.
- Preserve internal technical naming: `/api/apps`, `generated-apps/`, `ApplicationCard`, `application_generation`, `existing_application`, Go model fields, DB schema, and JSON field names stay unchanged.
- Do not modify `scene/**` or `cc-status/**`.
- Do not run mutating git commands (`git add`, `git commit`, `git checkout`, `git reset`, `git push`). The user controls commits.

---

## File Structure

- Modify `sf-portal-mvp/src/components/ApplicationsPanel.jsx`
  - Responsibility: current runtime left-panel business-agent cards and actions.
  - Change only user-facing generated-card action copy.
- Modify `factory-server/internal/dialogue/runner.go`
  - Responsibility: dialogue route normalization and legacy fallback route reasons.
  - Change only `UserFacingReason` strings returned to the UI.
- Modify `factory-server/internal/server/dialogue_handlers.go`
  - Responsibility: HTTP route selection fallback for stale/legacy clients.
  - Change only fallback `UserFacingReason` strings.
- Modify tests/scripts that assert old copy:
  - `factory-server/internal/dialogue/runner_test.go`
  - `factory-server/internal/server/dialogue_handlers_test.go`
  - `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`
  - `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`
  - Add/update assertions in `sf-portal-mvp/scripts/check-application-ordering.mjs` only if it checks user-facing generated delete/regenerate copy.

---

### Task 1: Update Frontend Running Copy

**Files:**
- Modify: `sf-portal-mvp/src/components/ApplicationsPanel.jsx`
- Test: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`
- Test: `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`

**Interfaces:**
- Consumes: existing `isGenerated(app)`, `onRegenerate(app)`, and `onDelete(app.id)` behavior.
- Produces: same UI behavior with updated visible strings.

- [ ] **Step 1: Search frontend copy before editing**

Run:

```bash
rg -n "基于该应用重新生成|删除生成应用|确认删除生成应用|生成新应用|复用已有应用|推荐应用|应用列表" sf-portal-mvp/src sf-portal-mvp/scripts --glob '!node_modules/**' --glob '!dist/**'
```

Expected: matches for old strings only in current runtime files/scripts that need migration. If `生成新应用` / `复用已有应用` / `推荐应用` do not appear in `sf-portal-mvp/src`, do not add changes for them.

- [ ] **Step 2: Update generated-card action copy**

In `sf-portal-mvp/src/components/ApplicationsPanel.jsx`, replace the generated-card action strings:

```jsx
title="基于该应用重新生成"
```

with:

```jsx
title="基于该智能体重新生成"
```

Replace:

```jsx
if (window.confirm(`确认删除生成应用「${app.name || app.slug}」？本地生成目录会被删除，生成审计记录会保留。`)) {
```

with:

```jsx
if (window.confirm(`确认删除生成智能体「${app.name || app.slug}」？本地生成目录会被删除，生成审计记录会保留。`)) {
```

Replace:

```jsx
title="删除生成应用"
```

with:

```jsx
title="删除生成智能体"
```

- [ ] **Step 3: Update frontend script assertions if they assert removed copy**

If any `sf-portal-mvp/scripts/*.mjs` file asserts the old generated-card copy, replace old expected strings with:

```js
'基于该智能体重新生成'
'确认删除生成智能体'
'删除生成智能体'
```

Keep existing assertions for already-correct strings:

```js
'生成新智能体'
'复用已有智能体'
'推荐智能体'
'通过需求澄清生成助手智能体或业务智能体'
```

- [ ] **Step 4: Run frontend logic tests**

Run:

```bash
cd sf-portal-mvp && npm run test:logic
```

Expected: command exits 0. If a failure points to old “应用” assertions, update that assertion to the new “智能体” product noun only when it is user-facing runtime copy.

- [ ] **Step 5: Skip git commit**

Do not run git commit/add/push. Leave the working-tree changes for the user.

---

### Task 2: Update Backend Route Fallback Reasons

**Files:**
- Modify: `factory-server/internal/dialogue/runner.go`
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Test: `factory-server/internal/dialogue/runner_test.go`
- Test: `factory-server/internal/server/dialogue_handlers_test.go`

**Interfaces:**
- Consumes: existing `RouteOutput.UserFacingReason` string behavior.
- Produces: same routing behavior, but fallback reasons use “智能体”.

- [ ] **Step 1: Search backend route reason copy before editing**

Run:

```bash
rg -n "新应用|助手应用|已有应用可复用|生成一个可运行" factory-server/internal/dialogue factory-server/internal/server
```

Expected: matches in route normalization/fallback code and tests.

- [ ] **Step 2: Update `runner.go` fallback reasons**

In `factory-server/internal/dialogue/runner.go`, replace:

```go
out.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的新应用。"
```

with:

```go
out.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的新智能体。"
```

Replace:

```go
out.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的助手应用。"
```

with:

```go
out.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的助手智能体。"
```

If the same old new-app fallback appears more than once in this file, replace every user-facing occurrence.

- [ ] **Step 3: Update `dialogue_handlers.go` stale-client fallback**

In `factory-server/internal/server/dialogue_handlers.go`, replace:

```go
route.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的新应用。"
```

with:

```go
route.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的新智能体。"
```

- [ ] **Step 4: Update backend tests**

In `factory-server/internal/dialogue/runner_test.go` and `factory-server/internal/server/dialogue_handlers_test.go`, replace expected user-facing strings:

```go
"我会澄清需求并生成一个可运行的新应用。"
"我会先澄清你的需求，并生成一个可运行的新应用。"
"将先澄清需求并生成一个可运行的新应用。"
```

with the matching “智能体” version while preserving the rest of the sentence:

```go
"我会澄清需求并生成一个可运行的新智能体。"
"我会先澄清你的需求，并生成一个可运行的新智能体。"
"将先澄清需求并生成一个可运行的新智能体。"
```

If a test intentionally injects legacy model output containing “已有应用可复用。” and asserts normalization behavior, keep or update it based on what the test verifies:

```go
// Keep if testing legacy input acceptance:
UserFacingReason: "已有应用可复用。"

// Use new copy if testing product output shown to users:
UserFacingReason: "已有智能体可复用。"
```

- [ ] **Step 5: Run targeted Go tests**

Run:

```bash
cd factory-server && go test ./internal/dialogue ./internal/server
```

Expected: command exits 0.

- [ ] **Step 6: Skip git commit**

Do not run git commit/add/push. Leave the working-tree changes for the user.

---

### Task 3: Final Naming Audit and Verification

**Files:**
- No required code files unless audit finds current-runtime user-facing misses.

**Interfaces:**
- Consumes: changes from Tasks 1 and 2.
- Produces: verified current runtime copy migration with known intentional leftovers.

- [ ] **Step 1: Run runtime-scope Chinese copy audit**

Run:

```bash
rg -n "生成新应用|复用已有应用|推荐应用|选择应用|应用列表|删除生成应用|确认删除生成应用|基于该应用重新生成|新应用|助手应用" sf-portal-mvp/src sf-portal-mvp/scripts factory-server/internal/dialogue factory-server/internal/server --glob '!node_modules/**' --glob '!dist/**'
```

Expected: no current-runtime user-facing miss remains. Test fixtures may still contain legacy input only if the test name/comment makes that intentional.

- [ ] **Step 2: Confirm correct current copy exists**

Run:

```bash
rg -n "业务智能体|纳管智能体|生成新智能体|复用已有智能体|推荐智能体|生成一个可运行的新智能体|助手智能体|删除生成智能体|基于该智能体重新生成" sf-portal-mvp/src sf-portal-mvp/scripts factory-server/internal/dialogue factory-server/internal/server --glob '!node_modules/**' --glob '!dist/**'
```

Expected: matches include the updated runtime UI and backend fallback reason strings.

- [ ] **Step 3: Run combined verification**

Run:

```bash
cd sf-portal-mvp && npm run test:logic
```

Expected: command exits 0.

Run:

```bash
cd factory-server && go test ./internal/dialogue ./internal/server
```

Expected: command exits 0.

- [ ] **Step 4: Report intentional leftovers**

In the final response, explicitly report that these were intentionally not changed under “运行口径优先”:

```text
/api/apps, generated-apps/, app/application internal identifiers, Go/React type names, DB fields, historical docs/plans, deploy docs, scene/**, cc-status/**
```

- [ ] **Step 5: Skip git commit**

Do not run git commit/add/push. Leave the working-tree changes for the user.

---

## Self-Review

- Spec coverage: The plan covers current runtime frontend copy, backend user-facing route fallback reasons, test assertions, and final audit. It explicitly excludes internal API/field names and historical docs per the selected scope.
- Placeholder scan: No TBD/TODO/fill-later placeholders remain. Each code change lists exact old and new strings.
- Type consistency: No public interfaces or data structures are renamed. Existing `app/application` identifiers remain unchanged by design.
