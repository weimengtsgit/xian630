import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('src/api/client.js', 'utf8')
const hook = fs.existsSync('src/hooks/prototypeState.js') ? fs.readFileSync('src/hooks/prototypeState.js', 'utf8') : ''
const block = fs.readFileSync('src/components/WorkbenchAgentBlock.jsx', 'utf8')
const workbench = fs.readFileSync('src/components/ConversationWorkbench.jsx', 'utf8')

for (const token of [
  'getJobPrototype',
  'getJobPrototypePreviewUrl',
  'sendPrototypeFeedback',
  'confirmPrototype',
  'continuePrototypeWithoutConfirmation',
]) {
  assert.match(client, new RegExp(token), `client missing ${token}`)
}

assert.match(hook, /normalizePrototypeSummary/, 'prototypeState hook missing normalizer')
assert.match(fs.readFileSync('src/hooks/workbenchOrchestrationState.js', 'utf8'), /stepId: String\(item\.stepId/, 'artifact normalization must preserve stepId')
// Task 1 moved the prototype preview/confirm/feedback affordances OUT of the
// in-conversation WorkbenchAgentBlock (the block now renders a generic artifact
// list + a stage-level confirm button). The prototype preview label surfaces at
// runtime via the artifact's own `label` field rendered by ArtifactList, and the
// MonitorCheck icon distinguishes an interface_preview artifact. The explicit
// 确认原型并继续 / 直接进入方案设计 / 修改意见 affordances moved to the
// PrototypeConfirmationDock in ConversationWorkbench, asserted below.
assert.match(block, /MonitorCheck/, 'agent block must distinguish interface_preview artifacts with a MonitorCheck icon')
assert.match(block, /ArtifactList/, 'agent block must render previewable artifacts via the shared ArtifactList')
assert.match(workbench, /handlePrototypeFeedback/, 'workbench missing prototype feedback wiring')
assert.match(workbench, /cw-prototype-dock/, 'workbench missing bottom-right prototype dock')
assert.match(workbench, /InterfacePreviewModal/, 'workbench must open the prototype preview via the shared InterfacePreviewModal')
assert.match(workbench, /<iframe/, 'prototype preview modal must render iframe')
assert.match(workbench, /确定原型并继续/, 'bottom-right dock missing confirm action')
assert.match(workbench, /预览原型/, 'bottom-right dock missing preview action')
assert.match(workbench, /提出修改意见/, 'prototype feedback affordance must live in the workbench dock')
assert.match(workbench, /请描述您的修改意见/, 'prototype feedback form must capture the feedback text in-app')
assert.doesNotMatch(workbench, /thinking=\"\"/, 'workbench must not pass empty thinking into agent cards')
assert.match(workbench, /questionsForCard/, 'workbench must derive card questions from job step pendingQuestions')
assert.match(workbench, /thinkingForCard/, 'workbench must derive card thinking from task execution timeline')
// Task 3: card-level structured questions are answered IN-CARD via an in-card
// submit (cw-clarification-submit → onSubmitClarification → onSend → answerJob).
// The old handlePickCardQuestion composer-refill path is gone (澄清交互卡片
// _Avoid_: 输入框回填选项, 卡片外提交).
assert.match(workbench, /onSubmitClarification/, 'workbench must let users answer card-level structured questions in-card (onSubmitClarification)')
assert.match(workbench, /cw-clarification-submit/, 'the in-card submit affordance must exist on the clarification card')
assert.doesNotMatch(workbench, /handlePickCardQuestion/, 'the composer-refill path (handlePickCardQuestion) must be removed')
assert.doesNotMatch(workbench, /window\.prompt\('请输入原型修改意见'\)/, 'prototype feedback must not use blocking prompt')
// Task 2: a confirmed prototype must also leave a DURABLE timeline record (not
// just the ephemeral Dock). The retained prototype_confirmed card lives in the
// ConversationWorkbench timeline renderer.
assert.match(workbench, /prototype_confirmed/, 'workbench must render the durable prototype_confirmed timeline card')

console.log('prototype handoff checks passed')



