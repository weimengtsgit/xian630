import { useState, useEffect } from 'react'
import { mockApplications } from '../data/mockData'

export function useApplications() {
  const [applications, setApplications] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 模拟异步加载
    const timer = setTimeout(() => {
      setApplications(mockApplications)
      setLoading(false)
    }, 500)

    return () => clearTimeout(timer)
  }, [])

  const startApplication = (id) => {
    setApplications(prev =>
      prev.map(app =>
        app.id === id
          ? { ...app, status: 'running', startedAt: new Date() }
          : app
      )
    )
  }

  const stopApplication = (id) => {
    setApplications(prev =>
      prev.map(app =>
        app.id === id
          ? { ...app, status: 'stopped' }
          : app
      )
    )
  }

  const restartApplication = (id) => {
    setApplications(prev =>
      prev.map(app =>
        app.id === id
          ? { ...app, status: 'running', startedAt: new Date() }
          : app
      )
    )
  }

  return {
    applications,
    loading,
    startApplication,
    stopApplication,
    restartApplication
  }
}
