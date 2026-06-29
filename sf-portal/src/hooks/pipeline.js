const PIPELINE_ORDER = [
  'agent-business',
  'agent-prototype',
  'agent-data',
  'agent-production',
]

const TASK_BY_AGENT = {
  'agent-business': '业务流程建模与逻辑拆解',
  'agent-prototype': '界面结构解析与原型编排',
  'agent-data': '数据采集策略与字段抽取',
  'agent-production': '代码生成与工程交付',
}

const PROGRESS_INCREMENT_BY_AGENT = {
  'agent-business': 14,
  'agent-prototype': 18,
  'agent-data': 16,
  'agent-production': 12,
}

export function getAgentProgressIncrement(agentId) {
  return PROGRESS_INCREMENT_BY_AGENT[agentId] || 10
}

export function advanceAgentProgress(agent, increment) {
  if (!agent || agent.status !== 'working') return agent
  const nextProgress = Math.min(100, Number(agent.progress || 0) + Number(increment || 0))
  return {
    ...agent,
    progress: nextProgress,
    status: nextProgress >= 100 ? 'completed' : 'working',
    currentTask: nextProgress >= 100 ? null : agent.currentTask,
    lastActivity: new Date(),
  }
}

export function advancePipeline(agents) {
  const list = Array.isArray(agents) ? agents : []
  const byId = Object.fromEntries(list.map(agent => [agent.id, agent]))

  const businessDone = byId['agent-business']?.status === 'completed'
  const prototypeDone = byId['agent-prototype']?.status === 'completed'
  const dataDone = byId['agent-data']?.status === 'completed'
  const parallelRunning = byId['agent-prototype']?.status === 'working' || byId['agent-data']?.status === 'working'
  const productionReady = prototypeDone && dataDone

  return list.map(agent => {
    if (!agent || agent.status !== 'idle') return agent
    if ((agent.id === 'agent-prototype' || agent.id === 'agent-data') && businessDone) {
      return startAgent(agent)
    }
    if (agent.id === 'agent-production' && productionReady && !parallelRunning) {
      return startAgent(agent)
    }
    return agent
  }).sort((a, b) => PIPELINE_ORDER.indexOf(a.id) - PIPELINE_ORDER.indexOf(b.id))
}

function startAgent(agent) {
  return {
    ...agent,
    status: 'working',
    currentTask: TASK_BY_AGENT[agent.id] || '处理流水线任务',
    progress: 0,
    lastActivity: new Date(),
  }
}
