import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from './app.js'
import { createStageStore, STAGE_KEYS } from './stages.js'
import { isValidProjectName } from './projects.js'

const CONFIG = STAGE_KEYS.map(k => ({ key: k, name: k, url: '' }))

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  try { return await fn(`http://127.0.0.1:${port}`) }
  finally { await new Promise(r => server.close(r)) }
}

async function req(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test('GET /api/stages 初始全 pending', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    const { status, json } = await req(base, 'GET', '/api/stages')
    assert.equal(status, 200)
    assert.equal(json.stages.length, 4)
    assert.ok(json.stages.every(s => s.status === 'pending'))
  })
})

test('POST /api/stages/:key 无 projectname → 400', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    const r = await req(base, 'POST', '/api/stages/agent-data', { status: 'running' })
    assert.equal(r.status, 400)
  })
})

test('POST unknown key (with projectname) → 400', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-nope', { projectname: 'any', status: 'running' })
    assert.equal(status, 400)
  })
})

test('POST invalid status (with projectname) → 400', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-business', { projectname: 'any', status: 'idle' })
    assert.equal(status, 400)
  })
})

// ---- F1: projectname validation (path-traversal guard) ----
// NOTE: the createProject + POST /api/projects tests live in interface-launch.test.js
// because they share projects.json (parallel node --test files must not race on it).

test('F1: isValidProjectName rejects traversal / invalid; accepts valid', () => {
  for (const bad of ['../../etc', 'a/b', 'a\\b', 'a b', 'a.b', 'A-B', 'x'.repeat(33), '', '-lead', 'a_b']) {
    assert.equal(isValidProjectName(bad), false, `${bad} should be invalid`)
  }
  for (const ok of ['demo', 'a', 'valid-key-1', 'x'.repeat(32)]) {
    assert.equal(isValidProjectName(ok), true, `${ok} should be valid`)
  }
})
