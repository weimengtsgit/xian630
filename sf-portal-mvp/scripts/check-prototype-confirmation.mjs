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
assert.equal(confirmedProto.outcome, 'confirmed', 'confirmed artifact => outcome "confirmed"')
assert.equal(confirmedProto.title, '原型已确认', 'confirmed artifact => title 原型已确认')
assert.equal(confirmedProto.detail, '确定原型并继续', 'confirmed artifact => detail 确定原型并继续')
assert.equal(confirmedProto.confirmLabel, '确定原型并继续', 'confirmLabel kept in sync with detail (back-compat)')
assert.equal(confirmedProto.artifact.kind, 'interface_preview', 'item must reference the interface_preview artifact')
assert.equal(confirmedProto.label, '原型预览', 'item must carry the artifact label')
assert.equal(confirmedProto.confirmedAt, '2026-07-01T10:01:00Z', 'item must carry the confirmation timestamp')

// ---- Case 1b: artifact.status === 'continued_without_confirmation' ----
// The user explicitly chose 继续不确认原型. The backend
// (factory-server/.../prototype_handlers.go) sets this status and advances the
// design_contract step IDENTICALLY to the confirm path, so a heuristic that only
// checks the step status CANNOT distinguish them — the artifact status is the
// only truthful signal. The card must NOT be labeled 原型已确认.
const continuedView = {
  session: { id: 'dlg_pc1b', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成管理系统' }],
  route: {},
  workbenchArtifacts: [
    {
      id: 'warf_pc1b',
      kind: 'interface_preview',
      label: '原型预览',
      previewUrl: '/api/jobs/j1/steps/s1/prototype/preview',
      updatedAt: '2026-07-01T10:02:00Z',
      status: 'continued_without_confirmation',
      jobId: 'j1',
      stepId: 's1',
    },
  ],
}
const continuedItems = buildDialogueTimeline(continuedView)
const continuedProto = continuedItems.find(it => it.type === 'prototype_confirmed')
assert.ok(continuedProto, 'a continued_without_confirmation artifact must still emit a prototype_confirmed item')
assert.equal(continuedProto.outcome, 'continued_without_confirmation', 'outcome must reflect the skip, not the confirm')
assert.equal(continuedProto.title, '原型未确认，已继续', 'title must say continued WITHOUT confirmation')
assert.doesNotMatch(continuedProto.title, /已确认/, 'the skip card must NEVER carry a 已确认 label')
assert.match(continuedProto.detail, /不确认原型/, 'the skip detail must explicitly say the prototype was NOT confirmed')

// ---- Case 2: fallback — step succeeded but artifact.status unknown ----
// The backend may not populate artifact.status yet; the design_contract step
// having moved past the gate (succeeded/completed) is the durable signal. In
// this case the outcome is genuinely UNKNOWN (could be confirm OR skip), so the
// card must be labeled NEUTRALLY — never 原型已确认.
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
const fallbackProto = fallbackItems.find(it => it.type === 'prototype_confirmed')
assert.ok(
  fallbackProto,
  'a succeeded design_contract step with an interface_preview artifact must emit a prototype_confirmed item (fallback derivation)',
)
assert.equal(fallbackProto.outcome, 'unknown', 'fallback (status not populated) => outcome "unknown"')
assert.doesNotMatch(fallbackProto.title, /已确认/, 'fallback card must NOT assert 原型已确认 (outcome is unknown)')
assert.match(fallbackProto.title, /原型阶段完成/, 'fallback card must use the neutral 原型阶段完成 label')

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
assert.match(workbenchJsx, /data-outcome=\{outcome\}/, 'the card must stamp the outcome discriminator on the DOM so styles/tests can branch')
assert.match(workbenchJsx, /MonitorCheck/, 'the retained card must render a prototype-preview affordance icon')
// The Dock (in-flight surface) is preserved alongside the durable record — Task 2 does not remove it.
assert.match(workbenchJsx, /PrototypeConfirmationDock/, 'the in-flight PrototypeConfirmationDock must remain for the pre-confirm case')

// ---- Static: the three outcome copy strings must live in the copy table ----
// (the JSX renders them via item.title/item.detail, so the literal strings live
// in dialogueTimeline.js's PROTOTYPE_OUTCOME_COPY — assert them here so a
// regression that re-collapses the three branches into one label is caught).
const timelineJs = readFileSync(new URL('../src/hooks/dialogueTimeline.js', import.meta.url), 'utf8')
assert.match(timelineJs, /原型已确认/, 'confirmed branch copy must exist in the copy table')
assert.match(timelineJs, /原型未确认，已继续/, 'continued-without-confirmation branch copy must exist (distinct from confirmed)')
assert.match(timelineJs, /原型阶段完成/, 'unknown/fallback branch copy must exist (neutral, not 原型已确认)')

console.log('check-prototype-confirmation: OK')
