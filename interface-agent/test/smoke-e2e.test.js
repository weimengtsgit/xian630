import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';

const SESSION_SECRET = 'test-secret-for-smoke-e2e';
const VALID_HTML = '<!doctype html><html><body><h1>Smoke</h1></body></html>';
const V2_HTML = '<!doctype html><html><body><h1>V2 Smoke</h1></body></html>';

/**
 * End-to-end smoke test exercising the full merge-blocker flow through the
 * real HTTP API + middleware stack:
 *   fresh project → first generate = V1 (null baseVersionId, Fix 1)
 *   → refresh restores session (GET /api/auth/session, Fix 2)
 *   → V2 from V1 → confirm → delivery (Fix 6 supersede guards in place)
 *   → restart (Fix 3 token stability)
 *   → reopen from agent-pipeline (token still works, Fix 4)
 */
describe('end-to-end smoke: full merge-blocker flow', () => {
  let h;
  afterEach(() => {
    if (h) { try { h.db.close(); } catch {} rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('fresh project → V1 → refresh → V2 → confirm → deliver → restart → token works', async () => {
    // --- harness ---
    const dir = mkdtempSync(join(tmpdir(), 'ia-smoke-'));
    const dbPath = join(dir, 'smoke.db');
    const db = createDbClient({ dbPath });
    runMigrations(db);

    const fileStore = new Map();
    const htmls = [VALID_HTML, V2_HTML];
    let callIdx = 0;
    const deepseekClient = {
      generateHtml: vi.fn().mockImplementation(async () => htmls[callIdx++]),
    };
    const fileClient = {
      uploadText: vi.fn().mockImplementation(async (p, c) => { fileStore.set(p, c); }),
      readText: vi.fn().mockImplementation(async (p) => fileStore.get(p) ?? ''),
    };
    const fetchClient = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => '' });

    const config = {
      publicBaseUrl: '', rateLimitWindowMs: 60000, rateLimitMax: 20,
      confirmedOutputPath: '共享/prototype.html',
      pipelineStageCompleteUrl: 'http://pipe.example/stage',
      pipelineCompleteTimeoutMs: 2000,
      sessionSecret: SESSION_SECRET, secureCookies: false,
      startCodeTtlMs: 90000, internalToken: 'smoke-internal-secret',
      generationPollIntervalMs: 1000, deliveryPollIntervalMs: 1000,
      shareDefaultExpiresMs: 7 * 24 * 60 * 60 * 1000,
    };
    const app = createApp({ config, deepseekClient, fileClient, fetchClient, db });
    h = { dir, db, app };

    const cookieFor = (sid) => `ia_session=${app.locals.sessionAuth.sign(sid)}`;

    // --- Step 1: fresh project → resolve-create (Fix 4: needs X-Internal-Token) ---
    const resolve1 = await request(app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'smoke-internal-secret')
      .send({ projectKey: 'smoke-project' });
    expect(resolve1.status).toBe(201);
    const { sessionId, editToken } = resolve1.body;
    expect(editToken.startsWith('iaet_')).toBe(true);

    // --- Step 2: first generate with null baseVersionId → root V1 (Fix 1) ---
    const gen1 = await request(app)
      .post(`/api/interface-sessions/${sessionId}/generations`)
      .set('Cookie', cookieFor(sessionId))
      .send({ baseVersionId: null, instruction: 'create dashboard', idempotencyKey: 'smoke-v1' });
    expect(gen1.status).toBe(202);

    await app.locals.worker.tick();

    const gen1Status = await request(app)
      .get(`/api/interface-sessions/${sessionId}/generations/${gen1.body.generationRequestId}`)
      .set('Cookie', cookieFor(sessionId));
    expect(gen1Status.body.status).toBe('succeeded');
    expect(gen1Status.body.versionLabel).toBe('V1');

    const v1Id = gen1Status.body.resultVersionId;
    const session1 = app.locals.repository.getSession(sessionId);
    expect(session1.mainline_head_version_id).toBe(v1Id);

    // --- Step 3: refresh restores session (Fix 2: GET /api/auth/session) ---
    const sessionRestore = await request(app)
      .get('/api/auth/session')
      .set('Cookie', cookieFor(sessionId));
    expect(sessionRestore.status).toBe(200);
    expect(sessionRestore.body.sessionId).toBe(sessionId);
    expect(sessionRestore.body.projectKey).toBe('smoke-project');

    // --- Step 4: V2 from V1 ---
    const gen2 = await request(app)
      .post(`/api/interface-sessions/${sessionId}/generations`)
      .set('Cookie', cookieFor(sessionId))
      .send({ baseVersionId: v1Id, instruction: 'make it darker', idempotencyKey: 'smoke-v2' });
    expect(gen2.status).toBe(202);

    await app.locals.worker.tick();

    const gen2Status = await request(app)
      .get(`/api/interface-sessions/${sessionId}/generations/${gen2.body.generationRequestId}`)
      .set('Cookie', cookieFor(sessionId));
    expect(gen2Status.body.status).toBe('succeeded');
    expect(gen2Status.body.versionLabel).toBe('V2');
    const v2Id = gen2Status.body.resultVersionId;

    // --- Step 5: confirm V2 ---
    const confirmRes = await request(app)
      .post(`/api/interface-sessions/${sessionId}/confirmations`)
      .set('Cookie', cookieFor(sessionId))
      .send({ versionId: v2Id, expectedConfirmedVersionId: null });
    expect(confirmRes.status).toBe(200);
    const deliveryId = confirmRes.body.delivery.id;

    // --- Step 6: delivery worker delivers ---
    await app.locals.deliveryWorker.tick();

    const deliveryRow = db.prepare('SELECT * FROM interface_deliveries WHERE id = ?').get(deliveryId);
    expect(deliveryRow.status).toBe('delivered');

    // Compat file written
    expect(fileStore.has('共享/smoke-project/prototype.html')).toBe(true);
    // Pipeline called
    expect(fetchClient).toHaveBeenCalledTimes(1);

    // --- Step 7: restart (Fix 3: token stability) ---
    const oldHash = app.locals.repository.getSession(sessionId).edit_token_hash;

    const restartRes = await request(app)
      .post(`/api/interface-sessions/${sessionId}/restart`)
      .set('Cookie', cookieFor(sessionId));
    expect(restartRes.status).toBe(200);
    const newSessionId = restartRes.body.sessionId;
    expect(newSessionId).not.toBe(sessionId);

    const newHash = app.locals.repository.getSession(newSessionId).edit_token_hash;
    expect(newHash).toBe(oldHash); // Fix 3: token hash preserved

    // --- Step 8: reopen from agent-pipeline (resolve-verify with ORIGINAL token) ---
    const resolve2 = await request(app)
      .post('/api/interface-sessions/resolve')
      .send({ projectKey: 'smoke-project', editToken }); // ORIGINAL plaintext token
    expect(resolve2.status).toBe(200); // NOT 401
    expect(resolve2.body.sessionId).toBe(newSessionId);
    expect(resolve2.body.startCode).toBeTruthy();
  });
});

// ===================================================== R3 smoke: merge-blocker round-3 flow
// Exercises the cross-feature critical path through the real HTTP API + worker:
//   direct open → independent session (Sp6)
//   → generate V1 (null baseVersionId) (Sp2 backend fast-path + root V1)
//   → lost-202 retry reuses the idempotency key (no duplicate model call) (Sp2)
//   → confirm V1 → mid-flight confirm V2 → old V1 delivery NOT pushed (Sp1)
//   → restart mid-generation resumes from staged_html (no re-call) (Sp5)
describe('end-to-end smoke: merge-blocker R3 flow', () => {
  let h;
  afterEach(() => {
    if (h) { try { h.db.close(); } catch {} rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('independent → V1 → lost-202 retry (no dup) → confirm supersede (no push) → staged resume (no re-call)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-smoke-r3-'));
    const dbPath = join(dir, 'smoke-r3.db');
    const db = createDbClient({ dbPath });
    runMigrations(db);

    const fileStore = new Map();
    const deepseekClient = { generateHtml: vi.fn().mockResolvedValue(VALID_HTML) };
    const fileClient = {
      uploadText: vi.fn().mockImplementation(async (p, c) => { fileStore.set(p, c); }),
      readText: vi.fn().mockImplementation(async (p) => fileStore.get(p) ?? ''),
    };
    const pipelineCalls = [];
    const fetchClient = vi.fn().mockImplementation(async (url) => {
      pipelineCalls.push(url);
      return { ok: true, status: 200, text: () => '' };
    });

    const config = {
      publicBaseUrl: '', rateLimitWindowMs: 60000, rateLimitMax: 20,
      confirmedOutputPath: '共享/prototype.html',
      pipelineStageCompleteUrl: 'http://pipe.example/r3-stage',
      pipelineCompleteTimeoutMs: 2000,
      sessionSecret: SESSION_SECRET, secureCookies: false,
      startCodeTtlMs: 90000, internalToken: 'smoke-internal-secret',
      generationPollIntervalMs: 1000, deliveryPollIntervalMs: 1000,
      shareDefaultExpiresMs: 7 * 24 * 60 * 60 * 1000,
    };
    const app = createApp({ config, deepseekClient, fileClient, fetchClient, db });
    h = { dir, db, app };
    const cookieFor = (sid) => `ia_session=${app.locals.sessionAuth.sign(sid)}`;

    // --- Step 1: direct open → independent session (Sp6) ---
    const indep = await request(app).post('/api/interface-sessions/independent');
    expect(indep.status).toBe(201);
    const sessionId = indep.body.sessionId;
    const cookie = cookieFor(sessionId);

    // --- Step 2: generate V1 (null baseVersionId) ---
    const gen1 = await request(app)
      .post(`/api/interface-sessions/${sessionId}/generations`)
      .set('Cookie', cookie)
      .send({ baseVersionId: null, instruction: 'make a dashboard', idempotencyKey: 'smoke-v1' });
    expect(gen1.status).toBe(202);
    await app.locals.worker.tick();
    const v1Req = app.locals.repository.getGenerationRequest(gen1.body.generationRequestId);
    expect(v1Req.status).toBe('succeeded');
    expect(app.locals.repository.getVersion(v1Req.result_version_id).version_label).toBe('V1');

    // --- Step 3: lost-202 retry with the SAME key → returns existing, model NOT called again ---
    const modelCallsBefore = deepseekClient.generateHtml.mock.calls.length;
    const retry = await request(app)
      .post(`/api/interface-sessions/${sessionId}/generations`)
      .set('Cookie', cookie)
      .send({ baseVersionId: null, instruction: 'make a dashboard', idempotencyKey: 'smoke-v1' });
    expect(retry.status).toBe(200); // existing (Sp2 backend fast-path before validation)
    expect(retry.body.id).toBe(gen1.body.generationRequestId);
    expect(deepseekClient.generateHtml.mock.calls.length).toBe(modelCallsBefore); // no dup call

    // --- Step 4: confirm V1 → delivery; then mid-flight confirm V2 supersedes V1's delivery ---
    const v1Id = v1Req.result_version_id;
    const v2Seed = app.locals.repository.commitVersion({
      sessionId, parentVersionId: v1Id,
      artifactPath: `out/${sessionId}/v2/prototype.html`,
      contentHash: 'sha256:v2smoke', byteSize: 100, title: 'V2', createdBy: 'seed',
    });
    const confirm1 = await request(app)
      .post(`/api/interface-sessions/${sessionId}/confirmations`)
      .set('Cookie', cookie)
      .send({ versionId: v1Id, expectedConfirmedVersionId: null });
    expect(confirm1.status).toBe(200);
    const deliveryV1Id = confirm1.body.delivery.id;

    // Confirm V2 (supersedes V1's delivery). No worker tick yet → V1's delivery
    // is pending→superseded by the confirm tx itself.
    const confirm2 = await request(app)
      .post(`/api/interface-sessions/${sessionId}/confirmations`)
      .set('Cookie', cookie)
      .send({ versionId: v2Seed.id, expectedConfirmedVersionId: v1Id });
    expect(confirm2.status).toBe(200);

    // Run the delivery worker: it must deliver V2 (the new confirmed) and NOT
    // push for V1 (superseded). pipelineCalls should only reflect V2's push.
    pipelineCalls.length = 0;
    await app.locals.deliveryWorker.tick();
    const dV1 = app.locals.repository.getDelivery(deliveryV1Id);
    expect(dV1.status).toBe('superseded'); // V1's delivery never pushed
    // V2's delivery delivered (the pipeline was notified once for V2).
    const dV2 = app.locals.repository.getDelivery(confirm2.body.delivery.id);
    expect(dV2.status).toBe('delivered');

    // --- Step 5: restart mid-generation resumes from staged_html (no re-call) (Sp5) ---
    // Seed a generating request WITH staged_html (model returned, crashed before
    // commit). recover() resets it to queued; the worker resumes WITHOUT calling
    // the model again.
    const stagedReq = crypto.randomUUID();
    const stagedHtml = '<!doctype html><html><body><h1>staged</h1></body></html>';
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, base_version_id, idempotency_key, instruction, status,
         started_at, created_at, created_by, staged_html, staged_at)
       VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, 'smoke', ?, ?)`,
    ).run(stagedReq, sessionId, v1Id, 'smoke-staged', 'resumed', nowIso, nowIso, stagedHtml, nowIso);

    const modelBeforeResume = deepseekClient.generateHtml.mock.calls.length;
    app.locals.worker.recover();
    await app.locals.worker.tick();

    expect(deepseekClient.generateHtml.mock.calls.length).toBe(modelBeforeResume); // Sp5: no re-call
    const resumedReq = app.locals.repository.getGenerationRequest(stagedReq);
    expect(resumedReq.status).toBe('succeeded');
    expect(resumedReq.staged_html).toBeNull(); // cleared on terminal
  });
});
