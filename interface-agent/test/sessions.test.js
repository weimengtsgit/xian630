import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';
import { createRepository } from '../src/lib/db/repository.js';

const SESSION_SECRET = 'test-secret-fixed-for-sessions-hmac';

function nowIso() {
  return new Date().toISOString();
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-sessions-'));
}

/**
 * Integration harness: temp SQLite DB with all migrations, createApp wired
 * with a mock fileClient (uploadText resolves), and supertest-ready app.
 * Mirrors auth.test.js's buildHarness so the full middleware stack
 * (helmet, json, auth router, session router) is exercised.
 */
function buildHarness(overrides = {}) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'sessions.db');
  const db = createDbClient({ dbPath });
  runMigrations(db);
  const repo = createRepository(db);
  // Sp4: default fileClient echoes uploads (Map-backed) so the legacy-import
  // post-write hash verification passes on the success path. Tests that need a
  // mismatched read-back override fileClient.
  const fileStore = new Map();
  const fileClient = {
    uploadText: vi.fn().mockImplementation(async (p, content) => { fileStore.set(p, content); }),
    readText: vi.fn().mockImplementation(async (p) => fileStore.get(p) ?? ''),
  };
  const config = {
    publicBaseUrl: '',
    rateLimitWindowMs: 60000,
    rateLimitMax: 20,
    pendingPollIntervalMs: 3000,
    pendingInputPath: '',
    confirmedOutputPath: 'test-output/prototype.html',
    pipelineStageCompleteUrl: '',
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    startCodeTtlMs: 90000,
    internalToken: 'test-internal-secret',
    ...overrides.config,
  };
  const app = createApp({
    config,
    deepseekClient: null,
    fileClient: overrides.fileClient ?? fileClient,
    fetchClient: vi.fn(),
    db,
  });
  return { dir, db, repo, app, fileClient, config };
}

function cleanup(h) {
  try {
    h.db.close();
  } catch { /* already closed */ }
  rmSync(h.dir, { recursive: true, force: true });
}

/** Forge a signed session cookie for the given session id. */
function cookieFor(h, sessionId) {
  const signed = h.app.locals.sessionAuth.sign(sessionId);
  return `${h.app.locals.sessionAuth.cookieName}=${signed}`;
}

/** Seed a version (root V1) directly via the repository. */
function seedVersion(repo, sessionId, { title = 'seed', artifactPath = 'p/prototype.html' } = {}) {
  return repo.commitVersion({
    sessionId,
    parentVersionId: null,
    artifactPath,
    contentHash: crypto.createHash('sha256').update(artifactPath).digest('hex'),
    byteSize: 100,
    title,
    createdBy: 'seed',
  });
}

/**
 * Resolve-create a session (no active session yet). Fix 4: resolve CREATE
 * requires X-Internal-Token; this helper always sends it so existing tests
 * that only care about subsequent behavior stay focused.
 */
function resolveCreate(h, body) {
  return request(h.app)
    .post('/api/interface-sessions/resolve')
    .set('X-Internal-Token', h.config.internalToken || 'test-internal-secret')
    .send(body);
}

// =================================================================== resolve

describe('POST /api/interface-sessions/resolve', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('1. no active session → 201 + editToken + startCode; re-resolve with correct token → 200 (no token); wrong token → 401', async () => {
    h = buildHarness();

    // First resolve: no active session → creates one
    const r1 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-alpha' });

    expect(r1.status).toBe(201);
    expect(r1.body.sessionId).toBeTruthy();
    expect(r1.body.editToken).toBeTruthy();
    expect(r1.body.editToken.startsWith('iaet_')).toBe(true);
    expect(r1.body.startCode).toBeTruthy();
    expect(r1.body.expiresAt).toBeTruthy();

    const { sessionId, editToken } = r1.body;

    // Re-resolve with correct token → 200, editToken NOT echoed
    const r2 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-alpha', editToken });

    expect(r2.status).toBe(200);
    expect(r2.body.sessionId).toBe(sessionId);
    expect(r2.body.startCode).toBeTruthy();
    expect(r2.body.editToken).toBeUndefined();

    // Wrong token → 401
    const r3 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-alpha', editToken: 'iaet_wrong' });

    expect(r3.status).toBe(401);
  });

  it('2. active session but no editToken → 401; missing projectKey → 400', async () => {
    h = buildHarness();

    // Create active session first
    const r0 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-beta' });
    expect(r0.status).toBe(201);

    // Active session + no editToken → 401
    const r1 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-beta' });
    expect(r1.status).toBe(401);

    // Missing projectKey → 400
    const r2 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ editToken: 'iaet_whatever' });
    expect(r2.status).toBe(400);

    // Empty body → 400
    const r3 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({});
    expect(r3.status).toBe(400);
  });

  it('F1. rejects path-traversal / invalid projectKey → 400; accepts valid', async () => {
    h = buildHarness();
    const bad = ['../../etc', 'a/b', 'a b', 'a.b', 'A-B', 'x'.repeat(33), 'a\\b'];
    for (const key of bad) {
      const r = await request(h.app)
        .post('/api/interface-sessions/resolve')
        .set('X-Internal-Token', 'test-internal-secret')
        .send({ projectKey: key });
      expect(r.status).toBe(400);
    }
    // Valid key still creates a session
    const ok = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'valid-key-1' });
    expect(ok.status).toBe(201);
    expect(ok.body.sessionId).toBeTruthy();
  });
});

// ================================================================== restart

describe('session restart + uniqueness', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('3. at most one active per projectKey; restart archives old + creates new active', async () => {
    h = buildHarness();

    const r1 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-gamma' });
    expect(r1.status).toBe(201);
    const oldId = r1.body.sessionId;

    // DB: exactly one active session for pk-gamma
    const active1 = h.repo.getActiveSessionByProjectKey('pk-gamma');
    expect(active1.id).toBe(oldId);

    // Restart with cookie for oldId
    const r2 = await request(h.app)
      .post(`/api/interface-sessions/${oldId}/restart`)
      .set('Cookie', cookieFor(h, oldId));
    expect(r2.status).toBe(200);
    expect(r2.body.sessionId).toBeTruthy();
    expect(r2.body.sessionId).not.toBe(oldId);
    // Fix 2: restart is browser-callable — editToken must NOT appear; the
    // startCode is what the browser re-exchanges for a cookie on the new session
    expect(r2.body.editToken).toBeUndefined();
    expect(r2.body.startCode).toBeTruthy();

    // Old session archived, new is active, still only one active
    const oldSession = h.repo.getSession(oldId);
    expect(oldSession.status).toBe('archived');
    expect(oldSession.archived_at).toBeTruthy();

    const active2 = h.repo.getActiveSessionByProjectKey('pk-gamma');
    expect(active2.id).toBe(r2.body.sessionId);
    expect(active2.status).toBe('active');
  });

  it('4. restart requires cookie ownership: no cookie → 401, other session → 403', async () => {
    h = buildHarness();

    // Create two sessions for different projects
    const r1 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-delta' });
    const r2 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-epsilon' });
    const sDelta = r1.body.sessionId;
    const sEpsilon = r2.body.sessionId;

    // No cookie → 401
    const noCookie = await request(h.app)
      .post(`/api/interface-sessions/${sDelta}/restart`);
    expect(noCookie.status).toBe(401);

    // Cookie for sDelta but URL targets sEpsilon → 403
    const wrongSession = await request(h.app)
      .post(`/api/interface-sessions/${sEpsilon}/restart`)
      .set('Cookie', cookieFor(h, sDelta));
    expect(wrongSession.status).toBe(403);
  });
});

// ============================================================== GET /:id

describe('GET /api/interface-sessions/:id', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('5. returns correct summary (versionCount, mainlineHead, confirmedVersion, deliveries)', async () => {
    h = buildHarness();

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-zeta' });
    const sid = r.body.sessionId;

    // Seed a root V1
    const v1 = seedVersion(h.repo, sid, { title: '初始版本' });

    const r2 = await request(h.app)
      .get(`/api/interface-sessions/${sid}`)
      .set('Cookie', cookieFor(h, sid));

    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(sid);
    expect(r2.body.projectKey).toBe('pk-zeta');
    expect(r2.body.status).toBe('active');
    expect(r2.body.versionCount).toBe(1);
    expect(r2.body.mainlineHead).toEqual({
      versionId: v1.id,
      versionLabel: 'V1',
      title: '初始版本',
    });
    expect(r2.body.confirmedVersion).toBeNull();
    expect(r2.body.deliveries).toEqual({
      pending: 0, delivering: 0, delivered: 0, failed: 0, superseded: 0,
    });
  });
});

// ========================================================= legacy-import

describe('legacy-import', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('6a. success: no versions + global not migrated + non-default html → V1 (parent=null, mainline_head, hash, global flag)', async () => {
    h = buildHarness();

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-eta' });
    const sid = r.body.sessionId;

    const importRes = await request(h.app)
      .post(`/api/interface-sessions/${sid}/legacy-import`)
      .set('Cookie', cookieFor(h, sid))
      .send({ html: '<html><body><h1>用户的历史界面稿</h1></body></html>', title: '旧稿' });

    expect(importRes.status).toBe(200);
    const v = importRes.body.version;
    expect(v.versionLabel).toBe('V1');
    expect(v.parentVersionId).toBeNull();
    expect(v.title).toBe('旧稿');
    expect(v.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.byteSize).toBeGreaterThan(0);
    expect(v.createdBy).toBe('legacy_local');

    // mainline_head points to V1
    const session = h.repo.getSession(sid);
    expect(session.mainline_head_version_id).toBe(v.versionId);

    // Global flag set
    expect(h.repo.getSetting('legacy_migration_done')).toBe('true');

    // Artifact was uploaded
    expect(h.fileClient.uploadText).toHaveBeenCalledTimes(1);
    const [uploadedPath] = h.fileClient.uploadText.mock.calls[0];
    expect(uploadedPath).toContain(sid);
    expect(uploadedPath).toContain('prototype.html');
    expect(uploadedPath).toContain(v.versionId);
  });

  it('6b. global-once: after one import, another session legacy-import → 409', async () => {
    h = buildHarness();

    // First session imports successfully
    const r1 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-theta' });
    const sid1 = r1.body.sessionId;

    const imp1 = await request(h.app)
      .post(`/api/interface-sessions/${sid1}/legacy-import`)
      .set('Cookie', cookieFor(h, sid1))
      .send({ html: '<html><body>historical draft theta</body></html>' });
    expect(imp1.status).toBe(200);

    // Second session for a different project → 409 (global done)
    const r2 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-iota' });
    const sid2 = r2.body.sessionId;

    const imp2 = await request(h.app)
      .post(`/api/interface-sessions/${sid2}/legacy-import`)
      .set('Cookie', cookieFor(h, sid2))
      .send({ html: '<html><body>historical draft iota</body></html>' });
    expect(imp2.status).toBe(409);

    // In-tx guard (Fix 1): the losing path must create NO version in sid2,
    // and the global flag stays set. The orphaned upload (before the tx) is
    // left for T8's sweep — we only assert the DB-side guarantee here.
    expect(h.repo.countVersions(sid2)).toBe(0);
    expect(h.repo.getSetting('legacy_migration_done')).toBe('true');
    expect(h.repo.getActiveSessionByProjectKey('pk-iota').id).toBe(sid2);
  });

  it('6c. empty html → 400; default template → 400', async () => {
    h = buildHarness();

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-kappa' });
    const sid = r.body.sessionId;

    // Empty html → 400
    const r1 = await request(h.app)
      .post(`/api/interface-sessions/${sid}/legacy-import`)
      .set('Cookie', cookieFor(h, sid))
      .send({ html: '   ' });
    expect(r1.status).toBe(400);

    // Missing html → 400
    const r2 = await request(h.app)
      .post(`/api/interface-sessions/${sid}/legacy-import`)
      .set('Cookie', cookieFor(h, sid))
      .send({});
    expect(r2.status).toBe(400);

    // Default template → 400
    const r3 = await request(h.app)
      .post(`/api/interface-sessions/${sid}/legacy-import`)
      .set('Cookie', cookieFor(h, sid))
      .send({ html: '<html><head><style>--bg-base: #0a0e14;</style></head><body>UNCLASSIFIED // NOTIONAL PROTOTYPE</body></html>' });
    expect(r3.status).toBe(400);
  });

  it('6d. session with versions → 409', async () => {
    h = buildHarness();

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-lambda' });
    const sid = r.body.sessionId;

    // Seed a version first
    seedVersion(h.repo, sid);

    const imp = await request(h.app)
      .post(`/api/interface-sessions/${sid}/legacy-import`)
      .set('Cookie', cookieFor(h, sid))
      .send({ html: '<html><body>some old draft</body></html>' });
    expect(imp.status).toBe(409);
  });

  it('Sp4. read-back hash mismatch → no V1, global flag stays false (retryable)', async () => {
    // The upload succeeds but the read-back differs from what was uploaded
    // (silent storage corruption). Mirroring the generations worker (Fix 7),
    // the legacy import must create NO version and must NOT set the global
    // migration-done flag (so the user can retry).
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue('CORRUPTED - NOT THE UPLOADED HTML'),
      },
    });

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-sp4' });
    const sid = r.body.sessionId;

    const importRes = await request(h.app)
      .post(`/api/interface-sessions/${sid}/legacy-import`)
      .set('Cookie', cookieFor(h, sid))
      .send({ html: '<html><body><h1>historical draft</h1></body></html>', title: '旧稿' });

    // Integrity failure → error response (no V1).
    expect(importRes.status).toBeGreaterThanOrEqual(400);
    expect(importRes.status).toBeLessThan(600);

    // No version was committed.
    expect(h.repo.countVersions(sid)).toBe(0);

    // Global migration flag NOT set → the user can retry.
    expect(h.repo.getSetting('legacy_migration_done')).toBe('false');

    // mainline_head unchanged (null).
    const session = h.repo.getSession(sid);
    expect(session.mainline_head_version_id).toBeNull();
  });
});

// ========================================================= ownership

describe('ownership guard', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('7. other session calls restart / legacy-import → 403', async () => {
    h = buildHarness();

    const r1 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-mu' });
    const r2 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-nu' });
    const sMu = r1.body.sessionId;
    const sNu = r2.body.sessionId;

    // Cookie for sMu, URL targets sNu → 403 on restart
    const restartRes = await request(h.app)
      .post(`/api/interface-sessions/${sNu}/restart`)
      .set('Cookie', cookieFor(h, sMu));
    expect(restartRes.status).toBe(403);

    // Cookie for sMu, URL targets sNu → 403 on legacy-import
    const importRes = await request(h.app)
      .post(`/api/interface-sessions/${sNu}/legacy-import`)
      .set('Cookie', cookieFor(h, sMu))
      .send({ html: '<html><body>test</body></html>' });
    expect(importRes.status).toBe(403);

    // Cookie for sMu, URL targets sNu → 403 on GET
    const getRes = await request(h.app)
      .get(`/api/interface-sessions/${sNu}`)
      .set('Cookie', cookieFor(h, sMu));
    expect(getRes.status).toBe(403);

    // legacy-import/status
    const statusRes = await request(h.app)
      .get(`/api/interface-sessions/${sNu}/legacy-import/status`)
      .set('Cookie', cookieFor(h, sMu));
    expect(statusRes.status).toBe(403);
  });
});

// ========================================================= Fix 4: internal token

describe('resolve CREATE requires X-Internal-Token (Fix 4)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('F4a. resolve-create without internal token → 401', async () => {
    h = buildHarness();

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .send({ projectKey: 'pk-notok' });

    expect(r.status).toBe(401);
    // No session was created
    expect(h.repo.getActiveSessionByProjectKey('pk-notok')).toBeUndefined();
  });

  it('F4b. resolve-create with wrong internal token → 401', async () => {
    h = buildHarness();

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'wrong-secret')
      .send({ projectKey: 'pk-wrong' });

    expect(r.status).toBe(401);
    expect(h.repo.getActiveSessionByProjectKey('pk-wrong')).toBeUndefined();
  });

  it('F4c. resolve-create with correct internal token → 201', async () => {
    h = buildHarness();

    const r = await resolveCreate(h, { projectKey: 'pk-ok' });

    expect(r.status).toBe(201);
    expect(r.body.sessionId).toBeTruthy();
    expect(r.body.editToken).toBeTruthy();
  });

  it('F4d. resolve-verify is NOT gated by internal token (editToken-gated only)', async () => {
    h = buildHarness();

    // Create with correct internal token
    const r1 = await resolveCreate(h, { projectKey: 'pk-verify' });
    const { sessionId, editToken } = r1.body;

    // Verify WITHOUT internal token but WITH correct editToken → 200
    const r2 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .send({ projectKey: 'pk-verify', editToken });

    expect(r2.status).toBe(200);
    expect(r2.body.sessionId).toBe(sessionId);
  });

  it('F4e. fail-closed: unset internalToken → resolve-create refused even with header', async () => {
    h = buildHarness({ config: { internalToken: '' } });

    const r = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .set('X-Internal-Token', 'test-internal-secret')
      .send({ projectKey: 'pk-failclosed' });

    expect(r.status).toBe(401);
    expect(h.repo.getActiveSessionByProjectKey('pk-failclosed')).toBeUndefined();
  });
});

// ========================================================= Fix 3: restart token

describe('restart preserves edit_token_hash (Fix 3)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('F3a. restart reuses the old edit_token_hash; resolve with original token succeeds (not 401)', async () => {
    h = buildHarness();

    // Create a session (get the plaintext editToken)
    const r1 = await resolveCreate(h, { projectKey: 'pk-restart-token' });
    const { sessionId: oldId, editToken } = r1.body;
    expect(editToken).toBeTruthy();

    const oldSession = h.repo.getSession(oldId);
    const oldHash = oldSession.edit_token_hash;

    // Restart via cookie
    const r2 = await request(h.app)
      .post(`/api/interface-sessions/${oldId}/restart`)
      .set('Cookie', cookieFor(h, oldId));
    expect(r2.status).toBe(200);
    const newId = r2.body.sessionId;

    // The new session's edit_token_hash must EQUAL the old session's
    const newSession = h.repo.getSession(newId);
    expect(newSession.edit_token_hash).toBe(oldHash);

    // agent-pipeline's stored plaintext token still works against the new session:
    // resolve-verify with the ORIGINAL editToken → 200 (not 401)
    const r3 = await request(h.app)
      .post('/api/interface-sessions/resolve')
      .send({ projectKey: 'pk-restart-token', editToken });
    expect(r3.status).toBe(200);
    expect(r3.body.sessionId).toBe(newId);
    expect(r3.body.startCode).toBeTruthy();
  });
});

// ========================================================= Sp6: independent session

describe('POST /api/interface-sessions/independent (standalone browser entry)', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('Sp6a. creates a session, sets the edit cookie DIRECTLY (no start-code), returns sessionId', async () => {
    h = buildHarness();
    const r = await request(h.app).post('/api/interface-sessions/independent');
    expect(r.status).toBe(201);
    expect(r.body.sessionId).toBeTruthy();

    // The edit cookie is set directly (no start-code dance). The cookie is the
    // credential for standalone sessions.
    const setCookie = r.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookie).toMatch(/ia_session=/);

    // Subsequent GET /api/auth/session restores the session via the cookie.
    const sess = await request(h.app)
      .get('/api/auth/session')
      .set('Cookie', cookie.split(';')[0]);
    expect(sess.status).toBe(200);
    expect(sess.body.sessionId).toBe(r.body.sessionId);
    expect(sess.body.projectKey).toMatch(/^independent-/);

    // No internal-token was required (standalone browser flow).
    // No startCode in the response.
    expect(r.body.startCode).toBeUndefined();
  });

  it('Sp6b. rate-limited: rapid posts from one IP → 429', async () => {
    h = buildHarness({ config: { rateLimitWindowMs: 60000, rateLimitMax: 2 } });
    const r1 = await request(h.app).post('/api/interface-sessions/independent');
    const r2 = await request(h.app).post('/api/interface-sessions/independent');
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // 3rd rapid request from the same IP → 429
    const r3 = await request(h.app).post('/api/interface-sessions/independent');
    expect(r3.status).toBe(429);
  });
});
