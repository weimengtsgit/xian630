const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL || 'http://127.0.0.1:8787'
const DEFAULT_TIMEOUT_MS = 15000

async function request(path, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...fetchOptions } = options
  const controller = new AbortController()
  let timedOut = false
  let timeoutId = null
  const abortFromCaller = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  if (timeoutMs > 0) {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
      ...fetchOptions,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError' && timedOut) {
      const timeoutErr = new Error('请求超时，请稍后重试')
      timeoutErr.name = 'TimeoutError'
      throw timeoutErr
    }
    throw err
  } finally {
    if (timeoutId) globalThis.clearTimeout(timeoutId)
    if (signal) signal.removeEventListener('abort', abortFromCaller)
  }
  if (!response.ok) {
    const body = await response.text()
    const err = new Error(`${response.status} ${body}`)
    err.status = response.status
    err.bodyText = body
    try {
      err.data = JSON.parse(body)
    } catch {
      err.data = null
    }
    throw err
  }
  return response.json()
}

// requestText mirrors `request` but resolves the body as TEXT (used for
// artifact content, which the backend serves as plain text). On failure it
// produces the SAME typed-error shape as `request` (status / message / bodyText
// / data) so callers can treat both uniformly.
async function requestText(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!response.ok) {
    const body = await response.text()
    const err = new Error(`${response.status} ${body}`)
    err.status = response.status
    err.bodyText = body
    try {
      err.data = JSON.parse(body)
    } catch {
      err.data = null
    }
    throw err
  }
  return response.text()
}

export const factoryApi = {
  listApps: () => request('/api/apps'),
  startApp: id => request(`/api/apps/${id}/start`, { method: 'POST' }),
  stopApp: id => request(`/api/apps/${id}/stop`, { method: 'POST' }),
  rebuildApp: id => request(`/api/apps/${id}/rebuild`, { method: 'POST' }),
  listAgents: () => request('/api/agents'),
  getAgent: id => request(`/api/agents/${id}`),
  listSoftwareAgents: () => request('/api/agents?category=software'),
  listBusinessAgents: () => request('/api/agents?category=business'),
  createBusinessAgent: agent => request('/api/business-agents', { method: 'POST', body: JSON.stringify(agent) }),
  updateBusinessAgent: (id, agent, options = {}) => request(`/api/business-agents/${id}/update`, { method: 'POST', body: JSON.stringify(agent), ...options }),
  setBusinessAgentEnabled: (id, enabled) => request(`/api/business-agents/${id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  createBusinessAgentAuthoring: body => request('/api/business-agent-authoring', { method: 'POST', body: JSON.stringify(body || { mode: 'create' }) }),
  sendBusinessAgentAuthoringMessage: (id, content) => request(`/api/business-agent-authoring/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
  finalizeBusinessAgentAuthoring: id => request(`/api/business-agent-authoring/${id}/finalize`, { method: 'POST' }),
  getClarificationBusinessAgents: id => request(`/api/clarifications/${id}/business-agents`),
  replaceClarificationBusinessAgents: (id, agentIds) => request(`/api/clarifications/${id}/business-agents`, { method: 'PUT', body: JSON.stringify({ agent_ids: agentIds }) }),
  removeClarificationBusinessAgent: (id, agentId) => request(`/api/clarifications/${id}/business-agents/${agentId}`, { method: 'DELETE' }),
  createAgent: agent => request('/api/agents', { method: 'POST', body: JSON.stringify(agent) }),
  createJob: prompt => request('/api/jobs', { method: 'POST', body: JSON.stringify({ prompt }) }),
  listJobs: () => request('/api/jobs'),
  getJob: id => request(`/api/jobs/${id}`),
  getJobSteps: id => request(`/api/jobs/${id}/steps`),
  cancelJob: id => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  answerJob: (id, answer) => request(`/api/jobs/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  retryCurrentStep: id => request(`/api/jobs/${id}/retry-current-step`, { method: 'POST' }),
  // Execution observability (Task 4 backend contract):
  //   - summary: per-step snapshot of latest attempt + latest record
  //   - records: paginated (newest-first via before_sequence=0) for ONE step+attempt
  //   - artifacts: list + text content (content served as TEXT, so requestText)
  getJobExecutionSummary: id => request(`/api/jobs/${id}/execution-summary`),
  getStepExecutionRecords: (jobId, stepId, attempt, beforeSequence) =>
    request(
      `/api/jobs/${jobId}/steps/${stepId}/execution-records?attempt=${attempt}&before_sequence=${
        beforeSequence || ''
      }&limit=200`,
    ),
  getJobArtifacts: id => request(`/api/jobs/${id}/artifacts`),
  getArtifactContent: async id => requestText(`/api/artifacts/${id}/content`),
  createClarification: (prompt, options = {}) => request('/api/clarifications', { method: 'POST', body: JSON.stringify({ prompt, ...options }) }),
  getActiveClarification: () => request('/api/clarifications/active'),
  getClarification: id => request(`/api/clarifications/${id}`),
  getClarificationMessages: id => request(`/api/clarifications/${id}/messages`),
  sendClarificationMessage: (id, content) => request(`/api/clarifications/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
  answerClarification: (id, answer) => request(`/api/clarifications/${id}/answers`, { method: 'POST', body: JSON.stringify(answer) }),
  answerClarificationBatch: (id, answers) => request(`/api/clarifications/${id}/answers/batch`, { method: 'POST', body: JSON.stringify({ answers }) }),
  patchClarificationRequirement: (id, requirement) => request(`/api/clarifications/${id}/requirement`, { method: 'PATCH', body: JSON.stringify({ requirement }) }),
  retryClarificationRound: id => request(`/api/clarifications/${id}/retry-current-round`, { method: 'POST' }),
  confirmClarification: id => request(`/api/clarifications/${id}/confirm`, { method: 'POST' }),
  abandonClarification: id => request(`/api/clarifications/${id}/abandon`, { method: 'POST' }),
  listClarifications: limit => request(`/api/clarifications?limit=${limit || 50}`),
  deleteApp: id => request(`/api/apps/${id}`, { method: 'DELETE' }),
}
