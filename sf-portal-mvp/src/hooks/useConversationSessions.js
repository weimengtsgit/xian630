import { useCallback, useEffect, useRef, useState } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'
import {
  applyConversationEvent,
  buildTimelineFromMessages,
  initialConversationState,
  questionsFromMessages,
} from './conversationTimeline'
import { moveSelectedBusinessAgent } from './agentList'

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
  'agent_authoring.draft.updated',
])

const terminal = status => status === 'confirmed' || status === 'abandoned' || status === 'failed'

export function useConversationSessions() {
  const [state, setState] = useState(initialConversationState)
  const [error, setError] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedBusinessAgents, setSelectedBusinessAgents] = useState([])
  const mountedRef = useRef(true)

  const loadBusinessAgentsForSession = useCallback(async sessionId => {
    if (!sessionId) {
      if (mountedRef.current) setSelectedBusinessAgents([])
      return []
    }
    const agents = await factoryApi.getClarificationBusinessAgents(sessionId)
    const list = Array.isArray(agents) ? agents : []
    if (mountedRef.current) setSelectedBusinessAgents(list)
    return list
  }, [])

  const refreshSessions = useCallback(async () => {
    const data = await factoryApi.listClarifications(50)
    const sessions = Array.isArray(data) ? data : data.sessions || []
    if (mountedRef.current) {
      setState(prev => ({ ...prev, sessions }))
    }
    return sessions
  }, [])

  const selectSession = useCallback(async id => {
    if (!id) {
      setSelectedBusinessAgents([])
      setState(prev => ({
        ...initialConversationState(),
        sessions: prev.sessions,
        selectedSessionId: null,
        session: null,
      }))
      return null
    }
    setError(null)
    const [session, messages, businessAgents] = await Promise.all([
      factoryApi.getClarification(id),
      factoryApi.getClarificationMessages(id),
      loadBusinessAgentsForSession(id).catch(() => []),
    ])
    if (mountedRef.current) {
      setSelectedBusinessAgents(businessAgents)
      setState(prev => ({
        ...prev,
        selectedSessionId: session.id,
        session,
        requirement: session.requirement || null,
        timeline: buildTimelineFromMessages(messages, session),
        questions: questionsFromMessages(messages, session.status),
        blueprints: [],
      }))
    }
    return session
  }, [loadBusinessAgentsForSession])

  const newSession = useCallback(() => {
    setError(null)
    setSelectedBusinessAgents([])
    setState(prev => ({
      ...initialConversationState(),
      sessions: prev.sessions,
      selectedSessionId: null,
      session: null,
    }))
  }, [])

  const replaceBusinessAgents = useCallback(async agentIds => {
    if (!state.session?.id) return []
    const agents = await factoryApi.replaceClarificationBusinessAgents(state.session.id, agentIds)
    const list = Array.isArray(agents) ? agents : []
    if (mountedRef.current) setSelectedBusinessAgents(list)
    return list
  }, [state.session?.id])

  const addBusinessAgent = useCallback(agent => {
    if (!agent?.id) return Promise.resolve(selectedBusinessAgents)
    const selectedIds = selectedBusinessAgents.map(item => item.id)
    if (selectedIds.includes(agent.id)) return Promise.resolve(selectedBusinessAgents)
    return replaceBusinessAgents([...selectedIds, agent.id])
  }, [replaceBusinessAgents, selectedBusinessAgents])

  const removeBusinessAgent = useCallback(agentId => {
    const selectedIds = selectedBusinessAgents.map(item => item.id).filter(id => id !== agentId)
    return replaceBusinessAgents(selectedIds)
  }, [replaceBusinessAgents, selectedBusinessAgents])

  const moveBusinessAgent = useCallback((agentId, delta) => {
    const selectedIds = selectedBusinessAgents.map(item => item.id)
    return replaceBusinessAgents(moveSelectedBusinessAgent(selectedIds, agentId, delta))
  }, [replaceBusinessAgents, selectedBusinessAgents])

  const send = useCallback(async content => {
    const prompt = String(content || '').trim()
    if (!prompt || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      let session
      if (!state.session || terminal(state.session.status)) {
        session = await factoryApi.createClarification(prompt)
      } else {
        session = await factoryApi.sendClarificationMessage(state.session.id, prompt)
      }
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const answerBatch = useCallback(async answers => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.answerClarificationBatch(state.session.id, answers)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const confirm = useCallback(async () => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.confirmClarification(state.session.id)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const retry = useCallback(async () => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.retryClarificationRound(state.session.id)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const abandon = useCallback(async () => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.abandonClarification(state.session.id)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const startAuthoring = useCallback(async () => {
    setError(null)
    setSelectedBusinessAgents([])
    setSubmitting(true)
    try {
      const session = await factoryApi.createClarification(
        '请帮我创建一个业务智能体',
        { mode: 'agent_authoring' }
      )
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession])

  const saveAuthoringAgent = useCallback(async () => {
    if (!state.session || submitting) return null
    // Extract the latest draft from timeline (last agent_draft item)
    const draftItems = state.timeline.filter(item => item.type === 'agent_draft')
    const latestDraft = draftItems[draftItems.length - 1]?.draft
    if (!latestDraft?.key || !latestDraft?.name || !latestDraft?.prompt) {
      throw new Error('Draft is missing required fields (name, key, prompt)')
    }
    setSubmitting(true)
    setError(null)
    try {
      const created = await factoryApi.createBusinessAgent({
        key: latestDraft.key,
        name: latestDraft.name,
        description: latestDraft.description || '',
        prompt: latestDraft.prompt,
        enabled: true,
      })
      // Mark session as complete (no job creation in agent_authoring mode)
      await factoryApi.confirmClarification(state.session.id)
      await refreshSessions()
      return created
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, state.session, state.timeline, submitting])

  useEffect(() => {
    mountedRef.current = true
    refreshSessions().then(sessions => {
      if (sessions[0]) selectSession(sessions[0].id).catch(() => {})
    }).catch(err => {
      if (mountedRef.current) setError(err.message || String(err))
    })
    const unsubscribe = subscribeFactoryEvents((type, raw) => {
      if (!mountedRef.current || !CLARIFICATION_TYPES.has(type)) return
      const ev = raw && typeof raw === 'object' && 'seq' in raw ? raw.data : raw
      if (!ev) return
      setState(prev => applyConversationEvent(prev, type, ev))
      refreshSessions().catch(() => {})
    })
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [refreshSessions, selectSession])

  return {
    ...state,
    selectedBusinessAgents,
    selectedBusinessAgentIds: selectedBusinessAgents.map(agent => agent.id),
    error,
    submitting,
    historyOpen,
    setHistoryOpen,
    refreshSessions,
    selectSession,
    newSession,
    send,
    answerBatch,
    confirm,
    retry,
    abandon,
    startAuthoring,
    saveAuthoringAgent,
    addBusinessAgent,
    removeBusinessAgent,
    moveBusinessAgent,
    replaceBusinessAgents,
  }
}
