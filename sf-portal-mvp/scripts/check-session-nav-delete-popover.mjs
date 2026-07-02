// Task 8 (delete-confirmation popover anchored near the delete button) layout
// check.
//
// Before Task 8 the SessionNav delete-confirm (.session-nav-delete-confirm) was
// a hard-anchored BOTTOM bar of the .session-nav rail — the same fixed position
// regardless of which row's delete was clicked, with no click/row tracking
// (SessionNav.css ~lines 235-243: position:absolute; left:0; right:0; bottom:0).
// That matched the glossary 会话删除确认浮层 _Avoid_ item "固定底部确认条".
//
// Task 8 replaces it with a SMALL popover anchored to the clicked ROW:
//   - .session-nav-row is already position:relative (the positioning context).
//   - The confirm card renders INSIDE the pending row (gated on pendingDelete
//     matching that row's session id), so it anchors per-row.
//   - requestDelete captures the click event target; if the row is near the
//     viewport bottom (space below < POPOVER_FLIP_BUDGET) a `flip-up` class
//     opens the popover ABOVE the row so it never overflows the viewport
//     (glossary: clamped to rail).
//   - Still no window.confirm, still a two-step cancel/confirm interaction,
//     still lightweight.
//
// This script pins the NEW layout MEANINGFULLY (not deleted to force green):
//   1. The old rail-bottom bar rule is GONE (no bottom:0;left:0;right:0 on
//      .session-nav-delete-confirm).
//   2. A per-row anchor exists: the confirm renders inside .session-nav-row,
//      gated on the row's session id; .session-nav-row is position:relative.
//   3. The popover is absolutely positioned relative to the row, with a
//      flip-up variant for viewport clamping.
//   4. No window.confirm anywhere in SessionNav source.
//   5. The click target is captured to decide flip direction.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

const sessionJsx = read('../src/components/SessionNav.jsx')
const sessionCss = read('../src/components/SessionNav.css')

// 1. The old rail-bottom bar rule is GONE. The pre-Task-8 rule was a single
//    declaration block that stretched across the WHOLE rail AND pinned to the
//    bottom: bottom:0 AND left:0 AND right:0 together. That combination is the
//    glossary 会话删除确认浮层 _Avoid_ "固定底部确认条". It must not reappear.
//    (A right-aligned popover anchored at the row's right edge is fine and is
//    the new intended layout — only the full-width rail-bottom bar is forbidden.)
const confirmBlockMatch = sessionCss.match(/\.session-nav-delete-confirm\s*\{([\s\S]*?)\}/)
assert(confirmBlockMatch, '.session-nav-delete-confirm rule must exist in SessionNav.css')
const confirmBlock = confirmBlockMatch[1]
assert.doesNotMatch(confirmBlock, /bottom:\s*0\b/, '.session-nav-delete-confirm must NOT pin to the rail bottom (old fixed-bottom bar)')
assert.doesNotMatch(confirmBlock, /left:\s*0\b[\s\S]*right:\s*0\b|right:\s*0\b[\s\S]*left:\s*0\b/, '.session-nav-delete-confirm must NOT stretch full rail width (left:0 AND right:0 = old fixed-bottom bar)')

// 2. The popover is absolutely positioned (so it anchors to the relative row,
//    not to the rail or the normal flow) and is a SMALL card anchored to the
//    row's right edge (where the delete button sits), width-capped so it is a
//    popover, not a full-width bar.
assert.match(confirmBlock, /position:\s*absolute/, '.session-nav-delete-confirm must be position:absolute (anchored to the relative row)')
assert.match(confirmBlock, /right:\s*0\b/, '.session-nav-delete-confirm must anchor to the row right edge (near the delete button)')
assert.match(confirmBlock, /width:\s*min\(/, '.session-nav-delete-confirm must be width-capped (a small popover, not a full-width bar)')

// 3. A flip-up variant exists for viewport clamping: when the clicked row is
//    near the viewport bottom the popover opens ABOVE the row.
assert.match(sessionCss, /\.session-nav-delete-confirm\.flip-up\s*\{[\s\S]*?bottom:\s*100%/, 'a .flip-up variant must anchor the popover above the row (bottom:100%) for viewport clamping')

// 4. .session-nav-row is the positioning context (relative) — the popover
//    anchors to the clicked row, not the rail.
assert.match(sessionCss, /\.session-nav-row\s*\{[\s\S]*?position:\s*relative/, '.session-nav-row must be position:relative so the popover anchors per-row')

// 5. The confirm card renders INSIDE the row, gated on the row's session id —
//    i.e. the popover is per-row, not a single rail-level block.
assert.match(sessionJsx, /session-nav-row[\s\S]*pendingDelete && \(pendingDelete\.session && pendingDelete\.session\.id\) === sess\.id[\s\S]*session-nav-delete-confirm/, 'the confirm popover must render inside the pending row (gated on the row session id)')

// 6. The click target is captured to decide flip direction (per-row anchoring
//    requires knowing which row was clicked and where it sits).
assert.match(sessionJsx, /requestDelete\(entry, e\)|requestDelete\(entry, clickEvent\)/, 'requestDelete must receive the click event to measure the clicked row position')
assert.match(sessionJsx, /getBoundingClientRect/, 'requestDelete must measure the click target via getBoundingClientRect for viewport-clamp decision')
assert.match(sessionJsx, /flipUp|flip-up/, 'SessionNav must track a flip direction for the popover (flip-up when near viewport bottom)')

// 7. No window.confirm anywhere in SessionNav (glossary hard negative).
assert.doesNotMatch(sessionJsx, /window\.confirm\s*\(/, 'SessionNav must NOT use window.confirm (glossary 会话删除确认浮层 _Avoid_)')

// 8. Two-step cancel/confirm interaction preserved (glossary: lightweight, but
//    still a confirm step — not a one-click destructive action).
assert.match(sessionJsx, /session-nav-delete-cancel/, 'popover must keep a cancel action (two-step interaction)')
assert.match(sessionJsx, /session-nav-delete-danger/, 'popover must keep a confirm-delete action (two-step interaction)')

console.log('check-session-nav-delete-popover: confirm is a row-anchored popover (no rail-bottom bar); flip-up clamps to viewport; no window.confirm; two-step interaction kept.')
