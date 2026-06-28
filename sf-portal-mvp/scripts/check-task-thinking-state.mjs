// Pure-logic tests for task-thinking state reducer (Phase 4 Task 4).
// Runs under node with no React imports. Exercises normalization,
// ordering, deduplication, and grouping by step attempt.
import assert from 'node:assert/strict'
import {
  initialTaskThinkingState,
  normalizeTaskThinkingEvent,
  applyTaskThinkingEvent,
  applyTaskThinkingEvents,
  resetTaskThinkingState,
  buildThinkingByStepAttempt,
} from '../src/hooks/taskThinkingState.js'

// ---- normalization tests ----

{
  const raw = normalizeTaskThinkingEvent({
    id: 'think_1',
    dialogue_id: 'dlg_1',
    task_id: 'job_1',
    step_id: 'step_1',
    attempt: 2,
    agent_key: 'designer',
    dialogue_sequence: 1,
    step_sequence: 1,
    content: 'hello',
    redacted: true,
    created_at: '2026-06-28T00:00:00Z',
  })
  assert.equal(raw.dialogueId, 'dlg_1', 'normalize should map dialogue_id to dialogueId')
  assert.equal(raw.taskId, 'job_1', 'normalize should map task_id to taskId')
  assert.equal(raw.stepId, 'step_1', 'normalize should map step_id to stepId')
  assert.equal(raw.attempt, 2, 'normalize should preserve attempt')
  assert.equal(raw.agentKey, 'designer', 'normalize should map agent_key to agentKey')
  assert.equal(raw.dialogueSequence, 1, 'normalize should map dialogue_sequence to dialogueSequence')
  assert.equal(raw.stepSequence, 1, 'normalize should map step_sequence to stepSequence')
  assert.equal(raw.redacted, true, 'normalize should preserve redacted')
  assert.equal(raw.content, 'hello', 'normalize should preserve content')
  assert.equal(raw.createdAt, '2026-06-28T00:00:00Z', 'normalize should map created_at to createdAt')
}

// Also accepts camelCase
{
  const raw = normalizeTaskThinkingEvent({
    id: 'think_2',
    dialogueId: 'dlg_2',
    taskId: 'job_2',
    stepId: 'step_2',
    attempt: 1,
    agentKey: 'coder',
    dialogueSequence: 5,
    stepSequence: 3,
    content: 'world',
    redacted: false,
    createdAt: '2026-06-28T00:01:00Z',
  })
  assert.equal(raw.dialogueId, 'dlg_2', 'normalize should accept camelCase dialogueId')
  assert.equal(raw.agentKey, 'coder', 'normalize should accept camelCase agentKey')
}

// Drops invalid events
{
  assert.equal(normalizeTaskThinkingEvent(null), null, 'normalize should return null for null input')
  assert.equal(normalizeTaskThinkingEvent({}), null, 'normalize should return null for empty input')
  assert.equal(normalizeTaskThinkingEvent({ dialogueId: 'dlg_1' }), null, 'normalize should return null without dialogueSequence')
  assert.equal(normalizeTaskThinkingEvent({ dialogueSequence: 1 }), null, 'normalize should return null without dialogueId')
}

// ---- reducer: ordering, dedupe, and isolation ----

{
  let state = initialTaskThinkingState('dlg_1')
  state = applyTaskThinkingEvents(state, [
    { id: 'think_2', dialogueId: 'dlg_1', taskId: 'job_1', stepId: 'step_1', attempt: 1, dialogueSequence: 2, content: ' world', redacted: false },
    { id: 'think_1', dialogueId: 'dlg_1', taskId: 'job_1', stepId: 'step_1', attempt: 1, dialogueSequence: 1, content: 'hello', redacted: true },
    { id: 'think_1_dup', dialogueId: 'dlg_1', taskId: 'job_1', stepId: 'step_1', attempt: 1, dialogueSequence: 1, content: 'duplicate', redacted: false }, // duplicate sequence
  ])
  assert.deepEqual(state.items.map(i => i.id), ['think_1', 'think_2'], 'events should order by dialogueSequence ascending, deduped')
  assert.equal(state.highestSequence, 2, 'highestSequence should track the max sequence')
  assert.equal(state.selectedDialogueId, 'dlg_1', 'selectedDialogueId should be preserved')

  // Isolation: events for other dialogues are ignored
  const before = state.items.length
  state = applyTaskThinkingEvent(state, { id: 'think_x', dialogueId: 'dlg_2', dialogueSequence: 10, content: 'ignored' })
  assert.equal(state.items.length, before, 'events for other dialogues should be ignored')
}

// ---- grouping by step attempt ----

{
  let state = initialTaskThinkingState('dlg_1')
  state = applyTaskThinkingEvents(state, [
    { id: 'think_a', dialogueId: 'dlg_1', taskId: 'job_1', stepId: 'step_1', attempt: 2, dialogueSequence: 1, content: 'First chunk', redacted: false },
    { id: 'think_b', dialogueId: 'dlg_1', taskId: 'job_1', stepId: 'step_1', attempt: 2, dialogueSequence: 2, content: ' second chunk', redacted: true },
    { id: 'think_c', dialogueId: 'dlg_1', taskId: 'job_1', stepId: 'step_2', attempt: 1, dialogueSequence: 3, content: 'Other step', redacted: false },
    { id: 'think_d', dialogueId: 'dlg_1', taskId: 'job_1', stepId: 'step_1', attempt: 1, dialogueSequence: 4, content: 'Retry attempt', redacted: false },
  ])

  const grouped = buildThinkingByStepAttempt(state.items)

  const key1 = 'job_1::step_1::2'
  assert.ok(grouped[key1], 'group should exist for job_1 step_1 attempt 2')
  assert.equal(grouped[key1].content, 'First chunk second chunk', 'content should be concatenated in order')
  assert.equal(grouped[key1].redacted, true, 'redacted should be true if any event is redacted')
  assert.equal(grouped[key1].agentKey, '', 'agentKey should be empty if not provided')

  const key2 = 'job_1::step_2::1'
  assert.ok(grouped[key2], 'group should exist for job_1 step_2 attempt 1')
  assert.equal(grouped[key2].content, 'Other step', 'content should match single event')
  assert.equal(grouped[key2].redacted, false, 'redacted should be false if no event is redacted')

  const key3 = 'job_1::step_1::1'
  assert.ok(grouped[key3], 'group should exist for job_1 step_1 attempt 1')
  assert.equal(grouped[key3].content, 'Retry attempt', 'content should match retry attempt')
}

// ---- reset ----

{
  let state = initialTaskThinkingState('dlg_1')
  state = applyTaskThinkingEvent(state, { id: 'think_1', dialogueId: 'dlg_1', dialogueSequence: 1, content: 'hello' })
  assert.equal(state.items.length, 1, 'state should have one item')

  const reset = resetTaskThinkingState('dlg_2')
  assert.equal(reset.selectedDialogueId, 'dlg_2', 'reset should set new selectedDialogueId')
  assert.equal(reset.highestSequence, 0, 'reset should reset highestSequence')
  assert.equal(reset.items.length, 0, 'reset should empty items')
}

console.log('check-task-thinking-state: OK')
