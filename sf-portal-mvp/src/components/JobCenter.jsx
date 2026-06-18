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
  X,
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

const AGENT_PROFILE = {
  'requirement-analyst': { name: '需求分析智能体', role: '澄清目标、整理需求边界' },
  'solution-designer': { name: '方案设计智能体', role: '拆解技术方案和交付计划' },
  'code-generator': { name: '代码生成智能体', role: '生成项目代码和 manifest' },
  tester: { name: '测试验证智能体', role: '执行构建检查和诊断验证' },
  deployer: { name: '构建部署智能体', role: '镜像构建、容器启动和部署' },
}

function statusToken(status) {
  switch (status) {
    case 'succeeded':
      return 'DONE'
    case 'failed':
    case 'waiting_user':
      return 'BLOCKED'
    case 'running':
      return 'RUNNING'
    case 'pending':
      return 'IDLE'
    default:
      return STEP_STATUS_LABEL[status] || status
  }
}

function statusClass(status) {
  if (status === 'succeeded') return 'done'
  if (status === 'failed' || status === 'waiting_user') return 'blocked'
  if (status === 'running') return 'running'
  return 'idle'
}

function jobTabClass(status) {
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'waiting_user') return 'blocked'
  if (status === 'running' || status === 'queued') return 'running'
  return 'idle'
}

function agentProfile(agentKey) {
  if (!agentKey) return { name: '待分配智能体', role: '等待任务调度' }
  return AGENT_PROFILE[agentKey] || { name: agentKey, role: '执行当前阶段任务' }
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatStepDuration(startedAt, endedAt) {
  if (!startedAt) return '未开始'
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

function groupArtifactsByStep(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).reduce((acc, artifact) => {
    if (!artifact.step_id) return acc
    if (!acc[artifact.step_id]) acc[artifact.step_id] = []
    acc[artifact.step_id].push(artifact)
    return acc
  }, {})
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

export function JobCenter({ jobs: jobList, activeJob, steps, onSelectJob, onCloseJob, onCancel, onRetry, loading }) {
  const [detail, setDetail] = useState(null)
  const [artifacts, setArtifacts] = useState([])
  const [artifactContents, setArtifactContents] = useState({})
  const [selectedStepKind, setSelectedStepKind] = useState(null)

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

  useEffect(() => {
    let cancelled = false
    setArtifacts([])
    setArtifactContents({})
    if (!activeJob) return undefined
    factoryApi
      .getJobArtifacts(activeJob.id)
      .then(data => {
        const list = Array.isArray(data) ? data : (data.artifacts || [])
        if (!cancelled) setArtifacts(list)
      })
      .catch(() => {
        if (!cancelled) setArtifacts([])
      })
    return () => {
      cancelled = true
    }
  }, [activeJob && activeJob.id, loading])

  useEffect(() => {
    let cancelled = false
    const outputArtifacts = artifacts.filter(artifact =>
      ['output_markdown', 'output_json'].includes(artifact.kind),
    )
    setArtifactContents({})
    if (outputArtifacts.length === 0) return undefined

    Promise.all(
      outputArtifacts.map(artifact =>
        factoryApi
          .getArtifactContent(artifact.id)
          .then(content => [artifact.id, content])
          .catch(() => [artifact.id, '']),
      ),
    ).then(entries => {
      if (cancelled) return
      setArtifactContents(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [artifacts])

  // 将后端步骤按 kind 补齐到固定六阶段，未开始的阶段用 pending 兜底。
  const stepByKind = {}
  if (Array.isArray(steps)) {
    steps.forEach(s => {
      const key = s.kind || s.step || s.name
      if (key) stepByKind[key] = s
    })
  }
  const resolvedSteps = FIXED_STEPS.map((fixed, idx) => {
    const step = stepByKind[fixed.kind]
    return {
      ...fixed,
      ...step,
      kind: fixed.kind,
      label: fixed.label,
      seq: step?.seq || idx + 1,
      status: (step && (step.status || step.state)) || 'pending',
    }
  })

  const jobStatus = activeJob?.status || 'queued'
  const isTerminal = ['completed', 'canceled', 'cancelled', 'failed'].includes(jobStatus)
  const canCancel = !isTerminal
  const canRetry = jobStatus === 'failed'
  const waitingQuestions =
    detail &&
    (detail.pending_questions ||
      detail.clarify_questions ||
      detail.waiting_questions ||
      detail.questions)
  const artifactsByStep = groupArtifactsByStep(artifacts)
  const visibleJobs = Array.isArray(jobList) ? jobList.slice(0, 8) : []

  const renderStepDetail = step => {
    const stepArtifacts = step ? artifactsByStep[step.id] || [] : []
    // 展开区只展示真实的智能体返回内容，避免继续堆无用状态指标。
    const outputArtifacts = stepArtifacts
      .filter(artifact => ['output_markdown', 'output_json'].includes(artifact.kind))
      .sort((a, b) => {
        const rank = { output_markdown: 0, output_json: 1 }
        return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)
      })

    return (
      <div className={`jc-agent-detail jc-agent-detail-${step.status}`}>
        <div className="jc-agent-detail-head">
          <div>
            <span className="jc-label">AI 返回内容</span>
          </div>
        </div>

        <div className="jc-agent-output-list">
          {step.error_message ? (
            <article className="jc-agent-output jc-agent-output-error">
              <strong>{step.error_code || '执行失败'}</strong>
              <pre>{step.error_message}</pre>
            </article>
          ) : null}

          {outputArtifacts.length > 0 ? (
            outputArtifacts.map(artifact => (
              <article key={artifact.id} className="jc-agent-output">
                <header>
                  <strong>{artifact.kind === 'output_markdown' ? 'output.md' : 'output.json'}</strong>
                  <span>{artifact.summary || '智能体返回内容'}</span>
                </header>
                <pre>{artifactContents[artifact.id] || '正在读取智能体返回内容...'}</pre>
              </article>
            ))
          ) : (
            <p className="jc-agent-output-empty">
              智能体已进入该阶段，正在等待写入 output.md / output.json。
            </p>
          )}
        </div>
      </div>
    )
  }

  useEffect(() => {
    if (!activeJob) {
      setSelectedStepKind(null)
      return
    }
    setSelectedStepKind(null)
  }, [activeJob && activeJob.id])

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

  return (
    <section className={`job-center job-status-${jobStatus}`}>
      <header className="jc-task-tabbar" aria-label="任务标签页">
        <div className="jc-task-tabs">
          {visibleJobs.length > 0 ? (
            visibleJobs.map(job => {
              const tone = jobTabClass(job.status)
              const isActive = activeJob && activeJob.id === job.id
              return (
                <button
                  key={job.id}
                  type="button"
                  className={`jc-task-tab jc-task-tab-${tone} ${isActive ? 'is-active' : ''}`}
                  onClick={() => onSelectJob && onSelectJob(job.id)}
                  title={displayJobTitle(job)}
                >
                  <span className="jc-task-tab-label">{displayJobTitle(job)}</span>
                  <span className="jc-task-tab-status">{JOB_STATUS_LABEL[job.status] || job.status}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="jc-task-tab-close"
                    aria-label={`关闭 ${displayJobTitle(job)}`}
                    onClick={event => {
                      event.stopPropagation()
                      onCloseJob && onCloseJob(job.id)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        onCloseJob && onCloseJob(job.id)
                      }
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              )
            })
          ) : (
            <div className="jc-task-tab jc-task-tab-idle is-active">
              <span className="jc-task-tab-label">{displayJobTitle(activeJob)}</span>
              <span className="jc-task-tab-status">{JOB_STATUS_LABEL[jobStatus] || jobStatus}</span>
            </div>
          )}
        </div>

      </header>

      {activeJob.error || activeJob.failure_reason ? (
        <div className="jc-failure">
          <XCircle size={16} />
          <span>{activeJob.error || activeJob.failure_reason}</span>
        </div>
      ) : null}

      <div className="jc-agent-board">
        <div className="jc-agent-board-head">
          <div>
            <span className="jc-label">Agent 运行监控台</span>
            <strong>{displayJobTitle(activeJob)}</strong>
          </div>
          <div className="jc-overall-actions">
            {canRetry && (
              <button
                type="button"
                className="jc-action jc-retry"
                onClick={() => onRetry && onRetry(activeJob.id)}
              >
                <RotateCcw size={14} /> 重试当前阶段
              </button>
            )}
            {!canRetry && canCancel && (
              <button
                type="button"
                className="jc-action jc-cancel"
                onClick={() => onCancel && onCancel(activeJob.id)}
              >
                <Ban size={14} /> 取消
              </button>
            )}
            <span className={`jc-status-badge jc-status-${jobStatus}`}>
              {JOB_STATUS_LABEL[jobStatus] || jobStatus}
            </span>
          </div>
        </div>

        <div className="jc-agent-layout">
          <div className="jc-agent-list" role="list" aria-label="智能体协同流程">
            {resolvedSteps.map((step, idx) => {
              const status = step.status
              const isSelected = selectedStepKind === step.kind
              const agent = agentProfile(step.agent_key)
              return (
                <div key={step.kind} className="jc-agent-row" role="listitem">
                  <button
                    type="button"
                    className={`jc-agent-node jc-agent-node-${status} jc-agent-tone-${statusClass(status)} ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedStepKind(current => (current === step.kind ? null : step.kind))}
                    aria-expanded={isSelected}
                  >
                    <span className="jc-agent-index">{String(idx + 1).padStart(2, '0')}</span>
                    <span className="jc-agent-main">
                      <span className="jc-agent-name">{agent.name}</span>
                      <span className="jc-agent-meta">
                        {step.label} · {step.agent_key || 'pending'} · {formatStepDuration(step.started_at, step.ended_at)}
                      </span>
                    </span>
                    <span className={`jc-agent-token jc-agent-token-${statusClass(status)}`}>
                      {statusToken(status)}
                    </span>
                  </button>
                  {isSelected ? renderStepDetail(step) : null}
                </div>
              )
            })}
          </div>

        </div>
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
