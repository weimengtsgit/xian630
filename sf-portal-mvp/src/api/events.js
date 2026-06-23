const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL || 'http://127.0.0.1:8787'

// subscribeFactoryEvents(onEvent, { onError } = {})
//
// Backward compatible: the second argument is optional, so existing callers
// that pass only `onEvent` (useJobs, useApplications, useClarification) keep
// working unchanged. The optional `onError` is invoked when the EventSource
// reports a connection error (onerror with no open connection) so subscribers
// can schedule a resync — see useJobs gap-resync.
export function subscribeFactoryEvents(onEvent, { onError } = {}) {
  const source = new EventSource(`${API_BASE_URL}/api/events`)
  const types = [
    'app.updated',
    'app.deleted',
    'job.created',
    'job.updated',
    'step.updated',
    'artifact.created',
    'deployment.updated',
    'step.record.appended',
    'clarification.created',
    'clarification.message.started',
    'clarification.message.delta',
    'clarification.message.completed',
    'clarification.question.created',
    'clarification.summary.updated',
    'clarification.blueprint.recommended',
    'clarification.ready_to_confirm',
    'clarification.confirmed',
    'clarification.failed',
    'clarification.abandoned',
    'clarification.deleted',
    // dialogue.* (Task 4): the composed parent facade. Child clarification events
    // arrive wrapped with a parent dialogue_id; the portal keys updates by
    // dialogue_id rather than refetching the whole history per streaming delta.
    'dialogue.created',
    'dialogue.intent.updated',
    'dialogue.application.recommended',
    'dialogue.route.confirmed',
    'dialogue.agent_draft.updated',
    'dialogue.agent.created',
    'dialogue.clarification.updated',
    'dialogue.resolved',
    'dialogue.abandoned',
    'dialogue.deleted',
  ]
  types.forEach(type => {
    source.addEventListener(type, event => {
      onEvent(type, JSON.parse(event.data))
    })
  })
  if (typeof onError === 'function') {
    source.addEventListener('error', err => {
      // EventSource auto-reconnects; onError lets the caller schedule a
      // debounced snapshot resync to cover any records missed while the
      // connection was down.
      onError(err)
    })
  }
  return () => source.close()
}
