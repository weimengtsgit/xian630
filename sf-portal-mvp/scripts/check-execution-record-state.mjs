import assert from 'node:assert/strict'
import {
  appendExecutionRecord,
  recordsForAttempt,
  unreadCountForStep,
  buildStepCardView,
} from '../src/hooks/executionRecordState.js'

// ---------------------------------------------------------------------------
// Brief canonical case: append out-of-order + duplicate -> ascending, deduped.
// ---------------------------------------------------------------------------
let state = []
state = appendExecutionRecord(state, { id: 'r2', step_id: 's1', attempt: 2, sequence: 2, content: 'two' })
state = appendExecutionRecord(state, { id: 'r1', step_id: 's1', attempt: 2, sequence: 1, content: 'one' })
state = appendExecutionRecord(state, { id: 'r1', step_id: 's1', attempt: 2, sequence: 1, content: 'duplicate' })
assert.deepEqual(recordsForAttempt(state, 's1', 2).map(r => r.id), ['r1', 'r2'])
assert.equal(unreadCountForStep(state, 's1', 2, 1), 1)

// ---------------------------------------------------------------------------
// Dedup-by-id: a repeated id must NOT overwrite the existing record's content.
// The first-seen record wins; later appends with the same id are ignored.
// ---------------------------------------------------------------------------
state = []
state = appendExecutionRecord(state, { id: 'x', step_id: 's', attempt: 1, sequence: 5, content: 'first' })
state = appendExecutionRecord(state, { id: 'x', step_id: 's', attempt: 1, sequence: 5, content: 'second' })
assert.equal(recordsForAttempt(state, 's', 1).length, 1)
assert.equal(recordsForAttempt(state, 's', 1)[0].content, 'first', 'duplicate id must not overwrite')

// ---------------------------------------------------------------------------
// Ascending sort across many sequences (incl. equal-sequence stable order).
// ---------------------------------------------------------------------------
state = []
state = appendExecutionRecord(state, { id: 'c', step_id: 's', attempt: 1, sequence: 3 })
state = appendExecutionRecord(state, { id: 'a', step_id: 's', attempt: 1, sequence: 1 })
state = appendExecutionRecord(state, { id: 'b', step_id: 's', attempt: 1, sequence: 2 })
state = appendExecutionRecord(state, { id: 'd', step_id: 's', attempt: 1, sequence: 3 })
assert.deepEqual(
  recordsForAttempt(state, 's', 1).map(r => r.sequence),
  [1, 2, 3, 3],
  'recordsForAttempt must sort ascending by sequence',
)

// ---------------------------------------------------------------------------
// Unread count: only sequence > lastReadSequence counts.
// ---------------------------------------------------------------------------
state = []
state = appendExecutionRecord(state, { id: 'a', step_id: 's', attempt: 1, sequence: 1 })
state = appendExecutionRecord(state, { id: 'b', step_id: 's', attempt: 1, sequence: 2 })
state = appendExecutionRecord(state, { id: 'c', step_id: 's', attempt: 1, sequence: 3 })
state = appendExecutionRecord(state, { id: 'd', step_id: 's', attempt: 1, sequence: 5 })
assert.equal(unreadCountForStep(state, 's', 1, 0), 4)
assert.equal(unreadCountForStep(state, 's', 1, 2), 2, 'only seq>2 counted')
assert.equal(unreadCountForStep(state, 's', 1, 5), 0, 'none beyond 5')

// ---------------------------------------------------------------------------
// Attempt isolation: records for other attempts/steps are invisible.
// ---------------------------------------------------------------------------
state = []
state = appendExecutionRecord(state, { id: 'a1', step_id: 's1', attempt: 1, sequence: 1 })
state = appendExecutionRecord(state, { id: 'a2', step_id: 's1', attempt: 2, sequence: 1 })
state = appendExecutionRecord(state, { id: 'b1', step_id: 's2', attempt: 1, sequence: 1 })
assert.deepEqual(recordsForAttempt(state, 's1', 1).map(r => r.id), ['a1'])
assert.deepEqual(recordsForAttempt(state, 's1', 2).map(r => r.id), ['a2'])
assert.deepEqual(recordsForAttempt(state, 's2', 1).map(r => r.id), ['b1'])
assert.equal(unreadCountForStep(state, 's1', 1, 0), 1)
assert.equal(unreadCountForStep(state, 's1', 2, 0), 1)

// ---------------------------------------------------------------------------
// Returns a NEW array reference (immutability) — original untouched.
// ---------------------------------------------------------------------------
const before = state
state = appendExecutionRecord(state, { id: 'new', step_id: 's1', attempt: 1, sequence: 9 })
assert.notEqual(state, before, 'appendExecutionRecord must return a new array reference')
assert.equal(before.length, 3, 'original array must not be mutated')

// ---------------------------------------------------------------------------
// record payload tolerance: missing optional fields don't crash.
// ---------------------------------------------------------------------------
state = []
state = appendExecutionRecord(state, { id: 'z', step_id: 's', attempt: 1, sequence: 1 })
assert.equal(unreadCountForStep(state, 's', 1, 0), 1)

// ---------------------------------------------------------------------------
// buildStepCardView: join fixed kinds -> REAL job_steps.id -> summary by id.
// The backend execution-summary is keyed by step_id (NOT kind). A kind string
// must NEVER appear as stepId, and a summary must only attach when its step_id
// matches a real step row.
// ---------------------------------------------------------------------------
const FIXED_STEPS = [
  { kind: 'requirement_analysis', label: '需求分析' },
  { kind: 'solution_design', label: '方案设计' },
  { kind: 'code_generation', label: '代码生成' },
  { kind: 'test_verification', label: '测试验证' },
  { kind: 'image_build', label: '镜像构建' },
  { kind: 'deployment', label: '部署' },
]
const stepsInput = [
  { id: 'step_a', kind: 'requirement_analysis', status: 'completed', attempt: 2 },
  { id: 'step_b', kind: 'solution_design', status: 'running', attempt: 1 },
]
const summaryInput = [
  { step_id: 'step_a', latest_attempt: 2, latest_record: { content: 'x' } },
]
const view = buildStepCardView(stepsInput, summaryInput, FIXED_STEPS)
assert.equal(view.length, 6, 'view covers all six fixed kinds')

const ra = view.find(v => v.kind === 'requirement_analysis')
assert.equal(ra.stepId, 'step_a', 'requirement_analysis resolves to real step id')
assert.equal(ra.summary && ra.summary.latest_record && ra.summary.latest_record.content, 'x')
assert.equal(ra.summary.latest_attempt, 2)

const sd = view.find(v => v.kind === 'solution_design')
assert.equal(sd.stepId, 'step_b', 'solution_design resolves to real step id')
assert.equal(sd.summary, null, 'solution_design has no summary entry -> null')

// Kinds with no step row yet: stepId null, summary null.
const cg = view.find(v => v.kind === 'code_generation')
assert.equal(cg.stepId, null)
assert.equal(cg.summary, null)

// CRITICAL: NO entry uses a kind string as its stepId.
view.forEach(v => {
  assert.ok(
    v.stepId === null || !FIXED_STEPS.some(f => f.kind === v.stepId),
    `stepId must be a real id, not a kind; got "${v.stepId}" for ${v.kind}`,
  )
})

// A stray summary whose step_id matches no real step must NOT attach anywhere.
const view2 = buildStepCardView(
  [{ id: 'step_a', kind: 'requirement_analysis' }],
  [
    { step_id: 'step_a', latest_attempt: 1 },
    { step_id: 'orphan', latest_attempt: 9 }, // no matching step row
  ],
  FIXED_STEPS,
)
assert.equal(
  view2.find(v => v.kind === 'requirement_analysis').summary.latest_attempt,
  1,
)
assert.ok(
  view2.every(v => !v.summary || v.summary.step_id !== 'orphan'),
  'orphan summary (no step row) must not attach to any card',
)

// Tolerant: missing/empty inputs never crash.
assert.equal(buildStepCardView(null, null, FIXED_STEPS).length, 6)
assert.equal(buildStepCardView([], [], FIXED_STEPS).length, 6)

console.log('check-execution-record-state: OK')
