# Dialogue Task Information Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the selected application's name once in the Conversation Workbench header and keep the Current Task title action-oriented.

**Architecture:** `ConversationWorkbench` derives its header title from the selected dialogue view, preferring the resolved application's durable name. `displayJobTitle` stops treating `job.app_name` as a task label, so JobCenter continues to render the selected focus task without repeating the header's application identity.

**Tech Stack:** React 18, Vite, Node static logic checks.

---

## File structure

- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx` — derive the header's display title from `view.resolvedApplication` with the existing dialogue title as fallback.
- Modify: `sf-portal-mvp/src/hooks/jobSelection.js` — make task-title priority prompt/action based and exclude `app_name`.
- Modify: `sf-portal-mvp/scripts/check-visible-work-trace.mjs` — protect both display rules through static logic checks.

### Task 1: Separate application identity from task action

**Files:**

- Modify: `sf-portal-mvp/scripts/check-visible-work-trace.mjs`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/hooks/jobSelection.js`

- [ ] **Step 1: Write the failing logic checks.**

Add the following checks after the existing focus-task assertions:

```js
const jobSelectionJs = readFileSync(new URL('../src/hooks/jobSelection.js', import.meta.url), 'utf8')
assert.match(workbenchJsx, /resolvedApplication.*name|applicationHeaderTitle/, 'workbench header must prefer the resolved application name')
assert.doesNotMatch(jobSelectionJs, /job\.app_name\s*\|\|/, 'task title must not fall back to job.app_name')
```

- [ ] **Step 2: Run the logic suite and verify the new checks fail.**

Run:

```bash
cd sf-portal-mvp && npm run test:logic
```

Expected: `check-visible-work-trace.mjs` fails because the workbench header still calls `titleForDialogue(session)` directly and `displayJobTitle` still prioritizes `job.app_name`.

- [ ] **Step 3: Implement the smallest display-rule change.**

In `ConversationWorkbench`, derive the title before render and use it in the header:

```js
const resolvedApplication = view && view.resolvedApplication
const applicationHeaderTitle = resolvedApplication &&
  (resolvedApplication.name || resolvedApplication.slug)
const workbenchTitle = applicationHeaderTitle || (session ? titleForDialogue(session) : '新会话')
```

```jsx
<strong>{workbenchTitle}</strong>
```

In `displayJobTitle`, remove `job.app_name ||` while keeping the remaining prompt/action fallbacks in their existing order:

```js
return (
  job.normalized_prompt ||
  job.user_prompt ||
  job.prompt ||
  job.title ||
  job.id ||
  '未命名任务'
)
```

- [ ] **Step 4: Run frontend verification.**

Run:

```bash
cd sf-portal-mvp && npm run test:logic && npm run build
```

Expected: all logic checks pass and Vite completes production build without warnings.

- [ ] **Step 5: Commit the focused UI change.**

```bash
git add sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/hooks/jobSelection.js sf-portal-mvp/scripts/check-visible-work-trace.mjs
git commit -m "fix: separate dialogue app and task titles"
```

## Self-review

- Spec coverage: Task 1 implements the resolved-app header title, prompt-based task title, and preserves all non-title UI behavior.
- Placeholder scan: no incomplete implementation steps or unspecified validation remain.
- Type consistency: `resolvedApplication` is already part of the composed dialogue view; no API, store, or scheduler type changes are required.
