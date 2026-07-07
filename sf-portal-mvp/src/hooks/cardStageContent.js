function stepIdsForCard(card) {
  return new Set((card && Array.isArray(card.steps) ? card.steps : [])
    .map(step => step && (step.id || step.stepId || step.step_id))
    .filter(Boolean)
    .map(String))
}

function stepKeysForCard(card) {
  return (card && Array.isArray(card.steps) ? card.steps : [])
    .map(step => {
      if (!step) return null
      const stepId = String(step.id || step.stepId || step.step_id || '')
      if (!stepId) return null
      const taskId = String(step.jobId || step.job_id || step.taskId || step.task_id || '')
      const attempt = Number(step.attempt || 0) || 0
      return { stepId, taskId, attempt }
    })
    .filter(Boolean)
}

function timelineBlocksForCard(card, timeline) {
  const ids = stepIdsForCard(card)
  if (!ids.size) return []
  return (Array.isArray(timeline) ? timeline : []).filter(item =>
    item && item.type === 'task_execution_block' && ids.has(String(item.stepId || item.step_id || '')),
  )
}

function traceText(item) {
  const payload = normalizePayload(item && (item.payload || item.payload_json || item.payloadJSON))
  return String(
    payload.summary ||
    payload.message ||
    payload.text ||
    payload.description ||
    payload.label ||
    '',
  ).trim()
}

function normalizePayload(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function uniqueJoin(values) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.join('\n')
}

function sameAttempt(expected, actual) {
  const a = Number(expected || 0) || 0
  const b = Number(actual || 0) || 0
  return a === 0 || b === 0 || a === b
}

export function deriveCardAnalysisLog({ card, timeline, workTraceItems } = {}) {
  const fromTimeline = timelineBlocksForCard(card, timeline)
    .map(item => item.safeExecution)
  const timelineText = uniqueJoin(fromTimeline)
  if (timelineText) return timelineText

  const ids = stepIdsForCard(card)
  if (!ids.size) return ''
  return uniqueJoin((Array.isArray(workTraceItems) ? workTraceItems : [])
    .filter(item => item && ids.has(String(item.stepId || item.step_id || '')))
    .map(traceText))
}

export function deriveCardThinking({ card, timeline, taskThinkingItems } = {}) {
  const fromTimeline = timelineBlocksForCard(card, timeline)
    .map(item => item.taskThinking)
  const timelineText = uniqueJoin(fromTimeline)
  if (timelineText) return timelineText

  const keys = stepKeysForCard(card)
  if (!keys.length) return ''
  return uniqueJoin((Array.isArray(taskThinkingItems) ? taskThinkingItems : [])
    .filter(item => {
      if (!item) return false
      const stepId = String(item.stepId || item.step_id || '')
      const taskId = String(item.taskId || item.task_id || '')
      const attempt = Number(item.attempt || 0) || 0
      return keys.some(key =>
        key.stepId === stepId &&
        (!key.taskId || !taskId || key.taskId === taskId) &&
        sameAttempt(key.attempt, attempt),
      )
    })
    .map(item => item.content))
}
