// Pure dialog-message parser for the agent-authoring dialog.
// NO React / API imports — this module is exercised by the node-assert
// logic harness (scripts/check-agent-authoring-dialog-hook.mjs) and also
// consumed by useAgentAuthoringDialog.js.

function parseJSON(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseDialogMessages(apiMessages) {
  const messages = []
  let draft = null
  for (const msg of apiMessages || []) {
    if (msg.role === 'user') {
      messages.push({ id: msg.id, role: 'user', kind: msg.kind, content: msg.content || '' })
      continue
    }
    if (msg.role === 'agent') {
      if (msg.kind === 'agent_draft') {
        const parsed = parseJSON(msg.metadata_json)
        if (!parsed) continue
        messages.push({ id: msg.id, role: 'agent', kind: 'agent_draft', content: msg.content || '', draft: parsed })
        draft = parsed
      } else {
        messages.push({ id: msg.id, role: 'agent', kind: msg.kind, content: msg.content || '' })
      }
    }
  }
  return { messages, draft }
}
