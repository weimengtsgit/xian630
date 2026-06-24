// Pure focus-task selector (Constraint #10: switching a history session syncs
// its focus task). For the SELECTED dialogue choose the newest queued/running/
// waiting job, otherwise the newest terminal job. Jobs link to a dialogue via
// `dialogue_id` (Task 1 column); legacy jobs with no dialogue_id are eligible
// only when no dialogue is selected (back-compat with the pre-dialogue job
// stream).
//
// Pure + side-effect-free so it can be exercised by the logic harness and memoized
// cheaply inside the hook.

const ACTIVE_STATUSES = ['running', 'queued', 'waiting_user', 'waiting', 'in_progress']
const TERMINAL_STATUSES = ['completed', 'failed', 'canceled', 'cancelled']

function isActive(job) {
  return job && ACTIVE_STATUSES.includes(job.status)
}
function isTerminal(job) {
  return job && TERMINAL_STATUSES.includes(job.status)
}

// byNewest sorts descending by the most reliable timestamp present: started_at
// (actual exec start) falls back to created_at (queue time) falls back to 0.
function sortKey(job) {
  const started = job.started_at ? Date.parse(job.started_at) : 0
  const created = job.created_at ? Date.parse(job.created_at) : 0
  return Math.max(started, created) || 0
}

// selectFocusTask picks the focus job for a dialogue from the full job list.
//   - When dialogueId is provided, only jobs whose dialogue_id matches are
//     eligible (Constraint #7/#10 — the trace/focus is dialogue-scoped).
//   - Prefers the newest ACTIVE job; else the newest terminal job; else null.
export function selectFocusTask(jobs, dialogueId) {
  const list = Array.isArray(jobs) ? jobs : []
  const scoped =
    dialogueId != null && dialogueId !== ''
      ? list.filter(j => j && j.dialogue_id === dialogueId)
      : list
  const actives = scoped.filter(isActive).sort((a, b) => sortKey(b) - sortKey(a))
  if (actives[0]) return actives[0]
  const terminals = scoped.filter(isTerminal).sort((a, b) => sortKey(b) - sortKey(a))
  return terminals[0] || null
}

// focusTaskOverview returns the CROSS-SESSION overview slice (Constraint #10:
// the overview receives only title, status, started time, and progress).
export function focusTaskOverview(job) {
  if (!job) return null
  const progress = typeof job.progress === 'number' ? job.progress : null
  return {
    id: job.id || '',
    title: job.app_name || job.user_prompt || job.normalized_prompt || job.title || '',
    status: job.status || '',
    startedAt: job.started_at || '',
    progress,
  }
}

export { ACTIVE_STATUSES, TERMINAL_STATUSES }
