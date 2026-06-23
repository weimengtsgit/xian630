# Agent Authoring Dialog Design

**Date:** 2026-06-23
**Status:** Approved
**Approach:** A (Reuse Clarification API, request-response, no SSE)

## Problem

Currently, clicking "新建业务智能体" (+) takes over the center ConversationWorkbench for agent authoring. The user wants this flow to happen inside a modal dialog instead, keeping the center workbench available for its primary purpose (requirement clarification for application generation).

## Solution

A self-contained modal dialog with a simple chat-bubble UI. The dialog independently manages an `agent_authoring` clarification session via the existing Clarification API (request-response pattern, no SSE streaming). Through multi-turn conversation, the backend generates an agent draft. The user reviews the draft inline and saves the agent.

## Architecture

### New Files

| File | Purpose |
|---|---|
| `sf-portal-mvp/src/components/AgentAuthoringDialog.jsx` | Dialog component with chat-bubble UI |
| `sf-portal-mvp/src/components/AgentAuthoringDialog.css` | Dialog styles |
| `sf-portal-mvp/src/hooks/useAgentAuthoringDialog.js` | Hook managing dialog state and API calls |

### Modified Files

| File | Change |
|---|---|
| `sf-portal-mvp/src/components/AgentsPanel.jsx` | "+" button opens dialog instead of calling `onStartAuthoring`. Renders `<AgentAuthoringDialog />`. Receives `onRefreshAgents` prop. |
| `sf-portal-mvp/src/App.jsx` | Pass `onRefreshAgents={agents.refresh}` to `AgentsPanel`. |

### Data Flow

```
User clicks "+" in AgentsPanel
  → useAgentAuthoringDialog.openDialog()
  → Dialog opens with welcome message from AI

User types and sends a message
  → First message: factoryApi.createClarification(text, { mode: 'agent_authoring' })
    → Stores sessionId
  → Subsequent messages: factoryApi.sendClarificationMessage(sessionId, text)
  → factoryApi.getClarificationMessages(sessionId)
    → Parse messages into chat bubbles + draft card
  → Re-render dialog with updated messages

User clicks "保存智能体"
  → factoryApi.createBusinessAgent(draft)
  → factoryApi.confirmClarification(sessionId)
  → onRefreshAgents()
  → closeDialog()
```

### State Shape (useAgentAuthoringDialog)

```js
{
  open: boolean,          // dialog visibility
  messages: [             // chat messages for display
    {
      id: string,
      role: 'user' | 'agent',
      content: string,
      kind: string,       // 'agent_draft' | 'analysis_stream' | etc.
      draft: object|null  // parsed draft body when kind === 'agent_draft'
    }
  ],
  draft: object|null,     // latest agent draft (name, key, description, prompt, enabled)
  sessionId: string|null, // current clarification session ID
  sending: boolean,       // true while API call in-flight
  saving: boolean,        // true while save API call in-flight
  error: string|null,     // error message for display
}
```

## UI Design

### Layout

```
┌─────────────────────────────────────┐
│  创建业务智能体                  ✕   │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🤖 AI message (left-aligned) │    │
│  └─────────────────────────────┘    │
│                                     │
│       ┌──────────────────────────┐  │
│       │ User message (right)      │  │
│       └──────────────────────────┘  │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🤖 AI + inline draft card:   │    │
│  │ ┌───────────────────────┐   │    │
│  │ │ Name / Key / Desc      │   │    │
│  │ │ Prompt preview         │   │    │
│  │ └───────────────────────┘   │    │
│  └─────────────────────────────┘    │
│                                     │
├─────────────────────────────────────┤
│  [Input textarea]            [Send] │
│                                     │
│  [Cancel]            [Save Agent]   │
└─────────────────────────────────────┘
```

### Styling

- **Dialog dimensions:** width `min(520px, 90vw)`, max-height `min(600px, 80vh)`
- **Backdrop:** `rgba(0, 8, 14, 0.64)` (reuse existing `.agent-dialog-backdrop`)
- **AI bubbles:** left-aligned, blue left-border (`rgba(104, 221, 255, 0.5)`)
- **User bubbles:** right-aligned, green right-border (`rgba(127, 235, 155, 0.55)`)
- **Draft card:** embedded within AI bubble, slightly indented background
- **Input area:** single-line textarea + send icon button, Enter to send
- **Bottom bar:** Cancel (secondary) + Save Agent (primary, disabled until draft has name/key/prompt)
- **Auto-scroll:** new messages scroll into view
- **Color palette:** reuse existing dark theme from AgentsPanel.css

### Welcome Message

On dialog open, immediately display an AI welcome message:
> "你好！请描述你需要创建的业务智能体，包括业务场景、关注的数据和规则。"

This is a static frontend message, not an API call.

## Hook Logic

### `openDialog()`

1. Set `open = true`
2. Reset messages to `[{ id: 'welcome', role: 'agent', content: WELCOME_TEXT }]`
3. Reset draft, sessionId, error

### `closeDialog()`

1. Set `open = false`
2. Reset all state

### `sendMessage(text)`

1. Set `sending = true`, clear error
2. Append user message to messages
3. If no `sessionId`:
   - Call `factoryApi.createClarification(text, { mode: 'agent_authoring' })`
   - Store returned `session.id` as `sessionId`
4. Else:
   - Call `factoryApi.sendClarificationMessage(sessionId, text)`
5. Call `factoryApi.getClarificationMessages(sessionId)`
6. Parse response into messages array:
   - `role === 'user'` → user bubble
   - `role === 'agent'` + `kind === 'agent_draft'` → AI bubble + draft card (parse `metadata_json`)
   - `role === 'agent'` + other kind → AI text bubble
7. Extract latest draft from messages
8. Set `sending = false`
9. On error: set error message, keep input text

### `saveAgent()`

1. Guard: `draft` must have `name`, `key`, `prompt`
2. Set `saving = true`, clear error
3. Call `factoryApi.createBusinessAgent({ key, name, description, prompt, enabled: true })`
4. Call `factoryApi.confirmClarification(sessionId)`
5. Call `onRefreshAgents()` (passed from App)
6. Call `closeDialog()`
7. On error: set error, do NOT close dialog

### Message Parsing

```js
function parseMessages(apiMessages) {
  return apiMessages
    .filter(m => m.role === 'user' || m.role === 'agent')
    .map(m => {
      const item = { id: m.id, role: m.role, content: m.content, kind: m.kind }
      if (m.kind === 'agent_draft' && m.metadata_json) {
        try { item.draft = JSON.parse(m.metadata_json) } catch {}
      }
      return item
    })
}
```

## Error Handling

| Scenario | Behavior |
|---|---|
| Session creation fails | Red error bar at top of dialog body. User can retry by sending again. |
| Message send fails | Same as above. Input text preserved. |
| Save fails | Error bar shown. Dialog stays open. User can retry. |
| Draft missing fields | Save button disabled. Hint text: "请继续描述以完善智能体信息" |
| Network timeout | Standard fetch error, caught by try/catch, shown as error bar. |

## AgentsPanel Changes

```jsx
// Props addition
onRefreshAgents  // new prop, passed from App.jsx

// Handler change
const handleCreateBusinessAgent = () => {
  setPanelError('')
  openAuthoringDialog()  // from useAgentAuthoringDialog hook
}

// Render addition (at bottom of panel, before closing </div>)
<AgentAuthoringDialog
  onRefreshAgents={onRefreshAgents}
/>
```

The `onStartAuthoring` prop can be removed from AgentsPanel since it's no longer used.

## App.jsx Changes

```jsx
<AgentsPanel
  // ... existing props
  onRefreshAgents={agents.refresh}  // new prop
/>
```

The `conversation.startAuthoring` is still available in the hook but no longer wired to AgentsPanel. The center workbench's authoring mode code can remain for backward compatibility but is not triggered from the UI.

## Backend

**No backend changes required.** The dialog reuses:
- `POST /api/clarifications` with `{ mode: 'agent_authoring' }`
- `POST /api/clarifications/:id/messages`
- `GET /api/clarifications/:id/messages`
- `POST /api/business-agents`
- `POST /api/clarifications/:id/confirm`

## Out of Scope

- SSE streaming in the dialog (request-response is sufficient)
- Agent editing through the dialog
- Agent deletion
- Real LLM-based draft generation (current template-based heuristics remain)
- Modifying the center workbench's existing authoring mode code
