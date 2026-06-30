import { CheckCircle2, Circle, Clock3, FileCheck2, Loader2, PackageCheck, User } from 'lucide-react'
import './AggregateOrchestrationGraph.css'

// The aggregate graph renders exactly five pipeline cards, one per role. The
// card text comes from the view model (card.label), but they are, in order:
// 用户输入 / 业务逻辑 / 界面解析 / 数据抓取 / 生产交付.
const ICONS = {
  user_input: User,
  business_logic: FileCheck2,
  interface_parsing: Circle,
  data_capture: Clock3,
  production_delivery: PackageCheck,
}

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

export function AggregateOrchestrationGraph({ graph, compact = false, onToggleCompact }) {
  if (!graph || !Array.isArray(graph.cards)) return null
  const active = graph.cardsByKey && graph.activeCardKey ? graph.cardsByKey[graph.activeCardKey] : null
  if (compact) {
    return (
      <button type="button" className="aog-compact" onClick={onToggleCompact} aria-label="展开协作执行图">
        <span>{active ? `${active.label} · ${STATE_LABELS[active.state] || active.state}` : '协作执行图'}</span>
        {active && active.subStage ? <em>{active.subStage}</em> : null}
      </button>
    )
  }
  return (
    <section className="aog" aria-label="编排执行总览">
      <header className="aog-head">
        <h3>编排执行总览</h3>
        <p>{active ? `${active.label} · ${STATE_LABELS[active.state] || active.state}` : '等待用户输入'}</p>
      </header>
      <div className="aog-canvas">
        {graph.cards.map(card => {
          const Icon = ICONS[card.key] || Circle
          const running = card.state === 'running' || card.state === 'auto_repairing'
          const complete = card.state === 'confirmed' || card.state === 'delivered'
          return (
            <article
              key={card.key}
              className={`aog-card aog-card-${card.key} aog-state-${card.state}${card.active || running ? ' is-active' : ''}`}
              aria-current={card.active ? 'step' : undefined}
            >
              <span className="aog-icon">{running ? <Loader2 size={16} className="aog-spin" /> : complete ? <CheckCircle2 size={16} /> : <Icon size={16} />}</span>
              <strong>{card.label}</strong>
              <small>{STATE_LABELS[card.state] || card.state}</small>
              {card.subStage ? <em>{card.subStage}</em> : null}
              {card.currentAction ? <p>{card.currentAction}</p> : null}
            </article>
          )
        })}
        {graph.edges.map(edge => (
          <span key={`${edge.from}-${edge.to}`} className={`aog-edge aog-edge-${edge.from}-${edge.to} aog-edge-${edge.state}`} aria-hidden="true" />
        ))}
      </div>
    </section>
  )
}
