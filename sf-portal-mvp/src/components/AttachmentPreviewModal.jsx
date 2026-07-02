import { useEffect, useState } from 'react'
import { FileText, Image as ImageIcon, X } from 'lucide-react'
import { factoryApi } from '../api/client'

// AttachmentPreviewModal renders a full-overlay preview of a single dialogue
// attachment. PLAN-GAP FILL: the Task 4 brief lists this file in its commit set
// but provides NO code or step for it, and no backend /content preview endpoint
// ships in this task, so this is a MINIMAL, self-contained component:
//   - image preview_kind  -> <img> (uses stored_path via the artifact route when
//     the backend exposes one; otherwise falls back to metadata).
//   - markdown/text/json/csv -> <pre> fetched via getDialogueAttachmentContent.
//     If the endpoint is absent (404) we degrade gracefully to metadata + a note.
//   - pdf                   -> <iframe> when a content URL is derivable, else a
//     download-style link line.
//   - word/excel/unknown/metadata -> metadata-only card (name, size, type, kind).
// Props: { attachment, onClose }. Returns null when no attachment is supplied.
export function AttachmentPreviewModal({ attachment, onClose }) {
  const [text, setText] = useState(null)
  const [textError, setTextError] = useState(false)

  const kind = attachment && (attachment.previewKind || attachment.preview_kind)
  const dialogueId = attachment && attachment.dialogueId
  const attachmentId = attachment && attachment.id

  useEffect(() => {
    setText(null)
    setTextError(false)
    if (!attachment || !dialogueId || !attachmentId) return
    if (!isTextKind(kind)) return
    let cancelled = false
    factoryApi
      .getDialogueAttachmentContent(dialogueId, attachmentId)
      .then(body => { if (!cancelled) setText(body) })
      .catch(() => { if (!cancelled) setTextError(true) })
    return () => { cancelled = true }
  }, [attachment, dialogueId, attachmentId, kind])

  if (!attachment) return null
  const name = attachment.originalName || attachment.original_name || attachment.name || '附件'
  const mime = attachment.mime || ''
  const size = typeof attachment.sizeBytes === 'number'
    ? attachment.sizeBytes
    : typeof attachment.size_bytes === 'number'
      ? attachment.size_bytes
      : null

  return (
    <div className="cw-preview-modal-layer" onClick={onClose}>
      <div className="cw-preview-modal" onClick={event => event.stopPropagation()}>
        <div className="cw-preview-modal-head">
          <span className="cw-preview-modal-title">
            {mime.startsWith('image/') ? <ImageIcon size={15} /> : <FileText size={15} />}
            <span>{name}</span>
          </span>
          <button type="button" className="cw-preview-modal-close" onClick={onClose} aria-label="关闭预览">
            <X size={16} />
          </button>
        </div>
        <div className="cw-preview-modal-body">
          {kind === 'image' ? (
            <img className="cw-preview-image" src={contentURL(attachment)} alt={name} />
          ) : isTextKind(kind) ? (
            textError ? (
              <p className="cw-preview-note">该附件暂无可预览的文本内容（仅显示元数据）。</p>
            ) : text == null ? (
              <p className="cw-preview-note">加载中…</p>
            ) : (
              <pre className="cw-preview-text">{text}</pre>
            )
          ) : kind === 'pdf' ? (
            contentURL(attachment) ? (
              <iframe className="cw-preview-pdf" src={contentURL(attachment)} title={name} />
            ) : (
              <p className="cw-preview-note">PDF 预览暂不可用。</p>
            )
          ) : (
            <p className="cw-preview-note">该类型附件暂不支持内联预览，仅显示元数据。</p>
          )}
          <dl className="cw-preview-meta">
            <dt>类型</dt><dd>{mime || kind || '未知'}</dd>
            {size != null ? (<><dt>大小</dt><dd>{formatBytes(size)}</dd></>) : null}
            {attachment.extension || attachment.extension === '' ? (<><dt>扩展名</dt><dd>{attachment.extension || '—'}</dd></>) : null}
            {attachment.focusKey || attachment.focus_key ? (<><dt>聚焦</dt><dd>{attachment.focusKey || attachment.focus_key}</dd></>) : null}
          </dl>
        </div>
      </div>
    </div>
  )
}

function isTextKind(kind) {
  return kind === 'markdown' || kind === 'text' || kind === 'json' || kind === 'csv'
}

// contentURL derives a fetchable URL for the attachment when the backend serves
// its bytes inline — the click-to-preview content route (F3). Only image and pdf
// kinds return a URL here (rendered via <img src> / <iframe src>); text kinds
// (markdown/text/json/csv) are fetched as text via getDialogueAttachmentContent
// and rendered into a <pre>, so they return null here. Other kinds have no
// inline preview body (the backend 404s), so they also return null and the modal
// falls back to a metadata-only card.
function contentURL(attachment) {
  if (!attachment) return null
  const dialogueId = attachment.dialogueId
  const attachmentId = attachment.id
  if (!dialogueId || !attachmentId) return null
  const kind = attachment.previewKind || attachment.preview_kind
  if (kind === 'image' || kind === 'pdf') {
    return factoryApi.getDialogueAttachmentContentURL(dialogueId, attachmentId)
  }
  return null
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
