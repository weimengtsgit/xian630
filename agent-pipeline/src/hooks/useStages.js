import { useState, useEffect, useRef } from 'react'
import { allCompleted } from './stagesLogic.js'

export function useStages(intervalMs = 5000) {
  const [stages, setStages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)

  async function fetchStages() {
    try {
      const res = await fetch('/api/stages')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStages(data.stages || [])
      setError(null)
      if (allCompleted(data.stages || [])) {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function init() {
      // 强刷清空：页面加载先把后端 reset 成全 pending，再开始轮询
      try { await fetch('/api/stages/reset', { method: 'POST' }) } catch { /* 兜底交给 fetchStages */ }
      if (cancelled) return
      fetchStages()
      timerRef.current = setInterval(fetchStages, intervalMs)
    }
    init()
    return () => {
      cancelled = true
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [intervalMs])

  // 点击卡片：前端发起，置为「进行中」
  async function activate(key) {
    try {
      await fetch(`/api/stages/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'working' })
      })
      fetchStages()
    } catch (e) {
      setError(e.message)
    }
  }

  return { stages, loading, error, activate }
}
