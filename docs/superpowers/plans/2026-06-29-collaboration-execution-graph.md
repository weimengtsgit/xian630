# Collaboration Execution Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the conversation-area collaboration plan preview into a real-state-driven collaboration orchestration execution graph with execution waves, an orchestration hub card, animated dependency flow, and task-card navigation.

**Architecture:** Keep the backend contract unchanged. Build a pure frontend graph view model from `collaborationPlanPreview` plus existing `jobStepBlocks`, then render it with a dedicated React component inside the dialogue timeline. The graph is observable and navigational only: it reflects accepted orchestration and real task state, but it never controls scheduler execution.

**Tech Stack:** React/Vite frontend in `sf-portal-mvp/`, pure JavaScript logic helpers, existing Node assertion harness under `sf-portal-mvp/scripts/`, CSS animations modeled after `sf-portal/src/components/AgentsPanel.css` from commit `69fcf80`.

---

## Scope

Implement only the conversation-area graph. Do not refactor the task execution drawer, backend scheduler, `job_steps` schema, or collaboration plan persistence.

Confirmed product decisions:

- Layout: horizontal execution waves, not a free-floating graph canvas.
- Origin: include a fixed user-input origin card.
- Hub: render `collaboration-orchestrator` as a visually prominent orchestration hub between user input and later waves.
- State: graph card states are user-facing derived states, not raw `step.status`.
- Edges: animated lines show dependency readiness/flow, not fabricated progress.
- Interaction: graph is observable and navigational; it does not start, skip, reorder, or retry agents.

## File Structure

- Create `sf-portal-mvp/src/hooks/collaborationExecutionGraphState.js`
  - Pure graph view model builder.
  - Computes waves, card states, upstream labels, edge states, graph summary.
  - Framework-free so `node scripts/check-collaboration-plan.mjs` can import it.

- Create `sf-portal-mvp/src/components/CollaborationExecutionGraph.jsx`
  - React renderer for graph waves, cards, dependency connectors, hover highlighting, and card click navigation.
  - Receives `graph`, `onOpenTask`, and `submitting`.

- Create `sf-portal-mvp/src/components/CollaborationExecutionGraph.css`
  - Visual design and animations.
  - Reuses the `69fcf80` visual language: flow lines via `repeating-linear-gradient`, running card pulse, split/merge feel, dark restrained UI.

- Modify `sf-portal-mvp/src/hooks/dialogueTimeline.js`
  - Import `buildCollaborationExecutionGraphView`.
  - Build `item.graph` for `collaboration_plan_preview`.

- Modify `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
  - Import `CollaborationExecutionGraph`.
  - Replace inline `CollaborationPlanPreviewCard` with the new component.
  - Thread `onToggleDrawerEntry` down to `TimelineItem` and graph card click handlers.

- Modify `sf-portal-mvp/scripts/check-collaboration-plan.mjs`
  - Add assertions for execution-wave layout, orchestration hub, card status mapping, edge status mapping, and component extraction.

- Modify `CONTEXT.md`
  - Keep the glossary updates already made in the design session:
    - `协作编排执行图`
    - `编排卡片状态`
    - `编排依赖线状态`
    - `协作编排智能体` as hub card

## Task 1: Pure Graph View Model

**Files:**
- Create: `sf-portal-mvp/src/hooks/collaborationExecutionGraphState.js`
- Modify: `sf-portal-mvp/scripts/check-collaboration-plan.mjs`

- [ ] **Step 1: Write failing graph state tests**

Modify `sf-portal-mvp/scripts/check-collaboration-plan.mjs` imports:

```js
import { buildCollaborationExecutionGraphView } from '../src/hooks/collaborationExecutionGraphState.js'
```

Append this test block after the existing `previewItem` assertions:

```js
const graphPreview = {
  lanes: [
    { id: 'analysis', label: '分析' },
    { id: 'generation', label: '生成' },
    { id: 'delivery', label: '交付' },
  ],
  agents: [
    { key: 'collaboration-orchestrator', name: '协作编排', role: 'collaboration_orchestration', lane: 'analysis' },
    { key: 'requirement-analyst', name: '需求分析', role: 'requirement_analysis', lane: 'analysis' },
    { key: 'designer', name: '设计', role: 'design_contract', lane: 'analysis' },
    { key: 'data-integration', name: '数据接入', role: 'data_integration', lane: 'analysis', highImpact: true },
    { key: 'solution-designer', name: '方案设计', role: 'solution_design', lane: 'generation' },
    { key: 'code-generator', name: '代码生成', role: 'code_generation', lane: 'generation' },
    { key: 'tester', name: '测试验证', role: 'test_verification', lane: 'delivery' },
  ],
  edges: [
    { from: 'collaboration-orchestrator', to: 'requirement-analyst' },
    { from: 'requirement-analyst', to: 'designer' },
    { from: 'requirement-analyst', to: 'data-integration' },
    { from: 'designer', to: 'solution-designer' },
    { from: 'data-integration', to: 'solution-designer' },
    { from: 'solution-designer', to: 'code-generator' },
    { from: 'code-generator', to: 'tester' },
  ],
  adjustments: [{ message: '用户要求保留数据接入门禁' }],
}

const plannedGraph = buildCollaborationExecutionGraphView(graphPreview, [])
assert.equal(plannedGraph.cards.length, 8, 'planned graph should include user input plus seven agents')
assert.equal(plannedGraph.cards[0].kind, 'origin', 'first graph card should be the user-input origin')
assert.equal(plannedGraph.cards[1].agentKey, 'collaboration-orchestrator', 'second graph card should be the orchestration hub')
assert.equal(plannedGraph.cards[1].kind, 'orchestrator', 'collaboration orchestrator should be marked as the hub card')
assert.equal(plannedGraph.cards.find(card => card.agentKey === 'designer').state, 'pending_confirmation', 'unconfirmed agents should be pending confirmation')
assert.equal(plannedGraph.edges.every(edge => edge.state === 'planned'), true, 'unconfirmed graph edges should be planned')

const runningGraph = buildCollaborationExecutionGraphView(graphPreview, [
  { stepId: 'step-orch', agentKey: 'collaboration-orchestrator', status: 'succeeded', name: '协作编排' },
  { stepId: 'step-req', agentKey: 'requirement-analyst', status: 'succeeded', name: '需求分析' },
  { stepId: 'step-design', agentKey: 'designer', status: 'running', name: '设计', summary: '正在生成设计契约' },
  { stepId: 'step-data', agentKey: 'data-integration', status: 'pending', name: '数据接入' },
  { stepId: 'step-solution', agentKey: 'solution-designer', status: 'pending', name: '方案设计' },
  { stepId: 'step-code', agentKey: 'code-generator', status: 'pending', name: '代码生成' },
  { stepId: 'step-test', agentKey: 'tester', status: 'pending', name: '测试验证' },
])
assert.equal(runningGraph.confirmed, true, 'presence of real step blocks should make the graph accepted/execution-state')
assert.equal(runningGraph.cards.find(card => card.agentKey === 'collaboration-orchestrator').state, 'completed', 'succeeded orchestrator should be completed')
assert.equal(runningGraph.cards.find(card => card.agentKey === 'designer').state, 'running', 'running step should map to running card state')
assert.equal(runningGraph.cards.find(card => card.agentKey === 'solution-designer').state, 'waiting_upstream', 'pending card with unfinished upstream should wait upstream')
assert.equal(
  runningGraph.cards.find(card => card.agentKey === 'solution-designer').waitingFor.join('、'),
  '设计、数据接入',
  'waiting card should name unfinished upstream agents',
)
assert.equal(
  runningGraph.edges.find(edge => edge.from === 'requirement-analyst' && edge.to === 'designer').state,
  'flowing',
  'completed upstream into running downstream should be flowing',
)
assert.equal(
  runningGraph.edges.find(edge => edge.from === 'designer' && edge.to === 'solution-designer').state,
  'inactive',
  'unfinished upstream should keep downstream edge inactive',
)
assert.ok(runningGraph.waves.length >= 5, 'graph should build multiple horizontal execution waves')
assert.equal(runningGraph.summary.totalAgents, 7, 'summary should count collaboration agents, excluding user input')
assert.equal(runningGraph.summary.running, 1, 'summary should count running cards')
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-collaboration-plan.mjs
```

Expected: FAIL with an import error like:

```text
Cannot find module '../src/hooks/collaborationExecutionGraphState.js'
```

- [ ] **Step 3: Create graph state helper**

Create `sf-portal-mvp/src/hooks/collaborationExecutionGraphState.js` with this content:

```js
const USER_INPUT_KEY = '__user_input__'
const ORCHESTRATOR_KEY = 'collaboration-orchestrator'

export const CARD_STATE_LABEL = {
  pending_confirmation: '待确认',
  waiting_upstream: '等待上游',
  ready: '待启动',
  running: '执行中',
  waiting_user: '等待用户',
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
    return {
      id: agent.key,
      kind: agent.key === ORCHESTRATOR_KEY ? 'orchestrator' : 'agent',
      agentKey: agent.key,
      title: agent.name || agent.key,
      subtitle: agent.role || agent.key,
      description: agent.description || '',
      state,
      stateLabel: CARD_STATE_LABEL[state] || state,
      lane: agent.lane || 'unassigned',
      wave: Math.max(1, (rankByAgent[agent.key] || 0) + 1),
      stepId: step && (step.stepId || step.step_id || step.id) || null,
      step,
      summary: step && (step.summary || step.error || '') || '',
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
    adjustments: Array.isArray(preview && preview.adjustments) ? preview.adjustments : [],
  }
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

function edgeState(fromCard, toCard, confirmed) {
  if (!confirmed) return 'planned'
  if (!fromCard || !toCard) return 'inactive'
  if (fromCard.state === 'failed' || toCard.state === 'failed' || toCard.state === 'waiting_user') return 'blocked'
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
```

- [ ] **Step 4: Run graph state tests**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-collaboration-plan.mjs
```

Expected: PASS. The script prints no error and exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/mengwei/ww/Developer/xian630
git add sf-portal-mvp/src/hooks/collaborationExecutionGraphState.js sf-portal-mvp/scripts/check-collaboration-plan.mjs
git commit -m "feat(portal): build collaboration execution graph state"
```

## Task 2: Thread Graph State Into Dialogue Timeline

**Files:**
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/scripts/check-collaboration-plan.mjs`

- [ ] **Step 1: Write failing timeline integration assertions**

Add these static assertions to `sf-portal-mvp/scripts/check-collaboration-plan.mjs` after the existing `const state = ...` reads:

```js
const dialogueTimeline = readFileSync(new URL('../src/hooks/dialogueTimeline.js', import.meta.url), 'utf8')
assert.match(dialogueTimeline, /buildCollaborationExecutionGraphView/, 'dialogue timeline should build collaboration execution graph view data')
assert.match(dialogueTimeline, /graph:\s*buildCollaborationExecutionGraphView/, 'collaboration timeline item should carry graph view data')
```

Add this assertion after `previewItem` is found:

```js
assert.ok(previewItem.graph, 'collaboration timeline item should include graph data for rendering')
assert.equal(previewItem.graph.cards.find(card => card.agentKey === 'collaboration-orchestrator').kind, 'orchestrator', 'timeline graph should keep the orchestrator hub card')
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-collaboration-plan.mjs
```

Expected: FAIL with:

```text
dialogue timeline should build collaboration execution graph view data
```

- [ ] **Step 3: Import graph helper**

Modify the import block at the top of `sf-portal-mvp/src/hooks/dialogueTimeline.js`:

```js
import { buildThinkingByStepAttempt, thinkingKey } from './taskThinkingState.js';
import { buildCollaborationExecutionGraphView } from './collaborationExecutionGraphState.js'
```

- [ ] **Step 4: Add graph to timeline item**

Replace the current `collaboration_plan_preview` item construction in `buildDialogueTimeline`:

```js
  const collaborationPreview = safeCollaborationPlanPreview(view.collaborationPlanPreview)
  if (collaborationPreview) {
    items.push({
      id: `${view.session.id || 'dlg'}_collaboration_plan_preview`,
      type: 'collaboration_plan_preview',
      preview: collaborationPreview,
      graph: buildCollaborationExecutionGraphView(collaborationPreview, taskBlocks),
    })
  }
```

- [ ] **Step 5: Run timeline integration test**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-collaboration-plan.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/mengwei/ww/Developer/xian630
git add sf-portal-mvp/src/hooks/dialogueTimeline.js sf-portal-mvp/scripts/check-collaboration-plan.mjs
git commit -m "feat(portal): attach collaboration graph to dialogue timeline"
```

## Task 3: Render Collaboration Execution Graph Component

**Files:**
- Create: `sf-portal-mvp/src/components/CollaborationExecutionGraph.jsx`
- Create: `sf-portal-mvp/src/components/CollaborationExecutionGraph.css`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/scripts/check-collaboration-plan.mjs`

- [ ] **Step 1: Write failing component extraction assertions**

Add these file reads to `sf-portal-mvp/scripts/check-collaboration-plan.mjs`:

```js
const graphComponent = readFileSync(new URL('../src/components/CollaborationExecutionGraph.jsx', import.meta.url), 'utf8')
const graphCss = readFileSync(new URL('../src/components/CollaborationExecutionGraph.css', import.meta.url), 'utf8')
```

Add these assertions:

```js
assert.match(workbench, /CollaborationExecutionGraph/, 'ConversationWorkbench should render the extracted graph component')
assert.doesNotMatch(workbench, /function CollaborationPlanPreviewCard/, 'old inline collaboration preview card should be removed')
assert.match(graphComponent, /function CollaborationExecutionGraph/, 'graph component should export a CollaborationExecutionGraph component')
assert.match(graphComponent, /ceg-orchestrator/, 'graph component should render a prominent orchestrator card')
assert.match(graphComponent, /ceg-edge-flowing/, 'graph component should render edge state classes')
assert.match(graphCss, /@keyframes cegFlowRight/, 'graph css should define animated flow lines')
assert.match(graphCss, /\.ceg-card-state-running/, 'graph css should style running cards')
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-collaboration-plan.mjs
```

Expected: FAIL with missing `CollaborationExecutionGraph.jsx`.

- [ ] **Step 3: Create graph component**

Create `sf-portal-mvp/src/components/CollaborationExecutionGraph.jsx`:

```jsx
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
      disabled={!canOpenTask && card.kind !== 'origin'}
      data-agent-key={card.agentKey}
    >
      <span className="ceg-card-icon">
        <Icon size={18} className={card.state === 'running' ? 'ceg-spin' : ''} />
      </span>
      <span className="ceg-card-main">
        <strong>{card.title}</strong>
        <small>{card.subtitle}</small>
      </span>
      {card.highImpact ? <em className="ceg-gate">门禁</em> : null}
      <span className="ceg-card-desc">{card.description || card.summary || waitText || '等待编排流转'}</span>
      <span className="ceg-card-state">{card.stateLabel}</span>
      {waitText ? <span className="ceg-card-wait">{waitText}</span> : null}
    </button>
  )
}

function WaveConnector({ edges, activeKey, relatedKeys }) {
  const state = mergedEdgeState(edges)
  const active = activeKey && edges.some(edge => relatedKeys.has(edge.from) && relatedKeys.has(edge.to))
  return (
    <div className={`ceg-connector ceg-edge-${state}${active ? ' is-active' : ''}`} aria-hidden="true">
      <span className="ceg-line ceg-line-main" />
      <span className="ceg-line ceg-line-branch ceg-line-top" />
      <span className="ceg-line ceg-line-branch ceg-line-bottom" />
      <span className="ceg-arrow" />
    </div>
  )
}

function mergedEdgeState(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return 'inactive'
  if (edges.some(edge => edge.state === 'blocked')) return 'blocked'
  if (edges.some(edge => edge.state === 'flowing')) return 'flowing'
  if (edges.every(edge => edge.state === 'completed')) return 'completed'
  if (edges.some(edge => edge.state === 'planned')) return 'planned'
  return 'inactive'
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
```

- [ ] **Step 4: Create graph CSS**

Create `sf-portal-mvp/src/components/CollaborationExecutionGraph.css`:

```css
.ceg { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid rgba(111, 218, 255, 0.3); border-radius: 8px; background: rgba(18, 72, 98, 0.38); }
.ceg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ceg-head h3 { margin: 0; color: #edfaff; font-size: 13px; font-weight: 600; }
.ceg-head p { margin: 3px 0 0; color: #83cddd; font-size: 11px; }
.ceg-summary { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.ceg-summary span { min-height: 22px; padding: 3px 8px; border: 1px solid rgba(104, 221, 255, 0.24); border-radius: 999px; background: rgba(6, 18, 29, 0.5); color: #9ddff0; font-size: 11px; white-space: nowrap; }
.ceg-canvas { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding: 6px 2px 8px; scrollbar-width: thin; scrollbar-color: rgba(104, 221, 255, 0.42) rgba(6, 18, 29, 0.28); }
.ceg-wave-group { display: flex; align-items: stretch; flex: 0 0 auto; }
.ceg-wave { min-width: 154px; display: flex; flex-direction: column; align-items: stretch; gap: 7px; }
.ceg-wave-label { color: #75bfd2; font-size: 10px; text-align: center; }
.ceg-wave-cards { display: flex; flex-direction: column; justify-content: center; gap: 8px; min-height: 100%; }
.ceg-card { position: relative; width: 154px; min-height: 116px; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 6px; align-items: start; padding: 10px; border: 1px solid rgba(104, 221, 255, 0.22); border-radius: 8px; background: linear-gradient(180deg, rgba(16, 57, 78, 0.92), rgba(8, 25, 39, 0.9)); color: #d7eef8; text-align: left; cursor: pointer; transition: border-color 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease, transform 0.16s ease; }
.ceg-card:disabled { cursor: default; }
.ceg-card:hover, .ceg-card.is-active { border-color: rgba(104, 221, 255, 0.65); box-shadow: 0 0 0 1px rgba(104, 221, 255, 0.18), 0 10px 22px rgba(0, 0, 0, 0.25); transform: translateY(-1px); }
.ceg-card.is-dimmed { opacity: 0.42; }
.ceg-card-icon { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; background: rgba(104, 221, 255, 0.14); color: #68ddff; }
.ceg-card-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ceg-card-main strong { color: #f0fbff; font-size: 12px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ceg-card-main small { color: #75bfd2; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ceg-card-desc { grid-column: 1 / -1; min-height: 28px; color: rgba(215, 238, 248, 0.72); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
.ceg-card-state { grid-column: 1 / -1; justify-self: start; padding: 3px 8px; border-radius: 999px; background: rgba(6, 18, 29, 0.54); color: #9ddff0; font-size: 11px; font-weight: 600; }
.ceg-card-wait { grid-column: 1 / -1; color: #83cddd; font-size: 10px; line-height: 1.3; overflow-wrap: anywhere; }
.ceg-gate { position: absolute; top: 6px; right: 7px; padding: 1px 5px; border: 1px solid rgba(252, 211, 77, 0.38); border-radius: 999px; background: rgba(92, 58, 8, 0.42); color: #fde68a; font-size: 9px; font-style: normal; }
.ceg-origin { border-color: rgba(252, 211, 77, 0.34); }
.ceg-orchestrator { border-color: rgba(167, 139, 250, 0.55); box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.16), 0 10px 24px rgba(23, 15, 50, 0.24); }
.ceg-card-state-running { border-color: rgba(104, 221, 255, 0.68); }
.ceg-card-state-running::before { content: ''; position: absolute; inset: -1px; border-radius: 8px; border: 1px solid rgba(104, 221, 255, 0.58); animation: cegPulse 1.6s ease-in-out infinite; pointer-events: none; }
.ceg-card-state-completed .ceg-card-state { color: #9df3a6; background: rgba(20, 64, 50, 0.5); }
.ceg-card-state-failed .ceg-card-state, .ceg-card-state-waiting_user .ceg-card-state { color: #ffd98a; background: rgba(92, 58, 8, 0.5); }
.ceg-card-state-skipped .ceg-card-state { color: #a5bdca; }
.ceg-connector { position: relative; width: 58px; min-height: 116px; align-self: stretch; flex: 0 0 58px; }
.ceg-line { position: absolute; border-radius: 2px; }
.ceg-line-main { top: 50%; left: 0; right: 0; height: 3px; transform: translateY(-50%); background: rgba(143, 176, 191, 0.28); }
.ceg-line-branch { display: none; height: 3px; left: 50%; right: 0; background: rgba(143, 176, 191, 0.28); }
.ceg-arrow { position: absolute; top: 50%; right: 0; width: 0; height: 0; border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-left: 9px solid rgba(143, 176, 191, 0.48); transform: translateY(-50%); }
.ceg-edge-planned .ceg-line-main, .ceg-edge-flowing .ceg-line-main { background: repeating-linear-gradient(90deg, rgba(104, 221, 255, 0.86) 0 8px, rgba(104, 221, 255, 0.16) 8px 16px); background-size: 16px 100%; animation: cegFlowRight 0.9s linear infinite; }
.ceg-edge-planned .ceg-arrow, .ceg-edge-flowing .ceg-arrow { border-left-color: rgba(104, 221, 255, 0.78); filter: drop-shadow(0 0 4px rgba(104, 221, 255, 0.5)); }
.ceg-edge-completed .ceg-line-main { background: rgba(127, 235, 155, 0.62); }
.ceg-edge-completed .ceg-arrow { border-left-color: rgba(127, 235, 155, 0.8); }
.ceg-edge-blocked .ceg-line-main { background: repeating-linear-gradient(90deg, rgba(252, 211, 77, 0.8) 0 8px, rgba(252, 211, 77, 0.16) 8px 16px); }
.ceg-edge-blocked .ceg-arrow { border-left-color: rgba(252, 211, 77, 0.8); }
.ceg-connector.is-active .ceg-line-main { box-shadow: 0 0 10px rgba(104, 221, 255, 0.36); }
.ceg-adjustments { display: flex; align-items: flex-start; gap: 6px; padding: 7px 8px; border: 1px solid rgba(252, 211, 77, 0.28); border-radius: 6px; background: rgba(92, 58, 8, 0.34); color: #fde68a; font-size: 11px; line-height: 1.4; }
.ceg-adjustments ul { margin: 0; padding-left: 14px; }
.ceg-spin { animation: cegSpin 1s linear infinite; }
@keyframes cegFlowRight { from { background-position: 0 0; } to { background-position: 16px 0; } }
@keyframes cegPulse { 0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 0.95; transform: scale(1.02); } }
@keyframes cegSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@media (max-width: 760px) {
  .ceg-head { flex-direction: column; }
  .ceg-card { width: 142px; }
  .ceg-connector { width: 42px; flex-basis: 42px; }
}
```

- [ ] **Step 5: Wire component into ConversationWorkbench**

Add imports in `sf-portal-mvp/src/components/ConversationWorkbench.jsx`:

```jsx
import { CollaborationExecutionGraph } from './CollaborationExecutionGraph'
```

In the `timeline.map(item => (` render call, pass `onToggleDrawerEntry`:

```jsx
          <TimelineItem
            key={item.id}
            item={item}
            draftAnswers={draftAnswers}
            setDraftAnswers={setDraftAnswers}
            submitting={submitting}
            focusRequirement={focusRequirement}
            onSelectRoute={onSelectRoute}
            onOpenApp={onOpenApp}
            onAcceptConsolidation={onAcceptConsolidation}
            onSend={onSend}
            onSelectClarificationScope={onSelectClarificationScope}
            onOpenTaskDrawer={() => onToggleDrawerEntry && onToggleDrawerEntry('task')}
            onPickClarification={(scope, value) => {
              if (!value) return
              if (onSelectClarificationScope) onSelectClarificationScope(scope)
              setInput(prev => {
                const trimmed = String(prev).trim()
                return trimmed ? `${trimmed}；${value}` : value
              })
            }}
          />
```

Change `TimelineItem` signature:

```jsx
function TimelineItem({ item, draftAnswers, setDraftAnswers, submitting, focusRequirement, onSelectRoute, onOpenApp, onAcceptConsolidation, onSend, onSelectClarificationScope, onPickClarification, onOpenTaskDrawer }) {
```

Replace the `collaboration_plan_preview` branch:

```jsx
  if (item.type === 'collaboration_plan_preview') {
    return (
      <CollaborationExecutionGraph
        graph={item.graph}
        onOpenTask={card => {
          if (card && card.stepId && onOpenTaskDrawer) onOpenTaskDrawer(card)
        }}
      />
    )
  }
```

Remove the old `CollaborationPlanPreviewCard` function from `ConversationWorkbench.jsx`.

- [ ] **Step 6: Run component extraction checks**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-collaboration-plan.mjs
```

Expected: PASS.

- [ ] **Step 7: Run frontend build**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run build
```

Expected:

```text
✓ built
```

- [ ] **Step 8: Commit**

```bash
cd /Users/mengwei/ww/Developer/xian630
git add sf-portal-mvp/src/components/CollaborationExecutionGraph.jsx sf-portal-mvp/src/components/CollaborationExecutionGraph.css sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/scripts/check-collaboration-plan.mjs
git commit -m "feat(portal): render collaboration execution graph"
```

## Task 4: Navigation And Interaction Hardening

**Files:**
- Modify: `sf-portal-mvp/src/components/CollaborationExecutionGraph.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/scripts/check-workbench-drawer.mjs`

- [ ] **Step 1: Write failing navigation assertions**

Append to `sf-portal-mvp/scripts/check-workbench-drawer.mjs`:

```js
const graphJsx = readFileSync(new URL('../src/components/CollaborationExecutionGraph.jsx', import.meta.url), 'utf8')
assert.match(workbenchJsx, /onOpenTaskDrawer/, 'ConversationWorkbench should pass task-drawer navigation into timeline items')
assert.match(workbenchJsx, /onToggleDrawerEntry && onToggleDrawerEntry\('task'\)/, 'graph card click should open the task execution drawer')
assert.match(graphJsx, /relatedCardKeys/, 'graph component should compute related upstream and downstream cards for hover focus')
assert.match(graphJsx, /onOpenTask\(card\)/, 'graph component should call onOpenTask with the clicked card')
assert.match(graphJsx, /disabled=\{!canOpenTask && card\.kind !== 'origin'\}/, 'pre-confirmation non-origin cards should not pretend to open task details')
```

- [ ] **Step 2: Run test and verify it fails if Task 3 did not wire navigation**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-workbench-drawer.mjs
```

Expected after Task 3: PASS. If it fails, the missing message identifies the exact navigation contract to fix.

- [ ] **Step 3: Improve card click accessibility**

In `CollaborationExecutionGraph.jsx`, update `GraphCard` button attributes:

```jsx
      aria-label={`${card.title}，${card.stateLabel}${canOpenTask ? '，打开任务详情' : ''}`}
      title={canOpenTask ? '打开任务执行详情' : card.kind === 'origin' ? '用户输入起点' : '确认后可打开任务详情'}
```

Place these attributes on the same `<button>` as the existing `className`, `onClick`, and `disabled`.

- [ ] **Step 4: Run checks**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
node scripts/check-workbench-drawer.mjs
node scripts/check-collaboration-plan.mjs
npm run build
```

Expected:

```text
check-workbench-drawer: OK
✓ built
```

- [ ] **Step 5: Commit**

```bash
cd /Users/mengwei/ww/Developer/xian630
git add sf-portal-mvp/src/components/CollaborationExecutionGraph.jsx sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/scripts/check-workbench-drawer.mjs
git commit -m "feat(portal): navigate from collaboration graph cards"
```

## Task 5: Browser Verification And Final Polish

**Files:**
- Modify if verification exposes layout issues: `sf-portal-mvp/src/components/CollaborationExecutionGraph.css`
- No backend source changes expected.

- [ ] **Step 1: Run frontend logic and build checks**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run test:logic
npm run build
```

Expected:

```text
check-collaboration-plan.mjs
✓ built
```

- [ ] **Step 2: Run backend smoke tests to verify no unintended server impact**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630/factory-server
go test ./...
```

Expected:

```text
ok  	github.com/weimengtsgit/xian630/factory-server/internal/server
```

- [ ] **Step 3: Run browser mount smoke**

Start Vite:

```bash
cd /Users/mengwei/ww/Developer/xian630/sf-portal-mvp
npm run dev -- --host 127.0.0.1 --port 5173
```

In another shell, run:

```bash
cd /Users/mengwei/ww/Developer/xian630
NODE_PATH=/Users/mengwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/mengwei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node - <<'NODE'
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForSelector('#root > *', { timeout: 10000 });
  await page.waitForTimeout(1500);
  const rootText = await page.locator('#root').innerText({ timeout: 10000 });
  if (rootText.trim().length < 20) throw new Error(`Root did not render enough content. textLength=${rootText.trim().length}`);
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, rootTextLength: rootText.trim().length }));
  await browser.close();
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
NODE
```

Expected:

```json
{"ok":true,"rootTextLength":8569}
```

The exact `rootTextLength` may differ; it must be greater than 20 and the script must exit 0.

- [ ] **Step 4: Run whitespace and status checks**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
git diff --check
git status --short --branch
```

Expected:

```text
## feat-dev-0629...origin/feat-dev-0629
 M CONTEXT.md
```

Plus the feature files if they are not committed by earlier tasks. No whitespace errors.

- [ ] **Step 5: Commit final polish if needed**

If Step 3 or Step 4 required CSS/layout fixes, commit them:

```bash
cd /Users/mengwei/ww/Developer/xian630
git add sf-portal-mvp/src/components/CollaborationExecutionGraph.css
git commit -m "fix(portal): polish collaboration execution graph layout"
```

If no files changed after the prior task commits, skip this commit.

## Task 6: Documentation Commit

**Files:**
- Modify: `CONTEXT.md`
- Create: `docs/superpowers/plans/2026-06-29-collaboration-execution-graph.md`

- [ ] **Step 1: Review glossary terms**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
rg -n "协作编排执行图|编排卡片状态|编排依赖线状态|协作编排智能体" CONTEXT.md
```

Expected:

```text
CONTEXT.md:75:**协作编排执行图**:
CONTEXT.md:79:**编排卡片状态**:
CONTEXT.md:83:**编排依赖线状态**:
CONTEXT.md:375:**协作编排智能体**:
```

Line numbers may differ; all four terms must be present.

- [ ] **Step 2: Commit glossary and implementation plan**

Run:

```bash
cd /Users/mengwei/ww/Developer/xian630
git add CONTEXT.md docs/superpowers/plans/2026-06-29-collaboration-execution-graph.md
git commit -m "docs: plan collaboration execution graph"
```

## Self-Review

Spec coverage:

- Real execution state after confirmation: covered by Task 1 state helper and Task 2 timeline integration.
- Execution-wave layout: covered by Task 1 `topologicalRanks` and `buildWaves`.
- User input origin card: covered by Task 1 `originCard`.
- Orchestration hub card: covered by Task 1 `kind: 'orchestrator'` and Task 3 `.ceg-orchestrator`.
- Animated flow line effect based on `69fcf80`: covered by Task 3 CSS keyframes and `repeating-linear-gradient`.
- Card click navigation to task drawer: covered by Task 4.
- No graph-based execution control: covered by component click contract and scope.
- Conversation-area only: no task drawer refactor tasks included.

Placeholder scan:

- The plan contains no unresolved placeholders and no open-ended edge-case instructions.
- Every implementation step includes concrete code or an exact command with expected output.

Type consistency:

- `buildCollaborationExecutionGraphView(preview, jobStepBlocks)` is defined in Task 1 and imported in Task 2.
- Graph item shape uses `item.graph` in both timeline and rendering tasks.
- Card states use the same keys in tests, helper, JSX classes, and CSS.
- Edge states use the same keys in tests, helper, JSX classes, and CSS.
