const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL || 'http://127.0.0.1:8787'

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${response.status} ${body}`)
  }
  return response.json()
}

export const factoryApi = {
  listApps: () => request('/api/apps'),
  startApp: id => request(`/api/apps/${id}/start`, { method: 'POST' }),
  stopApp: id => request(`/api/apps/${id}/stop`, { method: 'POST' }),
  rebuildApp: id => request(`/api/apps/${id}/rebuild`, { method: 'POST' }),
  listAgents: () => request('/api/agents'),
  createAgent: agent => request('/api/agents/create', { method: 'POST', body: JSON.stringify(agent) }),
  createJob: prompt => request('/api/jobs', { method: 'POST', body: JSON.stringify({ prompt }) }),
  listJobs: () => request('/api/jobs'),
  getJob: id => request(`/api/jobs/${id}`),
  getJobSteps: id => request(`/api/jobs/${id}/steps`),
  cancelJob: id => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  answerJob: (id, answer) => request(`/api/jobs/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  retryCurrentStep: id => request(`/api/jobs/${id}/retry-current-step`, { method: 'POST' }),
}
