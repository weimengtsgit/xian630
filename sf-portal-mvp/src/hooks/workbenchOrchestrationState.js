export const AGGREGATE_CARD_KEYS = ['user_input', 'business_logic', 'interface_parsing', 'data_capture', 'production_delivery']

const CARD_LABELS = {
  user_input: '用户输入',
  business_logic: '业务逻辑',
  interface_parsing: '界面解析',
  data_capture: '数据抓取',
  production_delivery: '生产交付',
}

const AGENT_TO_CARD = {
  '__user_input__': 'user_input',
  'requirement-analyst': 'business_logic',
  'domain-analyst': 'business_logic',
  designer: 'interface_parsing',
  'data-integration': 'data_capture',
  'solution-designer': 'production_delivery',
  'code-generator': 'production_delivery',
  'code-reviewer': 'production_delivery',
  'security-reviewer': 'production_delivery',
  tester: 'production_delivery',
  'product-acceptance': 'production_delivery',
  'image-builder': 'production_delivery',
  deployer: 'production_delivery',
}

const KIND_TO_CARD = {
  requirement_analysis: 'business_logic',
  domain_analysis: 'business_logic',
  design_contract: 'interface_parsing',
  data_integration: 'data_capture',
  solution_design: 'production_delivery',
  code_generation: 'production_delivery',
  code_review: 'production_delivery',
  security_review: 'production_delivery',
  test_verification: 'production_delivery',
  product_acceptance: 'production_delivery',
  image_build: 'production_delivery',
  deployment: 'production_delivery',
}

const PRODUCTION_STAGE_LABELS = {
  solution_design: '方案设计',
  code_generation: '代码生成',
  code_review: '代码审查',
  security_review: '安全审查',
  test_verification: '测试验证',
  product_acceptance: '产品验收',
  image_build: '镜像构建',
  deployment: '部署',
}

const BASE_EDGES = [
  ['user_input', 'business_logic'],
  ['business_logic', 'interface_parsing'],
  ['business_logic', 'data_capture'],
  ['interface_parsing', 'production_delivery'],
  ['data_capture', 'production_delivery'],
]

export function aggregateCardLabel(agentOrCardKey) {
  const cardKey = AGENT_TO_CARD[agentOrCardKey] || KIND_TO_CARD[agentOrCardKey] || agentOrCardKey
  return CARD_LABELS[cardKey] || agentOrCardKey || ''
}

export function buildWorkbenchOrchestrationView({ view, workTraceItems = [], jobStepBlocks = [] } = {}) {
  const cards = AGGREGATE_CARD_KEYS.map(key => ({
    key,
    label: CARD_LABELS[key],
    state: 'not_started',
    active: false,
    currentAction: '',
    subStage: '',
    summary: '',
    artifacts: artifactsForCard(view, key),
    steps: [],
  }))
  const cardsByKey = Object.fromEntries(cards.map(card => [card.key, card]))
  const hasUserInput = !!(view && Array.isArray(view.messages) && view.messages.some(msg => msg && msg.role === 'user'))
  if (hasUserInput) {
    cardsByKey.user_input.state = 'confirmed'
    cardsByKey.business_logic.state = 'ready'
  }

  const steps = Array.isArray(jobStepBlocks) ? jobStepBlocks.filter(Boolean) : []
  for (const step of steps) {
    const cardKey = cardKeyForStep(step)
    const card = cardsByKey[cardKey]
    if (!card) continue
    card.steps.push(step)
  }

  for (const key of ['business_logic', 'interface_parsing', 'data_capture']) {
    const card = cardsByKey[key]
    const state = aggregateAnalysisState(card.steps)
    card.state = state
    card.currentAction = latestStepSummary(card.steps, workTraceItems)
    card.summary = latestTerminalSummary(card.steps)
  }
  const production = cardsByKey.production_delivery
  const prod = aggregateProductionState(production.steps)
  production.state = prod.state
  production.subStage = prod.subStage
  production.currentAction = latestStepSummary(production.steps, workTraceItems)
  production.summary = latestTerminalSummary(production.steps)

  applyUpstreamWaiting(cardsByKey)
  const activeCardKey = firstActiveCardKey(cards)
  if (activeCardKey) cardsByKey[activeCardKey].active = true
  const edges = BASE_EDGES.map(([from, to]) => ({ from, to, state: edgeState(cardsByKey[from], cardsByKey[to]) }))

  return {
    cards,
    cardsByKey,
    edges,
    activeCardKey,
    focusQueue: ['business_logic', 'interface_parsing', 'data_capture', 'production_delivery'],
  }
}

function cardKeyForStep(step) {
  return KIND_TO_CARD[step.kind] || AGENT_TO_CARD[step.agentKey || step.agent_key] || ''
}

function aggregateAnalysisState(steps) {
  if (!steps.length) return 'not_started'
  if (steps.some(step => step.status === 'failed')) return 'failed'
  if (steps.some(step => step.status === 'waiting_user')) return 'waiting_user_clarification'
  if (steps.some(step => step.status === 'running')) return 'running'
  if (steps.some(step => step.status === 'pending' || step.status === 'queued')) return 'ready'
  if (steps.every(step => step.status === 'succeeded' || step.status === 'completed')) return 'confirmed'
  return 'ready'
}

function aggregateProductionState(steps) {
  if (!steps.length) return { state: 'not_started', subStage: '' }
  const failed = steps.find(step => step.status === 'failed')
  if (failed) return { state: productionFailureState(failed), subStage: stageName(failed) }
  const waiting = steps.find(step => step.status === 'waiting_user')
  if (waiting) return { state: 'waiting_user_confirmation', subStage: stageName(waiting) }
  const running = steps.find(step => step.status === 'running')
  if (running) return { state: 'running', subStage: stageName(running) }
  const ready = steps.find(step => step.status === 'pending' || step.status === 'queued')
  if (ready) return { state: 'ready', subStage: stageName(ready) }
  const skipped = steps.find(step => step.status === 'skipped')
  if (skipped) return { state: 'skipped', subStage: stageName(skipped) }
  if (steps.every(step => step.status === 'succeeded' || step.status === 'completed')) return { state: 'delivered', subStage: stageName(steps[steps.length - 1]) }
  return { state: 'ready', subStage: '' }
}

function productionFailureState(step) {
  const code = step.errorCode || step.error_code || ''
  const repairable = new Set(['blocking_review', 'schema_validation_failed', 'file_constraint_violated'])
  if (repairable.has(code)) return 'auto_repairing'
  return 'failed'
}

function stageName(step) {
  return step.name || PRODUCTION_STAGE_LABELS[step.kind] || step.agentKey || step.stepId || ''
}

function latestStepSummary(steps, traceItems) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].summary) return String(steps[i].summary)
    if (steps[i].error) return String(steps[i].error)
  }
  const stepIds = new Set(steps.map(step => step.stepId || step.id).filter(Boolean))
  const traces = Array.isArray(traceItems) ? traceItems : []
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const item = traces[i]
    if (!item || !stepIds.has(item.stepId || item.step_id)) continue
    const payload = item.payload || {}
    const text = payload.summary || payload.message || payload.text || payload.description || ''
    if (text) return String(text)
  }
  return ''
}

function latestTerminalSummary(steps) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if ((step.status === 'succeeded' || step.status === 'completed') && step.summary) return String(step.summary)
  }
  return ''
}

function artifactsForCard(view, cardKey) {
  const artifacts = view && Array.isArray(view.workbenchArtifacts) ? view.workbenchArtifacts : []
  return artifacts
    .filter(item => item && item.cardKey === cardKey)
    .map(item => ({
      id: String(item.id || ''),
      kind: String(item.kind || ''),
      label: String(item.label || item.path || ''),
      path: String(item.path || ''),
      previewUrl: String(item.previewUrl || ''),
      status: String(item.status || 'active'),
      jobId: String(item.jobId || item.job_id || ''),
    }))
}

function applyUpstreamWaiting(cardsByKey) {
  if (cardsByKey.user_input.state === 'not_started') {
    cardsByKey.business_logic.state = 'not_started'
    cardsByKey.interface_parsing.state = 'not_started'
    cardsByKey.data_capture.state = 'not_started'
    cardsByKey.production_delivery.state = 'not_started'
    return
  }
  if (cardsByKey.business_logic.state !== 'confirmed') {
    if (cardsByKey.interface_parsing.state === 'not_started') cardsByKey.interface_parsing.state = 'waiting_upstream'
    if (cardsByKey.data_capture.state === 'not_started') cardsByKey.data_capture.state = 'waiting_upstream'
    if (cardsByKey.production_delivery.state === 'not_started') cardsByKey.production_delivery.state = 'waiting_upstream'
    return
  }
  if (cardsByKey.interface_parsing.state !== 'confirmed') {
    if (cardsByKey.data_capture.state === 'not_started' || cardsByKey.data_capture.state === 'ready') cardsByKey.data_capture.state = 'waiting_upstream'
    if (cardsByKey.production_delivery.state === 'not_started' || cardsByKey.production_delivery.state === 'ready') cardsByKey.production_delivery.state = 'waiting_upstream'
    return
  }
  if (cardsByKey.interface_parsing.state !== 'confirmed' || cardsByKey.data_capture.state !== 'confirmed') {
    if (cardsByKey.production_delivery.state === 'not_started' || cardsByKey.production_delivery.state === 'ready') cardsByKey.production_delivery.state = 'waiting_upstream'
  }
}

function firstActiveCardKey(cards) {
  const order = ['user_input', 'business_logic', 'interface_parsing', 'data_capture', 'production_delivery']
  for (const key of order) {
    const card = cards.find(item => item.key === key)
    if (!card) continue
    if (['running', 'waiting_user_clarification', 'waiting_artifact_confirmation', 'waiting_user_confirmation', 'auto_repairing'].includes(card.state)) return key
  }
  const ready = cards.find(card => card.state === 'ready')
  return ready ? ready.key : ''
}

function edgeState(fromCard, toCard) {
  if (!fromCard || !toCard) return 'inactive'
  if (fromCard.state === 'failed' || toCard.state === 'failed') return 'blocked'
  if (fromCard.state === 'confirmed' || fromCard.state === 'delivered') {
    if (['running', 'waiting_user_clarification', 'waiting_user_confirmation', 'auto_repairing'].includes(toCard.state)) return 'flowing'
    if (toCard.state === 'confirmed' || toCard.state === 'delivered') return 'completed'
    if (toCard.state === 'ready') return 'flowing'
  }
  return 'inactive'
}
