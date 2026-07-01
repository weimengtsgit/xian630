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

console.log('prototype handoff checks passed')
