import { useState, useEffect, useRef } from 'react'
import { allCompleted } from './stagesLogic.js'

export function useStages(intervalMs = 5000) {
  const [stages, setStages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch('/api/stages')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        const next = data.stages || []
        setStages(next)
        setError(null)
        if (allCompleted(next)) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    poll()
    timerRef.current = setInterval(poll, intervalMs)
    return () => {
      cancelled = true
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [intervalMs])

  return { stages, loading, error }
}
