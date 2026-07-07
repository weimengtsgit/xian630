# Conversation Workbench Orchestration Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the leader-review conversation workbench experience for `sf-portal-mvp`: a fixed aggregate orchestration graph, serialized clarification blocks, attachment-aware conversation input, artifact previews, data fallback confirmations, and production-delivery aggregation.

**Architecture:** Keep the internal collaboration plan, job steps, audit trail, and project-document projection stable. Add a workbench projection layer that maps existing machine steps into the four user-facing aggregate cards, then extend backend contracts only where the spec needs new durable data: session attachments, early project documents, interface preview snapshots, data contract metadata, and controlled credential references. The UI consumes semantic timeline/view-model objects rather than deriving behavior from raw step JSON.

**Tech Stack:** Go, SQLite, `net/http`, SSE, React 18, Vite, Node assertion scripts, existing Factory executor/projectdocs/runner packages.

---

## Scope Boundary

This plan targets `sf-portal-mvp` and `factory-server`. It does not change the demo-only `sf-portal` project, does not build the collaboration-agent library page, and does not add custom collaboration-agent CRUD or custom-agent launching. Existing machine agent keys remain stable; only the workbench projection labels change.

## File Structure

### Backend

- Modify `factory-server/internal/model/model.go`
  - Add dialogue attachment models.
  - Add attachment reference models.
  - Add workbench artifact metadata models for project docs, interface preview snapshots, and data contracts.
  - Add ephemeral credential reference metadata. Raw credential values are not persisted.

- Modify `factory-server/internal/store/schema.sql`
  - Add `dialogue_attachments`, `dialogue_attachment_refs`, `workbench_artifact_refs`, and `ephemeral_credential_refs` metadata tables. Raw credential values are not persisted.

- Create `factory-server/internal/store/dialogue_attachments.go`
  - CRUD for attachment rows and message references.
  - Reference deactivation without hard deletion.

- Create `factory-server/internal/store/workbench_artifacts.go`
  - CRUD for interface preview snapshots, data contracts, and aggregate artifact refs.

- Existing migration path:
  - New tables are created through `schema.sql` on `store.Open`.
  - Do not add `ensureColumn` for newly introduced tables in this plan; add explicit `ensureColumn` only if a later task adds columns to tables that may already exist in user databases.

- Create `factory-server/internal/security/redaction.go`
  - Shared redaction for bearer tokens, API keys, passwords, authorization headers, and credential payloads.

- Create `factory-server/internal/server/test_helpers_test.go`
  - Shared server-test helpers for this plan: `newTestServerWithStore`, `testCtx`, and `testNow`.

- Create `factory-server/internal/server/attachment_handlers.go`
  - Multipart upload for dialogue attachments.
  - Attachment preview endpoints.
  - Reference deactivation endpoint.

- Create `factory-server/internal/server/workbench_artifact_handlers.go`
  - Job/dialogue project-document preview endpoints.
  - Interface preview raw/snapshot endpoints with safe MIME and CSP.

- Modify `factory-server/internal/server/server.go`
  - Register attachment and workbench artifact routes.
  - Add the in-process, short-lived credential secret registry field.
  - Wire the server as the credential resolver for the data-capture runner path.

- Create `factory-server/internal/server/credential_secrets.go`
  - Store plaintext credentials only in memory behind opaque handles.
  - Resolve handles for authorized data-verification execution only.

- Modify `factory-server/internal/server/dialogue_handlers.go`
  - Accept multipart first-message and follow-up message submission.
  - Persist attachment refs on submitted user messages.
  - Include attachment refs and workbench artifacts in `dialogueView`.
  - Preserve the existing JSON path for no-attachment messages.

- Modify `factory-server/internal/server/job_handlers.go`
  - Include attachment refs in task answers where the current focus owns them.
  - Expose job project document metadata for workbench preview.
  - Accept controlled credential handles in task answers without persisting plaintext secrets.

- Modify `factory-server/internal/projectdocs/generator.go`
  - Support early document projection into `generated-apps/<job.AppSlug>` before code generation registers an application.

- Modify `factory-server/internal/runner/contracts.go`
  - Add requirement-summary consistency metadata checks.
  - Add design-contract and data-integration contract decoders used by executor artifact projection.
  - Add `Question.InputType` so credential clarification questions can render as controlled credential input.

- Modify `factory-server/internal/executor/claude_runner.go`
  - Persist workbench artifact refs after requirement, design, data, and solution steps succeed.
  - Emit artifact summary traces that the workbench can fold into aggregate cards.
  - Keep raw thinking out of work traces and project documents.
  - Inject verified credential handles, not plaintext secrets, into data-capture input.

### Frontend

- Create `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`
  - Pure aggregate orchestration view-model builder.
  - Maps internal plan/job steps into `用户输入`, `业务逻辑`, `界面解析`, `数据抓取`, `生产交付`.

- Create `sf-portal-mvp/src/components/AggregateOrchestrationGraph.jsx`
  - Fixed top graph with five cards and the spec flow:
    `用户输入 -> 业务逻辑 -> 界面解析 -> 生产交付` and `业务逻辑 -> 数据抓取 -> 生产交付`.

- Create `sf-portal-mvp/src/components/AggregateOrchestrationGraph.css`
  - Grey initial states, pulse/breathing active states, compact bar, mobile horizontal graph.

- Create `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`
  - Shared expanded/folded block for `业务逻辑`, `界面解析`, `数据抓取`, and `生产交付`.

- Create `sf-portal-mvp/src/components/WorkbenchTracks.jsx`
  - `BusinessLogicAnalysisTrack`.
  - `InterfaceCompositionTrack`.
  - `DataFlowValidationTrack`.
  - `ProductionDeliveryTrack`.

- Create `sf-portal-mvp/src/hooks/useSessionAttachments.js`
  - Composer file selection/upload state.
  - Existing-dialogue upload and first-message multipart submission support.

- Create `sf-portal-mvp/src/components/AttachmentComposer.jsx`
  - Pending attachment thumbnails/file chips with remove actions.

- Create `sf-portal-mvp/src/components/AttachmentPreviewModal.jsx`
  - Image, text, Markdown, JSON, CSV, PDF, and metadata-only previews.

- Create `sf-portal-mvp/src/components/ProjectDocumentPreviewModal.jsx`
  - Read-only rich Markdown preview for task-owned project documents.

- Create `sf-portal-mvp/src/components/InterfacePreviewModal.jsx`
  - Static HTML/screenshot/manifest preview for interface artifacts.

- Modify `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
  - Replace the empty marketing copy with grey initial aggregate graph plus composer.
  - Render the aggregate graph fixed above the conversation body.
  - Render typed agent blocks and artifact links.
  - Wire attachment composer and preview modals.

- Modify `sf-portal-mvp/src/components/ConversationWorkbench.css`
  - Layout for fixed graph, compact bar, block tracks, artifact links, and composer attachments.

- Modify `sf-portal-mvp/src/hooks/dialogueTimeline.js`
  - Add semantic timeline item types for aggregate agent blocks, attachment references, artifact links, and production delivery summaries.

- Modify `sf-portal-mvp/src/hooks/useDialogueSessions.js`
  - Load attachment refs and workbench artifacts from dialogue view.
  - Pass files to `factoryApi.createDialogue` and `factoryApi.sendDialogueMessage`.

- Modify `sf-portal-mvp/src/api/client.js`
  - Add multipart request helpers.
  - Add attachment, document preview, and interface preview endpoints.

- Create `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`
  - Pure Node assertions for aggregate graph, serialized clarification focus, attachment references, artifact link projection, and production aggregation.

## Task 0: Shared Test Harness Baseline

**Files:**
- Create: `factory-server/internal/server/test_helpers_test.go`
- Verify: `factory-server/internal/server/app_handlers_test.go`
- Verify: `factory-server/internal/store/store_test.go`

- [x] **Step 1: Add shared server test helpers**

Create `factory-server/internal/server/test_helpers_test.go`:

```go
package server

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

func newTestServerWithStore(t *testing.T) (*Server, *Router, string) {
	t.Helper()
	root := t.TempDir()
	writeServerCatalog(t, root, `{"version":1,"scenes":{"east-sea-situation":{"surface":"application","order":1}}}`)
	writeServerSceneManifest(t, root, "east-sea-situation")

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	if err := st.UpsertApplication(context.Background(), seedApp()); err != nil {
		t.Fatalf("seed app: %v", err)
	}

	cfg := config.Config{
		WorkspaceRoot: root,
		ArtifactRoot: filepath.Join(root, ".factory", "artifacts"),
	}
	srv := New(cfg, st, scanner.Scanner{})
	return srv, srv.routes(), root
}

func testCtx() context.Context {
	return context.Background()
}

func testNow() time.Time {
	return time.UnixMilli(1700000000000)
}
```

- [x] **Step 2: Verify server helper compiles**

Run:

```bash
go test ./factory-server/internal/server -run TestListApplications -count=1
```

Expected: pass.

- [x] **Step 3: Use the existing store helper name in later tests**

When writing store tests in this plan, use the existing helper from `factory-server/internal/store/store_test.go`:

```go
st := newTestStore(t)
```

For store-package tests, use the existing `newTestStore(t)` helper.

- [x] **Step 4: Commit**

```bash
git add factory-server/internal/server/test_helpers_test.go
git commit -m "test: add shared server test helpers"
```

## Task 1: Pure Aggregate Orchestration View Model

**Files:**
- Create: `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`
- Test: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`
- Modify: `sf-portal-mvp/package.json`

- [x] **Step 1: Create the failing Node check**

Add this file:

```js
// sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
import assert from 'node:assert/strict'
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
console.log('check-workbench-orchestration-adjustment: ok')
```

- [x] **Step 2: Run the failing check**

Run:

```bash
node sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
```

Expected: it fails with `Cannot find module '../src/hooks/workbenchOrchestrationState.js'`.

- [x] **Step 3: Implement the pure view model**

Create `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`:

```js
export const AGGREGATE_CARD_KEYS = ['user_input', 'business_logic', 'interface_parsing', 'data_capture', 'production_delivery']

const CARD_LABELS = {
  user_input: '用户输入',
  business_logic: '业务逻辑',
  interface_parsing: '界面解析',
  data_capture: '数据抓取',
  production_delivery: '生产交付',
}

const AGENT_TO_CARD = {
  '__user_input__': 'user_input',
  'requirement-analyst': 'business_logic',
  'domain-analyst': 'business_logic',
  designer: 'interface_parsing',
  'data-integration': 'data_capture',
  'solution-designer': 'production_delivery',
  'code-generator': 'production_delivery',
  'code-reviewer': 'production_delivery',
  'security-reviewer': 'production_delivery',
  tester: 'production_delivery',
  'product-acceptance': 'production_delivery',
  'image-builder': 'production_delivery',
  deployer: 'production_delivery',
}

const KIND_TO_CARD = {
  requirement_analysis: 'business_logic',
  domain_analysis: 'business_logic',
  design_contract: 'interface_parsing',
  data_integration: 'data_capture',
  solution_design: 'production_delivery',
  code_generation: 'production_delivery',
  code_review: 'production_delivery',
  security_review: 'production_delivery',
  test_verification: 'production_delivery',
  product_acceptance: 'production_delivery',
  image_build: 'production_delivery',
  deployment: 'production_delivery',
}

const PRODUCTION_STAGE_LABELS = {
  solution_design: '方案设计',
  code_generation: '代码生成',
  code_review: '代码审查',
  security_review: '安全审查',
  test_verification: '测试验证',
  product_acceptance: '产品验收',
  image_build: '镜像构建',
  deployment: '部署',
}

const BASE_EDGES = [
  ['user_input', 'business_logic'],
  ['business_logic', 'interface_parsing'],
  ['business_logic', 'data_capture'],
  ['interface_parsing', 'production_delivery'],
  ['data_capture', 'production_delivery'],
]

export function aggregateCardLabel(agentOrCardKey) {
  const cardKey = AGENT_TO_CARD[agentOrCardKey] || KIND_TO_CARD[agentOrCardKey] || agentOrCardKey
  return CARD_LABELS[cardKey] || agentOrCardKey || ''
}

export function buildWorkbenchOrchestrationView({ view, workTraceItems = [], jobStepBlocks = [] } = {}) {
  const cards = AGGREGATE_CARD_KEYS.map(key => ({
    key,
    label: CARD_LABELS[key],
    state: 'not_started',
    active: false,
    currentAction: '',
    subStage: '',
    summary: '',
    artifacts: artifactsForCard(view, key),
    steps: [],
  }))
  const cardsByKey = Object.fromEntries(cards.map(card => [card.key, card]))
  const hasUserInput = !!(view && Array.isArray(view.messages) && view.messages.some(msg => msg && msg.role === 'user'))
  if (hasUserInput) {
    cardsByKey.user_input.state = 'confirmed'
    cardsByKey.business_logic.state = 'ready'
  }

  const steps = Array.isArray(jobStepBlocks) ? jobStepBlocks.filter(Boolean) : []
  for (const step of steps) {
    const cardKey = cardKeyForStep(step)
    const card = cardsByKey[cardKey]
    if (!card) continue
    card.steps.push(step)
  }

  for (const key of ['business_logic', 'interface_parsing', 'data_capture']) {
    const card = cardsByKey[key]
    const state = aggregateAnalysisState(card.steps)
    card.state = state
    card.currentAction = latestStepSummary(card.steps, workTraceItems)
    card.summary = latestTerminalSummary(card.steps)
  }
  const production = cardsByKey.production_delivery
  const prod = aggregateProductionState(production.steps)
  production.state = prod.state
  production.subStage = prod.subStage
  production.currentAction = latestStepSummary(production.steps, workTraceItems)
  production.summary = latestTerminalSummary(production.steps)

  applyUpstreamWaiting(cardsByKey)
  const activeCardKey = firstActiveCardKey(cards)
  if (activeCardKey) cardsByKey[activeCardKey].active = true
  const edges = BASE_EDGES.map(([from, to]) => ({ from, to, state: edgeState(cardsByKey[from], cardsByKey[to]) }))

  return {
    cards,
    cardsByKey,
    edges,
    activeCardKey,
    focusQueue: ['business_logic', 'interface_parsing', 'data_capture', 'production_delivery'],
  }
}

function cardKeyForStep(step) {
  return KIND_TO_CARD[step.kind] || AGENT_TO_CARD[step.agentKey || step.agent_key] || ''
}

function aggregateAnalysisState(steps) {
  if (!steps.length) return 'not_started'
  if (steps.some(step => step.status === 'failed')) return 'failed'
  if (steps.some(step => step.status === 'waiting_user')) return 'waiting_user_clarification'
  if (steps.some(step => step.status === 'running')) return 'running'
  if (steps.some(step => step.status === 'pending' || step.status === 'queued')) return 'ready'
  if (steps.every(step => step.status === 'succeeded' || step.status === 'completed')) return 'confirmed'
  return 'ready'
}

function aggregateProductionState(steps) {
  if (!steps.length) return { state: 'not_started', subStage: '' }
  const failed = steps.find(step => step.status === 'failed')
  if (failed) return { state: productionFailureState(failed), subStage: stageName(failed) }
  const waiting = steps.find(step => step.status === 'waiting_user')
  if (waiting) return { state: 'waiting_user_confirmation', subStage: stageName(waiting) }
  const running = steps.find(step => step.status === 'running')
  if (running) return { state: 'running', subStage: stageName(running) }
  const ready = steps.find(step => step.status === 'pending' || step.status === 'queued')
  if (ready) return { state: 'ready', subStage: stageName(ready) }
  const skipped = steps.find(step => step.status === 'skipped')
  if (skipped) return { state: 'skipped', subStage: stageName(skipped) }
  if (steps.every(step => step.status === 'succeeded' || step.status === 'completed')) return { state: 'delivered', subStage: stageName(steps[steps.length - 1]) }
  return { state: 'ready', subStage: '' }
}

function productionFailureState(step) {
  const code = step.errorCode || step.error_code || ''
  if (code === 'blocking_review' || code === 'schema_validation_failed') return 'auto_repairing'
  return 'failed'
}

function stageName(step) {
  return step.name || PRODUCTION_STAGE_LABELS[step.kind] || step.agentKey || step.stepId || ''
}

function latestStepSummary(steps, traceItems) {
  const stepIds = new Set(steps.map(step => step.stepId || step.id).filter(Boolean))
  const traces = Array.isArray(traceItems) ? traceItems : []
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const item = traces[i]
    if (!item || !stepIds.has(item.stepId || item.step_id)) continue
    const payload = item.payload || {}
    const text = payload.summary || payload.message || payload.text || payload.description || ''
    if (text) return String(text)
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].summary) return String(steps[i].summary)
    if (steps[i].error) return String(steps[i].error)
  }
  return ''
}

function latestTerminalSummary(steps) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if ((step.status === 'succeeded' || step.status === 'completed') && step.summary) return String(step.summary)
  }
  return ''
}

function artifactsForCard(view, cardKey) {
  const artifacts = view && Array.isArray(view.workbenchArtifacts) ? view.workbenchArtifacts : []
  return artifacts
    .filter(item => item && item.cardKey === cardKey)
    .map(item => ({
      id: String(item.id || ''),
      kind: String(item.kind || ''),
      label: String(item.label || item.path || ''),
      path: String(item.path || ''),
      previewUrl: String(item.previewUrl || ''),
      status: String(item.status || 'active'),
    }))
}

function applyUpstreamWaiting(cardsByKey) {
  if (cardsByKey.user_input.state === 'not_started') {
    cardsByKey.business_logic.state = 'not_started'
    cardsByKey.interface_parsing.state = 'not_started'
    cardsByKey.data_capture.state = 'not_started'
    cardsByKey.production_delivery.state = 'not_started'
    return
  }
  if (cardsByKey.business_logic.state !== 'confirmed') {
    if (cardsByKey.interface_parsing.state === 'not_started') cardsByKey.interface_parsing.state = 'waiting_upstream'
    if (cardsByKey.data_capture.state === 'not_started') cardsByKey.data_capture.state = 'waiting_upstream'
    if (cardsByKey.production_delivery.state === 'not_started') cardsByKey.production_delivery.state = 'waiting_upstream'
    return
  }
  if (cardsByKey.interface_parsing.state !== 'confirmed') {
    if (cardsByKey.data_capture.state === 'not_started' || cardsByKey.data_capture.state === 'ready') cardsByKey.data_capture.state = 'waiting_upstream'
    if (cardsByKey.production_delivery.state === 'not_started' || cardsByKey.production_delivery.state === 'ready') cardsByKey.production_delivery.state = 'waiting_upstream'
    return
  }
  if (cardsByKey.interface_parsing.state !== 'confirmed' || cardsByKey.data_capture.state !== 'confirmed') {
    if (cardsByKey.production_delivery.state === 'not_started' || cardsByKey.production_delivery.state === 'ready') cardsByKey.production_delivery.state = 'waiting_upstream'
  }
}

function firstActiveCardKey(cards) {
  const order = ['user_input', 'business_logic', 'interface_parsing', 'data_capture', 'production_delivery']
  for (const key of order) {
    const card = cards.find(item => item.key === key)
    if (!card) continue
    if (['running', 'waiting_user_clarification', 'waiting_artifact_confirmation', 'waiting_user_confirmation', 'auto_repairing'].includes(card.state)) return key
  }
  const ready = cards.find(card => card.state === 'ready')
  return ready ? ready.key : ''
}

function edgeState(fromCard, toCard) {
  if (!fromCard || !toCard) return 'inactive'
  if (fromCard.state === 'failed' || toCard.state === 'failed') return 'blocked'
  if (fromCard.state === 'confirmed' || fromCard.state === 'delivered') {
    if (['running', 'waiting_user_clarification', 'waiting_user_confirmation', 'auto_repairing'].includes(toCard.state)) return 'flowing'
    if (toCard.state === 'confirmed' || toCard.state === 'delivered') return 'completed'
    if (toCard.state === 'ready') return 'flowing'
  }
  return 'inactive'
}
```

- [x] **Step 4: Register the script**

Modify `sf-portal-mvp/package.json` scripts:

```json
"check:workbench-orchestration": "node scripts/check-workbench-orchestration-adjustment.mjs"
```

- [x] **Step 5: Run the check**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected:

```text
check-workbench-orchestration-adjustment: ok
```

- [x] **Step 6: Commit**

```bash
git add sf-portal-mvp/src/hooks/workbenchOrchestrationState.js sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs sf-portal-mvp/package.json
git commit -m "feat: add workbench orchestration projection"
```

## Task 2: Aggregate Orchestration Graph Component

**Files:**
- Create: `sf-portal-mvp/src/components/AggregateOrchestrationGraph.jsx`
- Create: `sf-portal-mvp/src/components/AggregateOrchestrationGraph.css`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`

- [x] **Step 1: Extend the Node check with static UI invariants**

Append to `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`:

```js
import { readFileSync } from 'node:fs'

const graphSource = readFileSync(new URL('../src/components/AggregateOrchestrationGraph.jsx', import.meta.url), 'utf8')
assert.equal(graphSource.includes('协作编排'), false, 'aggregate graph must not render 协作编排 as a card')
for (const label of ['用户输入', '业务逻辑', '界面解析', '数据抓取', '生产交付']) {
  assert.equal(graphSource.includes(label), true, `graph source must render ${label}`)
}
const css = readFileSync(new URL('../src/components/AggregateOrchestrationGraph.css', import.meta.url), 'utf8')
assert.equal(css.includes('@media (prefers-reduced-motion: reduce)'), true, 'pulse motion must respect reduced motion')
assert.equal(css.includes('position: sticky'), true, 'graph must support fixed-in-workbench placement')
```

- [x] **Step 2: Run the failing check**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: fails because `AggregateOrchestrationGraph.jsx` is missing.

- [x] **Step 3: Create the graph component**

Create `sf-portal-mvp/src/components/AggregateOrchestrationGraph.jsx`:

```jsx
import { CheckCircle2, Circle, Clock3, FileCheck2, Loader2, PackageCheck, UserRound } from 'lucide-react'
import './AggregateOrchestrationGraph.css'

const ICONS = {
  user_input: UserRound,
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
    <section className="aog" aria-label="协作编排执行图">
      <header className="aog-head">
        <h3>协作编排执行图</h3>
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
```

- [x] **Step 4: Create the graph CSS**

Create `sf-portal-mvp/src/components/AggregateOrchestrationGraph.css`:

```css
.aog {
  position: sticky;
  top: 0;
  z-index: 4;
  border-bottom: 1px solid rgba(111, 218, 255, 0.18);
  background: rgba(9, 24, 38, 0.96);
  padding: 10px 12px;
}
.aog-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.aog-head h3 { margin: 0; color: #edfaff; font-size: 13px; }
.aog-head p { margin: 0; color: rgba(215, 238, 248, 0.68); font-size: 11px; }
.aog-canvas {
  position: relative;
  display: grid;
  grid-template-columns: minmax(92px, 1fr) minmax(118px, 1.15fr) minmax(118px, 1.15fr) minmax(118px, 1.15fr) minmax(124px, 1.2fr);
  grid-template-rows: auto auto;
  gap: 12px 16px;
  align-items: stretch;
}
.aog-card {
  min-height: 92px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 4px 7px;
  padding: 10px;
  border: 1px solid rgba(143, 176, 191, 0.24);
  border-radius: 8px;
  background: rgba(24, 39, 51, 0.82);
  color: rgba(215, 238, 248, 0.78);
}
.aog-card-user_input { grid-column: 1; grid-row: 1 / span 2; }
.aog-card-business_logic { grid-column: 2; grid-row: 1 / span 2; }
.aog-card-interface_parsing { grid-column: 3; grid-row: 1; }
.aog-card-data_capture { grid-column: 3; grid-row: 2; }
.aog-card-production_delivery { grid-column: 4 / span 2; grid-row: 1 / span 2; }
.aog-icon { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(143, 176, 191, 0.12); color: #8fb0bf; }
.aog-card strong { min-width: 0; color: #edfaff; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aog-card small { grid-column: 2; color: rgba(215, 238, 248, 0.62); font-size: 11px; }
.aog-card em { grid-column: 2; color: #68ddff; font-style: normal; font-size: 11px; }
.aog-card p { grid-column: 1 / -1; margin: 3px 0 0; color: rgba(215, 238, 248, 0.72); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
.aog-state-not_started { filter: grayscale(1); opacity: 0.68; }
.aog-state-waiting_upstream { opacity: 0.76; }
.aog-state-ready { border-color: rgba(104, 221, 255, 0.3); }
.aog-state-running, .aog-state-auto_repairing {
  border-color: rgba(104, 221, 255, 0.74);
  box-shadow: 0 0 0 1px rgba(104, 221, 255, 0.18), 0 0 18px rgba(104, 221, 255, 0.22);
  animation: aogPulse 1.55s ease-in-out infinite;
}
.aog-state-waiting_user_clarification, .aog-state-waiting_artifact_confirmation, .aog-state-waiting_user_confirmation {
  border-color: rgba(243, 199, 97, 0.62);
  background: rgba(45, 34, 12, 0.62);
}
.aog-state-confirmed, .aog-state-delivered { border-color: rgba(126, 231, 135, 0.54); background: rgba(20, 64, 50, 0.48); }
.aog-state-failed { border-color: rgba(255, 102, 94, 0.62); background: rgba(67, 22, 30, 0.62); }
.aog-edge { display: none; }
.aog-spin { animation: aogSpin 1s linear infinite; }
.aog-compact { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border: 0; border-bottom: 1px solid rgba(111, 218, 255, 0.18); background: rgba(9, 24, 38, 0.96); color: #edfaff; cursor: pointer; }
.aog-compact em { color: #68ddff; font-style: normal; font-size: 11px; }
@keyframes aogPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.012); } }
@keyframes aogSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@media (max-width: 860px) {
  .aog-canvas { display: flex; overflow-x: auto; gap: 8px; }
  .aog-card { flex: 0 0 148px; min-height: 88px; }
}
@media (prefers-reduced-motion: reduce) {
  .aog-state-running, .aog-state-auto_repairing, .aog-spin { animation: none !important; }
}
```

- [x] **Step 5: Wire the graph into the workbench**

Modify `sf-portal-mvp/src/components/ConversationWorkbench.jsx` imports:

```jsx
import { AggregateOrchestrationGraph } from './AggregateOrchestrationGraph'
import { buildWorkbenchOrchestrationView } from '../hooks/workbenchOrchestrationState'
```

Inside `ConversationWorkbench`, add:

```jsx
const aggregateGraph = useMemo(() => buildWorkbenchOrchestrationView({
  view,
  workTraceItems: traceItems,
  jobStepBlocks: traceSteps,
}), [view, traceItems, traceSteps])
```

Render it between the header and `.cw-body`:

```jsx
<AggregateOrchestrationGraph graph={aggregateGraph} />
```

Delete the old empty-state JSX inside `.cw-body`:

```jsx
{timeline.length === 0 && traceItems.length === 0 ? (
  <div className="cw-empty">输入需求后，将自动识别是复用已有智能体，还是生成新智能体。</div>
) : null}
```

The aggregate graph now supplies the initial empty-workbench signal. Do not render replacement marketing copy in `.cw-body`.

- [x] **Step 6: Run the check**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected:

```text
check-workbench-orchestration-adjustment: ok
```

- [x] **Step 7: Run the existing dialogue check**

Run:

```bash
node sf-portal-mvp/scripts/check-dialogue-workbench.mjs
```

Expected: no assertion failure.

- [x] **Step 8: Commit**

```bash
git add sf-portal-mvp/src/components/AggregateOrchestrationGraph.jsx sf-portal-mvp/src/components/AggregateOrchestrationGraph.css sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
git commit -m "feat: show aggregate orchestration graph in workbench"
```

## Task 3: Backend Session Attachments

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Create: `factory-server/internal/store/dialogue_attachments.go`
- Test: `factory-server/internal/store/dialogue_attachments_test.go`
- Create: `factory-server/internal/server/attachment_handlers.go`
- Test: `factory-server/internal/server/attachment_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`

- [x] **Step 1: Add store tests**

Create `factory-server/internal/store/dialogue_attachments_test.go`:

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestDialogueAttachmentsReferenceLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.UnixMilli(1700000000000)
	att := model.DialogueAttachment{
		ID: "att_1", DialogueID: "dlg_1", FocusKey: "business_logic",
		OriginalName: "requirements.md", StoredPath: "dialogue-attachments/dlg_1/att_1/requirements.md",
		Mime: "text/markdown", Extension: ".md", SizeBytes: 128, SHA256: "sha256:abc",
		PreviewKind: model.AttachmentPreviewMarkdown, Status: model.AttachmentStatusActive,
		CreatedAt: now,
	}
	if err := st.CreateDialogueAttachment(ctx, att); err != nil {
		t.Fatalf("CreateDialogueAttachment: %v", err)
	}
	ref := model.DialogueAttachmentRef{
		ID: "aref_1", DialogueID: "dlg_1", MessageID: "dmsg_1", AttachmentID: "att_1",
		FocusKey: "business_logic", Active: true, CreatedAt: now,
	}
	if err := st.CreateDialogueAttachmentRef(ctx, ref); err != nil {
		t.Fatalf("CreateDialogueAttachmentRef: %v", err)
	}
	refs, err := st.ListDialogueAttachmentRefs(ctx, "dlg_1")
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs: %v", err)
	}
	if len(refs) != 1 || refs[0].Attachment.OriginalName != "requirements.md" || !refs[0].Active {
		t.Fatalf("refs = %#v", refs)
	}
	if err := st.DeactivateDialogueAttachmentRef(ctx, "dlg_1", "aref_1", now.Add(time.Minute)); err != nil {
		t.Fatalf("DeactivateDialogueAttachmentRef: %v", err)
	}
	refs, err = st.ListDialogueAttachmentRefs(ctx, "dlg_1")
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs after deactivate: %v", err)
	}
	if len(refs) != 1 || refs[0].Active {
		t.Fatalf("deactivated ref must stay visible but inactive: %#v", refs)
	}
}
```

- [x] **Step 2: Run the failing store test**

Run:

```bash
go test ./factory-server/internal/store -run TestDialogueAttachmentsReferenceLifecycle -count=1
```

Expected: fails because attachment types and store methods do not exist.

- [x] **Step 3: Add model structs**

Modify `factory-server/internal/model/model.go`:

```go
type AttachmentStatus string

const (
	AttachmentStatusActive      AttachmentStatus = "active"
	AttachmentStatusDeactivated AttachmentStatus = "deactivated"
)

type AttachmentPreviewKind string

const (
	AttachmentPreviewImage    AttachmentPreviewKind = "image"
	AttachmentPreviewMarkdown AttachmentPreviewKind = "markdown"
	AttachmentPreviewText     AttachmentPreviewKind = "text"
	AttachmentPreviewJSON     AttachmentPreviewKind = "json"
	AttachmentPreviewCSV      AttachmentPreviewKind = "csv"
	AttachmentPreviewPDF      AttachmentPreviewKind = "pdf"
	AttachmentPreviewMetadata AttachmentPreviewKind = "metadata"
	AttachmentPreviewBlocked  AttachmentPreviewKind = "blocked"
)

type DialogueAttachment struct {
	ID           string                `json:"id"`
	DialogueID   string                `json:"dialogue_id"`
	FocusKey     string                `json:"focus_key"`
	OriginalName string                `json:"original_name"`
	StoredPath   string                `json:"stored_path,omitempty"`
	Mime         string                `json:"mime"`
	Extension    string                `json:"extension"`
	SizeBytes    int64                 `json:"size_bytes"`
	SHA256       string                `json:"sha256"`
	PreviewKind  AttachmentPreviewKind `json:"preview_kind"`
	Status       AttachmentStatus      `json:"status"`
	CreatedAt    time.Time             `json:"created_at"`
	DeactivatedAt *time.Time           `json:"deactivated_at,omitempty"`
}

type DialogueAttachmentRef struct {
	ID           string             `json:"id"`
	DialogueID   string             `json:"dialogue_id"`
	MessageID    string             `json:"message_id"`
	AttachmentID string             `json:"attachment_id"`
	FocusKey     string             `json:"focus_key"`
	Active       bool               `json:"active"`
	CreatedAt    time.Time          `json:"created_at"`
	DeactivatedAt *time.Time        `json:"deactivated_at,omitempty"`
	Attachment   DialogueAttachment `json:"attachment"`
}
```

- [x] **Step 4: Add schema**

Modify `factory-server/internal/store/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS dialogue_attachments (
    id             TEXT    PRIMARY KEY,
    dialogue_id    TEXT    NOT NULL,
    focus_key      TEXT    NOT NULL DEFAULT '',
    original_name  TEXT    NOT NULL,
    stored_path    TEXT    NOT NULL DEFAULT '',
    mime           TEXT    NOT NULL DEFAULT '',
    extension      TEXT    NOT NULL DEFAULT '',
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    sha256         TEXT    NOT NULL DEFAULT '',
    preview_kind   TEXT    NOT NULL DEFAULT 'metadata',
    status         TEXT    NOT NULL DEFAULT 'active',
    created_at     INTEGER NOT NULL,
    deactivated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dialogue_attachments_dialogue
ON dialogue_attachments(dialogue_id, created_at);

CREATE TABLE IF NOT EXISTS dialogue_attachment_refs (
    id             TEXT    PRIMARY KEY,
    dialogue_id    TEXT    NOT NULL,
    message_id     TEXT    NOT NULL,
    attachment_id  TEXT    NOT NULL,
    focus_key      TEXT    NOT NULL DEFAULT '',
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    deactivated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dialogue_attachment_refs_dialogue
ON dialogue_attachment_refs(dialogue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dialogue_attachment_refs_message
ON dialogue_attachment_refs(message_id, created_at);
```

- [x] **Step 5: Implement store methods**

Create `factory-server/internal/store/dialogue_attachments.go` with methods:

```go
package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Store) CreateDialogueAttachment(ctx context.Context, a model.DialogueAttachment) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dialogue_attachments(id,dialogue_id,focus_key,original_name,stored_path,mime,extension,size_bytes,sha256,preview_kind,status,created_at,deactivated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.DialogueID, a.FocusKey, a.OriginalName, a.StoredPath, a.Mime, a.Extension, a.SizeBytes, a.SHA256,
		string(a.PreviewKind), string(a.Status), ms(a.CreatedAt), nullableMs(a.DeactivatedAt))
	return err
}

func (s *Store) GetDialogueAttachment(ctx context.Context, dialogueID, attachmentID string) (*model.DialogueAttachment, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,dialogue_id,focus_key,original_name,stored_path,mime,extension,size_bytes,sha256,preview_kind,status,created_at,deactivated_at FROM dialogue_attachments WHERE dialogue_id=? AND id=?`, dialogueID, attachmentID)
	return scanDialogueAttachment(row)
}

func (s *Store) CreateDialogueAttachmentRef(ctx context.Context, r model.DialogueAttachmentRef) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dialogue_attachment_refs(id,dialogue_id,message_id,attachment_id,focus_key,active,created_at,deactivated_at)
VALUES(?,?,?,?,?,?,?,?)`,
		r.ID, r.DialogueID, r.MessageID, r.AttachmentID, r.FocusKey, boolInt(r.Active), ms(r.CreatedAt), nullableMs(r.DeactivatedAt))
	return err
}

func (s *Store) ListDialogueAttachmentRefs(ctx context.Context, dialogueID string) ([]model.DialogueAttachmentRef, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT r.id,r.dialogue_id,r.message_id,r.attachment_id,r.focus_key,r.active,r.created_at,r.deactivated_at,
       a.id,a.dialogue_id,a.focus_key,a.original_name,a.stored_path,a.mime,a.extension,a.size_bytes,a.sha256,a.preview_kind,a.status,a.created_at,a.deactivated_at
FROM dialogue_attachment_refs r
JOIN dialogue_attachments a ON a.id = r.attachment_id
WHERE r.dialogue_id=?
ORDER BY r.created_at ASC`, dialogueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.DialogueAttachmentRef
	for rows.Next() {
		var r model.DialogueAttachmentRef
		var active int
		var created, attCreated int64
		var deactivated, attDeactivated sql.NullInt64
		var preview, status string
		if err := rows.Scan(&r.ID, &r.DialogueID, &r.MessageID, &r.AttachmentID, &r.FocusKey, &active, &created, &deactivated,
			&r.Attachment.ID, &r.Attachment.DialogueID, &r.Attachment.FocusKey, &r.Attachment.OriginalName, &r.Attachment.StoredPath,
			&r.Attachment.Mime, &r.Attachment.Extension, &r.Attachment.SizeBytes, &r.Attachment.SHA256, &preview, &status, &attCreated, &attDeactivated); err != nil {
			return nil, err
		}
		r.Active = active == 1
		r.CreatedAt = time.UnixMilli(created)
		r.DeactivatedAt = timePtrFromNull(deactivated)
		r.Attachment.PreviewKind = model.AttachmentPreviewKind(preview)
		r.Attachment.Status = model.AttachmentStatus(status)
		r.Attachment.CreatedAt = time.UnixMilli(attCreated)
		r.Attachment.DeactivatedAt = timePtrFromNull(attDeactivated)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) DeactivateDialogueAttachmentRef(ctx context.Context, dialogueID, refID string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE dialogue_attachment_refs SET active=0,deactivated_at=? WHERE dialogue_id=? AND id=?`, ms(now), dialogueID, refID)
	return err
}

type rowScanner interface{ Scan(dest ...any) error }

func scanDialogueAttachment(row rowScanner) (*model.DialogueAttachment, error) {
	var a model.DialogueAttachment
	var created int64
	var deactivated sql.NullInt64
	var preview, status string
	if err := row.Scan(&a.ID, &a.DialogueID, &a.FocusKey, &a.OriginalName, &a.StoredPath, &a.Mime, &a.Extension, &a.SizeBytes, &a.SHA256, &preview, &status, &created, &deactivated); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	a.PreviewKind = model.AttachmentPreviewKind(preview)
	a.Status = model.AttachmentStatus(status)
	a.CreatedAt = time.UnixMilli(created)
	a.DeactivatedAt = timePtrFromNull(deactivated)
	return &a, nil
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func timePtrFromNull(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := time.UnixMilli(v.Int64)
	return &t
}
```

- [x] **Step 6: Run store tests**

Run:

```bash
go test ./factory-server/internal/store -run DialogueAttachments -count=1
```

Expected: pass.

- [x] **Step 7: Add server handler tests**

Create `factory-server/internal/server/attachment_handlers_test.go`:

```go
package server

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestUploadDialogueAttachmentRejectsCredentials(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	_ = srv.store.CreateDialogueSession(testCtx(), model.DialogueSession{ID: "dlg_1", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	body, contentType := multipartBody(t, "file", "token.env", "API_KEY=secret\n", map[string]string{"focusKey": "data_capture"})
	req := httptest.NewRequest(http.MethodPost, "/api/dialogues/dlg_1/attachments", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "controlled credential input") {
		t.Fatalf("credential rejection message missing: %s", rec.Body.String())
	}
}

func TestUploadDialogueAttachmentStoresPreviewableFile(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	_ = srv.store.CreateDialogueSession(testCtx(), model.DialogueSession{ID: "dlg_2", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	body, contentType := multipartBody(t, "file", "requirements.md", "# 需求\n", map[string]string{"focusKey": "business_logic"})
	req := httptest.NewRequest(http.MethodPost, "/api/dialogues/dlg_2/attachments", body)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	refs, err := srv.store.ListDialogueAttachmentRefs(testCtx(), "dlg_2")
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs: %v", err)
	}
	if len(refs) != 0 {
		t.Fatalf("upload alone must not create message refs: %#v", refs)
	}
	files, _ := filepath.Glob(filepath.Join(srv.cfg.ArtifactRoot, "dialogue-attachments", "dlg_2", "*", "requirements.md"))
	if len(files) != 1 {
		t.Fatalf("stored file count = %d", len(files))
	}
}

func multipartBody(t *testing.T, field, filename, content string, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatalf("WriteField: %v", err)
		}
	}
	fw, err := w.CreateFormFile(field, filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write([]byte(content)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return &body, w.FormDataContentType()
}
```

- [x] **Step 8: Run the failing handler tests**

Run:

```bash
go test ./factory-server/internal/server -run DialogueAttachment -count=1
```

Expected: fails because routes and handlers do not exist.

- [x] **Step 9: Implement upload and preview handlers**

Create `factory-server/internal/server/attachment_handlers.go` with:

```go
package server

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

const maxDialogueAttachmentBytes = 10 * 1024 * 1024

func (s *Server) uploadDialogueAttachment(w http.ResponseWriter, r *http.Request) {
	dialogueID := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), dialogueID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "dialogue not found")
		return
	}
	if err := r.ParseMultipartForm(maxDialogueAttachmentBytes); err != nil {
		writeError(w, http.StatusBadRequest, "attachment too large")
		return
	}
	f, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing file")
		return
	}
	defer f.Close()
	name := safeAttachmentName(header.Filename)
	if looksLikeCredentialFile(name) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "credentials must use controlled credential input"})
		return
	}
	previewKind, ext, mimeType, ok := classifyAttachment(name, header.Header.Get("Content-Type"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported attachment type"})
		return
	}
	id := "att_" + idpkg.New()
	rel := filepath.ToSlash(filepath.Join("dialogue-attachments", dialogueID, id, name))
	full := filepath.Join(s.cfg.ArtifactRoot, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "create attachment dir")
		return
	}
	out, err := os.Create(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create attachment")
		return
	}
	defer out.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(f, maxDialogueAttachmentBytes+1))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "write attachment")
		return
	}
	if n > maxDialogueAttachmentBytes {
		_ = os.Remove(full)
		writeError(w, http.StatusBadRequest, "attachment too large")
		return
	}
	now := time.Now()
	att := model.DialogueAttachment{
		ID: id, DialogueID: dialogueID, FocusKey: r.FormValue("focusKey"),
		OriginalName: name, StoredPath: rel, Mime: mimeType, Extension: ext,
		SizeBytes: n, SHA256: "sha256:" + hex.EncodeToString(h.Sum(nil)),
		PreviewKind: previewKind, Status: model.AttachmentStatusActive, CreatedAt: now,
	}
	if err := s.store.CreateDialogueAttachment(r.Context(), att); err != nil {
		writeError(w, http.StatusInternalServerError, "save attachment")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"attachment": att})
}

func safeAttachmentName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.ReplaceAll(name, string(os.PathSeparator), "_")
	if name == "." || name == "" {
		return "attachment"
	}
	return name
}

func looksLikeCredentialFile(name string) bool {
	lower := strings.ToLower(name)
	for _, suffix := range []string{".env", ".pem", ".key", ".p12", ".pfx"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	for _, needle := range []string{"token", "password", "passwd", "secret", "apikey", "api-key"} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

func classifyAttachment(name, contentType string) (model.AttachmentPreviewKind, string, string, bool) {
	ext := strings.ToLower(filepath.Ext(name))
	mimeType := contentType
	if mimeType == "" {
		mimeType = mime.TypeByExtension(ext)
	}
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif":
		return model.AttachmentPreviewImage, ext, mimeType, true
	case ".md", ".markdown":
		return model.AttachmentPreviewMarkdown, ext, "text/markdown", true
	case ".txt", ".log":
		return model.AttachmentPreviewText, ext, "text/plain", true
	case ".json":
		return model.AttachmentPreviewJSON, ext, "application/json", true
	case ".csv":
		return model.AttachmentPreviewCSV, ext, "text/csv", true
	case ".pdf":
		return model.AttachmentPreviewPDF, ext, "application/pdf", true
	case ".doc", ".docx", ".xls", ".xlsx":
		return model.AttachmentPreviewMetadata, ext, mimeType, true
	default:
		return model.AttachmentPreviewBlocked, ext, mimeType, false
	}
}
```

- [x] **Step 10: Register routes**

Modify `factory-server/internal/server/server.go`:

```go
r.Handle("POST", "/api/dialogues/:id/attachments", s.uploadDialogueAttachment)
```

- [x] **Step 11: Run attachment tests**

Run:

```bash
go test ./factory-server/internal/store ./factory-server/internal/server -run DialogueAttachment -count=1
```

Expected: pass.

- [x] **Step 12: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/dialogue_attachments.go factory-server/internal/store/dialogue_attachments_test.go factory-server/internal/server/attachment_handlers.go factory-server/internal/server/attachment_handlers_test.go factory-server/internal/server/server.go
git commit -m "feat: add dialogue attachment storage"
```

## Task 4: Attachment Composer and Message References

**Files:**
- Create: `sf-portal-mvp/src/hooks/useSessionAttachments.js`
- Create: `sf-portal-mvp/src/components/AttachmentComposer.jsx`
- Create: `sf-portal-mvp/src/components/AttachmentPreviewModal.jsx`
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Test: `factory-server/internal/server/dialogue_handlers_test.go`
- Modify: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`

- [x] **Step 1: Add backend message-ref test**

Append to `factory-server/internal/server/dialogue_handlers_test.go`:

```go
func TestDialogueMessageCreatesAttachmentReferences(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	ctx := testCtx()
	_ = srv.store.CreateDialogueSession(ctx, model.DialogueSession{ID: "dlg_att", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration, RouteLocked: true})
	att := model.DialogueAttachment{
		ID: "att_msg", DialogueID: "dlg_att", FocusKey: "business_logic", OriginalName: "req.md",
		StoredPath: "dialogue-attachments/dlg_att/att_msg/req.md", Mime: "text/markdown", Extension: ".md",
		SizeBytes: 12, SHA256: "sha256:1", PreviewKind: model.AttachmentPreviewMarkdown, Status: model.AttachmentStatusActive, CreatedAt: time.Now(),
	}
	if err := srv.store.CreateDialogueAttachment(ctx, att); err != nil {
		t.Fatalf("CreateDialogueAttachment: %v", err)
	}
	body := strings.NewReader(`{"content":"补充需求","attachmentIds":["att_msg"]}`)
	req := httptest.NewRequest(http.MethodPost, "/api/dialogues/dlg_att/messages", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted && rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	refs, err := srv.store.ListDialogueAttachmentRefs(ctx, "dlg_att")
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs: %v", err)
	}
	if len(refs) != 1 || refs[0].AttachmentID != "att_msg" || refs[0].MessageID == "" {
		t.Fatalf("refs = %#v", refs)
	}
}
```

- [x] **Step 2: Run the failing backend test**

Run:

```bash
go test ./factory-server/internal/server -run TestDialogueMessageCreatesAttachmentReferences -count=1
```

Expected: fails because message body has no `attachmentIds` support.

- [x] **Step 3: Persist attachment refs in message handlers**

Modify the dialogue message body type in `factory-server/internal/server/dialogue_handlers.go`:

```go
type dialogueMessageBody struct {
	Content       string   `json:"content"`
	AttachmentIDs []string `json:"attachmentIds,omitempty"`
}
```

After the user message row is created in `addDialogueMessage`, call:

```go
if len(body.AttachmentIDs) > 0 {
	if err := s.createDialogueAttachmentRefs(ctx, id, msg.ID, body.AttachmentIDs, s.currentWorkbenchFocusKey(ctx, id)); err != nil {
		writeError(w, http.StatusBadRequest, "invalid attachment reference")
		return
	}
}
```

Add helpers in the same file:

```go
func (s *Server) createDialogueAttachmentRefs(ctx context.Context, dialogueID, messageID string, attachmentIDs []string, focusKey string) error {
	now := time.Now()
	seen := map[string]bool{}
	for _, attachmentID := range attachmentIDs {
		attachmentID = strings.TrimSpace(attachmentID)
		if attachmentID == "" || seen[attachmentID] {
			continue
		}
		seen[attachmentID] = true
		att, err := s.store.GetDialogueAttachment(ctx, dialogueID, attachmentID)
		if err != nil {
			return err
		}
		if att == nil || att.Status != model.AttachmentStatusActive {
			return fmt.Errorf("attachment %s unavailable", attachmentID)
		}
		ref := model.DialogueAttachmentRef{
			ID: "aref_" + idpkg.New(), DialogueID: dialogueID, MessageID: messageID,
			AttachmentID: attachmentID, FocusKey: focusKey, Active: true, CreatedAt: now,
		}
		if err := s.store.CreateDialogueAttachmentRef(ctx, ref); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) currentWorkbenchFocusKey(ctx context.Context, dialogueID string) string {
	jobs, err := s.store.ListJobsByDialogue(ctx, dialogueID)
	if err != nil || len(jobs) == 0 {
		return "business_logic"
	}
	job := jobs[len(jobs)-1]
	switch job.CurrentStepKind {
	case model.StepDesignContract:
		return "interface_parsing"
	case model.StepDataIntegration:
		return "data_capture"
	case model.StepSolutionDesign, model.StepCodeGeneration, model.StepCodeReview, model.StepSecurityReview, model.StepTestVerification, model.StepProductAcceptance, model.StepImageBuild, model.StepDeployment:
		return "production_delivery"
	default:
		return "business_logic"
	}
}
```

- [x] **Step 4: Run the backend test**

Run:

```bash
go test ./factory-server/internal/server -run TestDialogueMessageCreatesAttachmentReferences -count=1
```

Expected: pass.

- [x] **Step 5: Add frontend static checks**

Append to `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`:

```js
const clientSource = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
assert.equal(clientSource.includes('uploadDialogueAttachment'), true, 'client must expose uploadDialogueAttachment')
assert.equal(clientSource.includes('attachmentIds'), true, 'message send must carry attachmentIds')
const composerSource = readFileSync(new URL('../src/components/AttachmentComposer.jsx', import.meta.url), 'utf8')
assert.equal(composerSource.includes('X'), true, 'pending attachment chips must expose a remove icon')
assert.equal(composerSource.includes('input type="file"'), true, 'composer must include file input')
```

- [x] **Step 6: Run the failing frontend check**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: fails because attachment composer files are missing.

- [x] **Step 7: Add multipart client helpers**

Modify `sf-portal-mvp/src/api/client.js`:

```js
async function requestMultipart(path, formData) {
  const response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', body: formData })
  if (!response.ok) {
    const body = await response.text()
    const err = new Error(`${response.status} ${body}`)
    err.status = response.status
    err.bodyText = body
    throw err
  }
  return response.json()
}
```

Add methods:

```js
uploadDialogueAttachment(id, { file, focusKey }) {
  const form = new FormData()
  form.append('file', file)
  if (focusKey) form.append('focusKey', focusKey)
  return requestMultipart(`/api/dialogues/${id}/attachments`, form)
},
async sendDialogueMessage(id, content, options = {}) {
  const attachmentIds = Array.isArray(options.attachmentIds) ? options.attachmentIds : []
  const { status, body } = await requestWithStatus(
    `/api/dialogues/${id}/messages`,
    { method: 'POST', body: JSON.stringify({ content, attachmentIds }) },
  )
  if (status === 202) {
    if (body && body.view) return body.view
    return body || { dialogueId: id, turnId: null, acceptedAt: null, accepted: true }
  }
  return body
},
```

- [x] **Step 8: Add attachment hook**

Create `sf-portal-mvp/src/hooks/useSessionAttachments.js`:

```js
import { useCallback, useState } from 'react'
import { factoryApi } from '../api/client'

export function useSessionAttachments({ dialogueId, focusKey }) {
  const [pending, setPending] = useState([])
  const [uploading, setUploading] = useState(false)
  const addFiles = useCallback(async files => {
    const list = Array.from(files || [])
    if (!list.length) return []
    if (!dialogueId) {
      const local = list.map(file => ({ id: `local_${crypto.randomUUID()}`, file, name: file.name, status: 'local' }))
      setPending(prev => [...prev, ...local])
      return local
    }
    setUploading(true)
    try {
      const uploaded = []
      for (const file of list) {
        const res = await factoryApi.uploadDialogueAttachment(dialogueId, { file, focusKey })
        uploaded.push({ id: res.attachment.id, file, attachment: res.attachment, name: file.name, status: 'uploaded' })
      }
      setPending(prev => [...prev, ...uploaded])
      return uploaded
    } finally {
      setUploading(false)
    }
  }, [dialogueId, focusKey])
  const removePending = useCallback(id => setPending(prev => prev.filter(item => item.id !== id)), [])
  const clearPending = useCallback(() => setPending([]), [])
  const attachmentIds = pending.filter(item => item.attachment && item.attachment.id).map(item => item.attachment.id)
  return { pending, uploading, addFiles, removePending, clearPending, attachmentIds }
}
```

- [x] **Step 9: Add composer component**

Create `sf-portal-mvp/src/components/AttachmentComposer.jsx`:

```jsx
import { FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react'

export function AttachmentComposer({ items, uploading, onAddFiles, onRemove }) {
  return (
    <div className="cw-attachments">
      <label className="cw-attach-btn" title="添加附件">
        <Paperclip size={15} />
        <input type="file" multiple onChange={event => onAddFiles(event.target.files)} />
      </label>
      {items.map(item => (
        <span key={item.id} className="cw-attach-chip">
          {isImage(item) ? <ImageIcon size={14} /> : <FileText size={14} />}
          <span>{item.name}</span>
          <button type="button" onClick={() => onRemove(item.id)} title="移除附件" aria-label={`移除附件 ${item.name}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      {uploading ? <span className="cw-attach-uploading">上传中</span> : null}
    </div>
  )
}

function isImage(item) {
  const mime = item.attachment && item.attachment.mime || item.file && item.file.type || ''
  return mime.startsWith('image/')
}
```

- [x] **Step 10: Wire the composer**

Modify `ConversationWorkbench.jsx`:

```jsx
import { AttachmentComposer } from './AttachmentComposer'
import { useSessionAttachments } from '../hooks/useSessionAttachments'
```

Inside the component:

```jsx
const attachmentState = useSessionAttachments({
  dialogueId: session && session.id,
  focusKey: aggregateGraph.activeCardKey || 'business_logic',
})
```

Update submit:

```jsx
await onSend(value, { attachmentIds: attachmentState.attachmentIds, pendingAttachments: attachmentState.pending })
attachmentState.clearPending()
```

Render before `.cw-composer-row`:

```jsx
<AttachmentComposer
  items={attachmentState.pending}
  uploading={attachmentState.uploading}
  onAddFiles={attachmentState.addFiles}
  onRemove={attachmentState.removePending}
/>
```

- [x] **Step 11: Update `useDialogueSessions` send path**

Modify `useDialogueSessions.js` `send` callback signature so it accepts options:

```js
const send = useCallback(async (content, options = {}) => {
  const attachmentIds = Array.isArray(options.attachmentIds) ? options.attachmentIds : []
  ...
  const view = await factoryApi.sendDialogueMessage(id, content, { attachmentIds })
  ...
}, [...])
```

- [x] **Step 12: Pass attachment options through `App.jsx`**

Modify `sf-portal-mvp/src/App.jsx`:

```jsx
onSend={(prompt, options = {}) => {
  if (activeClarification) {
    return jobs.answerJob(activeClarification.taskId, prompt, {
      stepId: activeClarification.stepId,
      attempt: activeClarification.attempt,
      attachmentIds: options.attachmentIds || [],
    })
  }
  if (dialogue.focusTask && dialogue.focusTask.status === 'waiting_user') {
    return jobs.answerJob(dialogue.focusTask.id, prompt, { attachmentIds: options.attachmentIds || [] })
  }
  return dialogue.send(prompt, options)
}}
```

Append this static assertion to `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`:

```js
const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
assert.equal(appSource.includes('onSend={(prompt, options = {})'), true, 'App must preserve onSend options')
assert.equal(appSource.includes('dialogue.send(prompt, options)'), true, 'App must pass attachment options into dialogue.send')
```

- [x] **Step 13: Add CSS**

Append to `ConversationWorkbench.css`:

```css
.cw-attachments { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.cw-attach-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(111, 218, 255, 0.28); border-radius: 6px; color: #d7eef8; cursor: pointer; }
.cw-attach-btn input { display: none; }
.cw-attach-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 210px; padding: 4px 6px; border: 1px solid rgba(111, 218, 255, 0.22); border-radius: 6px; background: rgba(3, 17, 29, 0.66); color: #d7eef8; font-size: 11px; }
.cw-attach-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-attach-chip button { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; background: transparent; color: rgba(215, 238, 248, 0.7); cursor: pointer; }
.cw-attach-uploading { color: rgba(104, 221, 255, 0.72); font-size: 11px; }
```

- [x] **Step 14: Run checks**

Run:

```bash
go test ./factory-server/internal/server -run 'DialogueAttachment|TestDialogueMessageCreatesAttachmentReferences' -count=1
npm --prefix sf-portal-mvp run check:workbench-orchestration
node sf-portal-mvp/scripts/check-chat-input-sizing.mjs
```

Expected: all pass.

- [x] **Step 15: Commit**

```bash
git add factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/dialogue_handlers_test.go sf-portal-mvp/src/api/client.js sf-portal-mvp/src/hooks/useSessionAttachments.js sf-portal-mvp/src/components/AttachmentComposer.jsx sf-portal-mvp/src/components/AttachmentPreviewModal.jsx sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/src/App.jsx sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
git commit -m "feat: attach files to dialogue messages"
```

## Task 5: Early Project Documents and Rich Markdown Preview

**Files:**
- Modify: `factory-server/internal/projectdocs/generator.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Create: `factory-server/internal/server/workbench_artifact_handlers.go`
- Test: `factory-server/internal/server/workbench_artifact_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`
- Test: `factory-server/internal/server/dialogue_handlers_test.go`
- Create: `sf-portal-mvp/src/components/ProjectDocumentPreviewModal.jsx`
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`

- [x] **Step 1: Add backend test for job project document preview**

Create `factory-server/internal/server/workbench_artifact_handlers_test.go`:

```go
package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestJobProjectDocumentPreviewReadsEarlyGeneratedDoc(t *testing.T) {
	srv, router, root := newTestServerWithStore(t)
	ctx := testCtx()
	appDir := filepath.Join(root, "generated-apps", "leave-approval-a1")
	if err := os.MkdirAll(filepath.Join(appDir, "docs"), 0o755); err != nil {
		t.Fatalf("mkdir docs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "docs", "01-requirements.md"), []byte("# 需求文档\n\n已确认需求。\n"), 0o644); err != nil {
		t.Fatalf("write doc: %v", err)
	}
	job := model.Job{ID: "job_doc", AppSlug: "leave-approval-a1", AppName: "请假审批-A1", Status: model.JobStatusRunning, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/job_doc/project-docs/file?path=docs/01-requirements.md", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "已确认需求") {
		t.Fatalf("document content missing: %s", rec.Body.String())
	}
}
```

- [x] **Step 2: Run the failing test**

Run:

```bash
go test ./factory-server/internal/server -run TestJobProjectDocumentPreviewReadsEarlyGeneratedDoc -count=1
```

Expected: fails because `/api/jobs/:id/project-docs/file` is not registered.

- [x] **Step 3: Add early project root helper**

Modify `factory-server/internal/executor/claude_runner.go` `projectDocsAfterStep` fallback:

```go
if root == "" && job.AppSlug != "" {
	root = filepath.Join(c.Workspace, "generated-apps", filepath.FromSlash(job.AppSlug))
}
```

Before projecting, ensure docs metadata can exist:

```go
if root != "" {
	_ = os.MkdirAll(filepath.Join(root, "docs"), 0o755)
}
```

- [x] **Step 4: Add job document preview handler**

Create `factory-server/internal/server/workbench_artifact_handlers.go`:

```go
package server

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (s *Server) jobProjectDocumentFile(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.GetJob(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	root, ok := resolveJobProjectRoot(s.cfg.WorkspaceRoot, *job)
	if !ok {
		writeError(w, http.StatusNotFound, "project root not found")
		return
	}
	full, cleanRel, ok := resolveProjectFilePath(root, r.URL.Query().Get("path"))
	if !ok || !strings.HasPrefix(cleanRel, "docs/") || filepath.Ext(cleanRel) != ".md" {
		writeError(w, http.StatusForbidden, "unsupported project document path")
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "stat document")
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read document")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path": cleanRel,
		"name": filepath.Base(cleanRel),
		"kind": "markdown",
		"mime": mime.TypeByExtension(filepath.Ext(cleanRel)),
		"size": info.Size(),
		"content": string(data),
		"checksum": contentChecksum(data),
	})
}

func resolveJobProjectRoot(workspace string, job model.Job) (string, bool) {
	if job.AppSlug == "" {
		return "", false
	}
	root := filepath.Join(workspace, "generated-apps", filepath.FromSlash(job.AppSlug))
	if !strings.HasPrefix(filepath.Clean(root), filepath.Join(filepath.Clean(workspace), "generated-apps")+string(filepath.Separator)) {
		return "", false
	}
	return root, true
}
```

- [x] **Step 5: Register route**

Modify `factory-server/internal/server/server.go`:

```go
r.Handle("GET", "/api/jobs/:id/project-docs/file", s.jobProjectDocumentFile)
```

- [x] **Step 6: Run backend test**

Run:

```bash
go test ./factory-server/internal/server -run TestJobProjectDocumentPreviewReadsEarlyGeneratedDoc -count=1
```

Expected: pass.

- [x] **Step 7: Add confirmation-path AppSlug regression test**

Append to `factory-server/internal/server/dialogue_handlers_test.go`:

```go
func TestConfirmDialogueClarificationSeedsJobWithAppSlug(t *testing.T) {
	srv, router, _ := newTestServerWithStore(t)
	ctx := testCtx()
	dlg := model.DialogueSession{ID: "dlg_slug", Status: model.DialogueStatusDraftingApplication, Intent: model.DialogueIntentApplicationGeneration, RouteLocked: true, ClarificationSessionID: "clar_slug", CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateDialogueSession(ctx, dlg); err != nil {
		t.Fatalf("CreateDialogueSession: %v", err)
	}
	req := `{"appType":"operations_tool","appName":"请假审批","coreScenario":"提交和审批请假","primaryView":"审批工作台","targetUsers":["员工"],"mainEntities":["请假单"],"dataPolicy":"mock_data","acceptanceFocus":["可提交审批"]}`
	clar := model.ClarificationSession{ID: "clar_slug", Status: model.ClarificationStatusReadyToConfirm, InitialPrompt: "做请假审批", RequirementJSON: req, CreatedAt: testNow(), UpdatedAt: testNow()}
	if err := srv.store.CreateClarificationSession(ctx, clar); err != nil {
		t.Fatalf("CreateClarificationSession: %v", err)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/dialogues/dlg_slug/clarification/confirm", strings.NewReader(`{}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	jobs, err := srv.store.ListJobsByDialogue(ctx, "dlg_slug")
	if err != nil {
		t.Fatalf("ListJobsByDialogue: %v", err)
	}
	if len(jobs) != 1 || jobs[0].AppSlug == "" {
		t.Fatalf("confirmed dialogue must seed job with AppSlug for early project docs: %#v", jobs)
	}
}
```

- [x] **Step 8: Run confirmation-path test**

Run:

```bash
go test ./factory-server/internal/server -run TestConfirmDialogueClarificationSeedsJobWithAppSlug -count=1
```

Expected: pass. If it fails, set `job.AppSlug = factorySlug` before `SeedClarificationJobWithEdges` in `confirmDialogueClarification`.

- [x] **Step 9: Add frontend modal**

Create `sf-portal-mvp/src/components/ProjectDocumentPreviewModal.jsx`:

```jsx
import { X } from 'lucide-react'

export function ProjectDocumentPreviewModal({ document, onClose }) {
  if (!document) return null
  return (
    <div className="cw-doc-modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="cw-doc-modal" role="dialog" aria-modal="true" aria-label={document.path} onMouseDown={event => event.stopPropagation()}>
        <header>
          <strong>{document.path}</strong>
          <button type="button" onClick={onClose} aria-label="关闭预览"><X size={16} /></button>
        </header>
        <article className="cw-doc-rich">
          {renderMarkdown(document.content || '')}
        </article>
      </section>
    </div>
  )
}

function renderMarkdown(content) {
  const lines = String(content).split('\n')
  return lines.map((line, index) => {
    if (line.startsWith('# ')) return <h1 key={index}>{line.slice(2)}</h1>
    if (line.startsWith('## ')) return <h2 key={index}>{line.slice(3)}</h2>
    if (line.startsWith('### ')) return <h3 key={index}>{line.slice(4)}</h3>
    if (line.startsWith('- ')) return <p key={index} className="cw-doc-li">{line.slice(2)}</p>
    if (!line.trim()) return <br key={index} />
    return <p key={index}>{line}</p>
  })
}
```

- [x] **Step 10: Add client method**

Modify `sf-portal-mvp/src/api/client.js`:

```js
getJobProjectDocument: (jobId, path) =>
  request(`/api/jobs/${jobId}/project-docs/file?path=${encodeURIComponent(path)}`),
```

- [x] **Step 11: Wire modal into artifact links**

In `ConversationWorkbench.jsx`, add state:

```jsx
const [previewDocument, setPreviewDocument] = useState(null)
const openProjectDocument = async artifact => {
  if (!artifact || !artifact.jobId || !artifact.path) return
  const doc = await factoryApi.getJobProjectDocument(artifact.jobId, artifact.path)
  setPreviewDocument(doc)
}
```

Render:

```jsx
<ProjectDocumentPreviewModal document={previewDocument} onClose={() => setPreviewDocument(null)} />
```

- [x] **Step 12: Add modal CSS**

Append to `ConversationWorkbench.css`:

```css
.cw-doc-modal-layer { position: absolute; inset: 0; z-index: 32; display: flex; align-items: center; justify-content: center; padding: 18px; background: rgba(3, 11, 18, 0.64); }
.cw-doc-modal { width: min(760px, 100%); max-height: min(78vh, 760px); display: flex; flex-direction: column; border: 1px solid rgba(111, 218, 255, 0.26); border-radius: 8px; background: rgba(4, 18, 30, 0.98); }
.cw-doc-modal header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid rgba(111, 218, 255, 0.18); color: #edfaff; }
.cw-doc-modal header button { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: rgba(11, 29, 44, 0.72); color: #d7eef8; cursor: pointer; }
.cw-doc-rich { overflow: auto; padding: 16px 18px; color: #d7eef8; line-height: 1.62; }
.cw-doc-rich h1 { margin: 0 0 14px; font-size: 20px; color: #edfaff; }
.cw-doc-rich h2 { margin: 18px 0 8px; font-size: 16px; color: #edfaff; }
.cw-doc-rich h3 { margin: 14px 0 6px; font-size: 14px; color: #68ddff; }
.cw-doc-rich p { margin: 0 0 8px; }
.cw-doc-li::before { content: '• '; color: #68ddff; }
```

- [x] **Step 13: Run checks**

Run:

```bash
go test ./factory-server/internal/server -run TestJobProjectDocumentPreviewReadsEarlyGeneratedDoc -count=1
go test ./factory-server/internal/server -run TestConfirmDialogueClarificationSeedsJobWithAppSlug -count=1
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: pass.

- [x] **Step 14: Commit**

```bash
git add factory-server/internal/projectdocs/generator.go factory-server/internal/executor/claude_runner.go factory-server/internal/server/workbench_artifact_handlers.go factory-server/internal/server/workbench_artifact_handlers_test.go factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/dialogue_handlers_test.go factory-server/internal/server/server.go sf-portal-mvp/src/components/ProjectDocumentPreviewModal.jsx sf-portal-mvp/src/api/client.js sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css
git commit -m "feat: preview task-owned project documents"
```

## Task 6: Requirement Consistency Contract

**Files:**
- Modify: `factory-server/internal/runner/contracts.go`
- Test: `factory-server/internal/runner/contracts_test.go`
- Modify: `factory-server/internal/executor/claude_runner.go`

- [x] **Step 1: Add runner tests**

Append to `factory-server/internal/runner/contracts_test.go`:

```go
func TestValidateRequirementAnalysisRejectsSummaryChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	raw := `{
	  "confirmedRequirementId":"clar_1",
	  "summary":"需求摘要 B",
	  "appType":"operations_tool",
	  "appName":"请假审批",
	  "targetUsers":["员工"],
	  "coreScenario":"提交和审批请假",
	  "primaryView":"审批工作台",
	  "mainEntities":["请假单"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["可提交审批"],
	  "generationProfile":{"base":["software-factory-app"]},
	  "constraints":{},
	  "risks":[],
	  "validation":{"complete":true,"supported":true}
	}`
	if err := os.WriteFile(p, []byte(raw), 0o644); err != nil {
		t.Fatalf("write output: %v", err)
	}
	_, err := ValidateRequirementAnalysisWithConfirmedSummary(p, `{"summary":"需求摘要 A","appType":"operations_tool","appName":"请假审批","coreScenario":"提交和审批请假"}`)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed", err)
	}
}

func TestValidateRequirementAnalysisAcceptsMatchingSummaryChecksum(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	confirmed := `{"summary":"需求摘要 A","appType":"operations_tool","appName":"请假审批","coreScenario":"提交和审批请假","primaryView":"审批工作台","mainEntities":["请假单"],"dataPolicy":"mock_data","acceptanceFocus":["可提交审批"]}`
	raw := `{
	  "confirmedRequirementId":"clar_1",
	  "summary":"需求摘要 A",
	  "appType":"operations_tool",
	  "appName":"请假审批",
	  "targetUsers":["员工"],
	  "coreScenario":"提交和审批请假",
	  "primaryView":"审批工作台",
	  "mainEntities":["请假单"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["可提交审批"],
	  "generationProfile":{"base":["software-factory-app"]},
	  "constraints":{},
	  "risks":[],
	  "validation":{"complete":true,"supported":true}
	}`
	if err := os.WriteFile(p, []byte(raw), 0o644); err != nil {
		t.Fatalf("write output: %v", err)
	}
	if _, err := ValidateRequirementAnalysisWithConfirmedSummary(p, confirmed); err != nil {
		t.Fatalf("ValidateRequirementAnalysisWithConfirmedSummary: %v", err)
	}
}
```

- [x] **Step 2: Run failing tests**

Run:

```bash
go test ./factory-server/internal/runner -run 'RequirementAnalysis.*Checksum' -count=1
```

Expected: fails because checksum helpers do not exist.

- [x] **Step 3: Add validator-owned consistency helpers**

Modify `factory-server/internal/runner/contracts.go`:

```go
import (
	"crypto/sha256"
	"encoding/hex"
)

func ValidateRequirementAnalysisWithConfirmedSummary(path, confirmedRequirementJSON string) (StepOutput, error) {
	out, raw, err := validateRequirementAnalysisDecoded(path)
	if err != nil {
		return StepOutput{}, err
	}
	want := requirementSummaryChecksum(requirementFieldsFromConfirmed(confirmedRequirementJSON))
	got := requirementSummaryChecksum(requirementFieldsFromOutput(raw))
	if want != got {
		return StepOutput{}, fmt.Errorf("confirmed requirement consistency mismatch: %w", ErrSchemaValidationFailed)
	}
	return out, nil
}

func requirementFieldsFromConfirmed(confirmedRequirementJSON string) map[string]any {
	var doc map[string]any
	_ = json.Unmarshal([]byte(confirmedRequirementJSON), &doc)
	return pickRequirementFields(doc)
}

func requirementFieldsFromOutput(raw requirementAnalysisOutput) map[string]any {
	return pickRequirementFields(map[string]any{
		"summary": raw.Summary,
		"appType": raw.AppType,
		"appName": raw.AppName,
		"coreScenario": raw.CoreScenario,
		"primaryView": raw.PrimaryView,
		"mainEntities": raw.MainEntities,
		"dataPolicy": raw.DataPolicy,
		"acceptanceFocus": raw.AcceptanceFocus,
	})
}

func pickRequirementFields(doc map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"summary", "appType", "appName", "coreScenario", "primaryView", "mainEntities", "dataPolicy", "acceptanceFocus"} {
		if v, ok := doc[key]; ok {
			out[key] = v
		}
	}
	return out
}

func requirementSummaryChecksum(fields map[string]any) string {
	raw, _ := json.Marshal(fields)
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}
```

Refactor `ValidateRequirementAnalysis`:

```go
func ValidateRequirementAnalysis(path string) (StepOutput, error) {
	out, _, err := validateRequirementAnalysisDecoded(path)
	return out, err
}
```

- [x] **Step 4: Pass confirmed requirement into executor validator**

Modify `factory-server/internal/executor/claude_runner.go` in `StepRequirementAnalysis`:

```go
out, err := runner.ValidateRequirementAnalysisWithConfirmedSummary(ws.OutputPath(), string(confirmedReq))
```

- [x] **Step 5: Run tests**

Run:

```bash
go test ./factory-server/internal/runner ./factory-server/internal/executor -run 'RequirementAnalysis|ClaudeStepRunner' -count=1
```

Expected: pass.

- [x] **Step 6: Commit**

```bash
git add factory-server/internal/runner/contracts.go factory-server/internal/runner/contracts_test.go factory-server/internal/executor/claude_runner.go
git commit -m "feat: validate requirement document consistency"
```

## Task 7: Workbench Agent Blocks and Responsibility Tracks

**Files:**
- Create: `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`
- Create: `sf-portal-mvp/src/components/WorkbenchTracks.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`

- [x] **Step 1: Add pure timeline assertion**

Append to `check-workbench-orchestration-adjustment.mjs`:

```js
const blockSource = readFileSync(new URL('../src/components/WorkbenchAgentBlock.jsx', import.meta.url), 'utf8')
for (const text of ['思考过程', '思考摘要', '模型分析过程', '确认业务逻辑并继续', '确认界面解析并继续', '确认数据抓取并继续']) {
  assert.equal(blockSource.includes(text), true, `agent block must include ${text}`)
}
const tracksSource = readFileSync(new URL('../src/components/WorkbenchTracks.jsx', import.meta.url), 'utf8')
for (const text of ['目标识别', '布局分区', '来源', '方案设计', '部署']) {
  assert.equal(tracksSource.includes(text), true, `tracks must include ${text}`)
}
```

- [x] **Step 2: Run failing check**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: fails because block components are missing.

- [x] **Step 3: Create track components**

Create `sf-portal-mvp/src/components/WorkbenchTracks.jsx`:

```jsx
const TRACKS = {
  business_logic: ['目标识别', '对象识别', '规则提取', '澄清判断', '摘要生成'],
  interface_parsing: ['输入解析', '视图识别', '布局分区', '组件映射', '预览生成'],
  data_capture: ['来源', '连接验证', '样本获取', '字段识别', '契约生成', '流向'],
  production_delivery: ['方案设计', '代码生成', '代码审查', '测试验证', '产品验收', '镜像构建', '部署'],
}

export function WorkbenchTrack({ cardKey, activeLabel = '', failedLabel = '' }) {
  const steps = TRACKS[cardKey] || []
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
```

- [x] **Step 4: Create agent block component**

Create `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`:

```jsx
import { ChevronDown, ChevronRight, FileText, MonitorCheck } from 'lucide-react'
import { useState } from 'react'
import { WorkbenchTrack } from './WorkbenchTracks'

const CONFIRM_LABEL = {
  business_logic: '确认业务逻辑并继续',
  interface_parsing: '确认界面解析并继续',
  data_capture: '确认数据抓取并继续',
}

export function WorkbenchAgentBlock({ card, thinking, analysisLog, questions = [], onConfirm, onOpenArtifact }) {
  const [open, setOpen] = useState(!isFolded(card))
  if (!card) return null
  const canConfirm = ['waiting_artifact_confirmation', 'waiting_user_clarification'].includes(card.state) && CONFIRM_LABEL[card.key]
  return (
    <section className={`cw-agent-block cw-agent-block-${card.key} ${open ? 'is-open' : 'is-folded'}`}>
      <button type="button" className="cw-agent-block-head" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>{card.label}</strong>
        <span>{card.currentAction || card.summary || card.subStage || '未开始'}</span>
      </button>
      {open ? (
        <div className="cw-agent-block-body">
          <WorkbenchTrack cardKey={card.key} activeLabel={card.subStage || card.currentAction} failedLabel={card.state === 'failed' ? card.currentAction : ''} />
          {thinking ? <section className="cw-agent-section"><h4>思考过程</h4><pre>{thinking}</pre></section> : null}
          {card.summary ? <section className="cw-agent-section"><h4>思考摘要</h4><p>{card.summary}</p></section> : null}
          {analysisLog ? <section className="cw-agent-section"><h4>模型分析过程</h4><pre>{analysisLog}</pre></section> : null}
          {questions.length ? <QuestionList questions={questions} /> : null}
          {card.artifacts.length ? <ArtifactList artifacts={card.artifacts} onOpenArtifact={onOpenArtifact} /> : null}
          {canConfirm ? <button type="button" className="cw-agent-confirm" onClick={() => onConfirm && onConfirm(card.key)}>{CONFIRM_LABEL[card.key]}</button> : null}
        </div>
      ) : (
        <div className="cw-agent-folded">
          {card.artifacts.map(item => <button key={item.id || item.path} type="button" onClick={() => onOpenArtifact && onOpenArtifact(item)}>{item.label || item.path}</button>)}
        </div>
      )}
    </section>
  )
}

function isFolded(card) {
  return card.state === 'confirmed' || card.state === 'delivered'
}

function QuestionList({ questions }) {
  return (
    <section className="cw-agent-section">
      <h4>澄清项</h4>
      {questions.map(q => <p key={q.id || q.question}>{q.question}</p>)}
    </section>
  )
}

function ArtifactList({ artifacts, onOpenArtifact }) {
  return (
    <section className="cw-agent-section cw-artifact-list">
      <h4>产物</h4>
      {artifacts.map(item => (
        <button key={item.id || item.path} type="button" onClick={() => onOpenArtifact && onOpenArtifact(item)}>
          {item.kind === 'interface_preview' ? <MonitorCheck size={14} /> : <FileText size={14} />}
          <span>{item.label || item.path}</span>
        </button>
      ))}
    </section>
  )
}
```

- [x] **Step 5: Add CSS**

Append to `ConversationWorkbench.css`:

```css
.cw-agent-block { border: 1px solid rgba(111, 218, 255, 0.18); border-radius: 8px; background: rgba(11, 29, 44, 0.55); overflow: hidden; }
.cw-agent-block-head { width: 100%; display: grid; grid-template-columns: 16px minmax(90px, 130px) minmax(0, 1fr); align-items: center; gap: 8px; padding: 9px 10px; border: 0; background: transparent; color: #d7eef8; cursor: pointer; text-align: left; }
.cw-agent-block-head strong { color: #edfaff; font-size: 13px; }
.cw-agent-block-head span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(215, 238, 248, 0.68); font-size: 12px; }
.cw-agent-block-body { display: flex; flex-direction: column; gap: 10px; padding: 0 10px 10px; }
.cw-agent-section { border-top: 1px solid rgba(111, 218, 255, 0.12); padding-top: 8px; }
.cw-agent-section h4 { margin: 0 0 6px; color: #68ddff; font-size: 11px; }
.cw-agent-section p { margin: 0; color: rgba(215, 238, 248, 0.82); font-size: 12px; line-height: 1.5; }
.cw-agent-section pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: rgba(215, 238, 248, 0.78); font-size: 12px; line-height: 1.5; }
.cw-track { display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 6px; margin: 0; padding: 8px 0 0; list-style: none; }
.cw-track li { min-width: 0; display: flex; align-items: center; gap: 5px; color: rgba(215, 238, 248, 0.58); font-size: 11px; }
.cw-track li span { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 999px; background: rgba(143, 176, 191, 0.5); }
.cw-track li.is-active { color: #68ddff; }
.cw-track li.is-active span { background: #68ddff; box-shadow: 0 0 10px rgba(104, 221, 255, 0.56); }
.cw-track li.is-failed { color: #ffb0b0; }
.cw-track li.is-failed span { background: #ff665e; }
.cw-artifact-list { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-artifact-list h4 { flex-basis: 100%; }
.cw-artifact-list button, .cw-agent-folded button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border: 1px solid rgba(111, 218, 255, 0.28); border-radius: 6px; background: rgba(3, 17, 29, 0.66); color: #d7eef8; cursor: pointer; font-size: 11px; }
.cw-agent-confirm { align-self: flex-end; padding: 6px 10px; border: 1px solid rgba(126, 231, 135, 0.46); border-radius: 6px; background: rgba(20, 64, 50, 0.58); color: #bff6c4; cursor: pointer; }
.cw-agent-folded { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 10px 10px 34px; }
```

- [x] **Step 6: Render blocks under graph**

In `ConversationWorkbench.jsx`, after timeline rendering, add:

```jsx
{aggregateGraph.cards
  .filter(card => card.key !== 'user_input' && card.state !== 'not_started' && card.state !== 'waiting_upstream')
  .map(card => (
    <WorkbenchAgentBlock
      key={card.key}
      card={card}
      thinking=""
      analysisLog=""
      questions={card.key === aggregateGraph.activeCardKey ? activeQuestions : []}
      onConfirm={key => onConfirm && onConfirm({ aggregateCardKey: key })}
      onOpenArtifact={openProjectDocument}
    />
  ))}
```

- [x] **Step 7: Run checks**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
node sf-portal-mvp/scripts/check-dialogue-workbench.mjs
```

Expected: pass.

- [x] **Step 8: Commit**

```bash
git add sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx sf-portal-mvp/src/components/WorkbenchTracks.jsx sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/src/hooks/dialogueTimeline.js sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
git commit -m "feat: render workbench agent blocks"
```

## Task 8: Interface Preview Snapshot Contract

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Create: `factory-server/internal/store/workbench_artifacts.go`
- Test: `factory-server/internal/store/workbench_artifacts_test.go`
- Modify: `factory-server/internal/runner/contracts.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/server/workbench_artifact_handlers.go`
- Create: `sf-portal-mvp/src/components/InterfacePreviewModal.jsx`
- Modify: `sf-portal-mvp/src/api/client.js`

- [x] **Step 1: Add store test for workbench artifact refs**

Create `factory-server/internal/store/workbench_artifacts_test.go`:

```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestWorkbenchArtifactRefsLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	ref := model.WorkbenchArtifactRef{
		ID: "warf_1", DialogueID: "dlg_1", JobID: "job_1", StepID: "step_design",
		CardKey: "interface_parsing", Kind: model.WorkbenchArtifactInterfacePreview,
		Label: "界面预览", Path: "jobs/job_1/design/preview/index.html",
		SnapshotHash: "sha256:abc", Status: "provisional", CreatedAt: time.UnixMilli(1700000000000),
	}
	if err := st.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef: %v", err)
	}
	got, err := st.ListWorkbenchArtifactRefsByDialogue(ctx, "dlg_1")
	if err != nil {
		t.Fatalf("ListWorkbenchArtifactRefsByDialogue: %v", err)
	}
	if len(got) != 1 || got[0].Kind != model.WorkbenchArtifactInterfacePreview || got[0].SnapshotHash != "sha256:abc" {
		t.Fatalf("got = %#v", got)
	}
}
```

- [x] **Step 2: Run failing test**

Run:

```bash
go test ./factory-server/internal/store -run TestWorkbenchArtifactRefsLifecycle -count=1
```

Expected: fails because artifact ref model/store is missing.

- [x] **Step 3: Add model and schema**

Add to `model.go`:

```go
type WorkbenchArtifactKind string

const (
	WorkbenchArtifactProjectDocument  WorkbenchArtifactKind = "project_document"
	WorkbenchArtifactInterfacePreview WorkbenchArtifactKind = "interface_preview"
	WorkbenchArtifactDataContract     WorkbenchArtifactKind = "data_contract"
	WorkbenchArtifactSampleData       WorkbenchArtifactKind = "sample_data"
)

type WorkbenchArtifactRef struct {
	ID           string                `json:"id"`
	DialogueID   string                `json:"dialogue_id"`
	JobID        string                `json:"job_id"`
	StepID       string                `json:"step_id"`
	CardKey      string                `json:"cardKey"`
	Kind         WorkbenchArtifactKind `json:"kind"`
	Label        string                `json:"label"`
	Path         string                `json:"path"`
	PreviewURL   string                `json:"previewUrl,omitempty"`
	SnapshotHash string                `json:"snapshotHash,omitempty"`
	Status       string                `json:"status"`
	CreatedAt    time.Time             `json:"created_at"`
	UpdatedAt    time.Time             `json:"updated_at"`
}
```

Add schema:

```sql
CREATE TABLE IF NOT EXISTS workbench_artifact_refs (
    id            TEXT    PRIMARY KEY,
    dialogue_id   TEXT    NOT NULL DEFAULT '',
    job_id        TEXT    NOT NULL DEFAULT '',
    step_id       TEXT    NOT NULL DEFAULT '',
    card_key      TEXT    NOT NULL DEFAULT '',
    kind          TEXT    NOT NULL,
    label         TEXT    NOT NULL DEFAULT '',
    path          TEXT    NOT NULL DEFAULT '',
    preview_url   TEXT    NOT NULL DEFAULT '',
    snapshot_hash TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workbench_artifact_refs_dialogue
ON workbench_artifact_refs(dialogue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workbench_artifact_refs_job
ON workbench_artifact_refs(job_id, created_at);
```

- [x] **Step 4: Implement store methods**

Create `factory-server/internal/store/workbench_artifacts.go` with `UpsertWorkbenchArtifactRef`, `ListWorkbenchArtifactRefsByDialogue`, and `ListWorkbenchArtifactRefsByJob`. Use the same `ms` timestamp helper pattern as existing store files.

- [x] **Step 5: Run store test**

Run:

```bash
go test ./factory-server/internal/store -run TestWorkbenchArtifactRefsLifecycle -count=1
```

Expected: pass.

- [x] **Step 6: Add design contract decoder**

Modify `runner/contracts.go` with:

```go
type DesignContractOutput struct {
	Status            string        `json:"status"`
	Summary           string        `json:"summary"`
	NeedsUserInput    bool          `json:"needsUserInput"`
	Questions         []Question    `json:"questions"`
	DesignDocument    any           `json:"designDocument"`
	AssumedDataFields []string      `json:"assumedDataFields"`
	WorkLog           []workLogEntry `json:"workLog"`
	Warnings          []string       `json:"warnings"`
}

func ValidateDesignContract(path string) (StepOutput, DesignContractOutput, error) {
	var raw DesignContractOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, raw, err
	}
	if raw.NeedsUserInput {
		return StepOutput{NeedsUserInput: true, Questions: raw.Questions}, raw, nil
	}
	if strings.TrimSpace(raw.Summary) == "" || raw.DesignDocument == nil {
		return StepOutput{}, raw, fmt.Errorf("design summary and designDocument required: %w", ErrSchemaValidationFailed)
	}
	return StepOutput{}, raw, nil
}
```

- [x] **Step 7: Specialize the design prompt and create the preview in the executor**

Modify `factory-server/internal/executor/claude_runner.go` so the collaboration producer prompt branches before the generic prompt:

```go
func collaborationProducerPrompt(job model.Job, step model.JobStep, ws runner.AttemptWorkspace) string {
	if step.Kind == model.StepDesignContract {
		return designContractPrompt(job, ws)
	}
	if step.Kind == model.StepDataIntegration {
		return dataIntegrationPrompt(job, ws)
	}
	return genericCollaborationProducerPrompt(job, step, ws)
}

func designContractPrompt(job model.Job, ws runner.AttemptWorkspace) string {
	return "你是软件工厂的界面解析智能体。读取 input.json 中的 confirmedRequirement、附件摘要和已有字段假设，输出界面解析设计契约。" +
		"不要修改文件，不要生成界面预览文件；界面预览由 Factory 执行器根据 designDocument 生成 task-owned 产物。" +
		"最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块。Factory 会把 stdout 保存为 output.json，路径：" + absolutePath(ws.OutputPath()) + "。" +
		"JSON 必须包含：status、summary、needsUserInput、questions、designDocument、assumedDataFields、workLog、warnings。" +
		"status 只能是 passed 或 needs_input；不需要用户补充时 needsUserInput=false 且 questions=[]。" +
		"designDocument 必须描述视图识别、布局分区、组件映射、交互状态、响应式约束、关键文案和字段呈现。assumedDataFields 是预览依赖但数据抓取尚未确认的字段名数组。" +
		"需要用户澄清时，questions 必须是结构化数组，每项包含 id、question、options；options 每项包含 value、label，可包含 recommended:true。" +
		"所有人类可读文本必须使用简体中文；只有标识符、路径、枚举值和代码符号可以保留英文。用户需求：" + job.UserPrompt
}
```

In `claude_runner.go`, for `model.StepDesignContract`, call `runner.ValidateDesignContract`, then create a deterministic preview snapshot from the validated design contract. The preview may be a static manifest in the attempt workspace for the first version:

```go
out, design, err := runner.ValidateDesignContract(ws.OutputPath())
c.emitWorkLog(ctx, emit, ws.OutputPath())
res := c.resultFromValidatedOutput(ctx, trace, out, err)
if res.Status == model.StepStatusSucceeded {
	ref, perr := c.createInterfacePreviewSnapshot(ctx, job, step, ws, design)
	if perr != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed, ErrorMessage: perr.Error()}, nil
	}
	c.upsertWorkbenchArtifact(ctx, ref)
}
return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
```

Add helpers:

```go
func (c *ClaudeStepRunner) createInterfacePreviewSnapshot(ctx context.Context, job model.Job, step model.JobStep, ws runner.AttemptWorkspace, design runner.DesignContractOutput) (model.WorkbenchArtifactRef, error) {
	raw, err := json.MarshalIndent(map[string]any{
		"kind": "static_manifest",
		"summary": design.Summary,
		"designDocument": design.DesignDocument,
		"assumedDataFields": design.AssumedDataFields,
	}, "", "  ")
	if err != nil {
		return model.WorkbenchArtifactRef{}, err
	}
	previewRel := filepath.ToSlash(filepath.Join("jobs", job.ID, string(step.Kind), fmt.Sprintf("attempt-%d", step.Attempt), "interface-preview", "manifest.json"))
	full := filepath.Join(c.artifactRoot(), filepath.FromSlash(previewRel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return model.WorkbenchArtifactRef{}, err
	}
	if err := os.WriteFile(full, raw, 0o644); err != nil {
		return model.WorkbenchArtifactRef{}, err
	}
	sum := sha256.Sum256(raw)
	now := time.Now()
	return model.WorkbenchArtifactRef{
		ID: "warf_" + idpkg.New(), DialogueID: job.DialogueID, JobID: job.ID, StepID: step.ID,
		CardKey: "interface_parsing", Kind: model.WorkbenchArtifactInterfacePreview,
		Label: "界面预览", Path: previewRel, SnapshotHash: "sha256:" + hex.EncodeToString(sum[:]),
		Status: "provisional", CreatedAt: now, UpdatedAt: now,
	}, nil
}

func (c *ClaudeStepRunner) upsertWorkbenchArtifact(ctx context.Context, ref model.WorkbenchArtifactRef) {
	if c.Store == nil || ref.ID == "" {
		return
	}
	_ = c.Store.UpsertWorkbenchArtifactRef(ctx, ref)
}
```

- [x] **Step 8: Add frontend preview modal**

Create `sf-portal-mvp/src/components/InterfacePreviewModal.jsx`:

```jsx
import { X } from 'lucide-react'

export function InterfacePreviewModal({ artifact, onClose }) {
  if (!artifact) return null
  return (
    <div className="cw-doc-modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="cw-doc-modal cw-interface-modal" role="dialog" aria-modal="true" aria-label="界面预览" onMouseDown={event => event.stopPropagation()}>
        <header>
          <strong>{artifact.label || '界面预览'}</strong>
          <button type="button" onClick={onClose} aria-label="关闭预览"><X size={16} /></button>
        </header>
        <iframe title="界面预览" src={artifact.previewUrl} sandbox="allow-scripts allow-same-origin" />
      </section>
    </div>
  )
}
```

- [x] **Step 9: Run focused checks**

Run:

```bash
go test ./factory-server/internal/store -run WorkbenchArtifact -count=1
go test ./factory-server/internal/runner -run DesignContract -count=1
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: pass.

- [x] **Step 10: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/workbench_artifacts.go factory-server/internal/store/workbench_artifacts_test.go factory-server/internal/runner/contracts.go factory-server/internal/executor/claude_runner.go factory-server/internal/server/workbench_artifact_handlers.go sf-portal-mvp/src/components/InterfacePreviewModal.jsx sf-portal-mvp/src/api/client.js
git commit -m "feat: retain interface preview snapshots"
```

## Task 9: Data Capture Fallback and Data Flow Track

**Files:**
- Modify: `factory-server/internal/runner/contracts.go`
- Test: `factory-server/internal/runner/contracts_test.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `sf-portal-mvp/src/components/WorkbenchTracks.jsx`
- Modify: `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`
- Modify: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`

- [x] **Step 1: Add data contract runner tests**

Append to `contracts_test.go`:

```go
func TestValidateDataIntegrationRequiresStepwiseFallbackQuestion(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	raw := `{
	  "status":"needs_input",
	  "summary":"本体接口不可用",
	  "sourceBoundary":"ontology",
	  "verification":{"ontology":{"status":"failed","reason":"401"}},
	  "needsUserInput":true,
	  "questions":[{"id":"fallback-internet","question":"本体接口不可用，是否降级为互联网抓取？","options":[{"value":"internet","label":"降级为互联网抓取","recommended":true},{"value":"ontology","label":"继续提供本体接口信息"}]}],
	  "dataContract":{"fields":[]},
	  "workLog":[{"content":"已验证本体接口，返回 401"}]
	}`
	out, detail, err := ValidateDataIntegration(writeTempFileForContractTest(t, p, raw))
	if err != nil {
		t.Fatalf("ValidateDataIntegration: %v", err)
	}
	if !out.NeedsUserInput || len(out.Questions) != 1 {
		t.Fatalf("out = %#v", out)
	}
	if detail.SourceBoundary != "ontology" || detail.Verification.Ontology.Status != "failed" {
		t.Fatalf("detail = %#v", detail)
	}
}

func TestValidateDataIntegrationRejectsSilentDemoFallback(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	raw := `{"status":"passed","summary":"使用演示数据","sourceBoundary":"demo","needsUserInput":false,"dataContract":{"fields":[{"name":"id"}]},"fallbackHistory":["ontology_failed","internet_failed"]}`
	_, _, err := ValidateDataIntegration(writeTempFileForContractTest(t, p, raw))
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed", err)
	}
}

func writeTempFileForContractTest(t *testing.T, path, raw string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}
```

- [x] **Step 2: Add a data-integration prompt contract**

Modify `factory-server/internal/executor/claude_runner.go` beside `designContractPrompt`:

```go
func dataIntegrationPrompt(job model.Job, ws runner.AttemptWorkspace) string {
	return "你是软件工厂的数据抓取智能体。读取 input.json 中的 confirmedRequirement、controlledCredentialRefs、附件摘要和 [user_input] 回答，按本体接口优先、互联网抓取其次、演示数据最后的顺序做数据验证。" +
		"不要静默降级：本体接口不可用时必须 needsUserInput=true 并询问是否降级为互联网抓取；互联网抓取不可用时必须 needsUserInput=true 并询问是否降级为演示数据。用户已在 [user_input] 明确选择边界时，从该边界开始。" +
		"凭证类澄清问题必须设置 inputType:\"credential\"；普通选择问题使用 options，options 每项包含 value、label，可包含 recommended:true。" +
		"最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块。Factory 会把 stdout 保存为 output.json，路径：" + absolutePath(ws.OutputPath()) + "。" +
		"JSON 必须包含：status、summary、sourceBoundary、verification、dataContract、fallbackHistory、needsUserInput、questions、workLog、warnings、compatibility。" +
		"sourceBoundary 只能是 ontology、internet、demo；status 只能是 passed 或 needs_input。verification 必须包含 ontology/internet/demo 节点，每个节点包含 status 和 reason。" +
		"dataContract.fields 是字段数组；成功通过数据契约时 fields 不得为空。compatibility.status 只能是 passed、failed、pending；failed 时必须 needsUserInput=true 并给出兼容性确认问题。" +
		"所有人类可读文本必须使用简体中文；只有标识符、路径、枚举值和代码符号可以保留英文。用户需求：" + job.UserPrompt
}
```

- [x] **Step 3: Implement `ValidateDataIntegration`**

Add to `runner/contracts.go`:

```go
type DataIntegrationOutput struct {
	Status          string            `json:"status"`
	Summary         string            `json:"summary"`
	SourceBoundary  string            `json:"sourceBoundary"`
	Verification    DataVerification  `json:"verification"`
	DataContract    DataContract      `json:"dataContract"`
	FallbackHistory []string          `json:"fallbackHistory"`
	NeedsUserInput  bool              `json:"needsUserInput"`
	Questions       []Question        `json:"questions"`
	WorkLog         []workLogEntry    `json:"workLog"`
}

type DataVerification struct {
	Ontology DataVerificationNode `json:"ontology"`
	Internet DataVerificationNode `json:"internet"`
	Demo     DataVerificationNode `json:"demo"`
}

type DataVerificationNode struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

type DataContract struct {
	Fields []map[string]any `json:"fields"`
	SampleCount int `json:"sampleCount"`
}

func ValidateDataIntegration(path string) (StepOutput, DataIntegrationOutput, error) {
	var raw DataIntegrationOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, raw, err
	}
	if raw.NeedsUserInput || strings.EqualFold(raw.Status, "needs_input") {
		if len(raw.Questions) == 0 {
			return StepOutput{}, raw, fmt.Errorf("questions required for data fallback: %w", ErrSchemaValidationFailed)
		}
		return StepOutput{NeedsUserInput: true, Questions: raw.Questions}, raw, nil
	}
	if raw.SourceBoundary == "demo" && len(raw.FallbackHistory) > 0 {
		return StepOutput{}, raw, fmt.Errorf("demo data fallback requires explicit user confirmation trace: %w", ErrSchemaValidationFailed)
	}
	if len(raw.DataContract.Fields) == 0 {
		return StepOutput{}, raw, fmt.Errorf("data contract fields required: %w", ErrSchemaValidationFailed)
	}
	return StepOutput{}, raw, nil
}
```

- [x] **Step 4: Wire executor data step**

In `claude_runner.go` data integration branch:

```go
out, dataDetail, err := runner.ValidateDataIntegration(ws.OutputPath())
c.emitWorkLog(ctx, emit, ws.OutputPath())
res := c.resultFromValidatedOutput(ctx, trace, out, err)
if res.Status == model.StepStatusSucceeded {
	c.upsertWorkbenchArtifact(ctx, model.WorkbenchArtifactRef{
		ID: "warf_" + idpkg.New(), DialogueID: job.DialogueID, JobID: job.ID, StepID: step.ID,
		CardKey: "data_capture", Kind: model.WorkbenchArtifactDataContract,
		Label: "数据契约", Path: "docs/data-integration.md",
		Status: dataDetail.SourceBoundary, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	})
}
return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
```

- [x] **Step 5: Add track assertion**

Extend the Node check:

```js
const dataGraph = buildWorkbenchOrchestrationView({
  view: { session: { id: 'dlg_data', status: 'task_running' }, messages: [{ id: 'u', role: 'user', content: 'x' }] },
  jobStepBlocks: [{ stepId: 'data', kind: 'data_integration', agentKey: 'data-integration', status: 'waiting_user', summary: '本体接口不可用，等待降级确认' }],
  workTraceItems: [{ stepId: 'data', type: 'clarification', payload: { questions: [{ id: 'fallback-internet', question: '是否降级为互联网抓取？' }] } }],
})
assert.equal(dataGraph.cardsByKey.data_capture.state, 'waiting_user_clarification')
assert.equal(dataGraph.cardsByKey.data_capture.currentAction.includes('本体接口不可用'), true)
```

- [x] **Step 6: Run tests**

Run:

```bash
go test ./factory-server/internal/runner -run DataIntegration -count=1
go test ./factory-server/internal/executor -run DataIntegration -count=1
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: pass.

- [x] **Step 7: Commit**

```bash
git add factory-server/internal/runner/contracts.go factory-server/internal/runner/contracts_test.go factory-server/internal/executor/claude_runner.go sf-portal-mvp/src/components/WorkbenchTracks.jsx sf-portal-mvp/src/hooks/workbenchOrchestrationState.js sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
git commit -m "feat: model data capture fallback flow"
```

## Task 10: Production Delivery Aggregation

**Files:**
- Modify: `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`
- Modify: `sf-portal-mvp/src/components/WorkbenchTracks.jsx`
- Modify: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/executor/executor_test.go`

- [x] **Step 1: Add aggregation assertions**

Append:

```js
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
```

- [x] **Step 2: Run check**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: fails until state mapping accepts `errorCode` and deployment waits.

- [x] **Step 3: Update state mapping**

Modify `workbenchOrchestrationState.js`:

```js
function productionFailureState(step) {
  const code = step.errorCode || step.error_code || ''
  const repairable = new Set(['blocking_review', 'schema_validation_failed', 'file_constraint_violated'])
  if (repairable.has(code)) return 'auto_repairing'
  return 'failed'
}
```

Ensure `aggregateProductionState` maps `waiting_user` to `waiting_user_confirmation`.

- [x] **Step 4: Add executor failure-transition test**

Add a focused test in `factory-server/internal/executor/executor_test.go` that seeds a production-delivery step waiting for a required user confirmation, calls the reject/abandon path, and asserts the job transitions to failed:

```go
func TestRejectRequiredProductionConfirmationFailsJob(t *testing.T) {
	e, st := newTestExecutor(t, &fakeRunner{})
	ctx := context.Background()
	job := model.Job{ID: "job_confirm", Status: model.JobStatusWaitingUser, CurrentStepKind: model.StepDeployment, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := st.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	step := model.JobStep{ID: "step_deploy", JobID: job.ID, Kind: model.StepDeployment, Status: model.StepStatusWaitingUser, Attempt: 1, NeedsUserInput: true}
	if err := st.CreateJobStep(ctx, step); err != nil {
		t.Fatalf("CreateJobStep: %v", err)
	}
	got, err := e.RejectRequiredConfirmation(ctx, job.ID, "用户拒绝部署端口确认")
	if err != nil {
		t.Fatalf("RejectRequiredConfirmation: %v", err)
	}
	if got.Status != model.JobStatusFailed {
		t.Fatalf("status = %s, want failed", got.Status)
	}
}
```

- [x] **Step 5: Add the user-rejection error code**

Modify `factory-server/internal/model/model.go`:

```go
ErrorUserRejectedConfirmation ErrorCode = "user_rejected_confirmation"
```

- [x] **Step 6: Implement the fixed transition**

Modify `factory-server/internal/executor/executor.go`:

```go
func (e *Executor) RejectRequiredConfirmation(ctx context.Context, jobID, reason string) (*model.Job, error) {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, errors.New("job not found")
	}
	if job.Status != model.JobStatusWaitingUser {
		return nil, errors.New("job is not waiting for user confirmation")
	}
	msg := strings.TrimSpace(reason)
	if msg == "" {
		msg = "用户拒绝必要确认"
	}
	step, err := e.store.GetStepByKind(ctx, job.ID, job.CurrentStepKind)
	if err != nil {
		return nil, err
	}
	if step != nil {
		if err := e.store.MarkStepFailed(ctx, step.ID, model.ErrorUserRejectedConfirmation, msg); err != nil {
			return nil, err
		}
	}
	if err := e.store.MarkJobFailed(ctx, job.ID); err != nil {
		return nil, err
	}
	return e.store.GetJob(ctx, job.ID)
}
```

- [x] **Step 7: Run checks**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
go test ./factory-server/internal/executor -run 'Repair|Confirmation|Failure' -count=1
```

Expected: pass.

- [x] **Step 8: Commit**

```bash
git add sf-portal-mvp/src/hooks/workbenchOrchestrationState.js sf-portal-mvp/src/components/WorkbenchTracks.jsx sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs factory-server/internal/model/model.go factory-server/internal/executor/executor.go factory-server/internal/executor/executor_test.go
git commit -m "feat: aggregate production delivery state"
```

## Task 11: Dialogue View Projection of Attachments and Artifacts

**Files:**
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Test: `factory-server/internal/server/dialogue_handlers_test.go`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`

- [x] **Step 1: Add composed-view backend test**

Append:

```go
func TestComposeDialogueViewIncludesAttachmentRefsAndWorkbenchArtifacts(t *testing.T) {
	srv, _, _ := newTestServerWithStore(t)
	ctx := testCtx()
	_ = srv.store.CreateDialogueSession(ctx, model.DialogueSession{ID: "dlg_view", Status: model.DialogueStatusActive, Intent: model.DialogueIntentApplicationGeneration})
	_ = srv.store.AppendDialogueMessage(ctx, model.DialogueMessage{ID: "dmsg_view", DialogueID: "dlg_view", Role: "user", Kind: "message", Content: "带附件", CreatedAt: time.Now()})
	_ = srv.store.CreateDialogueAttachment(ctx, model.DialogueAttachment{ID: "att_view", DialogueID: "dlg_view", OriginalName: "req.md", StoredPath: "dialogue-attachments/dlg_view/att_view/req.md", PreviewKind: model.AttachmentPreviewMarkdown, Status: model.AttachmentStatusActive, CreatedAt: time.Now()})
	_ = srv.store.CreateDialogueAttachmentRef(ctx, model.DialogueAttachmentRef{ID: "aref_view", DialogueID: "dlg_view", MessageID: "dmsg_view", AttachmentID: "att_view", Active: true, CreatedAt: time.Now()})
	_ = srv.store.UpsertWorkbenchArtifactRef(ctx, model.WorkbenchArtifactRef{ID: "warf_view", DialogueID: "dlg_view", JobID: "job_1", CardKey: "business_logic", Kind: model.WorkbenchArtifactProjectDocument, Label: "需求文档", Path: "docs/01-requirements.md", CreatedAt: time.Now(), UpdatedAt: time.Now()})
	view, err := srv.composeDialogueView(ctx, "dlg_view")
	if err != nil {
		t.Fatalf("composeDialogueView: %v", err)
	}
	if len(view.AttachmentRefs) != 1 || view.AttachmentRefs[0].Attachment.OriginalName != "req.md" {
		t.Fatalf("AttachmentRefs = %#v", view.AttachmentRefs)
	}
	if len(view.WorkbenchArtifacts) != 1 || view.WorkbenchArtifacts[0].Path != "docs/01-requirements.md" {
		t.Fatalf("WorkbenchArtifacts = %#v", view.WorkbenchArtifacts)
	}
}
```

- [x] **Step 2: Run failing test**

Run:

```bash
go test ./factory-server/internal/server -run TestComposeDialogueViewIncludesAttachmentRefsAndWorkbenchArtifacts -count=1
```

Expected: fails because `dialogueView` does not expose these fields.

- [x] **Step 3: Extend `dialogueView`**

In `dialogue_handlers.go`:

```go
type dialogueView struct {
	...
	AttachmentRefs []model.DialogueAttachmentRef `json:"attachmentRefs,omitempty"`
	WorkbenchArtifacts []model.WorkbenchArtifactRef `json:"workbenchArtifacts,omitempty"`
}
```

In `composeDialogueView`, after messages:

```go
if refs, err := s.store.ListDialogueAttachmentRefs(ctx, id); err == nil {
	view.AttachmentRefs = refs
}
if artifacts, err := s.store.ListWorkbenchArtifactRefsByDialogue(ctx, id); err == nil {
	view.WorkbenchArtifacts = artifacts
}
```

- [x] **Step 4: Run backend test**

Run:

```bash
go test ./factory-server/internal/server -run TestComposeDialogueViewIncludesAttachmentRefsAndWorkbenchArtifacts -count=1
```

Expected: pass.

- [x] **Step 5: Render attachment refs in timeline**

Modify `dialogueTimeline.js` where user messages are mapped:

```js
const refsByMessage = attachmentRefsByMessage(view)
...
items.push({
  id: msg.id,
  type: 'user_message',
  content: safeString(msg.content),
  attachments: refsByMessage[msg.id] || [],
})
```

Add helper:

```js
function attachmentRefsByMessage(view) {
  const refs = Array.isArray(view && view.attachmentRefs) ? view.attachmentRefs : []
  const grouped = {}
  for (const ref of refs) {
    const messageId = safeString(ref.message_id || ref.messageId)
    if (!messageId) continue
    if (!grouped[messageId]) grouped[messageId] = []
    grouped[messageId].push({
      id: safeString(ref.id),
      active: ref.active !== false,
      name: safeString(ref.attachment && (ref.attachment.original_name || ref.attachment.originalName)),
      previewKind: safeString(ref.attachment && (ref.attachment.preview_kind || ref.attachment.previewKind)),
    })
  }
  return grouped
}
```

- [x] **Step 6: Run checks**

Run:

```bash
go test ./factory-server/internal/server -run TestComposeDialogueViewIncludesAttachmentRefsAndWorkbenchArtifacts -count=1
node sf-portal-mvp/scripts/check-dialogue-workbench.mjs
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: pass.

- [x] **Step 7: Commit**

```bash
git add factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/dialogue_handlers_test.go sf-portal-mvp/src/hooks/dialogueTimeline.js sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
git commit -m "feat: project workbench artifacts into dialogue view"
```

## Task 12: Controlled Credential Input Boundary

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Create: `factory-server/internal/store/credential_refs.go`
- Test: `factory-server/internal/store/credential_refs_test.go`
- Create: `factory-server/internal/security/redaction.go`
- Test: `factory-server/internal/security/redaction_test.go`
- Modify: `factory-server/internal/server/server.go`
- Create: `factory-server/internal/server/credential_secrets.go`
- Test: `factory-server/internal/server/credential_secrets_test.go`
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Modify: `factory-server/internal/runner/contracts.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`
- Modify: `sf-portal-mvp/src/api/client.js`

- [x] **Step 1: Add redaction tests**

Create `factory-server/internal/security/redaction_test.go`:

```go
package security

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	in := "Authorization: Bearer abcdef\npassword=secret\napi_key=xyz"
	out := RedactSecrets(in)
	for _, leaked := range []string{"abcdef", "secret", "xyz"} {
		if strings.Contains(out, leaked) {
			t.Fatalf("secret %q leaked in %q", leaked, out)
		}
	}
	for _, kept := range []string{"Authorization", "password", "api_key"} {
		if !strings.Contains(out, kept) {
			t.Fatalf("key %q missing in %q", kept, out)
		}
	}
}
```

- [x] **Step 2: Implement redaction**

Create `factory-server/internal/security/redaction.go`:

```go
package security

import "regexp"

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization\s*:\s*bearer\s+)[^\s]+`),
	regexp.MustCompile(`(?i)(api[_-]?key\s*[:=]\s*)[^\s]+`),
	regexp.MustCompile(`(?i)(password\s*[:=]\s*)[^\s]+`),
	regexp.MustCompile(`(?i)(token\s*[:=]\s*)[^\s]+`),
}

func RedactSecrets(value string) string {
	out := value
	for _, re := range secretPatterns {
		out = re.ReplaceAllString(out, `${1}[REDACTED]`)
	}
	return out
}
```

- [x] **Step 3: Run redaction test**

Run:

```bash
go test ./factory-server/internal/security -count=1
```

Expected: pass.

- [x] **Step 4: Add credential question type**

Modify `factory-server/internal/runner/contracts.go`:

```go
type Question struct {
	ID            string           `json:"id"`
	Question      string           `json:"question"`
	DefaultAnswer string           `json:"defaultAnswer"`
	InputType     string           `json:"inputType,omitempty"`
	Options       []QuestionOption `json:"options,omitempty"`
}
```

Update `Question.UnmarshalJSON`:

```go
type controlledCredentialInput struct {
	ID            string           `json:"id"`
	Question      string           `json:"question"`
	Text          string           `json:"text"`
	DefaultAnswer string           `json:"defaultAnswer"`
	InputType     string           `json:"inputType"`
	Options       []QuestionOption `json:"options"`
}
```

Assign `q.InputType = r.InputType`.

Update `clarificationPayload` in `factory-server/internal/executor/claude_runner.go`:

```go
type q struct {
	ID            string `json:"id,omitempty"`
	Question      string `json:"question"`
	DefaultAnswer string `json:"defaultAnswer,omitempty"`
	InputType     string `json:"inputType,omitempty"`
	Options       []opt  `json:"options,omitempty"`
}
out = append(out, q{ID: qq.ID, Question: qq.Question, DefaultAnswer: qq.DefaultAnswer, InputType: qq.InputType, Options: opts})
```

- [x] **Step 5: Add credential metadata store**

Add to `model.go`:

```go
type EphemeralCredentialRef struct {
	ID         string    `json:"id"`
	DialogueID string    `json:"dialogue_id"`
	FocusKey   string    `json:"focus_key"`
	Label      string    `json:"label"`
	Scope      string    `json:"scope"`
	Handle     string    `json:"handle"`
	CreatedAt  time.Time `json:"created_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}
```

Add to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS ephemeral_credential_refs (
    id          TEXT    PRIMARY KEY,
    dialogue_id TEXT    NOT NULL,
    focus_key   TEXT    NOT NULL DEFAULT '',
    label       TEXT    NOT NULL DEFAULT '',
    scope       TEXT    NOT NULL DEFAULT '',
    handle      TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ephemeral_credential_refs_dialogue
ON ephemeral_credential_refs(dialogue_id, created_at);
```

Create `factory-server/internal/store/credential_refs.go` with `CreateEphemeralCredentialRef` and `ListEphemeralCredentialRefs`.

- [x] **Step 6: Add credential submit endpoint**

Add request body in `dialogue_handlers.go`:

```go
type controlledCredentialBody struct {
	FocusKey string `json:"focusKey"`
	Label    string `json:"label"`
	Scope    string `json:"scope"`
	Value    string `json:"value"`
}
```

Add handler:

```go
func (s *Server) submitDialogueCredential(w http.ResponseWriter, r *http.Request) {
	dialogueID := Param(r, "id")
	var body controlledCredentialBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(body.Value) == "" {
		writeError(w, http.StatusBadRequest, "missing credential value")
		return
	}
	handle := s.storeRuntimeSecret(dialogueID, body.Scope, body.Value)
	now := time.Now()
	ref := model.EphemeralCredentialRef{
		ID: "cred_" + idpkg.New(), DialogueID: dialogueID, FocusKey: body.FocusKey,
		Label: body.Label, Scope: body.Scope, Handle: handle,
		CreatedAt: now, ExpiresAt: now.Add(30 * time.Minute),
	}
	if err := s.store.CreateEphemeralCredentialRef(r.Context(), ref); err != nil {
		writeError(w, http.StatusInternalServerError, "save credential ref")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"credentialRef": map[string]any{"id": ref.ID, "label": ref.Label, "scope": ref.Scope, "redacted": true},
	})
}
```

Register:

```go
r.Handle("POST", "/api/dialogues/:id/credentials", s.submitDialogueCredential)
```

Add the server field in `server.go`:

```go
credentialSecrets sync.Map // map[string]runtimeCredentialSecret
```

Create `factory-server/internal/server/credential_secrets.go`:

```go
package server

import (
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
)

type runtimeCredentialSecret struct {
	DialogueID string
	Scope      string
	Value      string
	ExpiresAt  time.Time
}

func (s *Server) storeRuntimeSecret(dialogueID, scope, value string) string {
	handle := "secret_" + idpkg.New()
	s.credentialSecrets.Store(handle, runtimeCredentialSecret{
		DialogueID: dialogueID,
		Scope:      scope,
		Value:      value,
		ExpiresAt:  time.Now().Add(30 * time.Minute),
	})
	return handle
}

func (s *Server) CredentialHandleAvailable(handle string) bool {
	v, ok := s.credentialSecrets.Load(handle)
	if !ok {
		return false
	}
	secret, ok := v.(runtimeCredentialSecret)
	if !ok || time.Now().After(secret.ExpiresAt) {
		s.credentialSecrets.Delete(handle)
		return false
	}
	return true
}
```

Add `credential_secrets_test.go` with one test for a live handle and one test for an expired handle being rejected/deleted. Do not persist `body.Value`, do not include it in SSE payloads, and do not write it to attachments, work traces, project docs, dialogue message content, `input.json`, or `output.json`.

- [x] **Step 7: Inject credential refs into data step input**

Modify `factory-server/internal/executor/claude_runner.go` to add a handle-availability resolver and wire it from `server.New` when creating `ClaudeStepRunner`:

```go
type CredentialHandleResolver interface {
	CredentialHandleAvailable(handle string) bool
}

type ClaudeStepRunner struct {
	Store              *store.Store
	Workspace          string
	ArtifactRoot       string
	Claude             *runner.ClaudeRunner
	AuditRunner        runner.CommandRunner
	CredentialResolver CredentialHandleResolver
}
```

Wire it in `server.New` when constructing the production `ClaudeStepRunner`:

```go
claude = &executor.ClaudeStepRunner{
	Store:              st,
	Workspace:          cfg.WorkspaceRoot,
	ArtifactRoot:       cfg.ArtifactRoot,
	Claude:             &runner.ClaudeRunner{Runner: claudeCmd, WorkDir: cfg.WorkspaceRoot},
	AuditRunner:        claudeCmd,
	CredentialResolver: s,
}
```

Before building `input`, collect only live, redacted refs:

```go
credentialRefs := []map[string]any{}
if step.Kind == model.StepDataIntegration && job.DialogueID != "" && c.Store != nil {
	refs, _ := c.Store.ListEphemeralCredentialRefs(ctx, job.DialogueID, "data_capture", time.Now())
	for _, ref := range refs {
		if c.CredentialResolver != nil && !c.CredentialResolver.CredentialHandleAvailable(ref.Handle) {
			continue
		}
		credentialRefs = append(credentialRefs, map[string]any{
			"id": ref.ID, "label": ref.Label, "scope": ref.Scope,
			"handle": ref.Handle, "expiresAt": ref.ExpiresAt,
		})
	}
}
```

Add `controlledCredentialRefs` to the `input.json` map. It must contain only `id`, `label`, `scope`, `handle`, and expiry metadata. Plaintext credential values remain in the runtime registry and may only be resolved by a server-side data verification tool that accepts the handle; Claude prompts, SSE, logs, project docs, artifacts, and dialogue messages never receive plaintext credentials.

- [x] **Step 8: UI credential prompt**

In `WorkbenchAgentBlock.jsx`, if a question has `inputType === 'credential'`, render:

```jsx
<label className="cw-credential-input">
  <span>{q.question}</span>
  <input
    type="password"
    autoComplete="off"
    value={credentialDrafts[q.id] || ''}
    onChange={event => setCredentialDrafts(prev => ({ ...prev, [q.id]: event.target.value }))}
    placeholder="输入受控凭证"
  />
  <button type="button" onClick={() => onSubmitCredential(q, credentialDrafts[q.id] || '')}>提交凭证</button>
</label>
```

Do not render credential values in summaries, attachments, or artifact lists.

- [x] **Step 9: Add client API**

Modify `sf-portal-mvp/src/api/client.js`:

```js
submitDialogueCredential: (id, body) =>
  request(`/api/dialogues/${id}/credentials`, { method: 'POST', body: JSON.stringify(body) }),
```

- [x] **Step 10: Run tests**

Run:

```bash
go test ./factory-server/internal/security ./factory-server/internal/store ./factory-server/internal/server -run 'Redact|Credential|DialogueMessage' -count=1
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: pass.

- [x] **Step 11: Commit**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/credential_refs.go factory-server/internal/store/credential_refs_test.go factory-server/internal/security/redaction.go factory-server/internal/security/redaction_test.go factory-server/internal/server/server.go factory-server/internal/server/credential_secrets.go factory-server/internal/server/credential_secrets_test.go factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/job_handlers.go factory-server/internal/runner/contracts.go factory-server/internal/executor/claude_runner.go sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx sf-portal-mvp/src/api/client.js
git commit -m "feat: add controlled credential boundary"
```

## Task 13: Interface/Data Compatibility Gate

**Files:**
- Modify: `factory-server/internal/runner/contracts.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`
- Modify: `sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs`

- [x] **Step 1: Add frontend compatibility assertion**

Append:

```js
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
```

- [x] **Step 2: Implement artifact-aware compatibility state**

In `workbenchOrchestrationState.js`, when data contract artifact status is `compatible_failed`, force:

```js
cardsByKey.interface_parsing.state = 'waiting_artifact_confirmation'
cardsByKey.interface_parsing.currentAction = '数据契约与界面预览不兼容，需要确认调整'
```

- [x] **Step 3: Add backend compatibility metadata**

In `DataIntegrationOutput`, add:

```go
Compatibility struct {
	Status string `json:"status"`
	MissingFields []string `json:"missingFields"`
	ConfirmedFallbacks []string `json:"confirmedFallbacks"`
} `json:"compatibility"`
```

In `ValidateDataIntegration`, fail if status is `failed` and no `NeedsUserInput` question is present:

```go
if raw.Compatibility.Status == "failed" && !raw.NeedsUserInput {
	return StepOutput{}, raw, fmt.Errorf("interface data compatibility requires user confirmation: %w", ErrSchemaValidationFailed)
}
```

- [x] **Step 4: Run checks**

Run:

```bash
go test ./factory-server/internal/runner -run DataIntegration -count=1
npm --prefix sf-portal-mvp run check:workbench-orchestration
```

Expected: pass.

- [x] **Step 5: Commit**

```bash
git add factory-server/internal/runner/contracts.go factory-server/internal/executor/claude_runner.go sf-portal-mvp/src/hooks/workbenchOrchestrationState.js sf-portal-mvp/scripts/check-workbench-orchestration-adjustment.mjs
git commit -m "feat: gate interface data compatibility"
```

## Task 14: Final Integration and Verification

**Files:**
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/src/hooks/useDialogueSessions.js`
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `factory-server/internal/server/dialogue_handlers.go`

- [x] **Step 1: Run backend focused suite**

Run:

```bash
go test ./factory-server/internal/store ./factory-server/internal/server ./factory-server/internal/runner ./factory-server/internal/executor -count=1
```

Expected: all packages pass.

- [x] **Step 2: Run frontend logic checks**

Run:

```bash
npm --prefix sf-portal-mvp run check:workbench-orchestration
node sf-portal-mvp/scripts/check-dialogue-workbench.mjs
node sf-portal-mvp/scripts/check-collaboration-plan.mjs
node sf-portal-mvp/scripts/check-chat-input-sizing.mjs
node sf-portal-mvp/scripts/check-application-project-drawer.mjs
```

Expected: all scripts complete without assertion errors.

- [x] **Step 3: Build frontend**

Run:

```bash
npm --prefix sf-portal-mvp run build
```

Expected: Vite build succeeds and emits `sf-portal-mvp/dist`.

- [x] **Step 4: Run full Go suite**

Run:

```bash
go test ./factory-server/...
```

Expected: all packages pass.

- [ ] **Step 5: Manual smoke** — _deferred: requires running factory-server + portal; all automated gates (go test ./..., npm build, all check scripts, git diff --check) are green_

Start the local services with the repository's normal development command. In the workbench:

1. Open a fresh session.
2. Confirm the initial graph shows five grey cards.
3. Send a request.
4. Confirm `用户输入` pulses, then `业务逻辑` becomes active.
5. Upload a Markdown attachment and remove it before send; confirm the chip disappears.
6. Upload a Markdown attachment and send; confirm the submitted message shows an attachment reference.
7. Confirm business logic; confirm a generation task is created.
8. Open `docs/01-requirements.md` from the folded business card.
9. Confirm interface preview opens from the interface card.
10. Seed a data-fallback fixture by inserting a `work_trace_events` clarification row for the selected dialogue with payload `{"questions":[{"id":"fallback-internet","question":"本体接口不可用，是否降级为互联网抓取？","options":[{"value":"internet","label":"降级为互联网抓取","recommended":true},{"value":"ontology","label":"继续提供本体接口信息"}]}]}` and a matching `data_integration` step in `waiting_user`; confirm the data-flow track shows source failure and waits for user choice.
11. Confirm production delivery shows the current sub-stage without routine user confirmation.

- [x] **Step 6: Run whitespace and placeholder scans**

Run:

```bash
git diff --check
rg -n "T[B]D|TO[D]O|implement late[r]|appropriate error handlin[g]|handle edge case[s]|Write tests for the abov[e]|Similar to Tas[k]" docs/superpowers/plans/2026-06-30-conversation-workbench-orchestration-adjustment.md
```

Expected: `git diff --check` has no output and the `rg` command has no matches.

- [x] **Step 7: Commit integration fixes**

```bash
git add sf-portal-mvp/src factory-server/internal docs/superpowers/plans/2026-06-30-conversation-workbench-orchestration-adjustment.md
git commit -m "feat: integrate conversation workbench orchestration"
```

## Self-Review Checklist

- [x] The visible graph has exactly `用户输入`, `业务逻辑`, `界面解析`, `数据抓取`, and `生产交付`.
- [x] No visible aggregate graph card is named `协作编排`.
- [x] The internal collaboration plan and machine agent keys remain stable.
- [x] `业务逻辑` aggregates requirement analysis and domain analysis.
- [x] `界面解析` uses the design contract step and exposes both design document and preview.
- [x] `数据抓取` verifies ontology, then asks before internet fallback, then asks before demonstration-data fallback.
- [x] `生产交付` aggregates solution design, code generation, review, security review, test verification, product acceptance, image build, and deployment.
- [x] Session attachments are previewable, message-bound after send, and reference-deactivated rather than hard-deleted.
- [x] Credentials use controlled input and are redacted before persistence, SSE, logs, work traces, and project documents.
- [x] Early task-owned project documents can be previewed before code generation registers an application.
- [x] Requirement document consistency mismatch fails at the requirement-analysis boundary with `schema_validation_failed`.
- [x] Interface preview snapshot is retained and can become acceptance evidence after data compatibility passes.
- [x] Data contract compatibility failure routes back to interface confirmation rather than silently continuing.
- [x] Production delivery user waits can transition to failure when the user rejects a required confirmation.
- [x] The initial empty workbench shows the grey graph plus composer and no marketing empty state.

## Verification Commands

Run before handing off:

```bash
go test ./factory-server/internal/store ./factory-server/internal/server ./factory-server/internal/runner ./factory-server/internal/executor -count=1
npm --prefix sf-portal-mvp run check:workbench-orchestration
node sf-portal-mvp/scripts/check-dialogue-workbench.mjs
node sf-portal-mvp/scripts/check-collaboration-plan.mjs
node sf-portal-mvp/scripts/check-chat-input-sizing.mjs
npm --prefix sf-portal-mvp run build
go test ./factory-server/...
git diff --check
```
