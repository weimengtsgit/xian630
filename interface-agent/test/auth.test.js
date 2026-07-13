import crypto from 'node:crypto';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';
import { createRepository } from '../src/lib/db/repository.js';
import { generateEditToken, hashEditToken, verifyEditToken } from '../src/lib/auth/editToken.js';
import {
  consumeStartCode,
  generateStartCode,
  hashStartCode,
  issueStartCode,
} from '../src/lib/auth/startCode.js';
import { createSessionAuth } from '../src/lib/auth/cookieSession.js';

const SESSION_SECRET = 'test-secret-fixed-for-hmac-verification';

function nowIso() {
  return new Date().toISOString();
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-auth-'));
}

function tableNames(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/**
 * Inserts an active session and optionally stores the hash of a known edit
 * token. The resolve endpoint (T4) will mint edit tokens in production; for
 * the auth primitives we seed the hash directly so the start-code endpoint
 * can verify it.
 */
function seedSession(repo, db, { id, projectKey, editToken = null }) {
  repo.createSession({ id, projectKey, createdAt: nowIso() });
  if (editToken) {
    db.prepare(
      `UPDATE interface_design_sessions SET edit_token_hash = ?, edit_token_set_at = ? WHERE id = ?`,
    ).run(hashEditToken(editToken), nowIso(), id);
  }
  return repo.getSession(id);
}

function buildHarness(overrides = {}) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'auth.db');
  const db = createDbClient({ dbPath });
  runMigrations(db);
  const repo = createRepository(db);
  const config = {
    publicBaseUrl: '',
    rateLimitWindowMs: 60000,
    rateLimitMax: 20,
    pendingPollIntervalMs: 3000,
    pendingInputPath: '',
    confirmedOutputPath: '',
    pipelineStageCompleteUrl: '',
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    startCodeTtlMs: 90000,
    ...overrides,
  };
  const app = createApp({ config, deepseekClient: null, fileClient: null, fetchClient: vi.fn(), db });
  return { dir, db, repo, app, sessionAuth: app.locals.sessionAuth };
}

/**
 * Minimal express app exposing the session middleware on toy routes so we can
 * assert req.session and the ownership guard without mounting test-only routes
 * on the real app (the real version routes arrive in T4-T7).
 */
function buildMiddlewareApp(sessionAuth) {
  const app = express();
  app.get('/me', sessionAuth.requireSession, (req, res) =>
    res.json({ sessionId: req.session.id, projectKey: req.session.projectKey }),
  );
  app.get(
    '/own/:versionId',
    sessionAuth.requireSession,
    sessionAuth.requireSessionOwnsVersion(),
    (req, res) => res.json({ ok: true, versionId: req.params.versionId }),
  );
  return app;
}

describe('auth primitives — edit token (scrypt)', () => {
  it('1. generate has prefix + length; hash hides plaintext; verify accepts/rejects', () => {
    const token = generateEditToken();
    expect(token.startsWith('iaet_')).toBe(true);
    // 48 bytes base64url ~= 64 chars + prefix
    expect(token.length).toBeGreaterThan(60);

    const stored = hashEditToken(token);
    // self-describing scrypt envelope
    expect(stored.startsWith('scrypt$')).toBe(true);
    // the plaintext token must NEVER be recoverable from the stored hash
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(token.slice(5));

    // correct token verifies
    expect(verifyEditToken(token, stored)).toBe(true);
    // a fresh token does not
    expect(verifyEditToken(generateEditToken(), stored)).toBe(false);
    // malformed envelope / empty inputs are rejected, not thrown
    expect(verifyEditToken(token, '')).toBe(false);
    expect(verifyEditToken(token, 'not-a-hash')).toBe(false);
    expect(verifyEditToken('', stored)).toBe(false);

    // same plaintext -> different stored hashes (random salt per hash)
    expect(hashEditToken(token)).not.toBe(stored);
  });
});

describe('auth primitives — one-time start code', () => {
  let h;
  beforeEach(() => {
    h = buildHarness();
    seedSession(h.repo, h.db, { id: 's-code', projectKey: 'pk-code' });
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('2. issueStartCode returns plaintext once; DB stores only the hash', () => {
    const { startCode, expiresAt } = issueStartCode(h.repo, 's-code');
    expect(typeof startCode).toBe('string');
    expect(startCode.length).toBeGreaterThan(10);
    expect(expiresAt).toBeTruthy();

    const rows = h.db
      .prepare(`SELECT code_hash, used_at FROM interface_start_codes WHERE session_id = ?`)
      .all('s-code');
    expect(rows.length).toBe(1);
    // the plaintext start code must not appear anywhere in stored data
    expect(rows[0].code_hash).not.toContain(startCode);
    // sha256 hex of the code is what's stored
    expect(rows[0].code_hash).toBe(hashStartCode(startCode));
    expect(rows[0].used_at).toBeNull();
  });

  it('3. consumeStartCode: success, one-time, expired, wrong', () => {
    // success
    const { startCode } = issueStartCode(h.repo, 's-code');
    const res = consumeStartCode(h.repo, startCode);
    expect(res).toEqual({ sessionId: 's-code' });

    // one-time: a second consume of the same code fails
    expect(consumeStartCode(h.repo, startCode)).toBeNull();

    // expired code fails (negative ttl => expires_at in the past)
    const { startCode: expired } = issueStartCode(h.repo, 's-code', { ttlMs: -1000 });
    expect(consumeStartCode(h.repo, expired)).toBeNull();

    // wrong code fails
    expect(consumeStartCode(h.repo, generateStartCode())).toBeNull();
  });
});

describe('auth primitives — cookie session', () => {
  let h;
  beforeEach(() => {
    h = buildHarness();
    seedSession(h.repo, h.db, { id: 's-cookie', projectKey: 'pk-cookie' });
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('4. exchange sets an HttpOnly cookie; requireSession reads it; no/bad cookie -> 401', async () => {
    const mwApp = buildMiddlewareApp(h.sessionAuth);

    // forge a validly-signed cookie directly from the auth helper
    const validCookie = `${'ia_session'}=${h.sessionAuth.sign('s-cookie')}`;

    // with cookie -> 200 + correct session
    const ok = await request(mwApp).get('/me').set('Cookie', validCookie).expect(200);
    expect(ok.body.sessionId).toBe('s-cookie');
    expect(ok.body.projectKey).toBe('pk-cookie');

    // no cookie -> 401
    await request(mwApp).get('/me').expect(401);

    // tampered cookie -> 401
    const tampered = validCookie.slice(0, -2) + 'xx';
    await request(mwApp).get('/me').set('Cookie', tampered).expect(401);

    // unknown session id (valid signature but no row) -> 401
    const unknownCookie = `ia_session=${h.sessionAuth.sign('does-not-exist')}`;
    await request(mwApp).get('/me').set('Cookie', unknownCookie).expect(401);
  });

  it('exchange Set-Cookie carries HttpOnly + SameSite=Lax (no Secure in dev)', async () => {
    const editToken = generateEditToken();
    seedSession(h.repo, h.db, { id: 's-exch', projectKey: 'pk-exch', editToken });

    const sc = await request(h.app)
      .post('/api/auth/start-code')
      .send({ sessionId: 's-exch', editToken })
      .expect(200);
    const startCode = sc.body.startCode;

    const res = await request(h.app).post('/api/auth/exchange').send({ startCode }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionId).toBe('s-exch');

    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toMatch(/ia_session=/);
    expect(cookieStr.toLowerCase()).toContain('httponly');
    expect(cookieStr).toContain('SameSite=Lax');
    expect(cookieStr.toLowerCase()).not.toContain('secure');
  });
});

describe('auth endpoints', () => {
  let h;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('5. POST /api/auth/start-code: correct editToken yields a startCode; wrong -> 401 (no token echoed)', async () => {
    const editToken = generateEditToken();
    seedSession(h.repo, h.db, { id: 's-sc', projectKey: 'pk-sc', editToken });

    const ok = await request(h.app)
      .post('/api/auth/start-code')
      .send({ sessionId: 's-sc', editToken })
      .expect(200);
    expect(ok.body.startCode).toBeTruthy();
    expect(ok.body.expiresAt).toBeTruthy();

    const bad = await request(h.app)
      .post('/api/auth/start-code')
      .send({ sessionId: 's-sc', editToken: generateEditToken() })
      .expect(401);
    // the response must not leak the (correct) edit token
    expect(JSON.stringify(bad.body)).not.toContain(editToken);
  });

  it('5b. POST /api/auth/exchange: valid code -> 200; consumed/invalid -> 401 (no code echoed)', async () => {
    const editToken = generateEditToken();
    seedSession(h.repo, h.db, { id: 's-ex', projectKey: 'pk-ex', editToken });

    const sc = await request(h.app)
      .post('/api/auth/start-code')
      .send({ sessionId: 's-ex', editToken })
      .expect(200);
    const startCode = sc.body.startCode;

    const ok = await request(h.app).post('/api/auth/exchange').send({ startCode }).expect(200);
    expect(ok.body.sessionId).toBe('s-ex');

    // replay -> 401
    const replay = await request(h.app)
      .post('/api/auth/exchange')
      .send({ startCode })
      .expect(401);
    expect(JSON.stringify(replay.body)).not.toContain(startCode);

    // garbage -> 401
    await request(h.app).post('/api/auth/exchange').send({ startCode: 'garbage' }).expect(401);
  });
});

// ================================================ F7: independent session recovery

describe('F7: POST /api/auth/restore (independent session recovery)', () => {
  let h;
  afterEach(() => {
    if (h) { h.db.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('F7a. /independent returns targeted recoveryCode; restore sets cookie + returns sessionId', async () => {
    h = buildHarness();
    const ind = await request(h.app).post('/api/interface-sessions/independent');
    expect(ind.status).toBe(201);
    expect(ind.body.recoveryCode).toMatch(/^independent-[a-f0-9]{16}\.iaet_/);
    expect(ind.body.editToken).toBeUndefined();

    // Restore with the targeted recovery code -> sets cookie + returns sessionId.
    const restore = await request(h.app)
      .post('/api/auth/restore')
      .send({ recoveryCode: ind.body.recoveryCode });
    expect(restore.status).toBe(200);
    expect(restore.body.sessionId).toBe(ind.body.sessionId);

    // The cookie authenticates the session
    const setCookie = restore.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    const me = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.sessionId).toBe(ind.body.sessionId);

    // Restart creates a new session for the same stable project key. The saved
    // recovery code must follow that project and restore the new active session.
    const restarted = await request(h.app)
      .post(`/api/interface-sessions/${ind.body.sessionId}/restart`)
      .set('Cookie', cookie);
    expect(restarted.status).toBe(200);
    const afterRestart = await request(h.app)
      .post('/api/auth/restore')
      .send({ recoveryCode: ind.body.recoveryCode });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.sessionId).toBe(restarted.body.sessionId);
  });

  it('F7b. wrong / malformed recoveryCode is rejected without scanning sessions', async () => {
    h = buildHarness();
    const ind = await request(h.app).post('/api/interface-sessions/independent');
    const [projectKey] = ind.body.recoveryCode.split('.', 1);
    const getSessionSpy = vi.spyOn(h.app.locals.repository, 'getActiveSessionByProjectKey');

    const wrong = await request(h.app)
      .post('/api/auth/restore')
      .send({ recoveryCode: `${projectKey}.iaet_wrong` });
    expect(wrong.status).toBe(401);
    expect(getSessionSpy).toHaveBeenCalledTimes(1);
    expect(getSessionSpy).toHaveBeenCalledWith(projectKey);

    const malformed = await request(h.app)
      .post('/api/auth/restore')
      .send({ recoveryCode: 'iaet_legacy_without_session_locator' });
    expect(malformed.status).toBe(400);
    const missing = await request(h.app).post('/api/auth/restore').send({});
    expect(missing.status).toBe(400);
  });

  it('F7c. restore is rate-limited per IP', async () => {
    h = buildHarness({ rateLimitWindowMs: 60000, rateLimitMax: 2 });
    // Two wrong attempts (allowed), third → 429
    await request(h.app).post('/api/auth/restore').send({ recoveryCode: 's1.iaet_x' });
    await request(h.app).post('/api/auth/restore').send({ recoveryCode: 's1.iaet_y' });
    const r3 = await request(h.app).post('/api/auth/restore').send({ recoveryCode: 's1.iaet_z' });
    expect(r3.status).toBe(429);
  });
});

describe('auth primitives — ownership guard', () => {
  let h;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('6. requireSessionOwnsVersion: foreign session -> 403; own session -> pass', async () => {
    seedSession(h.repo, h.db, { id: 's-a', projectKey: 'pk-a' });
    seedSession(h.repo, h.db, { id: 's-b', projectKey: 'pk-b' });

    // root version V1 under session A
    const v = h.repo.commitVersion({
      sessionId: 's-a',
      parentVersionId: null,
      artifactPath: '/p/v1.html',
      contentHash: 'sha256:deadbeef',
    });

    const mwApp = buildMiddlewareApp(h.sessionAuth);

    // session B references A's version -> 403
    await request(mwApp)
      .get(`/own/${v.id}`)
      .set('Cookie', `ia_session=${h.sessionAuth.sign('s-b')}`)
      .expect(403);

    // session A references its own version -> 200
    await request(mwApp)
      .get(`/own/${v.id}`)
      .set('Cookie', `ia_session=${h.sessionAuth.sign('s-a')}`)
      .expect(200);
  });
});

describe('auth primitives — sanitization', () => {
  let h;
  let warnSpy;
  let errorSpy;
  beforeEach(() => {
    h = buildHarness();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('7. no plaintext edit token / start code leaks into responses or logs', async () => {
    const editToken = generateEditToken();
    seedSession(h.repo, h.db, { id: 's-leak', projectKey: 'pk-leak', editToken });

    // issue a real start code so we can also assert it never leaks
    const sc = await request(h.app)
      .post('/api/auth/start-code')
      .send({ sessionId: 's-leak', editToken })
      .expect(200);
    const startCode = sc.body.startCode;

    // wrong-editToken attempt: response + console output must not contain secrets
    errorSpy.mockClear();
    warnSpy.mockClear();
    const bad = await request(h.app)
      .post('/api/auth/start-code')
      .send({ sessionId: 's-leak', editToken: generateEditToken() })
      .expect(401);
    expect(JSON.stringify(bad.body)).not.toContain(editToken);
    expect(JSON.stringify(bad.body)).not.toContain(startCode);

    const consoleText = [warnSpy.mock.calls.join('\n'), errorSpy.mock.calls.join('\n')].join('\n');
    expect(consoleText).not.toContain(editToken);
    expect(consoleText).not.toContain(startCode);
  });
});

describe('auth primitives — migration 002', () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        /* closed */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('8. adds edit_token_hash column + interface_start_codes table; idempotent re-run', () => {
    db = createDbClient({ dbPath: join(dir, 'mig.db') });
    runMigrations(db);

    const cols = columnNames(db, 'interface_design_sessions');
    expect(cols).toContain('edit_token_hash');
    expect(cols).toContain('edit_token_set_at');

    expect(tableNames(db)).toContain('interface_start_codes');
    const scCols = columnNames(db, 'interface_start_codes');
    for (const c of ['id', 'session_id', 'code_hash', 'expires_at', 'used_at', 'created_at']) {
      expect(scCols).toContain(c);
    }

    // running migrations again is a no-op (idempotent), no throw
    expect(() => runMigrations(db)).not.toThrow();
    const applied = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all();
    expect(applied.map((r) => r.version)).toEqual(['001_initial', '002_edit_auth', '003_app_settings', '004_staged_html', '005_delivery_notified_at']);
  });
});

// =========================================== Fix 2: GET /api/auth/session

describe('GET /api/auth/session (Fix 2: cookie restore)', () => {
  let h;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('F2a. valid cookie → 200 { sessionId, projectKey }', async () => {
    seedSession(h.repo, h.db, { id: 's-restore', projectKey: 'pk-restore' });

    const res = await request(h.app)
      .get('/api/auth/session')
      .set('Cookie', `ia_session=${h.sessionAuth.sign('s-restore')}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('s-restore');
    expect(res.body.projectKey).toBe('pk-restore');
  });

  it('F2b. no cookie → 401', async () => {
    const res = await request(h.app).get('/api/auth/session');
    expect(res.status).toBe(401);
  });

  it('F2c. tampered cookie → 401', async () => {
    seedSession(h.repo, h.db, { id: 's-tamper', projectKey: 'pk-tamper' });
    const valid = `ia_session=${h.sessionAuth.sign('s-tamper')}`;
    const tampered = valid.slice(0, -2) + 'xx';

    const res = await request(h.app).get('/api/auth/session').set('Cookie', tampered);
    expect(res.status).toBe(401);
  });

  it('F2d. archived session cookie → 401', async () => {
    seedSession(h.repo, h.db, { id: 's-archived', projectKey: 'pk-archived' });
    h.repo.archiveSession('s-archived');

    const res = await request(h.app)
      .get('/api/auth/session')
      .set('Cookie', `ia_session=${h.sessionAuth.sign('s-archived')}`);

    expect(res.status).toBe(401);
  });
});
