import { useCallback, useEffect, useRef, useState } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'
import {
  applyDialogueEvent,
  buildDialogueTimeline,
  initialDialogueState,
  lockedFromView,
} from './dialogueTimeline'

// dialogue.* + wrapped clarification.* event types drive a TARGETED refresh keyed
// by dialogue_id. We do NOT refetch all sessions on each streaming delta (the old
// hook's N+1 pattern). Selected-dialogue content events set needsRefresh=<id>; the
// hook refetches that ONE composed view. Other dialogues only mark activity.
const DIALOGUE_TYPES = new Set([
  'dialogue.created',
  'dialogue.intent.updated',
  'dialogue.application.recommended',
  'dialogue.route.confirmed',
  'dialogue.agent_draft.updated',
  'dialogue.agent.created',
  'dialogue.clarification.updated',
  'dialogue.resolved',
  'dialogue.abandoned',
  'dialogue.deleted',
  // Wrapped child clarification events arrive via publishDialogueChild; they carry
  // a parent dialogue_id so the portal updates one state source.
  'clarification.summary.updated',
])

const terminal = status => status === 'resolved' || status === 'abandoned' || status === 'failed'

export function useDialogueSessions() {
  const [state, setState] = useState(initialDialogueState)
  const [error, setError] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deletingDialogueId, setDeletingDialogueId] = useState(null)
  const mountedRef = useRef(true)

  // refreshSessions fetches the composed list (each entry is a full DialogueView).
  // It does NOT refetch on every streaming delta — only on mount, after a mutating
  // action, or when a background event arrives for an unselected dialogue that the
  // user may later open. The list is cheap (server composes ≤50 views).
  const refreshSessions = useCallback(async () => {
    const data = await factoryApi.listDialogues()
    const sessions = Array.isArray(data) ? data : data.sessions || []
    if (mountedRef.current) {
      setState(prev => ({ ...prev, sessions }))
    }
    return sessions
  }, [])

  // loadView fetches ONE composed view and derives the timeline + open questions
  // from it. This is the targeted-refresh path: called on select, after every
  // mutating action, and when needsRefresh flags the selected dialogue.
  const loadView = useCallback(async id => {
    if (!id) {
      setState(prev => ({
        ...initialDialogueState(),
        sessions: prev.sessions,
        selectedDialogueId: null,
        view: null,
      }))
      return null
    }
    const view = await factoryApi.getDialogue(id)
    if (mountedRef.current) {
      setState(prev => ({
        ...prev,
        selectedDialogueId: id,
        view,
        timeline: buildDialogueTimeline(view),
        requirement: view.child ? (view.child.requirement || null) : null,
        needsRefresh: null,
      }))
    }
    return view
  }, [])

  const selectDialogue = useCallback(async id => {
    if (!id) {
      setState(prev => ({
        ...initialDialogueState(),
        sessions: prev.sessions,
        selectedDialogueId: null,
        view: null,
      }))
      return null
    }
    setError(null)
    try {
      return await loadView(id)
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    }
  }, [loadView])

  const newDialogue = useCallback(() => {
    setError(null)
    setState(prev => ({
      ...initialDialogueState(),
      sessions: prev.sessions,
      selectedDialogueId: null,
      view: null,
    }))
  }, [])

  // send routes a new user turn. When no dialogue is selected (or the selected one
  // is terminal) it CREATES a dialogue with the prompt; otherwise it appends a
  // routed message (pre-lock re-routing).
  const send = useCallback(async content => {
    const prompt = String(content || '').trim()
    if (!prompt || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      let view
      if (!state.view || terminal(state.view.session.status)) {
        view = await factoryApi.createDialogue({ initialPrompt: prompt })
      } else {
        view = await factoryApi.sendDialogueMessage(state.view.session.id, prompt)
      }
      await refreshSessions()
      await loadView(view.session.id)
      return view
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  // selectRoute locks the route into one of the three outcomes.
  const selectRoute = useCallback(async (intent, extra = {}) => {
    if (!state.view || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const view = await factoryApi.selectDialogueRoute(state.view.session.id, { intent, ...extra })
      await refreshSessions()
      await loadView(view.session.id)
      return view
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  // openApp opens (and starts if stopped) a recommended existing application,
  // then resolves the dialogue.
  const openApp = useCallback(async applicationId => {
    if (!state.view || !applicationId || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const view = await factoryApi.openDialogueApplication(state.view.session.id, applicationId)
      await refreshSessions()
      await loadView(view.session.id)
      return view
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  const answerBatch = useCallback(async (answers, consolidation = null) => {
    if (!state.view || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      let view
      if (consolidation && consolidation.field) {
        // Round-6 single-field adjust path: the backend merges the persisted
        // consolidation with the override (no model turn) and marks ready_to_confirm.
        view = await factoryApi.answerDialogueClarificationBatch(state.view.session.id, {
          consolidationField: consolidation.field,
          consolidationValue: consolidation.value,
        })
      } else {
        view = await factoryApi.answerDialogueClarificationBatch(state.view.session.id, answers)
      }
      await refreshSessions()
      await loadView(view.session.id)
      return view
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  // acceptConsolidation handles the round-5 recommendation table actions. Called
  // with no args => 接受推荐 (accept the merged draft, advance to ready_to_confirm).
  // Called with {field, value} => one-field adjust (backend merges, no model turn).
  const acceptConsolidation = useCallback(async (adjust = null) => {
    if (!state.view || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      let view
      if (adjust && adjust.field) {
        view = await factoryApi.answerDialogueClarificationBatch(state.view.session.id, {
          consolidationField: adjust.field,
          consolidationValue: adjust.value,
        })
      } else {
        // Accept: empty adjust marks the requirement ready_to_confirm.
        view = await factoryApi.answerDialogueClarificationBatch(state.view.session.id, {
          consolidationField: '__accept__',
          consolidationValue: '',
        })
      }
      await loadView(view.session.id)
      return view
    } catch (err) {
      // If the accept path 409s because there is no consolidation list (e.g. the
      // round already advanced), fall back to an empty batch so the user can still
      // proceed to confirm.
      if (!adjust && err && err.status === 409) {
        try {
          const fallback = await factoryApi.answerDialogueClarificationBatch(state.view.session.id, [])
          await loadView(fallback.session.id)
          return fallback
        } catch (_) {
          // fall through to the original error surface
        }
      }
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, state.view, submitting])

  const confirm = useCallback(async () => {
    if (!state.view || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      let view
      if (state.view.session.intent === 'business_processing_agent') {
        view = await factoryApi.confirmDialogueBusinessAgent(state.view.session.id)
      } else {
        view = await factoryApi.confirmDialogueClarification(state.view.session.id)
      }
      await refreshSessions()
      await loadView(view.session.id)
      return view
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  const retry = useCallback(async () => {
    if (!state.view || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const view = await factoryApi.retryDialogueRound(state.view.session.id)
      await loadView(view.session.id)
      return view
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, state.view, submitting])

  const abandon = useCallback(async () => {
    if (!state.view || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const view = await factoryApi.abandonDialogueClarification(state.view.session.id)
      await refreshSessions()
      await loadView(view.session.id)
      return view
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  const deleteDialogue = useCallback(async id => {
    const dialogueId = String(id || '').trim()
    if (!dialogueId || deletingDialogueId) return null
    setDeletingDialogueId(dialogueId)
    setError(null)
    try {
      await factoryApi.deleteDialogue(dialogueId)
      const sessions = await refreshSessions()
      if (mountedRef.current && state.selectedDialogueId === dialogueId) {
        setState(prev => ({
          ...initialDialogueState(),
          sessions,
          selectedDialogueId: null,
          view: null,
        }))
      }
      return true
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setDeletingDialogueId(null)
    }
  }, [deletingDialogueId, refreshSessions, state.selectedDialogueId])

  // Mount: hydrate the list and auto-select the most recent dialogue. Subscribe to
  // dialogue.* events. Targeted refresh: a content event for the selected dialogue
  // sets needsRefresh, which we drain by refetching ONE view (debounced via rAF so
  // a burst of streaming deltas coalesces into a single getDialogue call).
  useEffect(() => {
    mountedRef.current = true
    refreshSessions().then(sessions => {
      if (sessions[0] && sessions[0].session) selectDialogue(sessions[0].session.id).catch(() => {})
    }).catch(err => {
      if (mountedRef.current) setError(err.message || String(err))
    })
    let rafId = null
    const drainRefresh = () => {
      rafId = null
      setState(prev => {
        if (!prev.needsRefresh || prev.needsRefresh !== prev.selectedDialogueId) return prev
        loadView(prev.needsRefresh).catch(err => {
          if (mountedRef.current) setError(err.message || String(err))
        })
        return prev
      })
    }
    const unsubscribe = subscribeFactoryEvents((type, raw) => {
      if (!mountedRef.current) return
      const isDialogue = DIALOGUE_TYPES.has(type)
      // Other top-level types (app.*/job.*/clarification.* bare) are handled by
      // their own hooks; we only care about dialogue.* + the wrapped summary event.
      if (!isDialogue && type !== 'clarification.summary.updated') return
      const ev = raw && typeof raw === 'object' && 'seq' in raw ? raw.data : raw
      if (!ev) return
      setState(prev => {
        const next = applyDialogueEvent(prev, type, ev)
        // If the event flagged a targeted refresh for the selected dialogue,
        // schedule a coalesced drain (rAF) instead of refetching per delta.
        if (next.needsRefresh && next.needsRefresh === next.selectedDialogueId && rafId == null) {
          rafId = requestAnimationFrame(drainRefresh)
        }
        return next
      })
      // A deleted or created dialogue changes the history list; refresh it cheaply.
      if (type === 'dialogue.deleted' || type === 'dialogue.created') {
        refreshSessions().catch(() => {})
      }
    })
    return () => {
      mountedRef.current = false
      if (rafId != null) cancelAnimationFrame(rafId)
      unsubscribe()
    }
  }, [loadView, refreshSessions, selectDialogue])

  const session = state.view && state.view.session
  const locked = lockedFromView(state.view)

  return {
    ...state,
    session,
    view: state.view,
    locked,
    error,
    submitting,
    deletingDialogueId,
    historyOpen,
    setHistoryOpen,
    refreshSessions,
    selectDialogue,
    newDialogue,
    send,
    selectRoute,
    openApp,
    answerBatch,
    acceptConsolidation,
    confirm,
    retry,
    abandon,
    deleteDialogue,
  }
}
