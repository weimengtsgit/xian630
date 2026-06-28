import assert from 'node:assert/strict'
import { selectFocusTask, rankTasks } from '../src/hooks/focusTask.js'

// Helper to build a minimal job with explicit timestamps. Times are ISO strings;
// later strings sort after earlier ones.
function job(id, status, { dialogue_id, started_at, created_at, updated_at } = {}) {
  return {
    id,
    status,
    user_prompt: id,
    dialogue_id: dialogue_id ?? 'dlg-1',
    started_at: started_at ?? null,
    created_at: created_at ?? null,
    updated_at: updated_at ?? null,
  }
}

// (a) An OLDER waiting_user must beat a NEWER queued — waiting_user is the
// highest-attention tier even when it started earlier.
{
  const older = job('wait', 'waiting_user', { started_at: '2026-06-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' })
  const newer = job('q', 'queued', { started_at: '2026-06-10T00:00:00Z', created_at: '2026-06-10T00:00:00Z' })
  assert.equal(selectFocusTask([newer, older])?.id, 'wait', 'waiting_user beats newer queued')
}

// (a') legacy alias 'waiting' is the same tier as 'waiting_user'.
{
  const older = job('wait', 'waiting', { started_at: '2026-06-01T00:00:00Z' })
  const newer = job('q', 'queued', { started_at: '2026-06-10T00:00:00Z' })
  assert.equal(selectFocusTask([newer, older])?.id, 'wait', "waiting alias beats newer queued")
}

// (b) running beats queued.
{
  const running = job('r', 'running', { started_at: '2026-06-01T00:00:00Z' })
  const queued = job('q', 'queued', { started_at: '2026-06-10T00:00:00Z' })
  assert.equal(selectFocusTask([queued, running])?.id, 'r', 'running beats queued')
}

// (c) failed beats completed (failed may be repairable / needs attention).
{
  const failed = job('f', 'failed', { started_at: '2026-06-01T00:00:00Z' })
  const completed = job('c', 'completed', { started_at: '2026-06-10T00:00:00Z' })
  assert.equal(selectFocusTask([completed, failed])?.id, 'f', 'failed beats completed')
}

// (c') canceled/cancelled sort after failed (both terminal, but failed needs
// attention; canceled does not).
{
  const failed = job('f', 'failed', { started_at: '2026-06-01T00:00:00Z' })
  const canceled = job('x', 'canceled', { started_at: '2026-06-10T00:00:00Z' })
  assert.equal(selectFocusTask([canceled, failed])?.id, 'f', 'failed beats canceled')
}

// (d) Within the same tier, newer started_at wins; ties fall back to created_at,
// then updated_at.
{
  const older = job('old', 'running', { started_at: '2026-06-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' })
  const newer = job('new', 'running', { started_at: '2026-06-05T00:00:00Z', created_at: '2026-06-05T00:00:00Z' })
  assert.equal(selectFocusTask([older, newer])?.id, 'new', 'newer started_at wins within tier')
}
{
  // No started_at → created_at decides.
  const older = job('old', 'queued', { created_at: '2026-06-01T00:00:00Z' })
  const newer = job('new', 'queued', { created_at: '2026-06-05T00:00:00Z' })
  assert.equal(selectFocusTask([older, newer])?.id, 'new', 'created_at tiebreak within tier')
}

// (e) dialogue scoping: only jobs whose dialogue_id matches are eligible.
{
  const other = job('wait', 'waiting_user', { dialogue_id: 'dlg-other', started_at: '2026-06-10T00:00:00Z' })
  const mine = job('q', 'queued', { dialogue_id: 'dlg-1', started_at: '2026-06-01T00:00:00Z' })
  assert.equal(selectFocusTask([other, mine], 'dlg-1')?.id, 'q', 'dialogue scoping ignores other-dialogue jobs')
}

// (e') no dialogueId → all jobs eligible (legacy back-compat).
{
  const other = job('wait', 'waiting_user', { dialogue_id: 'dlg-other', started_at: '2026-06-01T00:00:00Z' })
  const mine = job('q', 'queued', { dialogue_id: 'dlg-1', started_at: '2026-06-10T00:00:00Z' })
  assert.equal(selectFocusTask([mine, other])?.id, 'wait', 'no dialogueId → all eligible')
}

// (f) empty / non-array input → null.
assert.equal(selectFocusTask([], 'dlg-1'), null, 'empty → null')
assert.equal(selectFocusTask(null, 'dlg-1'), null, 'null → null')
assert.equal(selectFocusTask(undefined), null, 'undefined → null')

// (g) rankTasks returns ALL eligible tasks ordered by attention priority
// (focus task first), so the 任务执行 drawer can list every dialogue task.
// The first element always equals selectFocusTask.
{
  const wait = job('wait', 'waiting_user', { dialogue_id: 'dlg-1', started_at: '2026-06-01T00:00:00Z' })
  const queued = job('q', 'queued', { dialogue_id: 'dlg-1', started_at: '2026-06-10T00:00:00Z' })
  const completed = job('c', 'completed', { dialogue_id: 'dlg-1', started_at: '2026-06-05T00:00:00Z' })
  const ranked = rankTasks([completed, queued, wait], 'dlg-1')
  assert.deepEqual(ranked.map(j => j.id), ['wait', 'q', 'c'], 'rankTasks orders waiting_user → queued → completed')
  assert.equal(ranked[0].id, selectFocusTask([completed, queued, wait], 'dlg-1').id, 'rankTasks[0] === selectFocusTask')
}
// (g') rankTasks scopes to the dialogue and drops unknown statuses, keeping
// every eligible task (not just the winner).
{
  const mine = job('a', 'running', { dialogue_id: 'dlg-1', started_at: '2026-06-01T00:00:00Z' })
  const other = job('b', 'waiting_user', { dialogue_id: 'dlg-other', started_at: '2026-06-10T00:00:00Z' })
  const ranked = rankTasks([mine, other], 'dlg-1')
  assert.deepEqual(ranked.map(j => j.id), ['a'], 'rankTasks scopes to the dialogue')
  assert.equal(rankTasks([], 'dlg-1').length, 0, 'rankTasks empty → []')
}

console.log('check-focus-task: ok')
