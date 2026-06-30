import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, CircleDot, GitBranch, HelpCircle, Loader2, PlayCircle, SkipForward, User } from 'lucide-react'
import './CollaborationExecutionGraph.css'

const USER_INPUT_KEY = '__user_input__'
const ORCHESTRATOR_KEY = 'collaboration-orchestrator'
const ORCHESTRATION_PHASES = [
  { label: '正在解析确认需求', duration: 1000 },
  { label: '正在规划协作路径', duration: 1000 },
  { label: '正在召唤协作智能体', duration: 1400 },
  { label: '正在交接执行波次', duration: 900 },
]
const ORCHESTRATION_SUMMON_PHASE_INDEX = 2
const ORCHESTRATION_HANDOFF_PHASE_INDEX = 3
const ORCHESTRATION_PHASE_TRANSITION_MS = 260
const REVEAL_INITIAL_DELAY_MS = ORCHESTRATION_PHASES
  .slice(0, ORCHESTRATION_SUMMON_PHASE_INDEX)
  .reduce((total, phase) => total + phase.duration, 0) +
  (ORCHESTRATION_PHASE_TRANSITION_MS * ORCHESTRATION_SUMMON_PHASE_INDEX)
const REVEAL_STEP_DELAY_MS = 520
const REVEAL_CARD_ANIMATION_MS = 900

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

export function CollaborationExecutionGraph({ graph, onOpenTask }) {
  const [activeKey, setActiveKey] = useState('')
  const [revealedKeys, setRevealedKeys] = useState(() => new Set())
  const [revealingKeys, setRevealingKeys] = useState(() => new Set())
  const [revealComplete, setRevealComplete] = useState(false)
  const [orchestrationPhase, setOrchestrationPhase] = useState({ index: 0, exiting: false })
  const revealTimerRefs = useRef([])
  const lastGraphIdentityRef = useRef(null)

  const cardsByKey = graph && graph.cardsByKey ? graph.cardsByKey : {}
  const relatedKeys = useMemo(() => relatedCardKeys(graph, activeKey), [graph, activeKey])

  // 计算图的唯一标识，用于决定何时重置 reveal
  const graphIdentity = useMemo(() => {
    if (!graph) return ''
    const cardKeys = graph.cards?.map(c => c.agentKey).join('|') || ''
    const edgeIds = graph.edges?.map(e => e.id || `${e.from}->${e.to}`).join('|') || ''
    return `${graph.confirmed}|${cardKeys}|${edgeIds}`
  }, [graph])

  // 计算需要 reveal 的卡片顺序（排除用户输入和编排器）
  const revealOrder = useMemo(() => {
    if (!graph || !graph.waves) return []
    const order = []
    for (const wave of graph.waves) {
      if (wave.index <= 1) continue // 跳过波次 0（用户输入）和 1（编排器）
      for (const card of wave.cards) {
        if (card.agentKey !== USER_INPUT_KEY && card.agentKey !== ORCHESTRATOR_KEY) {
          order.push(card.agentKey)
        }
      }
    }
    return order
  }, [graph])
  const revealOrderKey = revealOrder.join('|')

  // 检查是否需要 reduce motion
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  // Reveal plays for both the planned graph and the accepted execution graph.
  const isRevealRunning = !revealComplete && !prefersReducedMotion
  const orchestrationPhaseIndex = orchestrationPhase.index
  const orchestrationLabel = isRevealRunning
    ? ORCHESTRATION_PHASES[orchestrationPhaseIndex]?.label || ORCHESTRATION_PHASES[0].label
    : prefersReducedMotion ? '协作编排已生成' : ''

  const clearRevealTimers = useCallback(() => {
    for (const timer of revealTimerRefs.current) clearTimeout(timer)
    revealTimerRefs.current = []
  }, [])

  const scheduleRevealTimer = useCallback((callback, delay) => {
    const timer = setTimeout(() => {
      revealTimerRefs.current = revealTimerRefs.current.filter(item => item !== timer)
      callback()
    }, delay)
    revealTimerRefs.current.push(timer)
    return timer
  }, [])

  // 初始化和重置 reveal 状态
  useLayoutEffect(() => {
    if (!graph) {
      lastGraphIdentityRef.current = null
      clearRevealTimers()
      setActiveKey('')
      setRevealedKeys(new Set())
      setRevealingKeys(new Set())
      setRevealComplete(false)
      setOrchestrationPhase({ index: 0, exiting: false })
      return
    }

    // 如果图标识没变，不做任何事。The effect is keyed by stable graph identity
    // values, so this guard is defensive and will not clear an active timer for
    // an unrelated parent re-render.
    if (graphIdentity === lastGraphIdentityRef.current) return
    lastGraphIdentityRef.current = graphIdentity

    // 清理之前的定时器
    clearRevealTimers()
    setActiveKey('')

    const initialKeys = new Set([USER_INPUT_KEY, ORCHESTRATOR_KEY])
    setRevealedKeys(initialKeys)
    setRevealingKeys(new Set())
    setRevealComplete(false)
    setOrchestrationPhase({ index: 0, exiting: false })

    // 如果没有需要 reveal 的卡片，直接完成
    if (revealOrder.length === 0) {
      setRevealComplete(true)
      setOrchestrationPhase({ index: ORCHESTRATION_HANDOFF_PHASE_INDEX, exiting: false })
      return
    }

    // 如果 reduce motion，立即显示所有卡片
    if (prefersReducedMotion) {
      const allKeys = new Set([...initialKeys, ...revealOrder])
      setRevealedKeys(allKeys)
      setRevealingKeys(new Set())
      setRevealComplete(true)
      setOrchestrationPhase({ index: ORCHESTRATION_HANDOFF_PHASE_INDEX, exiting: false })
      return
    }

    let phaseDelay = 0
    const schedulePhaseChange = (index, delay) => {
      scheduleRevealTimer(() => {
        setOrchestrationPhase(prev => ({ ...prev, exiting: true }))
      }, delay)
      scheduleRevealTimer(() => {
        setOrchestrationPhase({ index, exiting: false })
      }, delay + ORCHESTRATION_PHASE_TRANSITION_MS)
    }
    for (let index = 1; index < ORCHESTRATION_HANDOFF_PHASE_INDEX; index += 1) {
      phaseDelay += ORCHESTRATION_PHASES[index - 1].duration
      if (index < ORCHESTRATION_HANDOFF_PHASE_INDEX) {
        schedulePhaseChange(index, phaseDelay)
      }
      phaseDelay += ORCHESTRATION_PHASE_TRANSITION_MS
    }

    // 开始逐个 reveal 卡片
    let currentIndex = 0
    const revealNext = () => {
      if (currentIndex >= revealOrder.length) {
        setRevealingKeys(new Set())
        schedulePhaseChange(ORCHESTRATION_HANDOFF_PHASE_INDEX, 0)
        scheduleRevealTimer(() => {
          setRevealComplete(true)
        }, ORCHESTRATION_PHASE_TRANSITION_MS + ORCHESTRATION_PHASES[ORCHESTRATION_HANDOFF_PHASE_INDEX].duration)
        return
      }

      const agentKey = revealOrder[currentIndex]
      setRevealedKeys(prev => {
        const next = new Set(prev)
        next.add(agentKey)
        return next
      })
      setRevealingKeys(prev => {
        const next = new Set(prev)
        next.add(agentKey)
        return next
      })
      scheduleRevealTimer(() => {
        setRevealingKeys(prev => {
          const next = new Set(prev)
          next.delete(agentKey)
          return next
        })
      }, REVEAL_CARD_ANIMATION_MS)

      currentIndex++
      scheduleRevealTimer(revealNext, REVEAL_STEP_DELAY_MS)
    }

    // 初始延迟
    scheduleRevealTimer(revealNext, REVEAL_INITIAL_DELAY_MS)

    // 清理函数
    return clearRevealTimers
  }, [graphIdentity, revealOrderKey, prefersReducedMotion, clearRevealTimers, scheduleRevealTimer])

  // 检查边是否可见
  const isEdgeVisible = useCallback((edge) => {
    if (!isRevealRunning) return true
    return revealedKeys.has(edge.to)
  }, [isRevealRunning, revealedKeys])

  // 获取卡片的 reveal 状态类
  const getCardRevealClass = useCallback((agentKey) => {
    if (!isRevealRunning) return 'ceg-card-is-revealed'
    if (!revealedKeys.has(agentKey)) return 'ceg-card-is-hidden'
    return revealingKeys.has(agentKey) ? 'ceg-card-is-revealed ceg-card-is-revealing' : 'ceg-card-is-revealed'
  }, [isRevealRunning, revealedKeys, revealingKeys])

  if (!graph || !Array.isArray(graph.waves) || graph.waves.length === 0) return null

  return (
    <section className="ceg" aria-label="协作编排执行图">
      <header className="ceg-head">
        <div>
          <h3>协作编排执行图</h3>
          <p>用户输入 → 协作编排 → 执行波次</p>
        </div>
        <div className="ceg-summary">
          <span>{graph.summary.totalAgents} 个智能体</span>
          {graph.confirmed ? <span>{graph.summary.running} 执行中</span> : <span>待确认</span>}
          {graph.summary.waitingUser ? <span>{graph.summary.waitingUser} 等待用户</span> : null}
          {graph.summary.failed ? <span>{graph.summary.failed} 失败</span> : null}
        </div>
      </header>
      <div className="ceg-canvas">
        {graph.waves.map((wave, waveIndex) => {
          const nextWave = graph.waves[waveIndex + 1]
          const visibleCards = isRevealRunning
            ? wave.cards.filter(card => revealedKeys.has(card.agentKey))
            : wave.cards
          if (isRevealRunning && visibleCards.length === 0) return null
          const visibleEdges = graph.edges.filter(edge => {
            const from = cardsByKey[edge.from]
            const to = cardsByKey[edge.to]
            return from && to && from.wave === wave.index && to.wave > wave.index && isEdgeVisible(edge)
          })
          return (
          <div className="ceg-wave-group" key={wave.id}>
            <div className="ceg-wave" data-wave={wave.index}>
              <span className="ceg-wave-label">{wave.label}</span>
              <div className="ceg-wave-cards">
                {visibleCards.map(card => (
                  <GraphCard
                    key={card.id}
                    card={card}
                    dimmed={!!activeKey && !relatedKeys.has(card.agentKey)}
                    active={activeKey === card.agentKey}
                    onEnter={() => setActiveKey(card.agentKey)}
                    onLeave={() => setActiveKey('')}
                    onOpenTask={onOpenTask}
                    revealClass={getCardRevealClass(card.agentKey)}
                    isOrchestrating={isRevealRunning && card.agentKey === ORCHESTRATOR_KEY}
                    orchestrationLabel={card.agentKey === ORCHESTRATOR_KEY ? orchestrationLabel : ''}
                    orchestrationPhaseExiting={card.agentKey === ORCHESTRATOR_KEY ? orchestrationPhase.exiting : false}
                  />
                ))}
              </div>
            </div>
            {waveIndex < graph.waves.length - 1 && (!isRevealRunning || visibleEdges.length > 0) ? (
              <WaveConnector
                fromWave={wave}
                toWave={nextWave}
                edges={visibleEdges}
                activeKey={activeKey}
                relatedKeys={relatedKeys}
                isRevealMode={isRevealRunning}
              />
            ) : null}
          </div>
          )
        })}
      </div>
    </section>
  )
}

function GraphCard({ card, active, dimmed, onEnter, onLeave, onOpenTask, revealClass, isOrchestrating, orchestrationLabel, orchestrationPhaseExiting }) {
  const Icon = card.kind === 'origin' ? User : card.kind === 'orchestrator' ? isOrchestrating ? Loader2 : GitBranch : STATE_ICON[card.state] || CircleDot
  const canOpenTask = !!card.stepId
  const waitText = card.waitingFor && card.waitingFor.length > 0
    ? `等待：${card.waitingFor.slice(0, 2).join('、')}${card.waitingFor.length > 2 ? `等 ${card.waitingFor.length} 个上游` : ''}`
    : ''
  const tooltipText = card.tooltip || card.description || '暂无描述'
  const tooltipId = `ceg-card-tooltip-${card.id}`
  return (
    <button
      type="button"
      className={`ceg-card ceg-card-state-${card.state} ceg-${card.kind}${active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''} ${revealClass || ''}${isOrchestrating ? ' ceg-is-orchestrating' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={() => canOpenTask && onOpenTask && onOpenTask(card)}
      aria-disabled={!canOpenTask && card.kind !== 'origin'}
      data-agent-key={card.agentKey}
      aria-label={`${card.title}，${card.stateLabel}${canOpenTask ? '，打开任务详情' : ''}`}
      aria-describedby={tooltipId}
    >
      <span className="ceg-card-icon">
        <Icon size={18} className={card.state === 'running' || isOrchestrating ? 'ceg-spin' : ''} />
      </span>
      <span className="ceg-card-main">
        <strong>{card.title}</strong>
        <small>{card.subtitle}</small>
      </span>
      {card.highImpact ? <em className="ceg-gate">门禁</em> : null}
      <span className="ceg-card-desc">{card.summary || waitText || card.description || '等待编排流转'}</span>
      {orchestrationLabel ? (
        <span key={orchestrationLabel} className={`ceg-orchestration-phase${orchestrationPhaseExiting ? ' is-exiting' : ''}`}>{orchestrationLabel}</span>
      ) : null}
      <span className="ceg-card-state">{card.stateLabel}</span>
      {waitText ? <span className="ceg-card-wait">{waitText}</span> : null}
      <span id={tooltipId} className="ceg-card-tooltip" role="tooltip">{tooltipText}</span>
    </button>
  )
}

function WaveConnector({ fromWave, toWave, edges, activeKey, relatedKeys, isRevealMode }) {
  const list = Array.isArray(edges) ? edges : []
  const active = activeKey && list.some(edge => relatedKeys.has(edge.from) && relatedKeys.has(edge.to))
  const fromCards = fromWave && Array.isArray(fromWave.cards) ? fromWave.cards : []
  const toCards = toWave && Array.isArray(toWave.cards) ? toWave.cards : []
  const model = buildConnectorModel(list, fromCards, toCards)
  return (
    <div className={`ceg-connector ceg-connector-mode-${model.connectorMode} ceg-connector-state-${model.connectorState}${active ? ' is-active' : ''}`} aria-hidden="true">
      {model.segments.map(segment => (
        <EdgeSegment
          key={segment.id}
          segment={segment}
          isRevealing={isRevealMode}
        />
      ))}
      {model.arrows.map(arrow => (
        <span
          key={arrow.id}
          className={`ceg-edge-arrow ceg-edge-${arrow.state || 'inactive'}${isRevealMode ? ' ceg-edge-is-revealing' : ''}`}
          style={{ top: `${arrow.top}%` }}
        />
      ))}
    </div>
  )
}

function EdgeSegment({ segment, isRevealing }) {
  const stateClass = `ceg-edge-${segment.state || 'inactive'}`
  const revealClass = isRevealing ? 'ceg-edge-is-revealing' : ''
  return (
    <span
      className={`ceg-edge-seg ceg-edge-${segment.kind} ${stateClass} ${revealClass}`}
      style={segment.style}
    >
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
  if (count === 2) return index === 0 ? 25 : 75
  const top = Math.max(14, 50 - Math.min(36, (count - 1) * 16))
  const bottom = 100 - top
  return top + ((bottom - top) * index) / (count - 1)
}

function relatedCardKeys(graph, activeKey) {
  const keys = new Set()
  if (!graph || !activeKey) return keys
  keys.add(activeKey)
  for (const edge of graph.edges || []) {
    if (edge.from === activeKey) {
      keys.add(edge.to)
    }
    if (edge.to === activeKey) {
      keys.add(edge.from)
    }
  }
  if (activeKey === USER_INPUT_KEY) {
    for (const edge of graph.edges || []) keys.add(edge.to)
  }
  return keys
}
