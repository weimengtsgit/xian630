import { useState, useEffect, useCallback } from 'react'
import { factoryApi } from '../api/client'

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

  const createAgent = useCallback(async agent => {
    setError(null)
    const created = await factoryApi.createAgent(agent)
    setAgents(current => {
      const next = [...current, created]
      next.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      return next
    })
    return created
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

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
    getWorkingAgents,
    assignTask,
    stopAgent,
  }
}
