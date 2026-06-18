const API_BASE_URL = import.meta.env.VITE_FACTORY_API_BASE_URL || 'http://127.0.0.1:8787'

export function subscribeFactoryEvents(onEvent) {
  const source = new EventSource(`${API_BASE_URL}/api/events`)
  const types = ['app.updated', 'job.created', 'job.updated', 'step.updated', 'artifact.created', 'deployment.updated']
  types.forEach(type => {
    source.addEventListener(type, event => {
      onEvent(type, JSON.parse(event.data))
    })
  })
  return () => source.close()
}
