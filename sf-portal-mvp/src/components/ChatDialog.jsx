import { useState, useRef, useEffect } from 'react'
import { Send, Loader2, AlertTriangle } from 'lucide-react'
import './ChatDialog.css'

const STATUS_HINT = {
  running: '当前任务运行中，新需求将进入队列。',
  waiting_user: '当前任务等待你的澄清，可在下方输入补充信息。',
  queued: '任务排队中，新需求将追加到队列。',
}

export function ChatDialog({ activeJob, jobError, onSubmit }) {
  const [input, setInput] = useState('')
  const [history, setHistory] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [history, activeJob])

  const statusHint = activeJob ? STATUS_HINT[activeJob.status] : null

  const handleSubmit = async () => {
    const prompt = input.trim()
    if (!prompt) return
    setHistory(prev => [...prev, { role: 'user', content: prompt }])
    setInput('')
    setSubmitting(true)
    try {
      if (onSubmit) {
        await onSubmit(prompt)
      }
      setHistory(prev => [
        ...prev,
        {
          role: 'assistant',
          content: activeJob
            ? '需求已提交，已加入任务流程。'
            : '已创建生成任务，请查看中间任务区。',
        },
      ])
    } catch (e) {
      setHistory(prev => [
        ...prev,
        { role: 'assistant', content: `提交失败：${e && e.message ? e.message : e}` },
      ])
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="chat-dock">
      <div className="chat-dock-messages" ref={scrollRef}>
        {history.length === 0 && (
          <div className="chat-dock-empty">
            描述你想要生成的应用，例如：“做一个待办事项管理页面”。
          </div>
        )}
        {history.map((msg, i) => (
          <div key={i} className={`dock-message dock-${msg.role}`}>
            {msg.content}
          </div>
        ))}
      </div>

      {statusHint && <div className="chat-dock-hint">{statusHint}</div>}
      {jobError && (
        <div className="chat-dock-error">
          <AlertTriangle size={13} /> {jobError}
        </div>
      )}

      <div className="chat-dock-input">
        <textarea
          className="chat-dock-textarea"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入需求以创建/追加生成任务（回车提交，Shift+回车换行）"
          rows={2}
        />
        <button
          type="button"
          className="chat-dock-send"
          onClick={handleSubmit}
          disabled={!input.trim() || submitting}
          title={activeJob ? '提交后将加入队列' : '创建生成任务'}
        >
          {submitting ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
        </button>
      </div>
    </div>
  )
}
