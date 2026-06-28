// Task-thinking state reducer (Phase 4 Task 4).
// Pure functions only — no React hooks, no side effects.
// Handles normalization, ordering, deduplication, and grouping
// of task-thinking events streamed via the dedicated SSE endpoint.

export function initialTaskThinkingState(selectedDialogueId = null) {
  return {
    selectedDialogueId,
    highestSequence: 0,
    items: [],
  }
}

export function resetTaskThinkingState(selectedDialogueId) {
  return initialTaskThinkingState(selectedDialogueId)
}

export function normalizeTaskThinkingEvent(raw) {
  if (!raw || typeof raw !== 'object') return null

  const dialogueId = raw.dialogueId || raw.dialogue_id
  const dialogueSequence = Number(raw.dialogueSequence ?? raw.dialogue_sequence)

  if (!dialogueId || !Number.isFinite(dialogueSequence)) return null

  return {
    id: raw.id || `${dialogueId}:${dialogueSequence}`,
    dialogueId: String(dialogueId),
    taskId: raw.taskId || raw.task_id || '',
    stepId: raw.stepId || raw.step_id || '',
    attempt: Number(raw.attempt || 0) || 0,
    agentKey: raw.agentKey || raw.agent_key || '',
    dialogueSequence,
    stepSequence: Number(raw.stepSequence ?? raw.step_sequence) || 0,
    content: String(raw.content || ''),
    redacted: !!raw.redacted,
    createdAt: raw.createdAt || raw.created_at || '',
  }
}

export function applyTaskThinkingEvent(state, event) {
  const ev = normalizeTaskThinkingEvent(event)
  if (!ev) return state

  // Isolation: only accept events for the selected dialogue
  if (state.selectedDialogueId && ev.dialogueId !== state.selectedDialogueId) {
    return state
  }

  // Deduplication: skip events with already-seen dialogueSequence
  if ((state.items || []).some(item => item.dialogueSequence === ev.dialogueSequence)) {
    // Still track the highest sequence for reconnection
    return {
      ...state,
      highestSequence: Math.max(state.highestSequence || 0, ev.dialogueSequence),
    }
  }

  // Ordering: insert and sort by dialogueSequence ascending
  const items = [...(state.items || []), ev].sort((a, b) => a.dialogueSequence - b.dialogueSequence)

  return {
    ...state,
    highestSequence: Math.max(state.highestSequence || 0, ev.dialogueSequence),
    items,
  }
}

export function applyTaskThinkingEvents(state, events) {
  return (Array.isArray(events) ? events : []).reduce(applyTaskThinkingEvent, state)
}

export function thinkingKey(taskId, stepId, attempt) {
  return `${taskId || ''}::${stepId || ''}::${Number(attempt || 0) || 0}`
}

export function buildThinkingByStepAttempt(items) {
  const grouped = {}

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.stepId) continue

    const key = thinkingKey(item.taskId, item.stepId, item.attempt)

    if (!grouped[key]) {
      grouped[key] = {
        content: '',
        redacted: false,
        agentKey: item.agentKey || '',
      }
    }

    grouped[key].content += item.content || ''
    grouped[key].redacted = grouped[key].redacted || !!item.redacted
    if (!grouped[key].agentKey && item.agentKey) {
      grouped[key].agentKey = item.agentKey
    }
  }

  return grouped
}
