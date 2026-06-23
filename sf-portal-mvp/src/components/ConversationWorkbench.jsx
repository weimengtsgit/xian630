import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Edit3,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  History,
  PlayCircle,
  RefreshCw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { statusText, titleForDialogue } from '../hooks/dialogueTimeline'
import './ConversationWorkbench.css'

export function ConversationWorkbench({
  session,
  view,
  sessions,
  timeline,
  questions,
  locked,
  error,
  submitting,
  deletingDialogueId,
  historyOpen,
  setHistoryOpen,
  onNewSession,
  onSelectSession,
  onSend,
  onSelectRoute,
  onOpenApp,
  onAnswerBatch,
  onAcceptConsolidation,
  onConfirm,
  onRetry,
  onAbandon,
  onDeleteSession,
}) {
  const [input, setInput] = useState('')
  const [draftAnswers, setDraftAnswers] = useState({})
  const status = session && session.status
  const activeQuestions = Array.isArray(questions) ? questions : []
  const completedAnswers = activeQuestions.filter(q => hasAnswer(draftAnswers[q.id])).length
  const canSubmitAnswers = activeQuestions.length > 0 && completedAnswers === activeQuestions.length && !submitting
  const intent = session && session.intent
  const isBusiness = intent === 'business_processing_agent'
  const isClarification = intent === 'application_generation' && view && view.child
  const childStatus = isClarification ? view.child.status : null
  const canConfirmClarification = childStatus === 'ready_to_confirm'
  const canConfirmBusiness = isBusiness && view && view.agentDraft && (view.agentDraft.name || view.agentDraft.prompt)
  const canConfirm = (canConfirmClarification || canConfirmBusiness) && !submitting
  const canRetry = status === 'failed'
  const canAbandon = status && status !== 'resolved' && status !== 'abandoned'

  useEffect(() => {
    const ids = new Set(activeQuestions.map(q => q.id))
    setDraftAnswers(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))))
  }, [activeQuestions.map(q => q.id).join('|')])

  const submitText = async () => {
    const value = input.trim()
    if (!value || submitting || locked) return
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
          <strong>{session ? titleForDialogue(session) : '新会话'}</strong>
        </div>
        <div className="cw-actions">
          {session ? <span className={`cw-status cw-status-${status}`}>{statusText(status)}</span> : null}
          <button type="button" className="cw-icon-btn" onClick={onNewSession} title="新建会话" aria-label="新建会话"><MessageSquarePlus size={16} /></button>
          <button type="button" className="cw-icon-btn" onClick={() => setHistoryOpen(true)} title="历史会话" aria-label="历史会话"><History size={16} /></button>
        </div>
      </header>

      <div className="cw-body">
        {timeline.length === 0 ? (
          <div className="cw-empty">输入需求后，将自动识别是复用已有应用、生成新应用，还是配置业务 Agent。</div>
        ) : (
          timeline.map(item => (
            <TimelineItem
              key={item.id}
              item={item}
              draftAnswers={draftAnswers}
              setDraftAnswers={setDraftAnswers}
              submitting={submitting}
              onSelectRoute={onSelectRoute}
              onOpenApp={onOpenApp}
              onAcceptConsolidation={onAcceptConsolidation}
              onSend={onSend}
            />
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

      {canConfirm ? (
        <div className="cw-answer-bar">
          <button type="button" className="primary" onClick={onConfirm} disabled={submitting}>
            {submitting ? '处理中' : isBusiness ? '确认创建' : '确认并生成'}
          </button>
        </div>
      ) : null}

      {error ? <div className="cw-error">{error}</div> : null}

      <footer className="cw-composer">
        {canRetry ? <button type="button" onClick={onRetry} disabled={submitting} title="重试本轮">重试本轮</button> : null}
        {canAbandon ? <button type="button" onClick={onAbandon} disabled={submitting} title="放弃">放弃</button> : null}
        {status === 'resolved' ? (
          <p className="cw-terminal-hint">会话已完成，点击右上角「新建会话」开始新的需求。</p>
        ) : status === 'abandoned' || status === 'failed' ? (
          <p className="cw-terminal-hint">会话已结束。{canRetry ? '失败会话可重试本轮，或' : ''}新建会话开始新需求。</p>
        ) : locked ? (
          <p className="cw-terminal-hint">请在上方选择并确认操作。</p>
        ) : (
          <>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="输入需求或补充说明"
              disabled={submitting}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText() } }}
            />
            <button type="button" className="cw-send" onClick={submitText} disabled={!input.trim() || submitting} title="发送" aria-label="发送">
              {submitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            </button>
          </>
        )}
      </footer>

      {historyOpen ? (
        <DialogueHistoryDrawer
          sessions={sessions}
          selectedId={session && session.id}
          deletingDialogueId={deletingDialogueId}
          onClose={() => setHistoryOpen(false)}
          onSelect={id => { onSelectSession(id); setHistoryOpen(false) }}
          onDeleteSession={onDeleteSession}
        />
      ) : null}
    </section>
  )
}

function TimelineItem({ item, draftAnswers, setDraftAnswers, submitting, onSelectRoute, onOpenApp, onAcceptConsolidation, onSend }) {
  if (item.type === 'user_message') return <div className="cw-item cw-user">{item.content}</div>
  if (item.type === 'analysis_stream') {
    return (
      <div className="cw-item cw-agent">
        <span className="cw-item-label">分析过程</span>
        {item.content}
      </div>
    )
  }
  if (item.type === 'route_recommendation') {
    return <RouteChoiceCard reason={item.reason} onSelectRoute={onSelectRoute} submitting={submitting} />
  }
  if (item.type === 'app_recommendation') {
    return <AppRecommendationList cards={item.cards} onOpenApp={onOpenApp} submitting={submitting} />
  }
  if (item.type === 'question_group') {
    return (
      <div className="cw-question-group">
        {item.questions.map(q => (
          <QuestionCard key={q.id} q={q} value={draftAnswers[q.id]} setValue={value => setDraftAnswers(prev => ({ ...prev, [q.id]: value }))} />
        ))}
      </div>
    )
  }
  if (item.type === 'consolidation_table') {
    return <ConsolidationTable rows={item.rows} onAccept={onAcceptConsolidation} submitting={submitting} />
  }
  if (item.type === 'requirement_summary') return <RequirementSummary requirement={item.requirement} />
  if (item.type === 'business_recommendation') {
    return <BusinessRecommendationCard draft={item.draft} onRedescribe={onSend} submitting={submitting} />
  }
  if (item.type === 'resolved_outcome') {
    return (
      <div className="cw-item cw-resolved">
        <Check size={14} />
        <span>{item.label}</span>
      </div>
    )
  }
  if (item.type === 'system_status') {
    return <div className="cw-system">{statusText(item.status)}</div>
  }
  return null
}

function RouteChoiceCard({ reason, onSelectRoute, submitting }) {
  return (
    <div className="cw-route-choice">
      {reason ? <p className="cw-route-reason">{reason}</p> : null}
      <div className="cw-route-options">
        <button type="button" disabled={submitting} onClick={() => onSelectRoute('existing_application')}>
          <b>复用已有应用</b>
          <small>打开匹配的现有应用</small>
        </button>
        <button type="button" disabled={submitting} onClick={() => onSelectRoute('application_generation')}>
          <b>生成新应用</b>
          <small>通过需求澄清生成</small>
        </button>
        <button type="button" disabled={submitting} onClick={() => onSelectRoute('business_processing_agent')}>
          <b>配置业务 Agent</b>
          <small>创建一个业务处理 Agent</small>
        </button>
      </div>
    </div>
  )
}

function AppRecommendationList({ cards, onOpenApp, submitting }) {
  const list = Array.isArray(cards) ? cards : []
  if (list.length === 0) return null
  return (
    <div className="cw-apps">
      <strong>推荐应用</strong>
      <div className="cw-app-list">
        {list.map(card => (
          <AppRecommendationCard key={card.applicationId || card.slug} card={card} onOpenApp={onOpenApp} submitting={submitting} />
        ))}
      </div>
    </div>
  )
}

function AppRecommendationCard({ card, onOpenApp, submitting }) {
  const running = card.status === 'running'
  const stopped = !running && card.status !== 'running'
  const open = () => {
    if (submitting) return
    onOpenApp(card.applicationId)
  }
  return (
    <div className={`cw-app-card${card.primary ? ' cw-app-primary' : ''}`}>
      <div className="cw-app-head">
        <b>{card.name}</b>
        {card.primary ? <em className="cw-app-primary-badge">主推荐</em> : null}
      </div>
      {card.matchReason ? <small className="cw-app-reason">{card.matchReason}</small> : null}
      <div className="cw-app-actions">
        {running ? (
          <button type="button" className="cw-app-action" onClick={open} disabled={submitting} title="打开应用">
            <ExternalLink size={14} />
            <span>打开应用</span>
          </button>
        ) : stopped ? (
          <button type="button" className="cw-app-action cw-app-action-primary" onClick={open} disabled={submitting} title="启动并打开">
            <PlayCircle size={14} />
            <span>启动并打开</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ConsolidationTable({ rows, onAccept, submitting }) {
  const [adjustField, setAdjustField] = useState(null)
  const [adjustValue, setAdjustValue] = useState('')
  const list = Array.isArray(rows) ? rows : []
  const submitAdjust = field => {
    if (!adjustValue.trim() || submitting) return
    onAccept({ field, value: adjustValue.trim() })
    setAdjustField(null)
    setAdjustValue('')
  }
  return (
    <div className="cw-consolidation">
      <strong>推荐汇总</strong>
      <table className="cw-consolidation-table">
        <tbody>
          {list.map(row => (
            <tr key={row.field}>
              <th>{fieldLabel(row.field)}</th>
              <td>{formatValue(row.recommendedValue)}</td>
              {row.reason ? <td className="cw-consolidation-reason">{row.reason}</td> : <td />}
              <td className="cw-consolidation-actions">
                {adjustField === row.field ? (
                  <span className="cw-consolidation-adjust">
                    <input
                      value={adjustValue}
                      onChange={e => setAdjustValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') submitAdjust(row.field) }}
                      placeholder={row.alternatives && row.alternatives[0] ? `如 ${row.alternatives[0]}` : '输入调整值'}
                    />
                    <button type="button" disabled={!adjustValue.trim() || submitting} onClick={() => submitAdjust(row.field)}>应用</button>
                    <button type="button" className="cw-consolidation-cancel" onClick={() => { setAdjustField(null); setAdjustValue('') }} title="取消"><X size={12} /></button>
                  </span>
                ) : (
                  <button type="button" className="cw-consolidation-edit" onClick={() => { setAdjustField(row.field); setAdjustValue('') }} title="调整该字段">
                    <Edit3 size={12} />
                    <span>调整</span>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cw-consolidation-bar">
        <button type="button" className="primary" onClick={() => onAccept()} disabled={submitting}>
          <Check size={14} />
          <span>接受推荐</span>
        </button>
      </div>
    </div>
  )
}

function BusinessRecommendationCard({ draft, onRedescribe, submitting }) {
  const [redescribing, setRedescribing] = useState(false)
  const [text, setText] = useState('')
  const submitRedescribe = () => {
    const value = text.trim()
    if (!value || submitting) return
    onRedescribe(value)
    setText('')
    setRedescribing(false)
  }
  return (
    <div className="cw-business">
      <strong>推荐业务 Agent</strong>
      <div className="cw-business-draft">
        <b>{draft.name || '业务处理 Agent'}</b>
        {draft.description ? <p>{draft.description}</p> : null}
      </div>
      {redescribing ? (
        <div className="cw-business-redescribe">
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitRedescribe() }}
            placeholder="补充说明你希望这个 Agent 做什么"
          />
          <button type="button" disabled={!text.trim() || submitting} onClick={submitRedescribe}>提交</button>
          <button type="button" className="cw-consolidation-cancel" onClick={() => { setRedescribing(false); setText('') }} title="取消"><X size={12} /></button>
        </div>
      ) : (
        <div className="cw-business-actions">
          <button type="button" onClick={() => setRedescribing(true)} title="重新描述"><RefreshCw size={12} /><span>重新描述</span></button>
        </div>
      )}
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
      <strong>{q.label || q.id}</strong>
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

function RequirementSummary({ requirement }) {
  const rows = [
    ['应用类型', requirement.appType],
    ['应用名称', requirement.appName],
    ['核心场景', requirement.coreScenario],
    ['主视图', requirement.primaryView],
    ['数据策略', requirement.dataPolicy],
  ].filter(([, value]) => value)
  return (
    <div className="cw-summary">
      <strong>确认需求摘要</strong>
      {rows.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
    </div>
  )
}

function DialogueHistoryDrawer({ sessions, selectedId, deletingDialogueId, onClose, onSelect, onDeleteSession }) {
  const list = Array.isArray(sessions) ? sessions : []
  const [pendingDelete, setPendingDelete] = useState(null)
  const pendingTitle = pendingDelete ? titleForDialogue(pendingDelete.session || pendingDelete) : ''
  const confirmingDelete = pendingDelete && deletingDialogueId === (pendingDelete.session && pendingDelete.session.id)

  useEffect(() => {
    if (!pendingDelete) return
    const pid = pendingDelete.session && pendingDelete.session.id
    if (!list.some(v => v.session && v.session.id === pid)) setPendingDelete(null)
  }, [pendingDelete, list.map(v => v.session && v.session.id).join('|')])

  const requestDelete = entry => {
    const sess = entry && entry.session
    if (!sess) return
    if (sess.status === 'routing' || sess.status === 'drafting_application' || sess.status === 'drafting_business_agent') return
    setPendingDelete(entry)
  }

  const confirmDelete = async () => {
    if (!pendingDelete || confirmingDelete) return
    const sess = pendingDelete.session
    if (!sess) return
    try {
      await onDeleteSession(sess.id)
      setPendingDelete(null)
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
        {list.map(entry => {
          const sess = entry && entry.session
          if (!sess) return null
          const deletable = sess.status !== 'routing' && sess.status !== 'drafting_application' && sess.status !== 'drafting_business_agent'
          return (
            <div key={sess.id} className={`cw-history-row${sess.id === selectedId ? ' active' : ''}`}>
              <button type="button" className="cw-history-item" onClick={() => onSelect(sess.id)}>
                <span className="cw-history-title">{titleForDialogue(sess)}</span>
                <span className="cw-history-meta">
                  <em>{statusText(sess.status)}</em>
                  <time dateTime={sess.updated_at}>{formatSessionTime(sess.updated_at)}</time>
                </span>
                <small>{summaryForEntry(entry)}</small>
                {resultForEntry(entry) ? <b>{resultForEntry(entry)}</b> : null}
              </button>
              <button
                type="button"
                className="cw-history-delete"
                disabled={!deletable || deletingDialogueId === sess.id}
                onClick={() => requestDelete(entry)}
                title={deletable ? '删除历史会话' : '进行中的会话不可删除'}
                aria-label="删除历史会话"
              >
                {deletingDialogueId === sess.id ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          )
        })}
      </div>
      {pendingDelete ? (
        <div className="cw-delete-confirm" role="dialog" aria-labelledby="cw-delete-confirm-title">
          <div className="cw-delete-confirm-card">
            <span className="cw-delete-confirm-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
            <div className="cw-delete-confirm-copy">
              <strong id="cw-delete-confirm-title">删除历史会话</strong>
              <p>将删除「{pendingTitle}」的会话记录，不会删除已生成的应用或 Agent。</p>
            </div>
            <div className="cw-delete-confirm-actions">
              <button type="button" className="cw-delete-confirm-cancel" onClick={() => setPendingDelete(null)} disabled={confirmingDelete}>取消</button>
              <button type="button" className="cw-delete-confirm-danger" onClick={confirmDelete} disabled={confirmingDelete}>
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

function optionIsRecommended(q, opt) {
  if (opt.recommended) return true
  const values = Array.isArray(q.recommendation) ? q.recommendation : q.recommendation ? [q.recommendation] : []
  return values.includes(opt.value)
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

function summaryForEntry(entry) {
  const child = entry && entry.child
  const req = (child && child.requirement) || {}
  const parts = [req.appType, req.coreScenario].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  const sess = entry && entry.session
  return (sess && sess.initial_prompt) || '暂无摘要'
}

function resultForEntry(entry) {
  if (!entry) return ''
  const sess = entry.session || {}
  if (entry.resolvedApplication) return entry.resolvedApplication.name || '应用已就绪'
  if (entry.createdAgent) return entry.createdAgent.name || 'Agent 已创建'
  if (entry.seededJob) return entry.seededJob.app_name ? `生成任务：${entry.seededJob.app_name}` : '生成任务已创建'
  if (sess.status === 'resolved') return '已完成'
  return ''
}

function fieldLabel(field) {
  const map = {
    appType: '应用类型',
    appName: '应用名称',
    coreScenario: '核心场景',
    primaryView: '主视图',
    dataPolicy: '数据策略',
  }
  return map[field] || field
}

function formatValue(value) {
  if (value == null || value === '') return ''
  if (Array.isArray(value)) return value.join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
