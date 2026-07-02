import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createStageStore, STAGE_KEYS } from './stages.js'

function tmpStore(initial) {
  const file = path.join(os.tmpdir(), `stages-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  return { file, store: createStageStore(file, initial) }
}

const INITIAL = STAGE_KEYS.map(k => ({ key: k, name: k, status: 'pending', url: '' }))

test('read returns initial stages when file absent', () => {
  const { store } = tmpStore(INITIAL)
  assert.equal(store.read().length, 4)
  assert.deepEqual(store.read().map(s => s.key), STAGE_KEYS)
})

test('update flips status and persists to disk', () => {
  const { file, store } = tmpStore(INITIAL)
  const next = store.update('agent-business', 'completed')
  assert.equal(next.find(s => s.key === 'agent-business').status, 'completed')
  assert.equal(store.read().find(s => s.key === 'agent-business').status, 'completed')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).stages
  assert.equal(onDisk.find(s => s.key === 'agent-business').status, 'completed')
})

test('update throws on unknown key', () => {
  const { store } = tmpStore(INITIAL)
  assert.throws(() => store.update('agent-nope', 'completed'), /unknown stage key/)
})

test('update throws on invalid status', () => {
  const { store } = tmpStore(INITIAL)
  assert.throws(() => store.update('agent-business', 'working'), /invalid status/)
})
