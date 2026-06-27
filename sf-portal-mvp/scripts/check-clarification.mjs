import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyClarificationEvent,
  initialClarificationState,
  statusText,
} from '../src/hooks/clarificationLogic.js'

// ---------------------------------------------------------------------------
// clarification.created -> session set
// ---------------------------------------------------------------------------
let s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.created', {
  type: 'clarification.created',
  session_id: 'sess_1',
  data: { id: 'sess_1', status: 'active', prompt: 'hello' },
})
assert.equal(s.session && s.session.id, 'sess_1')
assert.equal(s.session.status, 'active')

// ---------------------------------------------------------------------------
// message.started + message.delta + message.completed share id -> ONE message
// delta SETS content (two deltas with same id => content = last, NOT concat)
// ---------------------------------------------------------------------------
s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.message.started', {
  type: 'clarification.message.started',
  session_id: 'sess_1',
  message_id: 'm_1',
  data: { type: 'analysis_work_log', content: '' },
})
s = applyClarificationEvent(s, 'clarification.message.delta', {
  type: 'clarification.message.delta',
  session_id: 'sess_1',
  message_id: 'm_1',
  delta: 'first chunk',
})
// second delta with same id must REPLACE, not append
s = applyClarificationEvent(s, 'clarification.message.delta', {
  type: 'clarification.message.delta',
  session_id: 'sess_1',
  message_id: 'm_1',
  delta: 'second chunk',
})
s = applyClarificationEvent(s, 'clarification.message.completed', {
  type: 'clarification.message.completed',
  session_id: 'sess_1',
  message_id: 'm_1',
  data: { type: 'analysis_work_log', content: 'second chunk' },
})
assert.equal(s.messages.length, 1, 'started+delta+delta+completed must yield ONE message')
assert.equal(s.messages[0].id, 'm_1')
assert.equal(s.messages[0].content, 'second chunk', 'delta must SET content, not append')
assert.equal(s.messages[0].role, 'agent')
assert.equal(s.messages[0].kind, 'analysis_work_log')

// delta for an unseen id must still create the message
s = applyClarificationEvent(s, 'clarification.message.delta', {
  type: 'clarification.message.delta',
  session_id: 'sess_1',
  message_id: 'm_2',
  delta: 'fresh',
})
assert.equal(s.messages.length, 2)
assert.equal(s.messages[1].id, 'm_2')
assert.equal(s.messages[1].content, 'fresh')

// ---------------------------------------------------------------------------
// question.created appends + dedups by id
// ---------------------------------------------------------------------------
s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.question.created', {
  type: 'clarification.question.created',
  session_id: 'sess_1',
  data: { id: 'q_1', question: 'which?', options: [{ value: 'a', label: 'A' }] },
})
s = applyClarificationEvent(s, 'clarification.question.created', {
  type: 'clarification.question.created',
  session_id: 'sess_1',
  data: { id: 'q_1', question: 'which?', options: [{ value: 'a', label: 'A' }] },
})
s = applyClarificationEvent(s, 'clarification.question.created', {
  type: 'clarification.question.created',
  session_id: 'sess_1',
  data: { id: 'q_2', question: 'how?' },
})
assert.equal(s.questions.length, 2, 'duplicate question id must be deduped')
assert.equal(s.questions[0].id, 'q_1')
assert.equal(s.questions[1].id, 'q_2')

// ---------------------------------------------------------------------------
// summary.updated -> requirement; ready_to_confirm -> requirement + status
// ---------------------------------------------------------------------------
s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.created', {
  type: 'clarification.created',
  data: { id: 'sess_1', status: 'active' },
})
s = applyClarificationEvent(s, 'clarification.summary.updated', {
  type: 'clarification.summary.updated',
  session_id: 'sess_1',
  data: {
    appType: 'dashboard',
    appName: 'Foo',
    coreScenario: 'x',
    judgementBoundary: {
      dataSources: ['ontology', 'public_web_search'],
      summary: '基于 AIS 数据判断异常',
    },
  },
})
assert.deepEqual(s.requirement, {
  appType: 'dashboard',
  appName: 'Foo',
  coreScenario: 'x',
  judgementBoundary: {
    dataSources: ['ontology', 'public_web_search'],
    summary: '基于 AIS 数据判断异常',
  },
})

s = applyClarificationEvent(s, 'clarification.question.created', {
  type: 'clarification.question.created',
  session_id: 'sess_1',
  data: { id: 'targetUsers', question: '面向哪类用户?', options: [{ value: '作战参谋' }] },
})
assert.equal(s.questions.length, 1, 'precondition: stale question exists before ready_to_confirm')

s = applyClarificationEvent(s, 'clarification.ready_to_confirm', {
  type: 'clarification.ready_to_confirm',
  session_id: 'sess_1',
  data: {
    appType: 'dashboard',
    appName: 'Foo',
    coreScenario: 'x',
    primaryView: 'map',
    judgementBoundary: {
      dataSources: ['ontology', 'public_web_search'],
      summary: '基于 AIS 数据判断异常',
    },
  },
})
assert.equal(s.session.status, 'ready_to_confirm')
assert.equal(s.requirement.primaryView, 'map')
assert.equal(s.requirement.judgementBoundary.summary, '基于 AIS 数据判断异常')
assert.equal(s.questions.length, 0, 'ready_to_confirm must clear stale clarification questions')

// ---------------------------------------------------------------------------
// blueprint.recommended is retired: blueprints are internal Factory metadata.
// ---------------------------------------------------------------------------
s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.blueprint.recommended', {
  type: 'clarification.blueprint.recommended',
  session_id: 'sess_1',
  data: [
    { id: 'bp_1', name: 'A', reason: 'r1', referenceKind: 'fork' },
    { id: 'bp_2', name: 'B', reason: 'r2', referenceKind: 'port' },
  ],
})
assert.equal(Array.isArray(s.blueprints), true)
assert.equal(s.blueprints.length, 0)

// ---------------------------------------------------------------------------
// confirmed -> session replaced (realistic confirmed-session payload: the
// backend now publishes the refreshed session with status=confirmed and a
// created_job_id, NOT the requirement object).
// ---------------------------------------------------------------------------
s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.created', {
  type: 'clarification.created',
  data: { id: 'sess_1', status: 'ready_to_confirm' },
})
s = applyClarificationEvent(s, 'clarification.confirmed', {
  type: 'clarification.confirmed',
  session_id: 'sess_1',
  data: { id: 'sess_1', status: 'confirmed', created_job_id: 'job_x' },
})
assert.equal(s.session.status, 'confirmed')
assert.equal(s.session.id, 'sess_1')
assert.equal(s.session.created_job_id, 'job_x')

// Regression: a confirmed event whose data is requirement-shaped (no id/status)
// must NOT overwrite the existing session. It should still mark the session
// confirmed and preserve the requirement payload, so a backend payload regression
// cannot leave the UI stuck at ready_to_confirm or route chat to
// /api/clarifications/undefined/messages.
s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.created', {
  type: 'clarification.created',
  data: { id: 'sess_1', status: 'ready_to_confirm' },
})
s = applyClarificationEvent(s, 'clarification.confirmed', {
  type: 'clarification.confirmed',
  session_id: 'sess_1',
  data: { appType: 'situation_replay', appName: 'Foo', coreScenario: 'x' },
})
assert.equal(s.session.id, 'sess_1', 'session id must be preserved')
assert.equal(s.session.status, 'confirmed', 'requirement-shaped confirmed payload must still mark the session confirmed')
assert.equal(s.requirement.appType, 'situation_replay', 'requirement-shaped confirmed payload must update requirement')

// ---------------------------------------------------------------------------
// failed / abandoned -> status set on session
// ---------------------------------------------------------------------------
s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.created', {
  type: 'clarification.created',
  data: { id: 'sess_1', status: 'active' },
})
s = applyClarificationEvent(s, 'clarification.failed', {
  type: 'clarification.failed',
  session_id: 'sess_1',
  data: { error: 'boom' },
})
assert.equal(s.session.status, 'failed')

s = initialClarificationState()
s = applyClarificationEvent(s, 'clarification.created', {
  type: 'clarification.created',
  data: { id: 'sess_2', status: 'active' },
})
s = applyClarificationEvent(s, 'clarification.abandoned', {
  type: 'clarification.abandoned',
  session_id: 'sess_2',
  data: { id: 'sess_2', status: 'abandoned' },
})
assert.equal(s.session.status, 'abandoned')

// ---------------------------------------------------------------------------
// unknown event type -> no-op (state unchanged reference)
// ---------------------------------------------------------------------------
s = initialClarificationState()
const before = s
s = applyClarificationEvent(s, 'something.else', { type: 'something.else' })
assert.equal(s, before, 'unknown event type must return state unchanged')

// ---------------------------------------------------------------------------
// statusText maps all 6 statuses + unknown passthrough
// ---------------------------------------------------------------------------
assert.equal(statusText('active'), '澄清中')
assert.equal(statusText('waiting_user'), '等待补充')
assert.equal(statusText('ready_to_confirm'), '待确认')
assert.equal(statusText('confirmed'), '已确认')
assert.equal(statusText('failed'), '已失败')
assert.equal(statusText('abandoned'), '已放弃')
assert.equal(statusText('weird'), 'weird')
assert.equal(statusText(undefined), '')
assert.equal(statusText(null), '')

// ---------------------------------------------------------------------------
// ClarificationPanel must not render internal blueprintRefs in the confirmation
// summary. Blueprint refs are server-side Factory metadata only.
// ---------------------------------------------------------------------------
const panelSource = readFileSync(new URL('../src/components/ClarificationPanel.jsx', import.meta.url), 'utf8')
assert.doesNotMatch(panelSource, /requirement\.blueprintRefs/, 'ClarificationPanel must not read requirement.blueprintRefs')
assert.doesNotMatch(panelSource, /蓝本引用/, 'ClarificationPanel must not render blueprint reference copy')
assert.match(panelSource, /研判边界/, 'ClarificationPanel must render judgement boundary summary')
assert.match(panelSource, /数据来源/, 'ClarificationPanel must render judgement data source labels')
assert.match(panelSource, /ontology:\s*'本体数据源'/, 'ClarificationPanel must label ontology data source')
assert.match(panelSource, /public_web_search:\s*'网络公开搜索'/, 'ClarificationPanel must label public web search data source')

// ---------------------------------------------------------------------------
// ENVELOPE shape end-to-end: subscribeFactoryEvents yields the server.Event
// envelope {seq,type,data,at}; the hook unwraps .data to the bare StreamEvent
// before calling the reducer. Mirror that exact unwrap predicate here so the
// SSE boundary stays covered even though the reducer itself is envelope-agnostic.
// ---------------------------------------------------------------------------
function unwrapEnvelope(raw) {
  // Mirrors the predicate in useClarification.js's SSE callback.
  return raw && typeof raw === 'object' && 'seq' in raw ? raw.data : raw
}

s = initialClarificationState()
// message.delta: an SSE client receives the outer Event envelope whose `data`
// is the bare clarification.StreamEvent carrying the delta payload.
const deltaEnvelope = {
  seq: 1,
  type: 'clarification.message.delta',
  data: {
    type: 'clarification.message.delta',
    session_id: 's',
    message_id: 'm',
    delta: 'x',
  },
  at: '2026-06-18T00:00:00Z',
}
s = applyClarificationEvent(
  s,
  deltaEnvelope.type,
  unwrapEnvelope(deltaEnvelope) || {},
)
assert.equal(s.messages.length, 1, 'envelope-wrapped delta must yield ONE message')
assert.equal(s.messages[0].id, 'm')
assert.equal(s.messages[0].content, 'x', 'envelope delta content must be unwrapped to the bare StreamEvent')

// summary.updated via envelope: requirement must come from the inner StreamEvent,
// not the outer Event.
s = initialClarificationState()
const summaryEnvelope = {
  seq: 2,
  type: 'clarification.summary.updated',
  data: {
    type: 'clarification.summary.updated',
    session_id: 's',
    data: {
      appType: 'situation_replay',
      appName: 'A',
      coreScenario: 'c',
      judgementBoundary: { dataSources: ['ontology'], summary: '基于潮汐数据判断窗口' },
    },
  },
}
s = applyClarificationEvent(
  s,
  summaryEnvelope.type,
  unwrapEnvelope(summaryEnvelope) || {},
)
assert.deepEqual(s.requirement, {
  appType: 'situation_replay',
  appName: 'A',
  coreScenario: 'c',
  judgementBoundary: { dataSources: ['ontology'], summary: '基于潮汐数据判断窗口' },
})

// A bare (non-envelope) StreamEvent must still pass through unchanged — the
// unwrap predicate must be a no-op for inputs without a numeric `seq`.
const bare = { type: 'clarification.message.delta', session_id: 's', message_id: 'm2', delta: 'bare' }
assert.equal(unwrapEnvelope(bare), bare, 'bare StreamEvent must not be unwrapped')

console.log('check-clarification: OK')
