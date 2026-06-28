# Fixed From 0624 Reimplementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reimplement selected `fixed-from0624` user-facing improvements on top of current `feat-0624` without merging or overwriting current work.

**Architecture:** Implement features incrementally in the current code shape. Do not cherry-pick whole commits or replace files from `fixed-from0624`; use that branch only as a reference. Start with the lowest-risk feature: Codex-style copy buttons below conversation items.

**Tech Stack:** React/Vite portal (`sf-portal-mvp`), existing Node static logic checks.

## Global Constraints

- Current branch is `feat-0624`; do not merge or reset to `fixed-from0624`.
- Preserve current product wording: generated products are “智能体”; do not reintroduce “应用” user-facing nouns.
- Preserve current dialogue/clarification/work-trace behavior, including naval judgement clarification, managed agents, job.updated refresh, and business-agent card refinements.
- NO wholesale file replacement from `fixed-from0624`.
- Follow TDD: add failing checks before implementation.
- Git commits are allowed only when explicitly requested by the user; otherwise leave working-tree changes.

---

## File Structure

- Modify `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
  - Adds a small reusable copy action rendered under text-like conversation items.
  - Uses browser clipboard with a textarea fallback.
- Modify `sf-portal-mvp/src/components/ConversationWorkbench.css`
  - Adds Codex-style subtle copy action row below each copied block.
- Modify `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`
  - Static checks that the copy affordance exists, uses clipboard/fallback, and is rendered below text items.

---

### Task 1: Codex-style copy action below dialogue items

**Files:**
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Test: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`

**Interfaces:**
- Consumes: existing `TimelineItem`, `FoldedAnalysis`, `RequirementSummary`, and text item shapes from `dialogueTimeline.js`.
- Produces: `CopyableBlock` React component and `copyText(text)` helper used only inside `ConversationWorkbench.jsx`.

- [ ] **Step 1: Add failing static checks**

In `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`, add checks near the other static source checks:

```js
assert.match(workbenchJsx, /function CopyableBlock\(/, 'workbench must define CopyableBlock for Codex-style copy actions')
assert.match(workbenchJsx, /navigator\.clipboard\.writeText/, 'copy action must use navigator.clipboard.writeText when available')
assert.match(workbenchJsx, /document\.execCommand\('copy'\)/, 'copy action must include a textarea fallback')
assert.match(workbenchJsx, /cw-copy-row/, 'copy action must render below message content')
assert.match(workbenchCss, /\.cw-copy-row/, 'copy action row must have dedicated styling')
assert.match(workbenchCss, /\.cw-copy-button/, 'copy button must have dedicated styling')
```

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && node scripts/check-dialogue-workbench.mjs
```

Expected: FAIL because `CopyableBlock` and copy styles do not exist.

- [ ] **Step 2: Add copy helper and wrapper component**

In `sf-portal-mvp/src/components/ConversationWorkbench.jsx`, add `Copy` and `Check` icons if `Copy` is not already imported from `lucide-react`. Add below `ConversationWorkbench` or above `TimelineItem`:

```jsx
async function copyText(text) {
  const value = String(text || '')
  if (!value) return false
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value)
    return true
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
    return true
  } finally {
    document.body.removeChild(textarea)
  }
}

function CopyableBlock({ text, children, className = '', copyLabel = '复制' }) {
  const [copied, setCopied] = useState(false)
  const value = String(text || '')
  const doCopy = async () => {
    if (!value) return
    try {
      const ok = await copyText(value)
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (_) {
      setCopied(false)
    }
  }
  return (
    <div className={`cw-copyable ${className}`.trim()}>
      {children}
      <div className="cw-copy-row">
        <button type="button" className="cw-copy-button" onClick={doCopy} disabled={!value} title={copied ? '已复制' : copyLabel}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : copyLabel}</span>
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wrap text-like timeline items**

In `TimelineItem`, wrap plain text items so the copy row appears below content:

```jsx
if (item.type === 'user_message') {
  return (
    <CopyableBlock text={item.content} className="cw-user-wrap">
      <div className="cw-item cw-user">{item.content}</div>
    </CopyableBlock>
  )
}
if (item.type === 'agent_message') {
  return (
    <CopyableBlock text={item.content} className="cw-agent-wrap">
      <div className="cw-item cw-agent">{item.content}</div>
    </CopyableBlock>
  )
}
```

For live analysis and thinking, wrap the displayed text similarly, preserving existing inner markup:

```jsx
return (
  <CopyableBlock text={item.content} className="cw-agent-wrap" copyLabel="复制过程">
    <div className={`cw-item cw-agent cw-live-analysis...`}>...</div>
  </CopyableBlock>
)
```

In `FoldedAnalysis`, when expanded, place the folded block inside `CopyableBlock` with `text` set to the full analysis content. If folded, the copy button may still be shown below the folded container and copy full text.

- [ ] **Step 4: Add CSS styling**

In `sf-portal-mvp/src/components/ConversationWorkbench.css`, add:

```css
.cw-copyable {
  display: flex;
  flex-direction: column;
  max-width: 86%;
}

.cw-user-wrap {
  align-self: flex-end;
  align-items: flex-end;
}

.cw-agent-wrap {
  align-self: flex-start;
  align-items: flex-start;
}

.cw-copyable .cw-item {
  max-width: 100%;
}

.cw-copy-row {
  display: flex;
  margin-top: 3px;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.16s ease;
}

.cw-copyable:hover .cw-copy-row,
.cw-copyable:focus-within .cw-copy-row {
  opacity: 1;
}

.cw-copy-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  color: rgba(215, 238, 248, 0.56);
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}

.cw-copy-button:hover:not(:disabled),
.cw-copy-button:focus-visible:not(:disabled) {
  color: #68ddff;
  background: rgba(104, 221, 255, 0.1);
  outline: none;
}

.cw-copy-button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
```

- [ ] **Step 5: Verify targeted check**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && node scripts/check-dialogue-workbench.mjs
```

Expected: PASS.

- [ ] **Step 6: Run full frontend logic tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && npm run test:logic
```

Expected: PASS.

---

### Task 2: Assess and reimplement persistent Chinese thinking summary

**Files:**
- Inspect first: `factory-server/internal/server/dialogue_handlers.go`, `factory-server/internal/server/clarification_handlers.go`, `factory-server/internal/store/work_traces.go`, `sf-portal-mvp/src/hooks/workTraceState.js`, `sf-portal-mvp/src/hooks/dialogueTimeline.js`, `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify only if a concrete missing behavior is found.

**Interfaces:**
- Consumes: current `dialogue.clarification.thinking`, `liveThinking`, `workTrace` event model.
- Produces: a minimal persistent summary path only if current branch loses summaries after refresh.

- [ ] **Step 1: Audit current behavior against fixed-from0624**

Use read-only commands:

```bash
git show --stat 3ea0a40
git show 3ea0a40 -- factory-server/internal/server/dialogue_handlers.go sf-portal-mvp/src/hooks/workTraceState.js sf-portal-mvp/src/components/ConversationWorkbench.jsx
```

Compare with current files. Document whether current `feat-0624` already supports the behavior.

- [ ] **Step 2: If missing, add failing tests before edits**

Add tests only for an observed gap. Do not copy fixed-from0624 files wholesale.

- [ ] **Step 3: Implement minimal fix and run**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server && go test -count=1 ./internal/server ./internal/store
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && npm run test:logic
```

---

### Task 3: Assess streaming clarification gap

**Files:**
- Inspect: fixed commit `bdaebf9` vs current dialogue/clarification event flow.
- Modify only if a concrete missing behavior is found.

**Interfaces:**
- Consumes: current `dialogue.clarification.delta`, `dialogue.clarification.thinking`, `clarification_prompt`, `question_group`, `liveAnalysis`, `liveThinking`.
- Produces: no change if current branch already supersedes fixed branch behavior.

- [ ] **Step 1: Compare fixed commit behavior with current code**

Run read-only:

```bash
git show --stat bdaebf9
git show bdaebf9 -- sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs sf-portal-mvp/src/hooks/useDialogueSessions.js sf-portal-mvp/src/hooks/dialogueTimeline.js factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/clarification_handlers.go
```

- [ ] **Step 2: Identify missing user-visible behaviors**

Only implement missing behavior that the current branch does not already have.

- [ ] **Step 3: Add failing tests and implement minimal changes**

Run the relevant Go and Node tests after each change.

---

## Self-Review

- Scope is decomposed: Task 1 is safe and independent; Tasks 2–3 are audit-first to avoid overwriting current code.
- No direct cherry-pick or file replacement is allowed.
- The plan intentionally avoids committing unless the user requests it.
