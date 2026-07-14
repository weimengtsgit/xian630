// 纯函数测试(不碰 projects.json,避免与 interface-launch.test.js 并发竞争)。
// HTTP/集成测试(回调/创建/状态视图)在 interface-launch.test.js 内(单一 projects.json 管理)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAgentStatus, computeCompleted, decorateProject } from './projects.js'
import { STAGE_KEYS } from './stages.js'

test('normalizeAgentStatus: canonical 四态 + 兼容 working/completed + 非法 null', () => {
  assert.equal(normalizeAgentStatus('pending'), 'pending')
  assert.equal(normalizeAgentStatus('running'), 'running')
  assert.equal(normalizeAgentStatus('failed'), 'failed')
  assert.equal(normalizeAgentStatus('succeeded'), 'succeeded')
  assert.equal(normalizeAgentStatus('working'), 'running')
  assert.equal(normalizeAgentStatus('completed'), 'succeeded')
  assert.equal(normalizeAgentStatus('done'), null)
  assert.equal(normalizeAgentStatus(undefined), null)
})

test('computeCompleted: 四个皆 failed/succeeded → true;否则 false', () => {
  const all = Object.fromEntries(STAGE_KEYS.map((k) => [k, 'succeeded']))
  assert.equal(computeCompleted(all), true)
  const allFail = Object.fromEntries(STAGE_KEYS.map((k) => [k, 'failed']))
  assert.equal(computeCompleted(allFail), true)
  assert.equal(computeCompleted({ ...all, 'agent-business': 'running' }), false)
  assert.equal(computeCompleted(Object.fromEntries(STAGE_KEYS.map((k) => [k, 'pending']))), false)
})

test('decorateProject: 旧项目(无 agentStatus)惰性补全为全 pending + completed false', () => {
  const d = decorateProject({ id: 'x', name: '旧', projectname: 'old1', createdAt: 1 })
  assert.deepEqual(d.agentStatus, Object.fromEntries(STAGE_KEYS.map((k) => [k, 'pending'])))
  assert.equal(d.completed, false)
})
