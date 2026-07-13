import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';

const SESSION_SECRET = 'test-secret-fixed-for-confirm-hmac';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-confirm-'));
}

function buildHarness(overrides = {}) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'confirm.db');
  const db = createDbClient({ dbPath });
  runMigrations(db);

  const deepseekClient = { generateHtml: vi.fn().mockResolvedValue('<html></html>') };
  const fileClient = overrides.fileClient ?? {
    uploadText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue('<html></html>'),
  };

  const config = {
    publicBaseUrl: '',
    rateLimitWindowMs: 60000,
    rateLimitMax: 20,
    confirmedOutputPath: '共享/prototype.html',
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    startCodeTtlMs: 90000,
    internalToken: 'test-internal-secret',
    generationPollIntervalMs: 1000,
    shareDefaultExpiresMs: 7 * 24 * 60 * 60 * 1000,
    ...overrides.config,
  };

  const app = createApp({
    config,
    deepseekClient,
    fileClient,
    fetchClient: vi.fn(),
    db,
  });

  return { dir, db, app, fileClient, config };
}

function cleanup(h) {
  try {
    h.db.close();
  } catch {
    /* already closed */
  }
  rmSync(h.dir, { recursive: true, force: true });
}

async function setupSession(h, projectKey = 'pk-confirm') {
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

function confirm(h, sessionId, body) {
  return request(h.app)
    .post(`/api/interface-sessions/${sessionId}/confirmations`)
    .set('Cookie', cookieFor(h, sessionId))
    .send(body);
}

function deliveriesForSession(h, sessionId) {
  return h.db
    .prepare(`SELECT * FROM interface_deliveries WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId);
}

// ============================================================ 1. success path

describe('confirm success', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('1. updates confirmed_version_id + row_version+1 + event + creates a pending delivery', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-ok');
    const v1 = seedRootVersion(h, sessionId);
    const repo = h.app.locals.repository;

    const sessionBefore = repo.getSession(sessionId);
    expect(sessionBefore.confirmed_version_id).toBeNull();
    expect(sessionBefore.row_version).toBe(0);

    const r = await confirm(h, sessionId, {
      versionId: v1.id,
      expectedConfirmedVersionId: null,
    });
    expect(r.status).toBe(200);
    expect(r.body.confirmedVersionId).toBe(v1.id);
    expect(r.body.rowVersion).toBe(1);
    expect(r.body.delivery).toBeTruthy();
    expect(r.body.delivery.id).toBeTruthy();
    expect(r.body.delivery.status).toBe('pending');

    // DB state
    const sessionAfter = repo.getSession(sessionId);
    expect(sessionAfter.confirmed_version_id).toBe(v1.id);
    expect(sessionAfter.row_version).toBe(1);

    // Delivery row
    const deliveries = deliveriesForSession(h, sessionId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('pending');
    expect(deliveries[0].version_id).toBe(v1.id);
    expect(deliveries[0].idempotency_key).toBeTruthy();

    // Confirm event emitted
    const events = repo.listEvents(sessionId);
    const confirmEvent = events.find((e) => e.type === 'confirm');
    expect(confirmEvent).toBeTruthy();
  });
});

// ============================================================ 2. 409 conflict

describe('confirm optimistic concurrency (409)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('2. expectedConfirmedVersionId mismatch → 409, does NOT overwrite', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-conflict');
    const v1 = seedRootVersion(h, sessionId);
    const v2 = repoCommit(h, sessionId, v1.id);

    // First confirm v1 (expected null) → succeeds, confirmed becomes v1
    await confirm(h, sessionId, { versionId: v1.id, expectedConfirmedVersionId: null }).expect(200);

    // Now a stale caller tries to confirm v2 with a STALE expected (null again),
    // expecting "no confirmation yet". Server has confirmed=v1 → must 409.
    const r = await confirm(h, sessionId, {
      versionId: v2.id,
      expectedConfirmedVersionId: null,
    });
    expect(r.status).toBe(409);
    expect(r.body.currentConfirmedVersionId).toBe(v1.id);
    expect(r.body.rowVersion).toBe(1);

    // Confirmed version NOT overwritten — still v1
    const session = h.app.locals.repository.getSession(sessionId);
    expect(session.confirmed_version_id).toBe(v1.id);

    // A correct expected (v1) confirming v2 succeeds
    const r2 = await confirm(h, sessionId, {
      versionId: v2.id,
      expectedConfirmedVersionId: v1.id,
    });
    expect(r2.status).toBe(200);
    expect(r2.body.confirmedVersionId).toBe(v2.id);
    expect(r2.body.rowVersion).toBe(2);
  });
});

// ================================================ 3. new confirm supersedes old

describe('confirm supersedes old unfinished deliveries', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('3. a new confirm marks the prior pending delivery superseded; worker will not process it', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-supersede');
    const v1 = seedRootVersion(h, sessionId);
    const v2 = repoCommit(h, sessionId, v1.id);

    const c1 = await confirm(h, sessionId, { versionId: v1.id, expectedConfirmedVersionId: null }).expect(200);
    const firstDeliveryId = c1.body.delivery.id;

    // The pending delivery exists
    let deliveries = deliveriesForSession(h, sessionId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('pending');

    const c2 = await confirm(h, sessionId, { versionId: v2.id, expectedConfirmedVersionId: v1.id }).expect(200);
    const secondDeliveryId = c2.body.delivery.id;

    // Old delivery → superseded, new one → pending
    deliveries = deliveriesForSession(h, sessionId);
    expect(deliveries).toHaveLength(2);
    const oldD = deliveries.find((d) => d.id === firstDeliveryId);
    const newD = deliveries.find((d) => d.id === secondDeliveryId);
    expect(oldD.status).toBe('superseded');
    expect(oldD.superseded_by_delivery_id).toBe(secondDeliveryId);
    expect(newD.status).toBe('pending');

    // Worker only claims pending — the superseded one is never processed.
    // Run the worker tick; it should claim the new delivery only.
    await h.app.locals.deliveryWorker.tick();
    const refreshed = deliveriesForSession(h, sessionId);
    const oldAfter = refreshed.find((d) => d.id === firstDeliveryId);
    const newAfter = refreshed.find((d) => d.id === secondDeliveryId);
    expect(oldAfter.status).toBe('superseded'); // untouched by worker
    expect(['delivered', 'delivering', 'pending']).toContain(newAfter.status);
  });
});

// ================================================ 4. cross-session versionId → 403

describe('confirm cross-session version rejected', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('4. confirming with another session versionId → 403', async () => {
    h = buildHarness();
    const { sessionId: sidA } = await setupSession(h, 'pk-cs-a');
    const { sessionId: sidB } = await setupSession(h, 'pk-cs-b');
    const vB = seedRootVersion(h, sidB);

    const r = await confirm(h, sidA, {
      versionId: vB.id,
      expectedConfirmedVersionId: null,
    });
    expect(r.status).toBe(403);
  });
});

// ================================================ 5. archived version rejected

describe('confirm archived version rejected', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('5. archived version -> 409 without changing confirmation or creating delivery', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-archived-confirm');
    const v1 = seedRootVersion(h, sessionId, { title: 'archived root' });
    h.app.locals.repository.setVersionArchived(v1.id, true);

    const response = await confirm(h, sessionId, {
      versionId: v1.id,
      expectedConfirmedVersionId: null,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('归档');
    expect(h.app.locals.repository.getSession(sessionId).confirmed_version_id).toBeNull();
    expect(deliveriesForSession(h, sessionId)).toHaveLength(0);
  });
});

// ----------------------------------------------- helpers

function repoCommit(h, sessionId, parentVersionId) {
  return h.app.locals.repository.commitVersion({
    sessionId,
    parentVersionId,
    artifactPath: `out/${sessionId}/${crypto.randomUUID()}/prototype.html`,
    contentHash: 'sha256:' + crypto.randomUUID(),
    byteSize: 100,
    title: 'child',
    createdBy: 'seed',
  });
}
