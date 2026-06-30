const USER_INPUT_KEY = '__user_input__'
const ORCHESTRATOR_KEY = 'collaboration-orchestrator'

const DEFAULT_AGENT_DESCRIPTIONS = {
  'collaboration-orchestrator': '根据确认需求摘要生成协作计划，并记录用户调整。',
  'requirement-analyst': '整理用户需求并形成确认需求摘要。',
  'domain-analyst': '注入领域知识和客户判断口径。',
  designer: '产出结构化设计契约。',
  'data-integration': '产出真实数据接入计划和演示数据契约。',
  'solution-designer': '形成技术方案、文件计划和实现边界。',
  'code-generator': '写入应用代码并生成 manifest。',
  'code-reviewer': '阻断式质量门禁。',
  'security-reviewer': '检查安全和权限风险。',
  tester: '运行或分析构建与测试结果。',
  'product-acceptance': '检查生成结果是否满足需求、设计和数据契约。',
  'image-builder': '构建应用容器镜像。',
  deployer: '部署容器并完成健康验证。',
}

const DEFAULT_ROLE_DESCRIPTIONS = {
  collaboration_orchestration: DEFAULT_AGENT_DESCRIPTIONS['collaboration-orchestrator'],
  requirement_analysis: DEFAULT_AGENT_DESCRIPTIONS['requirement-analyst'],
  domain_analysis: DEFAULT_AGENT_DESCRIPTIONS['domain-analyst'],
  design_contract: DEFAULT_AGENT_DESCRIPTIONS.designer,
  data_integration: DEFAULT_AGENT_DESCRIPTIONS['data-integration'],
  solution_design: DEFAULT_AGENT_DESCRIPTIONS['solution-designer'],
  code_generation: DEFAULT_AGENT_DESCRIPTIONS['code-generator'],
  code_review: DEFAULT_AGENT_DESCRIPTIONS['code-reviewer'],
  security_review: DEFAULT_AGENT_DESCRIPTIONS['security-reviewer'],
  test_verification: DEFAULT_AGENT_DESCRIPTIONS.tester,
  product_acceptance: DEFAULT_AGENT_DESCRIPTIONS['product-acceptance'],
  image_build: DEFAULT_AGENT_DESCRIPTIONS['image-builder'],
  deployment: DEFAULT_AGENT_DESCRIPTIONS.deployer,
}

export const CARD_STATE_LABEL = {
  pending_confirmation: '待确认',
  waiting_upstream: '等待上游',
  ready: '待启动',
  running: '执行中',
  waiting_user: '等待用户',
  manual_confirmation: '待人工确认',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
}

export const EDGE_STATE_LABEL = {
  planned: '计划',
  inactive: '未激活',
  flowing: '流转中',
  completed: '已完成',
  blocked: '阻塞',
  blocked_failed: '失败阻塞',
  blocked_waiting_user: '等待用户',
  blocked_manual_confirmation: '等待确认',
}

export function buildCollaborationExecutionGraphView(preview, jobStepBlocks = []) {
  const agents = Array.isArray(preview && preview.agents) ? preview.agents : []
  const edges = dedupeEdges(Array.isArray(preview && preview.edges) ? preview.edges : [])
  const steps = Array.isArray(jobStepBlocks) ? jobStepBlocks : []
  const confirmed = steps.some(step => step && (step.stepId || step.step_id || step.id))
  const stepByAgent = Object.fromEntries(
    steps
      .filter(step => step && (step.agentKey || step.agent_key))
      .map(step => [step.agentKey || step.agent_key, step]),
  )
  const agentByKey = Object.fromEntries(agents.filter(agent => agent && agent.key).map(agent => [agent.key, agent]))
  const incoming = incomingMap(edges)
  const outgoing = outgoingMap(edges)
  const rankByAgent = topologicalRanks(agents, edges)
  const agentOrder = Object.fromEntries(agents.map((agent, index) => [agent.key, index]))
  const originCard = {
    id: USER_INPUT_KEY,
    kind: 'origin',
    agentKey: USER_INPUT_KEY,
    title: '用户输入',
    subtitle: '需求描述',
    description: '来自对话中的确认需求',
    tooltip: '来自对话中的确认需求',
    state: confirmed ? 'completed' : 'pending_confirmation',
    stateLabel: confirmed ? CARD_STATE_LABEL.completed : CARD_STATE_LABEL.pending_confirmation,
    lane: 'origin',
    wave: 0,
    stepId: null,
    waitingFor: [],
    highImpact: false,
  }
  const agentCards = agents.map(agent => {
    const step = stepByAgent[agent.key] || null
    const upstreamKeys = incoming[agent.key] || []
    const waitingFor = upstreamKeys
      .filter(key => !isCompleted(cardStateForStep(stepByAgent[key], confirmed, [])))
      .map(key => agentByKey[key] && (agentByKey[key].name || agentByKey[key].key) || key)
    const state = cardStateForStep(step, confirmed, waitingFor)
    const description = agentDescription(agent)
    const manualConfirmation = isManualConfirmationStep(step)
    return {
      id: agent.key,
      kind: agent.key === ORCHESTRATOR_KEY ? 'orchestrator' : 'agent',
      agentKey: agent.key,
      title: agent.name || agent.key,
      subtitle: agent.role || agent.key,
      description,
      tooltip: description,
      state,
      stateLabel: manualConfirmation ? CARD_STATE_LABEL.manual_confirmation : CARD_STATE_LABEL[state] || state,
      lane: agent.lane || 'unassigned',
      wave: Math.max(1, (rankByAgent[agent.key] || 0) + 1),
      stepId: step && (step.stepId || step.step_id || step.id) || null,
      step,
      summary: manualConfirmation ? '任务已完成，等待人工确认继续。' : step && (step.summary || step.error || '') || '',
      manualConfirmation,
      waitingFor,
      highImpact: !!agent.highImpact,
      upstream: upstreamKeys,
      downstream: outgoing[agent.key] || [],
      order: agentOrder[agent.key] || 0,
    }
  })
  const cards = [originCard, ...agentCards].sort((a, b) => {
    if (a.wave !== b.wave) return a.wave - b.wave
    if (a.kind === 'origin') return -1
    if (b.kind === 'origin') return 1
    if (a.kind === 'orchestrator') return -1
    if (b.kind === 'orchestrator') return 1
    return (a.order || 0) - (b.order || 0)
  })
  const cardsByKey = Object.fromEntries(cards.map(card => [card.agentKey, card]))
  const graphEdges = [
    { from: USER_INPUT_KEY, to: ORCHESTRATOR_KEY },
    ...edges,
  ]
    .filter(edge => cardsByKey[edge.from] && cardsByKey[edge.to])
    .map(edge => ({
      id: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      state: edgeState(cardsByKey[edge.from], cardsByKey[edge.to], confirmed),
    }))
  const waves = buildWaves(cards)
  return {
    confirmed,
    cards,
    cardsByKey,
    edges: graphEdges,
    waves,
    summary: summarize(cards),
    manualStepConfirmation: !!(preview && preview.executionPolicy && preview.executionPolicy.manualStepConfirmation),
    adjustments: Array.isArray(preview && preview.adjustments) ? preview.adjustments : [],
  }
}

function agentDescription(agent) {
  if (!agent) return ''
  return DEFAULT_AGENT_DESCRIPTIONS[agent.key] ||
    DEFAULT_ROLE_DESCRIPTIONS[agent.role] ||
    agent.description ||
    ''
}

function cardStateForStep(step, confirmed, waitingFor) {
  if (!confirmed) return 'pending_confirmation'
  if (!step) return waitingFor.length > 0 ? 'waiting_upstream' : 'ready'
  const status = step.status || step.state || 'pending'
  if (status === 'running') return 'running'
  if (status === 'waiting_user') return 'waiting_user'
  if (status === 'failed') return 'failed'
  if (status === 'succeeded' || status === 'completed') return 'completed'
  if (status === 'skipped' || status === 'canceled' || status === 'cancelled') return 'skipped'
  return waitingFor.length > 0 ? 'waiting_upstream' : 'ready'
}

function isManualConfirmationStep(step) {
  if (!step) return false
  if (step.manualConfirmation || step.manual_confirmation) return true
  const raw = step.pendingQuestions || step.pending_questions || ''
  if (!raw) return false
  try {
    const items = JSON.parse(raw)
    return Array.isArray(items) && items.some(item => item && item.type === 'manual_step_confirmation' && item.confirm)
  } catch {
    return false
  }
}

function edgeState(fromCard, toCard, confirmed) {
  if (!confirmed) return 'planned'
  if (!fromCard || !toCard) return 'inactive'
  if (fromCard.state === 'failed' || toCard.state === 'failed') return 'blocked_failed'
  if (fromCard.manualConfirmation || toCard.manualConfirmation) return 'blocked_manual_confirmation'
  if (toCard.state === 'waiting_user') return 'blocked_waiting_user'
  if (toCard.state === 'completed') return 'completed'
  if (fromCard.state === 'completed' && (toCard.state === 'ready' || toCard.state === 'running')) return 'flowing'
  return 'inactive'
}

function isCompleted(state) {
  return state === 'completed'
}

function dedupeEdges(edges) {
  const seen = new Set()
  const out = []
  for (const edge of edges) {
    if (!edge || !edge.from || !edge.to) continue
    const key = `${edge.from}->${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from: edge.from, to: edge.to })
  }
  return out
}

function incomingMap(edges) {
  const map = {}
  for (const edge of edges) {
    if (!map[edge.to]) map[edge.to] = []
    map[edge.to].push(edge.from)
  }
  return map
}

function outgoingMap(edges) {
  const map = {}
  for (const edge of edges) {
    if (!map[edge.from]) map[edge.from] = []
    map[edge.from].push(edge.to)
  }
  return map
}

function topologicalRanks(agents, edges) {
  const keys = agents.filter(agent => agent && agent.key).map(agent => agent.key)
  const ranks = Object.fromEntries(keys.map(key => [key, 0]))
  for (let pass = 0; pass < keys.length; pass += 1) {
    let changed = false
    for (const edge of edges) {
      if (!(edge.from in ranks) || !(edge.to in ranks)) continue
      const nextRank = ranks[edge.from] + 1
      if (nextRank > ranks[edge.to]) {
        ranks[edge.to] = nextRank
        changed = true
      }
    }
    if (!changed) break
  }
  return ranks
}

function buildWaves(cards) {
  const groups = new Map()
  for (const card of cards) {
    if (!groups.has(card.wave)) groups.set(card.wave, [])
    groups.get(card.wave).push(card)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([wave, waveCards]) => ({
      id: `wave-${wave}`,
      index: wave,
      label: wave === 0 ? '起点' : wave === 1 ? '编排' : `第 ${wave - 1} 波`,
      cards: waveCards,
    }))
}

function summarize(cards) {
  const agentCards = cards.filter(card => card.kind !== 'origin')
  return {
    totalAgents: agentCards.length,
    pendingConfirmation: agentCards.filter(card => card.state === 'pending_confirmation').length,
    waitingUpstream: agentCards.filter(card => card.state === 'waiting_upstream').length,
    ready: agentCards.filter(card => card.state === 'ready').length,
    running: agentCards.filter(card => card.state === 'running').length,
    waitingUser: agentCards.filter(card => card.state === 'waiting_user').length,
    completed: agentCards.filter(card => card.state === 'completed').length,
    failed: agentCards.filter(card => card.state === 'failed').length,
    skipped: agentCards.filter(card => card.state === 'skipped').length,
  }
}
