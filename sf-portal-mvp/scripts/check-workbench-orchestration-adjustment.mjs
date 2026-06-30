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

// ---- Task 9: data-capture fallback flow + data-flow track assertion -------
// The data_integration step models the ontology → internet → demo fallback
// order with explicit user confirmation at each boundary. When the ontology
// boundary is unavailable, the step pauses for clarification (waiting_user),
// and the data_capture card surfaces that state plus the agent's summary so
// the user knows WHY the boundary failed (本体接口不可用).
const dataGraph = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_data', status: 'task_running' }, messages: [{ id: 'u', role: 'user', content: 'x' }] },
  jobStepBlocks: [{ stepId: 'data', kind: 'data_integration', agentKey: 'data-integration', status: 'waiting_user', summary: '本体接口不可用，等待降级确认' }],
  workTraceItems: [{ stepId: 'data', type: 'clarification', payload: { questions: [{ id: 'fallback-internet', question: '是否降级为互联网抓取？' }] } }],
})
assert.equal(dataGraph.cardsByKey.data_capture.state, 'waiting_user_clarification')
assert.equal(dataGraph.cardsByKey.data_capture.currentAction.includes('本体接口不可用'), true)

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
// Fix wave: createDialogue must support first-message multipart submission so a
// file attached to the very first message is uploaded alongside dialogue
// creation rather than silently discarded (the locally-staged File has no
// attachment.id to thread into attachmentIds before the dialogue exists).
assert.equal(clientSource.includes('createDialogue'), true, 'client must expose createDialogue')
assert.equal(clientSource.includes("form.append('files'"), true, 'createDialogue must append files to a multipart form for first-message attachments')
assert.equal(clientSource.includes('files.length'), true, 'createDialogue must branch on a non-empty files list')
const composerSource = readFileSync(new URL('../src/components/AttachmentComposer.jsx', import.meta.url), 'utf8')
assert.equal(composerSource.includes('X'), true, 'pending attachment chips must expose a remove icon')
assert.equal(composerSource.includes('input type="file"'), true, 'composer must include file input')
const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
assert.equal(appSource.includes('onSend={(prompt, options = {})'), true, 'App must preserve onSend options')
assert.equal(appSource.includes('dialogue.send(prompt, options)'), true, 'App must pass attachment options into dialogue.send')

// ---- Task 7: workbench agent blocks + responsibility tracks ----------------
const blockSource = readFileSync(new URL('../src/components/WorkbenchAgentBlock.jsx', import.meta.url), 'utf8')
for (const text of ['思考过程', '思考摘要', '模型分析过程', '确认业务逻辑并继续', '确认界面解析并继续', '确认数据抓取并继续']) {
  assert.equal(blockSource.includes(text), true, `agent block must include ${text}`)
}
const tracksSource = readFileSync(new URL('../src/components/WorkbenchTracks.jsx', import.meta.url), 'utf8')
for (const text of ['目标识别', '布局分区', '来源', '方案设计', '部署']) {
  assert.equal(tracksSource.includes(text), true, `tracks must include ${text}`)
}

// ---- Fix wave F6: data-flow track is data-driven, not a static label list ----
// The data_capture track must derive its node states from the REAL verification
// state projected onto the data_contract artifact (ontology/internet/demo
// sources, verification verdicts, fallback history). Assert the component
// references those signals and the metadata that carries them, confirming the
// track is no longer the fixed 来源/连接验证/样本获取/字段识别/契约生成/流向
// label array it replaced.
for (const text of ['ontology', 'internet', 'demo']) {
  assert.equal(tracksSource.includes(text), true, `data-flow track must reference source boundary ${text}`)
}
assert.equal(tracksSource.includes('metadata') || tracksSource.includes('verification') || tracksSource.includes('fallbackHistory'), true, 'data-flow track must read verification metadata')
const orchestrationSource = readFileSync(new URL('../src/hooks/workbenchOrchestrationState.js', import.meta.url), 'utf8')
assert.equal(orchestrationSource.includes('metadata') && orchestrationSource.includes('parseArtifactMetadata'), true, 'orchestration state must parse artifact metadata onto the card')
// The data_contract artifact carries the verification summary (sourceBoundary +
// per-boundary verdicts) the track renders. Drive it end-to-end through the
// view builder and assert the metadata round-trips onto the card.
const dataCardWithMeta = buildWorkbenchOrchestrationView({
  view: {
    session: { id: 'dlg_f6', status: 'task_running' },
    messages: [{ id: 'u', role: 'user', content: 'x' }],
    workbenchArtifacts: [
      {
        id: 'dc',
        cardKey: 'data_capture',
        kind: 'data_contract',
        label: '数据契约',
        status: 'internet',
        metadata: '{"sourceBoundary":"internet","verification":{"ontology":{"status":"failed","reason":"unreachable"},"internet":{"status":"passed","reason":"ok"},"demo":{"status":"pending"}},"fallbackHistory":["ontology_failed"],"sampleCount":24,"fieldCount":5}',
      },
    ],
  },
  jobStepBlocks: [{ stepId: 'data', kind: 'data_integration', agentKey: 'data-integration', status: 'succeeded', summary: '数据契约完成' }],
})
const f6Contract = dataCardWithMeta.cardsByKey.data_capture.artifacts.find(a => a.kind === 'data_contract')
assert.equal(f6Contract && f6Contract.metadata && f6Contract.metadata.sourceBoundary, 'internet', 'data_contract metadata.sourceBoundary must round-trip onto the card')
assert.equal(f6Contract.metadata.verification.ontology.status, 'failed', 'per-boundary verification must round-trip onto the card')
assert.equal(f6Contract.metadata.fallbackHistory[0], 'ontology_failed', 'fallback history must round-trip onto the card')
assert.equal(f6Contract.metadata.fieldCount, 5, 'fieldCount must round-trip onto the card')

// ---- Task 10: production delivery aggregation (auto-repair vs failed vs waiting) ----
// A failed code_review with a blocking_review errorCode surfaces as auto_repairing
// (the bounded auto-repair policy rewinds to code_generation), carrying the
// failed step's name as subStage so the card shows WHICH gate is repairing.
const repair = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_repair', status: 'task_running' }, messages: [{ id: 'u', role: 'user', content: 'x' }] },
  jobStepBlocks: [
    { stepId: 'r', kind: 'requirement_analysis', status: 'succeeded' },
    { stepId: 'd', kind: 'design_contract', status: 'succeeded' },
    { stepId: 'data', kind: 'data_integration', status: 'succeeded' },
    { stepId: 'review', kind: 'code_review', status: 'failed', errorCode: 'blocking_review', name: '代码审查', summary: '发现阻断问题' },
  ],
})
assert.equal(repair.cardsByKey.production_delivery.state, 'auto_repairing')
assert.equal(repair.cardsByKey.production_delivery.subStage, '代码审查')

// A deployment waiting_user (e.g. waiting for a port confirmation) surfaces as
// waiting_user_confirmation, and the card's currentAction prefers the step
// summary so the user sees WHY it paused (等待端口确认).
const userWait = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_wait', status: 'task_running' }, messages: [{ id: 'u', role: 'user', content: 'x' }] },
  jobStepBlocks: [
    { stepId: 'r', kind: 'requirement_analysis', status: 'succeeded' },
    { stepId: 'd', kind: 'design_contract', status: 'succeeded' },
    { stepId: 'data', kind: 'data_integration', status: 'succeeded' },
    { stepId: 'deploy', kind: 'deployment', status: 'waiting_user', name: '部署', summary: '等待端口确认' },
  ],
})
assert.equal(userWait.cardsByKey.production_delivery.state, 'waiting_user_confirmation')
assert.equal(userWait.cardsByKey.production_delivery.currentAction, '等待端口确认')

// ---- Task 13: interface/data compatibility gate ---------------------------
// When a confirmed data contract is incompatible with the interface preview
// (data_contract artifact status 'compatible_failed'), the data_integration
// step fails (schema_validation_failed) but the surface must route the user
// back to INTERFACE confirmation rather than silently continuing: the
// interface_parsing card is forced into waiting_artifact_confirmation and
// becomes the active card, with a currentAction that names the conflict.
const compatibilityFailure = buildWorkbenchOrchestrationView({
  view: {
    session: { id: 'dlg_compat', status: 'task_running' },
    messages: [{ id: 'u', role: 'user', content: 'x' }],
    workbenchArtifacts: [
      { id: 'preview', cardKey: 'interface_parsing', kind: 'interface_preview', label: '界面预览', status: 'provisional' },
      { id: 'contract', cardKey: 'data_capture', kind: 'data_contract', label: '数据契约', status: 'compatible_failed' },
    ],
  },
  jobStepBlocks: [
    { stepId: 'r', kind: 'requirement_analysis', status: 'succeeded' },
    { stepId: 'd', kind: 'design_contract', status: 'succeeded' },
    { stepId: 'data', kind: 'data_integration', status: 'failed', errorCode: 'schema_validation_failed', summary: '数据字段缺少审批状态' },
  ],
})
assert.equal(compatibilityFailure.cardsByKey.interface_parsing.state, 'waiting_artifact_confirmation')
assert.equal(compatibilityFailure.activeCardKey, 'interface_parsing')

// ---- Fix wave F2: task-phase card confirm routes to answerJob, not confirmDialogueClarification
// The WorkbenchAgentBlock confirm buttons (确认业务逻辑/界面解析/数据抓取并继续) back a
// waiting task step in the TASK-PHASE. confirmDialogueClarification returns 409 there
// (no active pre-task clarification child), so a dedicated onConfirmCard must route a
// task-phase confirm through jobs.answerJob. Pre-task business_logic keeps dialogue.confirm.
const appSrc = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
assert.equal(appSrc.includes('onConfirmCard'), true, 'App must define an onConfirmCard callback for card confirms')
assert.equal(appSrc.includes('jobs.answerJob'), true, 'onConfirmCard must advance the task-phase waiting step via jobs.answerJob')
assert.equal(/onConfirmCard/.test(appSrc) && appSrc.indexOf('onConfirmCard') < appSrc.indexOf('dialogue.confirm', appSrc.indexOf('onConfirmCard')), true, 'onConfirmCard must fall back to dialogue.confirm only in the pre-task branch')
const workbenchSrc = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
assert.equal(workbenchSrc.includes('onConfirmCard'), true, 'ConversationWorkbench must accept the onConfirmCard prop')
assert.equal(workbenchSrc.includes('onConfirmCard ? onConfirmCard(key)'), true, 'WorkbenchAgentBlock confirm must prefer onConfirmCard over onConfirm')

console.log('check-workbench-orchestration-adjustment: ok')
