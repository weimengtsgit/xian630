# Conversation Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the conversation workbench, historical clarification sessions, generated-app deletion, and preset visibility controls described in `docs/superpowers/specs/2026-06-22-conversation-workbench-design.md`.

**Architecture:** Keep `clarification_sessions` and `clarification_messages` as the backend source of truth, add session-list and delete APIs, then replace the split `ClarificationPanel + ChatDialog` frontend with a session-aware `ConversationWorkbench`. Preserve `JobCenter` as the generation-task monitor and keep generated-app deletion separate from generation audit history.

**Tech Stack:** Go 1.x, `net/http`, SQLite via `modernc.org/sqlite`, React 18, Vite, plain CSS, Node assertion scripts.

---

## File Structure

Backend session work:

- Modify `factory-server/internal/store/clarifications.go`: add historical session listing.
- Modify `factory-server/internal/server/clarification_handlers.go`: add list handler and allow multiple active sessions.
- Modify `factory-server/internal/server/server.go`: add `GET /api/clarifications`.
- Modify `factory-server/internal/server/clarification_handlers_test.go`: cover listing and multi-active creation.

Backend generated-app deletion:

- Modify `factory-server/internal/store/applications.go`: add transactional delete helper for app/deployment rows.
- Modify `factory-server/internal/store/deployments.go`: add `DeleteDeploymentsByApp`.
- Modify `factory-server/internal/server/app_operations.go`: add `deleteApp` handler and path validation helpers.
- Modify `factory-server/internal/server/server.go`: add `DELETE /api/apps/:id`.
- Modify `factory-server/internal/server/app_operations_test.go`: cover generated-only deletion, path safety, audit preservation, and event publication.

Preset visibility:

- Create `factory-server/internal/scanner/preset_visibility.go`: parse project-local preset visibility config.
- Modify `factory-server/internal/scanner/scanner.go`: let scanner apply visibility filtering.
- Modify `factory-server/internal/server/app_handlers.go`: list only visible apps if visibility is represented at scan time.
- Modify `factory-server/internal/scanner/scanner_test.go`: cover hidden preset exclusion while generated apps remain visible.

Frontend conversation workbench:

- Modify `sf-portal-mvp/src/api/client.js`: add list/delete APIs.
- Modify `sf-portal-mvp/src/api/events.js`: subscribe to `app.deleted`.
- Create `sf-portal-mvp/src/hooks/conversationTimeline.js`: pure timeline reducer and SSE routing.
- Create `sf-portal-mvp/src/hooks/useConversationSessions.js`: session-aware clarification hook.
- Create `sf-portal-mvp/src/components/ConversationWorkbench.jsx`.
- Create `sf-portal-mvp/src/components/ConversationWorkbench.css`.
- Modify `sf-portal-mvp/src/App.jsx`: replace `ClarificationPanel` and `ChatDialog` with `ConversationWorkbench`.
- Modify `sf-portal-mvp/src/App.css`: remove `.clar-panel` middle-row allocation and size the workbench.
- Modify `sf-portal-mvp/src/hooks/useApplications.js`: add generated-app deletion action.
- Modify `sf-portal-mvp/src/components/ApplicationsPanel.jsx`: show delete controls only for generated apps.
- Modify `sf-portal-mvp/src/components/ApplicationsPanel.css`: style delete affordance and confirmation state.
- Create `sf-portal-mvp/scripts/check-conversation-workbench.mjs`.
- Modify `sf-portal-mvp/package.json`: include the new logic check.

Requirement clarification skill:

- Modify `.claude/skills/requirement-clarification/SKILL.md`: add brainstorming-style guidance while preserving the JSON contract.

## Task 1: Backend Historical Clarification Sessions

**Files:**

- Modify: `factory-server/internal/store/clarifications.go`
- Modify: `factory-server/internal/server/clarification_handlers.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/server/clarification_handlers_test.go`

- [ ] **Step 1: Add failing store tests for historical listing**

Append this test to `factory-server/internal/store/clarifications_test.go`:

```go
func TestListClarificationSessionsNewestFirst(t *testing.T) {
	st := newTestStore(t)
	base := time.Now()
	rows := []model.ClarificationSession{
		{ID: "clar_old", Status: model.ClarificationStatusWaitingUser, InitialPrompt: "old", Round: 1, MaxRounds: 3, RequirementJSON: `{"appName":"旧会话"}`, CreatedAt: base, UpdatedAt: base},
		{ID: "clar_new", Status: model.ClarificationStatusReadyToConfirm, InitialPrompt: "new", Round: 2, MaxRounds: 3, RequirementJSON: `{"appName":"新会话"}`, CreatedAt: base.Add(time.Second), UpdatedAt: base.Add(time.Second)},
	}
	for _, row := range rows {
		if err := st.CreateClarificationSession(context.Background(), row); err != nil {
			t.Fatalf("CreateClarificationSession(%s): %v", row.ID, err)
		}
	}

	got, err := st.ListClarificationSessions(context.Background(), 50)
	if err != nil {
		t.Fatalf("ListClarificationSessions: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2: %#v", len(got), got)
	}
	if got[0].ID != "clar_new" || got[1].ID != "clar_old" {
		t.Fatalf("order = %s,%s; want clar_new,clar_old", got[0].ID, got[1].ID)
	}
}
```

- [ ] **Step 2: Run the store test and verify it fails**

Run:

```bash
cd factory-server
go test ./internal/store -run TestListClarificationSessionsNewestFirst -count=1
```

Expected: FAIL with `st.ListClarificationSessions undefined`.

- [ ] **Step 3: Implement `ListClarificationSessions`**

Add this function to `factory-server/internal/store/clarifications.go`:

```go
// ListClarificationSessions returns clarification sessions newest-first.
// limit <= 0 defaults to 50; limit > 200 is capped to 200.
func (s *Store) ListClarificationSessions(ctx context.Context, limit int) ([]model.ClarificationSession, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT `+clarificationSessionCols+`
FROM clarification_sessions
ORDER BY updated_at DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.ClarificationSession{}
	for rows.Next() {
		cs, err := scanClarificationSession(rows)
		if err != nil {
			return nil, err
		}
		if cs != nil {
			out = append(out, *cs)
		}
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: Run the store test and verify it passes**

Run:

```bash
cd factory-server
go test ./internal/store -run TestListClarificationSessionsNewestFirst -count=1
```

Expected: PASS.

- [ ] **Step 5: Add failing server tests for list API and multi-active create**

In `factory-server/internal/server/clarification_handlers_test.go`, change
`TestCreateClarificationConflictReportsNormalizedActiveStatus` into a
multi-active test. Replace its conflict assertion body with:

```go
	second := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成另一个应用"})
	if second.Code != http.StatusCreated {
		t.Fatalf("second create status = %d body=%s, want 201", second.Code, second.Body.String())
	}
	var secondSess model.ClarificationSession
	if err := json.NewDecoder(second.Body).Decode(&secondSess); err != nil {
		t.Fatalf("decode second session: %v", err)
	}
	if secondSess.ID == sess.ID {
		t.Fatalf("second session reused active session id %q", sess.ID)
	}

	sessions, err := st.ListClarificationSessions(context.Background(), 50)
	if err != nil {
		t.Fatalf("ListClarificationSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("sessions = %#v, want 2", sessions)
	}
```

Also append this API test:

```go
func TestListClarificationsReturnsParsedRequirement(t *testing.T) {
	_, r, _ := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/clarifications?limit=50", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var views []clarificationView
	if err := json.NewDecoder(rec.Body).Decode(&views); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("len = %d, want 1", len(views))
	}
	if views[0].Requirement.AppName != "航母编队复盘应用" {
		t.Fatalf("appName = %q", views[0].Requirement.AppName)
	}
}
```

- [ ] **Step 6: Run the server clarification tests and verify they fail**

Run:

```bash
cd factory-server
go test ./internal/server -run 'TestCreateClarificationConflictReportsNormalizedActiveStatus|TestListClarificationsReturnsParsedRequirement' -count=1
```

Expected: FAIL because `POST /api/clarifications` still returns 409 and `GET /api/clarifications` has no route.

- [ ] **Step 7: Implement list handler and multi-active create behavior**

In `factory-server/internal/server/clarification_handlers.go`, remove the active-session conflict block from `createClarification`. Keep support for `AbandonActive` by changing the beginning of the active session branch to:

```go
	ctx := r.Context()
	if body.AbandonActive {
		if active, err := s.store.GetActiveClarificationSession(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "get active session")
			return
		} else if active != nil {
			if err := s.store.SetClarificationStatus(ctx, active.ID, model.ClarificationStatusAbandoned, "", ""); err != nil {
				writeError(w, http.StatusInternalServerError, "abandon active session")
				return
			}
			s.publishClarificationEvent(clarification.StreamEvent{
				Type:      "clarification.abandoned",
				SessionID: active.ID,
				Data:      active,
			})
		}
	}
```

Add the list handler near `getActiveClarification`:

```go
// listClarifications handles GET /api/clarifications.
func (s *Server) listClarifications(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	sessions, err := s.store.ListClarificationSessions(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list sessions")
		return
	}
	out := make([]clarificationView, 0, len(sessions))
	for i := range sessions {
		sess := sessions[i]
		out = append(out, s.viewFromSession(&sess))
	}
	writeJSON(w, http.StatusOK, out)
}
```

Add `strconv` to the imports in the same file.

In `factory-server/internal/server/server.go`, add the route before `/api/clarifications/active`:

```go
r.Handle("GET", "/api/clarifications", s.listClarifications)
```

- [ ] **Step 8: Run server tests and verify they pass**

Run:

```bash
cd factory-server
go test ./internal/server -run 'TestCreateClarificationConflictReportsNormalizedActiveStatus|TestListClarificationsReturnsParsedRequirement' -count=1
```

Expected: PASS.

- [ ] **Step 9: Run all backend tests for this task**

Run:

```bash
cd factory-server
go test ./...
```

Expected: PASS.

- [ ] **Step 10: Commit backend session API work**

Run:

```bash
git add factory-server/internal/store/clarifications.go factory-server/internal/store/clarifications_test.go factory-server/internal/server/clarification_handlers.go factory-server/internal/server/clarification_handlers_test.go factory-server/internal/server/server.go
git commit -m "feat: add clarification session history"
```

Expected: commit succeeds.

## Task 2: Frontend Conversation Timeline Logic

**Files:**

- Create: `sf-portal-mvp/src/hooks/conversationTimeline.js`
- Create: `sf-portal-mvp/scripts/check-conversation-workbench.mjs`
- Modify: `sf-portal-mvp/package.json`

- [ ] **Step 1: Write failing timeline logic tests**

Create `sf-portal-mvp/scripts/check-conversation-workbench.mjs`:

```js
import assert from 'node:assert/strict'
import {
  buildTimelineFromMessages,
  initialConversationState,
  applyConversationEvent,
  titleForSession,
} from '../src/hooks/conversationTimeline.js'

const session = {
  id: 'clar_1',
  status: 'waiting_user',
  initial_prompt: '生成一个航母编队复盘应用',
  requirement: { appName: '航母编队复盘应用', appType: 'situation_replay', coreScenario: '复盘近 1 个月航迹' },
}

assert.equal(titleForSession(session), '航母编队复盘应用')
assert.equal(titleForSession({ initial_prompt: 'x'.repeat(60), requirement: {} }).length <= 35, true)

const messages = [
  { id: 'u1', role: 'user', kind: 'prompt', content: '生成应用' },
  { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '识别到这是态势复盘类应用。' },
  {
    id: 'q1',
    role: 'agent',
    kind: 'question',
    content: '',
    metadata_json: JSON.stringify({ id: 'targetUsers', label: '用户', options: [{ value: 'ops', label: '作战参谋' }] }),
  },
  { id: 'ans1', role: 'user', kind: 'answer', content: 'ops', metadata_json: JSON.stringify({ questionId: 'targetUsers', value: 'ops' }) },
]
const timeline = buildTimelineFromMessages(messages, session)
assert.deepEqual(timeline.map(item => item.type), ['user_message', 'analysis_stream', 'question_group', 'user_message', 'requirement_summary'])
assert.equal(timeline[2].questions[0].id, 'targetUsers')

let state = initialConversationState()
state = { ...state, selectedSessionId: 'clar_1' }
state = applyConversationEvent(state, 'clarification.message.delta', {
  type: 'clarification.message.delta',
  session_id: 'clar_2',
  message_id: 'foreign',
  delta: 'must not enter current timeline',
})
assert.equal(state.timeline.length, 0)
assert.equal(state.sessionActivity.clar_2.status, 'updated')

state = applyConversationEvent(state, 'clarification.message.delta', {
  type: 'clarification.message.delta',
  session_id: 'clar_1',
  message_id: 'm1',
  delta: '本轮正在分析需求',
})
assert.equal(state.timeline.length, 1)
assert.equal(state.timeline[0].content, '本轮正在分析需求')

state = applyConversationEvent(state, 'clarification.question.created', {
  type: 'clarification.question.created',
  session_id: 'clar_1',
  data: { id: 'app_type', label: '应用类型', options: [{ value: 'command_dashboard', label: '指挥看板' }] },
})
assert.equal(state.questions.length, 1)
assert.equal(state.timeline.at(-1).type, 'question_group')

console.log('check-conversation-workbench: OK')
```

- [ ] **Step 2: Run the new script and verify it fails**

Run:

```bash
cd sf-portal-mvp
node scripts/check-conversation-workbench.mjs
```

Expected: FAIL with module not found for `conversationTimeline.js`.

- [ ] **Step 3: Implement pure timeline helpers**

Create `sf-portal-mvp/src/hooks/conversationTimeline.js`:

```js
export const initialConversationState = () => ({
  selectedSessionId: null,
  session: null,
  sessions: [],
  timeline: [],
  questions: [],
  requirement: null,
  blueprints: [],
  sessionActivity: {},
})

export function titleForSession(session) {
  const fromRequirement = session && session.requirement && session.requirement.appName
  const raw = String(fromRequirement || (session && session.initial_prompt) || '新会话').trim()
  if (raw.length <= 32) return raw
  return `${raw.slice(0, 32)}...`
}

export function buildTimelineFromMessages(messages = [], session = null) {
  const items = []
  for (const msg of messages || []) {
    if (msg.role === 'user') {
      items.push({
        id: msg.id,
        type: 'user_message',
        role: 'user',
        kind: msg.kind,
        content: msg.content || '',
        metadata: parseJSON(msg.metadata_json),
      })
      continue
    }
    if (msg.role === 'agent' && (msg.kind === 'analysis_work_log' || msg.kind === 'model_output')) {
      items.push({
        id: msg.id,
        type: 'analysis_stream',
        role: 'agent',
        kind: msg.kind,
        content: msg.content || '',
      })
      continue
    }
    if (msg.role === 'agent' && msg.kind === 'question') {
      const question = parseJSON(msg.metadata_json)
      if (question && question.id) {
        items.push({
          id: msg.id,
          type: 'question_group',
          questions: [question],
        })
      }
    }
  }
  const requirement = session && session.requirement
  if (requirement && (requirement.appName || requirement.appType || requirement.coreScenario)) {
    items.push({ id: `${session.id || 'draft'}_requirement`, type: 'requirement_summary', requirement })
  }
  return items
}

export function applyConversationEvent(state, type, ev) {
  const sessionId = ev && ev.session_id
  if (!sessionId) return state
  if (state.selectedSessionId && sessionId !== state.selectedSessionId) {
    return {
      ...state,
      sessionActivity: {
        ...state.sessionActivity,
        [sessionId]: { status: 'updated', lastType: type },
      },
    }
  }
  switch (type) {
    case 'clarification.message.started':
    case 'clarification.message.delta':
    case 'clarification.message.completed':
      return upsertAnalysisEvent(state, ev)
    case 'clarification.question.created':
      return appendQuestionEvent(state, ev)
    case 'clarification.summary.updated':
    case 'clarification.ready_to_confirm':
      return applyRequirementEvent(state, type, ev)
    case 'clarification.blueprint.recommended':
      return { ...state, blueprints: Array.isArray(ev.data) ? ev.data : ev.data ? [ev.data] : [] }
    case 'clarification.confirmed':
    case 'clarification.failed':
    case 'clarification.abandoned':
      return applyStatusEvent(state, type, ev)
    default:
      return state
  }
}

function upsertAnalysisEvent(state, ev) {
  const id = ev.message_id || `analysis_${state.timeline.length + 1}`
  const content =
    ev.delta != null
      ? ev.delta
      : ev.data && typeof ev.data.content === 'string'
        ? ev.data.content
        : ''
  const existing = state.timeline.findIndex(item => item.id === id)
  const item = { id, type: 'analysis_stream', role: 'agent', kind: 'analysis_work_log', content }
  if (existing === -1) return { ...state, timeline: [...state.timeline, item] }
  const next = state.timeline.slice()
  next[existing] = { ...next[existing], ...item }
  return { ...state, timeline: next }
}

function appendQuestionEvent(state, ev) {
  const q = ev.data
  if (!q || !q.id || state.questions.some(item => item.id === q.id)) return state
  const questions = [...state.questions, q]
  const withoutCurrentGroup = state.timeline.filter(item => item.type !== 'question_group' || item.live !== true)
  return {
    ...state,
    questions,
    timeline: [...withoutCurrentGroup, { id: `${ev.session_id}_questions_live`, type: 'question_group', live: true, questions }],
  }
}

function applyRequirementEvent(state, type, ev) {
  const requirement = ev.data || null
  const timeline = state.timeline.filter(item => item.type !== 'requirement_summary' || item.live !== true)
  return {
    ...state,
    requirement,
    questions: typeClearsQuestions(type) ? [] : state.questions,
    timeline: requirement ? [...timeline, { id: `${ev.session_id}_requirement_live`, type: 'requirement_summary', live: true, requirement }] : timeline,
  }
}

function applyStatusEvent(state, type, ev) {
  const status = type.replace('clarification.', '')
  const session = state.session ? { ...state.session, status } : state.session
  return {
    ...state,
    session,
    timeline: [...state.timeline, { id: `${ev.session_id}_${type}`, type: 'system_status', status, data: ev.data || null }],
  }
}

function typeClearsQuestions(type) {
  return type === 'clarification.ready_to_confirm'
}

function parseJSON(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the script and verify it passes**

Run:

```bash
cd sf-portal-mvp
node scripts/check-conversation-workbench.mjs
```

Expected: PASS with `check-conversation-workbench: OK`.

- [ ] **Step 5: Add script to `package.json`**

Modify `sf-portal-mvp/package.json` so `test:logic` includes the new script:

```json
"test:logic": "node scripts/check-job-selection.mjs && node scripts/check-application-ordering.mjs && node scripts/check-agent-creation.mjs && node scripts/check-clarification.mjs && node scripts/check-chat-input-sizing.mjs && node scripts/check-clarification-layout.mjs && node scripts/check-execution-record-state.mjs && node scripts/check-task-observability-layout.mjs && node scripts/check-conversation-workbench.mjs"
```

- [ ] **Step 6: Run frontend logic tests**

Run:

```bash
cd sf-portal-mvp
npm run test:logic
```

Expected: PASS.

- [ ] **Step 7: Commit pure frontend timeline logic**

Run:

```bash
git add sf-portal-mvp/src/hooks/conversationTimeline.js sf-portal-mvp/scripts/check-conversation-workbench.mjs sf-portal-mvp/package.json
git commit -m "feat: add conversation timeline logic"
```

Expected: commit succeeds.

## Task 3: Frontend Conversation Workbench Integration

**Files:**

- Create: `sf-portal-mvp/src/hooks/useConversationSessions.js`
- Create: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Create: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/api/events.js`
- Modify: `sf-portal-mvp/src/App.jsx`
- Modify: `sf-portal-mvp/src/App.css`
- Modify: `sf-portal-mvp/scripts/check-conversation-workbench.mjs`

- [ ] **Step 1: Extend API client**

Modify `sf-portal-mvp/src/api/client.js` by adding methods to `factoryApi`:

```js
listClarifications: limit => request(`/api/clarifications?limit=${limit || 50}`),
deleteApp: id => request(`/api/apps/${id}`, { method: 'DELETE' }),
```

- [ ] **Step 2: Subscribe to `app.deleted`**

In `sf-portal-mvp/src/api/events.js`, add `'app.deleted'` to the `types` array.

- [ ] **Step 3: Create session-aware hook**

Create `sf-portal-mvp/src/hooks/useConversationSessions.js`:

```js
import { useCallback, useEffect, useRef, useState } from 'react'
import { factoryApi } from '../api/client'
import { subscribeFactoryEvents } from '../api/events'
import {
  applyConversationEvent,
  buildTimelineFromMessages,
  initialConversationState,
} from './conversationTimeline'

const CLARIFICATION_TYPES = new Set([
  'clarification.created',
  'clarification.message.started',
  'clarification.message.delta',
  'clarification.message.completed',
  'clarification.question.created',
  'clarification.summary.updated',
  'clarification.blueprint.recommended',
  'clarification.ready_to_confirm',
  'clarification.confirmed',
  'clarification.failed',
  'clarification.abandoned',
])

const terminal = status => status === 'confirmed' || status === 'abandoned' || status === 'failed'

export function useConversationSessions() {
  const [state, setState] = useState(initialConversationState)
  const [error, setError] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const mountedRef = useRef(true)

  const refreshSessions = useCallback(async () => {
    const data = await factoryApi.listClarifications(50)
    const sessions = Array.isArray(data) ? data : data.sessions || []
    if (mountedRef.current) {
      setState(prev => ({ ...prev, sessions }))
    }
    return sessions
  }, [])

  const selectSession = useCallback(async id => {
    if (!id) {
      setState(prev => ({
        ...initialConversationState(),
        sessions: prev.sessions,
        selectedSessionId: null,
        session: null,
      }))
      return null
    }
    setError(null)
    const [session, messages] = await Promise.all([
      factoryApi.getClarification(id),
      factoryApi.getClarificationMessages(id),
    ])
    if (mountedRef.current) {
      setState(prev => ({
        ...prev,
        selectedSessionId: session.id,
        session,
        requirement: session.requirement || null,
        timeline: buildTimelineFromMessages(messages, session),
        questions: questionsFromMessages(messages, session.status),
        blueprints: [],
      }))
    }
    return session
  }, [])

  const newSession = useCallback(() => {
    setError(null)
    setState(prev => ({
      ...initialConversationState(),
      sessions: prev.sessions,
      selectedSessionId: null,
      session: null,
    }))
  }, [])

  const send = useCallback(async content => {
    const prompt = String(content || '').trim()
    if (!prompt || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      let session
      if (!state.session || terminal(state.session.status)) {
        session = await factoryApi.createClarification(prompt)
      } else {
        session = await factoryApi.sendClarificationMessage(state.session.id, prompt)
      }
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const answerBatch = useCallback(async answers => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.answerClarificationBatch(state.session.id, answers)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const confirm = useCallback(async () => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.confirmClarification(state.session.id)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } catch (err) {
      if (mountedRef.current) setError(err.message || String(err))
      throw err
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const retry = useCallback(async () => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.retryClarificationRound(state.session.id)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  const abandon = useCallback(async () => {
    if (!state.session || submitting) return null
    setSubmitting(true)
    setError(null)
    try {
      const session = await factoryApi.abandonClarification(state.session.id)
      await refreshSessions()
      await selectSession(session.id)
      return session
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [refreshSessions, selectSession, state.session, submitting])

  useEffect(() => {
    mountedRef.current = true
    refreshSessions().then(sessions => {
      if (sessions[0]) selectSession(sessions[0].id).catch(() => {})
    }).catch(err => {
      if (mountedRef.current) setError(err.message || String(err))
    })
    const unsubscribe = subscribeFactoryEvents((type, raw) => {
      if (!mountedRef.current || !CLARIFICATION_TYPES.has(type)) return
      const ev = raw && typeof raw === 'object' && 'seq' in raw ? raw.data : raw
      if (!ev) return
      setState(prev => applyConversationEvent(prev, type, ev))
      refreshSessions().catch(() => {})
    })
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [refreshSessions, selectSession])

  return {
    ...state,
    error,
    submitting,
    historyOpen,
    setHistoryOpen,
    refreshSessions,
    selectSession,
    newSession,
    send,
    answerBatch,
    confirm,
    retry,
    abandon,
  }
}

function questionsFromMessages(messages, status) {
  if (status === 'ready_to_confirm' || status === 'confirmed' || status === 'abandoned' || status === 'failed') return []
  const out = []
  const seen = new Set()
  for (const msg of messages || []) {
    if (msg.role !== 'agent' || msg.kind !== 'question' || !msg.metadata_json) continue
    try {
      const q = JSON.parse(msg.metadata_json)
      if (q && q.id && !seen.has(q.id)) {
        out.push(q)
        seen.add(q.id)
      }
    } catch {
      // Ignore malformed historical question metadata.
    }
  }
  return out
}
```

- [ ] **Step 4: Create the workbench component**

Create `sf-portal-mvp/src/components/ConversationWorkbench.jsx`:

```jsx
import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus, History, Send } from 'lucide-react'
import { titleForSession } from '../hooks/conversationTimeline'
import './ConversationWorkbench.css'

const STATUS_TEXT = {
  active: '分析中',
  waiting_user: '等待补充',
  ready_to_confirm: '待确认',
  confirmed: '已确认',
  failed: '已失败',
  abandoned: '已放弃',
}

export function ConversationWorkbench({
  session,
  sessions,
  timeline,
  questions,
  error,
  submitting,
  historyOpen,
  setHistoryOpen,
  onNewSession,
  onSelectSession,
  onSend,
  onAnswerBatch,
  onConfirm,
  onRetry,
  onAbandon,
}) {
  const [input, setInput] = useState('')
  const [draftAnswers, setDraftAnswers] = useState({})
  const canConfirm = session && session.status === 'ready_to_confirm'
  const activeQuestions = Array.isArray(questions) ? questions : []
  const completedAnswers = activeQuestions.filter(q => hasAnswer(draftAnswers[q.id])).length
  const canSubmitAnswers = activeQuestions.length > 0 && completedAnswers === activeQuestions.length && !submitting

  useEffect(() => {
    const ids = new Set(activeQuestions.map(q => q.id))
    setDraftAnswers(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))))
  }, [activeQuestions.map(q => q.id).join('|')])

  const submitText = async () => {
    const value = input.trim()
    if (!value || submitting) return
    setInput('')
    await onSend(value)
  }

  const submitAnswers = async () => {
    if (!canSubmitAnswers) return
    const answers = activeQuestions.map(q => {
      const value = draftAnswers[q.id]
      return { questionId: q.id, value: Array.isArray(value) ? JSON.stringify(value) : String(value || '') }
    })
    await onAnswerBatch(answers)
    setDraftAnswers({})
  }

  return (
    <section className="conversation-workbench">
      <header className="cw-header">
        <div className="cw-title">
          <span className="cw-kicker">会话工作台</span>
          <strong>{session ? titleForSession(session) : '新会话'}</strong>
        </div>
        <div className="cw-actions">
          {session ? <span className={`cw-status cw-status-${session.status}`}>{STATUS_TEXT[session.status] || session.status}</span> : null}
          <button type="button" className="cw-icon-btn" onClick={onNewSession} title="新建会话"><MessageSquarePlus size={16} /></button>
          <button type="button" className="cw-icon-btn" onClick={() => setHistoryOpen(true)} title="历史会话"><History size={16} /></button>
        </div>
      </header>

      <div className="cw-body">
        {timeline.length === 0 ? (
          <div className="cw-empty">输入需求后，模型会先进行需求分析和澄清。</div>
        ) : (
          timeline.map(item => (
            <TimelineItem key={item.id} item={item} draftAnswers={draftAnswers} setDraftAnswers={setDraftAnswers} />
          ))
        )}
      </div>

      {activeQuestions.length > 0 ? (
        <div className="cw-answer-bar">
          <span>已完成 {completedAnswers}/{activeQuestions.length}</span>
          <button type="button" disabled={!canSubmitAnswers} onClick={submitAnswers}>
            {submitting ? '处理中' : '提交本轮澄清'}
          </button>
        </div>
      ) : null}

      {error ? <div className="cw-error">{error}</div> : null}

      <footer className="cw-composer">
        {session && session.status === 'failed' ? <button type="button" onClick={onRetry} disabled={submitting}>重试本轮</button> : null}
        {session && session.status !== 'confirmed' && session.status !== 'abandoned' ? <button type="button" onClick={onAbandon} disabled={submitting}>放弃</button> : null}
        {canConfirm ? <button type="button" className="primary" onClick={onConfirm} disabled={submitting}>确认并生成</button> : null}
        <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="输入新需求或补充说明" disabled={submitting || canConfirm} />
        <button type="button" className="cw-send" onClick={submitText} disabled={!input.trim() || submitting || canConfirm}>
          {submitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
        </button>
      </footer>

      {historyOpen ? (
        <ConversationHistoryDrawer sessions={sessions} selectedId={session && session.id} onClose={() => setHistoryOpen(false)} onSelect={id => { onSelectSession(id); setHistoryOpen(false) }} />
      ) : null}
    </section>
  )
}

function TimelineItem({ item, draftAnswers, setDraftAnswers }) {
  if (item.type === 'user_message') return <div className="cw-item cw-user">{item.content}</div>
  if (item.type === 'analysis_stream') return <div className="cw-item cw-agent"><span className="cw-item-label">模型分析过程</span>{item.content}</div>
  if (item.type === 'requirement_summary') return <RequirementSummary requirement={item.requirement} />
  if (item.type === 'system_status') return <div className="cw-system">{item.status}</div>
  if (item.type === 'question_group') {
    return (
      <div className="cw-question-group">
        {item.questions.map(q => (
          <QuestionCard key={q.id} q={q} value={draftAnswers[q.id]} setValue={value => setDraftAnswers(prev => ({ ...prev, [q.id]: value }))} />
        ))}
      </div>
    )
  }
  return null
}

function QuestionCard({ q, value, setValue }) {
  const selected = Array.isArray(value) ? value : value ? [value] : []
  const optionValues = new Set((q.options || []).map(opt => opt.value))
  const customSelected = selected.filter(v => !optionValues.has(v))
  const choose = optValue => {
    if (q.multiSelect) {
      setValue(selected.includes(optValue) ? selected.filter(v => v !== optValue) : [...selected, optValue])
    } else {
      setValue(optValue)
    }
  }
  return (
    <div className="cw-question">
      <strong>{q.label || q.question || q.id}</strong>
      <div className="cw-options">
        {(q.options || []).map(opt => (
          <button key={opt.value} type="button" className={selected.includes(opt.value) ? 'selected' : ''} onClick={() => choose(opt.value)}>
            <span>{opt.label || opt.value}</span>
            {opt.reason ? <em>{opt.reason}</em> : null}
          </button>
        ))}
      </div>
      {q.allowCustom ? <CustomAnswer onSubmit={v => q.multiSelect ? setValue([...selected, v]) : setValue(v)} /> : null}
      {customSelected.length > 0 ? <div className="cw-custom-selected">{customSelected.join('、')}</div> : null}
    </div>
  )
}

function CustomAnswer({ onSubmit }) {
  const [value, setValue] = useState('')
  return <div className="cw-custom"><input value={value} onChange={e => setValue(e.target.value)} /><button type="button" onClick={() => { if (value.trim()) { onSubmit(value.trim()); setValue('') } }}>添加</button></div>
}

function RequirementSummary({ requirement }) {
  const rows = [
    ['应用类型', requirement.appType],
    ['应用名称', requirement.appName],
    ['核心场景', requirement.coreScenario],
    ['主视图', requirement.primaryView],
    ['数据策略', requirement.dataPolicy],
  ].filter(([, value]) => value)
  return <div className="cw-summary"><strong>确认需求摘要</strong>{rows.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
}

function ConversationHistoryDrawer({ sessions, selectedId, onClose, onSelect }) {
  const list = Array.isArray(sessions) ? sessions : []
  return (
    <aside className="cw-history">
      <header><strong>历史会话</strong><button type="button" onClick={onClose}>关闭</button></header>
      {list.map(sess => (
        <button key={sess.id} type="button" className={sess.id === selectedId ? 'active' : ''} onClick={() => onSelect(sess.id)}>
          <span>{titleForSession(sess)}</span>
          <em>{STATUS_TEXT[sess.status] || sess.status}</em>
        </button>
      ))}
    </aside>
  )
}

function hasAnswer(value) {
  return Array.isArray(value) ? value.length > 0 : value != null && value !== ''
}
```

- [ ] **Step 5: Add workbench CSS**

Create `sf-portal-mvp/src/components/ConversationWorkbench.css`:

```css
.conversation-workbench {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: rgba(11, 29, 44, 0.84);
  border: 1px solid rgba(111, 218, 255, 0.24);
  border-radius: 8px;
  overflow: hidden;
}
.cw-header, .cw-composer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(9, 24, 38, 0.94);
  border-bottom: 1px solid rgba(111, 218, 255, 0.18);
}
.cw-composer {
  border-top: 1px solid rgba(111, 218, 255, 0.18);
  border-bottom: 0;
}
.cw-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cw-title strong { color: #edfaff; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-kicker { font-size: 11px; color: rgba(104, 221, 255, 0.7); }
.cw-actions { display: flex; align-items: center; gap: 6px; }
.cw-icon-btn, .cw-send, .cw-composer button, .cw-answer-bar button {
  border: 1px solid rgba(111, 218, 255, 0.32);
  background: rgba(11, 29, 44, 0.72);
  color: #d7eef8;
  border-radius: 6px;
  cursor: pointer;
}
.cw-icon-btn { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; }
.cw-status { font-size: 11px; color: #68ddff; }
.cw-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.cw-empty { margin: auto; color: rgba(215, 238, 248, 0.58); font-size: 13px; }
.cw-item { max-width: 86%; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.45; }
.cw-user { align-self: flex-end; background: rgba(104, 221, 255, 0.18); color: #edfaff; }
.cw-agent { align-self: flex-start; background: rgba(3, 17, 29, 0.74); border: 1px solid rgba(111, 218, 255, 0.16); color: #d7eef8; }
.cw-item-label { display: block; color: #68ddff; font-size: 11px; margin-bottom: 4px; }
.cw-system { align-self: center; color: rgba(215, 238, 248, 0.55); font-size: 11px; }
.cw-question-group, .cw-summary { border: 1px solid rgba(111, 218, 255, 0.18); border-radius: 8px; padding: 10px; background: rgba(11, 29, 44, 0.55); }
.cw-question { display: flex; flex-direction: column; gap: 8px; }
.cw-options { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-options button { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 6px 9px; border-radius: 6px; border: 1px solid rgba(111, 218, 255, 0.28); background: rgba(3, 17, 29, 0.7); color: #d7eef8; }
.cw-options button.selected { border-color: rgba(104, 221, 255, 0.78); background: rgba(25, 83, 112, 0.58); }
.cw-options em { color: rgba(215, 238, 248, 0.58); font-style: normal; font-size: 11px; }
.cw-summary { display: grid; gap: 5px; font-size: 12px; }
.cw-summary div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; }
.cw-summary span { color: rgba(215, 238, 248, 0.55); }
.cw-summary b { color: #edfaff; font-weight: 500; }
.cw-answer-bar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 6px 12px; border-top: 1px solid rgba(111, 218, 255, 0.14); font-size: 12px; }
.cw-error { padding: 6px 12px; color: #ff9a9a; background: rgba(255, 102, 94, 0.08); font-size: 12px; }
.cw-composer textarea { flex: 1; min-height: 42px; max-height: 120px; resize: vertical; border-radius: 6px; border: 1px solid rgba(111, 218, 255, 0.24); background: rgba(3, 17, 29, 0.8); color: #edfaff; padding: 8px; font-family: inherit; }
.cw-send { width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; }
.cw-history { position: absolute; top: 45px; right: 10px; bottom: 62px; width: 320px; z-index: 8; background: rgba(9, 24, 38, 0.98); border: 1px solid rgba(111, 218, 255, 0.32); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35); }
.cw-history header { display: flex; justify-content: space-between; align-items: center; }
.cw-history > button { text-align: left; padding: 8px; border-radius: 6px; border: 1px solid rgba(111, 218, 255, 0.18); background: rgba(11, 29, 44, 0.72); color: #d7eef8; display: flex; flex-direction: column; gap: 3px; }
.cw-history > button.active { border-color: rgba(104, 221, 255, 0.66); }
.cw-history em { font-style: normal; font-size: 11px; color: rgba(215, 238, 248, 0.58); }
.cw-custom { display: flex; gap: 6px; }
.cw-custom input { min-width: 0; flex: 1; }
.cw-custom-selected { color: rgba(215, 238, 248, 0.68); font-size: 11px; }
```

- [ ] **Step 6: Wire App.jsx**

In `sf-portal-mvp/src/App.jsx`:

1. Remove imports for `ClarificationPanel`, `ChatDialog`, and `useClarification`.
2. Add:

```js
import { ConversationWorkbench } from './components/ConversationWorkbench'
import { useConversationSessions } from './hooks/useConversationSessions'
```

3. Replace `const clarification = useClarification()` with:

```js
const conversation = useConversationSessions()
```

4. Update `regenerateApplication`:

```js
conversation
  .send(`基于已有应用「${name}」重新生成一个更完整的版本，保留原有主题和运行形态，并改进页面效果与交互。`)
  .catch(() => {})
```

5. Replace the `ClarificationPanel` and `ChatDialog` JSX with:

```jsx
<ConversationWorkbench
  session={conversation.session}
  sessions={conversation.sessions}
  timeline={conversation.timeline}
  questions={conversation.questions}
  error={conversation.error || jobs.error}
  submitting={conversation.submitting}
  historyOpen={conversation.historyOpen}
  setHistoryOpen={conversation.setHistoryOpen}
  onNewSession={conversation.newSession}
  onSelectSession={conversation.selectSession}
  onSend={prompt => {
    if (jobs.activeJob && jobs.activeJob.status === 'waiting_user') {
      return jobs.answerJob(jobs.activeJob.id, prompt)
    }
    return conversation.send(prompt)
  }}
  onAnswerBatch={conversation.answerBatch}
  onConfirm={conversation.confirm}
  onRetry={conversation.retry}
  onAbandon={conversation.abandon}
/>
```

- [ ] **Step 7: Update center layout CSS**

In `sf-portal-mvp/src/App.css`, remove the `.wb-center > .clar-panel` and `.wb-center > .chat-dock` blocks. Add:

```css
.wb-center > .conversation-workbench {
  flex: 1 1 0;
  min-height: 360px;
}
```

- [ ] **Step 8: Extend layout logic script**

In `sf-portal-mvp/scripts/check-conversation-workbench.mjs`, append:

```js
import { readFileSync } from 'node:fs'

const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')

assert.match(appJsx, /<ConversationWorkbench/, 'App must render ConversationWorkbench')
assert.doesNotMatch(appJsx, /<ClarificationPanel/, 'App must not render the old ClarificationPanel')
assert.doesNotMatch(appJsx, /<ChatDialog/, 'App must not render the old ChatDialog')
assert.match(appCss, /\.wb-center\s*>\s*\.conversation-workbench/, 'center column must allocate space to ConversationWorkbench')
assert.match(workbenchJsx, /历史会话/, 'ConversationWorkbench must expose historical sessions')
assert.match(workbenchJsx, /新建会话/, 'ConversationWorkbench must expose new session action')
assert.match(workbenchJsx, /模型分析过程/, 'ConversationWorkbench must label user-facing model analysis process')
```

- [ ] **Step 9: Run frontend tests and build**

Run:

```bash
cd sf-portal-mvp
npm run test:logic
npm run build
```

Expected: both PASS.

- [ ] **Step 10: Commit workbench integration**

Run:

```bash
git add sf-portal-mvp/src/api/client.js sf-portal-mvp/src/api/events.js sf-portal-mvp/src/hooks/useConversationSessions.js sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/src/App.jsx sf-portal-mvp/src/App.css sf-portal-mvp/scripts/check-conversation-workbench.mjs
git commit -m "feat: replace clarification panel with conversation workbench"
```

Expected: commit succeeds.

## Task 4: Generated Application Deletion

**Files:**

- Modify: `factory-server/internal/store/applications.go`
- Modify: `factory-server/internal/store/deployments.go`
- Modify: `factory-server/internal/server/app_operations.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/server/app_operations_test.go`
- Modify: `sf-portal-mvp/src/hooks/useApplications.js`
- Modify: `sf-portal-mvp/src/components/ApplicationsPanel.jsx`
- Modify: `sf-portal-mvp/src/components/ApplicationsPanel.css`

- [ ] **Step 1: Add failing backend delete tests**

Append these tests to `factory-server/internal/server/app_operations_test.go`:

```go
func TestDeleteGeneratedAppRemovesDirectoryRowsAndPublishesEvent(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	root := srv.cfg.WorkspaceRoot
	appDir := filepath.Join(root, "generated-apps", "demo-delete")
	if err := os.MkdirAll(filepath.Join(appDir, ".factory"), 0o755); err != nil {
		t.Fatalf("mkdir app dir: %v", err)
	}
	now := time.Now()
	app := model.Application{
		ID: "app-demo-delete", Slug: "demo-delete", Name: "Demo Delete", Type: "command_dashboard",
		Source: model.AppSourceGenerated, Path: "generated-apps/demo-delete",
		ManifestPath: "generated-apps/demo-delete/.factory/app.json", Status: model.AppStatusRunning,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := srv.store.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("seed app: %v", err)
	}
	dep := model.Deployment{ID: "dep_delete", AppID: app.ID, ContainerName: "sf-demo-delete", Status: "running", CreatedAt: now}
	if err := srv.store.CreateDeployment(context.Background(), dep); err != nil {
		t.Fatalf("seed dep: %v", err)
	}
	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	req := httptest.NewRequest(http.MethodDelete, "/api/apps/app-demo-delete", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(appDir); !os.IsNotExist(err) {
		t.Fatalf("app dir still exists or stat failed differently: %v", err)
	}
	got, err := srv.store.GetApplication(context.Background(), app.ID)
	if err != nil {
		t.Fatalf("get app: %v", err)
	}
	if got != nil {
		t.Fatalf("app row still exists: %#v", got)
	}
	deps, err := srv.store.ListDeploymentsByApp(context.Background(), app.ID)
	if err != nil {
		t.Fatalf("list deps: %v", err)
	}
	if len(deps) != 0 {
		t.Fatalf("deployments still exist: %#v", deps)
	}
	if !hasCall(fr.calls, "podman", "rm", "sf-demo-delete") {
		t.Fatalf("expected podman rm for running container; calls=%v", fr.calls)
	}
	expectEvent(t, ch, "app.deleted")
}

func TestDeleteRejectsPresetApp(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	_, r := newOpsServer(t, fr)
	req := httptest.NewRequest(http.MethodDelete, "/api/apps/app-east-sea-situation", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409", rec.Code, rec.Body.String())
	}
}

func TestDeleteRejectsGeneratedAppOutsideGeneratedRoot(t *testing.T) {
	fr := &srvRunner{failIdx: -1}
	srv, r := newOpsServer(t, fr)
	now := time.Now()
	app := model.Application{
		ID: "app-bad", Slug: "bad", Name: "Bad", Source: model.AppSourceGenerated,
		Type: "command_dashboard", Path: "../outside", ManifestPath: "generated-apps/bad/.factory/app.json",
		Status: model.AppStatusStopped, CreatedAt: now, UpdatedAt: now,
	}
	if err := srv.store.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("seed app: %v", err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/apps/app-bad", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s, want 403", rec.Code, rec.Body.String())
	}
	got, _ := srv.store.GetApplication(context.Background(), app.ID)
	if got == nil {
		t.Fatalf("unsafe app row was deleted")
	}
}
```

Add `os` to this test file's imports.

- [ ] **Step 2: Run delete tests and verify they fail**

Run:

```bash
cd factory-server
go test ./internal/server -run 'TestDeleteGeneratedApp|TestDeleteRejects' -count=1
```

Expected: FAIL because `DELETE /api/apps/:id` returns 404.

- [ ] **Step 3: Add store delete helpers**

In `factory-server/internal/store/deployments.go`, add:

```go
// DeleteDeploymentsByApp deletes all deployment rows for an app.
func (s *Store) DeleteDeploymentsByApp(ctx context.Context, appID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM deployments WHERE app_id = ?`, appID)
	return err
}
```

In `factory-server/internal/store/applications.go`, add:

```go
// DeleteApplication deletes an application row by id.
func (s *Store) DeleteApplication(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM applications WHERE id = ?`, id)
	return err
}
```

- [ ] **Step 4: Add delete handler**

In `factory-server/internal/server/app_operations.go`, add imports `errors`, `os`, and `strings`.

Add this handler and helpers:

```go
func (s *Server) deleteApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")
	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if app.Source != model.AppSourceGenerated {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "only generated apps can be deleted"})
		return
	}
	appDir, err := s.safeGeneratedAppDir(*app)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": err.Error()})
		return
	}

	ctx := r.Context()
	deps, err := s.store.ListDeploymentsByApp(ctx, appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list deployments")
		return
	}
	pod := deploy.NewPodman(s.runner)
	for _, dep := range deps {
		if dep.ContainerName == "" {
			continue
		}
		_, _ = pod.StopContainer(ctx, dep.ContainerName)
		_, _ = pod.RemoveContainer(ctx, dep.ContainerName)
	}

	tombstone := ""
	if _, err := os.Stat(appDir); err == nil {
		tombstone = filepath.Join(s.cfg.ArtifactRoot, "deleted-apps", app.ID+"-"+app.Slug)
		if !filepath.IsAbs(tombstone) {
			tombstone = filepath.Join(s.cfg.WorkspaceRoot, tombstone)
		}
		_ = os.RemoveAll(tombstone)
		if err := os.MkdirAll(filepath.Dir(tombstone), 0o755); err != nil {
			writeError(w, http.StatusInternalServerError, "prepare tombstone")
			return
		}
		if err := os.Rename(appDir, tombstone); err != nil {
			writeError(w, http.StatusInternalServerError, "move app directory")
			return
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusInternalServerError, "stat app directory")
		return
	}

	if err := s.store.DeleteDeploymentsByApp(ctx, appID); err != nil {
		restoreTombstone(tombstone, appDir)
		writeError(w, http.StatusInternalServerError, "delete deployments")
		return
	}
	if err := s.store.DeleteApplication(ctx, appID); err != nil {
		restoreTombstone(tombstone, appDir)
		writeError(w, http.StatusInternalServerError, "delete app")
		return
	}
	if tombstone != "" {
		_ = os.RemoveAll(tombstone)
	}
	s.hub.Publish(Event{Type: "app.deleted", Data: map[string]string{"id": app.ID, "slug": app.Slug}})
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": app.ID, "slug": app.Slug})
}

func (s *Server) safeGeneratedAppDir(app model.Application) (string, error) {
	root := s.cfg.WorkspaceRoot
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	path := app.Path
	if path == "" {
		path = filepath.Join("generated-apps", app.Slug)
	}
	if filepath.IsAbs(path) {
		return "", errors.New("generated app path must be workspace-relative")
	}
	cleanRel := filepath.Clean(path)
	wantRel := filepath.Join("generated-apps", app.Slug)
	if cleanRel != wantRel {
		return "", errors.New("generated app path does not match generated-apps slug")
	}
	absDir, err := filepath.Abs(filepath.Join(absRoot, cleanRel))
	if err != nil {
		return "", err
	}
	prefix := filepath.Join(absRoot, "generated-apps") + string(os.PathSeparator)
	if !strings.HasPrefix(absDir+string(os.PathSeparator), prefix) {
		return "", errors.New("generated app path escapes generated-apps root")
	}
	return absDir, nil
}

func restoreTombstone(tombstone, appDir string) {
	if tombstone == "" || appDir == "" {
		return
	}
	_ = os.Rename(tombstone, appDir)
}
```

In `factory-server/internal/server/server.go`, add:

```go
r.Handle("DELETE", "/api/apps/:id", s.deleteApp)
```

- [ ] **Step 5: Run delete tests and verify they pass**

Run:

```bash
cd factory-server
go test ./internal/server -run 'TestDeleteGeneratedApp|TestDeleteRejects' -count=1
```

Expected: PASS.

- [ ] **Step 6: Add frontend delete action**

In `sf-portal-mvp/src/hooks/useApplications.js`, update the SSE condition to refresh on `app.deleted`, and add:

```js
const deleteApplication = useCallback(id => runAction(id, factoryApi.deleteApp, 'delete'), [runAction])
```

Return `deleteApplication`.

In `sf-portal-mvp/src/components/ApplicationsPanel.jsx`:

1. Import `Trash2`.
2. Add `onDelete` to props.
3. Add `delete: '删除中'` to `ACTION_TEXT`.
4. Render this button inside generated app cards:

```jsx
{isGenerated(app) && (
  <button
    type="button"
    className="card-btn danger-btn"
    onClick={() => {
      if (window.confirm(`确认删除生成应用「${app.name || app.slug}」？本地生成目录会被删除，生成审计记录会保留。`)) {
        onDelete && onDelete(app.id)
      }
    }}
    title="删除生成应用"
    disabled={busy}
  >
    {action === 'delete' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
    {action === 'delete' ? ACTION_TEXT[action] : '删除'}
  </button>
)}
```

In `sf-portal-mvp/src/App.jsx`, pass:

```jsx
onDelete={apps.deleteApplication}
```

- [ ] **Step 7: Extend frontend logic check**

In `sf-portal-mvp/scripts/check-conversation-workbench.mjs`, append:

```js
const appsPanelJsx = readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const useApplicationsJs = readFileSync(new URL('../src/hooks/useApplications.js', import.meta.url), 'utf8')
assert.match(appsPanelJsx, /Trash2/, 'ApplicationsPanel must use a delete icon')
assert.match(appsPanelJsx, /isGenerated\(app\)[\s\S]*删除/, 'delete control must be gated to generated apps')
assert.match(useApplicationsJs, /deleteApplication/, 'useApplications must expose deleteApplication')
assert.match(useApplicationsJs, /app\.deleted/, 'useApplications must refresh on app.deleted')
```

- [ ] **Step 8: Run backend and frontend verification**

Run:

```bash
cd factory-server
go test ./...
cd ../sf-portal-mvp
npm run test:logic
npm run build
```

Expected: all PASS.

- [ ] **Step 9: Commit generated-app deletion**

Run:

```bash
git add factory-server/internal/store/applications.go factory-server/internal/store/deployments.go factory-server/internal/server/app_operations.go factory-server/internal/server/server.go factory-server/internal/server/app_operations_test.go sf-portal-mvp/src/hooks/useApplications.js sf-portal-mvp/src/components/ApplicationsPanel.jsx sf-portal-mvp/src/App.jsx sf-portal-mvp/scripts/check-conversation-workbench.mjs sf-portal-mvp/src/api/client.js sf-portal-mvp/src/api/events.js
git commit -m "feat: delete generated applications"
```

Expected: commit succeeds.

## Task 5: Preset Application Visibility

**Files:**

- Create: `factory-server/internal/scanner/preset_visibility.go`
- Modify: `factory-server/internal/scanner/scanner.go`
- Modify: `factory-server/internal/scanner/scanner_test.go`

- [ ] **Step 1: Add failing scanner visibility test**

Append this test to `factory-server/internal/scanner/scanner_test.go`:

```go
func TestScannerHidesConfiguredPresetApps(t *testing.T) {
	root := t.TempDir()
	writeManifest := func(rel, source, slug string) {
		t.Helper()
		path := filepath.Join(root, rel, ".factory")
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatalf("mkdir manifest dir: %v", err)
		}
		raw := fmt.Sprintf(`{"schemaVersion":1,"slug":%q,"name":%q,"type":"command_dashboard","source":%q,"entry":"static-vite","path":%q}`, slug, slug, source, rel)
		if err := os.WriteFile(filepath.Join(path, "app.json"), []byte(raw), 0o644); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
	}
	writeManifest("scene/hidden-preset", "preset", "hidden-preset")
	writeManifest("scene/visible-preset", "preset", "visible-preset")
	writeManifest("generated-apps/generated-demo", "generated", "generated-demo")
	if err := os.MkdirAll(filepath.Join(root, ".factory"), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	config := `{"presetApps":{"hidden-preset":{"showInAppList":false},"visible-preset":{"showInAppList":true}}}`
	if err := os.WriteFile(filepath.Join(root, ".factory", "preset-apps.json"), []byte(config), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	apps, err := Scanner{Root: root}.Scan(context.Background())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	slugs := make([]string, 0, len(apps))
	for _, app := range apps {
		slugs = append(slugs, app.Slug)
	}
	if containsString(slugs, "hidden-preset") {
		t.Fatalf("hidden preset was returned: %v", slugs)
	}
	if !containsString(slugs, "visible-preset") || !containsString(slugs, "generated-demo") {
		t.Fatalf("visible apps missing: %v", slugs)
	}
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
```

If `scanner_test.go` already has a helper equivalent to `containsString`, reuse that helper instead of adding a duplicate.

- [ ] **Step 2: Run scanner test and verify it fails**

Run:

```bash
cd factory-server
go test ./internal/scanner -run TestScannerHidesConfiguredPresetApps -count=1
```

Expected: FAIL because hidden preset is still returned.

- [ ] **Step 3: Implement visibility config**

Create `factory-server/internal/scanner/preset_visibility.go`:

```go
package scanner

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type presetVisibilityConfig struct {
	PresetApps map[string]struct {
		ShowInAppList *bool `json:"showInAppList"`
	} `json:"presetApps"`
}

func loadPresetVisibility(root string) map[string]bool {
	path := filepath.Join(root, ".factory", "preset-apps.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]bool{}
	}
	var cfg presetVisibilityConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return map[string]bool{}
	}
	out := map[string]bool{}
	for slug, entry := range cfg.PresetApps {
		if entry.ShowInAppList != nil {
			out[slug] = *entry.ShowInAppList
		}
	}
	return out
}
```

In `factory-server/internal/scanner/scanner.go`, load and apply the config:

```go
visibility := loadPresetVisibility(s.Root)
```

Place it before the `for _, pattern := range manifestGlobs` loop.

After manifest validation and duplicate-slug check, skip hidden preset apps:

```go
if m.Source == "preset" {
	if show, ok := visibility[m.Slug]; ok && !show {
		continue
	}
}
```

Keep duplicate slug detection before the visibility skip so two manifests with
the same slug still fail deterministically.

- [ ] **Step 4: Run scanner tests**

Run:

```bash
cd factory-server
go test ./internal/scanner -count=1
```

Expected: PASS.

- [ ] **Step 5: Run full backend tests**

Run:

```bash
cd factory-server
go test ./...
```

Expected: PASS.

- [ ] **Step 6: Commit preset visibility**

Run:

```bash
git add factory-server/internal/scanner/preset_visibility.go factory-server/internal/scanner/scanner.go factory-server/internal/scanner/scanner_test.go
git commit -m "feat: configure preset app visibility"
```

Expected: commit succeeds.

## Task 6: Requirement Clarification Skill Brainstorming Guidance

**Files:**

- Modify: `.claude/skills/requirement-clarification/SKILL.md`
- Modify: `factory-server/internal/clarification/runner_test.go`

- [ ] **Step 1: Add a contract assertion to the runner test**

Append this assertion inside `TestRunnerWritesArtifactsAndNormalizesEvents` after reading `prompt.md` or add a new test that reads the generated prompt:

```go
promptRaw, err := os.ReadFile(filepath.Join(root, ".factory-runs", "clarifications", "clar_1", "round-1", "prompt.md"))
if err != nil {
	t.Fatalf("read prompt.md: %v", err)
}
promptText := string(promptRaw)
if !strings.Contains(promptText, "requirement-clarification") {
	t.Fatalf("prompt should reference requirement-clarification skill: %s", promptText)
}
```

This pins the runner to the project-local skill; the behavior change itself
lives in the skill file.

- [ ] **Step 2: Update the skill rules**

In `.claude/skills/requirement-clarification/SKILL.md`, add this section after
`# Requirement Clarification`:

```md
## Brainstorming Method

Use a lightweight brainstorming loop inside each clarification round:

1. Restate the user's intent in product terms.
2. Identify the smallest missing decision that blocks a confirmed requirement.
3. Ask at most three high-value questions in the round.
4. For every question, provide a recommended answer and a concise reason.
5. When there are meaningful product directions, describe the trade-off in
   `workLog` and encode the options as structured `questions`.
6. When enough information is present, stop asking and return
   `ready_to_confirm` with a complete `requirement`.

The `workLog` is the user-facing model analysis process. It must explain what
was identified, why an option is recommended, and what remains unconfirmed. It
must not expose hidden chain-of-thought.
```

- [ ] **Step 3: Run clarification runner tests**

Run:

```bash
cd factory-server
go test ./internal/clarification -count=1
```

Expected: PASS.

- [ ] **Step 4: Commit skill guidance**

Run:

```bash
git add .claude/skills/requirement-clarification/SKILL.md factory-server/internal/clarification/runner_test.go
git commit -m "docs: guide clarification brainstorming"
```

Expected: commit succeeds.

## Task 7: Final Verification

**Files:**

- Read: `docs/superpowers/specs/2026-06-22-conversation-workbench-design.md`
- Read: `docs/superpowers/plans/2026-06-22-conversation-workbench-implementation.md`

- [ ] **Step 1: Run backend tests**

Run:

```bash
cd factory-server
go test ./...
```

Expected: PASS.

- [ ] **Step 2: Run frontend logic tests**

Run:

```bash
cd sf-portal-mvp
npm run test:logic
```

Expected: PASS.

- [ ] **Step 3: Run frontend production build**

Run:

```bash
cd sf-portal-mvp
npm run build
```

Expected: PASS.

- [ ] **Step 4: Inspect git state**

Run:

```bash
git status --short
```

Expected: no tracked-file modifications. Existing unrelated untracked generated app directories may remain untracked.

## Self-Review

Spec coverage:

- Conversation workbench layout: Task 3.
- Historical sessions and multiple unfinished sessions: Task 1 and Task 3.
- Session-scoped SSE routing and timeline model: Task 2 and Task 3.
- Brainstorming guidance in local requirement clarification skill: Task 6.
- Generated-app deletion without audit cascade: Task 4.
- Preset visibility separated from blueprint availability: Task 5.
- Verification commands: Task 7.

Placeholder scan:

- The plan contains no placeholder markers.
- Every task has concrete files, commands, and expected outcomes.

Type consistency:

- Backend uses existing `model.ClarificationSession`, `clarificationView`, `model.Application`, and `model.Deployment`.
- Frontend session state uses `selectedSessionId`, `sessions`, `timeline`, `questions`, `requirement`, and `blueprints` consistently across helper, hook, and component tasks.
