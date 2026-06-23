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

  useEffect(() => {
    if (!open) return
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

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
              <Loader2 size={14} className="authoring-spin" />
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
              {sending ? <Loader2 size={14} className="authoring-spin" /> : <Send size={14} />}
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
