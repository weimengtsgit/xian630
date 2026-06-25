# Chinese Thinking Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project workflow note:** This repository currently uses a NO-GIT implementation workflow unless the user explicitly asks for a commit. Do not run `git add`, `git commit`, `git reset`, `git checkout --`, or `git clean` during implementation. Use read-only git commands only for inspection.

**Goal:** Make the conversation workbench show a Chinese `思考摘要` by default while keeping the raw Claude Code thinking text available only inside a collapsed `原始思考过程` section.

**Architecture:** Keep the dedicated thinking channel unchanged, but change the conversation timeline/UI contract so raw thinking is no longer the first visible body text. The frontend derives a Chinese summary from the neighboring safe analysis stream (`liveAnalysis` / persisted analysis) for the first version; no translation model or backend summarizer is introduced. Raw thinking remains separate from analysis/tool/stdout/stderr and is displayed only when the user expands the original section.

**Tech Stack:** React 18, Vite, plain CSS, existing pure Node check scripts.

## Global Constraints

- Preserve the dedicated thinking channel: Claude Code CLI `thinking` / `thinking_delta` must not be merged into analysis logs, tool summaries, stdout/stderr, or attachments.
- User-visible default thinking surface should be Chinese: label it `思考摘要` and derive text from safe Chinese analysis content when available.
- Raw Claude Code thinking text must remain available only under a collapsed `原始思考过程` section.
- Do not add a translation model, extra API call, or backend summarization in this first version.
- Keep user dialogue thinking visible; task/pipeline step thinking remains hidden from the conversation area per the previous change.
- Do not modify `AgentsPanel` or the 协作智能体 tab layout.
- Keep user-facing product noun as `智能体`; internal entity/API names may remain `应用`.

---

## Target File Map

Modify:

```text
sf-portal-mvp/src/hooks/dialogueTimeline.js
sf-portal-mvp/src/components/ConversationWorkbench.jsx
sf-portal-mvp/src/components/ConversationWorkbench.css
sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs
```

No new runtime dependencies.

---

## Task 1: Add timeline contract for thinking summary

**Files:**
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`

**Interfaces:**
- Consumes: `buildDialogueTimeline(view, optimisticUserMessage, liveAnalysis, liveThinking, workTraceItems)`.
- Produces: `live_thinking` timeline items with:
  - `content`: raw original thinking text.
  - `summary`: safe Chinese summary text derived from `liveAnalysis.content` when available.
  - `kind`: existing `round` / `step` value, though step thinking should not be passed by current hook.

- [ ] **Step 1: Write the failing check**

In `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`, extend the existing live thinking block near the current `liveThinkTimeline` assertion:

```js
const liveThinkTimeline = buildDialogueTimeline(
  null,
  { id: 'opt_t', content: 'hi' },
  { key: 'turn:t1', content: '已识别为员工请假审批流程，需要确认审批层级和假期余额来源。', kind: 'round' },
  { key: 'thinking:t1', content: 'The model is reasoning in English...', kind: 'round' },
)
const liveThinkItem = liveThinkTimeline.find(it => it.type === 'live_thinking')
assert.ok(liveThinkItem, 'liveThinking renders a live_thinking item')
assert.equal(liveThinkItem.content, 'The model is reasoning in English...', 'raw thinking content is preserved for original view')
assert.equal(
  liveThinkItem.summary,
  '已识别为员工请假审批流程，需要确认审批层级和假期余额来源。',
  'live_thinking exposes a Chinese summary from the safe live analysis text',
)
```

Also add a fallback assertion for thinking with no analysis yet:

```js
const noSummaryTimeline = buildDialogueTimeline(
  null,
  { id: 'opt_t2', content: 'hi' },
  null,
  { key: 'thinking:t2', content: 'Still thinking in English...', kind: 'round' },
)
const noSummaryThinking = noSummaryTimeline.find(it => it.type === 'live_thinking')
assert.equal(noSummaryThinking.summary, '', 'no analysis means no fabricated Chinese summary')
```

- [ ] **Step 2: Run the check and verify RED**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && node scripts/check-conversation-agent-streaming.mjs
```

Expected: fail because `live_thinking.summary` is currently missing.

- [ ] **Step 3: Add `summary` to pre-view live thinking items**

In `sf-portal-mvp/src/hooks/dialogueTimeline.js`, in the `if (!view)` branch where `liveThinking` is pushed, change the item shape to include a `summary` field:

```js
items.push({
  id: `livethink_${safeString(liveThinking.key)}`,
  type: 'live_thinking',
  content: safeString(liveThinking.content),
  summary: safeString(la && liveAnalysis && liveAnalysis.content ? liveAnalysis.content : ''),
  kind: liveThinking.kind === 'step' ? 'step' : 'round',
})
```

Use the already-created `la` / `liveAnalysis` values in that branch. The summary must come only from safe analysis text, not from raw thinking.

- [ ] **Step 4: Add `summary` to normal-view live thinking items**

In the main `liveThinking` block in `buildDialogueTimeline`, add:

```js
summary: liveAnalysis && liveAnalysis.content ? safeString(liveAnalysis.content) : '',
```

The resulting item should look like:

```js
items.push({
  id: `livethink_${safeString(liveThinking.key)}`,
  type: 'live_thinking',
  content: safeString(liveThinking.content),
  summary: liveAnalysis && liveAnalysis.content ? safeString(liveAnalysis.content) : '',
  kind: liveThinking.kind === 'step' ? 'step' : 'round',
})
```

- [ ] **Step 5: Run the check and verify GREEN**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && node scripts/check-conversation-agent-streaming.mjs
```

Expected: pass through the live thinking summary assertions.

---

## Task 2: Render Chinese thinking summary and collapsed raw original

**Files:**
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`

**Interfaces:**
- Consumes: `live_thinking` item with `summary` and raw `content`.
- Produces: UI block with visible title `思考摘要`, optional summary text, and collapsed raw original section titled `原始思考过程`.

- [ ] **Step 1: Write the failing static/render contract check**

In `sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs`, after reading `ConversationWorkbench.jsx` source, add:

```js
assert.match(workbenchSrc3, /ThinkingSummary/, 'ConversationWorkbench must render live_thinking through ThinkingSummary')
assert.match(workbenchSrc3, /思考摘要/, 'thinking summary UI must use the 思考摘要 label')
assert.match(workbenchSrc3, /原始思考过程/, 'raw thinking must be behind an 原始思考过程 disclosure')
assert.match(workbenchSrc3, /<details[\s\S]*<summary[\s\S]*原始思考过程/, 'raw thinking should be collapsed by default in a details disclosure')
```

- [ ] **Step 2: Run the check and verify RED**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && node scripts/check-conversation-agent-streaming.mjs
```

Expected: fail because `ThinkingSummary` and the new labels do not exist yet.

- [ ] **Step 3: Route `live_thinking` through `ThinkingSummary`**

In `sf-portal-mvp/src/components/ConversationWorkbench.jsx`, replace the current `live_thinking` branch:

```jsx
if (item.type === 'live_thinking') {
  return (
    <CopyableMessage className="cw-item cw-agent cw-live-thinking" copyText={item.content}>
      <span className="cw-item-label"><Loader2 size={12} className="cw-spin" />思考过程</span>
      <pre className="cw-live-text">{item.content}</pre>
    </CopyableMessage>
  )
}
```

with:

```jsx
if (item.type === 'live_thinking') {
  return <ThinkingSummary item={item} />
}
```

- [ ] **Step 4: Add `ThinkingSummary` component**

In `ConversationWorkbench.jsx`, near `FoldedAnalysis` / `CopyableMessage`, add:

```jsx
function ThinkingSummary({ item }) {
  const summary = String(item.summary || '').trim()
  const raw = String(item.content || '').trim()
  const copyText = summary || raw
  return (
    <CopyableMessage className="cw-item cw-agent cw-live-thinking cw-thinking-summary" copyText={copyText}>
      <span className="cw-item-label"><Loader2 size={12} className="cw-spin" />思考摘要</span>
      {summary ? (
        <pre className="cw-live-text cw-thinking-summary-text">{summary}</pre>
      ) : (
        <p className="cw-thinking-summary-empty">中文摘要将在分析过程生成后显示。</p>
      )}
      {raw ? (
        <details className="cw-raw-thinking">
          <summary>原始思考过程</summary>
          <pre className="cw-live-text">{raw}</pre>
        </details>
      ) : null}
    </CopyableMessage>
  )
}
```

This keeps raw thinking visible only after the user expands `details`. It also keeps copying useful by copying the Chinese summary when present, or raw text only when no summary exists.

- [ ] **Step 5: Add CSS**

In `sf-portal-mvp/src/components/ConversationWorkbench.css`, append near existing `.cw-live-thinking` rules:

```css
.cw-thinking-summary .cw-item-label { color: rgba(180, 220, 255, 0.88); }
.cw-thinking-summary-text { color: rgba(215, 238, 248, 0.82); font-style: normal; }
.cw-thinking-summary-empty { margin: 0; color: rgba(215, 238, 248, 0.58); font-size: 12px; }
.cw-raw-thinking { margin-top: 6px; border-top: 1px solid rgba(111, 218, 255, 0.12); padding-top: 6px; }
.cw-raw-thinking summary { cursor: pointer; color: rgba(180, 200, 214, 0.72); font-size: 11px; }
.cw-raw-thinking .cw-live-text { margin-top: 6px; color: rgba(170, 196, 214, 0.68); font-style: italic; }
```

- [ ] **Step 6: Run check and build**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && node scripts/check-conversation-agent-streaming.mjs && npm run build
```

Expected: both pass.

---

## Task 3: Full portal logic verification and review

**Files:**
- No new production files beyond Tasks 1-2.

**Interfaces:**
- Confirms existing portal logic checks still pass with the new thinking summary presentation.

- [ ] **Step 1: Run portal logic suite**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && npm run test:logic
```

Expected: all logic checks pass, including `check-conversation-agent-streaming.mjs` and `check-dialogue-workbench.mjs`.

- [ ] **Step 2: Run production build**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp && npm run build
```

Expected: Vite build completes with exit code 0.

- [ ] **Step 3: Run whitespace check**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630 && git diff --check
```

Expected: no output.

- [ ] **Step 4: Review changed files**

Inspect:

```bash
cd /Users/mengwei/ww/Developer/xian630 && git diff -- sf-portal-mvp/src/hooks/dialogueTimeline.js sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/scripts/check-conversation-agent-streaming.mjs
```

Expected review points:

- `思考摘要` is the default visible label.
- Raw English thinking is inside collapsed `details` / `原始思考过程`.
- No backend translation model was added.
- No thinking content is mixed into analysis/tool/stdout/stderr.
- Task/pipeline step thinking remains absent from the conversation area.

---

## Self-Review

- Spec coverage: The plan implements the approved scheme C: default Chinese thinking summary, raw thinking collapsed, no translation model, dedicated channel preserved.
- Placeholder scan: No TBD/TODO/fill-in placeholders remain.
- Type consistency: `summary` is added to `live_thinking` items and consumed only by `ThinkingSummary`; `content` remains raw original thinking text.
- Scope: Frontend-only first version; no backend summarizer or translation API is introduced.
