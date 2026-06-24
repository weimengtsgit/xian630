// `??` (not `||`): in production the portal is built with
// VITE_FACTORY_API_BASE_URL="" so calls go same-origin (/api) through the edge
// reverse proxy; empty string is not nullish so it is kept. In `npm run dev` the
// var is unset, so the local factory address is used as before.
const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL ?? 'http://127.0.0.1:8787'

async function request(path, options = {}) {
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
  return response.json()
}

// requestWithStatus is the 200/202-bifurcation variant for endpoints that may
// return EITHER a composed view (200) OR an async ack (202). It exposes the
// status so the caller can distinguish the two paths WITHOUT consuming the body
// twice. Resolves { status, body } where body is the parsed JSON (or null when
// the 202 ack carried no body). Errors share the SAME typed-error shape as
// `request`.
async function requestWithStatus(path, options = {}) {
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
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { status: response.status, body }
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
  createClarification: prompt => request('/api/clarifications', { method: 'POST', body: JSON.stringify({ prompt }) }),
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
  deleteClarification: id => request(`/api/clarifications/${id}`, { method: 'DELETE' }),
  // ---- dialogue facade (Task 4 backend) -----------------------------------
  // The /api/dialogues surface is the composed parent view over the three Factory
  // outcomes: existing-app reuse, application generation (child clarification),
  // and business-agent drafting. Every method returns a composed DialogueView
  // (or a list of them). Path/methods mirror the backend routes exactly.
  listDialogues: () => request('/api/dialogues'),
  getDialogue: id => request(`/api/dialogues/${id}`),
  createDialogue: ({ initialPrompt }) =>
    request('/api/dialogues', { method: 'POST', body: JSON.stringify({ prompt: initialPrompt }) }),
  deleteDialogue: id => request(`/api/dialogues/${id}`, { method: 'DELETE' }),
  // sendDialogueMessage handles BOTH response shapes the backend returns for
  // POST /api/dialogues/:id/messages:
  //   - 202 {dialogueId, turnId, acceptedAt}  on a CONTINUING (already-routed)
  //     session: the turn is processed asynchronously by the per-dialogue turn
  //     worker. There is NO composed view body — return the ack as-is.
  //   - 200 <DialogueView>                    on a non-continuing (pre-route or
  //     freshly-created) unlocked session: return the composed view.
  // A locked session still 409s and surfaces via the typed error (preserved).
  // The hook inspects `.status` to decide whether to poll the trace stream
  // (202) or apply the returned view immediately (200).
  async sendDialogueMessage(id, content) {
    const { status, body } = await requestWithStatus(
      `/api/dialogues/${id}/messages`,
      { method: 'POST', body: JSON.stringify({ content }) },
    )
    if (status === 202) {
      // Async ack: surface {dialogueId, turnId, acceptedAt}. Body may be null
      // for an empty 202; synthesize a minimal ack so the caller's branch is
      // uniform. Never throw on a missing body for the 202 path.
      return body || { dialogueId: id, turnId: null, acceptedAt: null, accepted: true }
    }
    // 200: the composed view. Keep returning the view for the existing flow.
    return body
  },
  // cancelDialogueTurn cancels the currently-processing turn of a continuing
  // session. Returns the cancel status (202 accepted / 200 already-terminal).
  cancelDialogueTurn: (id, turnId) =>
    request(`/api/dialogues/${id}/turns/${turnId}/cancel`, { method: 'POST' }),
  // getDialogueTrace is the REST hydration / replay endpoint for a dialogue's
  // visible work-trace rows, ascending by sequence, honoring afterSequence.
  // Used on open + on a detected replay gap (sequence jump) to re-sync.
  getDialogueTrace: (id, afterSequence) =>
    request(`/api/dialogues/${id}/work-trace${afterSequence != null ? `?afterSequence=${afterSequence}` : ''}`),
  // rollbackApp is the confirm-gated version rollback. The body MUST carry an
  // explicit confirm flag ({confirm: true}) — the backend rejects a rollback
  // without it (destructive, retain-prior-service-on-failure contract).
  rollbackApp: (appId, body = {}) =>
    request(`/api/apps/${appId}/rollback`, { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }),
  selectDialogueRoute: (id, { intent, ...rest }) =>
    request(`/api/dialogues/${id}/route`, { method: 'POST', body: JSON.stringify({ intent, ...rest }) }),
  openDialogueApplication: (id, applicationID) =>
    request(`/api/dialogues/${id}/applications/${applicationID}/open`, { method: 'POST' }),
  answerDialogueClarification: (id, answers) =>
    request(`/api/dialogues/${id}/clarification/answers`, { method: 'POST', body: JSON.stringify(answers) }),
  answerDialogueClarificationBatch: (id, answers) =>
    request(`/api/dialogues/${id}/clarification/answers/batch`, { method: 'POST', body: JSON.stringify({ answers }) }),
  // applyDialogueConsolidation drives the round-5/6 consolidation actions over the
  // SAME batch endpoint but with top-level consolidation fields (NOT wrapped in
  // {answers}, which the backend decodes as the normal round-answer path). accept
  // => accept-all recommendations (ready_to_confirm); field+value => one-field
  // round-6 override.
  applyDialogueConsolidation: (id, { accept = false, field = '', value = '' } = {}) =>
    request(`/api/dialogues/${id}/clarification/answers/batch`, {
      method: 'POST',
      body: JSON.stringify(
        accept ? { consolidationAccept: true } : { consolidationField: field, consolidationValue: value },
      ),
    }),
  patchDialogueRequirement: (id, requirement) =>
    request(`/api/dialogues/${id}/clarification/requirement`, { method: 'PATCH', body: JSON.stringify({ requirement }) }),
  retryDialogueRound: id =>
    request(`/api/dialogues/${id}/clarification/retry-current-round`, { method: 'POST' }),
  confirmDialogueClarification: id =>
    request(`/api/dialogues/${id}/clarification/confirm`, { method: 'POST' }),
  abandonDialogueClarification: id =>
    request(`/api/dialogues/${id}/clarification/abandon`, { method: 'POST' }),
  confirmDialogueBusinessAgent: id =>
    request(`/api/dialogues/${id}/business-agent/confirm`, { method: 'POST' }),
  // continueDialogueBusinessAgent drives the multi-round business-agent drafting
  // loop: append the user's refinement/answer and re-run the draft round. The
  // business route is locked, so free-text /messages would 409 — this is the
  // dedicated answer/refine path.
  continueDialogueBusiness: (id, content) =>
    request(`/api/dialogues/${id}/business-agent/continue`, { method: 'POST', body: JSON.stringify({ content }) }),
  applyDialogueBusinessConsolidation: (id, { accept = false, field = '', value = '' } = {}) =>
    request(`/api/dialogues/${id}/business-agent/consolidation`, {
      method: 'POST',
      body: JSON.stringify(
        accept ? { consolidationAccept: true } : { consolidationField: field, consolidationValue: value },
      ),
    }),
  deleteApp: id => request(`/api/apps/${id}`, { method: 'DELETE' }),
}
