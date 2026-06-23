export const initialConversationState = () => ({
  selectedSessionId: null,
  session: null,
  sessions: [],
  timeline: [],
  questions: [],
  requirement: null,
  blueprints: [],
  sessionActivity: {},
})

export function titleForSession(session) {
  const fromRequirement = session && session.requirement && session.requirement.appName
  const raw = String(fromRequirement || (session && session.initial_prompt) || '新会话').trim()
  if (raw.length <= 32) return raw
  return `${raw.slice(0, 32)}...`
}

export function buildTimelineFromMessages(messages = [], session = null) {
  const items = []
  for (const msg of messages || []) {
    if (msg.role === 'user') {
      items.push({
        id: msg.id,
        type: 'user_message',
        role: 'user',
        kind: msg.kind,
        content: msg.content || '',
        metadata: parseJSON(msg.metadata_json),
      })
      continue
    }
    if (msg.role === 'agent' && (msg.kind === 'analysis_work_log' || msg.kind === 'model_output')) {
      items.push({
        id: msg.id,
        type: 'analysis_stream',
        role: 'agent',
        kind: msg.kind,
        content: msg.content || '',
      })
      continue
    }
    if (msg.role === 'agent' && msg.kind === 'question') {
      const question = parseJSON(msg.metadata_json)
      if (question && question.id) {
        items.push({
          id: msg.id,
          type: 'question_group',
          questions: [question],
        })
      }
      continue
    }
    if (msg.role === 'agent' && msg.kind === 'agent_draft') {
      const draft = parseJSON(msg.metadata_json)
      if (draft) {
        items.push({
          id: msg.id,
          type: 'agent_draft',
          draft,
        })
      }
      continue
    }
  }
  const requirement = session && session.requirement
  const blueprints = blueprintsFromRequirement(requirement)
  if (blueprints.length > 0) {
    items.push({ id: `${session.id || 'draft'}_blueprints`, type: 'blueprint_recommendation', blueprints })
  }
  if (requirement && (requirement.appName || requirement.appType || requirement.coreScenario)) {
    items.push({ id: `${session.id || 'draft'}_requirement`, type: 'requirement_summary', requirement })
  }
  return items
}

export function applyConversationEvent(state, type, ev) {
  const sessionId = ev && ev.session_id
  if (!sessionId) return state
  if (state.selectedSessionId && sessionId !== state.selectedSessionId) {
    return {
      ...state,
      sessionActivity: {
        ...state.sessionActivity,
        [sessionId]: { status: 'updated', lastType: type },
      },
    }
  }
  switch (type) {
    case 'clarification.message.started':
    case 'clarification.message.delta':
    case 'clarification.message.completed':
      return upsertAnalysisEvent(state, ev)
    case 'clarification.question.created':
      return appendQuestionEvent(state, ev)
    case 'clarification.summary.updated':
    case 'clarification.ready_to_confirm':
      return applyRequirementEvent(state, type, ev)
    case 'clarification.blueprint.recommended':
      return applyBlueprintEvent(state, ev)
    case 'clarification.confirmed':
    case 'clarification.failed':
    case 'clarification.abandoned':
      return applyStatusEvent(state, type, ev)
    case 'agent_authoring.draft.updated':
      return applyAgentDraftEvent(state, ev)
    default:
      return state
  }
}

export function questionsFromMessages(messages, status) {
  if (status === 'ready_to_confirm' || status === 'confirmed' || status === 'abandoned' || status === 'failed') return []
  const lastUserIndex = findLastUserMessageIndex(messages)
  const out = []
  const seen = new Set()
  for (const msg of (messages || []).slice(lastUserIndex + 1)) {
    if (msg.role !== 'agent' || msg.kind !== 'question' || !msg.metadata_json) continue
    try {
      const q = JSON.parse(msg.metadata_json)
      if (q && q.id && !seen.has(q.id)) {
        out.push(q)
        seen.add(q.id)
      }
    } catch {
      // Ignore malformed historical question metadata.
    }
  }
  return out
}

function upsertAnalysisEvent(state, ev) {
  const id = ev.message_id || `analysis_${state.timeline.length + 1}`
  const content =
    ev.delta != null
      ? ev.delta
      : ev.data && typeof ev.data.content === 'string'
        ? ev.data.content
        : ''
  const existing = state.timeline.findIndex(item => item.id === id)
  const item = { id, type: 'analysis_stream', role: 'agent', kind: 'analysis_work_log', content }
  if (existing === -1) return { ...state, timeline: [...state.timeline, item] }
  const next = state.timeline.slice()
  next[existing] = { ...next[existing], ...item }
  return { ...state, timeline: next }
}

function appendQuestionEvent(state, ev) {
  const q = ev.data
  if (!q || !q.id || state.questions.some(item => item.id === q.id)) return state
  const questions = [...state.questions, q]
  const withoutCurrentGroup = state.timeline.filter(item => item.type !== 'question_group' || item.live !== true)
  return {
    ...state,
    questions,
    timeline: [...withoutCurrentGroup, { id: `${ev.session_id}_questions_live`, type: 'question_group', live: true, questions }],
  }
}

function applyRequirementEvent(state, type, ev) {
  const requirement = ev.data || null
  const timeline = state.timeline.filter(item => item.type !== 'requirement_summary' || item.live !== true)
  return {
    ...state,
    requirement,
    questions: typeClearsQuestions(type) ? [] : state.questions,
    timeline: requirement ? [...timeline, { id: `${ev.session_id}_requirement_live`, type: 'requirement_summary', live: true, requirement }] : timeline,
  }
}

function applyBlueprintEvent(state, ev) {
  const blueprints = Array.isArray(ev.data) ? ev.data : ev.data ? [ev.data] : []
  const timeline = state.timeline.filter(item => item.type !== 'blueprint_recommendation' || item.live !== true)
  return {
    ...state,
    blueprints,
    timeline: blueprints.length > 0
      ? [...timeline, { id: `${ev.session_id}_blueprints_live`, type: 'blueprint_recommendation', live: true, blueprints }]
      : timeline,
  }
}

function applyStatusEvent(state, type, ev) {
  const status = type.replace('clarification.', '')
  const session = state.session ? { ...state.session, status } : state.session
  return {
    ...state,
    session,
    timeline: [...state.timeline, { id: `${ev.session_id}_${type}`, type: 'system_status', status, data: ev.data || null }],
  }
}

function blueprintsFromRequirement(requirement) {
  const refs = requirement && Array.isArray(requirement.blueprintRefs) ? requirement.blueprintRefs : []
  return refs.map((ref, i) => {
    if (ref && typeof ref === 'object') return ref
    return { id: String(ref || `blueprint_${i}`), name: String(ref || `blueprint_${i}`) }
  }).filter(bp => bp.id || bp.name)
}

function findLastUserMessageIndex(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return i
  }
  return -1
}

function typeClearsQuestions(type) {
  return type === 'clarification.ready_to_confirm'
}

function applyAgentDraftEvent(state, ev) {
  const draft = ev && ev.data
  if (!draft || !draft.name) return state
  // Replace or append the latest agent_draft in the timeline.
  // Use a stable id based on session so only the latest draft shows.
  const draftId = `${ev.session_id || 'draft'}_agent_draft_live`
  const existing = state.timeline.findIndex(item => item.id === draftId)
  const item = { id: draftId, type: 'agent_draft', draft, live: true }
  if (existing === -1) {
    return { ...state, timeline: [...state.timeline, item] }
  }
  const next = state.timeline.slice()
  next[existing] = item
  return { ...state, timeline: next }
}

function parseJSON(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
