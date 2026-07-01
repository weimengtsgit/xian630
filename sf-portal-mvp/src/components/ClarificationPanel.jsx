import { useEffect, useState } from 'react'
import { statusText } from '../hooks/clarificationLogic'
import { formatAppType } from '../utils/formatLabels'
import './ClarificationPanel.css'

// Renders the clarification flow: streaming analysis work-logs, structured
// option cards, recommended 场景蓝本 chips, a confirm-requirement summary, and
// footer actions. A Job is created ONLY when the user clicks 确认并生成 — before
// that, no Job / app card is produced (Task 5 gates bare POST /api/jobs).
//
// All data comes from normalized clarification.* SSE payloads via useClarification;
// raw claude stdout is never displayed.
export function ClarificationPanel({
  session,
  messages,
  questions,
  requirement,
  blueprints,
  error,
  onAnswerBatch,
  onConfirm,
  onRetry,
  onAbandon,
}) {
  const [pendingAnswerKey, setPendingAnswerKey] = useState('')
  const [draftAnswers, setDraftAnswers] = useState({})
  const handleAbandonRequirement = () => {
    if (!onAbandon) return
    const ok = typeof window === 'undefined'
      ? true
      : window.confirm('确定放弃本次需求吗？这会结束当前需求澄清/生成对话，但不会取消已经在执行的任务。如需停止任务，请在「任务执行」中取消。')
    if (ok) onAbandon()
  }

  useEffect(() => {
    const ids = new Set((questions || []).map(q => q.id))
    setDraftAnswers(prev => {
      const next = {}
      let changed = false
      for (const [id, value] of Object.entries(prev)) {
        if (ids.has(id)) {
          next[id] = value
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [questions])

  useEffect(() => {
    if (isAnswerClosedStatus(session?.status)) {
      setDraftAnswers({})
      setPendingAnswerKey('')
    }
  }, [session?.status])

  if (!session) {
    return (
      <section className="clar-panel clar-empty">
        <span>输入需求后，需求分析 agent 会先进行澄清，不会立即生成任务。</span>
      </section>
    )
  }

  const status = session.status
  const canConfirm = status === 'ready_to_confirm'
  const canAnswerQuestions = !isAnswerClosedStatus(status)
  const answerBusy = pendingAnswerKey !== ''
  const visibleQuestions = (questions || []).filter(q => q && q.id)
  const answeredCount = visibleQuestions.filter(q => hasDraftAnswer(draftAnswers[q.id])).length
  const canSubmitRound =
    canAnswerQuestions &&
    !answerBusy &&
    visibleQuestions.length > 0 &&
    answeredCount === visibleQuestions.length
  const roundSubmitTitle = canSubmitRound
    ? '提交本轮全部澄清答案'
    : canAnswerQuestions
      ? '请先完成本轮所有澄清项'
      : '当前状态不再接受澄清答案'
  const selectedValuesFor = q => {
    const current = draftAnswers[q.id]
    return Array.isArray(current) ? current : []
  }
  const setSingleAnswer = (questionId, value) => {
    if (!canAnswerQuestions || answerBusy) return
    setDraftAnswers(prev => ({ ...prev, [questionId]: value }))
  }
  const submitRoundAnswers = async () => {
    if (!onAnswerBatch || !canSubmitRound) return
    const answers = visibleQuestions.map(q => {
      const value = draftAnswers[q.id]
      return {
        questionId: q.id,
        value: Array.isArray(value) ? JSON.stringify(value) : String(value || ''),
      }
    })
    setPendingAnswerKey('__round__')
    try {
      await onAnswerBatch(answers)
      setDraftAnswers({})
    } finally {
      setPendingAnswerKey('')
    }
  }
  const toggleMultiAnswer = (q, value) => {
    if (!canAnswerQuestions || answerBusy) return
    setDraftAnswers(prev => {
      const current = Array.isArray(prev[q.id]) ? prev[q.id] : []
      const next = current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value]
      return { ...prev, [q.id]: next }
    })
  }
  const addMultiAnswer = (questionId, value) => {
    if (!canAnswerQuestions || answerBusy) return
    setDraftAnswers(prev => {
      const current = Array.isArray(prev[questionId]) ? prev[questionId] : []
      if (current.includes(value)) return prev
      return { ...prev, [questionId]: [...current, value] }
    })
  }
  const addSingleAnswer = (questionId, value) => {
    setSingleAnswer(questionId, value)
  }

  return (
    <section className="clar-panel">
      <header className="clar-header">
        <span className="clar-title">需求澄清</span>
        <strong className={`clar-status clar-status-${status || 'unknown'}`}>
          {statusText(status)}
        </strong>
      </header>

      <div className="clar-scroll">
        {messages.length > 0 && (
          <div className="clar-messages">
            {messages.map((m, i) => (
              <div
                key={m.id || `m_${i}`}
                className={`clar-message clar-kind-${m.kind || 'analysis_work_log'}`}
              >
                {m.content}
              </div>
            ))}
          </div>
        )}

        {visibleQuestions.length > 0 && (
          <div className="clar-questions">
            {visibleQuestions.map(q => {
              const hint = formatRecommendation(q)
              const isMulti = Boolean(q.multiSelect)
              const selectedValues = selectedValuesFor(q)
              const selectedSet = new Set(selectedValues)
              const singleSelectedValue = !isMulti ? draftAnswers[q.id] : ''
              const customSingleSelected =
                !isMulti && singleSelectedValue && !optionValues(q).has(singleSelectedValue)
              const customMultiValues = isMulti
                ? selectedValues.filter(value => !optionValues(q).has(value))
                : []
              return (
                <div key={q.id} className="clar-question">
                  <div className="clar-question-title">{q.label || q.question || q.id}</div>
                  {hint ? <div className="clar-question-hint">{hint}</div> : null}
                  <div className="clar-options">
                    {(q.options || []).map(opt => {
                      const selected = isMulti
                        ? selectedSet.has(opt.value)
                        : singleSelectedValue === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          className={`clar-option${opt.recommended ? ' clar-option-recommended' : ''}${
                            selected ? ' clar-option-selected' : ''
                          }`}
                          disabled={!canAnswerQuestions || answerBusy}
                          aria-pressed={selected}
                          aria-busy={answerBusy}
                          onClick={() =>
                            isMulti ? toggleMultiAnswer(q, opt.value) : setSingleAnswer(q.id, opt.value)
                          }
                        >
                          <span className="clar-option-label">{opt.label || opt.value}</span>
                          {opt.reason ? (
                            <span className="clar-option-reason">{opt.reason}</span>
                          ) : null}
                          {selected ? (
                            <em className="clar-option-badge">已选</em>
                          ) : opt.recommended ? (
                            <em className="clar-option-badge">推荐</em>
                          ) : null}
                        </button>
                      )
                    })}
                    {q.allowCustom ? (
                      <ClarCustomInput
                        disabled={!canAnswerQuestions || answerBusy}
                        submitLabel={isMulti ? '添加' : '选择'}
                        onSubmit={v => (isMulti ? addMultiAnswer(q.id, v) : addSingleAnswer(q.id, v))}
                      />
                    ) : null}
                    {customSingleSelected ? (
                      <div className="clar-selected-customs">
                        <span className="clar-selected-custom">已选择：{singleSelectedValue}</span>
                      </div>
                    ) : null}
                    {customMultiValues.length > 0 ? (
                      <div className="clar-selected-customs">
                        {customMultiValues.map(value => (
                          <span key={value} className="clar-selected-custom">
                            {value}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
            <div className="clar-round-actions">
              <span className="clar-round-progress">
                已完成 {answeredCount}/{visibleQuestions.length}
              </span>
              <button
                type="button"
                className="clar-custom-submit clar-round-submit"
                disabled={!canSubmitRound}
                onClick={submitRoundAnswers}
                title={roundSubmitTitle}
              >
                {answerBusy ? '处理中' : '提交本轮澄清'}
              </button>
            </div>
          </div>
        )}

        {blueprints.length > 0 && (
          <div className="clar-blueprints">
            <div className="clar-blueprints-title">参考蓝本</div>
            <div className="clar-blueprint-chips">
              {blueprints.map((bp, i) => (
                <span key={bp.id || `bp_${i}`} className="clar-blueprint-chip">
                  <span className="clar-bp-name">{bp.name || bp.id}</span>
                  {bp.referenceKind ? (
                    <span className="clar-bp-kind">{bp.referenceKind}</span>
                  ) : null}
                  {bp.reason ? <span className="clar-bp-reason">{bp.reason}</span> : null}
                </span>
              ))}
            </div>
          </div>
        )}

        {requirement && (
          <div className="clar-summary">
            <strong className="clar-summary-title">确认需求摘要</strong>
            {requirement.description ? (
              <p className="clar-summary-desc">{requirement.description}</p>
            ) : null}
            <div className="clar-summary-grid">
              <SummaryRow label="应用类型" value={formatAppType(requirement.appType)} />
              <SummaryRow label="应用名称" value={requirement.appName} />
              <SummaryRow label="核心场景" value={requirement.coreScenario} />
              <SummaryRow label="主视图" value={requirement.primaryView} />
              <SummaryRow label="数据策略" value={requirement.dataPolicy} />
            </div>
            {Array.isArray(requirement.blueprintRefs) &&
            requirement.blueprintRefs.length > 0 ? (
              <div className="clar-summary-refs">
                <span className="clar-summary-refs-label">蓝本引用：</span>
                {requirement.blueprintRefs.map((ref, i) => (
                  <span key={ref.id || ref.name || `ref_${i}`} className="clar-ref-chip">
                    {ref.name || ref.id || ref}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {error ? <div className="clar-error">{error}</div> : null}

      <footer className="clar-actions">
        {status === 'failed' && (
          <button type="button" className="clar-action clar-retry" onClick={onRetry}>
            重试本轮
          </button>
        )}
        <button type="button" className="clar-action clar-abandon" onClick={handleAbandonRequirement}>
          放弃本次需求
        </button>
        <button
          type="button"
          className="clar-action clar-confirm primary"
          disabled={!canConfirm || answerBusy}
          onClick={onConfirm}
          title={
            answerBusy
              ? '正在处理澄清答案'
              : canConfirm
                ? '确认需求并创建生成任务'
                : '需求尚未就绪，无法确认'
          }
        >
          确认并生成
        </button>
      </footer>
    </section>
  )
}

function SummaryRow({ label, value }) {
  if (value == null || value === '') return null
  return (
    <div className="clar-summary-row">
      <span className="clar-summary-label">{label}</span>
      <span className="clar-summary-value">{value}</span>
    </div>
  )
}

function recommendationValues(q) {
  if (Array.isArray(q.recommendation)) return q.recommendation.filter(Boolean)
  if (q.recommendation) return [q.recommendation]
  return []
}

function optionValues(q) {
  return new Set((q.options || []).map(opt => opt.value))
}

function hasDraftAnswer(value) {
  if (Array.isArray(value)) return value.length > 0
  return typeof value === 'string' && value.trim() !== ''
}

function isAnswerClosedStatus(status) {
  return (
    status === 'ready_to_confirm' ||
    status === 'confirmed' ||
    status === 'abandoned' ||
    status === 'failed'
  )
}

function formatRecommendation(q) {
  const values = recommendationValues(q)
  if (values.length === 0) return q.hint || ''
  const options = q.options || []
  const labels = values.map(value => {
    const opt = options.find(item => item.value === value)
    return opt ? opt.label || opt.value : value
  })
  return `推荐：${labels.join('、')}`
}

function ClarCustomInput({ disabled, onSubmit, submitLabel = '提交' }) {
  const [value, setValue] = useState('')
  const submit = () => {
    const v = value.trim()
    if (!v || disabled) return
    onSubmit(v)
    setValue('')
  }
  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="clar-custom">
      <input
        type="text"
        className="clar-custom-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder="自定义答案（回车提交）"
      />
      <button
        type="button"
        className="clar-custom-submit"
        onClick={submit}
        disabled={disabled || !value.trim()}
      >
        {submitLabel}
      </button>
    </div>
  )
}
