import { useState, useEffect } from 'react'
import {
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  ExternalLink,
  RotateCcw,
  Ban,
} from 'lucide-react'
import { factoryApi } from '../api/client'
import { displayJobTitle } from '../hooks/jobSelection'
import './JobCenter.css'

// Fixed ordered step kinds (design §4)
const FIXED_STEPS = [
  { kind: 'requirement_analysis', label: '需求分析' },
  { kind: 'solution_design', label: '方案设计' },
  { kind: 'code_generation', label: '代码生成' },
  { kind: 'test_verification', label: '测试验证' },
  { kind: 'image_build', label: '镜像构建' },
  { kind: 'deployment', label: '部署' },
]

const JOB_STATUS_LABEL = {
  draft: '草稿',
  queued: '排队中',
  running: '运行中',
  waiting_user: '等待用户',
  failed: '已失败',
  completed: '已完成',
  canceled: '已取消',
  cancelled: '已取消',
}

const STEP_STATUS_LABEL = {
  pending: '等待中',
  running: '进行中',
  waiting_user: '等待用户',
  succeeded: '已完成',
  failed: '已失败',
  skipped: '已跳过',
  canceled: '已取消',
  cancelled: '已取消',
}

function StepIcon({ status }) {
  switch (status) {
    case 'running':
      return <Loader2 size={14} className="spin" />
    case 'succeeded':
      return <CheckCircle2 size={14} />
    case 'failed':
      return <XCircle size={14} />
    case 'waiting_user':
      return <HelpCircle size={14} />
    case 'skipped':
    case 'canceled':
    case 'cancelled':
      return <Ban size={14} />
    default:
      return <Clock size={14} />
  }
}

export function JobCenter({ activeJob, steps, onCancel, onRetry, loading }) {
  const [detail, setDetail] = useState(null)

  // For waiting_user we try to fetch job detail to surface a clarifying
  // question if present; keep defensive — failures just hide the area.
  useEffect(() => {
    let cancelled = false
    setDetail(null)
    if (!activeJob || activeJob.status !== 'waiting_user') return undefined
    factoryApi
      .getJob(activeJob.id)
      .then(d => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeJob && activeJob.id, activeJob && activeJob.status])

  if (!activeJob) {
    return (
      <section className="job-center job-center-empty">
        <div className="jc-placeholder">
          <AlertTriangle size={22} />
          <p>当前没有进行中的生成任务</p>
          <span className="jc-hint">在下方输入需求以创建新的任务</span>
        </div>
      </section>
    )
  }

  // Map returned steps by kind; not-yet-started steps fall back to pending.
  const stepByKind = {}
  if (Array.isArray(steps)) {
    steps.forEach(s => {
      const key = s.kind || s.step || s.name
      if (key) stepByKind[key] = s
    })
  }

  const jobStatus = activeJob.status || 'queued'
  const isTerminal = ['completed', 'canceled', 'cancelled', 'failed'].includes(jobStatus)
  const canCancel = !isTerminal
  const canRetry = jobStatus === 'failed'
  const waitingQuestions =
    detail &&
    (detail.pending_questions ||
      detail.clarify_questions ||
      detail.waiting_questions ||
      detail.questions)

  return (
    <section className={`job-center job-status-${jobStatus}`}>
      <header className="jc-header">
        <div className="jc-title-block">
          <span className="jc-label">当前任务</span>
          <h2 className="jc-prompt">{displayJobTitle(activeJob)}</h2>
        </div>
        <div className="jc-header-right">
          <span className={`jc-status-badge jc-status-${jobStatus}`}>
            {JOB_STATUS_LABEL[jobStatus] || jobStatus}
          </span>
          {canCancel && (
            <button
              type="button"
              className="jc-action jc-cancel"
              onClick={() => onCancel && onCancel(activeJob.id)}
            >
              <Ban size={14} /> 取消
            </button>
          )}
        </div>
      </header>

      {activeJob.error || activeJob.failure_reason ? (
        <div className="jc-failure">
          <XCircle size={16} />
          <span>{activeJob.error || activeJob.failure_reason}</span>
        </div>
      ) : null}

      <div className="jc-steps">
        {FIXED_STEPS.map((fixed, idx) => {
          const step = stepByKind[fixed.kind]
          const status = (step && (step.status || step.state)) || 'pending'
          return (
            <div key={fixed.kind} className={`jc-step jc-step-${status}`}>
              <span className="jc-step-index">{idx + 1}</span>
              <span className="jc-step-label">{fixed.label}</span>
              <span className={`jc-step-status jc-step-status-${status}`}>
                <StepIcon status={status} />
                {STEP_STATUS_LABEL[status] || status}
              </span>
              {step && step.error_message ? (
                <span className="jc-step-error">{step.error_message}</span>
              ) : null}
            </div>
          )
        })}
      </div>

      {jobStatus === 'waiting_user' && (
        <div className="jc-waiting">
          <HelpCircle size={18} />
          <div className="jc-waiting-body">
            <strong>等待用户澄清</strong>
            {Array.isArray(waitingQuestions) && waitingQuestions.length > 0 ? (
              <ul>
                {waitingQuestions.map((q, i) => (
                  <li key={i}>{typeof q === 'string' ? q : q.question || q.text || JSON.stringify(q)}</li>
                ))}
              </ul>
            ) : (
              <p>任务需要你的补充输入，请在底部对话区回复或前往任务详情页回答。</p>
            )}
          </div>
        </div>
      )}

      {jobStatus === 'failed' && (
        <div className="jc-actions">
          <button
            type="button"
            className="jc-action jc-retry"
            onClick={() => onRetry && onRetry(activeJob.id)}
          >
            <RotateCcw size={14} /> 重试当前阶段
          </button>
        </div>
      )}

      {jobStatus === 'completed' && (
        <div className="jc-completed">
          <CheckCircle2 size={18} />
          <span>任务已完成</span>
          {activeJob.runtime_url || activeJob.url ? (
            <a
              className="jc-open"
              href={activeJob.runtime_url || activeJob.url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} /> 打开应用
            </a>
          ) : null}
        </div>
      )}

      {loading && <div className="jc-loading-hint">同步任务状态中...</div>}
    </section>
  )
}
