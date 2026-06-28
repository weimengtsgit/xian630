// Pure focus-task selector (Constraint #10: switching a history session syncs
// its focus task). For the SELECTED dialogue choose the job that most needs
// attention, ranked by status tier first and time second. Jobs link to a
// dialogue via `dialogue_id` (Task 1 column); legacy jobs with no dialogue_id
// are eligible only when no dialogue is selected (back-compat with the
// pre-dialogue job stream).
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

// statusTier ranks jobs by attention priority (lowest = most attention).
// Plan ordering: waiting_user → running → queued → failed → other terminals.
// The frontend has no reliable repairability signal, so we approximate
// "repairable failed" by ranking ALL failed above completed/canceled — a failed
// task may be repairable and always warrants attention over clean history.
// Jobs with statuses outside every known set sort last (tier Infinity).
function statusTier(job) {
  const s = job && job.status
  if (s === 'waiting_user' || s === 'waiting') return 0
  if (s === 'running') return 1
  if (s === 'queued') return 2
  if (s === 'failed') return 3
  if (s === 'completed' || s === 'canceled' || s === 'cancelled') return 4
  return Infinity
}

// timeKey returns the most reliable timestamp present for tie-breaking within a
// tier: started_at (actual exec start), else created_at (queue time), else
// updated_at (last mutation), else 0. Falls through the chain in that order so
// the most informative signal wins.
function timeKey(job) {
  const started = job.started_at ? Date.parse(job.started_at) : 0
  if (started) return started
  const created = job.created_at ? Date.parse(job.created_at) : 0
  if (created) return created
  const updated = job.updated_at ? Date.parse(job.updated_at) : 0
  return updated || 0
}

// selectFocusTask picks the focus job for a dialogue from the full job list.
//   - When dialogueId is provided, only jobs whose dialogue_id matches are
//     eligible (Constraint #7/#10 — the trace/focus is dialogue-scoped).
//   - Picks the job with the LOWEST status tier (most-attention-first); within
//     the same tier, the newest by started_at → created_at → updated_at.
//   - Returns null when nothing is eligible.
export function selectFocusTask(jobs, dialogueId) {
  const list = Array.isArray(jobs) ? jobs : []
  const scoped =
    dialogueId != null && dialogueId !== ''
      ? list.filter(j => j && j.dialogue_id === dialogueId)
      : list
  // Restrict to statuses we know how to rank; drop unknown/garbage statuses so
  // they never win the focus slot.
  const eligible = scoped.filter(j => isActive(j) || isTerminal(j))
  if (eligible.length === 0) return null
  return eligible.slice().sort((a, b) => {
    const ta = statusTier(a)
    const tb = statusTier(b)
    if (ta !== tb) return ta - tb // ascending tier — most attention first
    return timeKey(b) - timeKey(a) // within tier, newest first
  })[0]
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
