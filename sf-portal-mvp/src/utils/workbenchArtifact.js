// isPreviewableArtifact decides whether a workbench artifact ref can be opened
// in a preview (modal). It is the SINGLE source of truth shared by the graph
// card (WorkbenchAgentBlock) and the conversation timeline's artifact-link
// injection (dialogueTimeline.appendArtifactLinks) so the two surfaces never
// diverge. interface_preview always opens its own modal; any other kind is
// previewable only if it carries a servable path or previewUrl.
export function isPreviewableArtifact(item) {
  if (!item) return false
  return item.kind === 'interface_preview' || !!item.path || !!item.previewUrl
}
