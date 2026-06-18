const ACTIVE_STATUSES = ['running', 'queued', 'waiting_user', 'waiting']
const DISPLAYABLE_TERMINAL_STATUSES = ['failed', 'completed']

export function isActiveJob(job) {
  if (!job) return false
  return ACTIVE_STATUSES.includes(job.status)
}

export function isDisplayableTerminalJob(job) {
  if (!job) return false
  return DISPLAYABLE_TERMINAL_STATUSES.includes(job.status)
}

export function selectDisplayJob(jobs) {
  const list = Array.isArray(jobs) ? jobs : []
  return list.find(isActiveJob) || list.find(isDisplayableTerminalJob) || list[0] || null
}

export function displayJobTitle(job) {
  if (!job) return ''
  return (
    job.app_name ||
    job.normalized_prompt ||
    job.user_prompt ||
    job.prompt ||
    job.title ||
    job.id ||
    '未命名任务'
  )
}
