import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';

const SESSION_SECRET = 'test-secret-fixed-for-delivery-hmac';
const VERSION_HTML = '<!doctype html><html><body><h1>Delivered</h1></body></html>';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-deliv-'));
}

function buildHarness(overrides = {}) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'deliveries.db');
  const db = createDbClient({ dbPath });
  runMigrations(db);

  const deepseekClient = { generateHtml: vi.fn().mockResolvedValue(VERSION_HTML) };
  const fileClient = overrides.fileClient ?? {
    uploadText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(VERSION_HTML),
  };
  const fetchClient = overrides.fetchClient ?? vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(''),
  });

  const config = {
    publicBaseUrl: '',
    rateLimitWindowMs: 60000,
    rateLimitMax: 20,
    confirmedOutputPath: '共享/prototype.html',
    pipelineStageCompleteUrl: overrides.pipelineUrl ?? 'http://pipeline.example/stage',
    pipelineCompleteTimeoutMs: 2000,
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    startCodeTtlMs: 90000,
    internalToken: 'test-internal-secret',
    generationPollIntervalMs: 1000,
    deliveryPollIntervalMs: 1000,
    shareDefaultExpiresMs: 7 * 24 * 60 * 60 * 1000,
    ...overrides.config,
  };

  const app = createApp({
    config,
    deepseekClient,
    fileClient,
    fetchClient,
    db,
  });

  return { dir, db, app, fileClient, fetchClient, config };
}

function cleanup(h) {
  try {
    h.db.close();
  } catch {
    /* already closed */
  }
  rmSync(h.dir, { recursive: true, force: true });
}

async function setupSession(h, projectKey = 'pk-deliv') {
  const r = await request(h.app)
    .post('/api/interface-sessions/resolve')
          .set('X-Internal-Token', 'test-internal-secret')
    .send({ projectKey });
  return { sessionId: r.body.sessionId, editToken: r.body.editToken };
}

function cookieFor(h, sessionId) {
  const signed = h.app.locals.sessionAuth.sign(sessionId);
  return `${h.app.locals.sessionAuth.cookieName}=${signed}`;
}

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

async function confirmVersion(h, sessionId, versionId, expected = null) {
  return request(h.app)
    .post(`/api/interface-sessions/${sessionId}/confirmations`)
    .set('Cookie', cookieFor(h, sessionId))
    .send({ versionId, expectedConfirmedVersionId: expected });
}

function deliveriesForSession(h, sessionId) {
  return h.db
    .prepare(`SELECT * FROM interface_deliveries WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId);
}

function setDeliveryStatus(h, deliveryId, status) {
  h.db
    .prepare(`UPDATE interface_deliveries SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), deliveryId);
}

// ================================================ 1. worker success

describe('delivery worker success', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('1. writes compat 共享/<project>/prototype.html + calls pipeline with the idempotency key', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-success');
    const v1 = seedRootVersion(h, sessionId);

    const c = await confirmVersion(h, sessionId, v1.id);
    expect(c.status).toBe(200);
    const deliveryId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    const delivery = h.db
      .prepare(`SELECT * FROM interface_deliveries WHERE id = ?`)
      .get(deliveryId);
    expect(delivery.status).toBe('delivered');
    expect(delivery.attempts).toBe(1);

    // Compat path written: 共享/<projectKey>/prototype.html
    const uploadCalls = h.fileClient.uploadText.mock.calls.map((c2) => c2[0]);
    expect(uploadCalls).toContain('共享/pk-success/prototype.html');

    // Pipeline called once. Body is the legacy-compatible {status:'completed'}
    // only (no extra fields that could break the pipeline endpoint); the
    // idempotency key + project/version travel as headers so the pipeline can
    // still dedupe a restart re-run where it supports the header.
    expect(h.fetchClient).toHaveBeenCalledTimes(1);
    const pipelineBody = JSON.parse(h.fetchClient.mock.calls[0][1].body);
    expect(pipelineBody).toEqual({ status: 'completed' });
    const pipelineHeaders = h.fetchClient.mock.calls[0][1].headers;
    expect(pipelineHeaders['X-Idempotency-Key']).toBe(delivery.idempotency_key);
    expect(pipelineHeaders['X-Interface-Project']).toBe('pk-success');

    // Confirm NOT touched by delivery (still v1)
    const session = h.app.locals.repository.getSession(sessionId);
    expect(session.confirmed_version_id).toBe(v1.id);
  });
});

// ================================================ 2. failure does not undo confirm

describe('delivery failure leaves confirm intact', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('2a. blade read/upload failure → delivery failed, confirm stays confirmed', async () => {
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockRejectedValue(new Error('disk full')),
        readText: vi.fn().mockRejectedValue(new Error('blade read failed')),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-blade-fail');
    const v1 = seedRootVersion(h, sessionId);

    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    const delivery = h.db
      .prepare(`SELECT * FROM interface_deliveries WHERE id = ?`)
      .get(deliveryId);
    expect(delivery.status).toBe('failed');
    expect(delivery.error_code).toBeTruthy();
    // Sanitized: no raw exception text / no PAT
    expect(delivery.error_message || '').not.toContain('disk full');

    // Confirm UNCHANGED
    const session = h.app.locals.repository.getSession(sessionId);
    expect(session.confirmed_version_id).toBe(v1.id);

    // Pipeline never reached (failure was before/at file write)
    expect(h.fetchClient).not.toHaveBeenCalled();
  });

  it('2b. pipeline failure → delivery failed, confirm stays confirmed', async () => {
    h = buildHarness({
      fetchClient: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('pipeline boom'),
      }),
    });
    const { sessionId } = await setupSession(h, 'pk-pipe-fail');
    const v1 = seedRootVersion(h, sessionId);

    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    const delivery = h.db
      .prepare(`SELECT * FROM interface_deliveries WHERE id = ?`)
      .get(deliveryId);
    expect(delivery.status).toBe('failed');
    expect(delivery.error_code).toBeTruthy();

    const session = h.app.locals.repository.getSession(sessionId);
    expect(session.confirmed_version_id).toBe(v1.id);
  });
});

// ================================================ 3. retry failed → pending → success

describe('delivery retry', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('3. retry flips failed→pending; worker reruns and delivers', async () => {
    // First harness fails the pipeline; then we swap to a succeeding client.
    h = buildHarness({
      fetchClient: vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') }),
    });
    const { sessionId } = await setupSession(h, 'pk-retry');
    const v1 = seedRootVersion(h, sessionId);

    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryId = c.body.delivery.id;
    await h.app.locals.deliveryWorker.tick();
    let delivery = h.db.prepare(`SELECT * FROM interface_deliveries WHERE id = ?`).get(deliveryId);
    expect(delivery.status).toBe('failed');

    // Retry via the API
    const retry = await request(h.app)
      .post(`/api/interface-sessions/${sessionId}/deliveries/${deliveryId}/retry`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('pending');

    // Fix the pipeline IN PLACE: the worker closed over the same fetchClient
    // object, so mutating the mock's default resolution flips subsequent calls.
    h.fetchClient.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });
    await h.app.locals.deliveryWorker.tick();

    delivery = h.db.prepare(`SELECT * FROM interface_deliveries WHERE id = ?`).get(deliveryId);
    expect(delivery.status).toBe('delivered');
  });
});

// ================================================ 4. delivered retry = no-op

describe('delivered retry is a no-op', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('4. retrying an already-delivered delivery does not re-run the worker or re-push pipeline', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-idem');
    const v1 = seedRootVersion(h, sessionId);

    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();
    expect(h.fetchClient).toHaveBeenCalledTimes(1);

    // Retry a delivered delivery → no-op
    const retry = await request(h.app)
      .post(`/api/interface-sessions/${sessionId}/deliveries/${deliveryId}/retry`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('delivered');

    // Worker tick should find nothing pending
    await h.app.locals.deliveryWorker.tick();

    // Pipeline still called exactly once
    expect(h.fetchClient).toHaveBeenCalledTimes(1);
  });
});

// ================================================ 5. superseded not processed

describe('superseded delivery is not processed', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('5. a superseded delivery stays superseded; the worker never delivers it', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-sup');
    const v1 = seedRootVersion(h, sessionId);
    const v2 = h.app.locals.repository.commitVersion({
      sessionId,
      parentVersionId: v1.id,
      artifactPath: `out/${sessionId}/v2/prototype.html`,
      contentHash: 'sha256:v2',
      byteSize: 100,
      title: 'V2',
      createdBy: 'seed',
    });

    const c1 = await confirmVersion(h, sessionId, v1.id);
    const firstDeliveryId = c1.body.delivery.id;

    // New confirm supersedes the first delivery (no worker tick in between)
    await confirmVersion(h, sessionId, v2.id, v1.id);

    // Now run the worker — it must claim only the new (pending) delivery
    await h.app.locals.deliveryWorker.tick();

    const oldDelivery = h.db
      .prepare(`SELECT * FROM interface_deliveries WHERE id = ?`)
      .get(firstDeliveryId);
    expect(oldDelivery.status).toBe('superseded');
  });
});

// ================================================ 6. restart recovery

describe('restart recovery resets delivering→pending', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('6. a crashed delivering delivery is reset to pending on recover() and then delivered', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-restart');
    const v1 = seedRootVersion(h, sessionId);

    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryId = c.body.delivery.id;

    // Simulate a crash mid-flight: worker claimed it (pending→delivering) then died
    setDeliveryStatus(h, deliveryId, 'delivering');

    // Restart recovery
    const resetCount = h.app.locals.deliveryWorker.recover();
    expect(resetCount).toBeGreaterThanOrEqual(1);

    const after = h.db.prepare(`SELECT * FROM interface_deliveries WHERE id = ?`).get(deliveryId);
    expect(after.status).toBe('pending');

    // Worker reprocesses
    await h.app.locals.deliveryWorker.tick();
    const done = h.db.prepare(`SELECT * FROM interface_deliveries WHERE id = ?`).get(deliveryId);
    expect(done.status).toBe('delivered');

    // Pipeline called exactly once despite the re-run (idempotent key)
    expect(h.fetchClient).toHaveBeenCalledTimes(1);
  });
});

// ================================================ M2: notified_at durability

describe('M2: notified_at closes crash-after-notify-before-delivered window', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('M2a. successful notify → notified_at set', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-m2a');
    const v1 = seedRootVersion(h, sessionId);
    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    const delivery = h.db.prepare(`SELECT * FROM interface_deliveries WHERE id = ?`).get(deliveryId);
    expect(delivery.status).toBe('delivered');
    expect(delivery.notified_at).toBeTruthy(); // M2: set after successful notify
    expect(h.fetchClient).toHaveBeenCalledTimes(1);
  });

  it('M2b. restart with notified_at set + not delivered → NOT re-notified, marked delivered', async () => {
    // Simulate: worker notified the pipeline (notified_at set) but crashed
    // before the delivered tx. On restart, the delivery must NOT re-notify.
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-m2b');
    const v1 = seedRootVersion(h, sessionId);
    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryId = c.body.delivery.id;

    // Claim it (delivering) + mark notified_at, but leave it NOT delivered.
    setDeliveryStatus(h, deliveryId, 'delivering');
    h.db
      .prepare(`UPDATE interface_deliveries SET notified_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), deliveryId);

    // Restart recovery resets delivering → pending (notified_at is preserved).
    h.app.locals.deliveryWorker.recover();
    const afterRecover = h.db.prepare(`SELECT * FROM interface_deliveries WHERE id = ?`).get(deliveryId);
    expect(afterRecover.status).toBe('pending');
    expect(afterRecover.notified_at).toBeTruthy();

    // Worker reprocesses: re-uploads (idempotent) but SKIPS re-notify, then delivered.
    await h.app.locals.deliveryWorker.tick();
    const done = h.db.prepare(`SELECT * FROM interface_deliveries WHERE id = ?`).get(deliveryId);
    expect(done.status).toBe('delivered');

    // Pipeline was NEVER called (notified_at was already set → skip).
    expect(h.fetchClient).toHaveBeenCalledTimes(0);
  });
});

// ================================================ 7. Fix 6: supersede guards

describe('superseded delivery produces NO external effects (Fix 6)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('F6a. supersede BEFORE file write → no file write, no pipeline push, no delivered event', async () => {
    // The fake readText supersedes the delivery mid-read, so by the time the
    // worker re-checks status before uploadText, it sees 'superseded' and aborts.
    let capturedDeliveryId = null;
    const fileClient = {
      readText: vi.fn().mockImplementation(async () => {
        // Simulate a supersede landing during the Blade OS read
        h.db.prepare('UPDATE interface_deliveries SET status = ?, updated_at = ? WHERE id = ?')
          .run('superseded', new Date().toISOString(), capturedDeliveryId);
        return VERSION_HTML;
      }),
      uploadText: vi.fn().mockResolvedValue(undefined),
    };
    const fetchClient = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });

    h = buildHarness({ fileClient, fetchClient });
    const { sessionId } = await setupSession(h, 'pk-sup-write');
    const v1 = seedRootVersion(h, sessionId);
    const v2 = h.app.locals.repository.commitVersion({
      sessionId, parentVersionId: v1.id,
      artifactPath: `out/${sessionId}/v2/prototype.html`,
      contentHash: 'sha256:v2', byteSize: 100, title: 'V2', createdBy: 'seed',
    });

    const c = await confirmVersion(h, sessionId, v1.id);
    capturedDeliveryId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    // Compat file NOT written
    expect(fileClient.uploadText).not.toHaveBeenCalled();

    // Pipeline NOT called
    expect(fetchClient).not.toHaveBeenCalled();

    // Delivery stayed superseded (no delivered event, no status flip)
    const delivery = h.db.prepare('SELECT * FROM interface_deliveries WHERE id = ?').get(capturedDeliveryId);
    expect(delivery.status).toBe('superseded');

    // No delivery_delivered event
    const events = h.db.prepare(
      `SELECT * FROM interface_session_events WHERE session_id = ? AND type = 'delivery_delivered'`,
    ).all(sessionId);
    expect(events).toHaveLength(0);
  });

  it('F6b. supersede BEFORE pipeline notify → file already written, but NO pipeline push', async () => {
    // The fake uploadText superseded the delivery mid-write, so the worker's
    // re-check before notifyPipeline sees 'superseded' and skips the push.
    let capturedDeliveryId = null;
    const fileClient = {
      readText: vi.fn().mockResolvedValue(VERSION_HTML),
      uploadText: vi.fn().mockImplementation(async () => {
        // Simulate a supersede landing during the file write
        h.db.prepare('UPDATE interface_deliveries SET status = ?, updated_at = ? WHERE id = ?')
          .run('superseded', new Date().toISOString(), capturedDeliveryId);
      }),
    };
    const fetchClient = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });

    h = buildHarness({ fileClient, fetchClient });
    const { sessionId } = await setupSession(h, 'pk-sup-notify');
    const v1 = seedRootVersion(h, sessionId);
    const v2 = h.app.locals.repository.commitVersion({
      sessionId, parentVersionId: v1.id,
      artifactPath: `out/${sessionId}/v2/prototype.html`,
      contentHash: 'sha256:v2', byteSize: 100, title: 'V2', createdBy: 'seed',
    });

    const c = await confirmVersion(h, sessionId, v1.id);
    capturedDeliveryId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    // File WAS written (the supersede landed during the write, not before it)
    expect(fileClient.uploadText).toHaveBeenCalledTimes(1);

    // But pipeline was NOT called
    expect(fetchClient).not.toHaveBeenCalled();

    // Delivery stayed superseded
    const delivery = h.db.prepare('SELECT * FROM interface_deliveries WHERE id = ?').get(capturedDeliveryId);
    expect(delivery.status).toBe('superseded');

    // No delivery_delivered event
    const events = h.db.prepare(
      `SELECT * FROM interface_session_events WHERE session_id = ? AND type = 'delivery_delivered'`,
    ).all(sessionId);
    expect(events).toHaveLength(0);
  });
});

// ================================================ 8. Sp1: confirmed_version_id gate

describe('Sp1: delivery gated on version_id === confirmed_version_id', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('Sp1a. mid-flight confirm moves confirmed_version_id to V2 while D_A is still delivering → worker aborts (no file write, no pipeline push)', async () => {
    // The semantic condition the version gate guards: the delivery for V1 is
    // still 'delivering' (claimed), but the session's confirmed_version_id has
    // moved to V2 (a newer confirm landed). The status-only check would let the
    // worker proceed (status IS 'delivering'); the version gate must abort it.
    let capturedSessionId = null;
    let v2Id = null;
    const fileClient = {
      readText: vi.fn().mockImplementation(async () => {
        // Simulate a confirm of V2 landing during the Blade OS read: move
        // confirmed_version_id to V2 WITHOUT touching D_A's status (it stays
        // 'delivering'). This is the exact condition the version gate catches.
        h.db.prepare(
          `UPDATE interface_design_sessions SET confirmed_version_id = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?`,
        ).run(v2Id, new Date().toISOString(), capturedSessionId);
        return VERSION_HTML;
      }),
      uploadText: vi.fn().mockResolvedValue(undefined),
    };
    const fetchClient = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });

    h = buildHarness({ fileClient, fetchClient });
    const { sessionId } = await setupSession(h, 'pk-sp1');
    capturedSessionId = sessionId;
    const v1 = seedRootVersion(h, sessionId);
    v2Id = v1.id; // placeholder; corrected below once v2 exists
    const v2 = h.app.locals.repository.commitVersion({
      sessionId, parentVersionId: v1.id,
      artifactPath: `out/${sessionId}/v2/prototype.html`,
      contentHash: 'sha256:v2', byteSize: 100, title: 'V2', createdBy: 'seed',
    });
    v2Id = v2.id;

    // Confirm V1 → creates delivery D_A (status pending); confirmed = V1.
    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryAId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    // Sp1 gate: the worker MUST abort because delivery.version_id (V1) no longer
    // equals the session's confirmed_version_id (V2). No external effects.
    expect(fileClient.uploadText).not.toHaveBeenCalled();
    expect(fetchClient).not.toHaveBeenCalled();

    // The delivery was not delivered (no delivered event).
    const delivery = h.db.prepare('SELECT * FROM interface_deliveries WHERE id = ?').get(deliveryAId);
    expect(delivery.status).not.toBe('delivered');
  });

  it('Sp1b. real confirm of V2 injected during readText supersedes D_A → no external effects (status + version gate agree)', async () => {
    // End-to-end: a real confirmVersion(V2) lands during the worker's readText.
    // confirmVersion atomically moves confirmed→V2 AND supersedes D_A. Both the
    // status check and the new version gate agree → abort cleanly.
    let capturedSessionId = null;
    let v1IdLocal = null;
    let v2IdLocal = null;
    const fileClient = {
      readText: vi.fn().mockImplementation(async () => {
        // Real confirm of V2 mid-read (expected = V1, the current confirmed).
        await confirmVersion(h, capturedSessionId, v2IdLocal, v1IdLocal);
        return VERSION_HTML;
      }),
      uploadText: vi.fn().mockResolvedValue(undefined),
    };
    const fetchClient = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });

    h = buildHarness({ fileClient, fetchClient });
    const { sessionId } = await setupSession(h, 'pk-sp1b');
    capturedSessionId = sessionId;
    const v1 = seedRootVersion(h, sessionId);
    v1IdLocal = v1.id;
    const v2 = h.app.locals.repository.commitVersion({
      sessionId, parentVersionId: v1.id,
      artifactPath: `out/${sessionId}/v2b/prototype.html`,
      contentHash: 'sha256:v2b', byteSize: 100, title: 'V2', createdBy: 'seed',
    });
    v2IdLocal = v2.id;

    const c = await confirmVersion(h, sessionId, v1.id);
    const deliveryAId = c.body.delivery.id;

    await h.app.locals.deliveryWorker.tick();

    // No external effects for the superseded V1 delivery.
    expect(fileClient.uploadText).not.toHaveBeenCalled();
    expect(fetchClient).not.toHaveBeenCalled();

    const delivery = h.db.prepare('SELECT * FROM interface_deliveries WHERE id = ?').get(deliveryAId);
    expect(delivery.status).toBe('superseded');
  });
});
