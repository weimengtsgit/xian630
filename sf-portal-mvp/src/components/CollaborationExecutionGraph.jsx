import { useMemo, useState } from 'react'
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
        {graph.waves.map((wave, waveIndex) => (
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
        ))}
      </div>
      {Array.isArray(graph.adjustments) && graph.adjustments.length > 0 ? (
        <div className="ceg-adjustments">
          <AlertTriangle size={13} />
          <ul>
            {graph.adjustments.map((adjustment, index) => (
              <li key={`${adjustment.message || 'adjustment'}-${index}`}>{adjustment.message || '协作计划已调整'}</li>
            ))}
          </ul>
        </div>
      ) : null}
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

function WaveConnector({ edges, activeKey, relatedKeys }) {
  const list = Array.isArray(edges) ? edges : []
  const active = activeKey && list.some(edge => relatedKeys.has(edge.from) && relatedKeys.has(edge.to))
  return (
    <div className={`ceg-connector${active ? ' is-active' : ''}`} aria-hidden="true">
      {list.length > 0 ? list.map((edge, index) => (
        <span
          key={edge.id || `${edge.from}->${edge.to}-${index}`}
          className={`ceg-edge-track ceg-edge-${edge.state || 'inactive'}`}
          style={{ '--ceg-edge-index': index, '--ceg-edge-count': list.length }}
        />
      )) : <span className="ceg-edge-track ceg-edge-inactive" style={{ '--ceg-edge-index': 0, '--ceg-edge-count': 1 }} />}
      <span className="ceg-arrow" />
    </div>
  )
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
