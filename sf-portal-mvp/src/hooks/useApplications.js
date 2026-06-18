import { useState, useEffect, useCallback } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'

export function useApplications() {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await factoryApi.listApps()
      setApps(Array.isArray(data) ? data : (data.apps || []))
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    refresh()
    const unsubscribe = subscribeFactoryEvents(type => {
      if (!mounted) return
      if (type === 'app.updated' || type === 'deployment.updated') {
        refresh()
      }
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [refresh])

  // Delegate start/stop/rebuild to the API; components that call these will
  // rely on SSE app.updated to reflect state changes, but we also refresh.
  const startApplication = useCallback(async id => {
    try { await factoryApi.startApp(id) } catch (e) { setError(e.message) }
    refresh()
  }, [refresh])
  const stopApplication = useCallback(async id => {
    try { await factoryApi.stopApp(id) } catch (e) { setError(e.message) }
    refresh()
  }, [refresh])
  const restartApplication = useCallback(async id => {
    try { await factoryApi.rebuildApp(id) } catch (e) { setError(e.message) }
    refresh()
  }, [refresh])

  // Keep `applications` alias so the existing ApplicationsPanel destructure works.
  return {
    apps,
    applications: apps,
    loading,
    error,
    refresh,
    startApplication,
    stopApplication,
    restartApplication,
  }
}
