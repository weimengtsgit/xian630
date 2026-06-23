# Agent Authoring via Conversation Workbench

Date: 2026-06-23

## Status

Approved for specification review.

## Context

The sf-portal-mvp page has three columns:

- Left: ApplicationsPanel (application list)
- Center: JobCenter + ConversationWorkbench (job monitoring + conversation workspace)
- Right: AgentsPanel (agent management)

Currently, creating a business agent opens a self-contained modal dialog inside
AgentsPanel with its own mini-chat interface. This is disconnected from the
main conversation flow and has limited UX (no timeline, no rich rendering, no
SSE streaming).

The goal is to move the agent authoring conversation into the
ConversationWorkbench (center column), reusing its multi-turn conversation
capabilities (timeline, message rendering, state management, SSE events).
Through the conversation, the AI guides the user to provide key agent fields
(name, prompt, description), and a save button creates the agent.

## Design Decisions

1. **Extend clarification sessions** with a `mode` field (`"agent_authoring"`)
   rather than creating a parallel session system.
2. **AI actively guides** the user with structured questions about business
   scenario, name, rules, and output boundaries.
3. **Inline draft preview cards** appear in the conversation timeline as the
   AI generates and updates the agent draft.
4. **Direct save** on click — no secondary confirmation dialog. On success,
   the right-side agent list refreshes and the session completes.

## Architecture

### Session Flow

```
User clicks "Create Business Agent" in AgentsPanel
       ↓
AgentsPanel calls conversation.startAuthoring()
       ↓
POST /api/clarifications { prompt: "请帮我创建一个业务智能体", mode: "agent_authoring" }
       ↓
ConversationWorkbench auto-selects the new session
       ↓
Backend runs clarification in agent_authoring mode:
  - Sends guided questions (business scenario, name, rules, boundaries)
  - User answers in multi-turn conversation
  - Backend generates/updates agent draft from conversation context
  - Draft pushed as agent_draft message to timeline
       ↓
Inline draft preview card renders in ConversationWorkbench timeline
       ↓
User clicks "Save Agent"
       ↓
POST /api/business-agents { name, key, prompt, description, enabled }
       ↓
Agent list refreshes, session marked complete
```

### State Mapping

| Clarification Status | agent_authoring Meaning        |
| -------------------- | ------------------------------ |
| `active`             | AI analyzing, generating draft |
| `waiting_user`       | Waiting for user input         |
| `ready_to_confirm`   | Draft ready, can save          |
| `confirmed`          | Agent saved                    |
| `abandoned`          | Creation abandoneded           |
| `failed`             | Error occurred                 |

### ConversationWorkbench Mode Awareness

When `session.mode === "agent_authoring"`:

- Footer shows "Save Agent" button instead of "Confirm and Generate"
- Timeline renders `agent_draft` preview cards (new timeline item type)
- Business agent selection chips are hidden (the session IS creating an agent)
- On save success, triggers agent list refresh

## Backend Changes

### Data Model

Add `mode` field to `clarifications` table:

```sql
ALTER TABLE clarifications ADD COLUMN mode TEXT NOT NULL DEFAULT '';
```

Values:

- `""` (empty string, default): normal requirement clarification
- `"agent_authoring"`: agent creation conversation

### API Changes

**`POST /api/clarifications`** — request body gains optional `mode`:

```json
{
  "prompt": "请帮我创建一个业务智能体",
  "mode": "agent_authoring"
}
```

All other clarification APIs remain unchanged. The backend handler branches on
`mode` to determine behavior.

### Clarification Handler Branching

When `mode === "agent_authoring"`:

**Guided questions:** After receiving the initial message, the AI sends
structured questions using the existing `question_group` message type:

1. Business scenario and focus areas
2. Agent name preference
3. Judgment criteria and output boundaries
4. Constraints and prohibitions

**Draft generation:** After user answers, the backend generates an agent draft
from the conversation context and pushes it as a new message kind:

```go
model.ClarificationMessage{
    Role:         "agent",
    Kind:         "agent_draft",
    Content:      "已根据对话更新智能体预览",
    MetadataJSON: `{"name":"...","key":"...","description":"...","prompt":"..."}`,
}
```

**Status flow differences:**

- `ready_to_confirm` means "draft is ready, user can save"
- `confirm` does NOT create a job — it marks the session as complete
- The actual agent is created by the frontend calling `POST /api/business-agents`

### New SSE Event

```
agent_authoring.draft.updated
```

Payload:

```json
{
  "session_id": "clr_xxx",
  "message_id": "msg_xxx",
  "data": {
    "name": "Maritime Alert Expert",
    "key": "maritime-alert-expert",
    "description": "...",
    "prompt": "..."
  }
}
```

### Existing Authoring API

The `/api/business-agent-authoring` endpoints are preserved for backward
compatibility. New functionality uses the clarification flow.

## Frontend Changes

### Component Change Summary

| Component / Hook          | Change                                                     |
| ------------------------- | ---------------------------------------------------------- |
| `AgentsPanel`             | Remove authoring modal; create button triggers callback    |
| `ConversationWorkbench`   | Add mode awareness; add draft preview card; mode-specific footer |
| `useConversationSessions` | Add `startAuthoring()` and `saveAuthoringAgent()` methods  |
| `conversationTimeline.js` | Add `agent_draft` timeline item type and SSE handler       |
| `App.jsx`                 | Wire authoring callbacks between agents and conversation   |

### AgentsPanel

Remove the entire authoring modal (`authoringOpen`, `authoring` state,
authoring dialog JSX and CSS). The create button calls `onStartAuthoring`
from the conversation hook:

```jsx
const openAuthoringDialog = () => {
  onStartAuthoring?.()
}
```

Props change:

- Remove: `onCreateAuthoringSession`, `onSendAuthoringMessage`
- Add: `onStartAuthoring`

### useConversationSessions

New methods:

```js
const startAuthoring = async () => {
  setSubmitting(true)
  try {
    const session = await factoryApi.createClarification(
      '请帮我创建一个业务智能体',
      { mode: 'agent_authoring' }
    )
    await refreshSessions()
    await selectSession(session.id)
    return session
  } finally {
    setSubmitting(false)
  }
}

const saveAuthoringAgent = async () => {
  const draft = currentAgentDraft // extracted from timeline
  const created = await factoryApi.createBusinessAgent({
    key: draft.key,
    name: draft.name,
    description: draft.description,
    prompt: draft.prompt,
    enabled: true,
  })
  await factoryApi.confirmClarification(state.session.id)
  await refreshSessions()
  return created
}
```

`startAuthoring` is exposed to AgentsPanel; `saveAuthoringAgent` is exposed
to ConversationWorkbench.

### ConversationWorkbench

Mode detection:

```jsx
const isAuthoringMode = session?.mode === 'agent_authoring'
```

Footer conditional rendering:

```jsx
{isAuthoringMode ? (
  canSaveDraft ? (
    <button className="primary" onClick={onSaveAuthoring} disabled={submitting}>
      <Save size={14} /> Save Agent
    </button>
  ) : (
    <p className="cw-terminal-hint">
      Please answer the questions above to generate the agent draft.
    </p>
  )
) : (
  canConfirm ? <button onClick={onConfirm}>Confirm and Generate</button> : null
)}
```

Business agent chips hidden in authoring mode:

```jsx
{!isAuthoringMode && businessAgents.length > 0 ? (
  <div className="cw-business-agents">...</div>
) : null}
```

New props:

- `onSaveAuthoring`: callback to save the agent
- `onRefreshAgents`: callback to refresh the agent list after save

### AgentDraftCard Component

New timeline item rendered inline in the conversation:

```jsx
function AgentDraftCard({ draft }) {
  return (
    <div className="cw-agent-draft">
      <strong>Agent Preview</strong>
      <dl>
        <div><dt>Name</dt><dd>{draft.name || '-'}</dd></div>
        <div><dt>Key</dt><dd>{draft.key || '-'}</dd></div>
        <div><dt>Description</dt><dd>{draft.description || '-'}</dd></div>
        <div><dt>Status</dt><dd>{draft.enabled === false ? 'Disabled' : 'Enabled'}</dd></div>
      </dl>
      <h4>Final Prompt</h4>
      <pre>{draft.prompt || 'Pending...'}</pre>
    </div>
  )
}
```

### conversationTimeline.js

New message type in `buildTimelineFromMessages`:

```js
if (msg.role === 'agent' && msg.kind === 'agent_draft') {
  const draft = parseJSON(msg.metadata_json)
  if (draft) {
    items.push({ id: msg.id, type: 'agent_draft', draft })
  }
}
```

New SSE event in `applyConversationEvent`:

```js
case 'agent_authoring.draft.updated':
  return applyAgentDraftEvent(state, ev)
```

### App.jsx

Wire authoring callbacks:

```jsx
const conversation = useConversationSessions()

<AgentsPanel
  onStartAuthoring={conversation.startAuthoring}
  // ... existing props (minus onCreateAuthoringSession, onSendAuthoringMessage)
/>

<ConversationWorkbench
  onSaveAuthoring={conversation.saveAuthoringAgent}
  onRefreshAgents={agents.refresh}
  // ... existing props
/>
```

## Error Handling

| Scenario                              | Handling                                                  |
| ------------------------------------- | --------------------------------------------------------- |
| Creating authoring session fails      | ConversationWorkbench shows error, user can retry         |
| AI guidance fails mid-conversation    | Session marked `failed`, "Retry" button shown             |
| Draft missing required fields         | "Save Agent" button disabled, prompt user to continue     |
| Saving agent fails (e.g. key conflict) | Workbench shows error message, user can modify and retry |
| Save succeeds                         | Agent list refreshes, session marked complete             |

## Testing

### Backend Tests (Go)

- Creating clarification with `mode: "agent_authoring"` succeeds
- Agent authoring mode generates guided questions
- `agent_draft` message is created and pushed correctly
- `confirm` in agent_authoring mode does NOT create a job
- Normal clarification mode is unaffected (regression)
- SSE event `agent_authoring.draft.updated` is emitted on draft change

### Frontend Logic Tests

- `conversationTimeline` handles `agent_draft` message type correctly
- `conversationTimeline` handles `agent_authoring.draft.updated` SSE event
- ConversationWorkbench renders correct buttons in authoring mode
- ConversationWorkbench hides business agent chips in authoring mode
- AgentDraftCard renders all draft fields correctly
- Save agent triggers agent list refresh

### Build Verification

```bash
(cd factory-server && go test ./...)
(cd sf-portal-mvp && npm run build)
```

## Out of Scope

- Removing the old `/api/business-agent-authoring` endpoints (kept for
  backward compatibility)
- Replacing `draftBusinessAgentFromText` with a real LLM call (current
  template-based approach is sufficient for this iteration)
- Editing existing agents through the authoring flow (create only)
- Real-time SSE streaming of AI analysis during authoring (refresh-based
  updates are sufficient)
- Agent deletion support

## Implementation Order

1. Backend: add `mode` field to clarification model and schema
2. Backend: branch clarification handler for `agent_authoring` mode
3. Backend: add `agent_draft` message kind and SSE event
4. Backend: add tests for new mode
5. Frontend: add `startAuthoring` and `saveAuthoringAgent` to hook
6. Frontend: add `agent_draft` timeline item type
7. Frontend: add mode awareness and AgentDraftCard to ConversationWorkbench
8. Frontend: remove authoring modal from AgentsPanel, wire new callbacks
9. Frontend: update App.jsx wiring
10. Run full test suite and build verification
