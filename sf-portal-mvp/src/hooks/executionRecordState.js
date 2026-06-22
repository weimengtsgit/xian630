// Pure helpers for managing execution-record state.
//
// The record store is a flat array of records keyed by `id`. Records are
// deduped by id (first-seen wins — a repeated id never overwrites the existing
// record's content, and never appends a duplicate). Lookups filter to a
// (stepId, attempt) pair and sort ascending by `sequence`.
//
// These helpers are deliberately framework-free (no React, no side effects) so
// the Node assertion harness in scripts/check-execution-record-state.mjs can
// import them directly.

/**
 * Merge a single record into the store by id, deduping without overwriting.
 *
 * @param {Array} state - the current record array
 * @param {{ id: string, step_id: string, attempt: number, sequence: number }} record
 * @returns {Array} a NEW array with the record merged in
 */
export function appendExecutionRecord(state, record) {
  if (!record || record.id == null) return state
  const existing = state.some(r => r && r.id === record.id)
  if (existing) {
    // First-seen wins: do not overwrite, do not duplicate. Return the same
    // reference so callers that bail on identity still work, but keep a new
    // array for consistency with the merge-from-delta path used by SSE.
    return state.slice()
  }
  return state.concat(record)
}

/**
 * Return the records for one step+attempt, sorted ascending by sequence.
 *
 * Equal-sequence records keep their insertion order (stable), so the order in
 * which records were appended is preserved within a sequence tier.
 *
 * @param {Array} state
 * @param {string} stepId
 * @param {number} attempt
 * @returns {Array}
 */
export function recordsForAttempt(state, stepId, attempt) {
  return (state || [])
    .filter(r => r && r.step_id === stepId && r.attempt === attempt)
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
}

/**
 * Count records for one step+attempt whose sequence is strictly greater than
 * `lastReadSequence`.
 *
 * @param {Array} state
 * @param {string} stepId
 * @param {number} attempt
 * @param {number} lastReadSequence
 * @returns {number}
 */
export function unreadCountForStep(state, stepId, attempt, lastReadSequence) {
  const threshold = Number.isFinite(lastReadSequence) ? lastReadSequence : 0
  return recordsForAttempt(state, stepId, attempt).reduce(
    (count, r) => count + ((r.sequence || 0) > threshold ? 1 : 0),
    0,
  )
}

/**
 * Build the six-step card view by joining the job_steps list (id + kind) to
 * the execution-summary (keyed by step_id). The backend summary is keyed by
 * the REAL job_steps.id (NOT by kind), so we must resolve each fixed kind to
 * its real stepId first, then look up the summary by that id.
 *
 * @param {Array<{id:string, kind:string}>} steps - rows from GET /steps
 * @param {Array<{step_id:string, latest_attempt?:number, latest_record?:*}>} summary - rows from /execution-summary
 * @param {Array<{kind:string, label:string}>} fixedSteps - ordered six kinds
 * @returns {Array<{kind:string, label:string, stepId:string|null, step:object|null, summary:object|null}>}
 */
export function buildStepCardView(steps, summary, fixedSteps) {
  const stepList = Array.isArray(steps) ? steps : []
  const sumList = Array.isArray(summary) ? summary : []

  // index steps by kind -> real id
  const stepByKind = {}
  stepList.forEach(s => {
    if (!s || !s.kind) return
    // First row of a given kind wins (no overwrite), matching first-seen semantics.
    if (!stepByKind[s.kind]) stepByKind[s.kind] = s
  })

  // index summary by REAL step_id (the backend key), never by kind.
  const summaryByStepId = {}
  sumList.forEach(s => {
    if (!s || s.step_id == null) return
    if (!summaryByStepId[s.step_id]) summaryByStepId[s.step_id] = s
  })

  return (fixedSteps || []).map(fixed => {
    const step = stepByKind[fixed.kind] || null
    const stepId = step && step.id ? step.id : null
    const sm = stepId ? summaryByStepId[stepId] || null : null
    return {
      kind: fixed.kind,
      label: fixed.label,
      stepId,
      step,
      summary: sm,
    }
  })
}
