import { useState, useEffect, useCallback, useRef } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'
import { selectDisplayJob } from './jobSelection'

export function useJobs() {
  const [jobs, setJobs] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const [steps, setSteps] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await factoryApi.listJobs()
      const list = Array.isArray(data) ? data : (data.jobs || [])
      if (!mountedRef.current) return
      setJobs(list)

      const active = selectDisplayJob(list)
      setActiveJob(active || null)

      if (active) {
        try {
          const stepsData = await factoryApi.getJobSteps(active.id)
          const stepsList = Array.isArray(stepsData) ? stepsData : (stepsData.steps || [])
          if (!mountedRef.current) return
          setSteps(stepsList)
        } catch (e) {
          if (mountedRef.current) setSteps([])
        }
      } else {
        setSteps([])
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  const createJob = useCallback(async prompt => {
    setError(null)
    try {
      await factoryApi.createJob(prompt)
      await refresh()
    } catch (err) {
      setError(err.message || String(err))
      throw err
    }
  }, [refresh])

  const cancelJob = useCallback(async id => {
    setError(null)
    try {
      await factoryApi.cancelJob(id)
      await refresh()
    } catch (err) {
      setError(err.message || String(err))
    }
  }, [refresh])

  const retryCurrentStep = useCallback(async id => {
    setError(null)
    try {
      await factoryApi.retryCurrentStep(id)
      await refresh()
    } catch (err) {
      setError(err.message || String(err))
    }
  }, [refresh])

  const answerJob = useCallback(async (id, answer) => {
    setError(null)
    try {
      await factoryApi.answerJob(id, answer)
      await refresh()
    } catch (err) {
      setError(err.message || String(err))
      throw err
    }
  }, [refresh])

  useEffect(() => {
    mountedRef.current = true
    refresh()
    const unsubscribe = subscribeFactoryEvents(type => {
      if (!mountedRef.current) return
      if (type === 'job.created' || type === 'job.updated' || type === 'step.updated') {
        refresh()
      }
    })
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [refresh])

  return {
    jobs,
    activeJob,
    steps,
    loading,
    error,
    refresh,
    createJob,
    cancelJob,
    answerJob,
    retryCurrentStep,
  }
}
