import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from './app.js'
import { createStageStore, STAGE_KEYS } from './stages.js'

const INITIAL = STAGE_KEYS.map(k => ({ key: k, name: k, status: 'pending', url: '' }))

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

test('GET /api/stages returns stages', async () => {
  const store = createStageStore('/tmp/sf-portal-app-test-1.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status, json } = await req(base, 'GET', '/api/stages')
    assert.equal(status, 200)
    assert.equal(json.stages.length, 4)
  })
})

test('POST /api/stages/:key updates and returns stages', async () => {
  const store = createStageStore('/tmp/sf-portal-app-test-2.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status, json } = await req(base, 'POST', '/api/stages/agent-data', { status: 'completed' })
    assert.equal(status, 200)
    assert.equal(json.stages.find(s => s.key === 'agent-data').status, 'completed')
  })
})

test('POST unknown key → 400', async () => {
  const store = createStageStore('/tmp/sf-portal-app-test-3.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-nope', { status: 'completed' })
    assert.equal(status, 400)
  })
})

test('POST invalid status → 400', async () => {
  const store = createStageStore('/tmp/sf-portal-app-test-4.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-business', { status: 'working' })
    assert.equal(status, 400)
  })
})
