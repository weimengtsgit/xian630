import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createStageStore, STAGE_KEYS } from './stages.js'
import { createProject, isValidProjectName, InvalidProjectNameError } from './projects.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = path.resolve(__dirname, 'projects.json')

const CONFIG = STAGE_KEYS.map(k => ({ key: k, name: k, url: '' }))

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  try { return await fn(`http://127.0.0.1:${port}`) }
  finally { await new Promise(r => server.close(r)) }
}

async function req(base, method, pathStr, body) {
  const res = await fetch(`${base}${pathStr}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json, text: JSON.stringify(json || {}) }
}

/**
 * Build a stub fetchImpl that simulates the interface-agent resolve endpoint.
 * First call (no editToken in body) → 201 with editToken + startCode.
 * Subsequent calls (editToken present) → 200 with startCode only.
 */
function createStubFetch() {
  let callCount = 0
  const calls = []
  const stub = async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} })
    callCount++
    const body = calls[calls.length - 1].body
    if (url.includes('/api/interface-sessions/resolve')) {
      if (!body.editToken) {
        // First call: create session, return token
        return {
          ok: true,
          status: 201,
          json: async () => ({
            sessionId: 'ia-session-stub-1',
            editToken: 'iaet_stub_token_secret',
            startCode: 'startcode_first_123',
            expiresAt: '2026-12-31T23:59:59Z',
          }),
          text: async () => JSON.stringify({
            sessionId: 'ia-session-stub-1',
            editToken: 'iaet_stub_token_secret',
            startCode: 'startcode_first_123',
          }),
        }
      }
      // Subsequent: verify token, return startCode only
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: 'ia-session-stub-1',
          startCode: 'startcode_second_456',
          expiresAt: '2026-12-31T23:59:59Z',
        }),
        text: async () => JSON.stringify({
          sessionId: 'ia-session-stub-1',
          startCode: 'startcode_second_456',
        }),
      }
    }
    throw new Error(`Unexpected fetch to ${url}`)
  }
  return { stub, getCalls: () => calls }
}

test('interface-launch: first call stores token server-side, returns startCode only', async () => {
  // Save and restore projects.json so the test is isolated.
  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null
  try {
    const store = createStageStore(CONFIG)
    const { stub, getCalls } = createStubFetch()
    const app = createApp(store, { fetchImpl: stub })

    await withServer(app, async base => {
      // Create a project
      const createRes = await req(base, 'POST', '/api/projects', {})
      assert.equal(createRes.status, 201)
      assert.ok(createRes.json.id)
      assert.equal(createRes.json.interfaceEditToken, undefined,
        'newly created project must not expose editToken')
      const projId = createRes.json.id

      // First interface-launch: stub returns 201 with editToken
      const launch1 = await req(base, 'POST', `/api/projects/${projId}/interface-launch`)
      assert.equal(launch1.status, 200)
      assert.ok(launch1.json.startCode, 'response must include startCode')
      assert.equal(launch1.json.startCode, 'startcode_first_123')
      assert.equal(launch1.json.editToken, undefined,
        'editToken must NEVER appear in browser response')

      // The stub received no editToken on the first call
      const calls = getCalls()
      assert.equal(calls.length, 1)
      assert.equal(calls[0].body.editToken, undefined,
        'first resolve call must not send editToken')

      // GET /api/projects must not leak the stored editToken
      const listRes = await req(base, 'GET', '/api/projects')
      const proj = listRes.json.projects.find(p => p.id === projId)
      assert.ok(proj, 'project should exist')
      assert.equal(proj.interfaceEditToken, undefined,
        'GET /api/projects must never expose editToken')

      // Cleanup
      await req(base, 'DELETE', `/api/projects/${projId}`)
    })
  } finally {
    if (backup !== null) fs.writeFileSync(DATA_FILE, backup)
    else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE)
  }
})

test('interface-launch: second call reuses stored token, editToken stays server-side', async () => {
  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null
  try {
    const store = createStageStore(CONFIG)
    const { stub, getCalls } = createStubFetch()
    const app = createApp(store, { fetchImpl: stub })

    await withServer(app, async base => {
      const createRes = await req(base, 'POST', '/api/projects', {})
      const projId = createRes.json.id

      // First launch
      const launch1 = await req(base, 'POST', `/api/projects/${projId}/interface-launch`)
      assert.equal(launch1.status, 200)
      assert.equal(launch1.json.startCode, 'startcode_first_123')

      // Second launch: stub receives editToken this time → returns 200 startCode only
      const launch2 = await req(base, 'POST', `/api/projects/${projId}/interface-launch`)
      assert.equal(launch2.status, 200)
      assert.equal(launch2.json.startCode, 'startcode_second_456')
      assert.equal(launch2.json.editToken, undefined,
        'editToken must NEVER appear in browser response')

      // The second resolve call included the stored editToken
      const calls = getCalls()
      assert.equal(calls.length, 2)
      assert.ok(calls[1].body.editToken,
        'second resolve call must send the stored editToken')

      // Cleanup
      await req(base, 'DELETE', `/api/projects/${projId}`)
    })
  } finally {
    if (backup !== null) fs.writeFileSync(DATA_FILE, backup)
    else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE)
  }
})

test('interface-launch: unknown project → 404', async () => {
  const store = createStageStore(CONFIG)
  const { stub } = createStubFetch()
  const app = createApp(store, { fetchImpl: stub })

  await withServer(app, async base => {
    const r = await req(base, 'POST', '/api/projects/proj_nonexistent/interface-launch')
    assert.equal(r.status, 404)
  })
})

test('S1: interface-launch does not set Access-Control-Allow-Origin: * (same-origin default)', async () => {
  // The agent-pipeline SPA is served same-origin; its fetch calls are same-
  // origin. A global permissive CORS header let any cross-site page mint
  // startCodes for any project id (the route has no auth). Same-origin default
  // must be restored. Closes the cross-site startCode minting.
  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null
  try {
    const store = createStageStore(CONFIG)
    const { stub } = createStubFetch()
    const app = createApp(store, { fetchImpl: stub })

    await withServer(app, async base => {
      const createRes = await req(base, 'POST', '/api/projects', {})
      const projId = createRes.json.id
      try {
        // Same-origin POST still works
        const res = await fetch(`${base}/api/projects/${projId}/interface-launch`, { method: 'POST' })
        assert.equal(res.status, 200)
        // No permissive global CORS header (S1)
        assert.equal(res.headers.get('access-control-allow-origin'), null,
          'must NOT set Access-Control-Allow-Origin: * globally')
      } finally {
        await req(base, 'DELETE', `/api/projects/${projId}`)
      }
    })
  } finally {
    if (backup !== null) fs.writeFileSync(DATA_FILE, backup)
    else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE)
  }
})

test('interface-launch: resolve call sends X-Internal-Token (Fix 4)', async () => {
  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null
  try {
    const store = createStageStore(CONFIG)
    const { stub, getCalls } = createStubFetch()
    const app = createApp(store, {
      fetchImpl: stub,
      internalToken: 'shared-secret-xyz',
    })

    await withServer(app, async base => {
      const createRes = await req(base, 'POST', '/api/projects', {})
      const projId = createRes.json.id

      await req(base, 'POST', `/api/projects/${projId}/interface-launch`)

      const calls = getCalls()
      assert.equal(calls.length, 1)
      assert.equal(calls[0].headers['X-Internal-Token'], 'shared-secret-xyz',
        'resolve call must send the X-Internal-Token header')

      await req(base, 'DELETE', `/api/projects/${projId}`)
    })
  } finally {
    if (backup !== null) fs.writeFileSync(DATA_FILE, backup)
    else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE)
  }
})

// ---- F1: createProject validation (shares projects.json with these tests) ----

test('F1: createProject rejects invalid projectname; default randomCode is valid', async () => {
  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null
  try {
    for (const bad of ['../../etc', 'a/b', 'a b', 'x'.repeat(33)]) {
      assert.throws(() => createProject({ projectname: bad }), InvalidProjectNameError)
    }
    // default (no projectname) uses randomCode(4) — must satisfy the regex
    const proj = createProject({})
    assert.equal(isValidProjectName(proj.projectname), true)
    // explicit valid projectname accepted
    const proj2 = createProject({ projectname: 'my-proj' })
    assert.equal(proj2.projectname, 'my-proj')
  } finally {
    if (backup !== null) fs.writeFileSync(DATA_FILE, backup)
    else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE)
  }
})

test('F1: POST /api/projects with bad projectname → 400', async () => {
  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null
  try {
    const store = createStageStore(CONFIG)
    const app = createApp(store)
    await withServer(app, async base => {
      const bad = await req(base, 'POST', '/api/projects', { projectname: '../../etc' })
      assert.equal(bad.status, 400)
      const ok = await req(base, 'POST', '/api/projects', { projectname: 'clean-key' })
      assert.equal(ok.status, 201)
      assert.equal(ok.json.projectname, 'clean-key')
      await req(base, 'DELETE', `/api/projects/${ok.json.id}`)
    })
  } finally {
    if (backup !== null) fs.writeFileSync(DATA_FILE, backup)
    else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE)
  }
})

// ---- M1: interface-launch same-origin Origin guard ----

test('M1: foreign Origin → 403; same-origin / no-Origin → works', async () => {
  const backup = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null
  try {
    const store = createStageStore(CONFIG)
    const { stub } = createStubFetch()
    const app = createApp(store, { fetchImpl: stub })

    await withServer(app, async base => {
      const createRes = await req(base, 'POST', '/api/projects', {})
      const projId = createRes.json.id
      const launchPath = `/api/projects/${projId}/interface-launch`

      try {
        // Foreign Origin → 403 (blocks cross-site form/fetch startCode mint)
        const foreign = await fetch(`${base}${launchPath}`, {
          method: 'POST',
          headers: { Origin: 'http://evil.example' },
        })
        assert.equal(foreign.status, 403)

        // Same-origin Origin → works (200)
        const sameOrigin = await fetch(`${base}${launchPath}`, {
          method: 'POST',
          headers: { Origin: base },
        })
        assert.equal(sameOrigin.status, 200)

        // No Origin header → works (non-browser / direct)
        const noOrigin = await fetch(`${base}${launchPath}`, { method: 'POST' })
        assert.equal(noOrigin.status, 200)
      } finally {
        await req(base, 'DELETE', `/api/projects/${projId}`)
      }
    })
  } finally {
    if (backup !== null) fs.writeFileSync(DATA_FILE, backup)
    else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE)
  }
})
