// Pure-logic + static checks for the continuous-conversation workbench trace
// surface (Task 7). Runs under node with NO React import. It exercises the
// workTraceState pure reducer (ordering, isolation, dedup) and asserts static
// source invariants for the new per-dialogue SSE helper, the 202 ack contract,
// the focus-task selector, and the started_at display.
//
// Contracts (FIXED backend, do not change):
//   - GET  /api/dialogues/:id/work-trace?afterSequence=N       -> ascending rows
//   - GET  /api/dialogues/:id/work-trace/stream?afterSequence=N -> SSE (id=sequence)
//   - POST /api/dialogues/:id/messages -> 202 {dialogueId,turnId,acceptedAt} on a
//     CONTINUING session; 200 view otherwise.
//   - POST /api/dialogues/:id/turns/:turnId/cancel
//   - POST /api/apps/:id/rollback              (confirm-gated)
//   - Jobs carry started_at (actual exec start) distinct from created_at (queue).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  initialWorkTraceState,
  applyTraceEvent,
} from '../src/hooks/workTraceState.js'
import { resolveWorkbenchTitle } from '../src/hooks/dialogueTimeline.js'
import { displayJobTitle } from '../src/hooks/jobSelection.js'

// ---- reducer: ordering, isolation, dedup (the verbatim brief test) -----------

let state = initialWorkTraceState()
state = applyTraceEvent(state, { dialogueId: 'dlg_1', sequence: 2, type: 'tool.completed', payload: { tool: 'Read' } })
state = applyTraceEvent(state, { dialogueId: 'dlg_1', sequence: 1, type: 'intent.recognized', payload: {} })
assert.deepEqual(state.items.map(item => item.sequence), [1, 2], 'events must order by sequence ascending regardless of arrival')
assert.equal(
  applyTraceEvent(state, { dialogueId: 'dlg_2', sequence: 1, type: 'task.started', payload: {} }),
  state,
  'an event whose dialogueId differs from the selected dialogue must leave state UNCHANGED (isolation)',
)

// ---- dedup by sequence ------------------------------------------------------

// A replayed sequence must NOT duplicate an already-folded event.
const before = state.items.length
state = applyTraceEvent(state, { dialogueId: 'dlg_1', sequence: 2, type: 'tool.completed', payload: { tool: 'Read' } })
assert.equal(state.items.length, before, 'a duplicate sequence must be deduped, not appended')

// ---- highest-sequence cursor advances --------------------------------------

// The reducer tracks the highest sequence folded so the SSE helper can resume
// after a reconnect/gap. Folding a higher sequence advances it; a lower one
// (already seen) does not regress it.
assert.equal(state.highestSequence, 2, 'highestSequence must reflect the largest folded sequence')
state = applyTraceEvent(state, { dialogueId: 'dlg_1', sequence: 5, type: 'task.completed', payload: {} })
assert.equal(state.highestSequence, 5, 'folding a higher sequence advances highestSequence')
state = applyTraceEvent(state, { dialogueId: 'dlg_1', sequence: 3, type: 'task.started', payload: {} })
assert.equal(state.highestSequence, 5, 'a lower sequence must not regress highestSequence (out-of-order replay)')

// ---- hydration (bulk) sets the cursor without breaking isolation -----------

let hydrated = initialWorkTraceState()
hydrated = applyTraceEvent(hydrated, { dialogueId: 'dlg_1', sequence: 7, type: 'task.completed', payload: {} })
assert.equal(hydrated.highestSequence, 7, 'hydration must advance the cursor to the max sequence')

// ---- static source checks ---------------------------------------------------

const clientJs = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const eventsJs = readFileSync(new URL('../src/api/events.js', import.meta.url), 'utf8')
const useDialogueJs = readFileSync(new URL('../src/hooks/useDialogueSessions.js', import.meta.url), 'utf8')
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const jobCenterJsx = readFileSync(new URL('../src/components/JobCenter.jsx', import.meta.url), 'utf8')
const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

// The client MUST expose the new endpoints.
assert.match(clientJs, /getDialogueTrace/, 'client must expose getDialogueTrace (REST replay)')
assert.match(clientJs, /cancelDialogueTurn/, 'client must expose cancelDialogueTurn')
assert.match(clientJs, /rollbackApp/, 'client must expose rollbackApp (confirm-gated)')
assert.match(clientJs, /work-trace/, 'client must hit the work-trace path')

// sendDialogueMessage must NOT break on a 202 with no view body — it returns the
// ack. The 202 path is the CONTINUING-session contract; a 200 still returns the
// composed view. Both branches must be reachable without throwing.
assert.match(clientJs, /202|StatusAccepted|accepted/, 'sendDialogueMessage must handle the 202 ack path')
assert.match(
  clientJs,
  /turnId|dialogueId.*acceptedAt|acceptedAt/,
  'the 202 path must surface the ack fields (dialogueId/turnId/acceptedAt)',
)

// Per-dialogue SSE helper (Constraint #7: detailed trace events come ONLY via the
// dialogueId-filtered stream — NOT the global /api/events).
assert.match(eventsJs, /subscribeDialogueTrace/, 'events module must expose a per-dialogue subscribeDialogueTrace helper')
assert.match(eventsJs, /work-trace\/stream/, 'the per-dialogue helper must open the work-trace/stream EventSource')
assert.match(eventsJs, /afterSequence/, 'the helper must accept an afterSequence cursor for replay/reconnect')

// The continuous-workbench UI surfaces the new controls.
assert.match(workbenchJsx, /已生效，可继续描述修改需求/, 'after a version deploys, render the vN already-effective hint')
assert.match(workbenchJsx, /取消本轮|cancel.*turn|onCancelTurn/, 'workbench must render a cancel-current-turn control')
assert.match(workbenchJsx, /pending.*turn|turnId|本轮.*处理中|处理中.*轮/, 'workbench must render a pending-turn indicator')
assert.match(workbenchJsx, /变更.*确认|change.*confirm|onConfirmChange/, 'workbench must render a change-summary confirmation control')
assert.match(workbenchJsx, /回滚|rollback|onRollback/, 'workbench must render a rollback control (confirm-gated)')
assert.match(workbenchJsx, /归档|archive|onArchive/, 'workbench must render an archive control')

// JobCenter shows started_at (actual exec start) SEPARATELY from queue time
// (created_at) — Constraint #10.
assert.match(jobCenterJsx, /started_at|开始执行/, 'JobCenter must show started_at as 开始执行')
assert.match(jobCenterJsx, /created_at|排队时间|创建时间/, 'JobCenter must keep created_at (queue time) distinct from started_at')

// The focus-task selector exists and prefers active jobs, else newest terminal.
const focusTaskJs = readFileSync(new URL('../src/hooks/focusTask.js', import.meta.url), 'utf8')
assert.match(focusTaskJs, /selectFocusTask/, 'a focus-task selector (selectFocusTask) must exist')
assert.equal(resolveWorkbenchTitle({ resolvedApplication: { name: '航迹复盘', slug: 'track-replay' } }, { initial_prompt: '旧需求' }), '航迹复盘')
assert.equal(resolveWorkbenchTitle({ resolvedApplication: { slug: 'track-replay' } }, { initial_prompt: '旧需求' }), 'track-replay')
assert.equal(resolveWorkbenchTitle({}, { initial_prompt: '旧需求' }), '旧需求')
assert.equal(resolveWorkbenchTitle({}, null), '新会话')
assert.equal(displayJobTitle({ app_name: '航迹复盘', user_prompt: '将阈值改为 150 海里', id: 'job_1' }), '将阈值改为 150 海里')
assert.equal(displayJobTitle({ app_name: '航迹复盘', id: 'job_1' }), 'job_1')
assert.match(workbenchJsx, /resolveWorkbenchTitle\(view,\s*session\)/, 'workbench must resolve its header title through the pure helper')

// The selected dialogue owns the task panel. It must not be a separate
// workbench sibling driven by the global display-job selector: selecting a
// history dialogue must immediately change the task context and its actions.
assert.match(workbenchJsx, /taskPanel/, 'ConversationWorkbench must render its focus-task panel internally')
assert.match(appJsx, /taskPanel=\{[\s\S]*focusTask/, 'App must pass a dialogue focusTask-driven task panel into the workbench')
assert.doesNotMatch(appJsx, /<JobCenter\s+activeJob=\{jobs\.activeJob\}/, 'JobCenter must not remain a global task panel outside the dialogue workbench')

// WorkTraceList (执行轨迹) is collapsible like FoldedAnalysis: a fold toggle
// with an expand/collapse hint, defaulting collapsed, plus a live step count in
// the header so a collapsed trace still signals in-flight progress.
const workTraceFn = workbenchJsx.match(/function WorkTraceList[\s\S]*?\n\/\//)
assert.ok(workTraceFn, 'WorkTraceList component must exist')
assert.match(workTraceFn[0], /cw-fold-toggle/, 'WorkTraceList (执行轨迹) must be collapsible via a fold toggle')
assert.match(workTraceFn[0], /list\.length/, 'collapsed WorkTraceList header must show a live step count')

// The composer must stay active in the continuous loop once a job is seeded for
// the dialogue (queued/running/completed), not ONLY when an app is deployed and
// running — otherwise the composer locks right after generation (route_locked,
// versionDeployed still false) and the user can't iterate on the result.
assert.match(workbenchJsx, /seededJob/, 'ConversationWorkbench must read view.seededJob for the continuous-loop unlock')
assert.match(workbenchJsx, /continuousLoop/, 'ConversationWorkbench must derive a continuousLoop flag from the seeded job status')
assert.match(workbenchJsx, /composerActive/, 'ConversationWorkbench composer gate must use composerActive (versionDeployed || continuousLoop)')
const submitTextMatch = workbenchJsx.match(/const submitText = async \(\) => \{[\s\S]*?\n  \}/)
assert.ok(submitTextMatch, 'ConversationWorkbench must define submitText')
assert.match(
  submitTextMatch[0],
  /locked\s*&&\s*!composerActive/,
  'submitText must allow sending when the continuous-loop composer is visible despite a locked/resolved session',
)
assert.match(useDialogueJs, /dialogue\.turn\.completed/, 'useDialogueSessions must route completed turn events from global SSE')
assert.match(useDialogueJs, /dialogue\.turn\.failed/, 'useDialogueSessions must route failed turn events from global SSE')
assert.match(useDialogueJs, /dialogue\.turn\.canceled/, 'useDialogueSessions must route canceled turn events from global SSE')
assert.match(
  useDialogueJs,
  /TERMINAL_TURN_TYPES[\s\S]*setPendingTurn\(null\)/,
  'terminal turn events must clear the pending-turn indicator; inquiry turns do not emit work-trace rows',
)

console.log('check-visible-work-trace: OK')
