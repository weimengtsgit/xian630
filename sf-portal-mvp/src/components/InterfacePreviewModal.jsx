import { X } from 'lucide-react'

// InterfacePreviewModal renders the interface-preview artifact retained from a
// successful design_contract step (Task 8). When the artifact carries a
// previewUrl (a future serving endpoint renders the manifest as HTML), the
// modal embeds it in a sandboxed iframe. Until that endpoint exists the
// snapshot is RETAINED ONLY — the backend stores a design-derived manifest but
// does not serve it as a browsable page (decision #38: Task 8 mandates
// snapshot retention, not serving). To avoid a broken iframe the modal
// DEGRADES GRACEFULLY when previewUrl is empty: it surfaces the artifact label
// and a "快照已保留" note instead of pointing an iframe at a URL that would
// 404 / render the raw manifest JSON. A full GET serving endpoint with MIME +
// CSP is intentionally deferred to a later task.
export function InterfacePreviewModal({ artifact, onClose }) {
  if (!artifact) return null
  const title = artifact.label || '界面预览'
  const previewUrl = artifact.previewUrl || ''
  return (
    <div className="cw-doc-modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="cw-doc-modal cw-interface-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={event => event.stopPropagation()}>
        <header>
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label="关闭预览"><X size={16} /></button>
        </header>
        {previewUrl ? (
          <iframe title={title} src={previewUrl} sandbox="allow-scripts allow-same-origin" />
        ) : (
          <article className="cw-interface-fallback">
            <p className="cw-interface-fallback-title">界面预览快照已保留</p>
            <p className="cw-interface-fallback-hint">
              界面解析设计契约已生成并保留为产物快照。可交互的界面预览将在后续阶段渲染。
            </p>
          </article>
        )}
      </section>
    </div>
  )
}
