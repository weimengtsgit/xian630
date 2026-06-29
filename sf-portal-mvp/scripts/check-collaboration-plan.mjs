import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { buildCollaborationCardView } from '../src/hooks/collaborationPlanState.js'
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'
import { buildCollaborationExecutionGraphView } from '../src/hooks/collaborationExecutionGraphState.js'

const jobCenter = readFileSync(new URL('../src/components/JobCenter.jsx', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('../src/components/StepExecutionDrawer.jsx', import.meta.url), 'utf8')
const state = readFileSync(new URL('../src/hooks/collaborationPlanState.js', import.meta.url), 'utf8')
const execState = readFileSync(new URL('../src/hooks/executionRecordState.js', import.meta.url), 'utf8')
const useJobs = readFileSync(new URL('../src/hooks/useJobs.js', import.meta.url), 'utf8')
const dialogueTimeline = readFileSync(new URL('../src/hooks/dialogueTimeline.js', import.meta.url), 'utf8')
const graphComponent = readFileSync(new URL('../src/components/CollaborationExecutionGraph.jsx', import.meta.url), 'utf8')
const graphCss = readFileSync(new URL('../src/components/CollaborationExecutionGraph.css', import.meta.url), 'utf8')
assert.match(dialogueTimeline, /buildCollaborationExecutionGraphView/, 'dialogue timeline should build collaboration execution graph view data')
assert.match(dialogueTimeline, /graph:\s*buildCollaborationExecutionGraphView/, 'collaboration timeline item should carry graph view data')

assert.match(jobCenter, /collaborationLanes/, 'JobCenter should render collaboration lanes when a plan is available')
assert.match(jobCenter, /getJobCollaborationPlan|collaborationPlan/, 'JobCenter should consume collaboration plan data')
assert.match(useJobs, /getJobCollaborationPlan\(jobId\)/, 'useJobs should hydrate the selected job collaboration plan')
assert.match(useJobs, /setCollaborationPlan\(collaborationPlanData\)/, 'useJobs should store the hydrated collaboration plan')
assert.match(useJobs, /collaborationPlan,/, 'useJobs should return collaborationPlan so App can thread it into JobCenter')
assert.match(state, /buildCollaborationCardView/, 'collaboration plan state helper should build card views')
assert.match(execState, /fixedSteps\s*=\s*\[\]/, 'execution record helper should accept dynamic step definitions')
assert.doesNotMatch(jobCenter, /3x2 matrix of the six fixed stages/, 'JobCenter should no longer describe only fixed six stages')
assert.match(workbench, /collaboration_plan_preview/, 'confirm preview graph should render as a dialogue timeline item')
assert.match(workbench, /CollaborationExecutionGraph/, 'ConversationWorkbench should render the extracted graph component')
assert.doesNotMatch(workbench, /function CollaborationPlanPreviewCard/, 'old inline collaboration preview card should be removed')
assert.match(graphComponent, /function CollaborationExecutionGraph/, 'graph component should export a CollaborationExecutionGraph component')
assert.match(graphComponent, /orchestrator/, 'graph component should render a prominent orchestrator card')
assert.match(graphCss, /ceg-edge-flowing/, 'graph component should render edge state classes')
assert.match(graphComponent, /ceg-edge-seg/, 'graph component should render segmented dependency lines instead of merging all edges into one state')
assert.match(graphComponent, /function EdgeSegments/, 'graph component should route wave dependencies as fork/merge segmented paths')
assert.match(graphComponent, /cardSlotPercent/, 'graph component should align dependency paths to card slots in each wave')
assert.doesNotMatch(graphComponent, /function mergedEdgeState/, 'graph component should not collapse all dependency edges in a wave into one merged state')
assert.match(graphComponent, /card\.summary \|\| waitText \|\| card\.description/, 'graph cards should prefer live task summary before static agent description')
assert.doesNotMatch(graphComponent, /ceg-adjustments/, 'graph component should not render a separate long adjustment card below the execution graph')
assert.match(graphCss, /@keyframes cegFlowRight/, 'graph css should define horizontal animated flow lines')

// New assertions for reveal animation
assert.match(graphComponent, /AlertTriangle/, 'graph component should import AlertTriangle for failed state')
assert.match(graphComponent, /revealedKeys/, 'graph component should have reveal state tracking')
assert.match(graphComponent, /revealingKeys/, 'graph component should track cards that are currently playing their summon animation')
assert.match(graphComponent, /revealComplete/, 'graph component should track reveal completion')
assert.match(graphComponent, /REVEAL_REPLAY_PAUSE_MS/, 'graph reveal should be able to replay the orchestration sequence for visual inspection')
assert.match(graphComponent, /ceg-card-is-hidden/, 'graph component should support hidden cards before reveal')
assert.match(graphComponent, /ceg-card-is-revealed/, 'graph component should support revealed cards')
assert.match(graphComponent, /ceg-card-is-revealing/, 'graph component should attach a dedicated enter animation class to newly summoned cards')
assert.match(graphComponent, /isRevealRunning\s*=\s*!revealComplete && !prefersReducedMotion/, 'graph should run reveal for planned and confirmed graph identities until the reveal completes')
assert.doesNotMatch(graphComponent, /if\s*\(graph\.confirmed\)\s*\{[\s\S]*setRevealComplete\(true\)[\s\S]*return[\s\S]*\}/, 'confirmed graph should not bypass the orchestration reveal replay')
assert.match(graphComponent, /visibleCards\s*=\s*isRevealRunning[\s\S]*wave\.cards\.filter\(card => revealedKeys\.has\(card\.agentKey\)\)/, 'graph should remove unrevealed cards from wave layout instead of reserving empty card slots')
assert.match(graphComponent, /visibleCards\.map\(card =>/, 'graph should render visibleCards rather than all wave cards during reveal')
assert.match(graphComponent, /isRevealRunning && visibleCards\.length === 0\) return null/, 'graph should not render empty future waves before they are revealed')
assert.match(graphComponent, /!\s*isRevealRunning \|\| visibleEdges\.length > 0/, 'graph should not render fallback connector lines when no reveal edge is visible')
assert.match(graphComponent, /ceg-is-orchestrating/, 'graph component should have orchestrating state class')
assert.match(graphComponent, /graph\.confirmed/, 'graph identity should include confirmed state so accepted execution graphs replay the reveal once')
assert.match(graphComponent, /prefers-reduced-motion/, 'graph component should respect reduced motion preferences')
assert.match(graphCss, /\.ceg-is-orchestrating/, 'graph css should define orchestrating state styling')
assert.match(graphCss, /cegOrchestrateScan/, 'graph css should define a visible scanning effect for the orchestration card')
assert.match(graphCss, /\.ceg-is-orchestrating::after/, 'graph css should render the orchestration scan layer')
assert.match(graphCss, /\.ceg-card-is-hidden/, 'graph css should define hidden card styling')
assert.match(graphCss, /\.ceg-card-is-revealed/, 'graph css should define revealed card styling')
assert.match(graphCss, /\.ceg-card-is-revealing/, 'graph css should define a summoned-card enter animation')
assert.match(graphCss, /@keyframes cegAgentReveal/, 'graph css should define a keyframed agent reveal animation')
assert.match(graphCss, /@keyframes cegFlowDown/, 'graph css should define vertical animated flow lines')
assert.match(graphCss, /\.ceg-card-state-running/, 'graph css should style running cards')
assert.match(drawer, /sed-snapshot-skill-files/, 'step drawer should show snapshot skill files')
assert.match(drawer, /snapshotPreview/, 'step drawer should parse snapshot metadata for viewing')

const dynamicPlan = {
  plan: {
    lanes: [
      { id: 'analysis', label: '分析' },
      { id: 'generation', label: '生成' },
    ],
    agents: Array.from({ length: 13 }, (_, index) => ({
      key: `agent-${index + 1}`,
      name: `智能体 ${index + 1}`,
      role: `role-${index + 1}`,
      lane: index < 6 ? 'analysis' : 'generation',
    })),
  },
}
const dynamicCards = buildCollaborationCardView([], [], dynamicPlan)
assert.equal(
  dynamicCards.reduce((count, lane) => count + lane.cards.length, 0),
  13,
  'collaboration plan card view should render every planned agent task, not fall back to the fixed six stages',
)

const confirmedDialogueTimeline = buildDialogueTimeline({
  session: { id: 'dlg-confirmed', status: 'task_running', intent: 'application_generation' },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '请做一个 todo 应用' }],
  child: {
    id: 'clar-confirmed',
    status: 'confirmed',
    messages: [],
    requirement: { appType: 'tool', appName: 'Todo', coreScenario: '管理待办' },
  },
  collaborationPlanPreview: {
    lanes: dynamicPlan.plan.lanes,
    agents: [
      { key: 'collaboration-orchestrator', name: '协作编排', role: 'collaboration_orchestration', lane: 'analysis' },
      ...dynamicPlan.plan.agents,
    ],
    edges: [
      { from: 'collaboration-orchestrator', to: 'agent-1' },
      { from: 'agent-1', to: 'agent-2' },
      { from: 'agent-1', to: 'agent-2' },
    ],
    highImpactWarnings: [{ agentKey: 'agent-3', action: 'confirm_participation', message: '需要质量门禁' }],
  },
})
const previewItem = confirmedDialogueTimeline.find(item => item.type === 'collaboration_plan_preview')
assert.ok(previewItem, 'confirmed dialogue timeline should retain the collaboration preview inside the conversation')
assert.equal(previewItem.preview.agents.length, 14, 'retained collaboration preview should include every planned agent plus orchestrator')
assert.equal(previewItem.preview.adjustments[0].message, '需要质量门禁', 'retained collaboration preview should map high-impact warnings to adjustments')
assert.ok(previewItem.graph, 'collaboration timeline item should include graph data for rendering')
assert.equal(previewItem.graph.cards.find(card => card.agentKey === 'collaboration-orchestrator').kind, 'orchestrator', 'timeline graph should keep the orchestrator hub card')

const timelineWithCollaborationSteps = buildDialogueTimeline({
  session: { id: 'dlg-taskblocks', status: 'task_running', intent: 'application_generation' },
  messages: [{ id: 'u2', role: 'user', kind: 'prompt', content: '请做一个 todo 应用' }],
  collaborationPlanPreview: {
    lanes: dynamicPlan.plan.lanes,
    agents: [
      { key: 'collaboration-orchestrator', name: '协作编排', role: 'collaboration_orchestration', lane: 'analysis' },
      ...dynamicPlan.plan.agents,
    ],
    edges: [
      { from: 'collaboration-orchestrator', to: 'agent-1' },
      { from: 'agent-1', to: 'agent-2' },
    ],
  },
}, null, null, null, [], null, dynamicPlan.plan.agents.map((agent, index) => ({
  id: `step-${index + 1}`,
  job_id: 'job-collab',
  agent_key: agent.key,
  kind: agent.role,
  seq: index + 1,
  status: 'succeeded',
})))
assert.equal(
  timelineWithCollaborationSteps.some(item => item.type === 'task_execution_block'),
  false,
  'conversation timeline should not append long per-agent task cards after the collaboration execution graph',
)

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
