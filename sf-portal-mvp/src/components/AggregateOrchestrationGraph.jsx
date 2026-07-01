import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, CircleDot, HelpCircle, Loader2, PlayCircle, SkipForward, User } from 'lucide-react'
import './CollaborationExecutionGraph.css'
import './AggregateOrchestrationGraph.css'

const STATE_LABELS = {
  not_started: '未开始',
  waiting_upstream: '等待上游',
  ready: '待启动',
  running: '执行中',
  waiting_user_clarification: '等待用户澄清',
  waiting_artifact_confirmation: '产物待确认',
  confirmed: '已确认',
  auto_repairing: '自动修复中',
  waiting_user_confirmation: '等待用户确认',
  failed: '失败',
  delivered: '已交付',
  skipped: '已跳过',
}

const STATE_ICON = {
  pending_confirmation: HelpCircle,
  waiting_upstream: Clock3,
  ready: PlayCircle,
  running: Loader2,
  waiting_user: HelpCircle,
  completed: CheckCircle2,
  failed: AlertTriangle,
  skipped: SkipForward,
}

// What each pinned card DOES (hover tooltip = function description, not the
// live action — the action is shown inside the card via the 正在… phase).
const CARD_DESCRIPTIONS = {
  user_input: '用户的需求输入与澄清回答',
  business_logic: '识别业务目标、对象与规则，澄清并确认需求摘要（需求分析）',
  interface_parsing: '设计界面视图、布局与组件，产出界面预览与设计契约',
  data_capture: '验证数据来源与字段映射，按 本体→互联网→演示 顺序确认数据契约',
  production_delivery: '方案设计 → 代码生成 → 审查 → 测试 → 镜像构建 → 部署',
}

// While production_delivery runs, the tooltip shows the CURRENT sub-agent's
// function description (the sub-agent name is carried on card.subStage).
const SUBAGENT_DESCRIPTIONS = {
  方案设计: '汇总需求/领域/设计/数据，产出方案设计',
  代码生成: '按方案生成应用源码与构建配置',
  代码审查: '审查代码正确性、可部署性与数据诚实',
  安全审查: '审查安全、权限与暴露部署面风险',
  测试验证: '运行构建与测试并验证结果',
  产品验收: '对照需求与主流程做产品验收',
  镜像构建: '构建应用容器镜像',
  部署: '启动容器并完成健康验证',
}

// Used to derive a 正在… phase label for a running production sub-agent when
// the step has no explicit currentAction (e.g. 正在生成 / 正在审查).
const SUBAGENT_VERB = {
  方案设计: '设计',
  代码生成: '生成',
  代码审查: '审查',
  安全审查: '审查',
  测试验证: '验证',
  产品验收: '验收',
  镜像构建: '构建',
  部署: '部署',
}

const TOPOLOGY_WAVES = [
  { id: 'input', index: 1, label: '用户输入', cards: ['user_input'] },
  { id: 'logic', index: 2, label: '业务逻辑', cards: ['business_logic'] },
  { id: 'parallel', index: 3, label: '并行解析', cards: ['interface_parsing', 'data_capture'] },
  { id: 'delivery', index: 4, label: '生产交付', cards: ['production_delivery'] },
]

export function AggregateOrchestrationGraph({ graph, compact = false, onToggleCompact, onOpenTaskStep, userInputFlashSeq = 0 }) {
  const [activeKey, setActiveKey] = useState('')
  if (!graph || !Array.isArray(graph.cards)) return null
  const active = graph.cardsByKey && graph.activeCardKey ? graph.cardsByKey[graph.activeCardKey] : null
  const cardsByKey = graph.cardsByKey || Object.fromEntries(graph.cards.map(card => [card.key, card]))
  const waves = TOPOLOGY_WAVES.map(wave => ({
    ...wave,
    cards: wave.cards.map(key => cardView(cardsByKey[key])).filter(Boolean),
  })).filter(wave => wave.cards.length > 0)
  const cardsByAgentKey = Object.fromEntries(waves.flatMap(wave => wave.cards.map(card => [card.agentKey, card])))
  const relatedKeys = relatedCardKeys(graph.edges || [], activeKey)
  const summary = summarizeGraph(graph.cards)

  if (compact) {
    return (
      <button type="button" className="aog-compact" onClick={onToggleCompact} aria-label="展开协作执行图">
        <span>{active ? `${active.label} · ${STATE_LABELS[active.state] || active.state}` : '协作执行图'}</span>
        {active && active.subStage ? <em>{active.subStage}</em> : null}
      </button>
    )
  }

  return (
    <section className="ceg aog" aria-label="编排执行总览">
      <header className="ceg-head aog-head">
        <div>
          <h3>编排执行总览</h3>
        </div>
        <div className="ceg-summary aog-summary">
          <span>{graph.cards.length} 个阶段</span>
          {active ? <span>{active.label} · {STATE_LABELS[active.state] || active.state}</span> : <span>等待用户输入</span>}
          {summary.running ? <span>{summary.running} 执行中</span> : null}
          {summary.waiting ? <span>{summary.waiting} 等待用户</span> : null}
          {summary.failed ? <span>{summary.failed} 失败</span> : null}
        </div>
      </header>
      <div className="ceg-canvas aog-canvas">
        {waves.map((wave, waveIndex) => {
          const nextWave = waves[waveIndex + 1]
          const visibleEdges = (graph.edges || []).filter(edge => {
            const from = cardsByAgentKey[edge.from]
            const to = cardsByAgentKey[edge.to]
            return from && to && from.wave === wave.index && to.wave > wave.index
          })
          return (
            <div className="ceg-wave-group" key={wave.id}>
              <div className="ceg-wave" data-wave={wave.index}>
                <div className="ceg-wave-cards">
                  {wave.cards.map((card, cardIndex) => (
                    <GraphCard
                      key={card.id}
                      card={card}
                      flashSeq={card.agentKey === 'user_input' ? userInputFlashSeq : 0}
                      tooltipBelow={cardIndex === 0}
                      active={activeKey === card.agentKey || card.active}
                      dimmed={!!activeKey && !relatedKeys.has(card.agentKey)}
                      onEnter={() => setActiveKey(card.agentKey)}
                      onLeave={() => setActiveKey('')}
                      onOpenTask={onOpenTaskStep}
                    />
                  ))}
                </div>
              </div>
              {nextWave ? (
                <WaveConnector
                  fromWave={wave}
                  toWave={nextWave}
                  edges={visibleEdges}
                  activeKey={activeKey}
                  relatedKeys={relatedKeys}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function cardView(card) {
  if (!card) return null
  const state = toCegState(card.state)
  const step = cardDetailStep(card)
  const isRunning = state === 'running'
  const isProductionRunning = card.key === 'production_delivery' && isRunning
  // Production surfaces the current sub-agent name in the body while it runs;
  // every other card falls back to the existing state text.
  const bodyText = isProductionRunning && card.subStage
    ? card.subStage
    : getCardDescription(card)
  return {
    id: card.key,
    agentKey: card.key,
    title: card.label,
    state,
    stateLabel: STATE_LABELS[card.state] || card.state,
    summary: bodyText,
    description: card.currentAction || card.summary || card.subStage || '',
    tooltip: getCardTooltip(card),
    // 正在… phase hint, shown only while the card is running.
    phase: isRunning ? runningPhase(card) : '',
    wave: TOPOLOGY_WAVES.find(wave => wave.cards.includes(card.key))?.index || 0,
    active: !!card.active,
    step,
    stepId: step ? step.stepId || step.step_id || step.id || '' : '',
  }
}

// The live-action label for a running card (the execution-graph "正在解析确认需求" feel).
// Production uses the sub-agent action (正在生成代码); other cards use the
// pre-task currentAction (需求澄清中 / 分析需求中); if neither is present a
// generic "正在执行" is shown.
function runningPhase(card) {
  if (card.key === 'production_delivery') {
    if (card.currentAction) return card.currentAction
    const verb = SUBAGENT_VERB[card.subStage]
    return verb ? `正在${verb}` : '正在执行'
  }
  if (card.currentAction) return card.currentAction
  return '正在执行'
}

function GraphCard({ card, active, dimmed, onEnter, onLeave, onOpenTask, flashSeq = 0, tooltipBelow = false }) {
  const Icon = card.agentKey === 'user_input' ? User : STATE_ICON[card.state] || CircleDot
  const canOpenTask = !!card.stepId && !!onOpenTask
  const tooltipText = card.tooltip || card.description || '暂无描述'
  const tooltipId = `aog-card-tooltip-${card.id}`
  const openTask = () => {
    if (!canOpenTask) return
    onOpenTask({
      key: card.agentKey,
      label: card.title,
      step: card.step,
      stepId: card.stepId,
    })
  }
  const onKeyDown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openTask()
  }
  return (
    <div
      role="button"
      tabIndex={canOpenTask ? 0 : -1}
      className={`ceg-card ceg-card-state-${card.state}${active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}${active && card.state === 'running' ? ' ceg-is-orchestrating' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={openTask}
      onKeyDown={onKeyDown}
      aria-disabled={!canOpenTask}
      aria-label={`${card.title}，${card.stateLabel}${canOpenTask ? '，打开任务详情' : ''}`}
      aria-describedby={tooltipId}
      data-agent-key={card.agentKey}
    >
      {flashSeq > 0 ? <span key={flashSeq} className="ceg-card-flash" aria-hidden="true" /> : null}
      <span className="ceg-card-icon">
        <Icon size={18} className={card.state === 'running' ? 'ceg-spin' : ''} />
      </span>
      <span className="ceg-card-main">
        <strong>{card.title}</strong>
      </span>
      <span className="ceg-card-desc">{card.summary || card.description || '等待编排流转'}</span>
      {card.phase ? (
        <span key={card.phase} className="ceg-orchestration-phase">{card.phase}</span>
      ) : null}
      <span className="ceg-card-state">{card.stateLabel}</span>
      <span id={tooltipId} className={`ceg-card-tooltip${tooltipBelow ? ' ceg-card-tooltip-below' : ''}`} role="tooltip">{tooltipText}</span>
    </div>
  )
}

function WaveConnector({ fromWave, toWave, edges, activeKey, relatedKeys }) {
  const list = Array.isArray(edges) ? edges : []
  const active = activeKey && list.some(edge => relatedKeys.has(edge.from) && relatedKeys.has(edge.to))
  const fromCards = fromWave && Array.isArray(fromWave.cards) ? fromWave.cards : []
  const toCards = toWave && Array.isArray(toWave.cards) ? toWave.cards : []
  const model = buildConnectorModel(list, fromCards, toCards)
  return (
    <div className={`ceg-connector ceg-connector-mode-${model.connectorMode} ceg-connector-state-${model.connectorState}${active ? ' is-active' : ''}`} aria-hidden="true">
      {model.segments.map(segment => (
        <EdgeSegment key={segment.id} segment={segment} />
      ))}
      {model.arrows.map(arrow => (
        <span
          key={arrow.id}
          className={`ceg-edge-arrow ceg-edge-${arrow.state || 'inactive'}`}
          style={{ top: `${arrow.top}%` }}
        />
      ))}
    </div>
  )
}

function EdgeSegment({ segment }) {
  const stateClass = `ceg-edge-${segment.state || 'inactive'}`
  return (
    <span className={`ceg-edge-seg ceg-edge-${segment.kind} ${stateClass}`} style={segment.style}>
      <span className="ceg-edge-flow-layer" />
    </span>
  )
}

function buildConnectorModel(edges, fromCards, toCards) {
  const mapped = (Array.isArray(edges) ? edges : []).map((edge, index) => ({
    id: edge.id || `${edge.from}->${edge.to}-${index}`,
    from: edge.from,
    to: edge.to,
    state: edge.state || 'inactive',
    fromY: cardSlotPercent(fromCards, edge.from),
    toY: cardSlotPercent(toCards, edge.to),
  }))
  if (mapped.length === 0) {
    return {
      connectorMode: 'linear',
      connectorState: 'inactive',
      segments: [horizontalSegment('fallback-line', 'inactive', 0, 100, 50)],
      arrows: [{ id: 'fallback-arrow', state: 'inactive', top: 50 }],
    }
  }

  const fromSlots = uniqueSlots(mapped.map(edge => edge.fromY))
  const toSlots = uniqueSlots(mapped.map(edge => edge.toY))
  const connectorMode = classifyConnectorMode(fromSlots.length, toSlots.length)
  const connectorState = connectorStateForEdges(mapped)
  const segments = []
  const arrows = mapped.map(edge => ({ id: `${edge.id}-arrow`, state: edge.state, top: edge.toY }))
  const centerX = 48

  if (connectorMode === 'linear' && Math.abs(mapped[0].fromY - mapped[0].toY) < 1) {
    segments.push(horizontalSegment(`${mapped[0].id}-line`, mapped[0].state, 0, 100, mapped[0].fromY))
    return { connectorMode, connectorState, segments, arrows }
  }

  if (connectorMode === 'fork') {
    const fromY = fromSlots[0]
    const minY = Math.min(fromY, ...toSlots)
    const maxY = Math.max(fromY, ...toSlots)
    segments.push(horizontalSegment('fork-trunk', connectorState, 0, centerX, fromY))
    segments.push(verticalSegment('fork-spine', connectorState, centerX, minY, maxY))
    for (const edge of mapped) {
      segments.push(horizontalSegment(`${edge.id}-branch`, edge.state, centerX, 100, edge.toY))
    }
    return { connectorMode, connectorState, segments, arrows }
  }

  if (connectorMode === 'merge') {
    const toY = toSlots[0]
    const minY = Math.min(toY, ...fromSlots)
    const maxY = Math.max(toY, ...fromSlots)
    for (const edge of mapped) {
      segments.push(horizontalSegment(`${edge.id}-branch`, edge.state, 0, centerX, edge.fromY))
    }
    segments.push(verticalSegment('merge-spine', connectorState, centerX, minY, maxY))
    segments.push(horizontalSegment('merge-trunk', connectorState, centerX, 100, toY))
    return { connectorMode, connectorState, segments, arrows }
  }

  for (const edge of mapped) {
    if (Math.abs(edge.fromY - edge.toY) < 1) {
      segments.push(horizontalSegment(`${edge.id}-line`, edge.state, 0, 100, edge.fromY))
    } else {
      segments.push(horizontalSegment(`${edge.id}-from`, edge.state, 0, centerX, edge.fromY))
      segments.push(verticalSegment(`${edge.id}-spine`, edge.state, centerX, edge.fromY, edge.toY))
      segments.push(horizontalSegment(`${edge.id}-to`, edge.state, centerX, 100, edge.toY))
    }
  }
  return { connectorMode, connectorState, segments, arrows }
}

function classifyConnectorMode(fromCount, toCount) {
  if (fromCount <= 1 && toCount <= 1) return 'linear'
  if (fromCount <= 1 && toCount > 1) return 'fork'
  if (fromCount > 1 && toCount <= 1) return 'merge'
  return 'mesh'
}

function connectorStateForEdges(edges) {
  const states = edges.map(edge => edge.state || 'inactive')
  if (states.includes('blocked_failed')) return 'blocked_failed'
  if (states.includes('blocked_manual_confirmation')) return 'blocked_manual_confirmation'
  if (states.includes('blocked_waiting_user')) return 'blocked_waiting_user'
  if (states.includes('blocked')) return 'blocked'
  if (states.includes('flowing')) return 'flowing'
  if (states.length > 0 && states.every(state => state === 'planned')) return 'planned'
  if (states.length > 0 && states.every(state => state === 'completed')) return 'completed'
  return 'inactive'
}

function uniqueSlots(values) {
  return [...new Set(values.map(value => Math.round(value * 100) / 100))]
}

function horizontalSegment(id, state, left, right, top) {
  return {
    id,
    state,
    kind: 'horizontal',
    style: { left: `${left}%`, width: `${Math.max(0, right - left)}%`, top: `${top}%` },
  }
}

function verticalSegment(id, state, left, fromTop, toTop) {
  const top = Math.min(fromTop, toTop)
  const height = Math.abs(toTop - fromTop)
  return {
    id,
    state,
    kind: 'vertical',
    style: { left: `${left}%`, top: `${top}%`, height: `${height}%` },
  }
}

function cardSlotPercent(cards, agentKey) {
  const count = cards.length
  if (count <= 1) return 50
  const index = cards.findIndex(card => card.agentKey === agentKey)
  if (index < 0) return 50
  return ((index + 0.5) / count) * 100
}

function relatedCardKeys(edges, activeKey) {
  if (!activeKey) return new Set()
  const related = new Set([activeKey])
  for (const edge of edges || []) {
    if (edge.from === activeKey) related.add(edge.to)
    if (edge.to === activeKey) related.add(edge.from)
  }
  return related
}

function summarizeGraph(cards) {
  return cards.reduce((summary, card) => {
    if (card.state === 'running' || card.state === 'auto_repairing') summary.running += 1
    if (card.state === 'waiting_user_clarification' || card.state === 'waiting_artifact_confirmation' || card.state === 'waiting_user_confirmation') summary.waiting += 1
    if (card.state === 'failed') summary.failed += 1
    return summary
  }, { running: 0, waiting: 0, failed: 0 })
}

function getCardDescription(card) {
  if (card.key === 'user_input' && card.state === 'confirmed') return '需求已提交，已进入编排'
  if (card.state === 'running' || card.state === 'auto_repairing') return '正在执行'
  if (card.state === 'failed') return '执行失败，查看详情'
  if (card.state === 'confirmed' || card.state === 'delivered') return '步骤已完成'
  if (card.state === 'waiting_upstream') return '等待上游阶段完成'
  if (card.state === 'not_started') return '尚未开始'
  if (card.state === 'waiting_user_clarification') return '等待用户澄清'
  if (card.state === 'waiting_artifact_confirmation') return '等待产物确认'
  if (card.state === 'waiting_user_confirmation') return '等待用户确认'
  if (card.state === 'ready') return '待启动'
  return '等待编排流转'
}

function getCardTooltip(card) {
  if (card.state === 'failed') {
    const text = card.currentAction || card.summary || card.subStage || ''
    return shortFailureDescription(text, card.label)
  }
  // Running production surfaces the CURRENT sub-agent's function description.
  if (card.key === 'production_delivery' && card.state === 'running' && card.subStage) {
    return SUBAGENT_DESCRIPTIONS[card.subStage] || CARD_DESCRIPTIONS[card.key]
  }
  // Otherwise the tooltip describes what the card DOES, not the live action.
  return CARD_DESCRIPTIONS[card.key] || `${card.label}：${STATE_LABELS[card.state] || card.state}`
}

function shortFailureDescription(text, label) {
  if (/^Read\s+generated-apps\//i.test(text) || /SummaryMetrics\.tsx/.test(text)) return '读取生成文件失败'
  if (/^Read\s+/i.test(text)) return '读取文件失败'
  if (!text) return `${label || '当前阶段'}失败，等待处理`
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 34 ? `${normalized.slice(0, 34)}...` : normalized
}

function cardDetailStep(card) {
  const steps = Array.isArray(card.steps) ? card.steps : []
  return steps.find(step => step && step.status === 'failed') ||
    steps.find(step => step && (step.status === 'waiting_user' || step.status === 'running')) ||
    steps[steps.length - 1] ||
    null
}

function toCegState(state) {
  if (state === 'running' || state === 'auto_repairing') return 'running'
  if (state === 'confirmed' || state === 'delivered') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'skipped') return 'skipped'
  if (state === 'waiting_user_clarification' || state === 'waiting_artifact_confirmation' || state === 'waiting_user_confirmation') return 'waiting_user'
  if (state === 'waiting_upstream') return 'waiting_upstream'
  if (state === 'ready') return 'ready'
  return 'pending_confirmation'
}
