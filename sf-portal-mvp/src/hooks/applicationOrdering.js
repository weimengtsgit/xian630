// Business-agent cards are ordered by creation time, newest first. The slug is a
// deterministic tie-breaker only when timestamps are equal or missing.

function isGenerated(app) {
  return app && (app.source === 'generated' || app.source === 'generated-apps')
}

function isManagedAgent(app) {
  return app && (app.type === 'managed_agent' || app.surface === 'managed_agent')
}

function createdAtMs(app) {
  const raw = app && (app.created_at || app.createdAt)
  if (!raw) return 0
  const t = Date.parse(raw)
  return Number.isNaN(t) ? 0 : t
}

function displayOrder(app, indexById) {
  if (Number.isFinite(app && app.display_order)) return app.display_order
  if (Number.isFinite(app && app.displayOrder)) return app.displayOrder
  if (Number.isFinite(app && app.order)) return app.order
  const key = app && (app.id || app.slug)
  return key && indexById && Number.isFinite(indexById.get(key)) ? indexById.get(key) : Number.MAX_SAFE_INTEGER
}

function stableName(app) {
  return String((app && (app.name || app.slug || app.id)) || '')
}

export function isGeneratedApplication(app) {
  return isGenerated(app)
}

export function isStoreApplication(app) {
  return !!app && !isManagedAgent(app)
}

export function orderApplicationsForStore(apps) {
  const list = Array.isArray(apps) ? apps.filter(isStoreApplication) : []
  const indexById = new Map(list.map((app, index) => [app.id || app.slug, index]))
  return [...list].sort((a, b) => {
    const ag = isGenerated(a)
    const bg = isGenerated(b)
    if (ag !== bg) return ag ? -1 : 1
    if (ag && bg) {
      const byCreated = createdAtMs(b) - createdAtMs(a)
      if (byCreated !== 0) return byCreated
    }
    if (!ag && !bg) {
      const byOrder = displayOrder(a, indexById) - displayOrder(b, indexById)
      if (byOrder !== 0) return byOrder
    }
    return stableName(a).localeCompare(stableName(b), 'zh-CN')
  })
}

export function orderApplicationsForDisplay(apps) {
  const list = Array.isArray(apps) ? apps : []
  return [...list].sort((a, b) => {
    const byCreated = createdAtMs(b) - createdAtMs(a)
    if (byCreated !== 0) return byCreated
    return (a.slug || '').localeCompare(b.slug || '')
  })
}
