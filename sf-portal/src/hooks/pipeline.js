const AUTO_TASKS = {
  'agent-prototype': '界面结构解析与元素拆解',
  'agent-data': '数据采集与字段抽取',
  'agent-production': '代码生成与工程交付'
}

const PROGRESS_SPEEDS = {
  'agent-prototype': { min: 9, span: 7 },
  'agent-data': { min: 2, span: 3 },
  default: { min: 4, span: 4 }
}

export function getAgentProgressIncrement(agentId, randomValue = Math.random()) {
  const speed = PROGRESS_SPEEDS[agentId] || PROGRESS_SPEEDS.default
  return speed.min + randomValue * speed.span
}

export function advanceAgentProgress(agent, increment, now = () => new Date()) {
  if (agent.status !== 'working' || agent.progress >= 100) {
    return agent
  }

  const nextProgress = Math.min(agent.progress + increment, 100)
  const roundedProgress = Math.round(nextProgress)

  if (roundedProgress >= 100) {
    return {
      ...agent,
      progress: 100,
      status: 'completed',
      lastActivity: now()
    }
  }

  return {
    ...agent,
    progress: roundedProgress,
    lastActivity: now()
  }
}

function startAgent(agent, now) {
  return {
    ...agent,
    status: 'working',
    currentTask: AUTO_TASKS[agent.id] || agent.currentTask,
    progress: 0,
    lastActivity: now()
  }
}

export function advancePipeline(agents, now = () => new Date()) {
  const byId = (id) => agents.find((agent) => agent.id === id)
  const business = byId('agent-business')
  const prototype = byId('agent-prototype')
  const data = byId('agent-data')
  const production = byId('agent-production')

  const shouldStartParallel =
    business?.status === 'completed' &&
    (prototype?.status === 'idle' || data?.status === 'idle')

  const shouldStartProduction =
    prototype?.status === 'completed' &&
    data?.status === 'completed' &&
    production?.status === 'idle'

  if (!shouldStartParallel && !shouldStartProduction) {
    return agents
  }

  return agents.map((agent) => {
    if (shouldStartParallel && (agent.id === 'agent-prototype' || agent.id === 'agent-data') && agent.status === 'idle') {
      return startAgent(agent, now)
    }

    if (shouldStartProduction && agent.id === 'agent-production') {
      return startAgent(agent, now)
    }

    return agent
  })
}
