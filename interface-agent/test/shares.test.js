import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';

const SESSION_SECRET = 'test-secret-fixed-for-shares-hmac';
const VERSION_HTML = '<!doctype html><html><body><h1>Shared version</h1></body></html>';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-shares-'));
}

/**
 * Integration harness mirroring generations.test.js: temp SQLite + migrations,
 * createApp with injectable fileClient (serves VERSION_HTML for any readText).
 */
function buildHarness(overrides = {}) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'shares.db');
  const db = createDbClient({ dbPath });
  runMigrations(db);

  const deepseekClient = overrides.deepseekClient ?? {
    generateHtml: vi.fn().mockResolvedValue(VERSION_HTML),
  };
  const fileClient = overrides.fileClient ?? {
    uploadText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(VERSION_HTML),
  };

  const config = {
    publicBaseUrl: 'https://share.example',
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

async function setupSession(h, projectKey = 'pk-share') {
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

async function createShare(h, sessionId, versionId, body = {}) {
  return request(h.app)
    .post(`/api/interface-sessions/${sessionId}/shares`)
    .set('Cookie', cookieFor(h, sessionId))
    .send({ versionId, ...body });
}

// ============================================================ 1. create + pin

describe('share creation', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('1. returns an unguessable token + url; pinned to the version at creation', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-create');
    const v1 = seedRootVersion(h, sessionId);

    const r = await createShare(h, sessionId, v1.id);
    expect(r.status).toBe(200);
    expect(r.body.shareId).toBeTruthy();
    expect(r.body.token).toBeTruthy();
    // 256-bit random → base64url is ~43 chars
    expect(r.body.token.length).toBeGreaterThanOrEqual(32);
    expect(r.body.url).toContain(r.body.token);
    expect(r.body.url.startsWith('https://share.example/share/')).toBe(true);
    expect(r.body.expiresAt).toBeTruthy();
  });
});

// ================================================ 2. public metadata read-only

describe('public share metadata is read-only and pinned', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('2. GET /:token returns fixed version metadata without instruction/edit-token; unaffected by later confirm', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-meta');
    const v1 = seedRootVersion(h, sessionId, { title: 'Root draft' });

    const created = await createShare(h, sessionId, v1.id);
    const token = created.body.token;

    // Now confirm a DIFFERENT version (v2) — the share must still point at v1.
    const v2 = h.app.locals.repository.commitVersion({
      sessionId,
      parentVersionId: v1.id,
      artifactPath: `out/${sessionId}/v2/prototype.html`,
      contentHash: 'sha256:v2',
      byteSize: 100,
      title: 'Second',
      createdBy: 'seed',
    });
    await request(h.app)
      .post(`/api/interface-sessions/${sessionId}/confirmations`)
      .set('Cookie', cookieFor(h, sessionId))
      .send({ versionId: v2.id, expectedConfirmedVersionId: null })
      .expect(200);

    // Public metadata — NO cookie. Must reflect v1 (pinned), NOT the new confirm.
    const meta = await request(h.app).get(`/api/shares/${token}`);
    expect(meta.status).toBe(200);
    expect(meta.body.versionLabel).toBe(v1.version_label);
    expect(meta.body.title).toBe('Root draft');
    expect(meta.body.createdAt).toBeTruthy();
    expect(meta.body.expiresAt).toBeTruthy();

    // Read-only: no instruction, no edit token, no PAT, no session id
    const body = JSON.stringify(meta.body);
    expect(body).not.toContain('instruction');
    expect(body).not.toContain('editToken');
    expect(body).not.toContain(sessionId);
    expect(body).not.toContain(v2.version_label);
  });
});

// ====================================================== 3. public preview HTML

describe('public share preview', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('3. GET /:token/preview returns the pinned version HTML', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-preview');
    const v1 = seedRootVersion(h, sessionId);

    const created = await createShare(h, sessionId, v1.id);
    const token = created.body.token;

    const preview = await request(h.app).get(`/api/shares/${token}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toMatch(/text\/html/);
    expect(preview.text).toBe(VERSION_HTML);
    // fileClient read the pinned version's artifact path
    expect(h.fileClient.readText).toHaveBeenCalledWith(v1.artifact_path);

    // F2: CSP must be `sandbox allow-scripts` (SPACE — a semicolon ends the
    // sandbox directive). NO allow-same-origin.
    const csp = preview.headers['content-security-policy'] || '';
    expect(csp).toBe('sandbox allow-scripts');
    expect(csp).not.toMatch(/allow-same-origin/);
  });
});

// ====================================================== 4. revoke → 404

describe('share revocation', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('4. DELETE revokes; subsequent GET metadata + preview → 404; revoke is idempotent', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-revoke');
    const v1 = seedRootVersion(h, sessionId);

    const created = await createShare(h, sessionId, v1.id);
    const { shareId, token } = created.body;

    // Metadata works before revoke
    await request(h.app).get(`/api/shares/${token}`).expect(200);

    // Revoke (cookie + ownership)
    const del = await request(h.app)
      .delete(`/api/shares/${shareId}`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(del.status).toBe(200);

    // Idempotent: second revoke also 200
    const del2 = await request(h.app)
      .delete(`/api/shares/${shareId}`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(del2.status).toBe(200);

    // Now both public endpoints are gone
    await request(h.app).get(`/api/shares/${token}`).expect(404);
    await request(h.app).get(`/api/shares/${token}/preview`).expect(404);
  });
});

// ====================================================== 5. expiry → 404

describe('share expiry', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('5. an expired share → 404 on metadata + preview', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-expire');
    const v1 = seedRootVersion(h, sessionId);

    // Create with a 1ms expiry, then wait past it.
    const created = await createShare(h, sessionId, v1.id, { expiresInMs: 1 });
    const token = created.body.token;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await request(h.app).get(`/api/shares/${token}`).expect(404);
    await request(h.app).get(`/api/shares/${token}/preview`).expect(404);
  });
});

// ================================================ 6. cross-session DELETE → 403

describe('cross-session share delete rejected', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('6. DELETE with another session cookie → 403 (does not revoke)', async () => {
    h = buildHarness();
    const { sessionId: sidA } = await setupSession(h, 'pk-x-a');
    const { sessionId: sidB } = await setupSession(h, 'pk-x-b');
    const vA = seedRootVersion(h, sidA);

    const created = await createShare(h, sidA, vA.id);
    const { shareId, token } = created.body;

    // sidB tries to revoke sidA's share
    const del = await request(h.app)
      .delete(`/api/shares/${shareId}`)
      .set('Cookie', cookieFor(h, sidB));
    expect(del.status).toBe(403);

    // Still accessible (not revoked)
    await request(h.app).get(`/api/shares/${token}`).expect(200);
  });
});

// ================================================ 7. token never in events/log

describe('share token sanitization', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('7. share_created event payload never contains the plaintext token', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-sani');
    const v1 = seedRootVersion(h, sessionId);

    const created = await createShare(h, sessionId, v1.id);
    const token = created.body.token;

    const eventsRes = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/events`)
      .set('Cookie', cookieFor(h, sessionId));
    expect(eventsRes.status).toBe(200);

    const body = JSON.stringify(eventsRes.body);
    // The plaintext token must never appear in any event payload
    expect(body).not.toContain(token);
    // A share_created event exists
    const shareEvent = eventsRes.body.events.find((e) => e.type === 'share_created');
    expect(shareEvent).toBeTruthy();
  });
});
