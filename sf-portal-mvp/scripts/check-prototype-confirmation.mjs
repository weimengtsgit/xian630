// sf-portal-mvp/scripts/check-prototype-confirmation.mjs
//
// Task 2 (编排产物确认 glossary): a confirmed prototype (design_contract step)
// must leave a DURABLE retained record in the conversation timeline — not only
// the ephemeral PrototypeConfirmationDock. The Dock disappears once the gate is
// past, so without this record the user has no conversation-level trace of what
// was confirmed.
//
// This check exercises buildDialogueTimeline's derivation of the
// `prototype_confirmed` timeline item from existing frontend data
// (interface_preview workbench artifact + the confirm signal), plus a static
// assertion that ConversationWorkbench renders the item as a retained card.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

// ---- Case 1: artifact.status === 'confirmed' => durable item emitted ----
const confirmedView = {
  session: { id: 'dlg_pc1', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成管理系统' }],
  route: {},
  workbenchArtifacts: [
    {
      id: 'warf_pc1',
      kind: 'interface_preview',
      label: '原型预览',
      previewUrl: '/api/jobs/j1/steps/s1/prototype/preview',
      updatedAt: '2026-07-01T10:01:00Z',
      status: 'confirmed',
      jobId: 'j1',
      stepId: 's1',
    },
  ],
}
const confirmedItems = buildDialogueTimeline(confirmedView)
const confirmedProto = confirmedItems.find(it => it.type === 'prototype_confirmed')
assert.ok(confirmedProto, 'a confirmed interface_preview artifact must emit a prototype_confirmed item')
assert.equal(confirmedProto.confirmLabel, '确定原型并继续', 'item must carry the confirm action label')
assert.equal(confirmedProto.artifact.kind, 'interface_preview', 'item must reference the interface_preview artifact')
assert.equal(confirmedProto.label, '原型预览', 'item must carry the artifact label')
assert.equal(confirmedProto.confirmedAt, '2026-07-01T10:01:00Z', 'item must carry the confirmation timestamp')

// ---- Case 2: fallback — step succeeded but artifact.status not 'confirmed' ----
// The backend may not populate artifact.status yet; the design_contract step
// having moved past the gate (succeeded/completed) is the durable signal.
const fallbackView = {
  session: { id: 'dlg_pc2', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成管理系统' }],
  route: {},
  workbenchArtifacts: [
    {
      id: 'warf_pc2',
      kind: 'interface_preview',
      label: '原型预览',
      previewUrl: '/api/x',
      stepId: 's1',
      status: 'active',
    },
  ],
}
const stepBlocks = [{ stepId: 's1', kind: 'design_contract', status: 'succeeded', name: 'design_contract' }]
const fallbackItems = buildDialogueTimeline(fallbackView, null, null, null, [], null, stepBlocks)
assert.ok(
  fallbackItems.some(it => it.type === 'prototype_confirmed'),
  'a succeeded design_contract step with an interface_preview artifact must emit a prototype_confirmed item (fallback derivation)',
)

// ---- Case 3: negative — step still waiting_user (gate NOT past) => NO item ----
const waitingView = {
  session: { id: 'dlg_pc3', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成管理系统' }],
  route: {},
  workbenchArtifacts: [
    {
      id: 'warf_pc3',
      kind: 'interface_preview',
      label: '原型预览',
      previewUrl: '/api/x',
      stepId: 's1',
      status: 'active',
    },
  ],
}
const waitingBlocks = [{ stepId: 's1', kind: 'design_contract', status: 'waiting_user', name: 'design_contract' }]
const waitingItems = buildDialogueTimeline(waitingView, null, null, null, [], null, waitingBlocks)
assert.equal(
  waitingItems.some(it => it.type === 'prototype_confirmed'),
  false,
  'a waiting_user design_contract step must NOT emit a durable item (the Dock still owns the in-flight confirm)',
)

// ---- Case 4: no interface_preview artifact => NO item (nothing to confirm) ----
const noArtifactView = {
  session: { id: 'dlg_pc4', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成管理系统' }],
  route: {},
  workbenchArtifacts: [],
}
const noArtifactItems = buildDialogueTimeline(noArtifactView)
assert.equal(
  noArtifactItems.some(it => it.type === 'prototype_confirmed'),
  false,
  'no interface_preview artifact => no prototype_confirmed item',
)

// ---- Static: ConversationWorkbench must render the item as a retained card ----
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
assert.match(workbenchJsx, /item\.type === 'prototype_confirmed'/, 'ConversationWorkbench must render a prototype_confirmed branch')
assert.match(workbenchJsx, /cw-prototype-confirmed/, 'the retained prototype_confirmed card must have a dedicated class')
assert.match(workbenchJsx, /原型已确认/, 'the retained card must label itself as a confirmed prototype')
assert.match(workbenchJsx, /MonitorCheck/, 'the retained card must render a prototype-preview affordance icon')
// The Dock (in-flight surface) is preserved alongside the durable record — Task 2 does not remove it.
assert.match(workbenchJsx, /PrototypeConfirmationDock/, 'the in-flight PrototypeConfirmationDock must remain for the pre-confirm case')

console.log('check-prototype-confirmation: OK')
