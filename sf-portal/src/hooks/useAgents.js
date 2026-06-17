import { useState, useEffect } from 'react'
import { mockAgents } from '../data/mockData'

export function useAgents() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 模拟异步加载
    const timer = setTimeout(() => {
      setAgents(mockAgents)
      setLoading(false)
    }, 500)

    return () => clearTimeout(timer)
  }, [])

  // 模拟智能体工作进度更新
  useEffect(() => {
    const interval = setInterval(() => {
      setAgents(prev =>
        prev.map(agent => {
          if (agent.status === 'working' && agent.progress < 100) {
            const newProgress = Math.min(agent.progress + Math.random() * 5, 100)
            if (newProgress >= 100) {
              return {
                ...agent,
                progress: 100,
                status: 'completed',
                lastActivity: new Date()
              }
            }
            return {
              ...agent,
              progress: Math.round(newProgress),
              lastActivity: new Date()
            }
          }
          return agent
        })
      )
    }, 2000)

    return () => clearInterval(interval)
  }, [])

  const getWorkingAgents = () => {
    return agents.filter(agent => agent.status === 'working')
  }

  const assignTask = (agentId, task) => {
    setAgents(prev =>
      prev.map(agent =>
        agent.id === agentId
          ? {
              ...agent,
              status: 'working',
              currentTask: task,
              progress: 0,
              lastActivity: new Date()
            }
          : agent
      )
    )
  }

  const stopAgent = (agentId) => {
    setAgents(prev =>
      prev.map(agent =>
        agent.id === agentId
          ? {
              ...agent,
              status: 'idle',
              currentTask: null,
              progress: 0,
              lastActivity: new Date()
            }
          : agent
      )
    )
  }

  return {
    agents,
    loading,
    getWorkingAgents,
    assignTask,
    stopAgent
  }
}
