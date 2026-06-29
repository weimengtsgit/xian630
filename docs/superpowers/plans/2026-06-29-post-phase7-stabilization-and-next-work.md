# Post Phase 7 Stabilization And Next Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the completed workbench drawer, task observability, application project, and document draft workflow so it is ready for PR review, then sequence the next product increments without mixing new feature risk into the stabilization PR.

**Architecture:** Treat the current branch as a completed integrated vertical slice. First freeze behavior, verify it end-to-end, and prepare one reviewable PR. Future increments should extend the existing contracts: draft application remains confirmation-gated, revision jobs may consume linked draft records, semantic conversion is behind a backend interface, and diff/rebase UI stays user-mediated.

**Tech Stack:** Go backend under `factory-server/`, React/Vite frontend under `sf-portal-mvp/`, SQLite schema in `factory-server/internal/store/schema.sql`, project document generation in `factory-server/internal/projectdocs/`, product/architecture docs under `docs/`.

---

## 1. Current Status

- Branch: `feat-0624-dazhao`.
- HEAD at plan time: `2a0c408 fix: block stale document draft editing`.
- Remote branch: `origin/feat-0624-dazhao` points to the same HEAD.
- Only known unrelated local change: `.factory/scene-catalog.json`.
- Mainline feature phases 1-7 are implemented and pushed:
  - Workbench layout migration.
  - Task execution drawer migration.
  - Task execution blocks and task-internal clarification routing.
  - Task thinking persistence and streaming.
  - Read-only application project drawer.
  - Markdown project document generation and `.factory/project-docs.json`.
  - Document drafts, apply-as-change-request, stale recovery.
- Current Phase 7 draft apply path is a minimum viable flow:
  - Save draft persists separate markdown draft.
  - Apply draft creates a deterministic `application_modification` summary and moves dialogue to `change_confirmation`.
  - Confirmation creates the revision job through the existing `confirmDialogueChange` path.
  - The revision job still consumes `TurnSummary.ChangeDescription`; it does not yet load the full draft record.

## 2. Recommended Next Milestone

**Recommendation: do Direction 1 first: Stabilization and PR preparation.**

Phase 7.2 is not a hard blocker for the current PR if the PR description is explicit that document draft application currently passes a deterministic change summary/diff excerpt into the confirmation flow. The feature is usable as a minimum safe loop because it does not mutate source documents, does not mutate machine contracts, and still requires central confirmation before a revision task is created.

Phase 7.2 should be the next feature milestone after the stabilization PR if the product requires high-fidelity revision tasks for large drafts. It should not be slipped into the current PR because it changes backend data flow, dialogue turn summary shape, job input composition, and tests around `confirmDialogueChange`.

## 3. Task Breakdown

### Task 1: P0 Stabilization Freeze And Worktree Hygiene

**Priority:** P0  
**Goal:** Make the PR diff unambiguous and prevent the unrelated scene catalog edit from contaminating review.

**Files:**
- Inspect only: `.factory/scene-catalog.json`
- No intended feature edits.

- [ ] **Step 1: Confirm branch and dirty files**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
git status --short --branch
git log --oneline --decorate -8
```

Expected:

```text
## feat-0624-dazhao...origin/feat-0624-dazhao
 M .factory/scene-catalog.json
2a0c408 (HEAD -> feat-0624-dazhao, origin/feat-0624-dazhao) fix: block stale document draft editing
```

- [ ] **Step 2: Inspect the unrelated scene catalog diff**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
git diff -- .factory/scene-catalog.json
```

Expected: the diff is unrelated to workbench drawer, task observability, project documents, and document draft workflow.

- [ ] **Step 3: Exclude `.factory/scene-catalog.json` from this PR**

Default action for the stabilization PR:

```bash
cd /Users/mengwei/ww/Developer/xian630
git diff -- sf-portal-mvp factory-server docs package.json
git diff -- .factory/scene-catalog.json
```

Acceptance:
- The PR staging/commit list does not include `.factory/scene-catalog.json`.
- If the scene catalog change is intentional, it is handled in a separate commit or separate PR with its own review.
- If the scene catalog change is accidental, get explicit owner approval before reverting because it is a pre-existing user/workspace change.

**Suggested commit:** no commit unless the owner chooses to split or revert the scene catalog change.

### Task 2: P0 Full Verification Matrix

**Priority:** P0  
**Goal:** Prove the integrated branch still passes backend, frontend, and whitespace checks after Phase 4-7.

**Files:**
- No source edits expected.
- If failures occur, fix the specific failing test or code path in the file identified by the failure.

- [ ] **Step 1: Run backend focused integration packages**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/store ./internal/server ./internal/executor ./internal/runner ./internal/projectdocs
```

Expected:

```text
ok  	github.com/weimengtsgit/xian630/factory-server/internal/store
ok  	github.com/weimengtsgit/xian630/factory-server/internal/server
ok  	github.com/weimengtsgit/xian630/factory-server/internal/executor
ok  	github.com/weimengtsgit/xian630/factory-server/internal/runner
ok  	github.com/weimengtsgit/xian630/factory-server/internal/projectdocs
```

- [ ] **Step 2: Run backend full package sweep**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./...
```

Expected: every package returns `ok` or `[no test files]`; no package fails.

- [ ] **Step 3: Run frontend logic checks**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run test:logic
```

Expected: all check scripts print their `OK`/passed messages and the command exits 0.

- [ ] **Step 4: Run frontend production build**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run build
```

Expected: Vite reports `✓ built` and exits 0.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
git diff --check
```

Expected: no output, exit 0.

**Suggested commit:** no commit when verification is green. If a fix is required, use `fix: stabilize workbench project draft flow` and include only the failing area.

### Task 3: P0 Manual Smoke Test Of The User Flow

**Priority:** P0  
**Goal:** Verify the integrated behavior in the browser because several changes are UI state and timeline ordering changes that static checks cannot fully prove.

**Files:**
- No source edits expected.

- [ ] **Step 1: Start backend**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go run ./cmd/factory-server
```

Expected:
- Server starts without panic.
- API is reachable on the configured local address used by the portal.

- [ ] **Step 2: Start frontend**

Run in a second terminal:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run dev -- --host 127.0.0.1
```

Expected:
- Vite prints a local URL.
- Portal loads without console errors.

- [ ] **Step 3: Smoke workbench layout**

Actions:
- Open an existing dialogue.
- Confirm left session navigation is visible.
- Confirm center workbench has no inline task area at the top.
- Click top-right `任务执行`, `协作智能体`, `应用项目`.
- Confirm each opens the same right drawer host and active button toggles close/open.

Acceptance:
- No old fixed right agent panel appears.
- No old floating restore button appears.
- Drawer content does not overlap composer or timeline.

- [ ] **Step 4: Smoke task execution drawer and timeline blocks**

Actions:
- Open a dialogue with at least one generation task.
- Open `任务执行`.
- Confirm all generation tasks for the current dialogue appear.
- Select a task and a step.
- Return to task list.
- Check the conversation timeline for `任务执行块`, safe execution process, task thinking process, and clarification cards when present.

Acceptance:
- Task list defaults to the focus task.
- Step detail opens inside the drawer, not a second overlay drawer.
- Running/waiting/failed blocks default expanded; completed blocks default folded.
- Clarification answer appears after its clarification card, not above the task block.

- [ ] **Step 5: Smoke application project drawer and draft recovery**

Actions:
- Open a dialogue bound to a generated app.
- Open `应用项目`.
- Select a Markdown file under `docs/`.
- Use `编辑草稿`, change text, `保存草稿`.
- Confirm source Markdown is not overwritten.
- Use `应用为变更需求`.
- Confirm the center conversation enters change confirmation.
- For stale recovery, update the source Markdown externally or use a known stale draft fixture, then reopen the preview.

Acceptance:
- Stale draft cannot show normal `继续编辑草稿`.
- Stale draft cannot show normal `保存草稿`.
- Stale draft shows `重新以当前源文档创建草稿`.
- Clicking recovery discards stale draft, reloads current source, opens editor seeded with current source.
- Saving after recovery creates a fresh non-stale draft.

**Suggested commit:** no commit. If a UI defect is found, make a focused fix and commit `fix: harden application project draft recovery`.

### Task 4: P0 Final Code Review Checklist

**Priority:** P0  
**Goal:** Run a final review pass before PR so reviewers see known risk called out rather than discovering it from scratch.

**Files to inspect:**
- `factory-server/internal/server/app_project_handlers.go`
- `factory-server/internal/server/job_handlers.go`
- `factory-server/internal/server/dialogue_handlers.go`
- `factory-server/internal/executor/claude_runner.go`
- `factory-server/internal/projectdocs/generator.go`
- `factory-server/internal/store/schema.sql`
- `sf-portal-mvp/src/App.jsx`
- `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- `sf-portal-mvp/src/components/ApplicationProjectPanel.jsx`
- `sf-portal-mvp/src/components/JobCenter.jsx`
- `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- `sf-portal-mvp/src/hooks/useDialogueSessions.js`
- `sf-portal-mvp/src/hooks/taskThinkingState.js`

- [ ] **Step 1: Review security boundaries**

Check:
- Project tree/file APIs reject absolute path, empty path, `..`, symlink escapes.
- Hidden paths remain blocked: `dist`, `node_modules`, `.factory-runs`, `versions`, `audit/audits`, `output.json`.
- Draft save/apply only allows `docs/*.md`.
- Draft save/apply validates dialogue owns application.
- Task thinking redaction/capping happens before persistence/SSE publication.

Acceptance:
- No direct path read uses a user-provided path without `resolveProjectFilePath`.
- No raw `thinking_delta` is stored in work trace, execution records, artifacts, or ordinary dialogue messages.

- [ ] **Step 2: Review data lifecycle**

Check:
- Deleting dialogue removes task thinking.
- Discarded draft is not returned as preview overlay.
- Proposed draft cannot be applied again from UI.
- Stale draft cannot be edited or saved through the normal path.
- Step-scoped answer routes to target `stepId/attempt`.

Acceptance:
- Store and handler tests cover each lifecycle rule.

- [ ] **Step 3: Review UX consistency**

Check:
- Center workspace remains conversation-first.
- Right drawer entries are mutually exclusive.
- Application project drawer is disabled until an app is bound.
- Long text in buttons/actions does not overflow obvious narrow drawer widths.

Acceptance:
- No in-app explanatory copy is added beyond state/action labels needed for operation.

**Suggested commit:** only commit fixes found by this checklist; do not broaden scope.

### Task 5: P0 PR Preparation

**Priority:** P0  
**Goal:** Prepare one coherent PR that reviewers can understand despite the wide scope.

**Files:**
- No source edits required.
- Optional: create a PR notes file if the team wants local draft notes:
  - `docs/superpowers/plans/2026-06-29-pr-notes-workbench-project-docs.md`

- [ ] **Step 1: Generate final diff summary**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Acceptance:
- The commit list shows the Phase 1-7 sequence and follow-up fixes.
- The diff stat does not include `.factory/scene-catalog.json`.

- [ ] **Step 2: Use this PR description draft**

```markdown
## Summary

This PR completes the conversation workbench drawer and application project document workflow:

- Migrates the workbench to a left session nav, center conversation workspace, and unified right drawer.
- Moves task execution into the right drawer with all dialogue generation tasks, focus task ordering, step waves, and embedded step detail.
- Adds first-class task execution blocks to the conversation timeline, including safe execution process, task thinking process, task-internal clarification cards, and scoped clarification answer routing.
- Persists raw task thinking in a dedicated task-thinking stream/table instead of work trace, execution records, artifacts, or ordinary dialogue messages.
- Adds a read-only application project drawer for generated apps with safe project tree/file preview APIs.
- Generates user-facing Markdown project documents from validated step outputs and maintains `.factory/project-docs.json`.
- Adds Markdown document drafts, save/discard/apply-as-change-request, proposed/stale states, and stale draft recovery.

## Important Boundaries

- Markdown document edits do not overwrite generated project documents, machine contracts, or the running app.
- Applying a draft creates a confirmation-gated application modification summary; it does not directly create a job.
- The current minimum flow passes deterministic diff/excerpt content through `TurnSummary.ChangeDescription`.
- A follow-up Phase 7.2 should link full draft content to the revision job input so large drafts do not depend only on summary/excerpt text.
- Raw task thinking is persisted only in `task_thinking_events` and exposed only through task-thinking hydration/SSE for the conversation UI.

## Test Plan

- `cd factory-server && go test ./internal/store ./internal/server ./internal/executor ./internal/runner ./internal/projectdocs`
- `cd factory-server && go test ./...`
- `cd sf-portal-mvp && npm run test:logic`
- `cd sf-portal-mvp && npm run build`
- `git diff --check`

## Manual Smoke

- Verified right drawer entry toggles for task execution, collaboration agents, and application project.
- Verified task drawer shows all generation tasks for current dialogue and step detail opens inside the drawer.
- Verified task execution blocks and task-internal clarification cards render in the conversation timeline.
- Verified application project Markdown preview/source, draft save, apply-as-change-request, discard, proposed state, stale state, and restart-from-current-source recovery.

## Known Follow-ups

- Phase 7.2: revision job should consume linked full draft content, not only deterministic summary/excerpt.
- LLM-backed document draft converter behind a backend interface.
- Draft diff/rebase UI for stale draft recovery.
- Component cleanup for large workbench/project drawer components after behavior is frozen.
```

- [ ] **Step 3: Decide PR shape**

Recommendation:
- Keep one integrated PR for Phase 1-7 if reviewers can handle a large vertical slice. The phases are coupled through the workbench layout, task timeline, right drawer, project documents, and draft confirmation loop.
- Split only if the review platform or team process requires smaller PRs. If splitting, split by already-ordered commits:
  1. Workbench layout and task drawer.
  2. Task timeline, clarification routing, task thinking.
  3. Application project drawer and project docs.
  4. Document drafts and stale recovery.

Acceptance:
- PR description explicitly calls out Phase 7.2 as a follow-up, not hidden debt.
- PR test plan matches commands actually run.

**Suggested commit:** no commit unless adding local PR notes.

### Task 6: P1 Phase 7.2 Full Draft Content Consumption

**Priority:** P1 after stabilization PR  
**Goal:** Make revision jobs consume complete draft context after user confirmation while preserving the rule that the browser does not pass app/version/prompt at confirm time.

**Files likely modified:**
- `factory-server/internal/dialogue/turn.go`
- `factory-server/internal/server/app_project_handlers.go`
- `factory-server/internal/server/dialogue_handlers.go`
- `factory-server/internal/server/dialogue_handlers_test.go`
- `factory-server/internal/server/app_project_handlers_test.go`
- `factory-server/internal/store/project_document_drafts.go`
- `factory-server/internal/store/project_document_drafts_test.go`
- `factory-server/internal/model/model.go`

**Data flow design:**
- Extend `dialogue.TurnSummary` with document draft metadata, for example:

```go
type DocumentDraftChangeRef struct {
    DraftID        string `json:"draftId"`
    ApplicationID  string `json:"applicationId"`
    DialogueID     string `json:"dialogueId"`
    Path           string `json:"path"`
    SourceChecksum string `json:"sourceChecksum"`
}
```

- Add `DocumentDraftChange *DocumentDraftChangeRef json:"documentDraftChange,omitempty"` to `TurnSummary`.
- `POST /api/apps/:id/project-drafts/apply` writes the draft ref into `SummaryJSON` before setting `change_confirmation`.
- `confirmDialogueChange` continues to trust only server-side state:
  - gets dialogue by URL `dialogueID`;
  - gets latest completed application modification turn;
  - reads draft ref from `SummaryJSON`;
  - loads draft by server-side `draftID`;
  - validates draft belongs to dialogue and resolved application;
  - validates draft is `proposed`;
  - validates `sourceChecksum` matches ref;
  - composes `job.UserPrompt` from `ChangeDescription` plus full draft content or a bounded full-draft artifact pointer generated server-side.

**Test sequence:**
- [ ] Write failing test in `factory-server/internal/server/app_project_handlers_test.go`: apply draft stores `documentDraftChange.draftId/path/sourceChecksum` in `SummaryJSON`.
- [ ] Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/server -run TestApplicationProjectDraftApply -count=1
```

Expected before implementation: fails because `documentDraftChange` is missing.

- [ ] Implement `TurnSummary` extension and populate it in `applyApplicationProjectDraft`.
- [ ] Re-run the focused test; expected pass.
- [ ] Write failing test in `factory-server/internal/server/dialogue_handlers_test.go`: after confirming a document-draft change, the created revision job prompt contains full draft content beyond the 600-rune excerpt.
- [ ] Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/server -run TestConfirmDialogueChange -count=1
```

Expected before implementation: fails because prompt only contains `ChangeDescription`.

- [ ] Implement confirm-side draft load and prompt composition.
- [ ] Re-run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/server -run 'TestApplicationProjectDraftApply|TestConfirmDialogueChange' -count=1
go test ./internal/server ./internal/store
```

Acceptance:
- Browser confirm endpoint still does not accept app id, version id, prompt, or draft id from the request body.
- Draft ownership and status are revalidated server-side at confirm time.
- If the draft is missing, discarded, stale, or belongs to another dialogue/application, confirm returns 409 and does not create a job.
- Revision job prompt contains full draft content or a server-side artifact reference plus enough context for the agent to load it.

**Suggested commits:**
- `feat: link document draft metadata to change summary`
- `feat: include full document draft in revision job input`

### Task 7: P2 LLM-Backed Document Draft Converter

**Priority:** P2 after Phase 7.2  
**Goal:** Replace deterministic-only summary generation with an injectable converter that can semantically summarize source/draft changes while preserving deterministic fallback and draft safety.

**Files likely modified/created:**
- Create: `factory-server/internal/projectdocs/draft_converter.go`
- Create: `factory-server/internal/projectdocs/draft_converter_test.go`
- Modify: `factory-server/internal/server/app_project_handlers.go`
- Modify: `factory-server/internal/server/app_project_handlers_test.go`
- Modify: `factory-server/internal/dialogue/turn.go`

**Backend interface:**

```go
type DraftConversionInput struct {
    ApplicationID  string
    DialogueID     string
    Path           string
    SourceChecksum string
    SourceMarkdown string
    DraftMarkdown  string
}

type DraftConversionOutput struct {
    UserFacingText     string
    ChangeDescription  string
    StructuredChangeJSON string
    NeedsClarification bool
    ClarificationText  string
}

type DraftConverter interface {
    ConvertDraft(ctx context.Context, input DraftConversionInput) (DraftConversionOutput, error)
}
```

**Execution plan:**
- [ ] Add deterministic converter implementation using existing line counts and diff excerpt.
- [ ] Inject converter into `Server`, defaulting to deterministic converter.
- [ ] Add fake converter in tests that returns semantic summary, clarification, timeout error, and invalid output cases.
- [ ] In apply handler, call converter before marking draft proposed.
- [ ] On converter success, create `application_modification` turn and `change_confirmation`.
- [ ] On converter clarification, keep draft status `draft`, create/append a normal dialogue clarification/error item, and do not enter `change_confirmation`.
- [ ] On converter error/timeout, keep draft status `draft`, return an error response with stable code such as `conversion_failed`, and do not mutate source document or machine contracts.
- [ ] Decide fallback policy:
  - Recommended default for first implementation: use deterministic converter when LLM converter is disabled; do not silently fallback after an LLM failure unless the response explicitly says deterministic fallback was used.

**Prompt contract:**
- Inputs: source markdown, draft markdown, path, source checksum, app/dialogue ids as metadata.
- Output JSON:

```json
{
  "userFacingText": "已根据文档草稿生成变更建议，请确认后应用。",
  "changeDescription": "用户希望...",
  "structuredChange": {
    "documentPath": "docs/01-requirements.md",
    "added": [],
    "removed": [],
    "modified": [],
    "risks": []
  },
  "needsClarification": false,
  "clarificationText": ""
}
```

**Tests:**
- Converter success creates turn and proposed draft.
- Converter failure keeps draft intact and status `draft`.
- Converter clarification does not create revision job and does not mark proposed.
- Deterministic fallback output still contains added and deleted content excerpts.

**Suggested commits:**
- `feat: add document draft converter interface`
- `feat: use draft converter when applying document drafts`
- `test: cover draft conversion failure and clarification`

### Task 8: P2 Draft Diff And Manual Rebase UI

**Priority:** P2 after stabilization; can run before LLM converter if product support needs stale recovery UX sooner.  
**Goal:** Let users inspect source-vs-draft differences and manually recover useful stale draft content without automatic merge.

**Files likely modified/created:**
- Modify: `sf-portal-mvp/src/components/ApplicationProjectPanel.jsx`
- Modify: `sf-portal-mvp/src/components/ApplicationProjectPanel.css`
- Modify: `sf-portal-mvp/scripts/check-application-project-drawer.mjs`
- Optional create: `sf-portal-mvp/src/components/ProjectDraftDiff.jsx`
- Optional create: `sf-portal-mvp/src/components/ProjectDraftDiff.css`

**Recommended approach: frontend-only first.**
- Backend already returns current source content in `preview.content` and stale draft content in `preview.draft.content`.
- A simple side-by-side or unified line diff can be computed in the browser without changing persistence contracts.
- Do not auto-merge in the first iteration.

**UI state:**
- `preview` mode: current source preview.
- `source` mode: current source text.
- `draftDiff` mode: current source vs stale draft diff.
- `editing` mode: editable current-source-based draft after recovery.

**Task steps:**
- [ ] Add a line diff helper that labels lines as `same`, `added`, `removed`.
- [ ] Add static tests/checks ensuring no `dangerouslySetInnerHTML`.
- [ ] For stale drafts, show:
  - current source panel;
  - stale draft panel or unified diff;
  - `复制旧草稿内容到剪贴板` if clipboard support is acceptable;
  - `重新以当前源文档创建草稿`.
- [ ] Keep recovery explicit: clicking restart seeds editor with current source, not stale content.
- [ ] Let user manually copy useful stale content into the editor.

**Tests:**
- Static check that stale draft diff UI exists.
- Unit-style check if a helper script exists for diff classification.
- Manual smoke: stale draft displays old content and current source without allowing direct stale save.

**Suggested commits:**
- `feat: show stale document draft diff`
- `feat: support manual stale draft recovery editing`

### Task 9: P3 Component And Code Cleanup

**Priority:** P3 after PR or after Phase 7.2; do not mix into stabilization PR.  
**Goal:** Reduce component size and make future work safer without changing behavior.

**Files likely modified/created:**
- Split from `sf-portal-mvp/src/components/ApplicationProjectPanel.jsx`:
  - Create: `sf-portal-mvp/src/components/ApplicationProjectTree.jsx`
  - Create: `sf-portal-mvp/src/components/ApplicationProjectPreview.jsx`
  - Create: `sf-portal-mvp/src/components/ApplicationProjectDraftActions.jsx`
- Split from `sf-portal-mvp/src/components/ConversationWorkbench.jsx` only after tests are strong:
  - Create: `sf-portal-mvp/src/components/WorkbenchTimeline.jsx`
  - Create: `sf-portal-mvp/src/components/WorkbenchHeaderActions.jsx`

**Safe sequence:**
- [ ] Run current checks before refactor:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run test:logic
npm run build
```

- [ ] Extract `ApplicationProjectTree` with no prop renames.
- [ ] Run `node scripts/check-application-project-drawer.mjs`.
- [ ] Commit `refactor: split application project tree`.
- [ ] Extract `ApplicationProjectPreview` with no behavior changes.
- [ ] Run `npm run test:logic && npm run build`.
- [ ] Commit `refactor: split application project preview`.
- [ ] Extract `ApplicationProjectDraftActions`.
- [ ] Run `npm run test:logic && npm run build`.
- [ ] Commit `refactor: split application project draft actions`.
- [ ] Only then consider splitting `ConversationWorkbench`.

Acceptance:
- No copy changes except imports/component names.
- No API/client changes.
- No backend changes.
- `git diff --word-diff` shows JSX relocation more than behavior edits.

## 4. Risks

- **Large PR risk:** Phase 1-7 touches layout, task execution, task thinking, backend APIs, project documents, and draft workflow. Mitigation: use a detailed PR summary, explicit test plan, and known-follow-up section.
- **Full draft fidelity risk:** Current revision job prompt consumes deterministic summary/excerpt, not full draft content. Mitigation: document as follow-up Phase 7.2; do not promise full large-draft fidelity in the current PR.
- **Raw thinking sensitivity risk:** Product requires raw `thinking_delta`, but storage/exposure must stay isolated. Mitigation: final review must verify redaction/capping and exclusion from work trace, execution records, artifacts, and ordinary messages.
- **Path traversal/security risk:** Application project APIs read local project files. Mitigation: retain tests for path traversal, symlink escapes, denied directories, and output.json hiding.
- **Stale draft UX risk:** Users may expect automatic merge. Mitigation: current recovery intentionally discards stale draft and seeds from current source; future diff/rebase UI is a separate task.
- **Scene catalog dirty file risk:** `.factory/scene-catalog.json` can accidentally enter the PR. Mitigation: inspect and exclude or split before final PR actions.

## 5. Verification Commands

Run before final PR:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/store ./internal/server ./internal/executor ./internal/runner ./internal/projectdocs
go test ./...
```

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run test:logic
npm run build
```

```bash
cd /Users/mengwei/ww/Developer/xian630
git diff --check
git status --short --branch
```

Run after Phase 7.2:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./internal/server -run 'TestApplicationProjectDraftApply|TestConfirmDialogueChange' -count=1
go test ./internal/server ./internal/store
```

Run after frontend draft UI changes:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-application-project-drawer.mjs
npm run test:logic
npm run build
```

## 6. Suggested Commit And PR Strategy

### Current branch PR

Recommended: one integrated PR for Phase 1-7 plus stabilization fixes.

Reason:
- The user-facing feature is one vertical workbench experience.
- Backend task thinking, task timeline, project documents, and draft apply are coupled through the conversation UI.
- Splitting now may create intermediate PRs that compile but do not deliver a coherent workflow.

Review help:
- Use the PR description from Task 5.
- Put known follow-ups in the PR description.
- Ask reviewers to review by area:
  - layout/drawer;
  - task execution/timeline/clarification;
  - task thinking persistence;
  - application project APIs;
  - project docs/drafts.

### Future commits after current PR

Recommended order:

1. `feat: link document draft metadata to change summary`
2. `feat: include full document draft in revision job input`
3. `feat: add document draft converter interface`
4. `feat: use draft converter when applying document drafts`
5. `feat: show stale document draft diff`
6. `refactor: split application project drawer components`
7. `refactor: split conversation workbench timeline components`

Do not combine semantic converter work with component cleanup. Do not combine stale diff UI with full draft job consumption unless product explicitly requires both in one release.

## 7. Open Questions

1. Should the current PR state that Phase 7 draft application is a minimum deterministic conversion, or should Phase 7.2 be completed before exposing the feature to users?
   - Recommendation: ship current PR as minimum safe loop; schedule Phase 7.2 immediately after.

2. What should happen to `.factory/scene-catalog.json`?
   - Recommendation: exclude from this PR. Commit separately only if it is an intentional catalog update.

3. Should Phase 7.2 store full draft content directly in `TurnSummary`, or only store a draft reference?
   - Recommendation: store a draft reference in `TurnSummary`; load full content server-side at confirm time. This keeps confirmation server-authoritative and avoids bloating dialogue turn summaries.

4. Should LLM conversion fallback silently to deterministic conversion?
   - Recommendation: deterministic converter is the default when LLM converter is disabled. If LLM conversion is enabled and fails, do not silently fallback unless the UI/API response makes the fallback explicit.

5. Should stale draft recovery ever auto-merge?
   - Recommendation: no automatic merge in the next iteration. Add diff/manual rebase UI first.

## 8. Acceptance Checklist For The Next Engineer

- [ ] `.factory/scene-catalog.json` is resolved or explicitly excluded from the PR.
- [ ] Backend focused and full package tests pass.
- [ ] Frontend logic checks pass.
- [ ] Frontend production build passes.
- [ ] `git diff --check` passes.
- [ ] Manual smoke covers drawer toggles, task execution drawer, task timeline blocks, application project preview, draft save/apply/discard, proposed state, stale recovery.
- [ ] PR description includes the known Phase 7.2 follow-up.
- [ ] No new feature work is added before the stabilization PR unless it fixes a blocking defect.
