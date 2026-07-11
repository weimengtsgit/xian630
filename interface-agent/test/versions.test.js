import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';
import { BladeFileError } from '../src/lib/bladeFiles.js';

const SESSION_SECRET = 'test-secret-fixed-for-versions-hmac';
const ROOT_HTML = '<!doctype html><html><body><h1>Root</h1></body></html>';

function nowIso() {
  return new Date().toISOString();
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-versions-'));
}

/**
 * Integration harness identical in shape to generations.test.js: temp SQLite +
 * all migrations, createApp with injectable fake deepseekClient + fileClient.
 */
function buildHarness(overrides = {}) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'versions.db');
  const db = createDbClient({ dbPath });
  runMigrations(db);

  const deepseekClient = overrides.deepseekClient ?? {
    generateHtml: vi.fn().mockResolvedValue(ROOT_HTML),
  };
  const fileClient = overrides.fileClient ?? {
    uploadText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(ROOT_HTML),
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

async function setupSession(h, projectKey = 'pk-versions') {
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

function seedVersionWithInstruction(
  h,
  sessionId,
  { parentVersionId, instruction, artifactPath },
) {
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

function setConfirmed(h, sessionId, versionId) {
  h.db
    .prepare(`UPDATE interface_design_sessions SET confirmed_version_id = ? WHERE id = ?`)
    .run(versionId, sessionId);
}

// ============================================================ 1. GET versions tree

describe('GET versions tree', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('1. returns versions sorted by labelPath + confirmed flag + instructionSummary', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-tree');

    // Tree:
    //   V1 (root-instr) -> V2 (mainline-instr) [head]
    //   V1 -> V1.1 (branch-instr)
    //   V1.1 -> V1.1.1 (deep-instr)
    //   V1 -> V1.2 (sibling-instr) [archived]
    const { version: v1 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: null,
      instruction: 'root-instr',
    });
    const { version: v2 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'mainline-instr',
    });
    const { version: v11 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'branch-instr',
    });
    seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v11.id,
      instruction: 'deep-instr',
    });
    const { version: v12 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'sibling-instr',
    });

    // Archive V1.2 + confirm V2 directly.
    h.db
      .prepare(`UPDATE interface_draft_versions SET archived_at = ? WHERE id = ?`)
      .run(nowIso(), v12.id);
    setConfirmed(h, sessionId, v2.id);

    const r = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/versions`)
      .set('Cookie', cookieFor(h, sessionId));

    expect(r.status).toBe(200);
    const labels = r.body.versions.map((v) => v.versionLabel);
    // Numeric label_path order, NOT string lex: [1],[1,1],[1,1,1],[1,2],[2]
    expect(labels).toEqual(['V1', 'V1.1', 'V1.1.1', 'V1.2', 'V2']);

    const byLabel = Object.fromEntries(r.body.versions.map((v) => [v.versionLabel, v]));
    expect(byLabel.V2.confirmed).toBe(true);
    expect(byLabel.V1.confirmed).toBe(false);
    expect(byLabel['V1.2'].archived).toBe(true);
    expect(byLabel.V1.archived).toBe(false);

    // labelPath is a numeric array
    expect(byLabel.V1.labelPath).toEqual([1]);
    expect(byLabel['V1.1'].labelPath).toEqual([1, 1]);
    expect(byLabel['V1.1.1'].labelPath).toEqual([1, 1, 1]);

    // instructionSummary derives from the generation request instruction
    expect(byLabel.V1.instructionSummary).toContain('root-instr');
    expect(byLabel['V1.1'].instructionSummary).toContain('branch-instr');
    expect(byLabel.V2.generationStatus).toBe('succeeded');
  });
});

// ============================================================ 2. GET version detail

describe('GET version detail + branch dialogue', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('2. branchDialogue contains only ancestor-chain instructions (no siblings/descendants)', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-detail');

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
      instruction: 'instr-descendant',
    });
    const { version: v11 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'instr-branch',
    });
    seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'instr-sibling',
    });

    const r = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/versions/${v11.id}`)
      .set('Cookie', cookieFor(h, sessionId));

    expect(r.status).toBe(200);
    const dialogueLabels = r.body.branchDialogue.map((d) => d.versionLabel);
    expect(dialogueLabels).toEqual(['V1', 'V1.1']);
    const dialogueInstr = r.body.branchDialogue.map((d) => d.instruction);
    expect(dialogueInstr).toEqual(['instr-root', 'instr-branch']);

    // Explicitly excludes descendants and siblings
    expect(dialogueInstr).not.toContain('instr-mainline');
    expect(dialogueInstr).not.toContain('instr-descendant');
    expect(dialogueInstr).not.toContain('instr-sibling');

    // Detail metadata
    expect(r.body.versionId).toBe(v11.id);
    expect(r.body.contentHash).toBeTruthy();
    expect(r.body.byteSize).toBe(100);
    expect(r.body.labelPath).toEqual([1, 1]);
  });
});

// ============================================================ 3. GET version html

describe('GET version html', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('3a. returns the version HTML via fileClient (text/html)', async () => {
    const VERSION_HTML = '<!doctype html><html><body>V1 body</body></html>';
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(VERSION_HTML),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-html');
    const { version: v1 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: null,
      instruction: 'root',
    });

    const r = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/versions/${v1.id}/html`)
      .set('Cookie', cookieFor(h, sessionId));

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toBe(VERSION_HTML);
    // fileClient was asked for this version's artifact path
    expect(h.fileClient.readText).toHaveBeenCalledWith(v1.artifact_path);

    // F2: CSP must be `sandbox allow-scripts` (SPACE — a semicolon ends the
    // sandbox directive, leaving no tokens → scripts BLOCKED). NO allow-same-origin.
    const csp = r.headers['content-security-policy'] || '';
    expect(csp).toBe('sandbox allow-scripts');
    expect(csp).not.toMatch(/allow-same-origin/);
  });

  it('3b. missing artifact file -> 404 with sanitized message', async () => {
    h = buildHarness({
      fileClient: {
        uploadText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockImplementation(() => {
          throw new BladeFileError(404, 'not found');
        }),
      },
    });
    const { sessionId } = await setupSession(h, 'pk-html-404');
    const { version: v1 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: null,
      instruction: 'root',
    });

    const r = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/versions/${v1.id}/html`)
      .set('Cookie', cookieFor(h, sessionId));

    expect(r.status).toBe(404);
    expect(r.body.error).toBeTruthy();
  });
});

// ============================================================ 4. PATCH title

describe('PATCH version title', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('4. edits title in place (no new version, label unchanged)', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-title');
    const { version: v1 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: null,
      instruction: 'original instruction',
    });
    const versionsBefore = h.app.locals.repository.getVersionTree(sessionId).length;

    const r = await request(h.app)
      .patch(`/api/interface-sessions/${sessionId}/versions/${v1.id}`)
      .set('Cookie', cookieFor(h, sessionId))
      .send({ title: 'renamed title' });

    expect(r.status).toBe(200);
    expect(r.body.title).toBe('renamed title');
    // Label + HTML are immutable
    expect(r.body.versionLabel).toBe('V1');

    // No new version was created
    const versionsAfter = h.app.locals.repository.getVersionTree(sessionId).length;
    expect(versionsAfter).toBe(versionsBefore);

    // Persisted
    const refreshed = h.app.locals.repository.getVersion(v1.id);
    expect(refreshed.title).toBe('renamed title');
    expect(refreshed.version_label).toBe('V1');
  });

  it('4b. toggling archived flips archived flag without creating a version', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-archive');
    const { version: v1 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: null,
      instruction: 'original',
    });

    const archived = await request(h.app)
      .patch(`/api/interface-sessions/${sessionId}/versions/${v1.id}`)
      .set('Cookie', cookieFor(h, sessionId))
      .send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);

    const restored = await request(h.app)
      .patch(`/api/interface-sessions/${sessionId}/versions/${v1.id}`)
      .set('Cookie', cookieFor(h, sessionId))
      .send({ archived: false });
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);

    // Still one version
    expect(h.app.locals.repository.getVersionTree(sessionId)).toHaveLength(1);
  });

  it('F5. archiving the CONFIRMED version -> 409; non-confirmed + un-archive ok', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-f5');
    const { version: v1 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: null,
      instruction: 'root',
    });
    const { version: v2 } = seedVersionWithInstruction(h, sessionId, {
      parentVersionId: v1.id,
      instruction: 'child',
    });

    // Confirm v1 directly (the confirmed version must not be archivable).
    h.db
      .prepare(`UPDATE interface_design_sessions SET confirmed_version_id = ? WHERE id = ?`)
      .run(v1.id, sessionId);

    // Archive the CONFIRMED version -> 409
    const blockConf = await request(h.app)
      .patch(`/api/interface-sessions/${sessionId}/versions/${v1.id}`)
      .set('Cookie', cookieFor(h, sessionId))
      .send({ archived: true });
    expect(blockConf.status).toBe(409);

    // Archive a NON-confirmed branch -> ok
    const okBranch = await request(h.app)
      .patch(`/api/interface-sessions/${sessionId}/versions/${v2.id}`)
      .set('Cookie', cookieFor(h, sessionId))
      .send({ archived: true });
    expect(okBranch.status).toBe(200);
    expect(okBranch.body.archived).toBe(true);

    // Un-archive (archived:false) is always allowed, even on the confirmed version
    const unarchive = await request(h.app)
      .patch(`/api/interface-sessions/${sessionId}/versions/${v2.id}`)
      .set('Cookie', cookieFor(h, sessionId))
      .send({ archived: false });
    expect(unarchive.status).toBe(200);
    expect(unarchive.body.archived).toBe(false);
  });
});

// ============================================================ 5. cross-session 403

describe('cross-session version access rejected', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('5. GET/PATCH other session version -> 403', async () => {
    h = buildHarness();
    const { sessionId: sidA } = await setupSession(h, 'pk-x-a');
    const { sessionId: sidB } = await setupSession(h, 'pk-x-b');
    const { version: vB } = seedVersionWithInstruction(h, sidB, {
      parentVersionId: null,
      instruction: 'b-only',
    });

    // Auth as A, attempt to read B's version detail/html
    const getDetail = await request(h.app)
      .get(`/api/interface-sessions/${sidA}/versions/${vB.id}`)
      .set('Cookie', cookieFor(h, sidA));
    expect(getDetail.status).toBe(403);

    const getHtml = await request(h.app)
      .get(`/api/interface-sessions/${sidA}/versions/${vB.id}/html`)
      .set('Cookie', cookieFor(h, sidA));
    expect(getHtml.status).toBe(403);

    const patchTitle = await request(h.app)
      .patch(`/api/interface-sessions/${sidA}/versions/${vB.id}`)
      .set('Cookie', cookieFor(h, sidA))
      .send({ title: 'hijack' });
    expect(patchTitle.status).toBe(403);
  });
});

// ============================================================ 6. GET events

describe('GET events', () => {
  let h;
  afterEach(() => { if (h) cleanup(h); });

  it('6. returns events sorted by seq asc with sanitized payloads (no path/secret leak)', async () => {
    h = buildHarness();
    const { sessionId } = await setupSession(h, 'pk-events');
    const repo = h.app.locals.repository;

    // Seed three events with payloads that include fields that must NOT leak
    // (internal artifact path, raw instruction text). The endpoint whitelists
    // safe fields per event type.
    repo.insertEvent({
      sessionId,
      type: 'generation_succeeded',
      payload: { versionId: 'v-a', versionLabel: 'V1' },
    });
    repo.insertEvent({
      sessionId,
      type: 'legacy_imported',
      payload: { versionId: 'v-a', artifactPath: 'internal/secret/path/prototype.html' },
    });
    repo.insertEvent({
      sessionId,
      type: 'generation_failed',
      payload: { errorCode: 'model', instruction: 'SECRET-PAT-sk-deadbeef' },
    });

    const r = await request(h.app)
      .get(`/api/interface-sessions/${sessionId}/events`)
      .set('Cookie', cookieFor(h, sessionId));

    expect(r.status).toBe(200);
    const seqs = r.body.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(r.body.events.map((e) => e.type)).toEqual([
      'generation_succeeded',
      'legacy_imported',
      'generation_failed',
    ]);

    const body = JSON.stringify(r.body);
    // No internal path or raw instruction text leaks into the response
    expect(body).not.toContain('internal/secret/path');
    expect(body).not.toContain('SECRET-PAT-sk-deadbeef');

    // Whitelisted fields are present
    const succeeded = r.body.events.find((e) => e.type === 'generation_succeeded');
    expect(succeeded.payloadSummary.versionId).toBe('v-a');
    const failed = r.body.events.find((e) => e.type === 'generation_failed');
    expect(failed.payloadSummary.errorCode).toBe('model');
    expect(failed.payloadSummary.instruction).toBeUndefined();
  });
});
