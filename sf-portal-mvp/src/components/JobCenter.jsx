import { useState, useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ExternalLink,
  RotateCcw,
  Ban,
  Wrench,
} from 'lucide-react'
import { StepCard, STAGE_LABELS } from './StepCard'
import { StepExecutionDrawer } from './StepExecutionDrawer'
import { buildStepCardView } from '../hooks/executionRecordState'
import { buildCollaborationCardView } from './../hooks/collaborationPlanState'
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
  getRecords,
  getUnreadCount,
  loadStepRecords,
  getArtifactContent,
  collaborationPlan,
}) {
  // Local drawer tab is owned by the drawer; JobCenter only owns whether the
  // drawer is open (driven by selectedStepId).
  const [drawerOpen, setDrawerOpen] = useState(false)

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
          <p>当前没有进行中的生成任务</p>
          <span className="jc-hint">在下方输入需求以创建新的任务</span>
        </div>
      </section>
    )
  }

  return (
    <section className={`job-center job-status-${jobStatus}`}>
      <header className="jc-header">
        <div className="jc-title-block">
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

      {hasCollaborationPlan ? (
        <div className="jc-collaboration-lanes">
          {collaborationLanes.map(group => (
            <section className="jc-lane" key={group.lane.id}>
              <h3 className="jc-lane-title">{group.lane.label}</h3>
              <div className="jc-step-matrix">
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
          ))}
        </div>
      ) : (
        <div className="jc-step-matrix">
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

      {jobStatus === 'completed' && (activeJob.runtime_url || activeJob.url) ? (
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

      {loading && <div className="jc-loading-hint">同步任务状态中...</div>}

      {/* Right-side overlay drawer. Does NOT consume center-column space; it
          overlays the agent-list region. */}
      <StepExecutionDrawer
        open={drawerOpen && !!selectedStepId}
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
    </section>
  )
}
