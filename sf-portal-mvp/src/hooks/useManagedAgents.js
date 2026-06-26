import { useState, useEffect, useCallback } from 'react'
import { factoryApi } from '../api/client'

export function useManagedAgents() {
  const [managedAgents, setManagedAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await factoryApi.listManagedAgents()
      setManagedAgents(Array.isArray(data) ? data : (data.managedAgents || []))
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return {
    managedAgents,
    loading,
    error,
    refresh,
  }
}
