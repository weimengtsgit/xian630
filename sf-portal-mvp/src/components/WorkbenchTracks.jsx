// WorkbenchTrack renders one aggregate card's responsibility track. For three of
// the four agent tracks (business_logic / interface_parsing /
// production_delivery) the track is a label list whose active/failed node is
// derived from the card's current action / state — sufficient because those
// tracks are linear pipelines and the finding (F6) does not require real
// per-node signals there.
//
// The data_capture track (F6) is different: it is a DATA-VALIDATION flow whose
// nodes must reflect REAL verification state — which data source was selected,
// which boundaries failed (red), which succeeded, and whether a fallback is
// waiting on user confirmation. That state is NOT a label list: the executor
// projects a verification summary onto the data_capture card's data_contract
// artifact (sourceBoundary + per-boundary verdicts + fallback history + sample/
// field counts), and DataFlowTrack derives each node's CSS state from it.

const STATIC_TRACKS = {
  business_logic: ['目标识别', '对象识别', '规则提取', '澄清判断', '摘要生成'],
  interface_parsing: ['输入解析', '视图识别', '布局分区', '组件映射', '预览生成'],
  production_delivery: ['方案设计', '代码生成', '代码审查', '测试验证', '产品验收', '镜像构建', '部署'],
}

// Data-flow node identifiers map to the labels rendered in the track. Sources
// are keyed by their boundary name (ontology|internet|demo) so the metadata's
// sourceBoundary / verification / fallbackHistory line up directly.
const DATA_SOURCE_NODES = [
  { key: 'ontology', label: '本体' },
  { key: 'internet', label: '互联网' },
  { key: 'demo', label: '演示' },
]
const DATA_PROCESSING_NODES = [
  { key: 'connection', label: '连接验证' },
  { key: 'sample', label: '样本获取' },
  { key: 'field', label: '字段识别' },
  { key: 'contract', label: '契约生成' },
]
const DATA_DOWNSTREAM_NODES = [
  { key: 'data_contract', label: '数据契约' },
  { key: 'compatibility', label: '界面兼容' },
  { key: 'production', label: '生产交付' },
]

export function WorkbenchTrack({ cardKey, activeLabel = '', failedLabel = '', card }) {
  if (cardKey === 'data_capture') {
    return <DataFlowTrack card={card || {}} />
  }
  const steps = STATIC_TRACKS[cardKey] || []
  return (
    <ol className={`cw-track cw-track-${cardKey}`}>
      {steps.map(step => {
        const active = step === activeLabel || activeLabel.includes(step)
        const failed = step === failedLabel || failedLabel.includes(step)
        return (
          <li key={step} className={`${active ? 'is-active' : ''}${failed ? ' is-failed' : ''}`.trim()}>
            <span />
            <em>{step}</em>
          </li>
        )
      })}
    </ol>
  )
}

// DataFlowTrack derives the three data-flow groups (来源 / 处理 / 流向) from the
// card state + the verification metadata projected onto the data_contract
// artifact. Node states are CSS classes only — no animation:
//   - cw-track-node-succeeded : node reached a confirmed/solid end state
//   - cw-track-node-active    : node is running/flowing right now
//   - cw-track-node-failed    : node hit a red breakpoint (boundary failed)
//   - cw-track-node-waiting   : node is paused for degradation confirmation
// Inactive nodes keep the base .cw-track li styling.
function DataFlowTrack({ card }) {
  const contract = (card.artifacts || []).find(item => item.kind === 'data_contract')
  const meta = (contract && contract.metadata) || null
  const cardState = card.state || ''
  const sourceBoundary = (meta && meta.sourceBoundary) || card.status || contract?.status || ''
  const verification = (meta && meta.verification) || {}
  const fallbackHistory = Array.isArray(meta && meta.fallbackHistory) ? meta.fallbackHistory : []
  const sampleCount = (meta && meta.sampleCount) || 0
  const fieldCount = (meta && meta.fieldCount) || 0

  // Card-level phase the processing/downstream groups key off of.
  const cardRunning = cardState === 'running'
  const cardWaiting = cardState === 'waiting_user_clarification'
  const cardFailed = cardState === 'failed'
  const cardConfirmed = cardState === 'confirmed'

  // The boundary whose confirmation is pending when the card is waiting. If the
  // metadata names it (verification.<b>.status === 'pending') prefer that;
  // otherwise fall back to the next boundary after the last failed one.
  const pendingBoundary = cardWaiting
    ? pickPendingBoundary(verification, fallbackHistory, sourceBoundary)
    : ''

  function sourceState(boundary) {
    // A source appearing in fallbackHistory as "<boundary>_failed" is a red
    // breakpoint. The validator records ontology_failed/internet_failed etc.
    if (fallbackHistory.includes(`${boundary}_failed`) || verification[boundary]?.status === 'failed') {
      return 'cw-track-node-failed'
    }
    if (boundary === sourceBoundary) {
      // The selected source is succeeded once the card is confirmed, active
      // while the card is still running, and waiting if this is the boundary
      // the user must confirm.
      if (cardWaiting && pendingBoundary === boundary) return 'cw-track-node-waiting'
      if (cardConfirmed) return 'cw-track-node-succeeded'
      return 'cw-track-node-active'
    }
    return ''
  }

  function processingState(node) {
    // Until the card has started, processing nodes are inactive.
    if (cardState === 'not_started' || cardState === 'waiting_upstream') return ''
    if (cardFailed) return 'cw-track-node-failed'
    if (cardWaiting) return 'cw-track-node-waiting'
    if (cardConfirmed) return 'cw-track-node-succeeded'
    // Card running: the contract-generation node is the load-bearing one; the
    // earlier processing nodes are considered done once fields/samples exist.
    if (node.key === 'contract') return 'cw-track-node-active'
    if (node.key === 'field' && fieldCount > 0) return 'cw-track-node-succeeded'
    if (node.key === 'sample' && sampleCount > 0) return 'cw-track-node-succeeded'
    if (node.key === 'connection' && sourceBoundary) return 'cw-track-node-succeeded'
    return ''
  }

  function downstreamState(node) {
    if (cardState === 'not_started' || cardState === 'waiting_upstream') return ''
    if (node.key === 'data_contract') {
      if (cardFailed) return 'cw-track-node-failed'
      if (cardConfirmed) return 'cw-track-node-succeeded'
      if (cardRunning) return 'cw-track-node-active'
      return 'cw-track-node-waiting'
    }
    // compatibility + production are downstream of the contract; they stay
    // pending until production_delivery actually runs.
    return cardConfirmed ? 'cw-track-node-waiting' : ''
  }

  function nodeAnnotate(node) {
    if (node.key === 'sample' && sampleCount > 0) return ` (${sampleCount})`
    if (node.key === 'field' && fieldCount > 0) return ` (${fieldCount})`
    return ''
  }

  function renderNode(node, stateFn, annotate) {
    const cls = stateFn(node)
    return (
      <li key={node.key} className={cls}>
        <span />
        <em>{node.label}{annotate ? annotate(node) : ''}</em>
      </li>
    )
  }

  return (
    <div className="cw-track cw-track-data_capture cw-data-flow-track">
      <ol className="cw-data-flow-group">
        {DATA_SOURCE_NODES.map(node => renderNode(node, sourceState))}
      </ol>
      <ol className="cw-data-flow-group">
        {DATA_PROCESSING_NODES.map(node => renderNode(node, processingState, nodeAnnotate))}
      </ol>
      <ol className="cw-data-flow-group">
        {DATA_DOWNSTREAM_NODES.map(node => renderNode(node, downstreamState))}
      </ol>
    </div>
  )
}

// pickPendingBoundary resolves which source boundary a waiting card is paused
// on, preferring an explicit verification.status==="pending" and otherwise
// inferring the next boundary after the last failed one in the fallback order.
function pickPendingBoundary(verification, fallbackHistory, sourceBoundary) {
  for (const boundary of ['ontology', 'internet', 'demo']) {
    if (verification[boundary]?.status === 'pending') return boundary
  }
  const order = ['ontology', 'internet', 'demo']
  if (sourceBoundary && sourceBoundary !== 'demo') {
    const idx = order.indexOf(sourceBoundary)
    if (idx >= 0 && idx + 1 < order.length) return order[idx + 1]
  }
  if (fallbackHistory.includes('ontology_failed') && !fallbackHistory.includes('internet_failed')) return 'internet'
  if (fallbackHistory.includes('internet_failed')) return 'demo'
  return 'ontology'
}
