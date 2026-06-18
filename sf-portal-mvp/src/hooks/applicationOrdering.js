export const DISPLAY_APP_SLUG_ORDER = [
  'carrier-homeport-tide-window',
  'carrier-deck-wind-calculator',
  'merchant-density-grid-alert',
  'social-sighting-cluster-alert',
  'carrier-formation-replay',
  'east-sea-situation',
  'aircraft-carrier-track',
]

const displayOrderBySlug = new Map(
  DISPLAY_APP_SLUG_ORDER.map((slug, index) => [slug, index]),
)

export function orderApplicationsForDisplay(apps) {
  const list = Array.isArray(apps) ? apps : []
  return [...list].sort((a, b) => {
    const aOrder = displayOrderBySlug.get(a.slug)
    const bOrder = displayOrderBySlug.get(b.slug)

    if (aOrder !== undefined && bOrder !== undefined) {
      return aOrder - bOrder
    }
    if (aOrder !== undefined) return -1
    if (bOrder !== undefined) return 1

    return (a.slug || '').localeCompare(b.slug || '')
  })
}
