import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, CircleDot, GitBranch, HelpCircle, Loader2, PlayCircle, SkipForward, User } from 'lucide-react'
import './CollaborationExecutionGraph.css'

const USER_INPUT_KEY = '__user_input__'

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
  const [revealComplete, setRevealComplete] = useState(false)
  const revealTimerRef = useRef(null)
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
        if (card.agentKey !== USER_INPUT_KEY && card.agentKey !== 'collaboration-orchestrator') {
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

  // 检查是否是 reveal 模式
  const isRevealMode = !graph?.confirmed

  // 初始化和重置 reveal 状态
  useEffect(() => {
    if (!graph) {
      lastGraphIdentityRef.current = null
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current)
        revealTimerRef.current = null
      }
      setRevealedKeys(new Set())
      setRevealComplete(false)
      return
    }

    // 如果图标识没变，不做任何事。The effect is keyed by stable graph identity
    // values, so this guard is defensive and will not clear an active timer for
    // an unrelated parent re-render.
    if (graphIdentity === lastGraphIdentityRef.current) return
    lastGraphIdentityRef.current = graphIdentity

    // 清理之前的定时器
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
    }

    // 如果是确认后的图，立即显示所有卡片
    if (graph.confirmed) {
      const allKeys = new Set(graph.cards?.map(c => c.agentKey) || [])
      setRevealedKeys(allKeys)
      setRevealComplete(true)
      return
    }

    // 未确认的图：初始化 reveal 状态
    const initialKeys = new Set([USER_INPUT_KEY, 'collaboration-orchestrator'])
    setRevealedKeys(initialKeys)
    setRevealComplete(false)

    // 如果没有需要 reveal 的卡片，直接完成
    if (revealOrder.length === 0) {
      setRevealComplete(true)
      return
    }

    // 如果 reduce motion，立即显示所有卡片
    if (prefersReducedMotion) {
      const allKeys = new Set([...initialKeys, ...revealOrder])
      setRevealedKeys(allKeys)
      setRevealComplete(true)
      return
    }

    // 开始逐个 reveal 卡片
    let currentIndex = 0
    const revealNext = () => {
      if (currentIndex >= revealOrder.length) {
        setRevealComplete(true)
        return
      }

      setRevealedKeys(prev => {
        const next = new Set(prev)
        next.add(revealOrder[currentIndex])
        return next
      })

      currentIndex++
      revealTimerRef.current = setTimeout(revealNext, 200)
    }

    // 初始延迟
    revealTimerRef.current = setTimeout(revealNext, 250)

    // 清理函数
    return () => {
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current)
      }
    }
  }, [graphIdentity, revealOrderKey, prefersReducedMotion])

  // 检查边是否可见
  const isEdgeVisible = useCallback((edge) => {
    if (!isRevealMode) return true
    return revealedKeys.has(edge.to)
  }, [isRevealMode, revealedKeys])

  // 获取卡片的 reveal 状态类
  const getCardRevealClass = useCallback((agentKey) => {
    if (!isRevealMode) return 'ceg-card-is-revealed'
    if (!revealedKeys.has(agentKey)) return 'ceg-card-is-hidden'
    return 'ceg-card-is-revealed'
  }, [isRevealMode, revealedKeys])

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
          const visibleCards = isRevealMode
            ? wave.cards.filter(card => revealedKeys.has(card.agentKey))
            : wave.cards
          if (isRevealMode && visibleCards.length === 0) return null
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
                    isOrchestrating={isRevealMode && !revealComplete && card.agentKey === 'collaboration-orchestrator'}
                  />
                ))}
              </div>
            </div>
            {waveIndex < graph.waves.length - 1 && (!isRevealMode || visibleEdges.length > 0) ? (
              <WaveConnector
                fromWave={wave}
                toWave={nextWave}
                edges={visibleEdges}
                activeKey={activeKey}
                relatedKeys={relatedKeys}
                isRevealMode={isRevealMode}
              />
            ) : null}
          </div>
          )
        })}
      </div>
    </section>
  )
}

function GraphCard({ card, active, dimmed, onEnter, onLeave, onOpenTask, revealClass, isOrchestrating }) {
  const Icon = card.kind === 'origin' ? User : card.kind === 'orchestrator' ? GitBranch : STATE_ICON[card.state] || CircleDot
  const canOpenTask = !!card.stepId
  const waitText = card.waitingFor && card.waitingFor.length > 0
    ? `等待：${card.waitingFor.slice(0, 2).join('、')}${card.waitingFor.length > 2 ? `等 ${card.waitingFor.length} 个上游` : ''}`
    : ''
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
      title={canOpenTask ? '打开任务执行详情' : card.kind === 'origin' ? '用户输入起点' : '确认后可打开任务详情'}
    >
      <span className="ceg-card-icon">
        <Icon size={18} className={card.state === 'running' ? 'ceg-spin' : ''} />
      </span>
      <span className="ceg-card-main">
        <strong>{card.title}</strong>
        <small>{card.subtitle}</small>
      </span>
      {card.highImpact ? <em className="ceg-gate">门禁</em> : null}
      <span className="ceg-card-desc">{card.summary || waitText || card.description || '等待编排流转'}</span>
      <span className="ceg-card-state">{card.stateLabel}</span>
      {waitText ? <span className="ceg-card-wait">{waitText}</span> : null}
    </button>
  )
}

function WaveConnector({ fromWave, toWave, edges, activeKey, relatedKeys, isRevealMode }) {
  const list = Array.isArray(edges) ? edges : []
  const active = activeKey && list.some(edge => relatedKeys.has(edge.from) && relatedKeys.has(edge.to))
  const fromCards = fromWave && Array.isArray(fromWave.cards) ? fromWave.cards : []
  const toCards = toWave && Array.isArray(toWave.cards) ? toWave.cards : []
  return (
    <div className={`ceg-connector${active ? ' is-active' : ''}`} aria-hidden="true">
      {list.length > 0 ? list.map((edge, index) => {
        const fromY = cardSlotPercent(fromCards, edge.from)
        const toY = cardSlotPercent(toCards, edge.to)
        return (
          <EdgeSegments
            key={edge.id || `${edge.from}->${edge.to}-${index}`}
            edge={edge}
            fromY={fromY}
            toY={toY}
            isRevealing={isRevealMode}
          />
        )
      }) : <EdgeSegments edge={{ state: 'inactive' }} fromY={50} toY={50} />}
      {list.length > 0 ? list.map((edge, index) => (
        <span
          key={`${edge.id || `${edge.from}->${edge.to}`}-arrow-${index}`}
          className={`ceg-edge-arrow ceg-edge-${edge.state || 'inactive'}${isRevealMode ? ' ceg-edge-is-revealing' : ''}`}
          style={{ top: `${cardSlotPercent(toCards, edge.to)}%` }}
        />
      )) : <span className="ceg-edge-arrow ceg-edge-inactive" style={{ top: '50%' }} />}
    </div>
  )
}

function EdgeSegments({ edge, fromY, toY, isRevealing }) {
  const state = edge.state || 'inactive'
  const stateClass = `ceg-edge-${state}`
  const revealClass = isRevealing ? 'ceg-edge-is-revealing' : ''
  const linear = Math.abs(fromY - toY) < 1
  if (linear) {
    return (
      <span
        className={`ceg-edge-seg ceg-edge-horizontal ${stateClass} ${revealClass}`}
        style={{ left: '0%', width: '100%', top: `${fromY}%` }}
      />
    )
  }
  const minY = Math.min(fromY, toY)
  const height = Math.abs(toY - fromY)
  return (
    <Fragment>
      <span
        className={`ceg-edge-seg ceg-edge-horizontal ${stateClass} ${revealClass}`}
        style={{ left: '0%', width: '48%', top: `${fromY}%` }}
      />
      <span
        className={`ceg-edge-seg ceg-edge-vertical ${stateClass} ${revealClass}`}
        style={{ left: '48%', top: `${minY}%`, height: `${height}%` }}
      />
      <span
        className={`ceg-edge-seg ceg-edge-horizontal ${stateClass} ${revealClass}`}
        style={{ left: '48%', width: '52%', top: `${toY}%` }}
      />
    </Fragment>
  )
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
