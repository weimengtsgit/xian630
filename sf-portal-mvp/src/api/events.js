// See src/api/client.js: `??` keeps an empty build-time value (same-origin /api
// via the edge proxy) and falls back to the local factory address only in dev.
const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL ?? 'http://127.0.0.1:8787'

// subscribeFactoryEvents(onEvent, { onError } = {})
//
// Backward compatible: the second argument is optional, so existing callers
// that pass only `onEvent` (useJobs, useApplications, useClarification) keep
// working unchanged. The optional `onError` is invoked when the EventSource
// reports a connection error (onerror with no open connection) so subscribers
// can schedule a resync — see useJobs gap-resync.
export function subscribeFactoryEvents(onEvent, { onError } = {}) {
  const source = new EventSource(`${API_BASE_URL}/api/events`)
  const types = [
    'app.updated',
    'app.deleted',
    'job.created',
    'job.updated',
    'step.updated',
    'artifact.created',
    'deployment.updated',
    'step.record.appended',
    'clarification.created',
    'clarification.message.started',
    'clarification.message.delta',
    'clarification.message.completed',
    'clarification.question.created',
    'clarification.summary.updated',
    'clarification.ready_to_confirm',
    'clarification.confirmed',
    'clarification.failed',
    'clarification.abandoned',
    'clarification.deleted',
    // dialogue.* (Task 4): the composed parent facade. Child clarification events
    // arrive wrapped with a parent dialogue_id; the portal keys updates by
    // dialogue_id rather than refetching the whole history per streaming delta.
    'dialogue.created',
    'dialogue.intent.updated',
    'dialogue.route.started',
    'dialogue.route.delta',
    'dialogue.route.thinking',
    'dialogue.route.completed',
    'dialogue.application.recommended',
    'dialogue.route.confirmed',
    'dialogue.draft.started',
    'dialogue.draft.delta',
    'dialogue.draft.thinking',
    'dialogue.draft.completed',
    'dialogue.draft.question.created',
    'dialogue.draft.consolidation.updated',
    'dialogue.draft.summary.updated',
    'dialogue.draft.ready_to_confirm',
    'dialogue.agent_draft.updated',
    'dialogue.agent.created',
    'dialogue.clarification.updated',
    'dialogue.clarification.delta',
    'dialogue.clarification.thinking',
    'dialogue.resolved',
    'dialogue.failed',
    'dialogue.abandoned',
    'dialogue.deleted',
  ]
  types.forEach(type => {
    source.addEventListener(type, event => {
      onEvent(type, JSON.parse(event.data))
    })
  })
  if (typeof onError === 'function') {
    source.addEventListener('error', err => {
      // EventSource auto-reconnects; onError lets the caller schedule a
      // debounced snapshot resync to cover any records missed while the
      // connection was down.
      onError(err)
    })
  }
  return () => source.close()
}

// The SSE event type the backend emits for a work-trace row (see
// factory-server/internal/server/events.go: workTraceEventType). The server
// publishes the FULL row object as the frame data and sets the SSE `id:` to the
// row's dialogue-scoped sequence, so a browser auto-reconnect re-sends
// Last-Event-ID and the server resumes exactly after it.
const WORK_TRACE_EVENT_TYPE = 'dialogue.work_trace'

// subscribeDialogueTrace(dialogueId, { onEvent, onError, afterSequence })
//
// Per-dialogue SSE transport for the visible work-trace (Constraint #7: detailed
// timeline/trace events come ONLY via this dialogueId-filtered, sequence-replayable
// stream — NOT the global /api/events). It implements the hydrate→live→gap model:
//
//   1. HYDRATE: on subscribe, REST-fetch the persisted trace via
//      getDialogueTrace(afterSequence) FIRST so we have a stable cursor + the
//      backlog before the live stream starts. The highest sequence becomes the
//      reconnect cursor.
//   2. LIVE: open ONE EventSource on /api/dialogues/:id/work-trace/stream.
//      The server replays persisted rows (deduped against the cursor) then
//      forwards live events filtered to this dialogue_id server-side. Each
//      frame's SSE id is the sequence.
//   3. RECONNECT/GAP: EventSource auto-reconnects and the browser re-sends
//      Last-Event-ID automatically (server honors it). We ALSO track the
//      highest-seen sequence client-side: on an explicit onError we close +
//      re-open with ?afterSequence=<highest> (defensive — covers a proxy that
//      strips Last-Event-ID); on a detected replay GAP (a sequence jump in the
//      live stream) we REST-reload via onGap (debounced by the caller).
//
// The returned unsubscribe() closes the EventSource and cancels in-flight
// hydration. `onEvent(row)` receives each normalized WorkTraceEvent row; the
// caller folds it into workTraceState via applyTraceEvent.
export function subscribeDialogueTrace(
  dialogueId,
  { onEvent, onError, afterSequence = 0, getDialogueTrace } = {},
) {
  if (!dialogueId) return () => {}
  let closed = false
  let source = null
  let highest = Number.isFinite(afterSequence) ? afterSequence : 0
  // In-flight hydration guard: we only open the live stream AFTER the initial
  // REST hydration resolves so the cursor is stable and the live dedup is sound.
  let hydrated = false
  let hydrationAborted = false

  const emit = row => {
    if (closed || !row) return
    const seq = Number(row.sequence)
    if (Number.isFinite(seq) && seq > highest) highest = seq
    if (typeof onEvent === 'function') onEvent(row)
  }

  const reportGap = () => {
    if (closed) return
    // Defensive REST reload from the highest known sequence. The caller's reducer
    // dedups, so re-fetching is idempotent.
    if (typeof getDialogueTrace === 'function') {
      getDialogueTrace(dialogueId, highest)
        .then(rows => {
          if (!Array.isArray(rows)) return
          rows.forEach(emit)
        })
        .catch(() => {
          if (typeof onError === 'function') onError(new Error('work-trace gap reload failed'))
        })
    } else if (typeof onError === 'function') {
      onError(new Error('work-trace gap detected'))
    }
  }

  const openStream = () => {
    if (closed || source) return
    // afterSequence seeds the server-side replay cursor; Last-Event-ID (sent
    // automatically by the browser on reconnect) takes precedence server-side.
    source = new EventSource(
      `${API_BASE_URL}/api/dialogues/${dialogueId}/work-trace/stream?afterSequence=${highest}`,
    )
    source.addEventListener(WORK_TRACE_EVENT_TYPE, e => {
      if (closed) return
      let row = null
      try {
        row = JSON.parse(e.data)
      } catch {
        return
      }
      const seq = Number(row && row.sequence)
      // Gap detection: a live sequence that skips past highest+1 means we may
      // have missed rows (the server dedups replayed rows, but a frame lost in
      // transit would surface as a jump). Reload via REST from the cursor.
      if (Number.isFinite(seq) && highest > 0 && seq > highest + 1) {
        reportGap()
      }
      emit(row)
    })
    source.addEventListener('error', () => {
      if (closed) return
      // EventSource auto-reconnects and re-sends Last-Event-ID. We ALSO proactively
      // reload via REST from our client-side cursor to cover proxies that strip
      // the Last-Event-ID header, then let auto-reconnect continue.
      reportGap()
      if (typeof onError === 'function') onError(new Error('work-trace stream error'))
    })
  }

  // 1. HYDRATE first (so the cursor is stable before the live stream dedups).
  if (typeof getDialogueTrace === 'function') {
    getDialogueTrace(dialogueId, afterSequence)
      .then(rows => {
        if (hydrationAborted || closed) return
        hydrated = true
        if (Array.isArray(rows)) rows.forEach(emit)
        openStream()
      })
      .catch(() => {
        if (closed) return
        // Hydration failed — still open the live stream so the server-side replay
        // can recover the backlog (the stream itself replays from afterSequence).
        hydrated = true
        openStream()
        if (typeof onError === 'function') onError(new Error('work-trace hydration failed'))
      })
  } else {
    // No REST hydration provided: rely on the server-side stream replay alone.
    hydrated = true
    openStream()
  }

  return () => {
    closed = true
    hydrationAborted = true
    if (source) {
      source.close()
      source = null
    }
  }
}
