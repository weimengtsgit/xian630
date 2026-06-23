import { useCallback, useEffect, useRef, useState } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'
import {
  applyClarificationEvent,
  initialClarificationState,
} from './clarificationLogic'

// Mirrors useJobs: useState + mountedRef + useCallback + SSE subscription. The
// SSE subscription applies each clarification.* event through the PURE reducer
// in clarificationLogic.js (so the same logic is covered by the node-assert
// harness in scripts/check-clarification.mjs).
//
// SSE envelope: writeSSE (events.go) marshals the WHOLE server.Event into the
// `data:` line, so subscribeFactoryEvents calls onEvent(typeString, envelope)
// where envelope is
//   {seq, type, data, at}
// and envelope.data is the bare clarification.StreamEvent
//   {type, session_id, message_id, delta, data}
// The reducer's contract is the BARE StreamEvent (the node harness feeds it
// directly without an envelope), so this hook unwraps envelope.data before
// calling applyClarificationEvent. The envelope is uniquely identifiable by its
// numeric `seq`; a bare StreamEvent has none.
const CLARIFICATION_TYPES = new Set([
  'clarification.created',
  'clarification.message.started',
  'clarification.message.delta',
  'clarification.message.completed',
  'clarification.question.created',
  'clarification.summary.updated',
  'clarification.blueprint.recommended',
  'clarification.ready_to_confirm',
  'clarification.confirmed',
  'clarification.failed',
  'clarification.abandoned',
])

// isTerminal reports whether a session status is terminal (no further user
// turns may advance it). A confirmed/abandoned/failed session cannot accept
// messages or answers — a new prompt after a terminal session starts a FRESH
// session via create(); a stale option click on a dead session is a no-op.
const isTerminal = st => st === 'confirmed' || st === 'abandoned' || st === 'failed'
const rejectsAnswers = st => isTerminal(st) || st === 'ready_to_confirm'
const isQuestionClearingStatus = st =>
  st === 'ready_to_confirm' || st === 'confirmed' || st === 'abandoned' || st === 'failed'

function stateFromClarificationView(session, messages = []) {
  const visibleMessages = []
  const questions = []
  const seenQuestionIds = new Set()
  for (const msg of messages || []) {
    if (msg.role === 'agent' && (msg.kind === 'analysis_work_log' || msg.kind === 'model_output')) {
      visibleMessages.push({
        id: msg.id,
        role: 'agent',
        kind: msg.kind,
        content: msg.content || '',
      })
      continue
    }
    if (msg.role === 'agent' && msg.kind === 'question' && msg.metadata_json) {
      try {
        const q = JSON.parse(msg.metadata_json)
        if (q && q.id && !seenQuestionIds.has(q.id)) {
          questions.push(q)
          seenQuestionIds.add(q.id)
        }
      } catch {
        // Ignore malformed historical metadata; the requirement summary still
        // rehydrates from the session view.
      }
    }
  }
  return {
    ...initialClarificationState(),
    session,
    messages: visibleMessages,
    questions: isQuestionClearingStatus(session?.status) ? [] : questions,
    requirement: session?.requirement || null,
  }
}

export function useClarification() {
  const [state, setState] = useState(initialClarificationState)
  const [error, setError] = useState(null)
  const mountedRef = useRef(true)

  const hydrateSession = useCallback(async sessionOrId => {
    const session =
      typeof sessionOrId === 'string'
        ? await factoryApi.getClarification(sessionOrId)
        : sessionOrId
    if (!session || !session.id) return session
    const messages = await factoryApi.getClarificationMessages(session.id)
    if (mountedRef.current) {
      setState(stateFromClarificationView(session, messages))
      setError(null)
    }
    return session
  }, [])

  const hydrateActive = useCallback(async () => {
    try {
      const session = await factoryApi.getActiveClarification()
      return await hydrateSession(session)
    } catch (err) {
      if (err.status === 404) return null
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    }
  }, [hydrateSession])

  const create = useCallback(async prompt => {
    setError(null)
    try {
      const session = await factoryApi.createClarification(prompt)
      return await hydrateSession(session)
    } catch (err) {
      if (err.status === 409 && err.data && err.data.session_id) {
        const active = await hydrateActive()
        if (active) return active
      }
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    }
  }, [hydrateActive, hydrateSession])

  const reset = useCallback(() => {
    setState(initialClarificationState())
    setError(null)
  }, [])

  const send = useCallback(
    async content => {
      setError(null)
      try {
        // A terminal session (confirmed/abandoned/failed) cannot accept further
        // messages. A new prompt after a terminal session starts a FRESH session
        // via create() — the existing entrypoint — rather than POSTing to a dead
        // session id (which the backend would reject with 409).
        if (!state.session || isTerminal(state.session.status)) {
          reset()
          return create(content)
        }
        if (state.session.status === 'ready_to_confirm') {
          const msg = '当前需求已完成澄清，请先点击“确认并生成”，或放弃当前需求后再输入新需求。'
          if (mountedRef.current) setError(msg)
          return state.session
        }
        const result = await factoryApi.sendClarificationMessage(state.session.id, content)
        return await hydrateSession(result)
      } catch (err) {
        if (mountedRef.current) setError(err.message || String(err))
        throw err
      }
    },
    [state.session, create, reset, hydrateSession],
  )

  const answer = useCallback(
    async (questionId, value) => {
      if (!state.session) return null
      // A stale option click on a terminal session is a no-op — the backend
      // would reject it with 409, and the session's questions are stale anyway.
      if (rejectsAnswers(state.session.status)) return null
      setError(null)
      try {
        if (mountedRef.current) {
          setState(prev => ({ ...prev, questions: [] }))
        }
        const result = await factoryApi.answerClarification(state.session.id, { questionId, value })
        return await hydrateSession(result)
      } catch (err) {
        if (mountedRef.current) setError(err.message || String(err))
        throw err
      }
    },
    [state.session, hydrateSession],
  )

  const answerBatch = useCallback(
    async answers => {
      if (!state.session) return null
      if (rejectsAnswers(state.session.status)) return null
      setError(null)
      try {
        if (mountedRef.current) {
          setState(prev => ({ ...prev, questions: [] }))
        }
        const result = await factoryApi.answerClarificationBatch(state.session.id, answers)
        return await hydrateSession(result)
      } catch (err) {
        if (mountedRef.current) setError(err.message || String(err))
        throw err
      }
    },
    [state.session, hydrateSession],
  )

  const confirm = useCallback(async () => {
    if (!state.session) return null
    setError(null)
    try {
      const result = await factoryApi.confirmClarification(state.session.id)
      return await hydrateSession(result)
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    }
  }, [state.session, hydrateSession])

  const retry = useCallback(async () => {
    if (!state.session) return null
    setError(null)
    try {
      const result = await factoryApi.retryClarificationRound(state.session.id)
      return await hydrateSession(result)
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    }
  }, [state.session, hydrateSession])

  const abandon = useCallback(async () => {
    if (!state.session) return null
    setError(null)
    try {
      const result = await factoryApi.abandonClarification(state.session.id)
      return await hydrateSession(result)
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    }
  }, [state.session, hydrateSession])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribe = subscribeFactoryEvents((type, raw) => {
      if (!mountedRef.current) return
      if (!CLARIFICATION_TYPES.has(type)) return
      // SSE delivers the server.Event envelope {seq,type,data,at}; the reducer's
      // contract is the bare clarification.StreamEvent that lives at envelope.data.
      const ev = raw && typeof raw === 'object' && 'seq' in raw ? raw.data : raw
      setState(prev => applyClarificationEvent(prev, type, ev || {}))
    })
    hydrateActive().catch(() => {})
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [hydrateActive])

  return {
    session: state.session,
    messages: state.messages,
    questions: state.questions,
    requirement: state.requirement,
    blueprints: state.blueprints,
    error,
    create,
    send,
    answer,
    answerBatch,
    confirm,
    retry,
    abandon,
    reset,
  }
}
