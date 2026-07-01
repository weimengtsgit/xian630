import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  ChevronDown,
  ChevronRight,
  Edit3,
  ExternalLink,
  FileCode,
  FileText,
  GitCommit,
  HelpCircle,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Send,
  X,
  XCircle,
} from 'lucide-react'
import { AggregateOrchestrationGraph } from './AggregateOrchestrationGraph'
import { WorkbenchAgentBlock } from './WorkbenchAgentBlock'
import { AttachmentComposer } from './AttachmentComposer'
import { AttachmentPreviewModal } from './AttachmentPreviewModal'
import { ProjectDocumentPreviewModal } from './ProjectDocumentPreviewModal'
import { InterfacePreviewModal } from './InterfacePreviewModal'
import { useSessionAttachments } from '../hooks/useSessionAttachments'
import { buildWorkbenchOrchestrationView } from '../hooks/workbenchOrchestrationState'
import { normalizePrototypeSummary } from '../hooks/prototypeState'
import { resolveWorkbenchTitle, statusText, describeSessionError } from '../hooks/dialogueTimeline'
import { STAGE_LABELS } from './StepCard'
import { formatDataPolicy, formatAppType, translateAnalysisText } from '../utils/formatLabels'
import { factoryApi } from '../api/client'
import './ConversationWorkbench.css'

// Temporary switch: the dialogue work-trace surface (执行轨迹) is hidden while
// its business-facing content is being reworked. Flip to true to bring it back.
const SHOW_WORK_TRACE = false
const WORKBENCH_BODY_FOLLOW_BOTTOM_THRESHOLD = 24
const LIVE_THINKING_FOLLOW_BOTTOM_THRESHOLD = 24
const TASK_THINKING_FOLLOW_BOTTOM_THRESHOLD = 24

export function ConversationWorkbench({
  session,
  view,
  timeline,
  questions,
  locked,
  error,
  submitting,
  onSend,
  onSelectRoute,
  onOpenApp,
  onAnswerBatch,
  onAcceptConsolidation,
  onConfirm,
  onConfirmCard,
  onRetry,
  onAbandon,
  workTrace,
  pendingTurn,
  focusTask,
  clarificationScope,
  onSelectClarificationScope,
  traceSteps,
  drawerEntry,
  onToggleDrawerEntry,
  onOpenTaskStep,
  onConfirmTaskStep,
  onConfirmDataAccess,
  hasBoundApplication,
  onCancelTurn,
  onConfirmChange,
  onRollback,
  onArchive,
  onOpenApplicationStore,
}) {
  const [input, setInput] = useState('')
  const [draftAnswers, setDraftAnswers] = useState({})
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false)
  const [manualStepConfirmation, setManualStepConfirmation] = useState(false)
  const [aggregateGraphCompactOverride, setAggregateGraphCompactOverride] = useState(null)
  const textareaRef = useRef(null)
  const cwBodyScrollRef = useRef(null)
  const cwBodyShouldFollowRef = useRef(true)
  const previousHasSubmittedRequirementRef = useRef(false)
  const requestAbandonRequirement = () => {
    if (!onAbandon || submitting) return
    setMoreMenuOpen(false)
    setAbandonConfirmOpen(true)
  }
  const confirmAbandonRequirement = () => {
    if (!onAbandon || submitting) return
    setAbandonConfirmOpen(false)
    onAbandon()
  }
  // Auto-grow the composer textarea with its content (capped by the CSS
  // max-height). Keeps multi-line input visible instead of stuck at ~2 rows.
  const resizeTextarea = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useEffect(resizeTextarea, [input])
  useEffect(() => {
    if (!moreMenuOpen && !abandonConfirmOpen) return undefined
    const onKeyDown = event => {
      if (event.key !== 'Escape') return
      setMoreMenuOpen(false)
      setAbandonConfirmOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [moreMenuOpen, abandonConfirmOpen])
  useEffect(() => {
    setManualStepConfirmation(false)
    setAggregateGraphCompactOverride(null)
    cwBodyShouldFollowRef.current = true
    previousHasSubmittedRequirementRef.current = false
  }, [session && session.id])
  const status = session && session.status
  const activeQuestions = Array.isArray(questions) ? questions : []
  const completedAnswers = activeQuestions.filter(q => hasAnswer(draftAnswers[q.id])).length
  const canSubmitAnswers = activeQuestions.length > 0 && completedAnswers === activeQuestions.length && !submitting
  const intent = session && session.intent
  const isBusiness = intent === 'business_processing_agent'
  const isClarification = intent === 'application_generation' && view && view.child
  const childStatus = isClarification ? view.child.status : null
  const canConfirmClarification = childStatus === 'ready_to_confirm'
  const canConfirmBusiness = isBusiness &&
    view &&
    view.agentDraftStatus === 'ready_to_confirm' &&
    view.agentDraft &&
    view.agentDraft.name &&
    view.agentDraft.description &&
    view.agentDraft.prompt
  const canConfirm = (canConfirmClarification || canConfirmBusiness) && !submitting
  const canRetry = status === 'failed'
  const canAbandon = status && status !== 'resolved' && status !== 'abandoned'
  // Surface WHY a session failed (e.g. 模型服务余额不足), not just "已失败". The
  // raw error_message is operator-grade; describeSessionError maps it to a
  // plain-Chinese {title, detail, hint} and never leaks the raw blob.
  const sessionError = status === 'failed' ? describeSessionError(session && session.error_code, session && session.error_message) : null

  // ---- continuous-workbench derived state (Task 7) ------------------------
  const traceItems = Array.isArray(workTrace) ? workTrace : []
  const hasPendingTurn = !!(pendingTurn && pendingTurn.turnId)
  const workbenchTitle = resolveWorkbenchTitle(view, session)
  // A version has deployed when the view carries a resolved application with a
  // runtime url, OR the trace shows a deployment/version event. We render the
  // "vN 已生效，可继续描述修改需求" hint then, and keep the composer active.
  const deployedApp = view && view.resolvedApplication
  const versionLabel = deployedApp && (deployedApp.version || deployedApp.version_label || (deployedApp.status === 'running' ? 'v1' : ''))
  const versionDeployed = !!(deployedApp && (deployedApp.runtimeUrl || deployedApp.runtime_url || deployedApp.status === 'running'))
  // Continuous loop (doc Step 4 "make the workbench continuous"): once a job is
  // seeded for this dialogue the route is "in generation" — queued, running, or
  // completed — and the composer must stay active so the user can describe
  // further modifications. The backend accepts these as follow-up turns while
  // the dialogue status is continuing (IsContinuingDialogueStatus includes
  // active/task_running/change_confirmation). versionDeployed alone is too
  // strict: it requires a RUNNING app with a runtimeUrl, which a freshly
  // generated (or stopped, or not-yet-surfaced) app lacks — so without this the
  // composer locked even though generation finished and the user could iterate.
  const seededJob = view && view.seededJob
  const continuousLoop = !!(seededJob && ['queued', 'running', 'waiting_user', 'completed'].includes(seededJob.status))
  const composerActive = versionDeployed || continuousLoop
  // Change-summary confirmation: a trace event of type change_confirmation or
  // dialogue.change.proposed surfaces a confirm panel (the continuous loop).
  const changeProposal = versionDeployed
    ? traceItems.find(
      it => it.type === 'change_confirmation' || it.type === 'dialogue.change.proposed' || it.type === 'change.proposed',
    )
    : null
  const currentDeployment = deploymentStatusInfo({ view, focusTask, steps: traceSteps, traceItems })
  const focusRequirement = requirementFromJob(focusTask)
  const clarificationScopeLabel = clarificationScope
    ? [clarificationScope.stepName || clarificationScope.stepId, clarificationScope.agentKey]
      .filter(Boolean)
      .join(' / ')
    : ''
  const taskBadge = taskDrawerBadgeInfo(focusTask)
  const timelineFollowSignature = useMemo(() => {
    const items = Array.isArray(timeline) ? timeline : []
    return items.map(item => [
      item.id,
      item.type,
      item.content || '',
      item.summary || '',
      item.taskThinking || '',
      item.safeExecution || '',
      item.error || '',
      item.rawThinking || '',
      item.pending ? 'pending' : '',
      item.expanded ? 'expanded' : '',
    ].join(':')).join('|')
  }, [timeline])
  const updateWorkbenchBodyFollowState = event => {
    const el = event.currentTarget
    const { scrollHeight, scrollTop, clientHeight } = el
    const distanceToBottom = scrollHeight - scrollTop - clientHeight
    cwBodyShouldFollowRef.current = distanceToBottom <= WORKBENCH_BODY_FOLLOW_BOTTOM_THRESHOLD
  }
  useEffect(() => {
    const el = cwBodyScrollRef.current
    if (!el || !cwBodyShouldFollowRef.current) return
    // 只有用户停在底部时才跟随新增思考内容；上滑查看历史时不打断。
    const { scrollHeight } = el
    el.scrollTop = scrollHeight
  }, [timelineFollowSignature])

  // Aggregate orchestration graph (Task 2): a fixed five-card overview of the
  // whole pipeline (用户输入/业务逻辑/界面解析/数据抓取/生产交付) that stays pinned
  // above the conversation body and reflects the latest view + trace state.
  const aggregateGraph = useMemo(() => buildWorkbenchOrchestrationView({
    view,
    workTraceItems: traceItems,
    jobStepBlocks: traceSteps,
  }), [view, traceItems, traceSteps])
  const hasSubmittedRequirement = aggregateGraph.cardsByKey &&
    aggregateGraph.cardsByKey.user_input &&
    aggregateGraph.cardsByKey.user_input.state === 'confirmed'
  useEffect(() => {
    if (hasSubmittedRequirement && !previousHasSubmittedRequirementRef.current) {
      setAggregateGraphCompactOverride(false)
    }
    previousHasSubmittedRequirementRef.current = hasSubmittedRequirement
  }, [hasSubmittedRequirement])
  const aggregateGraphCompact = aggregateGraphCompactOverride == null ? !hasSubmittedRequirement : aggregateGraphCompactOverride
  const toggleAggregateGraphCompact = () => {
    setAggregateGraphCompactOverride(current => {
      const compactNow = current == null ? !hasSubmittedRequirement : current
      return !compactNow
    })
  }

  // Session attachments (Task 4): pending composer attachments for the current
  // message. focusKey mirrors the aggregate graph's active card so uploaded
  // files are tagged with the workbench region the user is working in.
  const attachmentState = useSessionAttachments({
    dialogueId: session && session.id,
    focusKey: aggregateGraph.activeCardKey || 'business_logic',
  })
  const [previewAttachment, setPreviewAttachment] = useState(null)
  const [previewDocument, setPreviewDocument] = useState(null)
  const [previewInterface, setPreviewInterface] = useState(null)
  // openProjectDocument fetches a task-owned docs/*.md file for read-only rich
  // preview. Early in the pipeline (before code generation registers an
  // application) the job already carries an AppSlug, so the backend can resolve
  // the project root and serve the projected document.
  const openProjectDocument = async artifact => {
    if (!artifact || !artifact.path) return
    const jobId = artifact.jobId || (focusTask && focusTask.id)
    if (!jobId) return
    try {
      const doc = await factoryApi.getJobProjectDocument(jobId, artifact.path)
      setPreviewDocument(doc)
    } catch {
      setPreviewDocument(null)
    }
  }

  // openArtifact routes an artifact-open click by kind: project_document loads
  // the markdown preview via openProjectDocument; interface_preview (Task 8)
  // opens the InterfacePreviewModal. The interface-preview snapshot is retained
  // server-side as a manifest with no serving endpoint yet, so the modal
  // degrades gracefully (label + retention note) until one is wired.
  const openArtifact = artifact => {
    if (!artifact) return
    if (artifact.kind === 'interface_preview') {
      setPreviewInterface(artifact)
      return
    }
    openProjectDocument(artifact)
  }

  // submitCredential is the controlled credential input boundary (Task 12). The
  // plaintext value the user typed is sent ONLY via factoryApi.submitDialogueCredential,
  // which swaps it for an opaque handle server-side and responds with metadata
  // + redacted:true (never the value). The value is never rendered, logged, or
  // persisted client-side beyond the transient password input draft. The
  // question carries focusKey/label/scope metadata describing WHICH credential
  // the handle refers to; we forward them so the data_integration step's
  // input.json controlledCredentialRefs can label the handle without the value.
  const submitCredential = async (question, value) => {
    const dialogueId = session && session.id
    if (!dialogueId || !value || submitting) return
    try {
      await factoryApi.submitDialogueCredential(dialogueId, {
        focusKey: question.focusKey || aggregateGraph.activeCardKey || 'data_capture',
        label: question.label || question.question || '凭证',
        scope: question.scope || 'data_capture',
        value,
      })
      // Credential handle persisted server-side (durable). The data_integration
      // step reads controlledCredentialRefs from the store on its next run;
      // resuming the waiting step after a credential submit is deferred wiring.
    } catch {
      // Surface failure via the existing submitting/error UX implicitly; the
      // boundary's own 4xx (e.g. empty value) is guarded before this call.
    }
  }

  function prototypeFromCard(c) {
    const artifact = (c.artifacts || []).find(item => item.kind === 'interface_preview')
    if (!artifact) return null
    return normalizePrototypeSummary({
      artifactId: artifact.id,
      status: artifact.status,
      label: artifact.label,
      previewUrl: artifact.previewUrl,
      jobId: artifact.jobId,
      stepId: artifact.stepId,
      manifest: artifact.metadata && artifact.metadata.manifest ? artifact.metadata.manifest : {},
      contract: artifact.metadata && artifact.metadata.contract ? artifact.metadata.contract : {},
    })
  }

  async function handleOpenPrototype(proto) {
    if (proto.previewUrl) window.open(proto.previewUrl, '_blank', 'noopener,noreferrer')
  }

  async function handlePrototypeFeedback(proto) {
    const feedback = window.prompt('请输入原型修改意见')
    if (!feedback || !feedback.trim()) return
    await factoryApi.sendPrototypeFeedback(proto.jobId, proto.stepId, feedback.trim())
  }

  async function handleConfirmPrototype(proto) {
    await factoryApi.confirmPrototype(proto.jobId, proto.stepId)
  }

  async function handleContinuePrototype(proto) {
    await factoryApi.continuePrototypeWithoutConfirmation(proto.jobId, proto.stepId)
  }

  useEffect(() => {
    const ids = new Set(activeQuestions.map(q => q.id))
    setDraftAnswers(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))))
  }, [activeQuestions.map(q => q.id).join('|')])

  const submitText = async () => {
    const value = input.trim()
    if (!value || submitting || (locked && !composerActive)) return
    setInput('')
    await onSend(value, { attachmentIds: attachmentState.attachmentIds, pendingAttachments: attachmentState.pending })
    attachmentState.clearPending()
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
          <strong>{workbenchTitle}</strong>
        </div>
        <div className="cw-actions">
          {session ? <span className={`cw-status cw-status-${status}`}>{statusText(status)}</span> : null}
          {/* Phase 1: the 3 top-right drawer-entry buttons. Mutually exclusive —
              clicking the active one closes the drawer; 工作空间 is disabled until
              the current dialogue has a bound generated application. 任务执行 keeps a
              state badge while a focus task exists, even when another entry is open. */}
          <button
            type="button"
            className={`cw-drawer-btn${drawerEntry === 'task' ? ' is-active' : ''}`}
            onClick={() => onToggleDrawerEntry('task')}
            title={taskBadge ? `任务执行：${taskBadge.label}` : '任务执行'}
            aria-label="任务执行"
            aria-pressed={drawerEntry === 'task'}
          >
            <span className="cw-drawer-btn-label">任务执行</span>
            {taskBadge ? <span className={`cw-drawer-badge cw-drawer-badge-state-${taskBadge.state}`} aria-label={`任务执行：${taskBadge.label}`} /> : null}
          </button>
          <button
            type="button"
            className={`cw-drawer-btn${drawerEntry === 'agents' ? ' is-active' : ''}`}
            onClick={() => onToggleDrawerEntry('agents')}
            title="协作智能体"
            aria-label="协作智能体"
            aria-pressed={drawerEntry === 'agents'}
          >
            <span className="cw-drawer-btn-label">协作智能体</span>
          </button>
          <button
            type="button"
            className={`cw-drawer-btn${drawerEntry === 'application' ? ' is-active' : ''}`}
            onClick={() => onToggleDrawerEntry('application')}
            title={hasBoundApplication ? '工作空间' : '当前会话未绑定工作空间'}
            aria-label="工作空间"
            aria-pressed={drawerEntry === 'application'}
            disabled={!hasBoundApplication}
          >
            <span className="cw-drawer-btn-label">工作空间</span>
          </button>
          <button
            type="button"
            className="cw-store-btn"
            onClick={onOpenApplicationStore}
            title="应用商店"
            aria-label="应用商店"
          >
            <span className="cw-drawer-btn-label">应用商店</span>
          </button>
          {canAbandon ? (
            <div className="cw-more">
              <button
                type="button"
                className="cw-more-btn"
                onClick={() => setMoreMenuOpen(open => !open)}
                title="更多操作"
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                disabled={submitting}
              >
                <MoreHorizontal size={16} />
              </button>
              {moreMenuOpen ? (
                <div className="cw-more-menu" role="menu">
                  <button
                    type="button"
                    className="cw-more-danger"
                    role="menuitem"
                    onClick={requestAbandonRequirement}
                    disabled={submitting}
                  >
                    放弃本次需求
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {moreMenuOpen ? <button type="button" className="cw-menu-backdrop" aria-label="关闭更多操作" onClick={() => setMoreMenuOpen(false)} /> : null}

      {/* Phase 1: the inline focus-task panel has been REMOVED from the center.
          Task execution now lives behind the 任务执行 drawer entry (Phase 2 fills
          it). The center keeps only the conversation timeline + composer. */}

      <AggregateOrchestrationGraph
        graph={aggregateGraph}
        compact={aggregateGraphCompact}
        onToggleCompact={toggleAggregateGraphCompact}
        onOpenArtifact={openArtifact}
        onOpenTaskStep={onOpenTaskStep}
      />

      <div ref={cwBodyScrollRef} className="cw-body" onScroll={updateWorkbenchBodyFollowState}>
        {timeline.map(item => (
          <TimelineItem
            key={item.id}
            item={item}
            draftAnswers={draftAnswers}
            setDraftAnswers={setDraftAnswers}
            submitting={submitting}
            focusRequirement={focusRequirement}
            dialogueId={session && session.id}
            onSelectRoute={onSelectRoute}
            onOpenApp={onOpenApp}
            onAcceptConsolidation={onAcceptConsolidation}
            onSend={onSend}
            onSelectClarificationScope={onSelectClarificationScope}
            onOpenPreviewAttachment={setPreviewAttachment}
            onOpenTaskStep={onOpenTaskStep}
            onConfirmTaskStep={onConfirmTaskStep}
            onConfirmDataAccess={onConfirmDataAccess}
            manualStepConfirmation={manualStepConfirmation}
            onToggleManualStepConfirmation={setManualStepConfirmation}
            onPickClarification={(scope, value) => {
              if (!value) return
              if (onSelectClarificationScope) onSelectClarificationScope(scope)
              setInput(prev => {
                const trimmed = String(prev).trim()
                // Append rather than overwrite so multi-question clarifications
                // (or multiple picks) accumulate in the composer. The answer goes
                // to answerJob as free text the agent reads, so a combined reply
                // like "演示数据；两级审批；年假、病假" is exactly what we want.
                return trimmed ? `${trimmed}；${value}` : value
              })
            }}
          />
        ))}

        {aggregateGraph.cards
          .filter(card => card.key !== 'user_input' && card.state !== 'not_started' && card.state !== 'waiting_upstream')
          .map(card => (
            <WorkbenchAgentBlock
              key={card.key}
              card={card}
              thinking=""
              analysisLog=""
              questions={card.key === aggregateGraph.activeCardKey ? activeQuestions : []}
              prototype={card.key === 'interface_parsing' ? prototypeFromCard(card) : null}
              onConfirm={key => onConfirmCard ? onConfirmCard(key) : onConfirm && onConfirm({ aggregateCardKey: key })}
              onOpenArtifact={openArtifact}
              onSubmitCredential={submitCredential}
              onOpenPrototype={handleOpenPrototype}
              onPrototypeFeedback={handlePrototypeFeedback}
              onConfirmPrototype={handleConfirmPrototype}
              onContinuePrototype={handleContinuePrototype}
            />
          ))}

        {/* Continuous-workbench trace surface (Task 7): the dialogue-scoped,
            sequence-replayable visible work-trace. Rendered as a compact
            activity list appended after the composed timeline items. */}
        {SHOW_WORK_TRACE && traceItems.length > 0 ? <WorkTraceList items={traceItems} steps={traceSteps} /> : null}

        {/* After a version deploys, surface the "已生效，可继续描述修改需求"
            hint and keep the composer active (continuous loop). */}
        {versionDeployed ? (
          <div className="cw-version-hint">
            <GitCommit size={14} />
            <span>{versionLabel ? `${versionLabel} ` : ''}已生效，可继续描述修改需求</span>
            {deployedApp && (deployedApp.runtimeUrl || deployedApp.runtime_url) ? (
              <a className="cw-version-open" href={deployedApp.runtimeUrl || deployedApp.runtime_url} target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> 打开
              </a>
            ) : null}
            {/* Confirm-gated rollback to the prior effective version. */}
            {onRollback && deployedApp && deployedApp.id ? (
              <RollbackControl appId={deployedApp.id} onRollback={onRollback} submitting={submitting} />
            ) : null}
          </div>
        ) : null}

        {/* Change-summary confirmation panel: the continuous loop surfaces a
            proposed change for the user to confirm before the worker applies it. */}
        {changeProposal ? (
          <div className="cw-change-confirm">
            <strong>变更确认</strong>
            <span>{(changeProposal.payload && (changeProposal.payload.summary || changeProposal.payload.description)) || '有新的变更建议待确认。'}</span>
            <button type="button" className="primary" onClick={onConfirmChange} disabled={submitting}>
              {submitting ? '处理中' : '确认变更'}
            </button>
          </div>
        ) : null}

        {currentDeployment ? (
            <div className="cw-deployment-info">
              <GitCommit size={14} />
              <span>
              <b>当前部署版本 {currentDeployment.version}</b>
                {currentDeployment.summary ? <em>摘要：{currentDeployment.summary}</em> : null}
            </span>
            </div>
        ) : null}
      </div>

      {/* Pending-turn indicator + cancel-current-turn control (202 ack path). */}
      {hasPendingTurn ? (
        <div className="cw-pending-turn">
          <Loader2 size={14} className="spin" />
          <span>本轮处理中{pendingTurn.acceptedAt ? `（${formatAcceptedAt(pendingTurn.acceptedAt)}）` : ''}</span>
          {onCancelTurn ? (
            <button type="button" className="cw-cancel-turn" onClick={onCancelTurn} disabled={submitting} title="取消本轮">
              <Ban size={12} /> 取消本轮
            </button>
          ) : null}
        </div>
      ) : null}

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
          <button
            type="button"
            className="primary"
            onClick={() => onConfirm && onConfirm({ executionPolicy: { manualStepConfirmation: !isBusiness && manualStepConfirmation } })}
            disabled={submitting}
          >
            {submitting ? '处理中' : isBusiness ? '确认创建' : '确认并生成'}
          </button>
        </div>
      ) : null}

      {error ? <div className="cw-error">{error}</div> : null}

      <footer className="cw-composer">
        {canRetry ? <button type="button" onClick={onRetry} disabled={submitting} title="重试本轮">重试本轮</button> : null}
        {/* Archive control: archive a resolved dialogue. The backend endpoint
            (POST /api/dialogues/:id/archive) sets status to `archived`; the hook
            refreshes the view so the composer is replaced by a terminal hint. */}
        {onArchive && session && status === 'resolved' ? (
          <button type="button" onClick={onArchive} disabled={submitting} title="归档此会话">
            <Archive size={12} /> 归档
          </button>
        ) : null}
        {/* Continuous loop: a version that deployed keeps the composer ACTIVE so
            the user can describe further changes, even though the dialogue is
            resolved. Only true terminal-without-deployment states lock it.
            Phase 1: the 新建会话 action moved to the left SessionNav, so the
            terminal hints no longer reference it here. */}
        {status === 'resolved' && !composerActive ? (
          <p className="cw-terminal-hint">会话已完成，在左侧「会话导航」开始新的需求。</p>
        ) : status === 'abandoned' || status === 'failed' || status === 'archived' ? (
          <>
            {sessionError ? (
              <div className="cw-session-error" role="alert">
                <div className="cw-session-error-title">{sessionError.title}</div>
                {sessionError.detail ? <div className="cw-session-error-detail">{sessionError.detail}</div> : null}
                {sessionError.hint ? <div className="cw-session-error-hint">{sessionError.hint}</div> : null}
              </div>
            ) : null}
            <p className="cw-terminal-hint">会话已结束。{canRetry ? '失败会话可重试本轮，或' : ''}在左侧会话导航新建会话。</p>
          </>
        ) : locked && !composerActive ? (
          <p className="cw-terminal-hint">请在上方选择并确认操作。</p>
        ) : (
          <>
            {clarificationScope ? (
              <div className="cw-composer-scope">
                正在回复任务内澄清{clarificationScopeLabel ? `：${clarificationScopeLabel}` : ''}。请先回答该问题。
              </div>
            ) : null}
            <AttachmentComposer
              items={attachmentState.pending}
              uploading={attachmentState.uploading}
              onAddFiles={attachmentState.addFiles}
              onRemove={attachmentState.removePending}
              onOpen={setPreviewAttachment}
            />
            <div className="cw-composer-row">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={clarificationScope ? '回复当前任务内澄清' : composerActive ? '继续描述修改需求' : '输入需求或补充说明'}
                disabled={submitting}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText() } }}
              />
              <button type="button" className="cw-send" onClick={submitText} disabled={!input.trim() || submitting} title="发送" aria-label="发送">
                {submitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              </button>
            </div>
          </>
        )}
      </footer>

      {previewAttachment ? (
        <AttachmentPreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
      ) : null}

      <ProjectDocumentPreviewModal document={previewDocument} onClose={() => setPreviewDocument(null)} />
      <InterfacePreviewModal
        artifact={previewInterface}
        jobId={(focusTask && focusTask.id) || ''}
        onClose={() => setPreviewInterface(null)}
      />

      {abandonConfirmOpen ? (
        <div className="cw-confirm-layer" role="presentation" onMouseDown={() => setAbandonConfirmOpen(false)}>
          <section
            className="cw-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cw-abandon-title"
            aria-describedby="cw-abandon-desc"
            onMouseDown={event => event.stopPropagation()}
          >
            <h3 id="cw-abandon-title">放弃本次需求？</h3>
            <p id="cw-abandon-desc">
              将结束当前需求澄清/生成对话，后续不能继续补充或确认生成。已在执行的任务不会被取消，如需停止任务请到“任务执行”中取消。
            </p>
            <div className="cw-confirm-actions">
              <button type="button" className="cw-confirm-secondary" onClick={() => setAbandonConfirmOpen(false)}>
                继续处理
              </button>
              <button type="button" className="cw-confirm-danger" onClick={confirmAbandonRequirement} disabled={submitting}>
                确认放弃
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

async function copyText(text) {
  const value = String(text || '')
  if (!value) return false
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value)
    return true
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

function CopyableBlock({ text, children, className = '', copyLabel = '复制' }) {
  const [copied, setCopied] = useState(false)
  const value = String(text || '')
  const doCopy = async () => {
    if (!value) return
    try {
      const ok = await copyText(value)
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (_) {
      setCopied(false)
    }
  }
  return (
    <div className={`cw-copyable ${className}`.trim()}>
      {children}
      <div className="cw-copy-row">
        <button type="button" className="cw-copy-button" onClick={doCopy} disabled={!value} title={copied ? '已复制' : copyLabel}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : copyLabel}</span>
        </button>
      </div>
    </div>
  )
}

function taskDrawerBadgeInfo(task) {
  if (!task) return null
  const status = task.status || ''
  if (status === 'waiting_user' || status === 'waiting') return { state: 'waiting-user', label: '等待用户处理' }
  if (status === 'running' || status === 'in_progress') return { state: 'running', label: '执行中' }
  if (status === 'queued') return { state: 'queued', label: '排队中' }
  if (status === 'failed') return { state: 'failed', label: '执行失败' }
  if (status === 'completed' || status === 'succeeded') return { state: 'completed', label: '已完成' }
  if (status === 'canceled' || status === 'cancelled') return { state: 'canceled', label: '已取消' }
  return { state: 'unknown', label: '状态未知' }
}

function TimelineItem({ item, draftAnswers, setDraftAnswers, submitting, focusRequirement, dialogueId, onSelectRoute, onOpenApp, onAcceptConsolidation, onSend, onSelectClarificationScope, onPickClarification, onOpenPreviewAttachment, onOpenTaskStep, onConfirmTaskStep, onConfirmDataAccess, manualStepConfirmation, onToggleManualStepConfirmation }) {
  if (item.type === 'user_message') {
    // Submitted attachment refs (Task 11 / spec decision #22): after send, the
    // persisted user_message carries `attachments` [{ id, active, name,
    // previewKind }]. Render each as a clickable chip BELOW the content. Inactive
    // refs (active===false) stay visible but muted with a 已停用 marker (decision
    // #23: deactivated refs remain for replay/audit). Clicking opens the existing
    // AttachmentPreviewModal via the shared preview setter (no second modal).
    const attachments = Array.isArray(item.attachments) ? item.attachments : []
    return (
      <CopyableBlock text={item.content} className="cw-user-wrap">
        <div className="cw-item cw-user">{item.content}</div>
        {attachments.length > 0 ? (
          <div className="cw-user-attachments">
            {attachments.map(ref => (
              <MessageAttachmentChip
                key={ref.id}
                ref_={ref}
                dialogueId={dialogueId}
                onOpen={onOpenPreviewAttachment}
              />
            ))}
          </div>
        ) : null}
      </CopyableBlock>
    )
  }
  if (item.type === 'agent_message') {
    return (
      <CopyableBlock text={item.content} className="cw-agent-wrap">
        <div className="cw-item cw-agent">{item.content}</div>
      </CopyableBlock>
    )
  }
  if (item.type === 'clarification_prompt') {
    // A pipeline step (solution_design / code_generation) paused for user input.
    // Render the question(s) + structured options as a card; picking an option
    // fills the composer (the reply goes through the normal send → answerJob
    // path, which resets the step so the agent reads the user's answer).
    return (
      <ClarificationPromptCard item={item} onSelectScope={onSelectClarificationScope} onPick={onPickClarification} onConfirmDataAccess={onConfirmDataAccess} submitting={submitting} />
    )
  }
  if (item.type === 'analysis_stream') {
    // D6: the persisted analysis lands after the round completes and renders
    // FOLDED (collapsed) above its conclusion. An expand/collapse toggle reveals
    // the full text. Rendered as plaintext only (never dangerouslySetInnerHTML).
    return <FoldedAnalysis content={item.content} label={item.label} expanded={item.expanded} rawThinking={item.rawThinking} />
  }
  if (item.type === 'task_execution_block') {
    // Phase 3: one block per executing task step. Running/waiting/failed steps
    // render EXPANDED with the safe-execution text plus the step summary;
    // completed/canceled steps fold into a one-line summary row. Step-attributed
    // task-thinking waits for Phase 4 persistence.
    return <TaskExecutionBlock item={item} />
  }
  if (item.type === 'live_analysis') {
    // D1/D2: the transient streaming safe analysis work log. Monospace,
    // plaintext `<pre>`-safe, NEVER dangerouslySetInnerHTML. Rendered as a
    // distinct "分析过程" block while the round/step is in flight. When `pending`
    // (no view yet, send just accepted) a spinner marks it as actively working
    // so the workbench does not look frozen during the routing wait.
    return (
      <CopyableBlock text={item.content} className="cw-agent-wrap" copyLabel="复制过程">
        <div className={`cw-item cw-agent cw-live-analysis${item.kind === 'step' ? ' cw-live-step' : ''}${item.pending ? ' cw-live-pending' : ''}`}>
          <span className="cw-item-label">
            {item.pending ? <Loader2 size={12} className="cw-spin" /> : null}
            {item.kind === 'step' ? '生成过程' : '分析过程'}
          </span>
          <pre className="cw-live-text">{translateAnalysisText(item.content)}</pre>
        </div>
      </CopyableBlock>
    )
  }
  if (item.type === 'live_thinking' || item.type === 'thinking_summary') {
    return <ThinkingSummary item={item} />
  }
  // The detailed 协作编排执行图 is hidden from the conversation flow: the pinned
  // 编排执行总览 (AggregateOrchestrationGraph) is now the primary orchestration
  // view. Per-agent execution detail still lives in the task drawer.
  if (item.type === 'collaboration_plan_preview') {
    return null
  }
  if (item.type === 'route_recommendation') {
    return <RouteChoiceCard reason={item.reason} canReuseExistingApplication={item.canReuseExistingApplication} onSelectRoute={onSelectRoute} submitting={submitting} />
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
  if (item.type === 'requirement_summary') return <RequirementSummary requirement={focusRequirement || item.requirement} />
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

// MessageAttachmentChip renders one submitted attachment reference under a
// user_message. It reuses the existing `.cw-attach-chip` look. Clicking opens the
// shared AttachmentPreviewModal (Task 4 wiring). The ref carries only
// { id, active, name, previewKind }; we attach dialogueId + name + previewKind so
// the modal degrades to its metadata path when there is no content route yet.
function MessageAttachmentChip({ ref_, dialogueId, onOpen }) {
  const active = ref_.active !== false
  const isImage = ref_.previewKind === 'image'
  const name = ref_.name || '附件'
  const open = () => {
    if (!onOpen || !ref_.id) return
    onOpen({ id: ref_.id, name, previewKind: ref_.previewKind, dialogueId, originalName: name })
  }
  return (
    <span className={`cw-attach-chip cw-attach-chip-ref${active ? '' : ' cw-attach-chip-inactive'}`}>
      {isImage ? <ImageIcon size={14} /> : <FileText size={14} />}
      <button type="button" className="cw-attach-name" onClick={open} title={active ? '预览附件' : '附件已停用'} disabled={!ref_.id || !onOpen}>
        {name}
      </button>
      {active ? null : <em className="cw-attach-deactivated">已停用</em>}
    </span>
  )
}

function ThinkingSummary({ item }) {
  const summary = String(item.summary || '').trim()
  const raw = String(item.content || '').trim()
  const copyValue = summary || raw
  // Translate known internal English tokens (status keys, requirement field
  // names, skill slugs, …) that leak into the streamed thinking / analysis text
  // so the 思考过程 surface reads in Chinese. Conservative whole-token replace.
  const displaySummary = translateAnalysisText(summary)
  const displayRaw = translateAnalysisText(raw)
  const live = item.pending || item.type === 'live_thinking'
  const liveThinkingScrollRef = useRef(null)
  const liveThinkingShouldFollowRef = useRef(true)
  useEffect(() => {
    liveThinkingShouldFollowRef.current = true
  }, [item.id])
  const updateLiveThinkingFollowState = event => {
    const el = event.currentTarget
    const { scrollHeight, scrollTop, clientHeight } = el
    const distanceToBottom = scrollHeight - scrollTop - clientHeight
    liveThinkingShouldFollowRef.current = distanceToBottom <= LIVE_THINKING_FOLLOW_BOTTOM_THRESHOLD
  }
  useEffect(() => {
    const el = liveThinkingScrollRef.current
    if (!el || !live || !liveThinkingShouldFollowRef.current) return
    // 思考流内部也按“贴底才跟随”处理，避免用户上滑阅读时被拉回底部。
    const { scrollHeight } = el
    el.scrollTop = scrollHeight
  }, [raw, live])
  return (
    <CopyableBlock text={copyValue} className="cw-agent-wrap" copyLabel="复制思考摘要">
      <div className="cw-item cw-agent cw-live-thinking cw-thinking-summary">
        <span className="cw-item-label">
          {live ? <Loader2 size={12} className="cw-spin" /> : null}
          {live ? '正在思考…' : '思考摘要'}
        </span>
        {live && displayRaw ? (
          <div
            ref={liveThinkingScrollRef}
            className="cw-raw-thinking-stream"
            onScroll={updateLiveThinkingFollowState}
          >
            <pre className="cw-live-text">{displayRaw}</pre>
          </div>
        ) : (
          <>
            {displaySummary ? (
              <pre className="cw-live-text cw-thinking-summary-text">{displaySummary}</pre>
            ) : (
              <p className="cw-thinking-summary-empty">中文摘要将在分析过程生成后显示。</p>
            )}
            {displayRaw ? (
              <details className="cw-raw-thinking">
                <summary>原始思考过程</summary>
                <pre className="cw-live-text">{displayRaw}</pre>
              </details>
            ) : null}
          </>
        )}
      </div>
    </CopyableBlock>
  )
}


// FoldedAnalysis (D6) renders the persisted analysis work log as a COLLAPSED
// block with an expand/collapse toggle. The round's streamed analysis folds above
// its conclusion once the persisted analysis lands; the user expands to read it.
// Plaintext only (a `<pre>`), never dangerouslySetInnerHTML.
function FoldedAnalysis({ content, label, expanded: initialExpanded, rawThinking }) {
  const [expanded, setExpanded] = useState(!!initialExpanded)
  const text = translateAnalysisText(String(content || ''))
  const raw = String(rawThinking || '')
  return (
    <CopyableBlock text={text} className="cw-agent-wrap" copyLabel="复制分析">
      <div className="cw-item cw-agent cw-folded-analysis">
        <button
          type="button"
          className="cw-fold-toggle"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
        >
          <span className="cw-item-label">{label || '分析过程'}</span>
          <span className="cw-fold-hint">{expanded ? '收起' : '展开'}</span>
        </button>
        {expanded ? <pre className="cw-folded-text">{text}</pre> : null}
        {expanded && raw ? (
          <details className="cw-raw-thinking">
            <summary>原始思考过程</summary>
            <pre className="cw-live-text">{raw}</pre>
          </details>
        ) : null}
      </div>
    </CopyableBlock>
  )
}

// TaskExecutionBlock renders one executing task step in the conversation flow
// (Phase 3 §Conversation Task Blocks). Display policy: running/waiting_user/
// failed expand by default (the builder sets expanded:true); completed/canceled
// fold into a one-line summary row. The user can always toggle. Expanded body
// shows the reconstructed safe-execution stream (安全执行过程), the step
// summary (步骤摘要), and any error. Task thinking stays in the independent
// live_thinking surface until Phase 4 adds step-attributed thinking events.
const TASK_STEP_STATUS_LABEL = {
  pending: '等待中',
  running: '进行中',
  waiting_user: '等待用户',
  succeeded: '已完成',
  completed: '已完成',
  failed: '已失败',
  canceled: '已取消',
  cancelled: '已取消',
  skipped: '已跳过',
}

function TaskExecutionBlock({ item }) {
  const [userExpandedOverride, setUserExpandedOverride] = useState(null)
  const taskThinkingScrollRef = useRef(null)
  const taskThinkingShouldFollowRef = useRef(true)
  useEffect(() => {
    setUserExpandedOverride(null)
    taskThinkingShouldFollowRef.current = true
  }, [item.id])
  const expanded = userExpandedOverride ?? !!item.expanded
  const status = item.status || 'pending'
  const label = TASK_STEP_STATUS_LABEL[status] || status
  const summary = String(item.summary || '')
  const safeExecution = String(item.safeExecution || '')
  const error = String(item.error || '')
  const taskThinking = String(item.taskThinking || '')
  const copyText = [safeExecution, summary, taskThinking].filter(Boolean).join('\n\n')
  const updateTaskThinkingFollowState = event => {
    const el = event.currentTarget
    const { scrollHeight, scrollTop, clientHeight } = el
    const distanceToBottom = scrollHeight - scrollTop - clientHeight
    taskThinkingShouldFollowRef.current = distanceToBottom <= TASK_THINKING_FOLLOW_BOTTOM_THRESHOLD
  }
  useEffect(() => {
    const el = taskThinkingScrollRef.current
    if (!el || !expanded || !taskThinkingShouldFollowRef.current) return
    const { scrollHeight } = el
    el.scrollTop = scrollHeight
  }, [taskThinking, expanded])
  return (
    <CopyableBlock text={copyText} className="cw-task-wrap" copyLabel="复制任务块">
      <div className={`cw-item cw-task-block cw-task-status-${status}`}>
        <button
          type="button"
          className="cw-task-toggle"
          onClick={() => setUserExpandedOverride(v => !(v ?? !!item.expanded))}
          aria-expanded={expanded}
        >
          <span className="cw-task-name">{item.name}</span>
          <span className={`cw-task-badge cw-task-badge-${status}`}>{label}</span>
          <span className="cw-fold-hint">{expanded ? '收起' : '展开'}</span>
        </button>
        {expanded ? (
          <div className="cw-task-body">
            {taskThinking ? (
              <section className="cw-task-section cw-task-thinking-section">
                <h5>任务思考过程{item.taskThinkingRedacted ? <em className="cw-redacted-note">已脱敏/截断</em> : null}</h5>
                <pre
                  ref={taskThinkingScrollRef}
                  className="cw-live-text cw-task-thinking-scroll"
                  onScroll={updateTaskThinkingFollowState}
                >{taskThinking}</pre>
              </section>
            ) : null}
            {safeExecution ? (
              <section className="cw-task-section">
                <h5>安全执行过程</h5>
                <pre className="cw-live-text">{safeExecution}</pre>
              </section>
            ) : null}
            {summary ? (
              <section className="cw-task-section">
                <h5>步骤摘要</h5>
                <pre className="cw-live-text">{summary}</pre>
              </section>
            ) : null}
            {error ? (
              <section className="cw-task-section cw-task-error">
                <h5>错误信息</h5>
                <pre className="cw-live-text">{error}</pre>
              </section>
            ) : null}
          </div>
        ) : summary ? (
          <p className="cw-task-summary-row">{summary}</p>
        ) : null}
      </div>
    </CopyableBlock>
  )
}

function RouteChoiceCard({ reason, canReuseExistingApplication, onSelectRoute, submitting }) {
  return (
    <div className="cw-route-choice">
      {reason ? <p className="cw-route-reason">{reason}</p> : null}
      <div className="cw-route-options">
        {canReuseExistingApplication ? (
          <button type="button" disabled={submitting} onClick={() => onSelectRoute('existing_application')}>
            <b>复用已有智能体</b>
            <small>打开匹配的现有应用</small>
          </button>
        ) : null}
        <button type="button" disabled={submitting} onClick={() => onSelectRoute('application_generation')}>
          <b>生成新智能体</b>
          <small>通过需求澄清生成助手应用或业务应用</small>
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
  const managed = card.kind === 'managed_agent'
  const running = card.status === 'running'
  const stopped = !managed && !running && card.status !== 'running'
  const canOpen = !managed || Boolean(card.runtimeUrl)
  const open = () => {
    if (submitting || !canOpen) return
    if (managed) {
      window.open(card.runtimeUrl, '_blank', 'noopener')
      return
    }
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
		{running && canOpen ? (
		  <button type="button" className="cw-app-action" onClick={open} disabled={submitting} title="打开智能体">
		    <ExternalLink size={14} />
		    <span>打开智能体</span>
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

function shortId(value) {
  const text = String(value || '')
  if (text.length <= 10) return text
  return `${text.slice(0, 6)}…${text.slice(-3)}`
}

// ClarificationPromptCard renders a job-step clarification (solution_design /
// code_generation pausing for user input) as a distinct, attention-grabbing card
// in the conversation flow. Unlike the pre-job QuestionCard (which has its own
// submit + draftAnswers state), a job-step clarification is answered via the
// normal composer: picking an option (or typing) fills the composer, and sending
// goes through answerJob → the step resets and the agent reads the reply.
function ClarificationPromptCard({ item, onSelectScope, onPick, onConfirmDataAccess, submitting }) {
  const questions = Array.isArray(item.questions) ? item.questions : []
  const open = item.status === 'open'
  const [expanded, setExpanded] = useState(item.expanded !== false)
  const [confirming, setConfirming] = useState(false)
  // Whether ANY question offers structured options. The agent does not always
  // emit an options array (sometimes it writes (A)/(B)/(C) into the question
  // text instead). When there are no pickable options, the hint must NOT say
  // "点击上方选项" — it would mislead the user.
  const hasAnyOptions = questions.some(q => Array.isArray(q.options) && q.options.length > 0)
  const firstQuestion = questions[0] && questions[0].question
  const finalAnswer = String(item.finalAnswer || '')
  const attribution = [
    item.taskId ? `任务 ${shortId(item.taskId)}` : '',
    item.stepName || item.stepId ? `步骤 ${item.stepName || shortId(item.stepId)}` : '',
    item.agentKey ? `智能体 ${item.agentKey}` : '',
    item.attempt ? `第 ${item.attempt} 次尝试` : '',
  ].filter(Boolean).join(' · ')
  const scope = { taskId: item.taskId, stepId: item.stepId, attempt: item.attempt, agentKey: item.agentKey, stepName: item.stepName }
  const selectScope = () => {
    if (!open || typeof onSelectScope !== 'function') return
    onSelectScope(scope)
  }
  const pick = async (value, opt, question) => {
    if (!open || submitting || confirming || typeof onPick !== 'function') return
    if (
      question &&
      question.id === 'data_access_summary_confirmation' &&
      opt &&
      opt.value === 'confirm' &&
      typeof onConfirmDataAccess === 'function'
    ) {
      setConfirming(true)
      try {
        await onConfirmDataAccess(scope.taskId, scope.stepId, { version: question.defaultAnswer || '', attempt: scope.attempt })
      } catch {
        // 错误信息已由 useJobs 写入全局错误状态，这里只负责恢复按钮状态。
      } finally {
        setConfirming(false)
      }
      return
    }
    onPick(scope, value)
  }
  return (
    <div
      className={`cw-item cw-agent cw-clarification${open ? ' cw-clarification-open' : ' cw-clarification-answered'}`}
      onMouseDown={selectScope}
      onFocusCapture={selectScope}
    >
      <button
        type="button"
        className="cw-clarification-toggle"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className="cw-item-label">{open ? '任务内澄清请求' : `已澄清：${firstQuestion || '任务内澄清'}`}</span>
        <span className="cw-fold-hint">{expanded ? '收起' : '展开'}</span>
      </button>
      {attribution ? <small className="cw-clarification-attribution">{attribution}</small> : null}
      {expanded ? (
        <>
          {questions.map((q, qi) => (
            <div key={q.id || qi} className="cw-clarification-q">
              <p className="cw-clarification-text">{q.question}</p>
              {q.options && q.options.length > 0 ? (
                <div className="cw-options">
                  {q.options.map(opt => (
                    <button
                      key={opt.value || opt.label}
                      type="button"
                      className={`cw-option cw-clarification-option${opt.recommended ? ' cw-option-recommended' : ''}`}
                      onClick={() => pick(opt.label || opt.value, opt, q)}
                      disabled={!open || submitting || confirming}
                    >
                      <span className="cw-option-head">
                        <b>{opt.label || opt.value}</b>
                        {opt.recommended ? <em className="cw-option-badge">推荐</em> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {q.defaultAnswer ? <small className="cw-clarification-hint">参考建议：{q.defaultAnswer}</small> : null}
            </div>
          ))}
          {!open && finalAnswer ? (
            <div className="cw-clarification-final-answer">
              <strong>最终回答</strong>
              <p>{finalAnswer}</p>
            </div>
          ) : null}
          <small className="cw-clarification-hint">
            {open
              ? hasAnyOptions ? '点击上方选项，或在下方输入框回复' : '请在下方输入框回复你的选择'
              : '该澄清已归档为只读。'}
          </small>
        </>
      ) : null}
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

function deploymentStatusInfo({ view, focusTask, steps, traceItems }) {
  const deploymentStep = (Array.isArray(steps) ? steps : []).find(step => {
    const kind = step && step.kind
    const agentKey = step && (step.agentKey || step.agent_key)
    return kind === 'deployment' && (step.status === 'running' || step.status === 'succeeded') && (!agentKey || agentKey === 'deployer')
  })
  if (!deploymentStep) return null
  const requirement = (view && view.child && view.child.requirement) || requirementFromJob(focusTask) || {}
  const summary = String(requirement.coreScenario || '').trim()
  return {
    version: deploymentVersionLabel({ view, focusTask, traceItems }),
    summary,
  }
}

function requirementFromJob(job) {
  const raw = job && (job.confirmed_requirement_json || job.confirmedRequirementJSON)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

function deploymentVersionLabel({ view, focusTask, traceItems }) {
  const deployedApp = view && view.resolvedApplication
  const existing = deployedApp && (deployedApp.version || deployedApp.version_label || deployedApp.versionLabel)
  const match = existing && String(existing).match(/v\s*(\d+)/i)
  if (match) return `V${match[1]}`
  const versionEvents = (Array.isArray(traceItems) ? traceItems : []).filter(it => it && it.type === 'version').length
  const baseVersionID = focusTask && (focusTask.base_version_id || focusTask.baseVersionID)
  const nextNumber = Math.max(1, versionEvents + 1, baseVersionID ? 2 : 1)
  return `V${nextNumber}`
}

function RequirementSummary({ requirement }) {
  const boundary = requirement && requirement.judgementBoundary
  const rows = [
    ['应用类型', formatAppType(requirement.appType)],
    ['应用名称', requirement.appName],
    ['核心场景', requirement.coreScenario],
    ['主视图', requirement.primaryView],
    ['研判边界', boundary && boundary.summary],
    ['数据来源', boundary && formatDataSources(boundary.dataSources)],
    ['数据策略', formatDataPolicy(requirement.dataPolicy)],
  ].filter(([, value]) => value)
  return (
    <div className="cw-summary">
      <strong>确认需求摘要</strong>
      {requirement && requirement.description ? (
        <p className="cw-summary-desc">{requirement.description}</p>
      ) : null}
      {rows.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
    </div>
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

function fieldLabel(field) {
  const map = {
    appType: '应用类型',
    appName: '应用名称',
    coreScenario: '核心场景',
    primaryView: '主视图',
    dataPolicy: '数据策略',
    judgementBoundary: '研判边界',
    'judgementBoundary.dataSources': '数据来源',
    judgementDataSources: '数据来源',
    judgement_boundary_data_sources: '数据来源',
    'judgementBoundary.summary': '研判边界摘要',
  }
  return map[field] || field
}

function formatValue(value) {
  if (value == null || value === '') return ''
  if (value && typeof value === 'object' && !Array.isArray(value) && (value.summary || value.dataSources)) {
    const parts = [value.summary, formatDataSources(value.dataSources)].filter(Boolean)
    return parts.join('；')
  }
  if (Array.isArray(value)) return value.join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatDataSources(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  return values.map(dataSourceLabel).filter(Boolean).join('、')
}

function dataSourceLabel(value) {
  const map = {
    ontology: '本体数据源',
    public_web_search: '网络公开搜索',
  }
  return map[value] || value
}

// ---- continuous-workbench components (Task 7) ------------------------------

// WorkTraceList renders the dialogue-scoped visible work-trace as a compact
// activity list. Each row is one backend WorkTraceEvent (folded ascending,
// deduped, isolated to the selected dialogue by workTraceState). The payload is
// already summarized server-side; we surface its label/title/text only.
//
// Collapsible (mirrors FoldedAnalysis): defaults COLLAPSED so the conversation
// stays clean, with a live step count in the header so a collapsed trace still
// signals in-flight progress. The user expands to read the detail.
// Business-facing trace rendering. The backend emits WorkTraceType values
// (intent / approach / tool / assistant_output / deployment …), NOT the dotted
// names the old label map guessed at — so most events fell back to the raw
// English type. This layer maps each real type to a milestone sentence and
// folds the noisy technical types (tool / assistant_output) into one
// expandable group, so business users see a clean progress flow instead of
// file diffs and model prose.
const FOLDED_TRACE_TYPES = new Set(['tool', 'assistant_output'])

// groupTraceItems walks items in order and folds runs of technical types
// (tool / assistant_output) into one expandable group node. Milestone types
// stay as individual rows. tool and assistant runs group separately (never
// merged) even when adjacent.
function groupTraceItems(items, stageByStepId) {
  const groups = []
  for (const it of items) {
    if (FOLDED_TRACE_TYPES.has(it.type)) {
      // Group by (type, stage) so a phase change splits the run — each folded
      // group then belongs to exactly one pipeline stage and can be titled by it.
      const stage = traceStageOf(it, stageByStepId)
      const last = groups[groups.length - 1]
      if (last && last.kind === 'folded' && last.type === it.type && last.stage === stage) {
        last.items.push(it)
      } else {
        groups.push({ kind: 'folded', type: it.type, stage, items: [it] })
      }
    } else {
      groups.push({ kind: 'milestone', item: it })
    }
  }
  return groups
}

// traceStageOf resolves a trace row's pipeline stage label (e.g. 代码生成) from
// its step_id via the step list the App passes in. '' when the step is unknown.
function traceStageOf(it, stageByStepId) {
  const sid = it && (it.stepId || it.step_id || '')
  return (sid && stageByStepId && stageByStepId[sid]) || ''
}

// traceClassFor maps a real WorkTraceType to a color bucket.
function traceClassFor(type) {
  if (!type) return 'info'
  if (type === 'error') return 'error'
  if (type === 'warning' || type === 'assumption') return 'warn'
  if (type === 'clarification' || type === 'change_confirmation') return 'confirm'
  if (type === 'deployment' || type === 'version' || type === 'intent' || type === 'approach' || type === 'validation') return 'ok'
  return 'info'
}

function traceIconFor(type) {
  const cls = traceClassFor(type)
  if (cls === 'error') return <XCircle size={14} />
  if (cls === 'warn') return <AlertTriangle size={14} />
  if (cls === 'confirm') return <HelpCircle size={14} />
  if (cls === 'ok') return <CheckCircle2 size={14} />
  return <Loader2 size={14} className="spin" />
}

// traceMilestoneText turns one milestone trace into a single business sentence.
function traceMilestoneText(it) {
  const p = it.payload || {}
  const raw = p.summary || p.message || p.text || p.description || p.label || ''
  switch (it.type) {
    case 'intent': return '已理解你的需求'
    case 'approach': return '已规划实现方案'
    case 'clarification': {
      const n = Array.isArray(p.questions) ? p.questions.length : 0
      return n > 0 ? `需要你确认 ${n} 个问题` : '需要你补充确认'
    }
    case 'assumption': return p.assumption ? `按默认前提处理:${p.assumption}` : '按默认前提处理'
    case 'validation': return /fail|invalid|失败/i.test(String(raw)) ? '校验未通过' : '校验通过'
    case 'change_confirmation': {
      const desc = p.summary || p.change_description || ''
      return desc ? `有修改建议待你确认:${desc}` : '有修改建议待你确认'
    }
    case 'version': return p.version || p.label ? `新版本就绪 · ${p.version || p.label}` : '新版本就绪'
    case 'deployment': return '已部署上线'
    case 'task': return raw ? `任务进展:${raw}` : '任务已推进'
    case 'data': return raw ? `已准备数据:${raw}` : '已准备数据'
    case 'warning': return raw || '有提醒'
    case 'error': return raw || '处理出错'
    default: return raw || it.type || ''
  }
}

// toolRowText renders one folded tool row as a short business verb + target
// (file path preferred; the +N/-M line-count noise is dropped — meaningless to
// a business user).
function toolRowText(p) {
  const name = (p && p.name) || ''
  const verb = ({ Write: '编写', Edit: '编辑', MultiEdit: '编辑', Bash: '执行命令' })[name] || name || '操作'
  const path = p && p.path ? p.path : ''
  const summary = p && p.summary ? p.summary : ''
  const target = path || summary
  return target ? `${verb} ${target}` : verb
}

// assistantRowText renders one folded assistant-output row, capped so a long
// model paragraph cannot blow out the trace panel.
function assistantRowText(payload) {
  const s = String(payload == null ? '' : payload)
  return s.length > 140 ? `${s.slice(0, 140)}…` : s
}

function foldedGroupLabel(type, count, stage) {
  if (type === 'tool') return stage ? `正在做【${stage}】${count} 步操作` : `正在执行 ${count} 步操作`
  return stage ? `【${stage}】思考过程(${count} 条)` : `思考过程(共 ${count} 条)`
}

function WorkTraceList({ items, steps }) {
  const list = Array.isArray(items) ? items : []
  const [expanded, setExpanded] = useState(false)
  // step_id → stage label (e.g. 代码生成) so folded groups can be titled by the
  // pipeline phase they belong to, instead of a generic "正在执行".
  const stageByStepId = useMemo(() => {
    const m = {}
    for (const s of (Array.isArray(steps) ? steps : [])) {
      if (s && s.id && s.kind) m[s.id] = STAGE_LABELS[s.kind] || String(s.kind)
    }
    return m
  }, [steps])
  if (list.length === 0) return null
  const groups = groupTraceItems(list, stageByStepId)
  return (
    <div className="cw-trace">
      <button
        type="button"
        className="cw-fold-toggle"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className="cw-item-label">执行轨迹 · {list.length} 步</span>
        <span className="cw-fold-hint">{expanded ? '收起' : '展开'}</span>
      </button>
      {expanded ? (
        <ul className="cw-trace-list">
          {groups.map((g, i) => g.kind === 'milestone' ? (
            <li
              key={g.item.id || `${g.item.sequence}` || i}
              className={`cw-trace-item cw-trace-${traceClassFor(g.item.type)}`}
            >
              <span className="cw-trace-icon">{traceIconFor(g.item.type)}</span>
              <span className="cw-trace-text">{traceMilestoneText(g.item)}</span>
            </li>
          ) : (
            <FoldedTraceGroup key={i} type={g.type} rows={g.items} stage={g.stage} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// FoldedTraceGroup is the collapsed "N steps" group for technical traces
// (tool calls / assistant output). Collapsed by default; expand to see each row.
function FoldedTraceGroup({ type, rows, stage }) {
  const [open, setOpen] = useState(false)
  const Icon = type === 'tool' ? <FileCode size={14} /> : <MessageSquare size={14} />
  return (
    <li className={`cw-trace-item cw-trace-info cw-trace-folded${open ? ' open' : ''}`}>
      <button type="button" className="cw-trace-fold-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="cw-trace-icon">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        {Icon}
        <span className="cw-trace-text">{foldedGroupLabel(type, rows.length, stage)}</span>
      </button>
      {open ? (
        <ul className="cw-trace-detail">
          {rows.map((r, idx) => (
            <li key={r.id || idx}>{type === 'tool' ? toolRowText(r.payload) : assistantRowText(r.payload)}</li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

// RollbackControl is the confirm-gated rollback to the prior effective version.
// Destructive → requires an explicit second click after arming.
function RollbackControl({ appId, onRollback, submitting }) {
  const [armed, setArmed] = useState(false)
  const submit = () => {
    if (submitting) return
    if (!armed) {
      setArmed(true)
      return
    }
    onRollback(appId)
    setArmed(false)
  }
  return (
    <button
      type="button"
      className={`cw-rollback${armed ? ' cw-rollback-armed' : ''}`}
      onClick={submit}
      disabled={submitting}
      title={armed ? '再次点击确认回滚到上一版本' : '回滚到上一版本'}
    >
      <RotateCcw size={12} />
      <span>{armed ? '确认回滚' : '回滚'}</span>
    </button>
  )
}

function formatAcceptedAt(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
