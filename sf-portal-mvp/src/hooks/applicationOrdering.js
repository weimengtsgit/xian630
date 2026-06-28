// Configuration-driven application ordering for the portal app list.
//
// Preset (application-surface) apps are ordered by their API-supplied
// display_order (assigned server-side from .factory/scene-catalog.json).
// Generated apps are ordered by newest updated_at. The slug is a deterministic
// tie-breaker ONLY within the same ordering bucket; it never overrides the
// catalog/upload order.

function isGenerated(app) {
  return app.source === 'generated' || app.source === 'generated-apps'
}

function presetRank(app) {
  // An application-surface preset carries display_order > 0. Presets without a
  // display_order sort after ordered presets, before generated apps.
  return Number.isFinite(app.display_order) && app.display_order > 0
    ? app.display_order
    : Number.MAX_SAFE_INTEGER
}

function byUpdatedAtDesc(a, b) {
  const ta = a.updated_at ? Date.parse(a.updated_at) : 0
  const tb = b.updated_at ? Date.parse(b.updated_at) : 0
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
  return tb - ta // newest first
}

export function orderApplicationsForDisplay(apps) {
  const list = Array.isArray(apps) ? apps : []
  return [...list].sort((a, b) => {
    const aGen = isGenerated(a)
    const bGen = isGenerated(b)
    // Presets before generated apps.
    if (!aGen && bGen) return -1
    if (aGen && !bGen) return 1
    if (aGen && bGen) {
      const byDate = byUpdatedAtDesc(a, b)
      if (byDate !== 0) return byDate
      return (a.slug || '').localeCompare(b.slug || '')
    }
    // Both presets: by display_order, slug as tie-breaker only.
    const ra = presetRank(a)
    const rb = presetRank(b)
    if (ra !== rb) return ra - rb
    return (a.slug || '').localeCompare(b.slug || '')
  })
}
