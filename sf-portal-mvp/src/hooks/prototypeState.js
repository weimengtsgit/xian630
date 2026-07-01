export function normalizePrototypeSummary(summary) {
  if (!summary) return null
  const manifest = summary.manifest || {}
  const contract = summary.contract || {}
  const pages = Array.isArray(manifest.pages) ? manifest.pages : []
  return {
    artifactId: summary.artifactId || '',
    status: summary.status || 'unconfirmed',
    label: summary.label || '原型预览',
    previewUrl: summary.previewUrl || '',
    jobId: summary.jobId || '',
    stepId: summary.stepId || '',
    defaultPage: manifest.defaultPage || 'home',
    fidelity: manifest.fidelity || contract?.prototype?.fidelity || 'static',
    pages,
    pageLabels: pages.map(page => page.title || page.id).filter(Boolean),
    canConfirm: summary.status !== 'confirmed',
    canContinue: summary.status !== 'confirmed',
  }
}
