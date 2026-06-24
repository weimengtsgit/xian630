// Pure clarification reducer + status mapping. NO React imports — this module
// is exercised by the node-assert logic harness (scripts/check-clarification.mjs)
// in addition to being consumed by useClarification.js.
//
// Contract: the reducer consumes the BARE clarification.StreamEvent
//   { type, session_id, message_id, delta, data }
// where the inner payload lives at `ev.data` (NOT `ev.data.data`).
//
// The node harness (check-clarification.mjs) feeds bare StreamEvents directly,
// so the reducer never sees an envelope. At runtime, SSE delivers the
// server.Event envelope {seq,type,data,at} via subscribeFactoryEvents;
// useClarification.js unwraps `.data` (the bare StreamEvent) before calling this
// reducer, so this module is envelope-agnostic.

export const initialClarificationState = () => ({
  session: null,
  messages: [],
  questions: [],
  requirement: null,
  blueprints: [],
})

// Upsert a message by id. `patch` is merged into the existing message (or used
// as the base for a new one). Always returns a NEW messages array.
function upsertMessage(messages, id, patch) {
  const idx = messages.findIndex(m => m.id === id)
  if (idx === -1) {
    return [
      ...messages,
      { id, role: 'agent', kind: 'analysis_work_log', content: '', ...patch },
    ]
  }
  const next = messages.slice()
  next[idx] = { ...messages[idx], ...patch, id }
  return next
}

// Apply one SSE event to state. Returns NEW state (immutable); unknown event
// types return the SAME reference (no-op).
//
//   type = event type string (e.g. "clarification.message.delta")
//   ev   = parsed StreamEvent ({type, session_id, message_id, delta, data})
export function applyClarificationEvent(state, type, ev) {
  switch (type) {
    case 'clarification.created': {
      const session = (ev && ev.data) || null
      return { ...state, session }
    }

    case 'clarification.message.started': {
      const id = ev && ev.message_id
      if (!id) return state
      const kind = (ev.data && ev.data.type) || 'analysis_work_log'
      return {
        ...state,
        messages: upsertMessage(state.messages, id, {
          role: 'agent',
          kind,
          content: (ev.data && ev.data.content) || '',
        }),
      }
    }

    case 'clarification.message.delta': {
      const id = ev && ev.message_id
      if (!id) return state
      // delta is the FULL current content for this message — SET, do not append,
      // otherwise started+delta+completed will triple the text.
      return {
        ...state,
        messages: upsertMessage(state.messages, id, {
          role: 'agent',
          kind: 'analysis_work_log',
          content: ev.delta != null ? ev.delta : '',
        }),
      }
    }

    case 'clarification.message.completed': {
      const id = ev && ev.message_id
      if (!id) return state
      // No content change unless the backend sent a finalized content payload.
      const patch = {}
      if (ev.data && ev.data.type) patch.kind = ev.data.type
      if (ev.data && typeof ev.data.content === 'string') patch.content = ev.data.content
      return { ...state, messages: upsertMessage(state.messages, id, patch) }
    }

    case 'clarification.question.created': {
      const q = ev && ev.data
      if (!q) return state
      const id = q.id
      if (id != null && state.questions.some(x => x.id === id)) {
        return state // dedupe by id
      }
      return { ...state, questions: [...state.questions, q] }
    }

    case 'clarification.summary.updated': {
      return { ...state, requirement: (ev && ev.data) || null }
    }

    case 'clarification.ready_to_confirm': {
      const requirement = (ev && ev.data) || state.requirement
      const session = state.session
        ? { ...state.session, status: 'ready_to_confirm' }
        : state.session
      return { ...state, requirement, session, questions: [] }
    }

    case 'clarification.confirmed': {
      // The backend publishes the refreshed confirmed SESSION. If ev.data looks
      // like a session (has id or status), replace the session slot directly.
      //
      // Defensive regression guard: if a future backend regression publishes the
      // REQUIREMENT instead (no id/status), we must NOT overwrite the session
      // slot with it (that would route chat to /api/clarifications/undefined/
      // messages). Instead, preserve the prior session's id, force its status to
      // confirmed, and fold the payload into the requirement slot so the UI both
      // advances out of ready_to_confirm and shows the confirmed requirement.
      const next = ev && ev.data
      if (next && (next.id != null || next.status != null)) {
        return { ...state, session: next, questions: [] }
      }
      const session = state.session
        ? { ...state.session, status: 'confirmed' }
        : state.session
      return {
        ...state,
        session,
        requirement: next != null ? next : state.requirement,
        questions: [],
      }
    }

    case 'clarification.failed': {
      if (!state.session) return state
      const session = { ...state.session, status: 'failed' }
      if (ev && ev.data) {
        if (ev.data.error) session.error = ev.data.error
        if (ev.data.reason) session.error = session.error || ev.data.reason
      }
      return { ...state, session }
    }

    case 'clarification.abandoned': {
      if (!state.session) return state
      return { ...state, session: { ...state.session, status: 'abandoned' } }
    }

    default:
      return state
  }
}

export function statusText(status) {
  const map = {
    active: '澄清中',
    waiting_user: '等待补充',
    ready_to_confirm: '待确认',
    confirmed: '已确认',
    failed: '已失败',
    abandoned: '已放弃',
  }
  if (status == null) return ''
  return map[status] || status
}
