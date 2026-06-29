import { Fragment, useMemo, useState } from 'react'
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
  const cardsByKey = graph && graph.cardsByKey ? graph.cardsByKey : {}
  const relatedKeys = useMemo(() => relatedCardKeys(graph, activeKey), [graph, activeKey])
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
          return (
          <div className="ceg-wave-group" key={wave.id}>
            <div className="ceg-wave" data-wave={wave.index}>
              <span className="ceg-wave-label">{wave.label}</span>
              <div className="ceg-wave-cards">
                {wave.cards.map(card => (
                  <GraphCard
                    key={card.id}
                    card={card}
                    dimmed={!!activeKey && !relatedKeys.has(card.agentKey)}
                    active={activeKey === card.agentKey}
                    onEnter={() => setActiveKey(card.agentKey)}
                    onLeave={() => setActiveKey('')}
                    onOpenTask={onOpenTask}
                  />
                ))}
              </div>
            </div>
            {waveIndex < graph.waves.length - 1 ? (
              <WaveConnector
                fromWave={wave}
                toWave={nextWave}
                edges={graph.edges.filter(edge => {
                  const from = cardsByKey[edge.from]
                  const to = cardsByKey[edge.to]
                  return from && to && from.wave === wave.index && to.wave > wave.index
                })}
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

function GraphCard({ card, active, dimmed, onEnter, onLeave, onOpenTask }) {
  const Icon = card.kind === 'origin' ? User : card.kind === 'orchestrator' ? GitBranch : STATE_ICON[card.state] || CircleDot
  const canOpenTask = !!card.stepId
  const waitText = card.waitingFor && card.waitingFor.length > 0
    ? `等待：${card.waitingFor.slice(0, 2).join('、')}${card.waitingFor.length > 2 ? `等 ${card.waitingFor.length} 个上游` : ''}`
    : ''
  return (
    <button
      type="button"
      className={`ceg-card ceg-card-state-${card.state} ceg-${card.kind}${active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}`}
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

function WaveConnector({ fromWave, toWave, edges, activeKey, relatedKeys }) {
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
          />
        )
      }) : <EdgeSegments edge={{ state: 'inactive' }} fromY={50} toY={50} />}
      {list.length > 0 ? list.map((edge, index) => (
        <span
          key={`${edge.id || `${edge.from}->${edge.to}`}-arrow-${index}`}
          className={`ceg-edge-arrow ceg-edge-${edge.state || 'inactive'}`}
          style={{ top: `${cardSlotPercent(toCards, edge.to)}%` }}
        />
      )) : <span className="ceg-edge-arrow ceg-edge-inactive" style={{ top: '50%' }} />}
    </div>
  )
}

function EdgeSegments({ edge, fromY, toY }) {
  const state = edge.state || 'inactive'
  const stateClass = `ceg-edge-${state}`
  const linear = Math.abs(fromY - toY) < 1
  if (linear) {
    return (
      <span
        className={`ceg-edge-seg ceg-edge-horizontal ${stateClass}`}
        style={{ left: '0%', width: '100%', top: `${fromY}%` }}
      />
    )
  }
  const minY = Math.min(fromY, toY)
  const height = Math.abs(toY - fromY)
  return (
    <Fragment>
      <span
        className={`ceg-edge-seg ceg-edge-horizontal ${stateClass}`}
        style={{ left: '0%', width: '48%', top: `${fromY}%` }}
      />
      <span
        className={`ceg-edge-seg ceg-edge-vertical ${stateClass}`}
        style={{ left: '48%', top: `${minY}%`, height: `${height}%` }}
      />
      <span
        className={`ceg-edge-seg ceg-edge-horizontal ${stateClass}`}
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
