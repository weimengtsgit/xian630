import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStageStore, STAGE_KEYS } from './stages.js'

const CONFIG = STAGE_KEYS.map(k => ({ key: k, name: k, url: 'http://x' }))

test('read 初始全 pending', () => {
  const store = createStageStore(CONFIG)
  assert.equal(store.read().length, 4)
  assert.ok(store.read().every(s => s.status === 'pending'))
})

test('update 改内存状态（不写盘）', () => {
  const store = createStageStore(CONFIG)
  const next = store.update('agent-business', { status: 'working' })
  assert.equal(next.find(s => s.key === 'agent-business').status, 'working')
  assert.equal(store.read().find(s => s.key === 'agent-business').status, 'working')
})

test('update 接受 pending/working/completed 流转', () => {
  const store = createStageStore(CONFIG)
  store.update('agent-business', { status: 'working' })
  assert.equal(store.read().find(s => s.key === 'agent-business').status, 'working')
  store.update('agent-business', { status: 'completed' })
  assert.equal(store.read().find(s => s.key === 'agent-business').status, 'completed')
  store.update('agent-business', { status: 'pending' })
  assert.equal(store.read().find(s => s.key === 'agent-business').status, 'pending')
})

test('update 可改 url（贴链接）', () => {
  const store = createStageStore(CONFIG)
  store.update('agent-production', { status: 'completed', url: 'http://delivery/x' })
  const s = store.read().find(x => x.key === 'agent-production')
  assert.equal(s.status, 'completed')
  assert.equal(s.url, 'http://delivery/x')
})

test('update 拒绝未知 key / 非法 status', () => {
  const store = createStageStore(CONFIG)
  assert.throws(() => store.update('agent-nope', { status: 'completed' }), /unknown stage key/)
  assert.throws(() => store.update('agent-business', { status: 'idle' }), /invalid status/)
})

test('reset 全部回 pending', () => {
  const store = createStageStore(CONFIG)
  store.update('agent-business', { status: 'completed' })
  store.update('agent-data', { status: 'working' })
  const after = store.reset()
  assert.ok(after.every(s => s.status === 'pending'))
})
