import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus, History, Send } from 'lucide-react'
import { titleForSession } from '../hooks/conversationTimeline'
import './ConversationWorkbench.css'

const STATUS_TEXT = {
  active: '分析中',
  waiting_user: '等待补充',
  ready_to_confirm: '待确认',
  confirmed: '已确认',
  failed: '已失败',
  abandoned: '已放弃',
}

export function ConversationWorkbench({
  session,
  sessions,
  timeline,
  questions,
  error,
  submitting,
  historyOpen,
  setHistoryOpen,
  onNewSession,
  onSelectSession,
  onSend,
  onAnswerBatch,
  onConfirm,
  onRetry,
  onAbandon,
}) {
  const [input, setInput] = useState('')
  const [draftAnswers, setDraftAnswers] = useState({})
  const canConfirm = session && session.status === 'ready_to_confirm'
  const activeQuestions = Array.isArray(questions) ? questions : []
  const completedAnswers = activeQuestions.filter(q => hasAnswer(draftAnswers[q.id])).length
  const canSubmitAnswers = activeQuestions.length > 0 && completedAnswers === activeQuestions.length && !submitting

  useEffect(() => {
    const ids = new Set(activeQuestions.map(q => q.id))
    setDraftAnswers(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))))
  }, [activeQuestions.map(q => q.id).join('|')])

  const submitText = async () => {
    const value = input.trim()
    if (!value || submitting) return
    setInput('')
    await onSend(value)
  }

  const submitAnswers = async () => {
    if (!canSubmitAnswers) return
    const answers = activeQuestions.map(q => {
      const value = draftAnswers[q.id]
      return { questionId: q.id, value: Array.isArray(value) ? JSON.stringify(value) : String(value || '') }
    })
    await onAnswerBatch(answers)
    setDraftAnswers({})
  }

  return (
    <section className="conversation-workbench">
      <header className="cw-header">
        <div className="cw-title">
          <span className="cw-kicker">会话工作台</span>
          <strong>{session ? titleForSession(session) : '新会话'}</strong>
        </div>
        <div className="cw-actions">
          {session ? <span className={`cw-status cw-status-${session.status}`}>{STATUS_TEXT[session.status] || session.status}</span> : null}
          <button type="button" className="cw-icon-btn" onClick={onNewSession} title="新建会话"><MessageSquarePlus size={16} /></button>
          <button type="button" className="cw-icon-btn" onClick={() => setHistoryOpen(true)} title="历史会话"><History size={16} /></button>
        </div>
      </header>

      <div className="cw-body">
        {timeline.length === 0 ? (
          <div className="cw-empty">输入需求后，模型会先进行需求分析和澄清。</div>
        ) : (
          timeline.map(item => (
            <TimelineItem key={item.id} item={item} draftAnswers={draftAnswers} setDraftAnswers={setDraftAnswers} />
          ))
        )}
      </div>

      {activeQuestions.length > 0 ? (
        <div className="cw-answer-bar">
          <span>已完成 {completedAnswers}/{activeQuestions.length}</span>
          <button type="button" disabled={!canSubmitAnswers} onClick={submitAnswers}>
            {submitting ? '处理中' : '提交本轮澄清'}
          </button>
        </div>
      ) : null}

      {error ? <div className="cw-error">{error}</div> : null}

      <footer className="cw-composer">
        {session && session.status === 'failed' ? <button type="button" onClick={onRetry} disabled={submitting}>重试本轮</button> : null}
        {session && session.status !== 'confirmed' && session.status !== 'abandoned' ? <button type="button" onClick={onAbandon} disabled={submitting}>放弃</button> : null}
        {canConfirm ? <button type="button" className="primary" onClick={onConfirm} disabled={submitting}>确认并生成</button> : null}
        <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="输入新需求或补充说明" disabled={submitting || canConfirm} />
        <button type="button" className="cw-send" onClick={submitText} disabled={!input.trim() || submitting || canConfirm}>
          {submitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
        </button>
      </footer>

      {historyOpen ? (
        <ConversationHistoryDrawer sessions={sessions} selectedId={session && session.id} onClose={() => setHistoryOpen(false)} onSelect={id => { onSelectSession(id); setHistoryOpen(false) }} />
      ) : null}
    </section>
  )
}

function TimelineItem({ item, draftAnswers, setDraftAnswers }) {
  if (item.type === 'user_message') return <div className="cw-item cw-user">{item.content}</div>
  if (item.type === 'analysis_stream') return <div className="cw-item cw-agent"><span className="cw-item-label">模型分析过程</span>{item.content}</div>
  if (item.type === 'requirement_summary') return <RequirementSummary requirement={item.requirement} />
  if (item.type === 'system_status') return <div className="cw-system">{item.status}</div>
  if (item.type === 'question_group') {
    return (
      <div className="cw-question-group">
        {item.questions.map(q => (
          <QuestionCard key={q.id} q={q} value={draftAnswers[q.id]} setValue={value => setDraftAnswers(prev => ({ ...prev, [q.id]: value }))} />
        ))}
      </div>
    )
  }
  return null
}

function QuestionCard({ q, value, setValue }) {
  const selected = Array.isArray(value) ? value : value ? [value] : []
  const optionValues = new Set((q.options || []).map(opt => opt.value))
  const customSelected = selected.filter(v => !optionValues.has(v))
  const choose = optValue => {
    if (q.multiSelect) {
      setValue(selected.includes(optValue) ? selected.filter(v => v !== optValue) : [...selected, optValue])
    } else {
      setValue(optValue)
    }
  }
  return (
    <div className="cw-question">
      <strong>{q.label || q.question || q.id}</strong>
      <div className="cw-options">
        {(q.options || []).map(opt => (
          <button key={opt.value} type="button" className={selected.includes(opt.value) ? 'selected' : ''} onClick={() => choose(opt.value)}>
            <span>{opt.label || opt.value}</span>
            {opt.reason ? <em>{opt.reason}</em> : null}
          </button>
        ))}
      </div>
      {q.allowCustom ? <CustomAnswer onSubmit={v => q.multiSelect ? setValue([...selected, v]) : setValue(v)} /> : null}
      {customSelected.length > 0 ? <div className="cw-custom-selected">{customSelected.join('、')}</div> : null}
    </div>
  )
}

function CustomAnswer({ onSubmit }) {
  const [value, setValue] = useState('')
  return <div className="cw-custom"><input value={value} onChange={e => setValue(e.target.value)} /><button type="button" onClick={() => { if (value.trim()) { onSubmit(value.trim()); setValue('') } }}>添加</button></div>
}

function RequirementSummary({ requirement }) {
  const rows = [
    ['应用类型', requirement.appType],
    ['应用名称', requirement.appName],
    ['核心场景', requirement.coreScenario],
    ['主视图', requirement.primaryView],
    ['数据策略', requirement.dataPolicy],
  ].filter(([, value]) => value)
  return <div className="cw-summary"><strong>确认需求摘要</strong>{rows.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
}

function ConversationHistoryDrawer({ sessions, selectedId, onClose, onSelect }) {
  const list = Array.isArray(sessions) ? sessions : []
  return (
    <aside className="cw-history">
      <header><strong>历史会话</strong><button type="button" onClick={onClose}>关闭</button></header>
      {list.map(sess => (
        <button key={sess.id} type="button" className={sess.id === selectedId ? 'active' : ''} onClick={() => onSelect(sess.id)}>
          <span>{titleForSession(sess)}</span>
          <em>{STATUS_TEXT[sess.status] || sess.status}</em>
        </button>
      ))}
    </aside>
  )
}

function hasAnswer(value) {
  return Array.isArray(value) ? value.length > 0 : value != null && value !== ''
}
