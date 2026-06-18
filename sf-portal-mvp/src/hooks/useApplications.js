import { useState, useEffect, useCallback } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'

export function useApplications() {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionById, setActionById] = useState({})

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
      if (
        type === 'app.updated' ||
        type === 'deployment.updated' ||
        type === 'job.updated' ||
        type === 'step.updated'
      ) {
        refresh()
      }
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [refresh])

  const runAction = useCallback(async (id, action, label) => {
    setActionById(prev => ({ ...prev, [id]: label }))
    setError(null)
    try {
      await action(id)
      await refresh()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setActionById(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }, [refresh])

  const startApplication = useCallback(id => runAction(id, factoryApi.startApp, 'start'), [runAction])
  const stopApplication = useCallback(id => runAction(id, factoryApi.stopApp, 'stop'), [runAction])
  const restartApplication = useCallback(id => runAction(id, factoryApi.rebuildApp, 'rebuild'), [runAction])

  // Keep `applications` alias so the existing ApplicationsPanel destructure works.
  return {
    apps,
    applications: apps,
    loading,
    error,
    actionById,
    refresh,
    startApplication,
    stopApplication,
    restartApplication,
  }
}
