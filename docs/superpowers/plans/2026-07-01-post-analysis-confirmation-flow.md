# Post Analysis Confirmation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move application-generation confirmation from clarification completion to the completed requirement-analysis result, then present business/interface/data confirmation blocks in the conversation surface.

**Architecture:** Reuse the existing job and manual-step-confirmation mechanisms instead of adding a second workflow. Clarification completion seeds the job automatically; the executor adds a demand-confirmation gate only for the first `requirement_analysis` step while the child clarification is still `ready_to_confirm`, and the frontend renders that pause as `需求确认`.

**Tech Stack:** Go server/store/executor tests, React/Vite portal logic harness scripts, existing SQLite-backed workflow.

---

### Task 1: Backend Auto-Seeding After Clarification

**Files:**
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Test: `factory-server/internal/server/dialogue_handlers_test.go`

- [ ] **Step 1: Write the failing test**

Add a server test that drives an application-generation dialogue to `ready_to_confirm`, verifies a job is already linked, and verifies the parent is `task_running` without calling `/clarification/confirm`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server -run TestDialogueClarificationReadyAutoSeedsRequirementAnalysisJob -count=1`
Expected: FAIL because current code only seeds the job from `confirmDialogueClarification`.

- [ ] **Step 3: Implement minimal backend change**

Extract the job-seeding part of `confirmDialogueClarification` into a helper, call it when composing/returning a ready clarification after answer/consolidation paths, and add an executor gate so only the auto-seeded `requirement_analysis` step pauses for `需求确认`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/server -run TestDialogueClarificationReadyAutoSeedsRequirementAnalysisJob -count=1`
Expected: PASS.

### Task 2: Requirement Analysis Confirmation Labeling

**Files:**
- Modify: `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`
- Modify: `sf-portal-mvp/src/App.jsx`
- Test: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`

- [ ] **Step 1: Write the failing test**

Assert the workbench source no longer contains the application-generation `确认并生成` button, and that business/interface/data confirmation labels are `需求确认`、`界面确认`、`数据确认`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix sf-portal-mvp run check:dialogue-workbench`
Expected: FAIL on the new label expectations.

- [ ] **Step 3: Implement minimal frontend change**

Replace aggregate confirmation labels and confirm-answer payloads. Hide the old bottom clarification confirm bar for application generation. Keep business-agent creation confirmation unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix sf-portal-mvp run check:dialogue-workbench`
Expected: PASS.

### Task 3: Conversation Block Separation

**Files:**
- Modify: `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Test: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`

- [ ] **Step 1: Write the failing test**

Assert the agent block renders a semantic divider element before interface and data blocks, and exposes business/interface/data block titles matching `需求理解结果`、`界面确认`、`数据方案确认`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix sf-portal-mvp run check:dialogue-workbench`
Expected: FAIL on missing block title/divider markup.

- [ ] **Step 3: Implement minimal frontend change**

Add a block-title map and divider rendering in `WorkbenchAgentBlock`; show the requirement summary only in the business block before confirmation by using existing requirement artifact/summary surfaces.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix sf-portal-mvp run check:dialogue-workbench`
Expected: PASS.

### Task 4: Final Verification

**Files:**
- Test-only command coverage.

- [ ] **Step 1: Run backend focused tests**

Run: `go test ./internal/server ./internal/executor -count=1`
Expected: PASS.

- [ ] **Step 2: Run frontend focused checks**

Run: `npm --prefix sf-portal-mvp run check:dialogue-workbench`
Expected: PASS.

- [ ] **Step 3: Inspect diff**

Run: `git diff --stat && git diff --check`
Expected: no whitespace errors and only scoped files changed.
