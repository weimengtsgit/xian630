import assert from 'node:assert/strict'
import { parseDialogMessages } from '../src/hooks/useAgentAuthoringDialog.js'

// --- Parse user and agent messages ---
const apiMessages = [
  { id: 'u1', role: 'user', kind: 'prompt', content: '创建海事预警智能体' },
  { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '正在分析业务场景' },
  {
    id: 'd1',
    role: 'agent',
    kind: 'agent_draft',
    content: '已根据对话更新智能体预览',
    metadata_json: JSON.stringify({
      key: 'maritime-alert-expert',
      name: '海事预警专家',
      description: '海事异常航迹监控',
      prompt: '你是海事预警专家。请关注以下业务要求...',
      enabled: true,
    }),
  },
]

const result = parseDialogMessages(apiMessages)
assert.equal(result.messages.length, 3, 'should have 3 messages')

// User message
assert.equal(result.messages[0].role, 'user')
assert.equal(result.messages[0].content, '创建海事预警智能体')

// Agent analysis message
assert.equal(result.messages[1].role, 'agent')
assert.equal(result.messages[1].kind, 'analysis_work_log')
assert.equal(result.messages[1].content, '正在分析业务场景')

// Agent draft message
assert.equal(result.messages[2].role, 'agent')
assert.equal(result.messages[2].kind, 'agent_draft')
assert.equal(result.messages[2].draft.name, '海事预警专家')
assert.equal(result.messages[2].draft.key, 'maritime-alert-expert')

// Draft extracted
assert.equal(result.draft.name, '海事预警专家')
assert.equal(result.draft.key, 'maritime-alert-expert')
assert.equal(result.draft.prompt, '你是海事预警专家。请关注以下业务要求...')

// --- Invalid metadata_json is skipped ---
const badMessages = [
  {
    id: 'd2',
    role: 'agent',
    kind: 'agent_draft',
    content: '',
    metadata_json: 'not valid json',
  },
]
const badResult = parseDialogMessages(badMessages)
assert.equal(badResult.messages.length, 0, 'invalid agent_draft must be skipped')
assert.equal(badResult.draft, null, 'no draft when metadata is invalid')

// --- Empty input ---
const emptyResult = parseDialogMessages([])
assert.equal(emptyResult.messages.length, 0)
assert.equal(emptyResult.draft, null)

// --- Latest draft wins ---
const multiDraft = [
  {
    id: 'd3',
    role: 'agent',
    kind: 'agent_draft',
    content: 'v1',
    metadata_json: JSON.stringify({ key: 'v1', name: 'V1', prompt: 'prompt1' }),
  },
  {
    id: 'd4',
    role: 'agent',
    kind: 'agent_draft',
    content: 'v2',
    metadata_json: JSON.stringify({ key: 'v2', name: 'V2', prompt: 'prompt2' }),
  },
]
const multiResult = parseDialogMessages(multiDraft)
assert.equal(multiResult.draft.name, 'V2', 'latest draft should win')
assert.equal(multiResult.draft.key, 'v2')

// --- System messages (role !== user/agent) are filtered ---
const withSystem = [
  { id: 's1', role: 'system', kind: 'status', content: 'session created' },
  { id: 'u1', role: 'user', kind: 'prompt', content: 'hello' },
]
const sysResult = parseDialogMessages(withSystem)
assert.equal(sysResult.messages.length, 1, 'system messages should be filtered out')
assert.equal(sysResult.messages[0].role, 'user')

// --- Source scan: AgentAuthoringDialog.jsx exists and has required structure ---
import { readFileSync } from 'node:fs'
const dialogSource = readFileSync(new URL('../src/components/AgentAuthoringDialog.jsx', import.meta.url), 'utf8')

assert.match(dialogSource, /agent-dialog-backdrop/, 'must use agent-dialog-backdrop class')
assert.match(dialogSource, /authoring-dialog/, 'must have authoring-dialog class')
assert.match(dialogSource, /authoring-bubble/, 'must have chat bubble class')
assert.match(dialogSource, /authoring-draft-card/, 'must have draft card class')
assert.match(dialogSource, /保存智能体/, 'must have save button with Chinese label')
assert.match(dialogSource, /onSend/, 'must accept onSend prop')
assert.match(dialogSource, /onSave/, 'must accept onSave prop')
assert.match(dialogSource, /onClose/, 'must accept onClose prop')

console.log('check-agent-authoring-dialog-hook: OK')
