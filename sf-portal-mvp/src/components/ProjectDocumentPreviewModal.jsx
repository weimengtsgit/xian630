import { FileText } from 'lucide-react'
import { WorkbenchPreviewModal, SharedRichContent } from './WorkbenchPreviewModal'

// ProjectDocumentPreviewModal — refactored (Task 7) to use the shared
// WorkbenchPreviewModal shell. Previously this rendered its own
// .cw-doc-modal-layer / .cw-doc-modal markup with a different z-index (32,
// position:absolute) and width than the attachment modal. It now shares the
// centered shell (z-index 1200, min(760px,92vw), max-height 86vh) so there is
// no longer a per-artifact modal style (glossary _Avoid_ 每类产物独立弹窗样式).
//
// Content rendering also moved from a hand-rolled line-by-line markdown stub to
// the shared SharedRichContent (react-markdown + rehype-highlight), so project
// documents render as real rich markdown with highlighted code blocks instead of
// the previous 纯文本预览 approximation.
export function ProjectDocumentPreviewModal({ document, onClose }) {
  if (!document) return null
  return (
    <WorkbenchPreviewModal
      title={document.path}
      icon={<FileText size={15} />}
      onClose={onClose}
      bodyClassName="cw-doc-rich"
    >
      <SharedRichContent content={document.content || ''} />
    </WorkbenchPreviewModal>
  )
}
