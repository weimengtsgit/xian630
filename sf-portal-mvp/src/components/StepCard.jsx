import { useEffect, useState } from 'react'
import {
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Ban,
  ChevronRight,
} from 'lucide-react'

// Fixed step stage display names (design §4). Kept here so the harness can
// assert the six labels exist in the StepCard source.
export const STAGE_LABELS = {
  requirement_analysis: '需求分析',
  solution_design: '方案设计',
  code_generation: '代码生成',
  test_verification: '测试验证',
  image_build: '镜像构建',
  deployment: '部署',
}

// Friendly agent role per stage (informational only; falls back to kind).
export const STAGE_AGENT_ROLE = {
  requirement_analysis: '需求分析师',
  solution_design: '方案架构师',
  code_generation: '代码工程师',
  test_verification: '测试工程师',
  image_build: '构建工程师',
  deployment: '部署工程师',
}

export const STEP_STATUS_LABEL = {
  pending: '等待中',
  running: '进行中',
  waiting_user: '等待用户',
  succeeded: '已完成',
  failed: '已失败',
  skipped: '已跳过',
  canceled: '已取消',
  cancelled: '已取消',
}

// Color is NOT the only signal: every status carries a text label via
// STEP_STATUS_LABEL, and the icon + label always render together.
function StatusIcon({ status }) {
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

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s > 0 ? `${m}m${s}s` : `${m}m`
}

// stepDurationMs returns the elapsed run time (ms) for a step, derived from its
// own started_at / ended_at timestamps (the backend StepExecutionSummary carries
// no duration field). Ended steps return their fixed duration; a RUNNING step
// returns the live elapsed time against `now` (StepCard re-renders each second
// so it counts up). null when the step has not started.
function stepDurationMs(step, status, now) {
  if (!step) return null
  const startedRaw = step.started_at || step.startedAt
  if (!startedRaw) return null
  const start = Date.parse(startedRaw)
  if (!Number.isFinite(start)) return null
  const endedRaw = step.ended_at || step.endedAt
  if (endedRaw) {
    const end = Date.parse(endedRaw)
    if (Number.isFinite(end)) return Math.max(0, end - start)
  }
  if (status === 'running') return Math.max(0, now - start)
  return null
}

/**
 * One card in the 3x2 step matrix. Renders a single fixed stage with:
 *   - Lucide status icon + status text label (color is never the sole signal)
 *   - stage name (e.g. 需求分析) with the attempt index inline (第 N 次)
 *   - duration (when present)
 *   - unread badge (counts ONLY the live SSE tail — see useJobs.getUnreadCount)
 *
 * The card is a <button> with aria-pressed (selected) + aria-label so keyboard
 * and screen-reader users can open the drawer.
 */
export function StepCard({
  kind,
  label,
  step,
  summary,
  selected,
  unreadCount,
  onSelect,
  agent,
}) {
  const status = (step && (step.status || step.state)) || 'pending'
  const displayName = label || STAGE_LABELS[kind] || kind
  const attempt =
    (summary && (summary.attempt ?? summary.latest_attempt)) ??
    (step && (step.attempt ?? step.latest_attempt)) ??
    null
  // Elapsed run time for this step. Ended steps show their fixed duration
  // (ended_at − started_at); a RUNNING step shows the live elapsed time, which
  // the tick below re-renders every second so the value counts up in real time.
  // The backend StepExecutionSummary has no duration field, so we derive it from
  // the step's own started_at / ended_at timestamps.
  const startedAt = step && (step.started_at || step.startedAt)
  const [, setDurationTick] = useState(0)
  useEffect(() => {
    if (status !== 'running' || !startedAt) return undefined
    const id = setInterval(() => setDurationTick(v => v + 1), 1000)
    return () => clearInterval(id)
  }, [status, startedAt])
  const durationMs = stepDurationMs(step, status, Date.now())

  const unread = Number.isFinite(unreadCount) ? unreadCount : 0

  return (
    <button
      type="button"
      className={`sc-card sc-status-${status}${selected ? ' sc-card-selected' : ''}`}
      aria-pressed={selected ? 'true' : 'false'}
      aria-label={`查看${displayName}执行详情`}
      onClick={() => onSelect && onSelect(kind)}
    >
      <div className="sc-card-head">
        <span className={`sc-status sc-status-${status}`}>
          <StatusIcon status={status} />
          <span className="sc-status-text">{STEP_STATUS_LABEL[status] || status}</span>
        </span>
        {unread > 0 ? (
          <span className="sc-unread" aria-label={`${unread} 条未读记录`}>
            {unread}
          </span>
        ) : null}
      </div>

      <div className="sc-card-title">
        <span className="sc-stage-name">{displayName}</span>
        {agent && agent.name ? <span className="sc-agent-name">{agent.name}</span> : null}
        {attempt != null ? <span className="sc-attempt">第 {attempt} 次</span> : null}
        <ChevronRight size={14} className="sc-chevron" />
      </div>

      {formatDuration(durationMs) ? (
        <div className="sc-card-meta">
          <span className="sc-duration">{formatDuration(durationMs)}</span>
        </div>
      ) : null}
    </button>
  )
}
