# Live Thinking Streaming & Tail Append Design

> Date: 2026-06-27. Reimplements the streaming-thinking UX for the dialogue workbench on `feat-0624`, focused on the new-agent (child clarification) flow.

## Problem

Three observed defects in the new-agent conversation flow:

1. **No "thinking…" placeholder** after send. When a user sends in a continuing/new flow and the model hasn't emitted a thinking delta yet, the workbench shows nothing — it looks frozen.
2. **Raw thinking is not streamed.** It only appears after the round completes, not incrementally.
3. **Streamed thinking/analysis appears after the FIRST user message, not appended to the tail.** In the new-agent flow the live items are inserted before the child clarification thread, so they sit above all the child's history.

## Root Cause

`buildDialogueTimeline` inserts the transient `live_thinking` / `live_analysis` items immediately after the parent thread loop (line ~217) and BEFORE the child clarification thread (`appendChildItems`). In the new-agent flow the child carries the round's persisted analysis/questions, so the live block lands above that history = "after the first user message".

Streaming reachability: the SSE event chain is wired (`LIVE_THINKING_EVENTS` folds into `liveThinking`), but the hook's onEvent must route `*.thinking` through `applyDialogueEvent` (which checks LIVE_THINKING before the default needsRefresh path) rather than treating them as refresh events.

The placeholder gap: a pending live indicator only renders when `!view` (pre-first-view). Once the view is loaded (continuing/new-agent flow), `pendingTurn` exists but no live content → no indicator.

## Design

Scope: frontend only (`sf-portal-mvp/src/hooks/dialogueTimeline.js`, `useDialogueSessions.js`). No backend changes.

### 1. Append live items to the timeline tail

Move the `live_thinking` and `live_analysis` emission to the END of `buildDialogueTimeline`, after route/recommendation/child/business surfaces, just before the resolved-outcome and system-status items. This guarantees streamed content always appears after the latest persisted content.

The D6 suppression (`hasPersistedAnalysis`) is preserved: once the persisted analysis for the current turn lands, the transient live_analysis is suppressed (the folded persisted analysis is authoritative).

### 2. Ensure thinking streams live (not batched)

Verify `useDialogueSessions` onEvent routes `dialogue.*.thinking` types through `applyDialogueEvent`. The reducer already checks `LIVE_THINKING_EVENTS` before the default `needsRefresh` branch, so thinking deltas fold into `liveThinking` incrementally. If the hook short-circuits thinking types into `DIALOGUE_TYPES` (refresh) before `applyDialogueEvent`, fix the ordering so LIVE_THINKING wins.

### 3. "正在思考…" placeholder

`buildDialogueTimeline` accepts the existing `pendingTurn` signal indirectly. Add: when there is an in-flight turn (`pendingTurn` truthy) AND no `liveAnalysis.content` AND no `liveThinking.content`, append a pending `live_thinking` item:

```js
{ id: 'cw_pending_thinking', type: 'live_thinking', content: '正在思考…', summary: '', pending: true, kind: 'round' }
```

The existing `ThinkingSummary` renders this; `pending` can drive the spinner. The placeholder is naturally replaced once a real thinking delta or analysis arrives.

### Testing

`check-conversation-agent-streaming.mjs`:
- live_thinking / live_analysis items appear at the tail (after child persisted content) in a view with child history + live content.
- A pending-turn state with no live content yields a `live_thinking` placeholder item with content "正在思考…".

`check-dialogue-workbench.mjs`:
- Static: workbench source renders the placeholder copy.

## Non-goals

- Backend streaming mechanics (already correct).
- Persisted thinking summary replay (already implemented).
- Business-agent / existing-app flows beyond the shared tail-append fix.
