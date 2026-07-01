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
assert.match(block, /原型预览/, 'agent block missing prototype preview copy')
assert.match(block, /确认原型并继续/, 'agent block missing confirm prototype action')
assert.match(block, /直接进入方案设计/, 'agent block missing continue action')
assert.match(workbench, /handlePrototypeFeedback/, 'workbench missing prototype feedback wiring')
assert.match(workbench, /cw-prototype-dock/, 'workbench missing bottom-right prototype dock')
assert.match(workbench, /PrototypePreviewModal/, 'workbench missing prototype preview modal')
assert.match(workbench, /<iframe/, 'prototype preview modal must render iframe')
assert.match(workbench, /确定原型并继续/, 'bottom-right dock missing confirm action')
assert.match(workbench, /预览原型/, 'bottom-right dock missing preview action')
assert.doesNotMatch(workbench, /thinking=\"\"/, 'workbench must not pass empty thinking into agent cards')
assert.match(workbench, /questionsForCard/, 'workbench must derive card questions from job step pendingQuestions')
assert.match(workbench, /thinkingForCard/, 'workbench must derive card thinking from task execution timeline')
assert.match(block, /onPickQuestion/, 'agent block must let users pick structured step questions')
assert.match(block, /cw-prototype-feedback/, 'prototype feedback must render inline after the user asks to revise')
assert.match(block, /提交修改意见/, 'prototype feedback form missing submit action')
assert.doesNotMatch(workbench, /window\.prompt\('请输入原型修改意见'\)/, 'prototype feedback must not use blocking prompt')

console.log('prototype handoff checks passed')


