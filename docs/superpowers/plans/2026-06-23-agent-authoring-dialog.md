# Agent Authoring Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move agent creation from the center ConversationWorkbench into a self-contained modal dialog with a chat-bubble UI.

**Architecture:** A new `AgentAuthoringDialog` component renders a modal with chat bubbles. A dedicated `useAgentAuthoringDialog` hook manages an independent `agent_authoring` clarification session via request-response API calls (no SSE). The dialog reuses the existing Clarification API (`createClarification`, `sendClarificationMessage`, `getClarificationMessages`, `createBusinessAgent`, `confirmClarification`).

**Tech Stack:** React 18, Vite, lucide-react icons, existing `factoryApi` client.

## Global Constraints

- No backend changes — reuse existing Clarification API endpoints.
- Dialog session is independent from the center ConversationWorkbench session.
- No SSE streaming — use request-response pattern only.
- Welcome message is a static frontend string, not an API call.
- Save button requires `draft.name`, `draft.key`, and `draft.prompt` to be present.

---

### Task 1: Create `useAgentAuthoringDialog` Hook

**Files:**
- Create: `sf-portal-mvp/src/hooks/useAgentAuthoringDialog.js`
- Create: `sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs`

**Interfaces:**
- Consumes: `factoryApi.createClarification`, `factoryApi.sendClarificationMessage`, `factoryApi.getClarificationMessages`, `factoryApi.createBusinessAgent`, `factoryApi.confirmClarification`
- Produces: `useAgentAuthoringDialog(onRefreshAgents)` → `{ open, messages, draft, sending, saving, error, openDialog, closeDialog, sendMessage, saveAgent }`
- Also exports: `parseDialogMessages(apiMessages)` (pure function for testing)

- [ ] **Step 1: Write the logic test for `parseDialogMessages`**

Create `sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs`:

```js
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

console.log('check-agent-authoring-dialog-hook: OK')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs`
Expected: FAIL — `parseDialogMessages` is not defined yet.

- [ ] **Step 3: Implement `useAgentAuthoringDialog.js`**

Create `sf-portal-mvp/src/hooks/useAgentAuthoringDialog.js`:

```js
import { useCallback, useState } from 'react'
import { factoryApi } from '../api/client'

const WELCOME_MESSAGE = {
  id: 'welcome',
  role: 'agent',
  kind: 'welcome',
  content: '你好！请描述你需要创建的业务智能体，包括业务场景、关注的数据和规则。',
}

function parseJSON(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseDialogMessages(apiMessages) {
  const messages = []
  let draft = null
  for (const msg of apiMessages || []) {
    if (msg.role === 'user') {
      messages.push({ id: msg.id, role: 'user', kind: msg.kind, content: msg.content || '' })
      continue
    }
    if (msg.role === 'agent') {
      if (msg.kind === 'agent_draft') {
        const parsed = parseJSON(msg.metadata_json)
        if (!parsed) continue
        messages.push({ id: msg.id, role: 'agent', kind: 'agent_draft', content: msg.content || '', draft: parsed })
        draft = parsed
      } else {
        messages.push({ id: msg.id, role: 'agent', kind: msg.kind, content: msg.content || '' })
      }
    }
  }
  return { messages, draft }
}

export function useAgentAuthoringDialog(onRefreshAgents) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([WELCOME_MESSAGE])
  const [draft, setDraft] = useState(null)
  const [sessionId, setSessionId] = useState(null)
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const openDialog = useCallback(() => {
    setOpen(true)
    setMessages([WELCOME_MESSAGE])
    setDraft(null)
    setSessionId(null)
    setSending(false)
    setSaving(false)
    setError(null)
  }, [])

  const closeDialog = useCallback(() => {
    setOpen(false)
    setMessages([WELCOME_MESSAGE])
    setDraft(null)
    setSessionId(null)
    setSending(false)
    setSaving(false)
    setError(null)
  }, [])

  const sendMessage = useCallback(async (text) => {
    const prompt = String(text || '').trim()
    if (!prompt || sending) return
    setSending(true)
    setError(null)
    try {
      let sid = sessionId
      if (!sid) {
        const session = await factoryApi.createClarification(prompt, { mode: 'agent_authoring' })
        sid = session.id
        setSessionId(sid)
      } else {
        await factoryApi.sendClarificationMessage(sid, prompt)
      }
      const apiMessages = await factoryApi.getClarificationMessages(sid)
      const parsed = parseDialogMessages(apiMessages)
      setMessages([WELCOME_MESSAGE, ...parsed.messages])
      setDraft(parsed.draft)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setSending(false)
    }
  }, [sessionId, sending])

  const saveAgent = useCallback(async () => {
    if (!draft || !draft.name || !draft.key || !draft.prompt || !sessionId) return
    setSaving(true)
    setError(null)
    try {
      await factoryApi.createBusinessAgent({
        key: draft.key,
        name: draft.name,
        description: draft.description || '',
        prompt: draft.prompt,
        enabled: true,
      })
      await factoryApi.confirmClarification(sessionId)
      if (onRefreshAgents) await onRefreshAgents()
      closeDialog()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setSaving(false)
    }
  }, [draft, sessionId, onRefreshAgents, closeDialog])

  return {
    open,
    messages,
    draft,
    sending,
    saving,
    error,
    openDialog,
    closeDialog,
    sendMessage,
    saveAgent,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs`
Expected: `check-agent-authoring-dialog-hook: OK`

- [ ] **Step 5: Commit**

```bash
git add sf-portal-mvp/src/hooks/useAgentAuthoringDialog.js sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs
git commit -m "feat: add useAgentAuthoringDialog hook with message parsing"
```

---

### Task 2: Create `AgentAuthoringDialog` Component + CSS

**Files:**
- Create: `sf-portal-mvp/src/components/AgentAuthoringDialog.jsx`
- Create: `sf-portal-mvp/src/components/AgentAuthoringDialog.css`
- Modify: `sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs` (add source scan assertions)

**Interfaces:**
- Consumes: `useAgentAuthoringDialog` hook return values (`open`, `messages`, `draft`, `sending`, `saving`, `error`, `closeDialog`, `sendMessage`, `saveAgent`)
- Produces: `<AgentAuthoringDialog ... />` React component

- [ ] **Step 1: Add source scan assertions to the test**

Append to `sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs` (before the `console.log` line):

```js
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
```

- [ ] **Step 2: Run test to verify new assertions fail**

Run: `node sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs`
Expected: FAIL — `AgentAuthoringDialog.jsx` does not exist yet.

- [ ] **Step 3: Create `AgentAuthoringDialog.jsx`**

Create `sf-portal-mvp/src/components/AgentAuthoringDialog.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react'
import { Loader2, Send, X } from 'lucide-react'
import './AgentAuthoringDialog.css'

export function AgentAuthoringDialog({ open, messages, draft, sending, saving, error, onClose, onSend, onSave }) {
  const [input, setInput] = useState('')
  const bodyRef = useRef(null)

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (!open) setInput('')
  }, [open])

  if (!open) return null

  const handleSend = async () => {
    const value = input.trim()
    if (!value || sending) return
    setInput('')
    await onSend(value)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSave = draft && draft.name && draft.key && draft.prompt

  return (
    <div className="agent-dialog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="agent-dialog authoring-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="创建业务智能体"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-dialog-header">
          <h3>创建业务智能体</h3>
          <button
            type="button"
            className="agent-icon-button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="authoring-body" ref={bodyRef}>
          {messages.map((msg) => (
            <ChatBubble key={msg.id} message={msg} />
          ))}
          {sending && (
            <div className="authoring-bubble authoring-bubble-agent">
              <Loader2 size={14} className="spin" />
              <span className="authoring-thinking">思考中...</span>
            </div>
          )}
        </div>

        {error && <div className="authoring-error">{error}</div>}

        <div className="authoring-input-area">
          <div className="authoring-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述业务场景、规则或补充说明..."
              disabled={sending || saving}
              rows={1}
            />
            <button
              type="button"
              className="authoring-send-btn"
              onClick={handleSend}
              disabled={!input.trim() || sending || saving}
              title="发送"
              aria-label="发送"
            >
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            </button>
          </div>
          <div className="authoring-actions">
            <button
              type="button"
              className="agent-secondary-button"
              onClick={onClose}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="agent-primary-button"
              onClick={onSave}
              disabled={!canSave || sending || saving}
              title={canSave ? '保存智能体' : '请继续描述以完善智能体信息'}
            >
              {saving ? '保存中...' : '保存智能体'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function ChatBubble({ message }) {
  if (message.role === 'user') {
    return (
      <div className="authoring-bubble authoring-bubble-user">
        {message.content}
      </div>
    )
  }
  return (
    <div className="authoring-bubble authoring-bubble-agent">
      <div className="authoring-bubble-text">{message.content}</div>
      {message.kind === 'agent_draft' && message.draft && (
        <DraftCard draft={message.draft} />
      )}
    </div>
  )
}

function DraftCard({ draft }) {
  return (
    <div className="authoring-draft-card">
      <dl className="authoring-draft-grid">
        <div><dt>名称</dt><dd>{draft.name || '-'}</dd></div>
        <div><dt>标识</dt><dd>{draft.key || '-'}</dd></div>
        <div><dt>描述</dt><dd>{draft.description || '-'}</dd></div>
      </dl>
      <div className="authoring-draft-prompt">
        <strong>最终提示词</strong>
        <pre>{draft.prompt || '待生成...'}</pre>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create `AgentAuthoringDialog.css`**

Create `sf-portal-mvp/src/components/AgentAuthoringDialog.css`:

```css
.authoring-dialog {
  width: min(520px, 90vw);
  max-height: min(600px, 80vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.authoring-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.authoring-bubble {
  max-width: 85%;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: #d4ecf7;
  word-break: break-word;
}

.authoring-bubble-agent {
  align-self: flex-start;
  border: 1px solid rgba(111, 218, 255, 0.14);
  border-left: 3px solid rgba(104, 221, 255, 0.5);
  background: rgba(3, 17, 29, 0.62);
}

.authoring-bubble-user {
  align-self: flex-end;
  border: 1px solid rgba(127, 235, 155, 0.2);
  border-right: 3px solid rgba(127, 235, 155, 0.55);
  background: rgba(127, 235, 155, 0.07);
  color: #d4ecf7;
}

.authoring-bubble-text {
  margin-bottom: 4px;
}

.authoring-thinking {
  color: #8fb0bf;
  font-size: 12px;
  margin-left: 6px;
}

.authoring-draft-card {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid rgba(111, 218, 255, 0.2);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.22);
}

.authoring-draft-grid {
  display: grid;
  gap: 4px;
  margin: 0;
}

.authoring-draft-grid div {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 6px;
  align-items: baseline;
}

.authoring-draft-grid dt {
  color: #8fb0bf;
  font-size: 11px;
}

.authoring-draft-grid dd {
  margin: 0;
  color: #d4ecf7;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.authoring-draft-prompt {
  margin-top: 8px;
}

.authoring-draft-prompt strong {
  color: #8fb0bf;
  font-size: 11px;
  font-weight: 600;
  display: block;
  margin-bottom: 4px;
}

.authoring-draft-prompt pre {
  max-height: 120px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid rgba(111, 218, 255, 0.14);
  border-radius: 4px;
  color: #d4ecf7;
  background: rgba(0, 0, 0, 0.22);
  font-family: 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.authoring-error {
  margin: 0 16px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 102, 94, 0.24);
  border-radius: 6px;
  color: #ff8e88;
  background: rgba(255, 102, 94, 0.08);
  font-size: 12px;
  line-height: 1.4;
}

.authoring-input-area {
  padding: 12px 16px;
  border-top: 1px solid rgba(111, 218, 255, 0.14);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.authoring-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px;
  gap: 8px;
  align-items: end;
}

.authoring-input-row textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid rgba(111, 218, 255, 0.2);
  border-radius: 6px;
  padding: 8px 9px;
  color: #edfaff;
  background: rgba(3, 17, 29, 0.86);
  font: inherit;
  font-size: 12px;
  resize: none;
  outline: none;
}

.authoring-input-row textarea:focus {
  border-color: rgba(104, 221, 255, 0.56);
  box-shadow: 0 0 0 2px rgba(104, 221, 255, 0.1);
}

.authoring-input-row textarea::placeholder {
  color: rgba(143, 176, 191, 0.6);
}

.authoring-input-row textarea:disabled {
  cursor: not-allowed;
  opacity: 0.66;
}

.authoring-send-btn {
  width: 32px;
  height: 32px;
  border: 1px solid rgba(111, 218, 255, 0.28);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #68ddff;
  background: rgba(104, 221, 255, 0.08);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s, color 0.2s;
}

.authoring-send-btn:hover:not(:disabled) {
  border-color: rgba(111, 218, 255, 0.48);
  background: rgba(104, 221, 255, 0.14);
  color: #edfaff;
}

.authoring-send-btn:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.authoring-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.authoring-body::-webkit-scrollbar {
  width: 6px;
}

.authoring-body::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 3px;
}

.authoring-body::-webkit-scrollbar-thumb {
  background: rgba(111, 218, 255, 0.24);
  border-radius: 3px;
}

.authoring-body::-webkit-scrollbar-thumb:hover {
  background: rgba(111, 218, 255, 0.4);
}

.spin {
  animation: authoring-spin 1s linear infinite;
}

@keyframes authoring-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 5: Run test to verify all assertions pass**

Run: `node sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs`
Expected: `check-agent-authoring-dialog-hook: OK`

- [ ] **Step 6: Commit**

```bash
git add sf-portal-mvp/src/components/AgentAuthoringDialog.jsx sf-portal-mvp/src/components/AgentAuthoringDialog.css sf-portal-mvp/scripts/check-agent-authoring-dialog-hook.mjs
git commit -m "feat: add AgentAuthoringDialog component with chat-bubble UI"
```

---

### Task 3: Wire Dialog into AgentsPanel + App.jsx

**Files:**
- Modify: `sf-portal-mvp/src/components/AgentsPanel.jsx`
- Modify: `sf-portal-mvp/src/App.jsx`
- Modify: `sf-portal-mvp/scripts/check-agent-authoring-dialog.mjs`

**Interfaces:**
- Consumes: `useAgentAuthoringDialog` hook (from Task 1), `AgentAuthoringDialog` component (from Task 2)
- Produces: Working "新建业务智能体" flow that opens the dialog, allows conversation, and saves agents

- [ ] **Step 1: Update source scan test for new dialog integration**

Replace the contents of `sf-portal-mvp/scripts/check-agent-authoring-dialog.mjs`:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

// Old authoring modal code must be removed
assert.doesNotMatch(source, /emptyAuthoringState/, 'emptyAuthoringState must be removed')
assert.doesNotMatch(source, /authoringOpen/, 'authoringOpen state must be removed')
assert.doesNotMatch(source, /ensureAuthoringSession/, 'ensureAuthoringSession must be removed')
assert.doesNotMatch(source, /sendAuthoringContent/, 'sendAuthoringContent must be removed')
assert.doesNotMatch(source, /finalizeAuthoring/, 'finalizeAuthoring must be removed')

// Old props that are no longer needed must be removed
assert.doesNotMatch(source, /onStartAuthoring/, 'onStartAuthoring prop must be removed (replaced by dialog)')
assert.doesNotMatch(source, /onCreateAuthoringSession/, 'onCreateAuthoringSession prop must be removed')
assert.doesNotMatch(source, /onSendAuthoringMessage/, 'onSendAuthoringMessage prop must be removed')

// New: dialog integration
assert.match(source, /useAgentAuthoringDialog/, 'must use useAgentAuthoringDialog hook')
assert.match(source, /AgentAuthoringDialog/, 'must render AgentAuthoringDialog component')
assert.match(source, /onRefreshAgents/, 'must accept onRefreshAgents prop')
assert.match(source, /openAuthoringDialog/, 'must call openAuthoringDialog on create button')

// Agent detail and edit functionality must still be present
assert.match(source, /onCreateBusinessAgent/, 'onCreateBusinessAgent prop must still exist')
assert.match(source, /onUpdateBusinessAgent/, 'onUpdateBusinessAgent prop must still exist')

console.log('check-agent-authoring-dialog: OK')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node sf-portal-mvp/scripts/check-agent-authoring-dialog.mjs`
Expected: FAIL — AgentsPanel doesn't use `useAgentAuthoringDialog` yet.

- [ ] **Step 3: Update `AgentsPanel.jsx`**

Modify `sf-portal-mvp/src/components/AgentsPanel.jsx`:

1. Add imports at the top (after existing imports):

```jsx
import { useAgentAuthoringDialog } from '../hooks/useAgentAuthoringDialog'
import { AgentAuthoringDialog } from './AgentAuthoringDialog'
```

2. Change props: remove `onStartAuthoring`, add `onRefreshAgents`:

```jsx
export function AgentsPanel({
  agents,
  softwareAgents,
  businessAgents,
  loading,
  error,
  selectedBusinessAgentIds = [],
  onAddBusinessAgent,
  onRemoveBusinessAgent,
  onCreateBusinessAgent,
  onUpdateBusinessAgent,
  onSetBusinessAgentEnabled,
  onRefreshAgents,
}) {
```

3. Add the hook call inside the component (after the existing state declarations):

```jsx
  const authoring = useAgentAuthoringDialog(onRefreshAgents)
```

4. Replace the `handleCreateBusinessAgent` function:

```jsx
  const handleCreateBusinessAgent = () => {
    setPanelError('')
    authoring.openDialog()
  }
```

5. Add the dialog render at the bottom of the JSX, right before the closing `</div>` of the panel:

```jsx
      <AgentAuthoringDialog
        open={authoring.open}
        messages={authoring.messages}
        draft={authoring.draft}
        sending={authoring.sending}
        saving={authoring.saving}
        error={authoring.error}
        onClose={authoring.closeDialog}
        onSend={authoring.sendMessage}
        onSave={authoring.saveAgent}
      />
```

The full file after all changes should look like:

```jsx
import { useMemo, useState } from 'react'
import { Bot, Pencil, Plus, Power, Save, X } from 'lucide-react'
import { applySelectedBusinessAgents, splitAgentsByCategory } from '../hooks/agentList'
import { useAgentAuthoringDialog } from '../hooks/useAgentAuthoringDialog'
import { AgentAuthoringDialog } from './AgentAuthoringDialog'
import './AgentsPanel.css'

const emptyEditForm = {
  name: '',
  description: '',
  prompt: '',
  enabled: true,
}

function agentIdentity(agent) {
  return agent?.id || agent?.key || agent?.agent_key || ''
}

function agentKey(agent) {
  return agent?.key || agent?.agent_key || agent?.id || ''
}

function isEnabled(agent) {
  return agent?.enabled === undefined ? true : Boolean(agent.enabled)
}

function promptText(agent) {
  return agent?.prompt || agent?.final_prompt || '暂无提示词'
}

function tabLabel(tab) {
  return tab === 'software' ? '软件开发智能体' : '业务智能体'
}

export function AgentsPanel({
  agents,
  softwareAgents,
  businessAgents,
  loading,
  error,
  selectedBusinessAgentIds = [],
  onAddBusinessAgent,
  onRemoveBusinessAgent,
  onCreateBusinessAgent,
  onUpdateBusinessAgent,
  onSetBusinessAgentEnabled,
  onRefreshAgents,
}) {
  const [activeTab, setActiveTab] = useState('software')
  const [selectedId, setSelectedId] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState(emptyEditForm)
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [panelError, setPanelError] = useState('')

  const authoring = useAgentAuthoringDialog(onRefreshAgents)

  const splitFallback = useMemo(() => splitAgentsByCategory(agents), [agents])
  const softwareList = useMemo(
    () => (Array.isArray(softwareAgents) ? softwareAgents : splitFallback.software),
    [softwareAgents, splitFallback.software],
  )
  const businessBaseList = useMemo(
    () => (Array.isArray(businessAgents) ? businessAgents : splitFallback.business),
    [businessAgents, splitFallback.business],
  )
  const businessList = useMemo(
    () => applySelectedBusinessAgents(businessBaseList, selectedBusinessAgentIds),
    [businessBaseList, selectedBusinessAgentIds],
  )
  const currentList = activeTab === 'software' ? softwareList : businessList

  const selectedAgent = useMemo(() => {
    const all = [...softwareList, ...businessList]
    return all.find(agent => agentIdentity(agent) === selectedId)
  }, [softwareList, businessList, selectedId])

  const selectedCount = selectedBusinessAgentIds.length

  const openAgentDetail = agent => {
    setPanelError('')
    setEditError('')
    setEditing(false)
    setSelectedId(agentIdentity(agent))
    setDetailOpen(true)
  }

  const closeAgentDetail = () => {
    if (editSaving) return
    setDetailOpen(false)
    setEditing(false)
    setEditError('')
  }

  const startEditing = () => {
    if (!selectedAgent || selectedAgent.category === 'software' || selectedAgent.editable === false) return
    setEditForm({
      name: selectedAgent.name || '',
      description: selectedAgent.description || '',
      prompt: selectedAgent.prompt || '',
      enabled: isEnabled(selectedAgent),
    })
    setEditError('')
    setEditing(true)
  }

  const updateEditForm = (field, value) => {
    setEditForm(current => ({ ...current, [field]: value }))
  }

  const saveBusinessAgent = async event => {
    event.preventDefault()
    if (!selectedAgent || !onUpdateBusinessAgent) return
    const name = editForm.name.trim()
    const prompt = editForm.prompt.trim()
    if (!name || !prompt) {
      setEditError('请填写名称和最终提示词')
      return
    }
    setEditSaving(true)
    setEditError('')
    try {
      const updated = await onUpdateBusinessAgent(selectedAgent.id, {
        name,
        description: editForm.description.trim(),
        prompt,
        enabled: editForm.enabled,
      })
      setSelectedId(updated.id || selectedAgent.id)
      setEditing(false)
    } catch (err) {
      setEditError(err.message || String(err))
    } finally {
      setEditSaving(false)
    }
  }

  const toggleBusinessAgentEnabled = async agent => {
    if (!agent?.id || !onSetBusinessAgentEnabled) return
    setPanelError('')
    try {
      await onSetBusinessAgentEnabled(agent.id, !isEnabled(agent))
    } catch (err) {
      setPanelError(err.message || String(err))
    }
  }

  const addBusinessAgent = async agent => {
    if (!agent?.id || !onAddBusinessAgent || !isEnabled(agent)) return
    setPanelError('')
    try {
      const next = await onAddBusinessAgent(agent)
      if (Array.isArray(next) && !next.some(item => item.id === agent.id)) {
        setPanelError('请先在会话工作台创建或选择一个会话，再加入业务智能体')
      }
    } catch (err) {
      setPanelError(err.message || String(err))
    }
  }

  const removeBusinessAgent = async agent => {
    if (!agent?.id || !onRemoveBusinessAgent) return
    setPanelError('')
    try {
      await onRemoveBusinessAgent(agent.id)
    } catch (err) {
      setPanelError(err.message || String(err))
    }
  }

  const handleCreateBusinessAgent = () => {
    setPanelError('')
    authoring.openDialog()
  }

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <h2>智能体</h2>
        <div className="agents-header-actions">
          <span className="panel-count">
            {activeTab === 'software' ? softwareList.length : businessList.length} 个
          </span>
          {activeTab === 'business' && (
            <button
              type="button"
              className="agent-icon-button"
              onClick={handleCreateBusinessAgent}
              title="创建业务智能体"
              aria-label="创建业务智能体"
            >
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="agent-tabs" role="tablist" aria-label="智能体分类">
        {['software', 'business'].map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`agent-tab ${activeTab === tab ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tabLabel(tab)}
            <span>{tab === 'software' ? softwareList.length : businessList.length}</span>
          </button>
        ))}
      </div>

      {activeTab === 'business' && selectedCount > 0 && (
        <div className="agent-selection-summary">本次会话已选择 {selectedCount} 个业务智能体</div>
      )}

      {(error || panelError) && (
        <div className="panel-error">{error ? `加载失败：${error}` : panelError}</div>
      )}

      <div className="panel-content">
        {loading && currentList.length === 0 ? (
          <div className="panel-loading">加载中...</div>
        ) : currentList.length === 0 ? (
          <div className="panel-loading">
            {error ? '无法连接到工厂服务' : `暂无${tabLabel(activeTab)}`}
          </div>
        ) : (
          <div className="agents-list">
            {currentList.map(agent => {
              const key = agentKey(agent)
              const enabled = isEnabled(agent)
              const selectedForConversation = Boolean(agent.isSelectedForConversation)
              return (
                <article
                  key={agentIdentity(agent)}
                  className={`agent-card ${enabled ? 'is-enabled' : 'is-disabled'} ${
                    selectedAgent?.id === agent.id ? 'is-selected' : ''
                  } ${selectedForConversation ? 'is-conversation-selected' : ''}`}
                >
                  <button
                    type="button"
                    className="agent-card-main"
                    onClick={() => openAgentDetail(agent)}
                  >
                    <div className="agent-avatar">
                      <Bot size={20} />
                    </div>
                    <div className="agent-info">
                      <div className="agent-name-row">
                        <h3 className="agent-name">{agent.name || key}</h3>
                        <span className={`agent-enabled-badge ${enabled ? 'on' : 'off'}`}>
                          {enabled ? '启用' : '停用'}
                        </span>
                      </div>
                      <div className="agent-meta">
                        <span className="agent-key">{key}</span>
                        {agent.role && <span className="agent-role">{agent.role}</span>}
                      </div>
                      {agent.description && <p className="agent-desc">{agent.description}</p>}
                    </div>
                  </button>

                  {activeTab === 'business' && (
                    <div className="agent-card-actions">
                      {selectedForConversation && (
                        <span className="agent-priority-badge">第 {agent.selectedPriority} 位</span>
                      )}
                      {selectedForConversation ? (
                        <button
                          type="button"
                          className="agent-secondary-button compact"
                          onClick={() => removeBusinessAgent(agent)}
                        >
                          移出会话
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="agent-primary-button compact"
                          onClick={() => addBusinessAgent(agent)}
                          disabled={!enabled}
                        >
                          加入会话
                        </button>
                      )}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>

      {detailOpen && selectedAgent && (
        <div className="agent-dialog-backdrop" role="presentation">
          <section className="agent-dialog agent-detail-dialog" role="dialog" aria-modal="true">
            <div className="agent-dialog-header">
              <h3>{selectedAgent.name || agentKey(selectedAgent)}</h3>
              <button
                type="button"
                className="agent-icon-button"
                onClick={closeAgentDetail}
                title="关闭"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div className="agent-detail-title">
              <span className="agent-detail-subtitle">
                {selectedAgent.category === 'software' ? '只读软件开发智能体' : '业务智能体详情'}
              </span>
              <span
                className={`agent-enabled-badge ${selectedAgent.enabled === false ? 'off' : 'on'}`}
              >
                {selectedAgent.enabled === false ? '停用' : '启用'}
              </span>
            </div>

            {!editing ? (
              <>
                <dl className="agent-detail-grid">
                  <div>
                    <dt>标识</dt>
                    <dd>{agentKey(selectedAgent) || '-'}</dd>
                  </div>
                  <div>
                    <dt>角色</dt>
                    <dd>{selectedAgent.role || '-'}</dd>
                  </div>
                  <div>
                    <dt>Claude Agent</dt>
                    <dd>{selectedAgent.claude_agent_name || '-'}</dd>
                  </div>
                  <div>
                    <dt>排序</dt>
                    <dd>{selectedAgent.sort_order ?? '-'}</dd>
                  </div>
                </dl>
                {selectedAgent.description && (
                  <p className="agent-detail-desc">{selectedAgent.description}</p>
                )}
                <div className="agent-prompt-section">
                  <h4>最终提示词</h4>
                  <pre className="agent-skills">{promptText(selectedAgent)}</pre>
                </div>
                {selectedAgent.category === 'business' && (
                  <div className="agent-dialog-actions">
                    <button
                      type="button"
                      className="agent-secondary-button"
                      onClick={() => toggleBusinessAgentEnabled(selectedAgent)}
                    >
                      <Power size={14} />
                      {isEnabled(selectedAgent) ? '停用' : '启用'}
                    </button>
                    <button type="button" className="agent-primary-button" onClick={startEditing}>
                      <Pencil size={14} />
                      编辑
                    </button>
                  </div>
                )}
              </>
            ) : (
              <form onSubmit={saveBusinessAgent}>
                <label className="agent-field">
                  <span>名称</span>
                  <input
                    value={editForm.name}
                    onChange={event => updateEditForm('name', event.target.value)}
                    disabled={editSaving}
                  />
                </label>
                <label className="agent-field">
                  <span>标识</span>
                  <input value={agentKey(selectedAgent)} disabled />
                </label>
                <label className="agent-field">
                  <span>描述</span>
                  <textarea
                    value={editForm.description}
                    onChange={event => updateEditForm('description', event.target.value)}
                    rows={3}
                    disabled={editSaving}
                  />
                </label>
                <label className="agent-field">
                  <span>最终提示词</span>
                  <textarea
                    value={editForm.prompt}
                    onChange={event => updateEditForm('prompt', event.target.value)}
                    rows={7}
                    disabled={editSaving}
                  />
                </label>
                <label className="agent-toggle">
                  <input
                    type="checkbox"
                    checked={editForm.enabled}
                    onChange={event => updateEditForm('enabled', event.target.checked)}
                    disabled={editSaving}
                  />
                  <span>启用</span>
                </label>
                {editError && <div className="agent-form-error">{editError}</div>}
                <div className="agent-dialog-actions">
                  <button
                    type="button"
                    className="agent-secondary-button"
                    onClick={() => setEditing(false)}
                    disabled={editSaving}
                  >
                    取消
                  </button>
                  <button type="submit" className="agent-primary-button" disabled={editSaving}>
                    <Save size={14} />
                    {editSaving ? '保存中...' : '保存'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      <AgentAuthoringDialog
        open={authoring.open}
        messages={authoring.messages}
        draft={authoring.draft}
        sending={authoring.sending}
        saving={authoring.saving}
        error={authoring.error}
        onClose={authoring.closeDialog}
        onSend={authoring.sendMessage}
        onSave={authoring.saveAgent}
      />
    </div>
  )
}
```

- [ ] **Step 4: Add new test script to `package.json`**

Modify `sf-portal-mvp/package.json` — add `check-agent-authoring-dialog-hook.mjs` to the `test:logic` script. Insert it before `check-agent-authoring-dialog.mjs`:

```json
"test:logic": "node scripts/check-job-selection.mjs && node scripts/check-application-ordering.mjs && node scripts/check-agent-creation.mjs && node scripts/check-clarification.mjs && node scripts/check-chat-input-sizing.mjs && node scripts/check-clarification-layout.mjs && node scripts/check-execution-record-state.mjs && node scripts/check-task-observability-layout.mjs && node scripts/check-conversation-workbench.mjs && node scripts/check-business-agents.mjs && node scripts/check-agent-authoring-dialog-hook.mjs && node scripts/check-agent-authoring-dialog.mjs && node scripts/check-agent-authoring-conversation.mjs"
```

- [ ] **Step 5: Update `App.jsx`**

Modify `sf-portal-mvp/src/App.jsx` — change the `AgentsPanel` props:

Remove `onStartAuthoring={conversation.startAuthoring}` and add `onRefreshAgents={agents.refresh}`:

```jsx
          <AgentsPanel
            agents={agents.agents}
            softwareAgents={agents.softwareAgents}
            businessAgents={agents.businessAgents}
            loading={agents.loading}
            error={agents.error}
            selectedBusinessAgentIds={conversation.selectedBusinessAgentIds}
            onAddBusinessAgent={conversation.addBusinessAgent}
            onRemoveBusinessAgent={conversation.removeBusinessAgent}
            onCreateBusinessAgent={agents.createBusinessAgent}
            onUpdateBusinessAgent={agents.updateBusinessAgent}
            onSetBusinessAgentEnabled={agents.setBusinessAgentEnabled}
            onRefreshAgents={agents.refresh}
          />
```

- [ ] **Step 6: Run all logic tests**

Run: `cd sf-portal-mvp && npm run test:logic`
Expected: All tests pass, including:
- `check-agent-authoring-dialog: OK`
- `check-agent-authoring-dialog-hook: OK`
- All existing tests still pass

- [ ] **Step 7: Run the build**

Run: `cd sf-portal-mvp && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 8: Commit**

```bash
git add sf-portal-mvp/src/components/AgentsPanel.jsx sf-portal-mvp/src/App.jsx sf-portal-mvp/scripts/check-agent-authoring-dialog.mjs sf-portal-mvp/package.json
git commit -m "feat: wire agent authoring dialog into AgentsPanel"
```

---

### Task 4: Manual Verification

**Files:** None (verification only)

- [ ] **Step 1: Start the dev server**

Run: `cd sf-portal-mvp && npm run dev`

- [ ] **Step 2: Start the backend server**

Run the Go backend as usual (e.g., `cd factory-server && go run ./cmd/server`).

- [ ] **Step 3: Verify the dialog opens**

1. Open the portal in a browser.
2. Click the "业务智能体" tab in the right panel.
3. Click the "+" button.
4. Verify: A modal dialog opens with the title "创建业务智能体" and a welcome message from the AI.

- [ ] **Step 4: Verify the conversation flow**

1. Type a message like "我需要一个处理海事数据的智能体" and press Enter or click send.
2. Verify: The user message appears as a right-aligned green bubble.
3. Verify: After the API responds, AI messages appear as left-aligned blue bubbles.
4. Verify: If the backend generates a draft, a draft card appears inline with name, key, description, and prompt.

- [ ] **Step 5: Verify multi-turn conversation**

1. Send another message to refine the agent (e.g., "请增加对异常航迹的监控规则").
2. Verify: The conversation continues, and the draft card updates.

- [ ] **Step 6: Verify save flow**

1. Once a draft card is visible with all required fields, click "保存智能体".
2. Verify: The dialog closes.
3. Verify: The new agent appears in the business agents list in the right panel.

- [ ] **Step 7: Verify cancel flow**

1. Open the dialog again, type a message, then click "取消" or the X button.
2. Verify: The dialog closes without saving.
3. Verify: No new agent was added to the list.

- [ ] **Step 8: Verify center workbench is unaffected**

1. During the dialog flow, check that the center ConversationWorkbench still shows its current session (if any) and is not disrupted.
