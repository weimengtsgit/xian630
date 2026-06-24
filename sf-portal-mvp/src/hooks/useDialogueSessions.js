import { useCallback, useEffect, useRef, useState } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents, subscribeDialogueTrace } from '../api/events'
import {
  applyDialogueEvent,
  buildDialogueTimeline,
  initialDialogueState,
  lockedFromView,
  openQuestionsForView,
} from './dialogueTimeline'
import {
  applyTraceEvent,
  applyTraceEvents,
  initialWorkTraceState,
  resetWorkTraceState,
} from './workTraceState'
import { selectFocusTask } from './focusTask'

// dialogue.* + wrapped clarification.* event types drive a TARGETED refresh keyed
// by dialogue_id. We do NOT refetch all sessions on each streaming delta (the old
// hook's N+1 pattern). Selected-dialogue content events set needsRefresh=<id>; the
// hook refetches that ONE composed view. Other dialogues only mark activity.
const DIALOGUE_TYPES = new Set([
  'dialogue.created',
  'dialogue.intent.updated',
  'dialogue.route.started',
  'dialogue.route.delta',
  'dialogue.route.completed',
  'dialogue.application.recommended',
  'dialogue.route.confirmed',
  'dialogue.draft.started',
  'dialogue.draft.delta',
  'dialogue.draft.completed',
  'dialogue.draft.question.created',
  'dialogue.draft.consolidation.updated',
  'dialogue.draft.summary.updated',
  'dialogue.draft.ready_to_confirm',
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

  // ---- continuous-workbench state (Task 7) --------------------------------
  // workTrace: the folded, ascending, deduped visible trace for the SELECTED
  // dialogue, fed by the per-dialogue SSE stream (Constraint #7 — NOT the global
  // /api/events). Reset + re-hydrated whenever the selected dialogue changes.
  const [workTrace, setWorkTrace] = useState(initialWorkTraceState())
  // pendingTurn: a 202 ack {dialogueId, turnId, acceptedAt} from send when the
  // session is CONTINUING (route already locked). The workbench renders a
  // cancel-current-turn control against it. Cleared when the trace shows the
  // turn completing, or on cancel.
  const [pendingTurn, setPendingTurn] = useState(null)
  // focusTask: the active-or-newest-terminal job scoped to the selected
  // dialogue (Constraint #10 — switching history syncs the focus task). Driven
  // by the job list the App passes in via setJobsForFocus; null when no list.
  const [jobsForFocus, setJobsForFocus] = useState([])
  // pendingTurnRef mirrors pendingTurn so the SSE onEvent closure (which must
  // NOT re-subscribe the stream on every turn change) reads the latest value.
  const pendingTurnRef = useRef(null)
  useEffect(() => {
    pendingTurnRef.current = pendingTurn
  }, [pendingTurn])
  // selectedDialogueIdRef mirrors state.selectedDialogueId so the loadView
  // closure (a stable useCallback([]) that cannot read `state` without a stale
  // closure) can distinguish a real dialogue SWITCH (reset the trace stream)
  // from a same-dialogue refresh.
  const selectedDialogueIdRef = useRef(null)
  useEffect(() => {
    selectedDialogueIdRef.current = state.selectedDialogueId
  }, [state.selectedDialogueId])

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
      setWorkTrace(initialWorkTraceState())
      setPendingTurn(null)
      return null
    }
    const view = await factoryApi.getDialogue(id)
    if (mountedRef.current) {
      setState(prev => ({
        ...prev,
        selectedDialogueId: id,
        view,
        timeline: buildDialogueTimeline(view),
        questions: openQuestionsForView(view),
        requirement: view.child ? (view.child.requirement || null) : null,
        needsRefresh: null,
      }))
      // Switching the selected dialogue resets the trace stream (Constraint #10):
      // the per-dialogue SSE effect re-subscribes and re-hydrates from scratch.
      // Compare against the ref: loadView is a stable useCallback, so `state`
      // would be a stale closure here, and `prev` is only the setState-updater
      // parameter (out of scope outside that arrow).
      if (selectedDialogueIdRef.current !== id) {
        setWorkTrace(resetWorkTraceState(id))
        setPendingTurn(null)
      }
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
  // routed message (pre-lock re-routing). On a CONTINUING (route-locked) session
  // the backend returns a 202 ack {dialogueId, turnId, acceptedAt} instead of a
  // composed view — we surface it as a pending turn and let the trace stream
  // drive the follow-up refresh.
  const send = useCallback(async content => {
    const prompt = String(content || '').trim()
    if (!prompt || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      let view
      let ack = null
      const sess = state.view && state.view.session
      // A locked business-agent drafting dialogue has no free-text /messages path
      // (it 409s). Route its refinement — including the 重新描述 action — to the
      // dedicated continue endpoint so the multi-round draft loop closes.
      if (sess && sess.route_locked && sess.intent === 'business_processing_agent' && sess.status === 'drafting_business_agent') {
        view = await factoryApi.continueDialogueBusiness(sess.id, prompt)
      } else if (!state.view || terminal(state.view.session.status)) {
        view = await factoryApi.createDialogue({ initialPrompt: prompt })
      } else {
        const result = await factoryApi.sendDialogueMessage(state.view.session.id, prompt)
        // 202 ack (continuing session): result carries {dialogueId, turnId, acceptedAt}
        // and NO composed view. 200 path: result IS the composed view (has .session).
        if (result && result.session) {
          view = result
        } else {
          ack = result
        }
      }
      await refreshSessions()
      if (view) {
        await loadView(view.session.id)
      } else if (ack && sess) {
        // Async turn: record the pending turn so the workbench renders a
        // cancel-current-turn control and the trace stream drives progress. We
        // DO NOT reload the view synchronously — the per-dialogue SSE events
        // (needsRefresh) will refresh it once the worker advances the state.
        if (mountedRef.current) setPendingTurn(ack)
      }
      return view || ack
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
      const sess = state.view.session
      if (sess.intent === 'business_processing_agent') {
        if (consolidation && consolidation.field) {
          view = await factoryApi.applyDialogueBusinessConsolidation(sess.id, {
            field: consolidation.field,
            value: consolidation.value,
          })
        } else {
          // Business drafting: the selected answer(s) become a refinement that
          // continues the draft round (the route is locked; there is no separate
          // answer endpoint).
          const content = answers.map(a => a.value).filter(Boolean).join('；')
          view = await factoryApi.continueDialogueBusiness(sess.id, content)
        }
      } else if (consolidation && consolidation.field) {
        // Round-6 single-field adjust path: the backend merges the persisted
        // consolidation with the override (no model turn) and marks ready_to_confirm.
        view = await factoryApi.applyDialogueConsolidation(sess.id, {
          field: consolidation.field,
          value: consolidation.value,
        })
      } else {
        view = await factoryApi.answerDialogueClarificationBatch(sess.id, answers)
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
  // with no args => 接受推荐 (accept-all: merge every persisted recommendation and
  // advance to ready_to_confirm). Called with {field, value} => one-field round-6
  // adjust (backend merges, no model turn). Both go through applyDialogueConsolidation
  // so the body carries top-level consolidation fields, not an {answers} wrapper.
  const acceptConsolidation = useCallback(async (adjust = null) => {
    if (!state.view || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const isBusiness = state.view.session.intent === 'business_processing_agent'
      const apply = isBusiness ? factoryApi.applyDialogueBusinessConsolidation : factoryApi.applyDialogueConsolidation
      const view = adjust && adjust.field
        ? await apply(state.view.session.id, { field: adjust.field, value: adjust.value })
        : await apply(state.view.session.id, { accept: true })
      await loadView(view.session.id)
      return view
    } catch (err) {
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

  // ---- continuous-workbench actions (Task 7) ------------------------------
  // cancelTurn cancels the currently-processing turn (the 202 ack's turnId) of
  // a continuing session. Clears the pending-turn indicator.
  const cancelTurn = useCallback(async () => {
    const sess = state.view && state.view.session
    if (!sess || !pendingTurn || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const dialogueId = sess.id
      const turnId = pendingTurn.turnId
      if (!turnId) {
        if (mountedRef.current) setPendingTurn(null)
        return null
      }
      await factoryApi.cancelDialogueTurn(dialogueId, turnId)
      if (mountedRef.current) setPendingTurn(null)
      await refreshSessions()
      await loadView(dialogueId)
      return true
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, pendingTurn, submitting])

  // rollback rolls a generated application back to the prior effective version
  // (confirm-gated server-side; we always send {confirm: true}). Used by the
  // version/rollback control in the workbench after a version deploys.
  const rollback = useCallback(async appId => {
    if (!appId || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const result = await factoryApi.rollbackApp(appId)
      await refreshSessions()
      if (state.selectedDialogueId) await loadView(state.selectedDialogueId)
      return result
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.selectedDialogueId, submitting])

  const confirmChange = useCallback(async () => {
    const sess = state.view && state.view.session
    if (!sess || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const result = await factoryApi.confirmDialogueChange(sess.id)
      await refreshSessions()
      await loadView(sess.id)
      return result
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  // archive marks the selected dialogue as archived. The backend endpoint
  // (POST /api/dialogues/:id/archive) is idempotent and sets status to
  // `archived`, emitting `dialogue.archived`. On success we refresh the list +
  // the selected view so the status reflects `archived`.
  const archive = useCallback(async () => {
    const sess = state.view && state.view.session
    if (!sess || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      await factoryApi.archiveDialogue(sess.id)
      await refreshSessions()
      await loadView(sess.id)
      return true
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [loadView, refreshSessions, state.view, submitting])

  // Per-dialogue work-trace SSE subscription (Constraint #7: detailed trace
  // events come ONLY via this dialogueId-filtered, sequence-replayable stream).
  // Re-subscribes when the selected dialogue changes; resets + re-hydrates the
  // folded trace. The reducer isolates + dedups, so hydration + live overlap is
  // idempotent.
  useEffect(() => {
    const dialogueId = state.selectedDialogueId
    if (!dialogueId) {
      setWorkTrace(initialWorkTraceState())
      return undefined
    }
    // Seed the state scoped to the selected dialogue; the SSE helper hydrates
    // from afterSequence=0 and folds each row through applyTraceEvent.
    let unsubscribe = () => {}
    setWorkTrace(resetWorkTraceState(dialogueId))
    unsubscribe = subscribeDialogueTrace(dialogueId, {
      afterSequence: 0,
      getDialogueTrace: factoryApi.getDialogueTrace,
      onEvent: row => {
        if (!mountedRef.current) return
        setWorkTrace(prev => applyTraceEvent(prev, row))
        // A trace that marks the pending turn terminal clears the indicator.
        // We key off the turn lifecycle event types the executor emits.
        const t = row && row.type
        if (
          pendingTurnRef.current &&
          (t === 'turn.completed' || t === 'turn.failed' || t === 'turn.canceled' || t === 'task.completed')
        ) {
          setPendingTurn(null)
        }
      },
      onError: () => {
        /* best-effort: the helper REST-reloads on gap; the reducer dedups. */
      },
    })
    return () => unsubscribe()
    // pendingTurn is read inside onEvent for the terminal-clear side effect, but
    // must NOT re-subscribe the stream on every turn change; read it via ref.
  }, [state.selectedDialogueId]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // Focus task for the SELECTED dialogue (Constraint #10 — switching a history
  // session syncs its focus task). Memoized cheaply over the job list + dialogue.
  // No selected session (e.g. just clicked "新建会话") ⇒ no focus task, so the
  // task panel shows its empty placeholder instead of the cross-session fallback
  // (which would otherwise surface the previous session's task in a workbench
  // whose conversation has already been cleared).
  const focusTask = state.view ? selectFocusTask(jobsForFocus, state.selectedDialogueId) : null

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
    // Task 7 continuous-workbench surface:
    workTrace: workTrace.items,
    workTraceCursor: workTrace.highestSequence,
    pendingTurn,
    focusTask,
    setJobsForFocus,
    cancelTurn,
    rollback,
    confirmChange,
    archive,
  }
}
