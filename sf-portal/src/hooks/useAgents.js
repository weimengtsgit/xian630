import { useState, useEffect } from 'react'
import { mockAgents } from '../data/mockData'
import { advanceAgentProgress, advancePipeline, getAgentProgressIncrement } from './pipeline.js'

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
      setAgents(prev => {
        const progressedAgents = prev.map(agent =>
          advanceAgentProgress(agent, getAgentProgressIncrement(agent.id))
        )

        return advancePipeline(progressedAgents)
      })
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

  const createAgent = (name, type) => {
    const newAgent = {
      id: `agent-${Date.now()}`,
      name,
      type,
      status: 'idle',
      currentTask: null,
      progress: 0,
      lastActivity: new Date()
    }
    setAgents(prev => [...prev, newAgent])
  }

  return {
    agents,
    loading,
    getWorkingAgents,
    assignTask,
    stopAgent,
    createAgent
  }
}
