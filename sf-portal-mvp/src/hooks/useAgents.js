import { useState, useEffect, useCallback } from 'react'
import { factoryApi } from '../api/client'
import { appendCreatedAgentForDisplay } from './agentList'

export function useAgents() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deletingAgentId, setDeletingAgentId] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await factoryApi.listAgents()
      setAgents(Array.isArray(data) ? data : (data.agents || []))
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createAgent = useCallback(async agent => {
    setError(null)
    const created = await factoryApi.createAgent(agent)
    setAgents(current => appendCreatedAgentForDisplay(current, created))
    return created
  }, [])

  // deleteAgent removes a business agent. Single-flight on deletingAgentId (the
  // confirm card only allows one pending delete at a time) and refreshes the
  // list on success. Errors surface via `error`; the card re-throws so its
  // spinner clears and pending stays for retry.
  const deleteAgent = useCallback(async id => {
    if (!id || deletingAgentId) return null
    setDeletingAgentId(id)
    setError(null)
    try {
      await factoryApi.deleteAgent(id)
      await refresh()
      return true
    } catch (err) {
      setError(err.message || String(err))
      throw err
    } finally {
      setDeletingAgentId(null)
    }
  }, [deletingAgentId, refresh])

  // No-op stubs kept for legacy component compatibility; Task 15 reworks the UI.
  const getWorkingAgents = useCallback(
    () => agents.filter(a => a.status === 'working'),
    [agents]
  )
  const assignTask = useCallback(() => {}, [])
  const stopAgent = useCallback(() => {}, [])

  return {
    agents,
    loading,
    error,
    refresh,
    createAgent,
    deleteAgent,
    deletingAgentId,
    getWorkingAgents,
    assignTask,
    stopAgent,
  }
}
