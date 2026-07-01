import { X } from 'lucide-react'

export function ProjectDocumentPreviewModal({ document, onClose }) {
  if (!document) return null
  return (
    <div className="cw-doc-modal-layer" role="presentation" onMouseDown={onClose}>
      <section className="cw-doc-modal" role="dialog" aria-modal="true" aria-label={document.path} onMouseDown={event => event.stopPropagation()}>
        <header>
          <strong>{document.path}</strong>
          <button type="button" onClick={onClose} aria-label="关闭预览"><X size={16} /></button>
        </header>
        <article className="cw-doc-rich">
          {renderMarkdown(document.content || '')}
        </article>
      </section>
    </div>
  )
}

function renderMarkdown(content) {
  const lines = String(content).split('\n')
  return lines.map((line, index) => {
    if (line.startsWith('# ')) return <h1 key={index}>{line.slice(2)}</h1>
    if (line.startsWith('## ')) return <h2 key={index}>{line.slice(3)}</h2>
    if (line.startsWith('### ')) return <h3 key={index}>{line.slice(4)}</h3>
    if (line.startsWith('- ')) return <p key={index} className="cw-doc-li">{line.slice(2)}</p>
    if (!line.trim()) return <br key={index} />
    return <p key={index}>{line}</p>
  })
}
