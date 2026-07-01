import { FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react'

// AttachmentComposer renders the paperclip upload affordance plus the chips for
// each pending attachment (uploaded or staged locally). Each chip exposes a
// remove (X) button. The actual upload happens in useSessionAttachments; this
// component is presentational. Hidden file input is inside the paperclip label.
export function AttachmentComposer({ items, uploading, onAddFiles, onRemove, onOpen }) {
  return (
    <div className="cw-attachments">
      <label className="cw-attach-btn" title="添加附件">
        <Paperclip size={15} />
        <input type="file" multiple onChange={event => onAddFiles(event.target.files)} />
      </label>
      {items.map(item => {
        const attachment = item.attachment
        const canPreview = attachment && attachment.id
        return (
          <span key={item.id} className="cw-attach-chip">
            {isImage(item) ? <ImageIcon size={14} /> : <FileText size={14} />}
            <span
              className={canPreview ? 'cw-attach-name' : undefined}
              role={canPreview ? 'button' : undefined}
              tabIndex={canPreview ? 0 : undefined}
              onClick={canPreview && onOpen ? () => onOpen(attachment) : undefined}
              title={canPreview ? '预览附件' : undefined}
            >
              {item.name}
            </span>
            <button type="button" onClick={() => onRemove(item.id)} title="移除附件" aria-label={`移除附件 ${item.name}`}>
              <X size={12} />
            </button>
          </span>
        )
      })}
      {uploading ? <span className="cw-attach-uploading">上传中</span> : null}
    </div>
  )
}

function isImage(item) {
  const mime = item.attachment && item.attachment.mime || item.file && item.file.type || ''
  return mime.startsWith('image/')
}
