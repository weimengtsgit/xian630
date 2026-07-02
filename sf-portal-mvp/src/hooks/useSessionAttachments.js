import { useCallback, useState } from 'react'
import { factoryApi } from '../api/client'

// useSessionAttachments manages the pending attachments a user has pinned to the
// composer for the CURRENT message. It is per-render-call local state: each
// pinned file is either uploaded immediately (dialogueId known) or staged
// locally (no dialogue yet) and uploaded on send. `attachmentIds` is the list of
// persisted attachment ids to thread into sendDialogueMessage; `pending` is the
// full chip list (id/file/attachment/name/status) for the composer. clearPending
// resets the chips once the message is submitted.
export function useSessionAttachments({ dialogueId, focusKey }) {
  const [pending, setPending] = useState([])
  const [uploading, setUploading] = useState(false)
  const addFiles = useCallback(async files => {
    const list = Array.from(files || [])
    if (!list.length) return []
    if (!dialogueId) {
      const local = list.map(file => ({ id: `local_${crypto.randomUUID()}`, file, name: file.name, status: 'local' }))
      setPending(prev => [...prev, ...local])
      return local
    }
    setUploading(true)
    try {
      const uploaded = []
      for (const file of list) {
        const res = await factoryApi.uploadDialogueAttachment(dialogueId, { file, focusKey })
        uploaded.push({ id: res.attachment.id, file, attachment: res.attachment, name: file.name, status: 'uploaded' })
      }
      setPending(prev => [...prev, ...uploaded])
      return uploaded
    } finally {
      setUploading(false)
    }
  }, [dialogueId, focusKey])
  const removePending = useCallback(id => setPending(prev => prev.filter(item => item.id !== id)), [])
  const clearPending = useCallback(() => setPending([]), [])
  const attachmentIds = pending.filter(item => item.attachment && item.attachment.id).map(item => item.attachment.id)
  return { pending, uploading, addFiles, removePending, clearPending, attachmentIds }
}
