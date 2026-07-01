// sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AGGREGATE_CARD_KEYS,
  buildWorkbenchOrchestrationView,
  aggregateCardLabel,
} from '../src/hooks/workbenchOrchestrationState.js'
import { describeSessionError, buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

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

const freshInput = buildWorkbenchOrchestrationView({
  view: {
    session: { id: 'dlg_fresh', status: 'active', intent: 'application_generation' },
    messages: [{ id: 'u-fresh', role: 'user', kind: 'prompt', content: '请做一个后勤管理应用' }],
  },
  jobStepBlocks: [],
})
assert.equal(freshInput.cardsByKey.user_input.state, 'confirmed')
assert.equal(freshInput.cardsByKey.business_logic.state, 'ready', 'fresh input should enter the business-logic stage before task steps exist')
assert.equal(freshInput.activeCardKey, 'business_logic', 'fresh input should make business_logic the active card')

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

const productionFailure = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_failed', status: 'task_running', intent: 'application_generation' }, messages: [{ id: 'u2', role: 'user', kind: 'prompt', content: '生成系统' }] },
  jobStepBlocks: [
    { stepId: 'r', kind: 'requirement_analysis', agentKey: 'requirement-analyst', status: 'succeeded', summary: '需求完成' },
    { stepId: 'd', kind: 'design_contract', agentKey: 'designer', status: 'succeeded', summary: '界面完成' },
    { stepId: 'x', kind: 'data_integration', agentKey: 'data-integration', status: 'succeeded', summary: '数据契约完成' },
    { stepId: 'c', kind: 'code_generation', agentKey: 'code-generator', status: 'failed', error: 'Read generated-apps/ops/src/components/SummaryMetrics.tsx failed' },
  ],
})
assert.equal(productionFailure.cardsByKey.production_delivery.state, 'failed')
assert.equal(productionFailure.activeCardKey, 'production_delivery', 'failed production delivery must be the headline active stage')
assert.equal(productionFailure.edges.find(edge => edge.from === 'data_capture' && edge.to === 'production_delivery').state, 'blocked_failed')
assert.equal(productionFailure.edges.find(edge => edge.from === 'interface_parsing' && edge.to === 'production_delivery').state, 'blocked_failed')

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

// ---- pre-task clarification: business_logic is the active responsibility ---
// Before the job is created, business_logic has NO job steps, so without a
// dialogue-aware override the card sits at 'ready' (待启动) even while the agent
// is actively running clarification rounds — the graph looks frozen. The card
// must reflect that activity (执行中 + 需求澄清中 / 分析需求中).
const clarifying = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_clar', status: 'drafting_application', intent: 'application_generation' }, messages: [{ id: 'u', role: 'user', content: '做一个后勤管理应用' }] },
  jobStepBlocks: [],
})
assert.equal(clarifying.cardsByKey.business_logic.state, 'running', 'business_logic must be running during pre-task clarification (not 待启动)')
assert.equal(/澄清|分析/.test(clarifying.cardsByKey.business_logic.currentAction), true, 'business_logic currentAction must say it is clarifying/analyzing')
const analyzingDlg = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_ana', status: 'analyzing', intent: 'application_generation' }, messages: [{ id: 'u', role: 'user', content: 'x' }] },
  jobStepBlocks: [],
})
assert.equal(analyzingDlg.cardsByKey.business_logic.state, 'running', 'business_logic must be running while the dialogue is analyzing')

const graphSource = readFileSync(new URL('../src/components/AggregateOrchestrationGraph.jsx', import.meta.url), 'utf8')
assert.equal(graphSource.includes('协作编排'), false, 'aggregate graph must not render 协作编排 as a card')
const css = readFileSync(new URL('../src/components/AggregateOrchestrationGraph.css', import.meta.url), 'utf8')
const collaborationGraphCss = readFileSync(new URL('../src/components/CollaborationExecutionGraph.css', import.meta.url), 'utf8')
assert.equal(collaborationGraphCss.includes('@media (prefers-reduced-motion: reduce)'), true, 'shared ceg pulse motion must respect reduced motion')
assert.equal(collaborationGraphCss.includes('.ceg-card-state-running::before') && collaborationGraphCss.includes('.ceg-card-state-running::before {\n    animation: none !important;'), true, 'running card pulse must be disabled under reduced motion')
assert.equal(css.includes('position: sticky'), true, 'graph must support fixed-in-workbench placement')
assert.equal(css.includes('max-height'), false, 'aggregate graph should not cap the old collaboration-graph visual canvas')
assert.equal(css.includes('justify-content: center'), true, 'aggregate graph cards should be centered in the overview canvas')
assert.equal(css.includes('.aog .ceg-canvas'), true, 'aggregate graph must tune the canvas without changing shared ceg styles')
assert.equal(css.includes('padding: 12px 2px 10px'), true, 'aggregate graph should reduce top padding after removing wave labels')
assert.equal(css.includes('.aog .ceg-card-state-running'), true, 'aggregate 执行中 card carries a scoped running tint')
assert.equal(/\.aog \.ceg-card\b[\s\S]*?transition:/.test(css), true, 'aggregate card state changes animate (transition) instead of snapping')

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
assert.equal(appSrc.includes('scopedTraceSteps'), true, 'App must derive dialogue-scoped task steps for the workbench')
assert.equal(appSrc.includes('traceSteps={scopedTraceSteps}'), true, 'ConversationWorkbench must not receive global jobs.steps')
assert.equal(appSrc.includes('buildTaskBlocks(scopedTraceSteps'), true, 'dialogue task blocks must be built from scoped task steps')
const workbenchSrc = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
assert.equal(workbenchSrc.includes('onConfirmCard'), true, 'ConversationWorkbench must accept the onConfirmCard prop')
assert.equal(workbenchSrc.includes('onConfirmCard ? onConfirmCard(key)'), true, 'WorkbenchAgentBlock confirm must prefer onConfirmCard over onConfirm')

// answerJob (task-internal clarification answer) must carry attachmentIds so UI-uploaded
// attachments bind to the answer message (review finding: client dropped scope.attachmentIds).
const clientSrc = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const answerJobBody = clientSrc.slice(clientSrc.indexOf('answerJob:'), clientSrc.indexOf('retryCurrentStep:'))
assert.equal(answerJobBody.includes('attachmentIds'), true, 'answerJob request body must include scope.attachmentIds')

// Waiting-user data-flow metadata refs may be kind=data_contract but pathless:
// they exist for the data-flow track, not as clickable final data-contract docs.
const agentBlockSrc = readFileSync(new URL('../src/components/WorkbenchAgentBlock.jsx', import.meta.url), 'utf8')
assert.equal(agentBlockSrc.includes('previewableArtifacts'), true, 'WorkbenchAgentBlock must filter metadata-only artifacts before rendering artifact buttons')
const aggregateGraphSrc = readFileSync(new URL('../src/components/AggregateOrchestrationGraph.jsx', import.meta.url), 'utf8')

// The pinned aggregate overview is the same visual language as the historical
// collaboration execution graph, only with the fixed five-card topology. It must
// reuse the ceg container/card/state classes instead of drifting into a separate
// aog-only card system.
assert.equal(aggregateGraphSrc.includes("import './CollaborationExecutionGraph.css'"), true, 'AggregateOrchestrationGraph must import the collaboration graph stylesheet')
assert.equal(aggregateGraphSrc.includes('className="ceg aog"'), true, 'AggregateOrchestrationGraph root must reuse the ceg container class')
assert.equal(aggregateGraphSrc.includes('className="ceg-head'), true, 'AggregateOrchestrationGraph header must reuse the ceg head class')
assert.equal(aggregateGraphSrc.includes('className="ceg-canvas'), true, 'AggregateOrchestrationGraph canvas must reuse the ceg canvas class')
assert.equal(aggregateGraphSrc.includes('用户输入 → 业务逻辑 → 界面解析 / 数据抓取 → 生产交付'), false, 'aggregate graph must not render the path subtitle under the title')
assert.equal(aggregateGraphSrc.includes('ceg-wave-label'), false, 'aggregate graph must not render wave labels above the cards')
assert.equal(aggregateGraphSrc.includes('ceg-card ceg-card-state-'), true, 'AggregateOrchestrationGraph cards must reuse ceg card and state classes')
assert.equal(aggregateGraphSrc.includes('className="ceg-card-icon'), true, 'AggregateOrchestrationGraph icons must reuse the ceg card icon class')
assert.equal(aggregateGraphSrc.includes('className="ceg-card-state'), true, 'AggregateOrchestrationGraph state badge must reuse the ceg state badge class')
assert.equal(aggregateGraphSrc.includes('aria-disabled="true"'), false, 'AggregateOrchestrationGraph cards must not mark clickable artifact descendants as aria-disabled')
assert.equal(aggregateGraphSrc.includes('<small>{card.subtitle}</small>'), false, 'aggregate cards must not render English subtitles under Chinese titles')
assert.equal(aggregateGraphSrc.includes('SUBTITLES'), false, 'aggregate cards must not carry English key subtitles')
assert.equal(aggregateGraphSrc.includes('getCardDescription'), true, 'AggregateOrchestrationGraph must derive user-facing short card descriptions')
assert.equal(aggregateGraphSrc.includes('需求已提交，已进入编排'), true, 'confirmed user input must not keep saying it is waiting for orchestration')
assert.equal(aggregateGraphSrc.includes('正在执行'), true, 'running card text must be a short status label')
assert.equal(aggregateGraphSrc.includes('步骤已完成'), true, 'completed card text must be a short status label')
assert.equal(aggregateGraphSrc.includes('执行失败，查看详情'), true, 'failed card text must be a short status label')
assert.equal(aggregateGraphSrc.includes('读取生成文件失败'), true, 'file-read failures must be shortened on the card')
assert.equal(aggregateGraphSrc.includes('getCardTooltip'), true, 'aggregate graph must keep full card descriptions in the tooltip')
assert.equal(aggregateGraphSrc.includes('onOpenTaskStep'), true, 'failed cards must expose a task detail entry')
assert.equal(aggregateGraphSrc.includes('step.step_id'), true, 'task detail entry must support backend step_id fields')
assert.equal(aggregateGraphSrc.includes('function WaveConnector'), true, 'aggregate graph must restore the old WaveConnector renderer')
assert.equal(aggregateGraphSrc.includes('function EdgeSegment'), true, 'aggregate graph must restore the old EdgeSegment renderer')
assert.equal(aggregateGraphSrc.includes('function buildConnectorModel'), true, 'aggregate graph must restore the old fork/merge connector model')
assert.equal(aggregateGraphSrc.includes('function classifyConnectorMode'), true, 'aggregate graph must classify connector modes like the old collaboration graph')
assert.equal(aggregateGraphSrc.includes('function AggregateConnector'), false, 'aggregate graph must not keep the simplified hand-written connector')
assert.equal(aggregateGraphSrc.includes('aog-card-actions'), false, 'aggregate cards should open task details by card click, not an extra action row')
assert.equal(aggregateGraphSrc.includes('aog-connector-merge'), false, 'aggregate graph should use the old connector model instead of a manual merge class')
assert.equal(css.includes('.aog-connector'), false, 'aggregate CSS should not override the old connector geometry')
assert.equal(css.includes('.aog-action-link'), false, 'aggregate CSS should not add non-legacy card action buttons')

// describeSessionError turns a raw session failure into plain-Chinese
// {title, detail, hint} and MUST NOT leak the operator-grade raw blob.
const e402 = describeSessionError('route_failed', 'claude exit 1: {"type":"result","is_error":true,"api_error_status":402,"result":"API Error: 402 Insufficient Balance"}: runner_exit_nonzero')
assert.equal(e402 && e402.title.includes('余额'), true, '402 → 余额不足 title')
assert.equal(e402 && e402.hint && e402.hint.length > 0, true, 'error must carry an actionable hint')
assert.equal(JSON.stringify(e402).includes('claude exit'), false, 'friendly error must not leak raw "claude exit" blob')
assert.equal(JSON.stringify(e402).includes('api_error_status'), false, 'friendly error must not leak raw JSON')
assert.equal(describeSessionError('', 'api_error_status: 401 Unauthorized').title.includes('鉴权'), true, '401 → 鉴权')
assert.equal(describeSessionError('', 'context deadline exceeded').title.includes('超时'), true, 'timeout → 超时')
assert.equal(describeSessionError('', 'dial tcp: connection refused').title.includes('连接'), true, 'conn refused → 连接失败')
const eUnknown = describeSessionError('', 'something weird happened')
assert.equal(eUnknown.title, '会话处理失败', 'unknown → generic title')
assert.equal(eUnknown.detail.includes('something weird happened'), true, 'unknown fallback surfaces cleaned cause')
assert.equal(describeSessionError('', ''), null, 'no error → null')

// 分析过程 / 思考摘要 merge: a clarification round with BOTH a thinking message
// and an analysis_work_log must render ONE 分析过程 block (carrying the
// comprehensive analysis + the raw thinking as a collapsible 原始思考过程) and NO
// standalone 思考摘要 block — the old behavior duplicated the analysis text across
// both. flushPendingThinking still covers the rare thinking-without-analysis case.
const mergeItems = buildDialogueTimeline({
  session: { id: 'dlg_merge', status: 'drafting_application', intent: 'application_generation' },
  messages: [],
  child: {
    messages: [
      { id: 'm1', role: 'agent', kind: 'thinking', content: 'RAWTHINK 识别为后勤管理类应用' },
      { id: 'm2', role: 'agent', kind: 'analysis_work_log', content: 'THEANALYSIS 识别为后勤管理类应用，推荐物资调度模式' },
    ],
  },
})
const mergeTypes = mergeItems.map(i => i.type)
assert.equal(mergeTypes.includes('thinking_summary'), false, '思考摘要 block must merge away when 分析过程 exists for the round')
const mergedAnalysis = mergeItems.find(i => i.type === 'analysis_stream')
assert.equal(!!mergedAnalysis, true, '分析过程 block must render for the round')
assert.equal(mergedAnalysis.content.includes('THEANALYSIS'), true, '分析过程 carries the comprehensive analysis text')
assert.equal(!!(mergedAnalysis.rawThinking && mergedAnalysis.rawThinking.includes('RAWTHINK')), true, '原始思考过程 must attach to 分析过程 as rawThinking')
// ConversationWorkbench must surface the session error (not just "已失败").
assert.equal(workbenchSrc.includes('describeSessionError'), true, 'ConversationWorkbench must render the session error via describeSessionError')
assert.equal(workbenchSrc.includes('cw-session-error'), true, 'ConversationWorkbench must render a session-error block')

// ---- Item 3: aggregate card polish (breathing, 正在… phase, function tooltip) ----
// The pinned overview must match the execution graph's polish: the active
// running card breathes via cegOrchestratePulse, a 正在… phase hint shows the
// live action, the tooltip describes what the card DOES (not the live action),
// and a running production card surfaces its current sub-agent name + action +
// sub-agent function description.
assert.equal(aggregateGraphSrc.includes('CARD_DESCRIPTIONS'), true, 'aggregate graph must carry a CARD_DESCRIPTIONS function-description map')
assert.equal(aggregateGraphSrc.includes('SUBAGENT_DESCRIPTIONS'), true, 'aggregate graph must carry a SUBAGENT_DESCRIPTIONS map for running production sub-agents')
assert.equal(aggregateGraphSrc.includes('ceg-orchestration-phase'), true, 'aggregate graph must render the 正在… phase via the shared .ceg-orchestration-phase span')
assert.equal(css.includes('cegOrchestratePulse'), true, 'aggregate CSS must wire the purple cegOrchestratePulse breathing on the active running card')
assert.equal(css.includes('.aog .ceg-card.ceg-card-state-running.is-active::before'), true, 'aggregate CSS must override the active running card ::before to the breathing pulse')
assert.equal(css.includes('prefers-reduced-motion'), true, 'aggregate CSS breathing must be reduced-motion-guarded')
// The tooltip for a running production card is the CURRENT sub-agent function
// description; for other cards it is the card function description (NOT the live
// action). Drive a running production step end-to-end through the view builder.
const item3Production = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_i3', status: 'task_running', intent: 'application_generation' }, messages: [{ id: 'u', role: 'user', kind: 'prompt', content: '生成系统' }] },
  jobStepBlocks: [
    { stepId: 'r', kind: 'requirement_analysis', agentKey: 'requirement-analyst', status: 'succeeded', summary: '需求完成' },
    { stepId: 'd', kind: 'design_contract', agentKey: 'designer', status: 'succeeded', summary: '界面完成' },
    { stepId: 'x', kind: 'data_integration', agentKey: 'data-integration', status: 'succeeded', summary: '数据契约完成' },
    { stepId: 'c', kind: 'code_generation', agentKey: 'code-generator', status: 'running', name: '代码生成', summary: '正在生成代码' },
  ],
})
const item3Card = item3Production.cardsByKey.production_delivery
assert.equal(item3Card.state, 'running')
assert.equal(item3Card.subStage, '代码生成', 'running production card must surface the sub-agent name as subStage')
assert.equal(item3Card.currentAction.includes('生成'), true, 'running production card currentAction must mention the sub-agent verb (生成)')

console.log('check-workbench-orchestration-adjustment: ok')
