import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { buildCollaborationCardView } from '../src/hooks/collaborationPlanState.js'
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

const jobCenter = readFileSync(new URL('../src/components/JobCenter.jsx', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('../src/components/StepExecutionDrawer.jsx', import.meta.url), 'utf8')
const state = readFileSync(new URL('../src/hooks/collaborationPlanState.js', import.meta.url), 'utf8')
const execState = readFileSync(new URL('../src/hooks/executionRecordState.js', import.meta.url), 'utf8')
const useJobs = readFileSync(new URL('../src/hooks/useJobs.js', import.meta.url), 'utf8')

assert.match(jobCenter, /collaborationLanes/, 'JobCenter should render collaboration lanes when a plan is available')
assert.match(jobCenter, /getJobCollaborationPlan|collaborationPlan/, 'JobCenter should consume collaboration plan data')
assert.match(useJobs, /getJobCollaborationPlan\(jobId\)/, 'useJobs should hydrate the selected job collaboration plan')
assert.match(useJobs, /setCollaborationPlan\(collaborationPlanData\)/, 'useJobs should store the hydrated collaboration plan')
assert.match(useJobs, /collaborationPlan,/, 'useJobs should return collaborationPlan so App can thread it into JobCenter')
assert.match(state, /buildCollaborationCardView/, 'collaboration plan state helper should build card views')
assert.match(execState, /fixedSteps\s*=\s*\[\]/, 'execution record helper should accept dynamic step definitions')
assert.doesNotMatch(jobCenter, /3x2 matrix of the six fixed stages/, 'JobCenter should no longer describe only fixed six stages')
assert.match(workbench, /cw-collaboration-graph/, 'confirm preview should render a collaboration graph')
assert.match(workbench, /collaboration_plan_preview/, 'confirm preview graph should render as a dialogue timeline item')
assert.match(workbench, /uniqueEdges/, 'confirm preview graph should dedupe plan edges before rendering')
assert.doesNotMatch(workbench, /edge\.to\}-\$\{index\}/, 'confirm preview graph keys should not depend on array indexes')
assert.match(workbench, /cw-collaboration-adjustments/, 'confirm preview should show collaboration adjustment records')
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
    agents: dynamicPlan.plan.agents,
    edges: [{ from: 'agent-1', to: 'agent-2' }, { from: 'agent-1', to: 'agent-2' }],
    highImpactWarnings: [{ agentKey: 'agent-3', action: 'confirm_participation', message: '需要质量门禁' }],
  },
})
const previewItem = confirmedDialogueTimeline.find(item => item.type === 'collaboration_plan_preview')
assert.ok(previewItem, 'confirmed dialogue timeline should retain the collaboration preview inside the conversation')
assert.equal(previewItem.preview.agents.length, 13, 'retained collaboration preview should include every planned agent')
assert.equal(previewItem.preview.adjustments[0].message, '需要质量门禁', 'retained collaboration preview should map high-impact warnings to adjustments')
