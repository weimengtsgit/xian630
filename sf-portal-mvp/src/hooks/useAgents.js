import { useState, useEffect, useCallback } from 'react'
import { factoryApi } from '../api/client'
import { appendCreatedAgentForDisplay, splitAgentsByCategory } from './agentList'

export function useAgents() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  const createBusinessAgent = useCallback(async agent => {
    setError(null)
    const created = await factoryApi.createBusinessAgent(agent)
    setAgents(current => appendCreatedAgentForDisplay(current, created))
    return created
  }, [])

  const updateBusinessAgent = useCallback(async (id, agent) => {
    setError(null)
    const updated = await factoryApi.updateBusinessAgent(id, agent)
    setAgents(current => current.map(item => item.id === updated.id ? updated : item))
    return updated
  }, [])

  const setBusinessAgentEnabled = useCallback(async (id, enabled) => {
    setError(null)
    const updated = await factoryApi.setBusinessAgentEnabled(id, enabled)
    setAgents(current => current.map(item => item.id === updated.id ? updated : item))
    return updated
  }, [])

  // No-op stubs kept for legacy component compatibility; Task 15 reworks the UI.
  const getWorkingAgents = useCallback(
    () => agents.filter(a => a.status === 'working'),
    [agents]
  )
  const assignTask = useCallback(() => {}, [])
  const stopAgent = useCallback(() => {}, [])

  const { software: softwareAgents, business: businessAgents } = splitAgentsByCategory(agents)

  return {
    agents,
    softwareAgents,
    businessAgents,
    loading,
    error,
    refresh,
    createAgent,
    createBusinessAgent,
    updateBusinessAgent,
    setBusinessAgentEnabled,
    getWorkingAgents,
    assignTask,
    stopAgent,
  }
}
