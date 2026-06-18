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
  FileText,
  TerminalSquare,
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

const ACTIVE_STEP_STATUSES = new Set(['failed', 'running', 'waiting_user'])

const STEP_DETAIL = {
  requirement_analysis: {
    action: '已完成需求拆解',
    output: 'PRD / 验收点',
    summary: '已完成需求边界、用户目标和验收条件整理。',
  },
  solution_design: {
    action: '等待确认构建策略',
    output: '方案草案 / 风险清单',
    summary: '已完成模块边界、数据流和关键风险整理，等待下一步确认。',
  },
  code_generation: {
    action: '已接收方案上下文',
    output: '源码准备 / manifest 待生成',
    summary: '代码生成智能体已准备接收方案产物并生成项目文件。',
  },
  test_verification: {
    action: '等待代码产物',
    output: '测试计划 / 覆盖目标',
    summary: '测试验证智能体等待代码产物后执行构建与诊断验证。',
  },
  image_build: {
    action: '镜像构建诊断中',
    output: '镜像构建 / 部署配置',
    summary: '当前阻塞在镜像构建阶段，需要处理构建命令或容器环境问题。',
  },
  deployment: {
    action: '等待测试通过',
    output: '服务启动 / 健康检查',
    summary: '部署智能体等待前置阶段通过后启动服务并检查访问地址。',
  },
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
  const selectedStep =
    resolvedSteps.find(step => step.kind === selectedStepKind) || resolvedSteps[0]
  const selectedAgent = agentProfile(selectedStep && selectedStep.agent_key)
  const selectedArtifacts = selectedStep ? artifactsByStep[selectedStep.id] || [] : []
  const completedStepCount = resolvedSteps.filter(step => step.status === 'succeeded').length
  const activeAgentCount = new Set(resolvedSteps.filter(step => step.agent_key).map(step => step.agent_key)).size
  const blockedStepCount = resolvedSteps.filter(step => step.status === 'failed' || step.status === 'waiting_user').length
  const retryCount = resolvedSteps.reduce((sum, step) => sum + Math.max(0, (step.attempt || 0) - 1), 0)
  const totalAttempts = resolvedSteps.reduce((sum, step) => sum + (step.attempt || 0), 0)
  const healthScore = Math.max(
    0,
    Math.min(100, Math.round((completedStepCount / resolvedSteps.length) * 100 + (jobStatus === 'running' ? 15 : 0) - blockedStepCount * 10)),
  )
  const selectedCopy = selectedStep ? STEP_DETAIL[selectedStep.kind] || {} : {}
  const selectedTone = selectedStep ? statusClass(selectedStep.status) : 'idle'
  const visibleJobs = Array.isArray(jobList) ? jobList.slice(0, 8) : []

  useEffect(() => {
    if (!activeJob) {
      setSelectedStepKind(null)
      return
    }
    // 默认聚焦失败、运行或等待用户的智能体，便于用户第一眼看到阻塞点。
    const activeStep = resolvedSteps.find(step => ACTIVE_STEP_STATUSES.has(step.status))
    setSelectedStepKind((activeStep || resolvedSteps.find(step => step.kind === activeJob.current_step_kind) || resolvedSteps[0])?.kind || null)
  }, [activeJob && activeJob.id, activeJob && activeJob.status, activeJob && activeJob.current_step_kind, steps])

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
              const isSelected = selectedStep && selectedStep.kind === step.kind
              const agent = agentProfile(step.agent_key)
              return (
                <button
                  key={step.kind}
                  type="button"
                  className={`jc-agent-node jc-agent-node-${status} jc-agent-tone-${statusClass(status)} ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setSelectedStepKind(step.kind)}
                  aria-expanded={isSelected}
                >
                  <span className="jc-agent-index">{String(idx + 1).padStart(2, '0')}</span>
                  <span className="jc-agent-main">
                    <span className="jc-agent-name">{agent.name}</span>
                    <span className="jc-agent-meta">
                      {step.label} · {step.agent_key || 'pending'} · {formatStepDuration(step.started_at, step.ended_at)}
                    </span>
                    <span className="jc-agent-action">{(STEP_DETAIL[step.kind] || {}).action || '等待调度'}</span>
                  </span>
                  <span className={`jc-agent-token jc-agent-token-${statusClass(status)}`}>
                    {statusToken(status)}
                  </span>
                </button>
              )
            })}
          </div>

          {selectedStep && (
            <div className={`jc-agent-detail jc-agent-detail-${selectedStep.status}`}>
              <div className="jc-agent-detail-head">
                <div>
                  <span className="jc-label">智能体执行详情</span>
                  <h3>{selectedAgent.name}</h3>
                  <p>{selectedStep.label} · {selectedStep.agent_key || 'pending'}</p>
                </div>
                <span className={`jc-agent-token jc-agent-token-${selectedTone}`}>
                  {statusToken(selectedStep.status)}
                </span>
              </div>

              <dl className="jc-agent-metrics">
                <div>
                  <dt>负责阶段</dt>
                  <dd>{selectedStep.label}</dd>
                </div>
                <div>
                  <dt>尝试次数</dt>
                  <dd>{selectedStep.attempt || 0}</dd>
                </div>
                <div>
                  <dt>开始时间</dt>
                  <dd>{formatDateTime(selectedStep.started_at)}</dd>
                </div>
                <div>
                  <dt>结束时间</dt>
                  <dd>{formatDateTime(selectedStep.ended_at)}</dd>
                </div>
                <div>
                  <dt>执行耗时</dt>
                  <dd>{formatStepDuration(selectedStep.started_at, selectedStep.ended_at)}</dd>
                </div>
                <div>
                  <dt>会话标识</dt>
                  <dd>{selectedStep.claude_session_id || selectedStep.cc_status_session_id || '—'}</dd>
                </div>
              </dl>

              <div className="jc-status-summary">
                <strong>当前状态摘要</strong>
                <p>{selectedCopy.summary || selectedAgent.role}</p>
                <p>下一步：{selectedStep.status === 'failed' ? '处理阻塞原因后重试当前阶段。' : selectedCopy.action || '等待调度。'}</p>
              </div>

              {selectedStep.error_message ? (
                <div className="jc-agent-error">
                  <TerminalSquare size={15} />
                  <div>
                    <strong>{selectedStep.error_code || '执行失败'}</strong>
                    <p>{selectedStep.error_message}</p>
                  </div>
                </div>
              ) : null}

              <div className="jc-agent-artifacts">
                <div className="jc-agent-artifacts-title">
                  <FileText size={15} />
                  <span>阶段产物</span>
                </div>
                {selectedArtifacts.length > 0 ? (
                  <div className="jc-artifact-list">
                    {selectedArtifacts.map(artifact => (
                      <a
                        key={artifact.id}
                        className="jc-artifact"
                        href={factoryApi.artifactContentUrl(artifact.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span>{artifact.summary || artifact.kind || artifact.path}</span>
                        <ExternalLink size={13} />
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="jc-artifacts-empty">当前阶段还没有可查看的产物。</p>
                )}
              </div>
            </div>
          )}
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
