// Pure work-trace reducer. NO React imports — exercised by the node-assert logic
// harness (scripts/check-visible-work-trace.mjs) in addition to being consumed by
// useDialogueSessions.js.
//
// The reducer folds work-trace events for the SELECTED dialogue into an
// ascending, deduped item list and tracks the highest sequence folded (the
// resume cursor for the per-dialogue SSE stream). It is deliberately pure and
// deterministic: the SAME event sequence yields the SAME state regardless of
// call timing.
//
// Contracts:
//   - An event whose `dialogueId` differs from the selected dialogue leaves
//     state UNCHANGED (isolation — Constraint #7: the stream is dialogue-scoped).
//   - Items are ordered by `sequence` ascending regardless of arrival order
//     (out-of-order replay / reconnect merge).
//   - Duplicate sequences are deduped (replay + in-flight overlap).
//   - `highestSequence` is the max sequence ever folded; a lower sequence never
//     regresses it (the SSE helper uses it as the reconnect/gap `afterSequence`).
//
// Trace event shape (backend model.WorkTraceEvent, JSON-encoded as SSE data):
//   { id, dialogue_id, sequence, task_id?, application_id?, version_id?,
//     step_id?, attempt?, type, payload_json, created_at }
// For the reducer the caller passes a normalized event: { dialogueId, sequence,
// type, payload, ...rest }. The SSE helper (events.js) parses payload_json before
// calling applyTraceEvent.

export const initialWorkTraceState = (selectedDialogueId = null) => ({
  // The dialogue this trace state is scoped to. Events for any other dialogue
  // are ignored (isolation). Set by the hook when a dialogue is selected.
  selectedDialogueId,
  // Trace items, ascending by sequence, deduped.
  items: [],
  // Highest sequence ever folded — the resume cursor.
  highestSequence: 0,
  // Sequences folded, for O(1) dedup.
  _seen: new Set(),
})

// normalizeTraceEvent accepts EITHER a backend WorkTraceEvent row (snake_case,
// payload_json string) OR a pre-normalized event ({dialogueId, sequence, type,
// payload}). Returns the normalized shape or null if it carries no sequence.
export function normalizeTraceEvent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const dialogueId = raw.dialogueId || raw.dialogue_id
  const sequence = Number(raw.sequence)
  if (!Number.isFinite(sequence)) return null
  let payload = raw.payload
  if (payload == null && raw.payload_json != null) {
    try {
      payload = JSON.parse(raw.payload_json)
    } catch {
      payload = null
    }
  }
  return {
    dialogueId: dialogueId ? String(dialogueId) : null,
    sequence,
    type: raw.type || '',
    payload: payload || {},
    // Carry the provenance fields the UI may render (all optional).
    id: raw.id || `${dialogueId}:${sequence}`,
    taskId: raw.taskId || raw.task_id || '',
    applicationId: raw.applicationId || raw.application_id || '',
    versionId: raw.versionId || raw.version_id || '',
    stepId: raw.stepId || raw.step_id || '',
    attempt: raw.attempt != null ? Number(raw.attempt) : 0,
    createdAt: raw.createdAt || raw.created_at || '',
  }
}

// applyTraceEvent folds ONE trace event into state. Returns NEW state (immutable)
// or the SAME state reference when the event is for a different dialogue or a
// duplicate sequence. `state.selectedDialogueId` drives isolation: if it is null
// the event is adopted only if it carries a dialogueId matching none (treated as
// the active stream). The hook always sets selectedDialogueId before folding.
export function applyTraceEvent(state, event) {
  const ev = normalizeTraceEvent(event)
  if (!ev) return state
  // Isolation: an event whose dialogueId differs from the selected dialogue
  // leaves state UNCHANGED. (When no dialogue is selected we are lenient and
  // adopt the first dialogue's events so initial hydration works.)
  if (state.selectedDialogueId && ev.dialogueId && ev.dialogueId !== state.selectedDialogueId) {
    return state
  }
  // Dedup by sequence.
  if (state._seen && state._seen.has(ev.sequence)) return state
  const seen = new Set(state._seen)
  seen.add(ev.sequence)
  const items = [...state.items, ev].sort((a, b) => a.sequence - b.sequence)
  const highestSequence = Math.max(state.highestSequence || 0, ev.sequence)
  return {
    ...state,
    selectedDialogueId: state.selectedDialogueId || ev.dialogueId,
    items,
    highestSequence,
    _seen: seen,
  }
}

// applyTraceEvents folds a batch (REST hydration / reconnect replay). Events for
// other dialogues are dropped by applyTraceEvent's isolation guard.
export function applyTraceEvents(state, events) {
  const list = Array.isArray(events) ? events : []
  let next = state
  for (const ev of list) {
    next = applyTraceEvent(next, ev)
  }
  return next
}

// resetWorkTraceState clears items + cursor for a NEW selected dialogue, keeping
// the selectedDialogueId. Used when the user switches the active dialogue so the
// trace stream re-hydrates from scratch.
export function resetWorkTraceState(selectedDialogueId) {
  return {
    selectedDialogueId: selectedDialogueId || null,
    items: [],
    highestSequence: 0,
    _seen: new Set(),
  }
}

// parseSequenceId parses an SSE `id:` (the dialogue-scoped sequence) for the
// Last-Event-ID reconnect path. Returns null when unparseable.
export function parseSequenceId(value) {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}
