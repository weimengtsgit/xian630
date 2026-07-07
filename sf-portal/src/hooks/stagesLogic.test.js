import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allCompleted } from './stagesLogic.js'

const K = ['agent-business', 'agent-prototype', 'agent-data', 'agent-production']
const done = () => K.map(k => ({ key: k, status: 'completed' }))

test('allCompleted: 空数组 → false', () => {
  assert.equal(allCompleted([]), false)
})
test('allCompleted: 任一 pending → false', () => {
  const s = done(); s[2].status = 'pending'
  assert.equal(allCompleted(s), false)
})
test('allCompleted: 全 completed → true', () => {
  assert.equal(allCompleted(done()), true)
})
