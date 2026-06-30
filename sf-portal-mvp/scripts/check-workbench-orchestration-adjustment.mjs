// sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AGGREGATE_CARD_KEYS,
  buildWorkbenchOrchestrationView,
  aggregateCardLabel,
} from '../src/hooks/workbenchOrchestrationState.js'

const empty = buildWorkbenchOrchestrationView({ view: null, workTraceItems: [], jobStepBlocks: [] })
assert.deepEqual(
  empty.cards.map(card => [card.key, card.label, card.state]),
  [
    ['user_input', '用户输入', 'not_started'],
    ['business_logic', '业务逻辑', 'not_started'],
    ['interface_parsing', '界面解析', 'not_started'],
    ['data_capture', '数据抓取', 'not_started'],
    ['production_delivery', '生产交付', 'not_started'],
  ],
)
assert.deepEqual(empty.edges, [
  { from: 'user_input', to: 'business_logic', state: 'inactive' },
  { from: 'business_logic', to: 'interface_parsing', state: 'inactive' },
  { from: 'business_logic', to: 'data_capture', state: 'inactive' },
  { from: 'interface_parsing', to: 'production_delivery', state: 'inactive' },
  { from: 'data_capture', to: 'production_delivery', state: 'inactive' },
])
assert.equal(aggregateCardLabel('requirement-analyst'), '业务逻辑')
assert.equal(aggregateCardLabel('designer'), '界面解析')
assert.equal(aggregateCardLabel('data-integration'), '数据抓取')
assert.equal(aggregateCardLabel('code-generator'), '生产交付')

const running = buildWorkbenchOrchestrationView({
  view: {
    session: { id: 'dlg_1', status: 'task_running', intent: 'application_generation' },
    messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成排班系统' }],
    workbenchArtifacts: [
      { id: 'req_doc', cardKey: 'business_logic', kind: 'project_document', label: '需求文档', path: 'docs/01-requirements.md' },
    ],
  },
  jobStepBlocks: [
    { stepId: 's1', kind: 'requirement_analysis', agentKey: 'requirement-analyst', status: 'succeeded', name: '需求分析', summary: '需求已冻结' },
    { stepId: 's2', kind: 'domain_analysis', agentKey: 'domain-analyst', status: 'succeeded', name: '领域分析', summary: '领域规则已补齐' },
    { stepId: 's3', kind: 'design_contract', agentKey: 'designer', status: 'waiting_user', name: '界面设计', summary: '等待确认布局方案' },
    { stepId: 's4', kind: 'data_integration', agentKey: 'data-integration', status: 'pending', name: '数据接入' },
    { stepId: 's5', kind: 'solution_design', agentKey: 'solution-designer', status: 'pending', name: '方案设计' },
  ],
  workTraceItems: [
    { type: 'assistant_output', stepId: 's3', payload: { summary: '识别为审批列表 + 审批详情双视图' } },
  ],
})
assert.equal(running.cardsByKey.user_input.state, 'confirmed')
assert.equal(running.cardsByKey.business_logic.state, 'confirmed')
assert.equal(running.cardsByKey.business_logic.artifacts[0].path, 'docs/01-requirements.md')
assert.equal(running.cardsByKey.interface_parsing.state, 'waiting_user_clarification')
assert.equal(running.cardsByKey.interface_parsing.currentAction, '等待确认布局方案')
assert.equal(running.cardsByKey.data_capture.state, 'waiting_upstream')
assert.equal(running.cardsByKey.production_delivery.state, 'waiting_upstream')
assert.equal(running.activeCardKey, 'interface_parsing')
assert.equal(running.focusQueue.join('>'), 'business_logic>interface_parsing>data_capture>production_delivery')

const production = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_2', status: 'task_running', intent: 'application_generation' }, messages: [{ id: 'u2', role: 'user', kind: 'prompt', content: '生成系统' }] },
  jobStepBlocks: [
    { stepId: 'r', kind: 'requirement_analysis', agentKey: 'requirement-analyst', status: 'succeeded', summary: '需求完成' },
    { stepId: 'd', kind: 'design_contract', agentKey: 'designer', status: 'succeeded', summary: '界面完成' },
    { stepId: 'x', kind: 'data_integration', agentKey: 'data-integration', status: 'succeeded', summary: '数据契约完成' },
    { stepId: 'c', kind: 'code_generation', agentKey: 'code-generator', status: 'running', name: '代码生成', summary: '正在生成代码' },
  ],
})
assert.equal(production.cardsByKey.production_delivery.state, 'running')
assert.equal(production.cardsByKey.production_delivery.subStage, '代码生成')
assert.equal(production.edges.find(edge => edge.from === 'data_capture' && edge.to === 'production_delivery').state, 'flowing')

assert.deepEqual(AGGREGATE_CARD_KEYS, ['user_input', 'business_logic', 'interface_parsing', 'data_capture', 'production_delivery'])

const graphSource = readFileSync(new URL('../src/components/AggregateOrchestrationGraph.jsx', import.meta.url), 'utf8')
assert.equal(graphSource.includes('协作编排'), false, 'aggregate graph must not render 协作编排 as a card')
for (const label of ['用户输入', '业务逻辑', '界面解析', '数据抓取', '生产交付']) {
  assert.equal(graphSource.includes(label), true, `graph source must render ${label}`)
}
const css = readFileSync(new URL('../src/components/AggregateOrchestrationGraph.css', import.meta.url), 'utf8')
assert.equal(css.includes('@media (prefers-reduced-motion: reduce)'), true, 'pulse motion must respect reduced motion')
assert.equal(css.includes('position: sticky'), true, 'graph must support fixed-in-workbench placement')

// ---- Task 4: attachment composer + message send-path ----------------------
const clientSource = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
assert.equal(clientSource.includes('uploadDialogueAttachment'), true, 'client must expose uploadDialogueAttachment')
assert.equal(clientSource.includes('attachmentIds'), true, 'message send must carry attachmentIds')
const composerSource = readFileSync(new URL('../src/components/AttachmentComposer.jsx', import.meta.url), 'utf8')
assert.equal(composerSource.includes('X'), true, 'pending attachment chips must expose a remove icon')
assert.equal(composerSource.includes('input type="file"'), true, 'composer must include file input')
const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
assert.equal(appSource.includes('onSend={(prompt, options = {})'), true, 'App must preserve onSend options')
assert.equal(appSource.includes('dialogue.send(prompt, options)'), true, 'App must pass attachment options into dialogue.send')

console.log('check-workbench-orchestration-adjustment: ok')
