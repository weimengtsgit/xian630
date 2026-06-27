// Business-agent cards are ordered by creation time, newest first. The slug is a
// deterministic tie-breaker only when timestamps are equal or missing.

function isGenerated(app) {
  return app.source === 'generated' || app.source === 'generated-apps'
}

function createdAtMs(app) {
  const raw = app && (app.created_at || app.createdAt)
  if (!raw) return 0
  const t = Date.parse(raw)
  return Number.isNaN(t) ? 0 : t
}

export function orderApplicationsForDisplay(apps) {
  const list = Array.isArray(apps) ? apps : []
  return [...list].sort((a, b) => {
    const byCreated = createdAtMs(b) - createdAtMs(a)
    if (byCreated !== 0) return byCreated
    return (a.slug || '').localeCompare(b.slug || '')
  })
}
