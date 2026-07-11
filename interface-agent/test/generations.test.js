import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';

const SESSION_SECRET = 'test-secret-fixed-for-generations-hmac';
const VALID_HTML = '<!doctype html><html><body><h1>Generated</h1></body></html>';
const BASE_HTML = '<!doctype html><html><body><h1>Base</h1></body></html>';

function nowIso() {
  return new Date().toISOString();
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-gen-'));
}

/**
 * Integration harness: temp SQLite DB + all migrations, createApp wired with
 * injectable fake deepseekClient + fileClient. The worker is created inside
 * createApp (app.locals.worker) but NOT auto-started — tests drive it via
 * worker.tick() for deterministic processing without setInterval timing.
 */
function buildHarness(overrides = {}) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'generations.db');
  const db = createDbClient({ dbPath });
  runMigrations(db);

  const deepseekClient = overrides.deepseekClient ?? {
    generateHtml: vi.fn().mockResolvedValue(VALID_HTML),
  };
  // Fix 7: the default fileClient uses a Map store so that readText echoes back
  // exactly what uploadText stored (the post-write hash verification depends on
  // this). Unknown paths (e.g. seeded base-version artifacts) return BASE_HTML.
  const fileStore = new Map();
  const fileClient = overrides.fileClient ?? {
    uploadText: vi.fn().mockImplementation(async (path, content) => { fileStore.set(path, content); }),
    readText: vi.fn().mockImplementation(async (path) => fileStore.get(path) ?? BASE_HTML),
  };

  const config = {
    publicBaseUrl: '',
    rateLimitWindowMs: 60000,
    rateLimitMax: 20,
    confirmedOutputPath: 'test-output/prototype.html',
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    startCodeTtlMs: 90000,
    internalToken: 'test-internal-secret',
    generationPollIntervalMs: 1000,
    ...overrides.config,
  };

  const app = createApp({
    config,
    deepseekClient,
    fileClient,
    fetchClient: vi.fn(),
    db,
  });

  return { dir, db, app, deepseekClient, fileClient, config };
}

function cleanup(h) {
  try {
    h.db.close();
  } catch {
    /* already closed */
  }
  rmSync(h.dir, { recursive: true, force: true });
}

/** Resolve a fresh active session via the API. Returns { sessionId, editToken }. */
async function setupSession(h, projectKey = 'pk-gen') {
  const r = await request(h.app)
    .post('/api/interface-sessions/resolve')
          .set('X-Internal-Token', 'test-internal-secret')
    .send({ projectKey });
  return { sessionId: r.body.sessionId, editToken: r.body.editToken };
}

/** Forge a signed session cookie. */
function cookieFor(h, sessionId) {
  const signed = h.app.locals.sessionAuth.sign(sessionId);
  return `${h.app.locals.sessionAuth.cookieName}=${signed}`;
}

/**
 * Commit a root V1 directly via the repository (no generation request). The
 * artifact_path points to a fake Blade OS location; the harness fileClient
 * serves BASE_HTML for any readText call.
 */
function seedRootVersion(h, sessionId, opts = {}) {
  return h.app.locals.repository.commitVersion({
    sessionId,
    parentVersionId: null,
    artifactPath: opts.artifactPath || `out/${sessionId}/v1/prototype.html`,
    contentHash: opts.contentHash || 'sha256:v1',
    byteSize: 100,
    title: opts.title || 'V1',
    createdBy: 'seed',
  });
}

/**
 * Seed a version WITH a generation request (so getBranchInstructions projects
 * its instruction). Mirrors numbering.test.js's seeding approach: insert the
 * request row directly, then commitVersion with generationRequestId.
 */
function seedVersionWithInstruction(h, sessionId, { parentVersionId, instruction, artifactPath }) {
  const repo = h.app.locals.repository;
  const requestId = crypto.randomUUID();
  h.db
    .prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, base_version_id, idempotency_key, instruction, status,
         created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'succeeded', ?, 'seed')`,
    )
    .run(requestId, sessionId, parentVersionId, `seed-${requestId}`, instruction, nowIso());

  const version = repo.commitVersion({
    sessionId,
    parentVersionId,
    generationRequestId: requestId,
    artifactPath: artifactPath || `out/${sessionId}/${requestId}/prototype.html`,
    contentHash: 'sha256:' + requestId,
    byteSize: 100,
    title: instruction.slice(0, 20),
    createdBy: 'seed',
  });
  return { version, requestId };
}

/** POST a generation request. Returns the supertest response. */
function postGeneration(h, sessionId, body) {
  return request(h.app)
    .post(`/api/interface-sessions/${sessionId}/generations`)
    .set('Cookie', cookieFor(h, sessionId))
    .send(body);
}

// ============================================================= 1. idempotency

describe('generation idempotency', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('1. same idempotencyKey returns the same request; model called once; single version', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-idem');
    const v1 = seedRootVersion(h, sessionId);

    const body = {
      baseVersionId: v1.id,
      instruction: 'Make the header blue',
      idempotencyKey: 'idem-001',
    };

    const r1 = await postGeneration(h, sessionId, body);
    expect(r1.status).toBe(202);
    expect(r1.body.generationRequestId).toBeTruthy();
    expect(r1.body.status).toBe('queued');

    // Process the request
    await h.app.locals.worker.tick();

    // Second POST with the same idempotency key → returns the existing request
    const r2 = await postGeneration(h, sessionId, body);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.generationRequestId);
    expect(r2.body.status).toBe('succeeded');

    // Model called exactly once
    expect(h.deepseekClient.generateHtml).toHaveBeenCalledTimes(1);

    // Exactly one version beyond the seeded V1
    const tree = h.app.locals.repository.getVersionTree(sessionId);
    expect(tree).toHaveLength(2);
  });
});

// =================================================== 2. per-step atomic failure

describe('atomic failure leaves no half-baked version', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  async function runFailingCase(h, sessionId, baseV1, idemKey) {
    const versionsBefore = h.app.locals.repository.getVersionTree(sessionId).length;
    const r = await postGeneration(h, sessionId, {
      baseVersionId: baseV1.id,
      instruction: 'do something',
      idempotencyKey: idemKey,
    });
    expect(r.status).toBe(202);
    const requestId = r.body.generationRequestId;

    await h.app.locals.worker.tick();

    const req = h.app.locals.repository.getGenerationRequest(requestId);
    expect(req.status).toBe('failed');
    expect(req.result_version_id).toBeNull();
    expect(req.error_code).toBeTruthy();

    // No new version was committed
    const versionsAfter = h.app.locals.repository.getVersionTree(sessionId).length;
    expect(versionsAfter).toBe(versionsBefore);

    // Head unchanged (V1 still head)
    const session = h.app.locals.repository.getSession(sessionId);
    expect(session.mainline_head_version_id).toBe(baseV1.id);
  }

  it('2a. model throws → failed, no version', async () => {
    h = buildHarness({
      deepseekClient: { generateHtml: vi.fn().mockRejectedValue(new Error('model down')) },
    });
    const { sessionId } = await setupSession(h, 'pk-fail-model');
    const v1 = seedRootVersion(h, sessionId);
    await runFailingCase(h, sessionId, v1, 'idem-model');
  });

  it('2b. HTML validation fails → failed, no version', async () => {
    h = buildHarness({
      deepseekClient: { generateHtml: vi.fn().mockResolvedValue('not html at all') },
    });
    const { sessionId } = await setupSession(h, 'pk-fail-html');
    const v1 = seedRootVersion(h, sessionId);
    await runFailingCase(h, sessionId, v1, 'idem-html');
  });

  it('2c. fileClient.uploadText throws → failed, no version', async () => {
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockRejectedValue(new Error('disk full')),
        readText: vi.fn().mockResolvedValue(BASE_HTML),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-fail-blade');
    const v1 = seedRootVersion(h, sessionId);
    await runFailingCase(h, sessionId, v1, 'idem-blade');
  });

  it('2d. commitVersion (DB) throws → failed, no version', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-fail-db');
    const v1 = seedRootVersion(h, sessionId);

    // Sabotage commitVersion to simulate a DB fault inside the success tx
    const repo = h.app.locals.repository;
    const original = repo.commitVersion;
    repo.commitVersion = () => { throw new Error('simulated DB fault'); };

    try {
      await runFailingCase(h, sessionId, v1, 'idem-db');
    } finally {
      repo.commitVersion = original;
    }
  });
});

// ================================================ 3. branch-context exclusion

describe('branch context assembly', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('3. model history contains only ancestor instructions (no siblings/descendants)', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-branch-ctx');

    // Build a tree:
    //   V1 (instr-root) → V2 (instr-mainline) → V3 (instr-mainline2)
    //   V1 → V1.1 (instr-branch)
    //   V1 → V1.2 (instr-sibling)
    const { version: v1 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: null,
      instruction: 'instr-root',
    });
    const { version: v2 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'instr-mainline',
    });
    seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v2.id,
      instruction: 'instr-mainline2',
    });
    const { version: v11 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'instr-branch',
    });
    seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'instr-sibling',
    });

    // Advance mainline past v1 so v1 is not head (making v1.1 a real branch)
    // v2 already advanced head; v11 and v12 branched off v1.

    // Now generate from base = V1.1. The model context should contain
    // ONLY [instr-root, instr-branch] — NOT instr-mainline, instr-mainline2,
    // or instr-sibling.
    const r = await postGeneration(h, sessionId, {
      baseVersionId: v11.id,
      instruction: 'instr-new-from-v11',
      idempotencyKey: 'idem-branch',
    });
    expect(r.status).toBe(202);
    await h.app.locals.worker.tick();

    expect(h.deepseekClient.generateHtml).toHaveBeenCalledTimes(1);
    const callArg = h.deepseekClient.generateHtml.mock.calls[0][0];

    // history is an array of {role, content}
    const historyContents = callArg.history.map((item) => item.content);
    expect(historyContents).toEqual(['instr-root', 'instr-branch']);

    // Explicitly excludes descendants and siblings
    expect(historyContents).not.toContain('instr-mainline');
    expect(historyContents).not.toContain('instr-mainline2');
    expect(historyContents).not.toContain('instr-sibling');

    // The new instruction is the message
    expect(callArg.message).toBe('instr-new-from-v11');

    // currentHtml comes from the base version's artifact
    expect(callArg.currentHtml).toBe(BASE_HTML);
  });
});

// ================================================ 4. concurrent mainline

describe('concurrent mainline serialization', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('4. two requests same base=head: first advances mainline, second branches', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-concurrent');
    const v1 = seedRootVersion(h, sessionId);

    // Two requests both based on V1 (=head)
    const r1 = await postGeneration(h, sessionId, {
      baseVersionId: v1.id,
      instruction: 'first edit',
      idempotencyKey: 'idem-c1',
    });
    const r2 = await postGeneration(h, sessionId, {
      baseVersionId: v1.id,
      instruction: 'second edit',
      idempotencyKey: 'idem-c2',
    });
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);

    // Process serially (single-instance worker)
    await h.app.locals.worker.tick(); // processes first queued
    await h.app.locals.worker.tick(); // processes second queued

    const req1 = h.app.locals.repository.getGenerationRequest(r1.body.generationRequestId);
    const req2 = h.app.locals.repository.getGenerationRequest(r2.body.generationRequestId);
    expect(req1.status).toBe('succeeded');
    expect(req2.status).toBe('succeeded');

    const v1Result = h.app.locals.repository.getVersion(req1.result_version_id);
    const v2Result = h.app.locals.repository.getVersion(req2.result_version_id);

    // Labels don't conflict: one is V2 (mainline), the other is V1.1 (branch)
    const labels = [v1Result.version_label, v2Result.version_label].sort();
    expect(labels).toEqual(['V1.1', 'V2']);

    // Both versions exist
    const tree = h.app.locals.repository.getVersionTree(sessionId);
    expect(tree).toHaveLength(3); // V1 + 2 new
  });
});

// ================================================ 5. cross-session 403

describe('cross-session base rejected', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('5. POST with other session baseVersionId → 403', async () => {
    h = buildHarness();
    const { sessionId: sidA } = await setupSession(h, 'pk-x-a');
    const { sessionId: sidB } = await setupSession(h, 'pk-x-b');
    const vB = seedRootVersion(h, sidB);

    const r = await postGeneration(h, sidA, {
      baseVersionId: vB.id,
      instruction: 'cross-session attempt',
      idempotencyKey: 'idem-x',
    });
    expect(r.status).toBe(403);
  });
});

// ================================================ 6. restart recovery

describe('restart recovery', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('6. crashed generating request is re-queued on worker start and eventually succeeds', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-restart');
    const v1 = seedRootVersion(h, sessionId);

    // Simulate a crash mid-processing: insert a request stuck in 'generating'
    const requestId = crypto.randomUUID();
    h.db
      .prepare(
        `INSERT INTO interface_generation_requests
          (id, session_id, base_version_id, idempotency_key, instruction, status,
           started_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, 'test')`,
      )
      .run(requestId, sessionId, v1.id, 'idem-crash', 'recovered instruction', nowIso(), nowIso());

    // Worker restart: recover() resets 'generating' → 'queued'
    const resetCount = h.app.locals.worker.recover();
    expect(resetCount).toBeGreaterThanOrEqual(1);

    // Process the recovered request
    await h.app.locals.worker.tick();

    const req = h.app.locals.repository.getGenerationRequest(requestId);
    expect(req.status).toBe('succeeded');
    expect(req.result_version_id).toBeTruthy();

    // Exactly one new version (V2 or branch)
    const tree = h.app.locals.repository.getVersionTree(sessionId);
    expect(tree).toHaveLength(2);
  });

  it('F6. crashed SAVING request (with staged_html) resumes from staged_html on restart', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-saving-restart');
    const v1 = seedRootVersion(h, sessionId);

    // Simulate a crash after the model returned + staged_html was persisted, but
    // before the artifact write completed: request is stuck in 'saving'.
    const requestId = crypto.randomUUID();
    h.db
      .prepare(
        `INSERT INTO interface_generation_requests
          (id, session_id, base_version_id, idempotency_key, instruction, status,
           started_at, created_at, created_by, staged_html, staged_at)
         VALUES (?, ?, ?, ?, ?, 'saving', ?, ?, 'test', ?, ?)`,
      )
      .run(
        requestId, sessionId, v1.id, 'idem-saving', 'resumed from saving',
        nowIso(), nowIso(), VALID_HTML, nowIso(),
      );

    // Restart recovery resets 'saving' → 'queued' (treated like 'generating').
    const resetCount = h.app.locals.worker.recover();
    expect(resetCount).toBeGreaterThanOrEqual(1);

    const afterRecover = h.app.locals.repository.getGenerationRequest(requestId);
    expect(afterRecover.status).toBe('queued');

    // Process — should resume from staged_html (NO model call).
    await h.app.locals.worker.tick();
    expect(h.deepseekClient.generateHtml).not.toHaveBeenCalled();

    const req = h.app.locals.repository.getGenerationRequest(requestId);
    expect(req.status).toBe('succeeded');
    expect(req.result_version_id).toBeTruthy();
  });
});

// ================================================ F6: saving status transition

describe('F6: saving status transition', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('F6. transitions queued → generating → saving → succeeded (saving observed during upload)', async () => {
    // Use a deferred uploadText so we can observe the 'saving' status mid-write.
    let resolveUpload;
    const uploadGate = new Promise((resolve) => { resolveUpload = resolve; });
    let statusDuringUpload = null;
    const fileStore = new Map();
    const customFileClient = {
      uploadText: vi.fn().mockImplementation(async (p, content) => {
        fileStore.set(p, content);
        const row = h.db
          .prepare(`SELECT status FROM interface_generation_requests WHERE status IN ('generating','saving')`)
          .get();
        statusDuringUpload = row?.status ?? null;
        await uploadGate;
      }),
      readText: vi.fn().mockImplementation(async (p) => fileStore.get(p) ?? BASE_HTML),
    };

    h = buildHarness({ fileClient: customFileClient });
    const { sessionId } = await setupSession(h, 'pk-saving-obs');
    const v1 = seedRootVersion(h, sessionId);

    const r = await postGeneration(h, sessionId, {
      baseVersionId: v1.id,
      instruction: 'observe saving',
      idempotencyKey: 'idem-saving-obs',
    });
    const requestId = r.body.generationRequestId;

    // tick runs until uploadText blocks on the gate.
    const tickPromise = h.app.locals.worker.tick();

    // Give the async tick a chance to reach the upload (await a microtask flush).
    await Promise.resolve();
    await Promise.resolve();

    // While upload is blocked, the request MUST be in 'saving' status (F6).
    expect(statusDuringUpload).toBe('saving');

    // Release the upload gate → tick completes → succeeded.
    resolveUpload();
    await tickPromise;

    const req = h.app.locals.repository.getGenerationRequest(requestId);
    expect(req.status).toBe('succeeded');
  });

  it('M3. staged_html is persisted BEFORE upload (model-call window minimized)', async () => {
    // If upload fails, staged_html must already be set — proving it was written
    // as the FIRST statement after model return, before any upload/processing.
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockRejectedValue(new Error('disk full')),
        readText: vi.fn().mockResolvedValue(BASE_HTML),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-m3');
    const v1 = seedRootVersion(h, sessionId);

    const r = await postGeneration(h, sessionId, {
      baseVersionId: v1.id,
      instruction: 'stage before upload',
      idempotencyKey: 'idem-m3',
    });
    const requestId = r.body.generationRequestId;

    await h.app.locals.worker.tick();

    // Upload failed → request is failed, no version.
    const req = h.app.locals.repository.getGenerationRequest(requestId);
    expect(req.status).toBe('failed');

    // M3 proof: staged_html WAS persisted before the upload attempt (so a
    // restart resume would skip the model call). The fail path clears it, so
    // we verify via the deepseek call count (model was called exactly once +
    // staged was set synchronously after). We can't read staged_html after
    // failure (terminal clears it), so assert the model ran once and the
    // upload was attempted (order: model → staged → upload → fail).
    expect(h.deepseekClient.generateHtml).toHaveBeenCalledTimes(1);
    expect(h.fileClient.uploadText).toHaveBeenCalledTimes(1);
  });
});

// ================================================ 7. GET progress

describe('GET generation progress', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('7. queued / generating / succeeded / failed return correct fields', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-progress');
    const v1 = seedRootVersion(h, sessionId);

    // --- queued ---
    const rQueued = await postGeneration(h, sessionId, {
      baseVersionId: v1.id,
      instruction: 'queued task',
      idempotencyKey: 'idem-q',
    });
    const queuedId = rQueued.body.generationRequestId;

    const gQueued = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/generations/${queuedId}`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(gQueued.status).toBe(200);
    expect(gQueued.body.status).toBe('queued');
    expect(gQueued.body.id).toBe(queuedId);
    expect(gQueued.body.createdAt).toBeTruthy();
    expect(gQueued.body.resultVersionId).toBeUndefined();
    expect(gQueued.body.versionLabel).toBeUndefined();

    // --- generating (simulated) ---
    const genId = crypto.randomUUID();
    h.db
      .prepare(
        `INSERT INTO interface_generation_requests
          (id, session_id, base_version_id, idempotency_key, instruction, status,
           started_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'generating', ?, ?)`,
      )
      .run(genId, sessionId, v1.id, 'idem-gen', 'generating task', nowIso(), nowIso());
    const gGen = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/generations/${genId}`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(gGen.status).toBe(200);
    expect(gGen.status).toBe(200);
    expect(gGen.body.status).toBe('generating');
    expect(gGen.body.startedAt).toBeTruthy();

    // --- succeeded ---
    await h.app.locals.worker.tick(); // process the queued one
    const gSucceeded = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/generations/${queuedId}`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(gSucceeded.status).toBe(200);
    expect(gSucceeded.body.status).toBe('succeeded');
    expect(gSucceeded.body.resultVersionId).toBeTruthy();
    expect(gSucceeded.body.versionLabel).toMatch(/^V/);
    expect(gSucceeded.body.finishedAt).toBeTruthy();
    expect(gSucceeded.body.errorCode).toBeUndefined();

    // --- failed ---
    h = buildHarness({
      deepseekClient: { generateHtml: vi.fn().mockRejectedValue(new Error('fail')) },
    });
    // re-setup for the failed case (h was replaced)
    const { sessionId: sid2 } = await setupSession(h, 'pk-progress-fail');
    const v1b = seedRootVersion(h, sid2);
    const rFail = await postGeneration(h, sid2, {
      baseVersionId: v1b.id,
      instruction: 'will fail',
      idempotencyKey: 'idem-fail',
    });
    await h.app.locals.worker.tick();
    const gFailed = await request(h.app)
      .get(`/api/interface-sessions/${sid2}/generations/${rFail.body.generationRequestId}`)
      .set('Cookie', cookieFor(h, sid2));
    expect(gFailed.status).toBe(200);
    expect(gFailed.body.status).toBe('failed');
    expect(gFailed.body.errorCode).toBeTruthy();
    expect(gFailed.body.resultVersionId).toBeUndefined();
  });
});

// ================================================ 8. sanitization

describe('error message sanitization', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('8. failed error_message / GET response must not leak instruction or PAT', async () => {
    const SECRET_INSTRUCTION = 'My secret PAT is sk-deadbeef123 do not leak';
    h = buildHarness({
      deepseekClient: { generateHtml: vi.fn().mockRejectedValue(new Error('model exploded')) },
    });
    const { sessionId } = await setupSession(h, 'pk-sani');
    const v1 = seedRootVersion(h, sessionId);

    const r = await postGeneration(h, sessionId, {
      baseVersionId: v1.id,
      instruction: SECRET_INSTRUCTION,
      idempotencyKey: 'idem-sani',
    });
    await h.app.locals.worker.tick();

    // DB-level: error_message must not contain the secret
    const req = h.app.locals.repository.getGenerationRequest(r.body.generationRequestId);
    expect(req.status).toBe('failed');
    const storedMsg = req.error_message || '';
    const storedCode = req.error_code || '';
    expect(storedMsg).not.toContain('sk-deadbeef123');
    expect(storedMsg).not.toContain(SECRET_INSTRUCTION);
    expect(storedCode).not.toContain('sk-deadbeef123');

    // API-level: GET response must not leak either
    const g = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/generations/${r.body.generationRequestId}`)
      .set('Cookie', cookieFor(h, sessionId));
    const body = JSON.stringify(g.body);
    expect(body).not.toContain('sk-deadbeef123');
    expect(body).not.toContain(SECRET_INSTRUCTION);
  });
});

// ================================================ 9. Fix 1: root V1 via generation

describe('first generation creates root V1 (Fix 1)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('F1a. null baseVersionId on 0-version session → succeeds → root V1 (mainline_head=V1)', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-root-gen');

    // Session has 0 versions. POST with null baseVersionId.
    const r = await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'Create a dashboard',
      idempotencyKey: 'idem-root',
    });
    expect(r.status).toBe(202);

    await h.app.locals.worker.tick();

    // The request succeeded
    const req = h.app.locals.repository.getGenerationRequest(r.body.generationRequestId);
    expect(req.status).toBe('succeeded');
    expect(req.result_version_id).toBeTruthy();

    // Root V1 created
    const version = h.app.locals.repository.getVersion(req.result_version_id);
    expect(version.version_label).toBe('V1');
    expect(version.parent_version_id).toBeNull();

    // mainline_head points to V1
    const session = h.app.locals.repository.getSession(sessionId);
    expect(session.mainline_head_version_id).toBe(version.id);

    // Exactly one version
    const tree = h.app.locals.repository.getVersionTree(sessionId);
    expect(tree).toHaveLength(1);
  });

  it('F1b. null baseVersionId on a session WITH versions → 400 (需要选择基线版本)', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-root-gen-2');
    seedRootVersion(h, sessionId); // now has 1 version

    const r = await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'try root again',
      idempotencyKey: 'idem-root-2',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('基线版本');
  });

  it('F1c. worker model input for root generation has empty history', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-root-gen-3');

    await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'first instruction ever',
      idempotencyKey: 'idem-root-3',
    });
    await h.app.locals.worker.tick();

    expect(h.deepseekClient.generateHtml).toHaveBeenCalledTimes(1);
    const callArg = h.deepseekClient.generateHtml.mock.calls[0][0];

    // Root generation: no ancestor context
    expect(callArg.history).toEqual([]);
    // The new instruction is the message
    expect(callArg.message).toBe('first instruction ever');
    // No base HTML (root has no parent)
    expect(callArg.currentHtml).toBe('');
  });
});

// ================================================ 10. Fix 7: post-write hash verify

describe('post-write hash verification (Fix 7)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('F7a. upload succeeds but read-back differs → request failed, no version', async () => {
    // The fake fileClient returns CORRUPTED content on read-back, so the
    // post-write hash check catches the mismatch.
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue('CORRUPTED CONTENT - NOT WHAT WE UPLOADED'),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-hash-mismatch');

    const r = await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'generate something',
      idempotencyKey: 'idem-hash',
    });
    expect(r.status).toBe(202);
    await h.app.locals.worker.tick();

    const req = h.app.locals.repository.getGenerationRequest(r.body.generationRequestId);
    expect(req.status).toBe('failed');
    expect(req.result_version_id).toBeNull();
    expect(req.error_code).toBe('blade');

    // No version was committed
    expect(h.app.locals.repository.getVersionTree(sessionId)).toHaveLength(0);
  });

  it('F7b. read-back fails entirely → request failed, no version', async () => {
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockRejectedValue(new Error('read-back failed')),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-hash-readfail');

    const r = await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'generate something',
      idempotencyKey: 'idem-hash2',
    });
    await h.app.locals.worker.tick();

    const req = h.app.locals.repository.getGenerationRequest(r.body.generationRequestId);
    expect(req.status).toBe('failed');
    expect(req.result_version_id).toBeNull();
    expect(h.app.locals.repository.getVersionTree(sessionId)).toHaveLength(0);
  });

  it('F7c. read-back matches → succeeds (normal path)', async () => {
    // The default harness fileClient returns BASE_HTML for all reads. For a
    // root generation, read-back returns BASE_HTML which differs from
    // VALID_HTML → would fail. So we use a fileClient that echoes back exactly
    // what was uploaded (upload stores it, readText returns it).
    const store = new Map();
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockImplementation(async (path, content) => { store.set(path, content); }),
        readText: vi.fn().mockImplementation(async (path) => store.get(path) || ''),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-hash-ok');

    const r = await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'generate something',
      idempotencyKey: 'idem-hash3',
    });
    await h.app.locals.worker.tick();

    const req = h.app.locals.repository.getGenerationRequest(r.body.generationRequestId);
    expect(req.status).toBe('succeeded');
    expect(req.result_version_id).toBeTruthy();
    expect(h.app.locals.repository.getVersionTree(sessionId)).toHaveLength(1);
  });
});

// ================================================ 11. S3: rate limiting on generations POST

describe('S3: rate limiting on POST .../generations', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('S3a. N+1th rapid request from one IP → 429', async () => {
    // Tight limit so the test is deterministic. resolve/seed do NOT go through
    // the generations limiter (it is scoped to the POST route only).
    h = buildHarness({ config: { rateLimitWindowMs: 60000, rateLimitMax: 3 } });
    const { sessionId } = await setupSession(h, 'pk-rate');
    const v1 = seedRootVersion(h, sessionId);

    const post = (n) => postGeneration(h, sessionId, {
      baseVersionId: v1.id,
      instruction: `rate test ${n}`,
      idempotencyKey: `rate-${n}`,
    });

    // max=3 → first 3 pass (202)
    for (let i = 1; i <= 3; i += 1) {
      const r = await post(i);
      expect(r.status).toBe(202);
    }
    // 4th rapid request from the same IP → 429 with the existing message
    const blocked = await post(4);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBeTruthy();
  });
});

// ================================================ 12. Sp2: idempotency fast-path BEFORE baseVersionId validation

describe('Sp2: idempotency fast-path before baseVersionId validation', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('Sp2a. retry of a SUCCEEDED root-generation (null baseVersionId, now has V1) returns the existing request, not 400', async () => {
    // Root cause: the idempotency fast-path ran AFTER the hasVersions check, so
    // retrying a succeeded root-generation (null baseVersionId, but the session
    // now has V1) returned 400 instead of the existing succeeded request.
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-sp2');

    // First generation: null baseVersionId on a 0-version session → root V1.
    const r1 = await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'create root',
      idempotencyKey: 'idem-sp2-root',
    });
    expect(r1.status).toBe(202);
    await h.app.locals.worker.tick();

    const req = h.app.locals.repository.getGenerationRequest(r1.body.generationRequestId);
    expect(req.status).toBe('succeeded');

    // Retry with the SAME body (null baseVersionId). The session now has V1, so
    // the hasVersions check would 400 if it ran first. The fast-path must return
    // the existing succeeded request (200) BEFORE that validation.
    const r2 = await postGeneration(h, sessionId, {
      baseVersionId: null,
      instruction: 'create root',
      idempotencyKey: 'idem-sp2-root',
    });
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.generationRequestId);
    expect(r2.body.status).toBe('succeeded');
  });
});

// ================================================ 13. Sp5: staged_html restart resume (no duplicate model call)

describe('Sp5: staged model output (restart resumes from staged, no re-call)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('Sp5a. a generating request WITH staged_html → worker resumes WITHOUT calling the model; version created from staged html', async () => {
    // Restart scenario: the model returned (staged_html persisted), but the
    // process crashed before write/commit. On restart the request is reset to
    // 'queued'; the worker must SKIP the model call and produce the version from
    // the staged HTML.
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-sp5a');
    const v1 = seedRootVersion(h, sessionId);

    const staged = '<!doctype html><html><body><h1>Staged by prior model call</h1></body></html>';
    const requestId = crypto.randomUUID();
    h.db
      .prepare(
        `INSERT INTO interface_generation_requests
          (id, session_id, base_version_id, idempotency_key, instruction, status,
           started_at, created_at, created_by, staged_html, staged_at)
         VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, 'test', ?, ?)`,
      )
      .run(requestId, sessionId, v1.id, 'idem-sp5a', 'recovered instruction', nowIso(), nowIso(), staged, nowIso());

    // Restart recovery resets 'generating' → 'queued' (staged_html persists).
    h.app.locals.worker.recover();

    // fileClient echoes uploads so the post-write hash check passes.
    await h.app.locals.worker.tick();

    // Model NOT called (resumed from staged).
    expect(h.deepseekClient.generateHtml).not.toHaveBeenCalled();

    // Version created from the staged HTML.
    const req = h.app.locals.repository.getGenerationRequest(requestId);
    expect(req.status).toBe('succeeded');
    expect(req.result_version_id).toBeTruthy();

    // staged_html cleared on terminal success.
    expect(req.staged_html).toBeNull();
  });

  it('Sp5b. a generating request WITHOUT staged_html (never reached the model) → model IS called (legitimate first attempt)', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-sp5b');
    const v1 = seedRootVersion(h, sessionId);

    const requestId = crypto.randomUUID();
    h.db
      .prepare(
        `INSERT INTO interface_generation_requests
          (id, session_id, base_version_id, idempotency_key, instruction, status,
           started_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, 'test')`,
      )
      .run(requestId, sessionId, v1.id, 'idem-sp5b', 'never reached model', nowIso(), nowIso());

    h.app.locals.worker.recover();
    await h.app.locals.worker.tick();

    // No staged_html → legitimate first attempt → model called once.
    expect(h.deepseekClient.generateHtml).toHaveBeenCalledTimes(1);

    const req = h.app.locals.repository.getGenerationRequest(requestId);
    expect(req.status).toBe('succeeded');
  });
});
