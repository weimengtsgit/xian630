import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from './app.js'
import { createStageStore, STAGE_KEYS } from './stages.js'

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

test('POST /api/stages/:key working → completed 流转', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    let r = await req(base, 'POST', '/api/stages/agent-data', { status: 'working' })
    assert.equal(r.status, 200)
    assert.equal(r.json.stages.find(s => s.key === 'agent-data').status, 'working')
    r = await req(base, 'POST', '/api/stages/agent-data', { status: 'completed' })
    assert.equal(r.json.stages.find(s => s.key === 'agent-data').status, 'completed')
  })
})

test('POST /api/stages/reset 全回 pending', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    await req(base, 'POST', '/api/stages/agent-data', { status: 'completed' })
    const { json } = await req(base, 'POST', '/api/stages/reset')
    assert.ok(json.stages.every(s => s.status === 'pending'))
  })
})

test('POST unknown key → 400', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-nope', { status: 'completed' })
    assert.equal(status, 400)
  })
})

test('POST invalid status → 400', async () => {
  const store = createStageStore(CONFIG)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-business', { status: 'idle' })
    assert.equal(status, 400)
  })
})
