import { useCallback, useState } from 'react'
import { parseDialogMessages } from './agentAuthoringDialogLogic.js'

export { parseDialogMessages }

// Lazy API import — client.js uses import.meta.env (Vite-only), so we defer
// loading it until the first async call. This keeps the pure parser testable
// in plain Node ESM.
let _apiPromise = null
function getApi() {
  if (!_apiPromise) _apiPromise = import('../api/client.js').then(m => m.factoryApi)
  return _apiPromise
}

const WELCOME_MESSAGE = {
  id: 'welcome',
  role: 'agent',
  kind: 'welcome',
  content: '你好！请描述你需要创建的业务智能体，包括业务场景、关注的数据和规则。',
}

export function useAgentAuthoringDialog(onRefreshAgents) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([WELCOME_MESSAGE])
  const [draft, setDraft] = useState(null)
  const [sessionId, setSessionId] = useState(null)
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const openDialog = useCallback(() => {
    setOpen(true)
    setMessages([WELCOME_MESSAGE])
    setDraft(null)
    setSessionId(null)
    setSending(false)
    setSaving(false)
    setError(null)
  }, [])

  const closeDialog = useCallback(() => {
    setOpen(false)
    setMessages([WELCOME_MESSAGE])
    setDraft(null)
    setSessionId(null)
    setSending(false)
    setSaving(false)
    setError(null)
  }, [])

  const sendMessage = useCallback(async (text) => {
    const prompt = String(text || '').trim()
    if (!prompt || sending) return
    setSending(true)
    setError(null)
    try {
      const factoryApi = await getApi()
      let sid = sessionId
      if (!sid) {
        const session = await factoryApi.createClarification(prompt, { mode: 'agent_authoring' })
        sid = session.id
        setSessionId(sid)
      } else {
        await factoryApi.sendClarificationMessage(sid, prompt)
      }
      const apiMessages = await factoryApi.getClarificationMessages(sid)
      const parsed = parseDialogMessages(apiMessages)
      setMessages([WELCOME_MESSAGE, ...parsed.messages])
      setDraft(parsed.draft)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setSending(false)
    }
  }, [sessionId, sending])

  const saveAgent = useCallback(async () => {
    if (!draft || !draft.name || !draft.key || !draft.prompt || !sessionId) return
    setSaving(true)
    setError(null)
    try {
      const factoryApi = await getApi()
      await factoryApi.createBusinessAgent({
        key: draft.key,
        name: draft.name,
        description: draft.description || '',
        prompt: draft.prompt,
        enabled: true,
      })
      await factoryApi.confirmClarification(sessionId)
      if (onRefreshAgents) await onRefreshAgents()
      closeDialog()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setSaving(false)
    }
  }, [draft, sessionId, onRefreshAgents, closeDialog])

  return {
    open,
    messages,
    draft,
    sending,
    saving,
    error,
    openDialog,
    closeDialog,
    sendMessage,
    saveAgent,
  }
}
