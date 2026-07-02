import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Ban,
  Clock,
  RotateCcw,
  Wrench,
  Ban as CancelIcon,
  FileText,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  ArrowLeft,
} from 'lucide-react'
import { collaborationAgentName } from '../hooks/collaborationAgentLabels'

// StepExecutionDrawer — right-side overlay drawer with three tabs.
//
// Tabs:
//   - 概览 (overview): status, latest summary, duration, attempt selector.
//     Action constraints (design §操作规则): Cancel appears ONLY for the
//     current RUNNING step (cancels the whole job); Retry appears ONLY for the
//     latest attempt of the current FAILED step. Completed/queued/historical
//     attempts are read-only.
//   - 执行记录 (records): newest 200 records, paginated older via
//     before_sequence. A scroll ref FOLLOWS new entries only while the viewport
//     is pinned to the bottom; scrolling up stops following and surfaces an
//     "N 条新记录" button + an "自动跟随" affordance to resume. Historical
//     attempts and completed steps do NOT auto-follow.
//   - 产物与审计 (artifacts): lists registered artifacts; loads a selected
//     artifact's content via getArtifactContent AFTER the user picks it.
//     Advanced-audit content is collapsed under <details>高级审计</details>.
//
// Plaintext discipline: EVERY content/artifact string renders in <pre> or text
// nodes. There is no raw-HTML injection path anywhere in this file.

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'records', label: '执行记录' },
  { id: 'artifacts', label: '产物与审计' },
]

const RECORD_KIND_LABEL = {
  system: '系统',
  activity: '活动',
  summary: '总结',
  command_stdout: '命令输出',
  command_stderr: '命令错误',
  error: '错误',
  thinking: '思考',
  file_delta: '文件生成',
  // legacy aliases (not emitted by the current backend, kept for safety)
  lifecycle: '生命周期',
  claude: 'Claude',
  command: '命令',
  stream: '流式',
  log: '日志',
}

// parseFileDelta splits a file_delta record's content into verb/path/added/
// removed. Content shape (backend): "新建 <path>  +N" or "编辑 <path>  +A -B".
// Returns null when the content does not match (so the renderer falls back to a
// plain pre). Plain-text discipline: everything is text, no HTML.
function parseFileDelta(content) {
  const m = String(content || '').match(/^(新建|编辑)\s+(\S.*?)\s\s\+(\d+)(?:\s+-(\d+))?$/)
  if (!m) return null
  return { verb: m[1], path: m[2], added: +m[3], removed: m[4] ? +m[4] : 0 }
}

// recordText extracts the displayable text of a record across the backend's
// possible field names (content / text / message), with a JSON fallback.
function recordText(r) {
  return r.content || r.text || r.message || JSON.stringify(r.payload || r.data || '', null, 2)
}

// renderRecordBody renders the BODY of one execution record, branching on kind:
//   - thinking (方案 B): a muted pre block so the model's reasoning is visible
//     but visually distinct from tool/command output.
//   - file_delta: a compact "新建/编辑 <path> +N -M" chip with green +/red −, so
//     code generation reads like an agent IDE's file progress.
//   - everything else: the standard pre block.
// Plain-text discipline: all branches render text nodes / pre only.
function renderRecordBody(r) {
  if (r.kind === 'thinking') {
    return <pre className="sed-record-text sed-thinking-text">{recordText(r)}</pre>
  }
  if (r.kind === 'file_delta') {
    const d = parseFileDelta(r.content)
    if (d) {
      return (
        <div className="sed-filedelta">
          <span className={`sed-filedelta-verb sed-filedelta-${d.verb}`}>{d.verb}</span>
          <span className="sed-filedelta-path">{d.path}</span>
          <span className="sed-filedelta-added">+{d.added}</span>
          {d.removed > 0 ? <span className="sed-filedelta-removed">-{d.removed}</span> : null}
        </div>
      )
    }
  }
  return <pre className="sed-record-text">{recordText(r)}</pre>
}

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

const STATUS_TEXT = {
  pending: '等待中',
  running: '进行中',
  waiting_user: '等待用户',
  succeeded: '已完成',
  failed: '已失败',
  skipped: '已跳过',
  canceled: '已取消',
  cancelled: '已取消',
}

// ClarificationBlock renders the clarifying questions a step raised when it
// paused for user input (waiting_user). The questions are persisted on the step
// as `pending_questions` (a JSON string the backend writes via
// MarkStepWaitingUser). This is a READ-ONLY view inside the drawer — the user
// answers in the conversation area; the drawer just shows WHAT to answer.
// Tolerates the agent's alternate field names (question/text, value/id).
function ClarificationBlock({ step }) {
  const raw = step && step.pending_questions
  if (!raw) {
    return (
      <section className="sed-clarification-block">
        <h4>等待用户澄清</h4>
        <p className="sed-readonly-hint">请在底部对话区回复以继续。</p>
      </section>
    )
  }
  let questions = []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    questions = Array.isArray(parsed) ? parsed : []
  } catch {
    questions = []
  }
  if (questions.length === 0) {
    return (
      <section className="sed-clarification-block">
        <h4>等待用户澄清</h4>
        <p className="sed-readonly-hint">请在底部对话区回复以继续。</p>
      </section>
    )
  }
  return (
    <section className="sed-clarification-block">
      <h4>等待用户澄清</h4>
      <p className="sed-clarification-hint">请在底部对话区回复，回答后任务会继续。</p>
      {questions.map((q, i) => {
        const text = q.question || q.text || ''
        const options = Array.isArray(q.options) ? q.options : []
        return (
          <div key={q.id || i} className="sed-clarification-q">
            {text ? <p className="sed-clarification-text">{text}</p> : null}
            {options.length > 0 ? (
              <ul className="sed-clarification-options">
                {options.map((opt, j) => (
                  <li key={opt.value || opt.id || j}>
                    {opt.label || opt.value || opt.id}
                    {opt.recommended ? <em className="sed-clarification-rec">推荐</em> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {q.defaultAnswer ? (
              <small className="sed-clarification-default">参考建议：{q.defaultAnswer}</small>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}

function isPinnedToBottom(el, slack = 24) {
  if (!el) return false
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

export function StepExecutionDrawer({
  open,
  onClose,
  // Step identity + snapshot
  step,
  summary,
  stageLabel,
  // Attempts for this step (for the selector). Derived by the parent from
  // summary/records so historical attempts are switchable but read-only.
  attempts,
  selectedAttempt,
  onSelectAttempt,
  // Records surface from useJobs
  records,
  onLoadOlder,
  hasOlder,
  loadingOlder,
  // Action handlers (gated by status — see canCancel / canRetry below)
  onCancel,
  onRetry,
  onRepairFromFailure,
  // Per-task snapshot editor (Task 5): saves an edited snapshot to
  // job_steps.snapshot_json — the editable copy that affects ONLY this
  // generation task. Bound by JobCenter as
  // (stepId, snapshotObj) => factoryApi.patchJobStepSnapshot(activeJob.id, ...).
  onSaveSnapshot,
  // Artifacts
  artifacts,
  getArtifactContent,
  // Phase 2 embedded mode: when true the drawer renders its panel body INLINE
  // (no createPortal, no position:fixed overlay, no backdrop) so it fills the
  // 任务执行 drawer. The header shows a back affordance (onBack) instead of a
  // standalone X close. Reuses ALL existing detail logic (tabs, attempt
  // selector, records, artifacts, snapshot editor, cancel/retry/repair).
  embedded = true,
  onBack,
}) {
  const [tab, setTab] = useState('overview')
  const [artifactId, setArtifactId] = useState(null)
  const [artifactContent, setArtifactContent] = useState(null)
  const [artifactLoading, setArtifactLoading] = useState(false)
  const [artifactError, setArtifactError] = useState(null)

  // --- Follow-on-scroll state --------------------------------------------
  // `following` is true while we should auto-scroll to the bottom on new
  // records. It becomes false the moment the user scrolls up. Resumed via the
  // 自动跟随 button (which also clears the unread-since-unfollow counter).
  const [following, setFollowing] = useState(true)
  const [missedCount, setMissedCount] = useState(0)
  const scrollRef = useRef(null)
  const lastSeqRef = useRef(0)
  const recordCountRef = useRef(0)

  // --- Per-task snapshot editor (Task 5) ---------------------------------
  // snapshotDraft holds the editable text for the step's per-task snapshot
  // (job_steps.snapshot_json). It is seeded from the existing snapshot (pretty-
  // printed) whenever the step changes, so the user edits a readable copy.
  // snapshotError surfaces a JSON parse failure without crashing the drawer.
  const [snapshotDraft, setSnapshotDraft] = useState('')
  const [snapshotError, setSnapshotError] = useState(null)
  const [snapshotSaving, setSnapshotSaving] = useState(false)

  const status = (step && (step.status || step.state)) || 'pending'
  const snapshotPreview = useMemo(() => {
    if (!snapshotDraft.trim()) return null
    try {
      const parsed = JSON.parse(snapshotDraft)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }, [snapshotDraft])
  const snapshotSkillFiles = snapshotPreview && Array.isArray(snapshotPreview.skillOverrides)
    ? snapshotPreview.skillOverrides.filter(item => item && (item.path || item.content))
    : []
  const snapshotName = snapshotPreview ? collaborationAgentName(snapshotPreview) : ''

  // Reset follow state when switching step or attempt (new view = fresh tail).
  useEffect(() => {
    setFollowing(true)
    setMissedCount(0)
    lastSeqRef.current = 0
    recordCountRef.current = 0
    setArtifactId(null)
    setArtifactContent(null)
    setArtifactError(null)
  }, [step && step.id, selectedAttempt])

  // Seed the snapshot editor from the step's existing per-task snapshot
  // (pretty-printed so the user edits readable JSON). Re-seeds whenever the
  // step or its snapshot changes (e.g. after a save + refresh). Clears the
  // draft when there is no snapshot so the editor section stays hidden.
  useEffect(() => {
    setSnapshotError(null)
    const raw = step && step.snapshot_json
    if (!raw) {
      setSnapshotDraft('')
      return
    }
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      setSnapshotDraft(JSON.stringify(parsed, null, 2))
    } catch {
      // Store-backed snapshot is malformed; let the user edit the raw text.
      setSnapshotDraft(typeof raw === 'string' ? raw : JSON.stringify(raw))
    }
  }, [step && step.id, step && step.snapshot_json])

  // Follow logic: when records grow AND we are following, pin to bottom. When
  // records grow but we are NOT following, bump the missed-count badge.
  useEffect(() => {
    if (!scrollRef.current || tab !== 'records') return
    const count = Array.isArray(records) ? records.length : 0
    const grew = count > recordCountRef.current
    recordCountRef.current = count

    // Track the highest sequence we've shown so missed-count is accurate for
    // the live SSE tail (older pages prepended do not count as "missed").
    const maxSeq = (records || []).reduce((m, r) => Math.max(m, r.sequence || 0), 0)
    const newTailSeq = maxSeq > lastSeqRef.current
    lastSeqRef.current = Math.max(lastSeqRef.current, maxSeq)

    if (!grew) return

    // Historical attempts and completed steps do NOT auto-follow: the tail is
    // frozen, so pinning would just snap the user away from where they scroll.
    const attemptIsHistorical =
      attempts && attempts.length > 1 && selectedAttempt != null &&
      selectedAttempt !== Math.max(...attempts)
    const stepFrozen = ['succeeded', 'failed', 'skipped', 'canceled', 'cancelled'].includes(status)

    if (following && !attemptIsHistorical && !stepFrozen) {
      const el = scrollRef.current
      el.scrollTop = el.scrollHeight
    } else if (newTailSeq && !following) {
      setMissedCount(c => c + 1)
    }
  }, [records, tab, following, selectedAttempt, attempts, status])

  // When entering the records tab, jump to bottom once if following.
  useEffect(() => {
    if (tab !== 'records' || !following) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tab, following])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (isPinnedToBottom(el)) {
      if (!following) {
        setFollowing(true)
        setMissedCount(0)
      }
    } else if (following) {
      setFollowing(false)
    }
  }

  const resumeFollow = () => {
    setFollowing(true)
    setMissedCount(0)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // --- Action constraints (design §操作规则) -----------------------------
  // Cancel: ONLY the current RUNNING step (cancels the whole job).
  // Retry:  ONLY the latest attempt of the current FAILED step.
  // Everything else (completed, queued, historical attempts) is read-only.
  const canCancel = status === 'running'
  const isLatestAttempt =
    attempts && attempts.length > 0
      ? selectedAttempt === Math.max(...attempts)
      : true
  const canRetry = status === 'failed' && isLatestAttempt
  // deployment is included so a health_check_failed deploy can be repaired
  // (regenerated with the failure context). The backend enforces that ONLY
  // health_check_failed deploy failures are actually repairable; other deploy
  // failures (port/run infra errors) are rejected server-side with a message.
  const canRepairFromFailure =
    canRetry &&
    ['test_verification', 'image_build', 'deployment'].includes(step?.kind)

  // Artifact content load: only AFTER the user selects one (never eagerly).
  const selectArtifact = async id => {
    setArtifactId(id)
    setArtifactContent(null)
    setArtifactError(null)
    if (!id) return
    setArtifactLoading(true)
    try {
      const text = await getArtifactContent(id)
      setArtifactContent(text)
    } catch (err) {
      setArtifactError(err && (err.message || String(err)))
    } finally {
      setArtifactLoading(false)
    }
  }

  // saveSnapshot parses the draft as JSON, then persists it to the step's
  // per-task snapshot via the onSaveSnapshot closure (which carries the job
  // id). A malformed draft surfaces an inline error instead of crashing.
  const saveSnapshot = async () => {
    setSnapshotError(null)
    let parsed
    try {
      parsed = JSON.parse(snapshotDraft)
    } catch (err) {
      setSnapshotError('JSON 格式无效：' + (err && err.message ? err.message : String(err)))
      return
    }
    if (!step || !onSaveSnapshot) return
    setSnapshotSaving(true)
    try {
      await onSaveSnapshot(step.id, parsed)
    } catch (err) {
      setSnapshotError(err && (err.message || String(err)))
    } finally {
      setSnapshotSaving(false)
    }
  }

  if (!open) return null

  // The panel body is shared by BOTH modes (portal overlay + embedded inline).
  // Extracting it keeps ALL detail logic (tabs, attempt selector, records,
  // artifacts, snapshot editor, cancel/retry/repair) in one place so the
  // embedded drawer renders an identical detail surface — only the wrapper +
  // header affordance differ.
  const panelBody = (
    <>
      <header className="sed-header">
        <div className="sed-title-block">
          {embedded ? (
            <button
              type="button"
              className="sed-back"
              aria-label="返回任务执行列表"
              onClick={() => onBack && onBack()}
            >
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <span className="sed-stage">{stageLabel || (step && (step.label || step.kind)) || '步骤'}</span>
          <span className={`sed-status sed-status-${status}`}>
            <StatusIcon status={status} />
            <span>{STATUS_TEXT[status] || status}</span>
          </span>
        </div>
        {!embedded ? (
          <button
            type="button"
            className="sed-close"
            aria-label="关闭步骤详情"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        ) : null}
      </header>

      {Array.isArray(attempts) && attempts.length > 1 ? (
        <div className="sed-attempt-row">
          <span className="sed-attempt-label">尝试次数</span>
          <div className="sed-attempt-chips" role="tablist" aria-label="选择尝试次数">
            {attempts.map(a => (
              <button
                key={a}
                type="button"
                role="tab"
                aria-selected={a === selectedAttempt}
                className={`sed-attempt-chip${a === selectedAttempt ? ' sed-attempt-chip-active' : ''}`}
                onClick={() => onSelectAttempt && onSelectAttempt(a)}
              >
                第 {a} 次
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <nav className="sed-tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`sed-tab${tab === t.id ? ' sed-tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="sed-body">
        {tab === 'overview' && (
          <div className="sed-overview">
            <dl className="sed-facts">
              <div className="sed-fact">
                <dt>状态</dt>
                <dd>
                  <span className={`sed-status sed-status-${status}`}>
                    <StatusIcon status={status} />
                    <span>{STATUS_TEXT[status] || status}</span>
                  </span>
                </dd>
              </div>
              {selectedAttempt != null ? (
                <div className="sed-fact">
                  <dt>尝试</dt>
                  <dd>第 {selectedAttempt} 次</dd>
                </div>
              ) : null}
              {summary && (summary.duration_ms || summary.durationMs) ? (
                <div className="sed-fact">
                  <dt>耗时</dt>
                  <dd>{Math.round((summary.duration_ms || summary.durationMs) / 1000)}s</dd>
                </div>
              ) : null}
              {step && (step.agent_key || step.agent) ? (
                <div className="sed-fact">
                  <dt>代理</dt>
                  <dd>{step.agent_key || step.agent}</dd>
                </div>
              ) : null}
            </dl>

            {summary && summary.latest_record &&
            (summary.latest_record.content ||
              summary.latest_record.text ||
              summary.latest_record.message) ? (
              <section className="sed-summary-block">
                <h4>最新摘要</h4>
                <pre className="sed-summary-text">
                  {summary.latest_record.content ||
                    summary.latest_record.text ||
                    summary.latest_record.message}
                </pre>
              </section>
            ) : null}

            {step && step.error_message ? (
              <section className="sed-error-block">
                <h4>错误信息</h4>
                <pre className="sed-error-text">{step.error_message}</pre>
              </section>
            ) : null}

            {step && step.snapshot_json ? (
              <section className="sed-snapshot">
                <h4>本次配置快照</h4>
                <p className="sed-snapshot-hint">
                  编辑仅影响本次生成任务，不会改动全局代理/技能配置。
                </p>
                {snapshotPreview ? (
                  <div className="sed-snapshot-meta">
                    {snapshotName ? <strong>{snapshotName}</strong> : null}
                    {snapshotPreview.description ? <p>{snapshotPreview.description}</p> : null}
                    {Array.isArray(snapshotPreview.selectedSkills) && snapshotPreview.selectedSkills.length > 0 ? (
                      <div className="sed-snapshot-skills">
                        {snapshotPreview.selectedSkills.map(skill => (
                          <span key={skill}>{skill}</span>
                        ))}
                      </div>
                    ) : null}
                    {snapshotSkillFiles.length > 0 ? (
                      <ul className="sed-snapshot-skill-files">
                        {snapshotSkillFiles.map((file, index) => (
                          <li key={`${file.path || 'inline'}-${index}`}>
                            <FileText size={12} />
                            <span>{file.path || `inline-${index + 1}`}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {step.status === 'pending' ? (
                  <>
                    <textarea
                      className="sed-snapshot-editor"
                      value={snapshotDraft}
                      onChange={event => setSnapshotDraft(event.target.value)}
                      spellCheck={false}
                      rows={12}
                    />
                    {snapshotError ? (
                      <p className="sed-snapshot-error">{snapshotError}</p>
                    ) : null}
                    <button
                      type="button"
                      className="sed-action sed-snapshot-save"
                      onClick={saveSnapshot}
                      disabled={snapshotSaving}
                    >
                      {snapshotSaving ? <Loader2 size={14} className="spin" /> : null}
                      保存到本次任务
                    </button>
                  </>
                ) : (
                  <p className="sed-readonly-hint">快照在步骤开始后只读（仅可查看名称/描述/技能，不可编辑）。</p>
                )}
              </section>
            ) : null}

            {status === 'waiting_user' && step && step.kind !== 'design_contract' ? (
              <ClarificationBlock step={step} />
            ) : null}

            <div className="sed-actions">
              {canCancel ? (
                <button
                  type="button"
                  className="sed-action sed-cancel"
                  onClick={() => onCancel && onCancel()}
                >
                  <CancelIcon size={14} /> 取消任务
                </button>
              ) : null}
              {canRetry ? (
                <button
                  type="button"
                  className="sed-action sed-retry"
                  onClick={() => onRetry && onRetry()}
                >
                  <RotateCcw size={14} /> 重试当前阶段
                </button>
              ) : null}
              {canRepairFromFailure ? (
                <button
                  type="button"
                  className="sed-action sed-retry"
                  onClick={() => onRepairFromFailure && onRepairFromFailure()}
                >
                  <Wrench size={14} /> 发送错误给代码修复
                </button>
              ) : null}
              {!canCancel && !canRetry && !canRepairFromFailure ? (
                <p className="sed-readonly-hint">当前阶段为只读（已完成或非最新尝试）。</p>
              ) : null}
            </div>
          </div>
        )}

        {tab === 'records' && (
          <div className="sed-records">
            <div className="sed-records-toolbar">
              {hasOlder ? (
                <button
                  type="button"
                  className="sed-load-older"
                  onClick={() => onLoadOlder && onLoadOlder()}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? <Loader2 size={12} className="spin" /> : <ChevronUp size={12} />}
                  加载更早记录
                </button>
              ) : (
                <span className="sed-no-older">已是最早</span>
              )}
              <button
                type="button"
                className={`sed-follow-toggle${following ? ' sed-follow-on' : ''}`}
                aria-pressed={following ? 'true' : 'false'}
                onClick={resumeFollow}
                disabled={following}
              >
                <CornerDownRight size={12} /> 自动跟随
              </button>
            </div>

            {!following && missedCount > 0 ? (
              <button type="button" className="sed-missed" onClick={resumeFollow}>
                {missedCount} 条新记录
              </button>
            ) : null}

            <div
              className="sed-record-list"
              ref={scrollRef}
              onScroll={handleScroll}
            >
              {(!records || records.length === 0) ? (
                <p className="sed-empty">暂无执行记录</p>
              ) : (
                records.map(r => {
                  const body = renderRecordBody(r)
                  return (
                    <div key={r.id} className={`sed-record sed-record-${r.kind || 'log'}`}>
                      <div className="sed-record-head">
                        <span className="sed-record-kind">
                          {RECORD_KIND_LABEL[r.kind] || r.kind || '记录'}
                        </span>
                        {r.sequence != null ? (
                          <span className="sed-record-seq">#{r.sequence}</span>
                        ) : null}
                        {r.created_at != null || r.at != null ? (
                          <span className="sed-record-at">
                            {String(r.created_at || r.at).slice(11, 19)}
                          </span>
                        ) : null}
                      </div>
                      {body}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {tab === 'artifacts' && (
          <div className="sed-artifacts">
            {(!artifacts || artifacts.length === 0) ? (
              <p className="sed-empty">暂无产物</p>
            ) : (
              <ul className="sed-artifact-list">
                {artifacts.map(a => {
                  const isAdvanced =
                    a.kind === 'audit' || a.advanced || (a.name || '').includes('审计')
                  return (
                    <li
                      key={a.id}
                      className={`sed-artifact${a.id === artifactId ? ' sed-artifact-active' : ''}`}
                    >
                      <button
                        type="button"
                        className="sed-artifact-pick"
                        onClick={() => selectArtifact(a.id)}
                        aria-pressed={a.id === artifactId}
                      >
                        <FileText size={14} />
                        <span>{a.name || a.path || a.id}</span>
                      </button>
                      {isAdvanced ? <span className="sed-artifact-tag">审计</span> : null}
                    </li>
                  )
                })}
              </ul>
            )}

            {artifactId ? (
              <section className="sed-artifact-content">
                <h4 className="sed-artifact-title">
                  {artifacts.find(a => a.id === artifactId)?.name || artifactId}
                </h4>
                {artifactLoading ? (
                  <p className="sed-empty">加载中...</p>
                ) : artifactError ? (
                  <pre className="sed-error-text">{artifactError}</pre>
                ) : (() => {
                    const current = artifacts.find(a => a.id === artifactId)
                    const isAdvanced =
                      current &&
                      (current.kind === 'audit' || current.advanced || (current.name || '').includes('审计'))
                    if (isAdvanced) {
                      return (
                        <details className="sed-advanced">
                          <summary>高级审计</summary>
                          <pre className="sed-artifact-text">{artifactContent}</pre>
                        </details>
                      )
                    }
                    return <pre className="sed-artifact-text">{artifactContent}</pre>
                  })()}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </>
  )

  // Embedded mode (Phase 2): render the panel INLINE inside the 任务执行 drawer.
  // No createPortal, no position:fixed overlay, no backdrop — the panel fills
  // the drawer body directly. This collapses the old two-level portal-overlay
  // stack (JobCenter inline + a createPortal drawer on top) into a single
  // list↔detail view inside one drawer.
  if (embedded) {
    return (
      <section className="sed-panel sed-panel-embedded" role="region" aria-label="步骤执行详情">
        {panelBody}
      </section>
    )
  }

}
