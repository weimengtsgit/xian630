# Workbench Drawer And Project Documents PR Notes

## Branch State

- Branch: `feat-0624-dazhao`
- HEAD: `2a0c408 fix: block stale document draft editing`
- Remote: `origin/feat-0624-dazhao` at the same commit
- Excluded local change: `.factory/scene-catalog.json`
  - This file is modified locally but is intentionally not part of the workbench/project-docs PR.
  - The diff changes scene catalog surface/order assignments and should be reviewed separately if it is intentional.
- Planning artifact:
  - `docs/superpowers/plans/2026-06-29-post-phase7-stabilization-and-next-work.md`
  - This is a local execution plan and can be committed separately if the team wants to keep it.

## PR Summary Draft

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
- Follow-up Phase 7.2 should link full draft content to the revision job input so large drafts do not depend only on summary/excerpt text.
- Raw task thinking is persisted only in `task_thinking_events` and exposed only through task-thinking hydration/SSE for the conversation UI.

## Verification Results

Fresh verification run on 2026-06-29:

```bash
cd factory-server
go test ./internal/store ./internal/server ./internal/executor ./internal/runner ./internal/projectdocs
```

Result: passed.

```bash
cd factory-server
go test ./...
```

Result: passed.

```bash
cd sf-portal-mvp
npm run test:logic
```

Result: passed.

```bash
cd sf-portal-mvp
npm run build
```

Result: passed.

```bash
git diff --check
```

Result: passed.

## Manual Smoke Results

Local services used:

```bash
curl -sS http://127.0.0.1:8787/healthz
```

Result: `{"ok":true}`. A local factory-server was already bound to `127.0.0.1:8787`; a second startup attempt correctly failed with `bind: address already in use`, so the smoke used the existing healthy server.

```bash
cd sf-portal-mvp
npm run dev -- --host 127.0.0.1 --port 3001
```

Smoke target: `http://127.0.0.1:3001/`

Observed:

- Portal loaded with no browser console errors or warnings.
- Left session navigation was visible and included `新建会话`.
- Center workbench did not show the old inline `当前任务` area.
- Top-right workbench actions were present:
  - `任务执行`
  - `协作智能体`
  - `应用项目`
- `任务执行` opened a single right drawer host.
- Task execution drawer showed vertical execution waves and completed step cards.
- Clicking a step opened step detail inside the same drawer host.
- No old fixed right agent panel was present.
- No old floating collaboration-agent restore button was present.
- `协作智能体` opened the same drawer host and showed the global collaboration-agent list.
- `应用项目` opened the same drawer host and showed:
  - generated app project tree
  - grouped sections for documents, code, config, and factory metadata
  - text/code preview for the selected file
- Application project drawer had no visible project API error.

Manual smoke limitation:

- The local generated app data available in this smoke database did not contain `docs/*.md` or `.factory/project-docs.json` files, so the browser smoke could not manually exercise Markdown draft save/apply/stale recovery.
- Draft workflow behavior is covered by backend handler/store tests and frontend static logic checks in this PR.

## Risk Checklist

- Large PR scope: mitigated by keeping a single vertical-slice PR summary and area-by-area review guidance.
- Full draft fidelity: current revision job consumes deterministic summary/diff excerpt, not full draft content; Phase 7.2 is the explicit follow-up.
- Task thinking sensitivity: task thinking is isolated from work trace, execution records, artifacts, and ordinary dialogue messages.
- Project file safety: path traversal, symlink escapes, denied directories, hidden run/audit output, binary/large files, and generated-app-only access are covered by tests.
- Stale draft safety: stale drafts cannot be saved/applied through normal UI paths; recovery starts from current source after discarding the stale draft.
- Dirty worktree: `.factory/scene-catalog.json` remains excluded from this PR.

## Suggested PR Shape

Keep one integrated PR for Phase 1-7 plus stabilization fixes.

Reasoning:

- The user-facing workflow is one integrated workbench experience.
- Splitting now would create intermediate PRs that compile but do not deliver a coherent conversation/drawer/project-document flow.
- Reviewers can still review by area:
  - layout and drawer
  - task execution and timeline
  - task thinking persistence
  - application project APIs
  - project document projection
  - document draft workflow

## Known Follow-Ups

- Phase 7.2: revision jobs should consume linked full draft content, not only deterministic summary/excerpt.
- LLM-backed document draft converter behind a backend interface.
- Draft diff/manual rebase UI for stale draft recovery.
- Component cleanup for large workbench/project drawer components after behavior is frozen.
