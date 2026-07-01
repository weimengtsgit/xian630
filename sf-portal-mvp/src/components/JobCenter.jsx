import { useEffect, useState, useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ExternalLink,
  RotateCcw,
  Ban,
  Wrench,
  ChevronLeft,
} from 'lucide-react'
import { StepCard, STAGE_LABELS } from './StepCard'
import { StepExecutionDrawer } from './StepExecutionDrawer'
import { buildStepCardView } from '../hooks/executionRecordState'
import { buildCollaborationCardView } from './../hooks/collaborationPlanState'
import { collaborationAgentName } from '../hooks/collaborationAgentLabels'
import './JobCenter.css'

// Fixed ordered step kinds (design §4). Same six stages, fixed order.
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

// formatJobTime renders a job timestamp as HH:mm:ss (or MM-dd HH:mm when the
// job predates today). Used for both created_at (queue time) and started_at
// (actual exec start) — the two are kept visually distinct in the header.
function formatJobTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function JobCenter({
  activeJob,
  // jobs: the SELECTED dialogue's generation tasks, ranked by attention
  // priority (focus task first). The 任务执行 drawer lists ALL of them;
  // onSelectTask drills into a non-focus task. See App.jsx taskProps.
  jobs,
  onSelectTask,
  steps,
  onCancel,
  onRetry,
  onRepairFromFailure,
  onSaveSnapshot,
  loading,
  // Task 6 state surface from useJobs:
  summary,
  artifacts,
  selectedStepId,
  selectedAttempt,
  selectStepAttempt,
  stepOpenRequest,
  getRecords,
  getUnreadCount,
  loadStepRecords,
  getArtifactContent,
  collaborationPlan,
}) {
  // Local drawer tab is owned by the drawer; JobCenter only owns whether the
  // drawer is open (driven by selectedStepId).
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Task-list ↔ task-detail toggle (plan §Task Execution Drawer). The drawer
  // lands on the task list when the dialogue has multiple generation tasks; a
  // single (or zero) task skips the list and goes straight to its detail. The
  // list is ranked upstream (focus task first), so index 0 is always the focus
  // task — marked with a 焦点 badge.
  const dialogueJobs = Array.isArray(jobs) ? jobs : []
  const multiTask = dialogueJobs.length > 1
  const [taskView, setTaskView] = useState('list')
  const view = multiTask ? taskView : 'detail'

  useEffect(() => {
    if (!stepOpenRequest || !stepOpenRequest.stepId) return
    setTaskView('detail')
    setDrawerOpen(true)
  }, [stepOpenRequest])

  // Resolve each fixed step kind to its REAL job_steps.id, then join its
  // summary. The backend execution-summary is keyed by step_id (NOT kind), so
  // we must never index summaries by kind — a kind has no summary entry.
  const cardView = useMemo(
    () => buildStepCardView(steps, summary, FIXED_STEPS),
    [steps, summary],
  )
  const stepByKind = useMemo(() => {
    const map = {}
    cardView.forEach(v => {
      if (v.kind && v.step) map[v.kind] = v.step
    })
    return map
  }, [cardView])
  // Summaries keyed by REAL step_id (the backend key), never by kind.
  const summaryByStepId = useMemo(() => {
    const map = {}
    if (Array.isArray(summary)) {
      summary.forEach(s => {
        if (s && s.step_id != null && !map[s.step_id]) map[s.step_id] = s
      })
    }
    return map
  }, [summary])

  // Collaboration plan: render lanes of agent cards when a plan is present,
  // falling back to the fixed six-step matrix for legacy jobs.
  const collaborationLanes = useMemo(
    () => buildCollaborationCardView(steps, summary, collaborationPlan),
    [steps, summary, collaborationPlan],
  )
  const hasCollaborationPlan = collaborationLanes.length > 0

  const jobStatus = activeJob ? activeJob.status || 'queued' : 'queued'
  const isTerminal = ['completed', 'canceled', 'cancelled', 'failed'].includes(jobStatus)
  const canCancelHeader = activeJob && !isTerminal
  // deployment is included so a health_check_failed deploy can be repaired
  // (regenerated with the failure context). The backend enforces that ONLY
  // health_check_failed deploy failures are actually repairable; other deploy
  // failures (port/run infra errors) are rejected server-side with a message.
  const canRepairFromFailure =
    jobStatus === 'failed' &&
    ['test_verification', 'image_build', 'deployment'].includes(
      activeJob?.current_step_kind,
    )

  // --- Drawer wiring ------------------------------------------------------
  // Opening a card resolves the REAL stepId (from stepByKind / cardView) and
  // passes that to selectStepAttempt(stepId, attempt). The backend records
  // endpoint REQUIRES the real job_steps.id; a kind like "requirement_analysis"
  // would 404. `selectedStepId` always holds a real step_id end-to-end.
  const openDrawerFor = kind => {
    const step = stepByKind[kind]
    const stepId = step && step.id
    if (!stepId) return
    const sm = summaryByStepId[stepId]
    const attempt =
      (sm && (sm.attempt ?? sm.latest_attempt)) ??
      (step && (step.attempt ?? step.latest_attempt)) ??
      1
    setDrawerOpen(true)
    if (selectStepAttempt) selectStepAttempt(stepId, attempt)
  }

  // Open the drawer by a REAL step id (collaboration-plan cards carry the id
  // directly, so no kind -> stepId resolution is needed).
  const openDrawerForStepId = stepId => {
    if (!stepId) return
    const sm = summaryByStepId[stepId]
    const step = (Array.isArray(steps) ? steps : []).find(s => s && s.id === stepId)
    const attempt = (sm && (sm.attempt ?? sm.latest_attempt)) ?? (step && step.attempt) ?? 1
    setDrawerOpen(true)
    if (selectStepAttempt) selectStepAttempt(stepId, attempt)
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    if (selectStepAttempt) selectStepAttempt(null, null)
  }

  // Lookups key off the real step_id (selectedStepId), not the kind.
  const selectedStep = useMemo(() => {
    if (!selectedStepId) return null
    return (Array.isArray(steps) ? steps : []).find(s => s && s.id === selectedStepId) || null
  }, [steps, selectedStepId])
  const selectedSummary = selectedStepId ? summaryByStepId[selectedStepId] : null
  const selectedStageLabel = selectedStepId
    ? (() => {
        for (const group of collaborationLanes) {
          const collaborationEntry = group.cards.find(v => v.stepId === selectedStepId)
          if (collaborationEntry && collaborationEntry.label) return collaborationEntry.label
          if (collaborationEntry && collaborationEntry.agent) return collaborationAgentName(collaborationEntry.agent)
        }
        const entry = cardView.find(v => v.stepId === selectedStepId)
        if (entry && entry.label) return entry.label
        if (entry && entry.kind) return STAGE_LABELS[entry.kind] || entry.kind
        return null
      })()
    : null

  const selectedAttempts = useMemo(() => {
    if (!selectedStepId) return []
    const sm = summaryByStepId[selectedStepId]
    const latest =
      sm && Number.isFinite(sm.latest_attempt) && sm.latest_attempt >= 1
        ? sm.latest_attempt
        : 0
    if (latest >= 1) {
      return Array.from({ length: latest }, (_, i) => latest - i)
    }
    if (selectedAttempt != null) return [selectedAttempt]
    return []
  }, [summaryByStepId, selectedStepId, selectedAttempt])

  // Records view (REST page + live SSE tail merged ascending) for the open
  // step+attempt. Memoized so the drawer's follow-effect deps are stable.
  const recordsView = useMemo(() => {
    if (!selectedStepId || selectedAttempt == null || !getRecords) return []
    return getRecords(selectedStepId, selectedAttempt)
  }, [selectedStepId, selectedAttempt, getRecords])

  // Older-page support: when the drawer asks for older records, compute the
  // smallest sequence currently shown and page before it.
  const oldestSeq = recordsView.length > 0
    ? recordsView.reduce((m, r) => Math.min(m, r.sequence || 0), Infinity)
    : 0
  const hasOlder = recordsView.length >= 200 || oldestSeq > 1
  const loadOlder = () => {
    if (!loadStepRecords || !selectedStepId || selectedAttempt == null) return
    loadStepRecords(selectedStepId, selectedAttempt, Number.isFinite(oldestSeq) ? oldestSeq : 0)
  }

  const onSelectAttempt = attempt => {
    if (selectStepAttempt && selectedStepId) selectStepAttempt(selectedStepId, attempt)
  }

  if (!activeJob) {
    return (
      <section className="job-center job-center-empty">
        <div className="jc-placeholder">
          <AlertTriangle size={22} />
          <p>当前会话暂无生成任务</p>
          <span className="jc-hint">在对话区输入需求以创建新的生成任务</span>
        </div>
      </section>
    )
  }

  return (
    <section className={`job-center job-status-${jobStatus}`}>
      {view === 'list' ? (
        <div className="jc-task-list">
          <div className="jc-task-list-head">
            <span className="jc-label">生成任务</span>
            <span className="jc-task-count">{dialogueJobs.length} 个任务</span>
          </div>
          {dialogueJobs.map((job, index) => {
            const status = job.status || 'queued'
            const title = job.app_name || job.user_prompt || job.normalized_prompt || job.id
            const selected = !!(activeJob && job.id === activeJob.id)
            return (
              <button
                key={job.id}
                type="button"
                className={`jc-task-card jc-status-${status}${selected ? ' jc-task-card-selected' : ''}`}
                aria-pressed={selected ? 'true' : 'false'}
                aria-label={`查看任务 ${title}`}
                onClick={() => {
                  if (onSelectTask) onSelectTask(job.id)
                  setTaskView('detail')
                }}
              >
                <div className="jc-task-card-head">
                  <span className={`jc-status-badge jc-status-${status}`}>
                    {JOB_STATUS_LABEL[status] || status}
                  </span>
                  {index === 0 ? <span className="jc-task-focus">焦点</span> : null}
                </div>
                <div className="jc-task-card-title">{title}</div>
                <div className="jc-task-card-meta">
                  {job.started_at ? (
                    <time dateTime={job.started_at}>开始 {formatJobTime(job.started_at)}</time>
                  ) : job.created_at ? (
                    <time dateTime={job.created_at}>排队 {formatJobTime(job.created_at)}</time>
                  ) : null}
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <>
      <header className="jc-header">
        <div className="jc-title-block">
          {multiTask ? (
            <button
              type="button"
              className="jc-back"
              onClick={() => setTaskView('list')}
              aria-label="返回任务列表"
            >
              <ChevronLeft size={14} /> 任务列表
            </button>
          ) : null}
          <span className="jc-label">当前任务</span>
          {/* started_at (actual exec start) vs created_at (queue time) — Constraint #10.
              Show both, distinctly, when present. */}
          <div className="jc-time-block">
            {activeJob.started_at ? (
              <span className="jc-time jc-time-started" title="开始执行">
                <small>开始执行</small>
                <time dateTime={activeJob.started_at}>{formatJobTime(activeJob.started_at)}</time>
              </span>
            ) : null}
            {activeJob.ended_at ? (
              <span className="jc-time jc-time-ended" title="结束执行">
                <small>结束执行</small>
                <time dateTime={activeJob.ended_at}>{formatJobTime(activeJob.ended_at)}</time>
              </span>
            ) : null}
          </div>
        </div>
        <div className="jc-header-right">
          <span className={`jc-status-badge jc-status-${jobStatus}`}>
            {JOB_STATUS_LABEL[jobStatus] || jobStatus}
          </span>
          {canCancelHeader && (
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

      {/*
        Phase 2: in-drawer list↔detail toggle. The body switches between the
        vertical 执行波次 list and the embedded step detail (rendered INLINE,
        no createPortal overlay). `drawerOpen` (driven by selectedStepId) is the
        toggle; the detail's back button calls closeDrawer to return to the
        list. Both views live inside this one drawer — no stacked overlays.
      */}
      {drawerOpen && selectedStepId ? (
        <StepExecutionDrawer
          embedded
          open
          onBack={closeDrawer}
          onClose={closeDrawer}
          step={selectedStep}
          summary={selectedSummary}
          stageLabel={selectedStageLabel}
          attempts={selectedAttempts}
          selectedAttempt={selectedAttempt}
          onSelectAttempt={onSelectAttempt}
          records={recordsView}
          onLoadOlder={loadOlder}
          hasOlder={hasOlder}
          loadingOlder={false}
          onCancel={() => onCancel && onCancel(activeJob.id)}
          onRetry={() => onRetry && onRetry(activeJob.id)}
          onRepairFromFailure={() => onRepairFromFailure && onRepairFromFailure(activeJob.id)}
          onSaveSnapshot={(stepId, snapshot) =>
            onSaveSnapshot && onSaveSnapshot(activeJob.id, stepId, snapshot)
          }
          artifacts={artifacts || []}
          getArtifactContent={getArtifactContent}
        />
      ) : (
        <div className="jc-waves">
          {hasCollaborationPlan
            ? collaborationLanes.map(group => (
                <section className="jc-wave" key={group.lane.id}>
                  <h3 className="jc-wave-title">{group.lane.label}</h3>
                  <div className="jc-wave-cards">
                    {group.cards.map(view => {
                      const attempt =
                        (view.summary && (view.summary.attempt ?? view.summary.latest_attempt)) ??
                        (view.step && (view.step.attempt ?? view.step.latest_attempt)) ??
                        null
                      return (
                        <StepCard
                          key={view.agent.key}
                          kind={view.kind}
                          label={view.label}
                          agent={view.agent}
                          step={view.step}
                          summary={view.summary}
                          selected={!!view.stepId && selectedStepId === view.stepId}
                          unreadCount={view.stepId && getUnreadCount ? getUnreadCount(view.stepId, attempt) : 0}
                          onSelect={() => openDrawerForStepId(view.stepId)}
                        />
                      )
                    })}
                  </div>
                </section>
              ))
            : (
                <section className="jc-wave">
                  <h3 className="jc-wave-title">执行阶段</h3>
                  <div className="jc-wave-cards">
                    {cardView.map(view => {
                      const { kind, label, stepId, step, summary: sm } = view
                      const attempt =
                        (sm && (sm.attempt ?? sm.latest_attempt)) ??
                        (step && (step.attempt ?? step.latest_attempt)) ??
                        null
                      // Unread and selected both key off the REAL step_id.
                      const unread = stepId && getUnreadCount ? getUnreadCount(stepId, attempt) : 0
                      return (
                        <StepCard
                          key={kind}
                          kind={kind}
                          label={label}
                          step={step}
                          summary={sm}
                          selected={!!stepId && selectedStepId === stepId}
                          unreadCount={unread}
                          onSelect={openDrawerFor}
                        />
                      )
                    })}
                  </div>
                </section>
              )}
        </div>
      )}

      {jobStatus === 'failed' && !drawerOpen && (
        <div className="jc-actions">
          <button
            type="button"
            className="jc-action jc-retry"
            onClick={() => onRetry && onRetry(activeJob.id)}
          >
            <RotateCcw size={14} /> 重试当前阶段
          </button>
          {canRepairFromFailure ? (
            <button
              type="button"
              className="jc-action jc-retry"
              onClick={() => onRepairFromFailure && onRepairFromFailure(activeJob.id)}
            >
              <Wrench size={14} /> 发送错误给代码修复
            </button>
          ) : null}
        </div>
      )}

      {jobStatus === 'completed' && (activeJob.runtime_url || activeJob.url) && !drawerOpen ? (
        <div className="jc-completed">
          <CheckCircle2 size={18} />
          <a
            className="jc-open"
            href={activeJob.runtime_url || activeJob.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} /> 打开应用
          </a>
        </div>
      ) : null}
        </>
      )}

      {loading && <div className="jc-loading-hint">同步任务状态中...</div>}
    </section>
  )
}
