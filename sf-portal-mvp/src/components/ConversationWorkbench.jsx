import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus, History, Send, ChevronUp, ChevronDown, X } from 'lucide-react'
import { AlertTriangle, Loader2, MessageSquarePlus, History, Send, X, Trash2 } from 'lucide-react'
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
  selectedBusinessAgents = [],
  onRemoveBusinessAgent,
  onMoveBusinessAgent,
  deletingSessionId,
  historyOpen,
  setHistoryOpen,
  onNewSession,
  onSelectSession,
  onSend,
  onAnswerBatch,
  onConfirm,
  onRetry,
  onAbandon,
  onSaveAuthoring,
  onRefreshAgents,
  onDeleteSession,
}) {
  const [input, setInput] = useState('')
  const [draftAnswers, setDraftAnswers] = useState({})
  const canConfirm = session && session.status === 'ready_to_confirm'
  const terminal = !!(session && (session.status === 'confirmed' || session.status === 'abandoned' || session.status === 'failed'))
  const activeQuestions = Array.isArray(questions) ? questions : []
  const businessAgents = Array.isArray(selectedBusinessAgents) ? selectedBusinessAgents : []
  const completedAnswers = activeQuestions.filter(q => hasAnswer(draftAnswers[q.id])).length
  const canSubmitAnswers = activeQuestions.length > 0 && completedAnswers === activeQuestions.length && !submitting

  const isAuthoringMode = session?.mode === 'agent_authoring'
  const draftItems = timeline.filter(item => item.type === 'agent_draft')
  const latestDraft = draftItems.length > 0 ? draftItems[draftItems.length - 1].draft : null
  const canSaveDraft = isAuthoringMode
    && session?.status === 'ready_to_confirm'
    && latestDraft?.name
    && latestDraft?.key
    && latestDraft?.prompt

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

  const handleSaveAuthoring = async () => {
    if (!onSaveAuthoring || submitting) return
    try {
      await onSaveAuthoring()
      if (onRefreshAgents) await onRefreshAgents()
    } catch {
      // Error is surfaced by the hook's setError
    }
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

      {!isAuthoringMode && businessAgents.length > 0 ? (
        <div className="cw-business-agents" aria-label="本次业务智能体">
          <span className="cw-business-label">本次业务智能体</span>
          <div className="cw-business-chips">
            {businessAgents.map((agent, index) => {
              const agentLabel = agent.name || agent.key || agent.id
              return (
                <span className="cw-business-chip" key={agent.id || agent.key || `${agentLabel}_${index}`}>
                  <span className="cw-business-chip-label">{index + 1}. {agentLabel}</span>
                  <button type="button" onClick={() => onMoveBusinessAgent?.(agent.id, -1)} disabled={index === 0} aria-label={`上移${agentLabel}`}>
                    <ChevronUp size={12} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => onMoveBusinessAgent?.(agent.id, 1)} disabled={index === businessAgents.length - 1} aria-label={`下移${agentLabel}`}>
                    <ChevronDown size={12} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => onRemoveBusinessAgent?.(agent.id)} aria-label={`移除${agentLabel}`}>
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              )
            })}
          </div>
        </div>
      ) : null}

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
        {isAuthoringMode ? (
          canSaveDraft ? (
            <button type="button" className="primary" onClick={handleSaveAuthoring} disabled={submitting}>
              保存智能体
            </button>
          ) : session && session.status !== 'confirmed' && session.status !== 'abandoned' ? (
            <p className="cw-terminal-hint">请回答上方的引导问题,生成智能体草稿后可以保存。</p>
          ) : null
        ) : (
          canConfirm ? <button type="button" className="primary" onClick={onConfirm} disabled={submitting}>确认并生成</button> : null
        )}
        {terminal ? (
          <p className="cw-terminal-hint">
            {session.status === 'failed' ? '会话已结束。失败会话可重试本轮，或新建会话开始新需求。' : isAuthoringMode ? '智能体创建会话已结束，点击右上角「新建会话」开始新的需求。' : '会话已结束，点击右上角「新建会话」开始新的需求澄清。'}
          </p>
        ) : (
          <>
            <textarea value={input} onChange={e => setInput(e.target.value)} placeholder={isAuthoringMode ? '描述业务场景、规则或补充说明' : '输入新需求或补充说明'} disabled={submitting || canConfirm || terminal} />
            <button type="button" className="cw-send" onClick={submitText} disabled={!input.trim() || submitting || canConfirm || terminal}>
              {submitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            </button>
          </>
        )}
      </footer>

      {historyOpen ? (
        <ConversationHistoryDrawer
          sessions={sessions}
          selectedId={session && session.id}
          deletingSessionId={deletingSessionId}
          onClose={() => setHistoryOpen(false)}
          onSelect={id => { onSelectSession(id); setHistoryOpen(false) }}
          onDeleteSession={onDeleteSession}
        />
      ) : null}
    </section>
  )
}

function TimelineItem({ item, draftAnswers, setDraftAnswers }) {
  if (item.type === 'user_message') return <div className="cw-item cw-user">{item.content}</div>
  if (item.type === 'analysis_stream') return <div className="cw-item cw-agent"><span className="cw-item-label">模型分析过程</span>{item.content}</div>
  if (item.type === 'blueprint_recommendation') return <BlueprintRecommendation blueprints={item.blueprints} />
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
  if (item.type === 'agent_draft') return <AgentDraftCard draft={item.draft} />
  return null
}

function BlueprintRecommendation({ blueprints }) {
  const list = Array.isArray(blueprints) ? blueprints : []
  if (list.length === 0) return null
  return (
    <div className="cw-blueprints">
      <strong>参考蓝本</strong>
      <div className="cw-blueprint-list">
        {list.map((bp, i) => (
          <span key={bp.id || bp.name || `bp_${i}`} className="cw-blueprint-chip">
            <b>{bp.name || bp.id}</b>
            {bp.referenceKind ? <em>{bp.referenceKind}</em> : null}
            {bp.reason ? <small>{bp.reason}</small> : null}
          </span>
        ))}
      </div>
    </div>
  )
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
        {(q.options || []).map(opt => {
          const recommended = optionIsRecommended(q, opt)
          const classes = ['cw-option', selected.includes(opt.value) ? 'selected' : '', recommended ? 'cw-option-recommended' : ''].filter(Boolean).join(' ')
          return (
            <button key={opt.value} type="button" className={classes} onClick={() => choose(opt.value)}>
              <span className="cw-option-head">
                <b>{opt.label || opt.value}</b>
                {recommended ? <em className="cw-option-badge">推荐</em> : null}
              </span>
              {opt.reason ? <small>{opt.reason}</small> : null}
            </button>
          )
        })}
      </div>
      {q.allowCustom ? <CustomAnswer onSubmit={v => q.multiSelect ? setValue([...selected, v]) : setValue(v)} /> : null}
      {customSelected.length > 0 ? <div className="cw-custom-selected">{customSelected.join('、')}</div> : null}
    </div>
  )
}

function CustomAnswer({ onSubmit }) {
  const [value, setValue] = useState('')
  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    setValue('')
  }
  return (
    <div className="cw-custom">
      <input
        className="cw-custom-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit() }}
        placeholder="输入自定义答案"
      />
      <button type="button" className="cw-custom-submit" disabled={!value.trim()} onClick={submit}>添加</button>
    </div>
  )
}

function optionIsRecommended(q, opt) {
  if (opt.recommended) return true
  const values = Array.isArray(q.recommendation) ? q.recommendation : q.recommendation ? [q.recommendation] : []
  return values.includes(opt.value)
}

function RequirementSummary({ requirement }) {
  const rows = [
    ['应用类型', requirement.appType],
    ['应用名称', requirement.appName],
    ['核心场景', requirement.coreScenario],
    ['主视图', requirement.primaryView],
    ['数据策略', requirement.dataPolicy],
  ].filter(([, value]) => value)
  const refs = Array.isArray(requirement.blueprintRefs) ? requirement.blueprintRefs : []
  return (
    <div className="cw-summary">
      <strong>确认需求摘要</strong>
      {rows.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
      {refs.length > 0 ? (
        <div>
          <span>蓝本引用</span>
          <b>{refs.map(ref => ref.name || ref.id || ref).join('、')}</b>
        </div>
      ) : null}
    </div>
  )
}

function AgentDraftCard({ draft }) {
  if (!draft) return null
  return (
    <div className="cw-agent-draft">
      <strong>智能体预览</strong>
      <dl className="cw-agent-draft-grid">
        <div><dt>名称</dt><dd>{draft.name || '-'}</dd></div>
        <div><dt>标识</dt><dd>{draft.key || '-'}</dd></div>
        <div><dt>描述</dt><dd>{draft.description || '-'}</dd></div>
        <div><dt>状态</dt><dd>{draft.enabled === false ? '停用' : '启用'}</dd></div>
      </dl>
      <h4>最终提示词</h4>
      <pre className="cw-agent-draft-prompt">{draft.prompt || '待生成...'}</pre>
    </div>
  )
}

function ConversationHistoryDrawer({ sessions, selectedId, deletingSessionId, onClose, onSelect, onDeleteSession }) {
  const list = Array.isArray(sessions) ? sessions : []
  const [pendingDeleteSession, setPendingDeleteSession] = useState(null)
  const pendingTitle = pendingDeleteSession ? titleForSession(pendingDeleteSession) : ''
  const confirmingDelete = pendingDeleteSession && deletingSessionId === pendingDeleteSession.id

  useEffect(() => {
    if (!pendingDeleteSession) return
    if (!list.some(sess => sess.id === pendingDeleteSession.id)) setPendingDeleteSession(null)
  }, [pendingDeleteSession, list.map(sess => sess.id).join('|')])

  const requestDeleteHistorySession = sess => {
    if (!sess || sess.status === 'active') return
    setPendingDeleteSession(sess)
  }

  const confirmDeleteHistorySession = async () => {
    if (!pendingDeleteSession || pendingDeleteSession.status === 'active' || confirmingDelete) return
    try {
      await onDeleteSession(pendingDeleteSession.id)
      setPendingDeleteSession(null)
    } catch (_) {
      // The hook surfaces the error in the workbench error bar.
    }
  }

  return (
    <aside className="cw-history">
      <header>
        <strong>历史会话</strong>
        <button type="button" className="cw-history-close" onClick={onClose} title="关闭历史会话" aria-label="关闭历史会话"><X size={16} /></button>
      </header>
      <div className="cw-history-list">
        {list.map(sess => (
          <div key={sess.id} className={`cw-history-row${sess.id === selectedId ? ' active' : ''}`}>
            <button type="button" className="cw-history-item" onClick={() => onSelect(sess.id)}>
              <span className="cw-history-title">{titleForSession(sess)}</span>
              <span className="cw-history-meta">
                <em>{STATUS_TEXT[sess.status] || sess.status}</em>
                <time dateTime={sess.updated_at}>{formatSessionTime(sess.updated_at)}</time>
              </span>
              <small>{summaryForSession(sess)}</small>
              {resultForSession(sess) ? <b>{resultForSession(sess)}</b> : null}
            </button>
            <button
              type="button"
              className="cw-history-delete"
              disabled={sess.status === 'active' || deletingSessionId === sess.id}
              onClick={() => requestDeleteHistorySession(sess)}
              title={sess.status === 'active' ? '分析中会话不可删除' : '删除历史会话'}
              aria-label="删除历史会话"
            >
              {deletingSessionId === sess.id ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
            </button>
          </div>
        ))}
      </div>
      {pendingDeleteSession ? (
        <div className="cw-delete-confirm" role="dialog" aria-labelledby="cw-delete-confirm-title">
          <div className="cw-delete-confirm-card">
            <span className="cw-delete-confirm-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
            <div className="cw-delete-confirm-copy">
              <strong id="cw-delete-confirm-title">删除历史会话</strong>
              <p>将删除「{pendingTitle}」的会话记录和消息，不会删除已生成任务或应用。</p>
            </div>
            <div className="cw-delete-confirm-actions">
              <button type="button" className="cw-delete-confirm-cancel" onClick={() => setPendingDeleteSession(null)} disabled={confirmingDelete}>取消</button>
              <button type="button" className="cw-delete-confirm-danger" onClick={confirmDeleteHistorySession} disabled={confirmingDelete}>
                {confirmingDelete ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  )
}

function hasAnswer(value) {
  return Array.isArray(value) ? value.length > 0 : value != null && value !== ''
}

function formatSessionTime(value) {
  if (!value) return '未更新'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function summaryForSession(sess) {
  const requirement = (sess && sess.requirement) || {}
  const parts = [requirement.appType, requirement.coreScenario].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : sess.initial_prompt || '暂无摘要'
}

function resultForSession(sess) {
  if (!sess || (!sess.created_job_id && !sess.created_job)) return ''
  if (sess.application_state === 'deleted') return '应用已删除'
  if (sess.application) return sess.application.name || sess.application.slug || '应用已创建'
  if (sess.created_job && sess.created_job.status) return `生成任务：${sess.created_job.status}`
  return '生成任务已创建'
}
