// Pure dialogue timeline mapper + event reducer. NO React imports — exercised by
// the node-assert logic harness (scripts/check-dialogue-workbench.mjs) in addition
// to being consumed by useDialogueSessions.js.
//
// Contract: the mapper consumes the composed DialogueView the Task 4 backend
// returns (parent session + parent messages + redacted route + recommendation
// cards + optional child clarification view + business agent draft + resolved
// application/agent/job). It produces SEMANTIC UI items, NOT JSX. It DELIBERATELY
// DROPS unknown/internal metadata keys (any blueprint/internal-slug/thinking
// fields) — the browser never derives trusted catalog or route data.
//
// Security boundary: only the fields explicitly named in this mapper survive into
// a timeline item. Any extra key on a persisted message's metadata_json is
// ignored. Blueprint refs / internal slugs / catalog availability never appear.

import { buildThinkingByStepAttempt, thinkingKey } from './taskThinkingState.js';
import { buildCollaborationExecutionGraphView } from './collaborationExecutionGraphState.js';

export const initialDialogueState = () => ({
  selectedDialogueId: null,
  view: null,
  sessions: [],
  timeline: [],
  questions: [],
  requirement: null,
  // needsRefresh is set to a dialogue id when a targeted SSE update arrives for
  // the selected (or any) dialogue, so the hook can refetch ONE view instead of
  // doing an N+1 full-history refresh per streaming delta.
  needsRefresh: null,
  dialogueActivity: {},
  // liveAnalysis (Task 3, D1/D2): a SINGLE transient item holding the safe
  // analysis work log as it streams token-by-token. It is the live
  // "分析过程" shown beneath the user message BEFORE the round's persisted
  // analysis_work_log lands. Folded from *.delta (route / draft / clarification)
  // and from the in-flight pipeline step (dialogue.work_trace). On the round /
  // step completion the persisted view reconciles and the builder suppresses
  // this transient item (rendering the persisted analysis FOLDED instead).
  //   { key, content, kind } | null
  //   key   — turn id for routing/clarification/draft rounds, 'step:<jobId>:<stepId>' for a pipeline step
  //   kind  — 'round' | 'step'
  //   content — the FULL-so-far safe text (set-not-append, never raw reasoning)
  liveAnalysis: null,
  // liveThinking: a SINGLE transient item holding the model's raw reasoning
  // (thinking_delta) as it streams token-by-token — the live "思考过程" block,
  // parallel to liveAnalysis. Policy: the conversation surface streams the
  // model's thinking (#9 applies to the executor/trace pipeline, not here).
  // Folded from *.thinking (route / draft / clarification). Same shape as
  // liveAnalysis: { key, content, kind } | null.
  liveThinking: null,
})

// statusText maps a dialogue status to user-facing Chinese. It is the ONLY place
// status strings are translated; the workbench imports this (no inline maps).
export function statusText(status) {
  const map = {
    routing: '识别需求中',
    active: '进行中',
    analyzing: '分析中',
    recommending: '推荐智能体中',
    drafting_application: '需求澄清中',
    drafting_business_agent: '配置 Agent 中',
    waiting_user: '等待补充',
    change_confirmation: '变更确认中',
    task_running: '任务执行中',
    resolved: '已完成',
    failed: '已失败',
    abandoned: '已放弃',
    archived: '已归档',
  }
  if (status == null) return ''
  return map[status] || status
}

// titleForDialogue derives a short, human title from a session. It prefers an
// app name in the resolved requirement, then the initial prompt.
export function titleForDialogue(session) {
  if (!session) return '新会话'
  const fromRequirement = session.requirement && session.requirement.appName
  const raw = String(fromRequirement || session.initial_prompt || '新会话').trim()
  if (raw.length <= 32) return raw
  return `${raw.slice(0, 32)}...`
}

export function resolveWorkbenchTitle(view, session) {
  const resolvedApplication = view && view.resolvedApplication
  return (resolvedApplication && (resolvedApplication.name || resolvedApplication.slug)) || titleForDialogue(session)
}

// lockedFromView returns true when the composer's free-text input must be
// non-editable: the route is locked OR confirmation is needed OR the dialogue is
// terminal. When locked the user interacts via the rendered cards/controls, not a
// free textarea.
export function lockedFromView(view) {
  if (!view || !view.session) return false
  const status = view.session.status
  if (status === 'resolved' || status === 'abandoned' || status === 'failed') return true
  const route = view.route
  // Route confirmation needed => the user must pick a route card; no free text.
  if (route && route.needsRouteConfirmation) return true
  // Route locked into an outcome => further free-text would be ignored (backend 409).
  if (view.session.route_locked && view.session.intent !== 'routing') return true
  return false
}

// STEP_STAGE_LABEL mirrors StepCard's STAGE_LABELS so this pure module can name
// a pipeline step without importing the JSX StepCard (which would pull React +
// lucide into the node-assert logic harness). Keep in sync with StepCard.jsx.
const STEP_STAGE_LABEL = {
  requirement_analysis: '需求分析',
  solution_design: '方案设计',
  code_generation: '代码生成',
  test_verification: '测试验证',
  image_build: '镜像构建',
  deployment: '部署',
}

// The statuses a step can be in while it still warrants attention in the
// conversation flow: running, waiting for the user, or failed. Per the plan's
// display policy these blocks render EXPANDED; everything else (succeeded /
// completed / canceled / skipped) renders FOLDED into a summary row.
const STEP_ATTENTION_STATUSES = new Set(['running', 'waiting_user', 'failed'])

// buildTaskBlocks derives one `task_execution_block` timeline descriptor per
// step of the active generation task (Phase 3 §Conversation Task Blocks). Each
// block carries the step's identity (jobId/stepId/attempt/agentKey), a name
// (stage label or agent key), status, the step-level summary (from the
// StepExecutionSummary's latest_record), and the display-policy fold state.
// The running/waiting/failed steps are expanded; terminal steps are folded.
//
// Pure + side-effect-free so the logic harness can assert it directly. The
// block's `safeExecution` field is filled later by buildDialogueTimeline from
// persisted work-trace rows (see below), NOT here — this helper only handles
// persisted step/summary state. Task thinking stays in the existing independent
// live_thinking surface until Phase 4 adds step-attributed thinking events.
export function buildTaskBlocks(steps, summary) {
  const stepList = Array.isArray(steps) ? steps : []
  const summaryList = Array.isArray(summary) ? summary : summary && summary.steps ? summary.steps : []
  const summaryByStepId = {}
  for (const s of summaryList) {
    if (s && s.step_id != null && !summaryByStepId[s.step_id]) summaryByStepId[s.step_id] = s
  }
  return stepList
    .map(step => {
      if (!step || !step.id) return null
      const status = step.status || 'pending'
      const sm = summaryByStepId[step.id]
      const latest = sm && (sm.latest_record || sm.latestRecord)
      const summaryText = latest && (latest.content || latest.text || latest.message) || ''
      const attention = STEP_ATTENTION_STATUSES.has(status)
      const pendingQuestions = safeString(step.pending_questions || step.pendingQuestions)
      return {
        id: `taskblock_${step.job_id || step.jobId || ''}_${step.id}`,
        type: 'task_execution_block',
        stepId: step.id,
        jobId: step.job_id || step.jobId || '',
        attempt: step.attempt || (sm && sm.latest_attempt) || null,
        agentKey: step.agent_key || step.agentKey || '',
        name: STEP_STAGE_LABEL[step.kind] || step.agent_key || step.kind || step.id,
        status,
        summary: safeString(summaryText),
        error: safeString(step.error_message || step.errorMessage),
        needsUserInput: !!(step.needs_user_input || step.needsUserInput),
        pendingQuestions,
        manualConfirmation: isManualStepConfirmation(pendingQuestions),
        startedAt: step.started_at || step.startedAt || '',
        endedAt: step.ended_at || step.endedAt || '',
        // safeExecution is populated by the builder from persisted work-trace
        // rows when the timeline is assembled.
        safeExecution: '',
        folded: !attention,
        expanded: attention,
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      // step.seq captures dependency/execution order; fall back to step id.
      const sa = stepSeq(a.stepId, stepList)
      const sb = stepSeq(b.stepId, stepList)
      if (sa !== sb) return sa - sb
      return a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0
    })
}

function isManualStepConfirmation(raw) {
  if (!raw) return false
  try {
    const items = JSON.parse(raw)
    return Array.isArray(items) && items.some(item => item && item.type === 'manual_step_confirmation' && item.confirm)
  } catch {
    return false
  }
}

// stepSeq looks up a step's seq by id (dependency/execution order). Returns
// Number.MAX_SAFE_INTEGER for unknown ids so they sort last.
function stepSeq(stepId, stepList) {
  for (const s of stepList) {
    if (s && s.id === stepId) return Number.isFinite(s.seq) ? s.seq : Number.MAX_SAFE_INTEGER
  }
  return Number.MAX_SAFE_INTEGER
}

// buildSafeExecutionByStepAttempt reconstructs each step attempt's safe execution
// process from the persisted work-trace stream. Unlike liveStepFromTrace (which
// intentionally returns only the latest in-flight step row), this aggregates ALL
// step-attributed trace rows by stepId+attempt so historical replay can restore
// every block's execution process without mixing retry attempts.
function buildSafeExecutionByStepAttempt(workTraceItems) {
  const grouped = {}
  const list = Array.isArray(workTraceItems) ? workTraceItems.slice() : []
  list
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .forEach(it => {
      if (!it) return
      const stepId = it.stepId || it.step_id || ''
      if (!stepId) return
      const key = safeExecutionKey(stepId, it.attempt)
      const p = it.payload || {}
      const text = p.summary || p.message || p.text || p.description || p.label || ''
      if (!text) return
      if (!grouped[key]) grouped[key] = []
      const value = safeString(text)
      // Consecutive duplicate summaries are common for snapshot/resync overlap;
      // keep the replay readable without changing event order.
      if (grouped[key][grouped[key].length - 1] !== value) grouped[key].push(value)
    })
  const out = {}
  for (const [key, chunks] of Object.entries(grouped)) {
    out[key] = chunks.join('\n')
  }
  return out
}

function safeExecutionKey(stepId, attempt) {
  const normalizedAttempt = Number(attempt)
  return Number.isFinite(normalizedAttempt) && normalizedAttempt > 0
    ? `${stepId}::${normalizedAttempt}`
    : `${stepId}::legacy`
}

// buildDialogueTimeline maps a composed DialogueView to an ordered list of
// semantic UI items. Items are plain objects; the workbench renders them. Every
// item is built from EXPLICITLY NAMED fields so internal keys cannot leak.
//
// The optional `optimisticUserMessage` ({ id, content }) is a transient in-flight
// user message the send path sets SYNCHRONOUSLY (before any network await) so the
// user sees their own message immediately. It is prepended as a user_message item
// UNLESS the reloaded persisted view already contains a user message with identical
// content for this turn — then it is DEDUPED (the persisted message is authoritative).
//
// The optional `liveAnalysis` ({ key, content, kind }) is the Task 3 transient
// streaming analysis item. It is inserted as a `live_analysis` item right after
// the optimistic/persisted user message. It is SUPPRESSED when the persisted view
// already carries an analysis_work_log for the round it represents — on completion
// the persisted analysis (rendered FOLDED) is authoritative (D6).
export function buildDialogueTimeline(view, optimisticUserMessage = null, liveAnalysis = null, liveThinking = null, workTraceItems = [], pendingTurn = null, jobStepBlocks = [], taskThinkingItems = []) {
  const items = []
  const parentMessages = view && Array.isArray(view.messages) ? view.messages : []

  // Determine whether the persisted view already carries a user message with the
  // SAME content as the optimistic one for this turn. If so the optimistic entry
  // is dropped (dedupe) — the persisted message is authoritative on reload.
  let optimisticDropped = false
  if (optimisticUserMessage && optimisticUserMessage.content) {
    const optimisticContent = String(optimisticUserMessage.content).trim()
    const hasMatchingPersisted = parentMessages.some(
      msg => msg && msg.role === 'user' && String(msg.content).trim() === optimisticContent,
    )
    if (hasMatchingPersisted) {
      optimisticDropped = true
    } else {
      items.push({
        id: optimisticUserMessage.id,
        type: 'user_message',
        content: safeString(optimisticUserMessage.content),
        optimistic: true,
      })
    }
  }

  // D5: before the first persisted view lands (first message of a brand-new
  // dialogue, while createDialogue is in flight) surface the optimistic user
  // message PLUS an in-flight "thinking" indicator beneath it, so the workbench
  // never looks frozen during the routing CLI call (which blocks the
  // createDialogue POST; its streaming cannot be attributed to this
  // not-yet-selected dialogue, so it would otherwise be dropped). The moment
  // the view loads, the full thread — with real per-round streaming — takes
  // over. Prefer real streaming if it has already folded into liveAnalysis.
  if (!view) {
    // Idle (no send pending, no view) stays empty.
    if (!optimisticUserMessage && !(liveAnalysis && liveAnalysis.content)) return items
    const la = liveAnalysis && liveAnalysis.content
      ? liveAnalysis
      : { key: 'pending', content: '正在理解你的需求…', kind: 'round' }
    items.push({
      id: `live_${safeString(la.key)}`,
      type: 'live_analysis',
      content: safeString(la.content),
      kind: la.kind === 'step' ? 'step' : 'round',
      pending: !(liveAnalysis && liveAnalysis.content),
    })
    if (liveThinking && liveThinking.content) {
      items.push({
        id: `livethink_${safeString(liveThinking.key)}`,
        type: 'live_thinking',
        content: safeString(liveThinking.content),
        summary: safeString(la.content),
        kind: liveThinking.kind === 'step' ? 'step' : 'round',
      })
    }
    return items
  }

  // Whether the persisted view already carries an analysis work log for this
  // round. When it does, the transient live_analysis is SUPPRESSED (the persisted
  // analysis, rendered FOLDED, is authoritative — D6) so the streaming block does
  // not duplicate the just-landed folded summary.
  const hasPersistedAnalysis = parentMessages.some(
    msg => msg && msg.role === 'agent' && (msg.kind === 'analysis_work_log' || msg.kind === 'model_output'),
  )

  // Task-internal clarification answers are persisted as dialogue user messages
  // (kind=task_clarification_answer) so the answer becomes part of the normal
  // thread, but they render in the task-local context: immediately after the
  // corresponding clarification card. Index them by stepId+attempt here and skip
  // them in the generic parent-thread pass below.
  const taskAnswerByStepAttempt = {}
  for (const msg of parentMessages) {
    if (!msg || msg.role !== 'user' || msg.kind !== 'task_clarification_answer') continue
    const meta = parseJSON(msg.metadata_json) || {}
    const stepId = safeString(meta.stepId || meta.step_id)
    if (!stepId) continue
    const key = safeExecutionKey(stepId, meta.attempt)
    if (!taskAnswerByStepAttempt[key]) taskAnswerByStepAttempt[key] = []
    taskAnswerByStepAttempt[key].push({
      id: msg.id,
      type: 'user_message',
      content: safeString(msg.content),
      taskClarificationAnswer: true,
      taskId: safeString(meta.taskId || meta.task_id),
      stepId,
      attempt: Number(meta.attempt || 0) || 0,
      agentKey: safeString(meta.agentKey || meta.agent_key),
    })
  }

  // 1. Parent thread: user messages + analysis work logs, in persisted order.
  for (const msg of parentMessages) {
    if (!msg || msg.role === 'user') {
      if (msg && msg.role === 'user' && msg.kind !== 'task_clarification_answer') {
        items.push({
          id: msg.id,
          type: 'user_message',
          content: safeString(msg.content),
        })
      }
      continue
    }
    if (msg.role === 'agent' && (msg.kind === 'analysis_work_log' || msg.kind === 'model_output')) {
      // D6: the persisted analysis lands ONLY after the round completes. It
      // renders as a collapsible block above the conclusion (`folded`), default
      // EXPANDED so the reasoning is visible without an extra click; the user
      // can collapse it via the toggle.
      items.push({
        id: msg.id,
        type: 'analysis_stream',
        content: safeString(msg.content),
        folded: true,
        expanded: true,
      })
      continue
    }
    if (msg.role === 'agent' && (msg.kind === 'reply' || msg.kind === 'message')) {
      items.push({
        id: msg.id,
        type: 'agent_message',
        content: safeString(msg.content),
      })
    }
    // Other parent agent kinds (business_draft handled below) are dropped here.
  }

  // NOTE: transient live_thinking / live_analysis items are appended at the
  // TAIL (after child/business surfaces, before resolved_outcome) so streamed
  // content always appears after the latest persisted content — see below.

  // 2. Route choice cards when the intent is ambiguous (needs confirmation).
  const route = view.route
  if (route && route.needsRouteConfirmation && statusIsRouting(view.session)) {
    items.push({
      id: `${view.session.id || 'dlg'}_route`,
      type: 'route_recommendation',
      reason: safeString(route.userFacingReason),
      canReuseExistingApplication: Array.isArray(route.existingApplicationSlugs) && route.existingApplicationSlugs.length > 0,
    })
  }

  // 3. Existing-app recommendation cards (intent locked to existing_application
  //    or pre-lock recommendation present). One primary + <=2 alternatives.
  const recs = Array.isArray(view.recommendations) ? view.recommendations : []
  if (recs.length > 0) {
    items.push({
      id: `${view.session.id || 'dlg'}_apps`,
      type: 'app_recommendation',
      cards: recs.slice(0, 3).map(card => ({
        applicationId: safeString(card.applicationId),
        kind: safeString(card.kind),
        slug: safeString(card.slug),
        name: safeString(card.name),
        appType: safeString(card.appType),
        matchReason: safeString(card.matchReason),
        status: safeString(card.status),
        runtimeUrl: safeString(card.runtimeUrl),
        primary: !!card.primary,
      })),
    })
  }

  // 4. Child clarification (application-generation) surface.
  const child = view.child
  if (child) {
    appendChildItems(items, child, view.session)
  }
  const collaborationPreview = safeCollaborationPlanPreview(view.collaborationPlanPreview)
  if (collaborationPreview) {
    items.push({
      id: `${view.session.id || 'dlg'}_collaboration_plan_preview`,
      type: 'collaboration_plan_preview',
      preview: collaborationPreview,
      graph: buildCollaborationExecutionGraphView(collaborationPreview, jobStepBlocks),
    })
  }
  const suppressTaskBlocksInConversation = !!collaborationPreview

  // 5. Business-agent drafting surface.
  // 5a. Open business-draft clarifying questions (parent agent question messages
  //     after the last user turn) render as an answerable question group — the
  //     business route is locked so these need a dedicated continue path, not the
  //     free-text composer.
  const bizQuestions = openBusinessQuestions(view)
  if (bizQuestions.length > 0) {
    items.push({
      id: `${view.session.id || 'dlg'}_bizquestions`,
      type: 'question_group',
      questions: bizQuestions.map(safeQuestion),
    })
  }
  const bizConsolidation = latestBusinessConsolidation(view)
  if (bizConsolidation && bizConsolidation.length > 0) {
    items.push({
      id: `${view.session.id || 'dlg'}_bizconsolidation`,
      type: 'consolidation_table',
      rows: bizConsolidation.map(safeConsolidationRow),
    })
  }
  // 5b. The in-progress agentDraft card (重新描述 / 确认创建).
  if (view.agentDraft && (view.agentDraft.name || view.agentDraft.prompt)) {
    items.push({
      id: `${view.session.id || 'dlg'}_business`,
      type: 'business_recommendation',
      draft: {
        name: safeString(view.agentDraft.name),
        description: safeString(view.agentDraft.description),
        prompt: safeString(view.agentDraft.prompt),
      },
    })
  }

  // 5b. Job-step clarifications + task blocks. Clarification cards are
  //     collected first (with task/step/attempt/agent attribution preserved), then
  //     inserted immediately after the matching task_execution_block. Orphans
  //     (legacy traces without step provenance) append after the task blocks.
  const taskBlocks = Array.isArray(jobStepBlocks) ? jobStepBlocks : []
  const blockByStepAttempt = new Map()
  const blockByStepId = new Map()
  for (const b of taskBlocks) {
    if (!b || !b.stepId) continue
    blockByStepId.set(b.stepId, b)
    blockByStepAttempt.set(safeExecutionKey(b.stepId, b.attempt), b)
  }
  const clarificationItems = []
  const clarificationsByStepAttempt = {}
  if (Array.isArray(workTraceItems)) {
    const clarifications = workTraceItems
      .filter(it => it && it.type === 'clarification' && it.payload && Array.isArray(it.payload.questions) && it.payload.questions.length > 0)
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    for (const c of clarifications) {
      const seq = c.sequence || 0
      const stepId = safeString(c.stepId || c.step_id)
      const attempt = Number(c.attempt || 0) || 0
      const match = blockByStepAttempt.get(safeExecutionKey(stepId, attempt)) || blockByStepId.get(stepId) || null
      const agentKey = safeString(c.agentKey || c.agent_key || (match && match.agentKey))
      const statusOpen = !!(
        match &&
        match.status === 'waiting_user' &&
        match.stepId === stepId &&
        (!attempt || Number(match.attempt || 0) === attempt)
      )
      const questions = c.payload.questions.map((q, i) => {
        const options = Array.isArray(q.options)
          ? q.options.map(opt => ({
            value: safeString(opt.value || opt.id || opt.label),
            label: safeString(opt.label || opt.value || opt.id),
            recommended: !!opt.recommended,
          })).filter(opt => opt.value || opt.label)
          : []
        return {
          id: safeString(q.id) || `clar_q_${seq}_${i}`,
          // Agents emit the question text under `question` or `text`; honor both
          // so the card never shows an empty prompt.
          question: safeString(q.question || q.text),
          defaultAnswer: safeString(q.defaultAnswer),
          options,
        }
      })
      const answerKey = safeExecutionKey(stepId, attempt)
      const answers = taskAnswerByStepAttempt[answerKey] || []
      const item = {
        id: `clarify_${c.dialogueId || ''}_${seq}_${c.id || ''}`,
        type: 'clarification_prompt',
        taskId: safeString(c.taskId || c.task_id),
        stepId,
        attempt,
        agentKey,
        stepName: safeString(match && match.name) || stepId,
        status: statusOpen ? 'open' : 'answered',
        folded: !statusOpen,
        expanded: statusOpen,
        answers,
        finalAnswer: safeString(answers.map(a => a.content).filter(Boolean).join('；')),
        questions,
      }
      clarificationItems.push(item)
      if (stepId) {
        const key = safeExecutionKey(stepId, attempt)
        if (!clarificationsByStepAttempt[key]) clarificationsByStepAttempt[key] = []
        clarificationsByStepAttempt[key].push(item)
      }
    }
  }

  // 5b2. Task execution blocks (Phase 3 §Conversation Task Blocks): one block
  //      per step of the active generation task, appended near the tail after
  //      the latest persisted content. Safe execution is reconstructed from ALL
  //      persisted work-trace rows grouped by stepId+attempt, so history/replay
  //      restores each step attempt's own execution process (not just the latest
  //      step). The builder clones every input block before enrichment;
  //      jobStepBlocks comes from hook state and must remain immutable/pure.
  let absorbedStepId = null
  const pushedClarificationIds = new Set()
  if (taskBlocks.length > 0 && !suppressTaskBlocksInConversation) {
    const safeExecutionByStepAttempt = buildSafeExecutionByStepAttempt(workTraceItems)
    const thinkingByStepAttempt = buildThinkingByStepAttempt(taskThinkingItems)
    const liveStepId = liveAnalysis && liveAnalysis.kind === 'step' && liveAnalysis.key
      ? String(liveAnalysis.key).split(':').pop()
      : ''
    const knownStepIds = new Set(taskBlocks.map(block => block && block.stepId).filter(Boolean))
    if (liveStepId && knownStepIds.has(liveStepId)) absorbedStepId = liveStepId
    const pushClarifications = key => {
      const list = clarificationsByStepAttempt[key] || []
      for (const item of list) {
        if (pushedClarificationIds.has(item.id)) continue
        items.push(item)
        pushedClarificationIds.add(item.id)
        if (Array.isArray(item.answers)) items.push(...item.answers)
      }
    }
    for (const rawBlock of taskBlocks) {
      if (!rawBlock) continue
      const thinking = thinkingByStepAttempt[thinkingKey(rawBlock.jobId, rawBlock.stepId, rawBlock.attempt)] || null
      const block = {
        ...rawBlock,
        safeExecution: safeExecutionByStepAttempt[safeExecutionKey(rawBlock.stepId, rawBlock.attempt)] ||
          safeExecutionByStepAttempt[safeExecutionKey(rawBlock.stepId, null)] ||
          '',
        taskThinking: thinking ? thinking.content : '',
        taskThinkingRedacted: !!(thinking && thinking.redacted),
      }
      items.push(block)
      pushClarifications(safeExecutionKey(block.stepId, block.attempt))
      pushClarifications(safeExecutionKey(block.stepId, null))
    }
  }
  for (const item of clarificationItems) {
    if (pushedClarificationIds.has(item.id)) continue
    items.push(item)
    pushedClarificationIds.add(item.id)
    if (Array.isArray(item.answers)) items.push(...item.answers)
  }

  // 5c. Transient live items at the TAIL (after all persisted child/business
  //     content, before resolved_outcome / system_status). Streaming content
  //     must appear AFTER the latest persisted content so it sits at the bottom
  //     of the conversation — not above the child history (the prior bug). The
  //     D6 suppression is preserved: once the persisted analysis for the current
  //     turn lands (hasPersistedAnalysis), the transient live_analysis is
  //     suppressed (the folded persisted analysis is authoritative).
  //
  //     When a task execution block absorbed the in-flight step's safe-execution
  //     stream (absorbedStepId set), skip the standalone step-level live_analysis
  //     so it is not duplicated beneath the block. liveThinking currently has only
  //     round-level attribution (applyLiveThinkingEvent writes kind:'round'), so
  //     it stays independent until Phase 4 introduces step-attributed thinking.
  if (liveThinking && liveThinking.content) {
    items.push({
      id: `livethink_${safeString(liveThinking.key)}`,
      type: 'live_thinking',
      content: safeString(liveThinking.content),
      summary: safeString(liveAnalysis && liveAnalysis.content),
      kind: liveThinking.kind === 'step' ? 'step' : 'round',
    })
  }
  if (liveAnalysis && liveAnalysis.content && !hasPersistedAnalysis && !(absorbedStepId && liveAnalysis.kind === 'step')) {
    items.push({
      id: `live_${safeString(liveAnalysis.key)}`,
      type: 'live_analysis',
      content: safeString(liveAnalysis.content),
      kind: liveAnalysis.kind === 'step' ? 'step' : 'round',
    })
  }

  // 5d. Pending "thinking" placeholder. When a turn is in flight (pendingTurn
  //     truthy) but no live thinking/analysis has streamed yet, append a
  //     pending live_thinking item so the workbench never looks frozen between
  //     send and the first delta. Naturally replaced once real content arrives.
  if (pendingTurn && !(liveThinking && liveThinking.content) && !(liveAnalysis && liveAnalysis.content)) {
    items.push({
      id: 'cw_pending_thinking',
      type: 'live_thinking',
      content: '正在思考…',
      summary: '',
      pending: true,
      kind: 'round',
    })
  }

  // 6. Resolved outcome (application / agent / seeded job).
  appendResolvedOutcome(items, view)

  // 7. System status for terminal non-resolved states.
  const status = view.session && view.session.status
  if (status === 'failed' || status === 'abandoned') {
    items.push({
      id: `${view.session.id || 'dlg'}_${status}`,
      type: 'system_status',
      status,
    })
  }

  return items
}

// openQuestionsForView returns the questions currently awaiting an answer for a
// composed view, so the hook can populate the answer bar's `questions` prop
// (which ConversationWorkbench's 提交本轮澄清 control depends on). For an
// application-generation view it derives the open CHILD questions; for a
// business-agent drafting view it derives the open PARENT (business-draft)
// questions. Exported (pure) so the logic harness can assert it directly — the
// prior bug was loadView setting `timeline` but never `questions`, so the answer
// bar never rendered and round 1 stalled.
export function openQuestionsForView(view) {
  const sess = view && view.session
  if (sess && (sess.intent === 'business_processing_agent' || sess.status === 'drafting_business_agent')) {
    return openBusinessQuestions(view).map(safeQuestion)
  }
  const child = view && view.child
  if (!child) return []
  const childMessages = Array.isArray(child.messages) ? child.messages : []
  return openChildQuestions(child, childMessages).map(safeQuestion)
}

// openBusinessQuestions returns the business-draft questions currently awaiting
// an answer: parent agent question messages emitted AFTER the last user turn,
// while the dialogue is still drafting the business agent. Mirrors openChildQuestions
// over the parent thread.
function openBusinessQuestions(view) {
  const sess = view && view.session
  if (!sess) return []
  if (sess.status === 'resolved' || sess.status === 'abandoned' || sess.status === 'failed') return []
  const msgs = Array.isArray(view.messages) ? view.messages : []
  const lastUserIndex = findLastIndex(msgs, m => m && m.role === 'user')
  const out = []
  const seen = new Set()
  for (const msg of msgs.slice(lastUserIndex + 1)) {
    if (!msg || msg.role !== 'agent' || msg.kind !== 'question' || !msg.metadata_json) continue
    const q = parseJSON(msg.metadata_json)
    if (q && q.id && !seen.has(q.id)) {
      out.push(q)
      seen.add(q.id)
    }
  }
  return out
}

function latestBusinessConsolidation(view) {
  const explicit = Array.isArray(view && view.agentConsolidation) ? view.agentConsolidation : []
  if (explicit.length > 0) return explicit
  const msgs = Array.isArray(view && view.messages) ? view.messages : []
  const lastUserIndex = findLastIndex(msgs, m => m && m.role === 'user')
  return latestConsolidation(msgs.slice(lastUserIndex + 1))
}

// appendChildItems maps the child clarification view (parent's child field) into
// question groups, a round-5 consolidation table, and a requirement summary. It
// reads child.messages (the persisted child thread) and child.requirement.
function appendChildItems(items, child, parentSession) {
  const childMessages = Array.isArray(child.messages) ? child.messages : []
  // Walk the child clarification thread CHRONOLOGICALLY and emit, in order:
  //   - each round's analysis_work_log entries as ONE folded 分析过程 · 第N轮
  //     block, flushed when a question or a user answer arrives so the thinking
  //     sits above the question / the user's reply. The application-generation
  //     flow persists its analysis here (not in the parent); one block per entry
  //     was too noisy (~10 for a 3-round dialogue), so each round folds together.
  //     Default EXPANDED so the reasoning is visible without an extra click.
  //   - the user's clarification answer as a user_message, rendered with the
  //     SELECTED OPTION LABEL (looked up from the preceding question) instead of
  //     the raw value slug — so the reply reads e.g. "主要使用角色：图书工作人员".
  // Only the safe analysis_work_log / model_output kinds are emitted — never raw
  // reasoning (security #9). A user answer (not the initial prompt) starts a new
  // round.
  let round = 1
  let bucket = null // { round, entries: [] }
  let prevWasUser = false // true while inside a batch of consecutive user answers
  // questionsById accumulates EVERY question seen (id -> parsed metadata). A
  // round can ask several high-impact questions at once, and the user answers
  // them in one batch; each answer is resolved against the question its OWN
  // metadata_json.questionId names — not a single "last question", which would
  // mislabel every answer after the first in a batch.
  const questionsById = {}
  let pendingThinking = null
  const flushPendingThinking = () => {
    if (!pendingThinking) return
    items.push({
      id: pendingThinking.id || `${parentSession.id || 'dlg'}_thinking_round_${pendingThinking.round}`,
      type: 'thinking_summary',
      content: pendingThinking.content,
      summary: '',
      label: `思考摘要 · 第${pendingThinking.round}轮`,
    })
    pendingThinking = null
  }
  const flushAnalysis = () => {
    flushPendingThinking()
    if (bucket && bucket.entries.length > 0) {
      items.push({
        id: `${parentSession.id || 'dlg'}_analysis_round_${bucket.round}`,
        type: 'analysis_stream',
        content: bucket.entries.join('\n\n'),
        folded: true,
        expanded: true,
        label: `分析过程 · 第${bucket.round}轮`,
      })
    }
    bucket = null
  }
  for (const msg of childMessages) {
    if (msg && msg.role === 'agent' && msg.kind === 'thinking') {
      pendingThinking = { id: msg.id, content: safeString(msg.content), round }
      prevWasUser = false
      continue
    }
    if (msg && msg.role === 'agent' && (msg.kind === 'analysis_work_log' || msg.kind === 'model_output')) {
      if (msg.content) {
        const analysis = safeString(msg.content)
        if (pendingThinking) {
          items.push({
            id: pendingThinking.id || `${parentSession.id || 'dlg'}_thinking_round_${pendingThinking.round}`,
            type: 'thinking_summary',
            content: pendingThinking.content,
            summary: analysis,
            label: `思考摘要 · 第${pendingThinking.round}轮`,
          })
          pendingThinking = null
        }
        if (!bucket) bucket = { round, entries: [] }
        bucket.entries.push(analysis)
      }
      prevWasUser = false
      continue
    }
    if (msg && msg.role === 'agent' && msg.kind === 'question') {
      flushAnalysis()
      const q = parseJSON(msg.metadata_json)
      if (q && q.id) questionsById[q.id] = q
      prevWasUser = false
      continue
    }
    if (msg && msg.role === 'user' && msg.kind !== 'prompt') {
      // A user turn may carry MULTIPLE answers (one batched question group);
      // only the FIRST answer of the batch flushes the round's analysis and
      // advances the round counter, so N batched answers inflate it by 1, not N.
      if (!prevWasUser) {
        flushAnalysis()
        round += 1
      }
      items.push({
        id: msg.id || `${parentSession.id || 'dlg'}_answer_${round}`,
        type: 'user_message',
        content: clarifyAnswerLabel(msg, questionsById),
      })
      prevWasUser = true
      continue
    }
  }
  flushAnalysis()
  // Question groups: the latest unanswered question set after the last user
  // answer. One group with all open questions.
  const openQuestions = openChildQuestions(child, childMessages)
  if (openQuestions.length > 0) {
    items.push({
      id: `${parentSession.id || 'dlg'}_questions`,
      type: 'question_group',
      questions: openQuestions.map(safeQuestion),
    })
  }
  // Round-5 consolidation table (recommendation_consolidation message present).
  const consolidation = latestConsolidation(childMessages)
  if (consolidation && consolidation.length > 0) {
    items.push({
      id: `${parentSession.id || 'dlg'}_consolidation`,
      type: 'consolidation_table',
      rows: consolidation.map(safeConsolidationRow),
    })
  }
  // Requirement summary when the child has a populated requirement.
  const req = child.requirement
  if (req && (req.appType || req.appName || req.coreScenario)) {
    items.push({
      id: `${parentSession.id || 'dlg'}_requirement`,
      type: 'requirement_summary',
      requirement: safeRequirement(req),
    })
  }
}

// clarifyAnswerLabel renders a clarification answer as the user's reply, mapping
// the persisted option VALUE to its human label via the question the answer
// names. Each answer message carries metadata_json {questionId, value}; the
// question is looked up in questionsById (accumulated from the thread) so a
// BATCH of answers resolves each against its own question — not a single shared
// one. Reads e.g. value "librarian_manage" → "主要使用角色：图书工作人员（管理端）".
// Falls back to the raw value when no question/options match.
function clarifyAnswerLabel(msg, questionsById) {
  const meta = parseJSON(msg && msg.metadata_json)
  const qid = meta && meta.questionId
  const value = meta && meta.value != null ? meta.value : safeString(msg && msg.content)
  const raw = safeString(value)
  const q = qid ? questionsById[qid] : null
  if (!q) return raw
  const qLabel = safeString(q.label || q.question)
  const opts = Array.isArray(q.options) ? q.options : []
  const selectedValues = parseAnswerValues(value)
  const optLabel = selectedValues.map(selected => {
    const opt = opts.find(o => o && safeString(o.value) === selected)
    return opt ? safeString(opt.label || opt.value) : selected
  }).filter(Boolean).join('、') || raw
  return qLabel ? `${qLabel}：${optLabel}` : optLabel
}

// openChildQuestions returns the questions currently awaiting an answer, mirroring
// the legacy questionsFromMessages logic: questions after the last user answer,
// while the child status accepts answers.
function openChildQuestions(child, childMessages) {
  const status = child.status
  if (status === 'ready_to_confirm' || status === 'confirmed' || status === 'abandoned' || status === 'failed') return []
  const lastUserIndex = findLastIndex(childMessages, m => m && m.role === 'user')
  const out = []
  const seen = new Set()
  for (const msg of childMessages.slice(lastUserIndex + 1)) {
    if (!msg || msg.role !== 'agent' || msg.kind !== 'question' || !msg.metadata_json) continue
    const q = parseJSON(msg.metadata_json)
    if (q && q.id && !seen.has(q.id)) {
      out.push(q)
      seen.add(q.id)
    }
  }
  return out
}

function latestConsolidation(childMessages) {
  for (let i = childMessages.length - 1; i >= 0; i -= 1) {
    const m = childMessages[i]
    if (m && m.kind === 'recommendation_consolidation' && m.metadata_json) {
      const parsed = parseJSON(m.metadata_json)
      if (Array.isArray(parsed)) return parsed
    }
  }
  return null
}

// appendResolvedOutcome emits a resolved_outcome item for a resolved dialogue,
// classifying it by which linked result is present.
function appendResolvedOutcome(items, view) {
  const status = view.session && view.session.status
  if (status !== 'resolved') return
  let kind = 'application'
  let label = ''
  if (view.resolvedApplication) {
    kind = 'application'
    label = view.resolvedApplication.name || view.resolvedApplication.slug || '应用已就绪'
  } else if (view.createdAgent) {
    kind = 'agent'
    label = view.createdAgent.name || 'Agent 已创建'
  } else if (view.seededJob) {
    kind = 'job'
    label = view.seededJob.app_name ? `生成任务：${view.seededJob.app_name}` : '生成任务已创建'
  } else {
    kind = 'application'
    label = '已完成'
  }
  items.push({
    id: `${view.session.id || 'dlg'}_resolved`,
    type: 'resolved_outcome',
    kind,
    label,
  })
}

// ---- safe field mappers (drop unknown/internal keys) -----------------------

function safeString(value) {
  if (value == null) return ''
  return String(value)
}

function safeQuestion(q) {
  if (!q) return null
  return {
    id: safeString(q.id),
    label: safeString(q.label || q.question),
    multiSelect: !!q.multiSelect,
    allowCustom: !!q.allowCustom,
    options: Array.isArray(q.options)
      ? q.options.map(opt => ({
          value: safeString(opt.value),
          label: safeString(opt.label || opt.value),
          reason: safeString(opt.reason),
          recommended: !!opt.recommended,
        }))
      : [],
    recommendation: normalizeRecommendation(q.recommendation),
  }
}

function normalizeRecommendation(rec) {
  if (rec == null) return []
  return Array.isArray(rec) ? rec.map(safeString) : [safeString(rec)]
}

function safeConsolidationRow(entry) {
  if (!entry) return null
  return {
    field: safeString(entry.field),
    recommendedValue: entry.recommendedValue != null ? entry.recommendedValue : '',
    reason: safeString(entry.reason),
    alternatives: Array.isArray(entry.alternatives) ? entry.alternatives.map(safeString) : [],
  }
}

function safeRequirement(req) {
  if (!req) return null
  // Explicitly named fields ONLY. blueprintRefs / generationProfile / any future
  // internal field is dropped — it must never reach the UI.
  return {
    appType: safeString(req.appType),
    appName: safeString(req.appName),
    coreScenario: safeString(req.coreScenario),
    primaryView: safeString(req.primaryView),
    dataPolicy: safeString(req.dataPolicy),
    judgementBoundary: safeJudgementBoundary(req.judgementBoundary),
  }
}

function safeJudgementBoundary(boundary) {
  if (!boundary || typeof boundary !== 'object') return null
  const dataSources = Array.isArray(boundary.dataSources)
    ? boundary.dataSources.map(safeString).filter(Boolean)
    : []
  const summary = safeString(boundary.summary).trim()
  if (dataSources.length === 0 && !summary) return null
  return { dataSources, summary }
}

// ---- SSE event reducer -----------------------------------------------------

// applyDialogueEvent folds one dialogue.* (or wrapped clarification.*) SSE event
// into state. It NEVER does an N+1 full-history refresh: for the selected
// dialogue it either folds a LIVE delta incrementally into liveAnalysis (Task 3)
// or sets needsRefresh=<id> for completion/lifecycle events so the hook refetches
// ONE view; for other dialogues it records lightweight activity. Returns NEW
// state (immutable).
export function applyDialogueEvent(state, type, ev) {
  const dialogueId = ev && (ev.dialogue_id || ev.dialogueId || (ev.data && (ev.data.dialogue_id || ev.data.dialogueId)))
  if (!dialogueId) return state
  if (type === 'dialogue.deleted') {
    return applyDeletedEvent(state, dialogueId)
  }
  // The selected dialogue gets special handling.
  if (state.selectedDialogueId && dialogueId === state.selectedDialogueId) {
    // Task 3 (D1/D2): a *.delta event carries the FULL-so-far safe analysis text
    // and folds incrementally into the single transient liveAnalysis item. It
    // does NOT set needsRefresh — that was the old per-token full-reload path.
    if (LIVE_DELTA_EVENTS.has(type)) {
      return applyLiveAnalysisEvent(state, type, ev)
    }
    // A *.thinking event carries the model's raw reasoning (FULL-so-far) and
    // folds into the parallel liveThinking "思考过程" item. Also does not reload.
    if (LIVE_THINKING_EVENTS.has(type)) {
      return applyLiveThinkingEvent(state, type, ev)
    }
    // All other events (lifecycle, completion, route confirmation, ready_to_confirm,
    // clarification.updated — anything that changes PERSISTED structure) flag a
    // targeted refresh so the authoritative persisted view reconciles and REPLACES
    // the live item (D6 fold-on-completion).
    return { ...state, needsRefresh: dialogueId }
  }
  const isActivityOnly = ACTIVITY_ONLY_EVENTS.has(type)
  if (isActivityOnly) {
    return {
      ...state,
      dialogueActivity: {
        ...state.dialogueActivity,
        [dialogueId]: { status: 'updated', lastType: type },
      },
    }
  }
  // Non-activity events for an unselected dialogue still mark it dirty so the
  // history list can refresh on next open, but do not trigger a targeted refresh.
  return {
    ...state,
    dialogueActivity: {
      ...state.dialogueActivity,
      [dialogueId]: { status: 'updated', lastType: type },
    },
  }
}

// LIVE_DELTA_EVENTS are the dialogue.* event types whose payload is the streaming
// safe analysis work log (the FULL-so-far text). They fold incrementally into
// liveAnalysis instead of triggering a per-token full view reload.
const LIVE_DELTA_EVENTS = new Set([
  'dialogue.route.delta',
  'dialogue.draft.delta',
  // The dialogue flow mirrors each child clarification work-log delta as a
  // dialogue-attributed event (D2 — clarification must stream live in the
  // application-generation flow). The bare clarification.message.delta is NOT
  // listed here: it is never routed into applyDialogueEvent by the dispatcher
  // (it is not a dialogue.* type), and the legacy standalone clarification
  // surface folds it via clarificationLogic.js, not this timeline.
  'dialogue.clarification.delta',
])

// LIVE_THINKING_EVENTS are the parallel raw-reasoning stream (the model's
// thinking_delta, FULL-so-far). They fold into liveThinking — the live
// "思考过程" block — instead of liveAnalysis. Policy: the conversation surface
// streams the model's thinking; #9 still applies to the executor/trace pipeline
// (a different surface), not to this conversation timeline.
const LIVE_THINKING_EVENTS = new Set([
  'dialogue.route.thinking',
  'dialogue.draft.thinking',
  'dialogue.clarification.thinking',
])

// applyLiveAnalysisEvent folds ONE *.delta event into state.liveAnalysis. The
// delta payload carries the FULL current text (set-not-append, mirroring
// clarificationLogic.js). It is keyed by the running turn so a new turn replaces
// the prior live block.
export function applyLiveAnalysisEvent(state, type, ev) {
  if (!ev) return state
  const turnId = ev.turn_id || ev.turnId || ev.message_id || ev.messageId || 'turn'
  const key = `turn:${turnId}`
  const content = ev.delta != null ? String(ev.delta) : ''
  if (!content) return state
  return {
    ...state,
    liveAnalysis: { key, content, kind: 'round' },
  }
}

// applyLiveThinkingEvent folds ONE *.thinking event into state.liveThinking —
// the live "思考过程" block, parallel to applyLiveAnalysisEvent. Same set-not-
// append, turn-keyed shape.
export function applyLiveThinkingEvent(state, type, ev) {
  if (!ev) return state
  const turnId = ev.turn_id || ev.turnId || ev.message_id || ev.messageId || 'turn'
  const key = `thinking:${turnId}`
  const content = ev.delta != null ? String(ev.delta) : ''
  if (!content) return state
  return {
    ...state,
    liveThinking: { key, content, kind: 'round' },
  }
}

// foldTraceIntoLiveAnalysis merges a step-derived live item (produced by
// workTraceState.liveStepFromTrace) into state.liveAnalysis. A new step key
// replaces the prior block; the same step key updates content in place. Used by
// the hook to surface the in-flight pipeline step's safe text in the same live
// surface (D2 — pipeline steps stream through this path too).
export function foldTraceIntoLiveAnalysis(state, stepLive) {
  if (!stepLive || !stepLive.content) return state
  const existing = state.liveAnalysis
  // A round delta always wins over a step (a round is the broader context).
  if (existing && existing.kind === 'round') return state
  return {
    ...state,
    liveAnalysis: { key: stepLive.key, content: stepLive.content, kind: 'step' },
  }
}

// Events that only nudge the history list (no need to interrupt the current view
// beyond a refresh if it happens to be the selected one). Used to distinguish a
// background status change from a foreground content update.
const ACTIVITY_ONLY_EVENTS = new Set([
  'dialogue.created',
])

function applyDeletedEvent(state, dialogueId) {
  const sessions = (state.sessions || []).filter(s => s.session && s.session.id !== dialogueId)
  const dialogueActivity = { ...state.dialogueActivity }
  delete dialogueActivity[dialogueId]
  if (state.selectedDialogueId === dialogueId) {
    return {
      ...initialDialogueState(),
      sessions,
      dialogueActivity,
    }
  }
  return { ...state, sessions, dialogueActivity }
}

// ---- helpers ---------------------------------------------------------------

function statusIsRouting(session) {
  if (!session) return false
  return session.status === 'routing' && !session.route_locked
}

function findLastIndex(arr, predicate) {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (predicate(arr[i])) return i
  }
  return -1
}

function safeCollaborationPlanPreview(preview) {
  if (!preview || typeof preview !== 'object') return null
  const agents = Array.isArray(preview.agents) ? preview.agents : []
  if (agents.length === 0) return null
  return {
    schemaVersion: Number(preview.schemaVersion || preview.schema_version || 0) || 0,
    mode: safeString(preview.mode),
    lanes: Array.isArray(preview.lanes) ? preview.lanes.map(lane => ({
      id: safeString(lane.id),
      label: safeString(lane.label || lane.name || lane.id),
    })).filter(lane => lane.id) : [],
    agents: agents.map(agent => ({
      key: safeString(agent.key),
      name: safeString(agent.name || agent.key),
      role: safeString(agent.role || agent.key),
      lane: safeString(agent.lane),
      highImpact: !!(agent.highImpact || agent.high_impact),
    })).filter(agent => agent.key || agent.name),
    edges: Array.isArray(preview.edges) ? preview.edges.map(edge => ({
      from: safeString(edge.from),
      to: safeString(edge.to),
    })).filter(edge => edge.from && edge.to) : [],
    adjustments: Array.isArray(preview.adjustments)
      ? preview.adjustments.map(safeCollaborationAdjustment)
      : Array.isArray(preview.highImpactWarnings)
        ? preview.highImpactWarnings.map(safeCollaborationAdjustment)
        : [],
  }
}

function safeCollaborationAdjustment(adjustment) {
  return {
    agentKey: safeString(adjustment && (adjustment.agentKey || adjustment.agent_key)),
    action: safeString(adjustment && adjustment.action),
    message: safeString(adjustment && adjustment.message),
  }
}

function parseJSON(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseAnswerValues(value) {
  if (Array.isArray(value)) return value.map(safeString).filter(Boolean)
  const raw = safeString(value)
  const parsed = parseJSON(raw)
  if (Array.isArray(parsed)) return parsed.map(safeString).filter(Boolean)
  if (parsed != null && typeof parsed !== 'object') return [safeString(parsed)]
  return raw ? [raw] : []
}
