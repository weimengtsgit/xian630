import { X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import './WorkbenchPreviewModal.css'

// WorkbenchPreviewModal — the SHARED shell for the 工作台预览弹窗 glossary term.
//
// Before Task 7 the portal had THREE divergent preview modals:
//   - AttachmentPreviewModal  (.cw-preview-modal-layer: position:fixed; z-index:1200; width:min(720px,92vw))
//   - ProjectDocumentPreviewModal / InterfacePreviewModal (.cw-doc-modal-layer: position:absolute; inset:0; z-index:32; width:min(760px,100%))
// with slightly different headers, sizing, and z-index. The glossary forbids
// "每类产物独立弹窗样式" (a separate modal style per artifact kind).
//
// This component consolidates the SHELL only:
//   - a centered overlay layer (.wpm-layer) that sits ABOVE workbench content
//     (z-index:1200, matching the topmost existing modal so it covers the drawer
//      and the conversation workbench)
//   - a panel (.wpm-panel) with the agreed sizing (~min(760px,92vw), max-height:86vh)
//   - a header row: icon+title on the left, a close (X) button on the right
//   - a scrollable body (.wpm-body) — content rendering stays the caller's job
//
// The three existing modals (and the new workspace maximize modal) render their
// CONTENT inside this shell; only the shell + sizing is unified. Click on the
// overlay closes; click inside the panel does not propagate. ESC is handled by
// callers that want it (kept out of the shell so existing onClose semantics are
// preserved).
//
// Read-only by construction: the shell renders no edit affordance. Glossary
// _Avoid_ 直接修改产物 is honored at the shell level.
export function WorkbenchPreviewModal({ title, icon, onClose, children, bodyClassName, panelClassName }) {
  return (
    <div
      className="wpm-layer"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className={`wpm-panel${panelClassName ? ` ${panelClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '预览'}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="wpm-head">
          <span className="wpm-title">
            {icon || null}
            <span>{title}</span>
          </span>
          <button type="button" className="wpm-close" onClick={onClose} aria-label="关闭预览">
            <X size={16} />
          </button>
        </header>
        <div className={`wpm-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
      </section>
    </div>
  )
}

// SharedRichContent — the shared rich renderer for markdown + code.
//
// The glossary requires markdown to render as rich text (not raw 纯文本预览) and
// code to render with language-aware syntax highlighting. This wraps react-markdown
// + rehype-highlight so EVERY preview surface (workspace maximize modal, project
// document modal, attachment modal text bodies, interface design document) renders
// the same way instead of each hand-rolling a partial markdown parser.
//
//   - react-markdown renders the markdown to React elements (no raw HTML, so no
//     dangerouslySetInnerHTML XSS surface).
//   - rehype-highlight runs highlight.js over fenced code blocks (```lang) and
//     inline code, emitting hljs token classes; the CSS in
//     WorkbenchPreviewModal.css paints those tokens with the existing dark-theme
//     cyan/accent palette (no new clashing palette).
//
// `content` may be a string or null/undefined. Callers that already render
// structured content (e.g. InterfacePreviewModal's designDocument sections) keep
// their own rendering and only use this for free-text/markdown fields.
export function SharedRichContent({ content, className }) {
  const text = content == null ? '' : String(content)
  return (
    <div className={`wpm-rich${className ? ` ${className}` : ''}`}>
      {text.trim() ? (
        <Markdown text={text} />
      ) : (
        <p className="wpm-note">暂无可预览的内容。</p>
      )}
    </div>
  )
}

function Markdown({ text }) {
  return <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown>
}
