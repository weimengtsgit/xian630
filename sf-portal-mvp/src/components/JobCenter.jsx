import { useState, useEffect, useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ExternalLink,
  RotateCcw,
  Ban,
} from 'lucide-react'
import { factoryApi } from '../api/client'
import { displayJobTitle } from '../hooks/jobSelection'
import { StepCard, STAGE_LABELS } from './StepCard'
import { StepExecutionDrawer } from './StepExecutionDrawer'
import { buildStepCardView } from '../hooks/executionRecordState'
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

export function JobCenter({
  activeJob,
  steps,
  onCancel,
  onRetry,
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
}) {
  const [detail, setDetail] = useState(null)
  // Local drawer tab is owned by the drawer; JobCenter only owns whether the
  // drawer is open (driven by selectedStepId).
  const [drawerOpen, setDrawerOpen] = useState(false)

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

  const jobStatus = activeJob ? activeJob.status || 'queued' : 'queued'
  const isTerminal = ['completed', 'canceled', 'cancelled', 'failed'].includes(jobStatus)
  const canCancelHeader = activeJob && !isTerminal
  const waitingQuestions =
    detail &&
    (detail.pending_questions ||
      detail.clarify_questions ||
      detail.waiting_questions ||
      detail.questions)

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
          <h2 className="jc-prompt">{displayJobTitle(activeJob)}</h2>
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

      {/* 3x2 matrix of the six fixed stages. Replaces the old vertical list. */}
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
        artifacts={artifacts || []}
        getArtifactContent={getArtifactContent}
      />
    </section>
  )
}
