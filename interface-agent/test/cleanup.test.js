import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';
import { createRepository } from '../src/lib/db/repository.js';
import { cleanupOrphanArtifacts } from '../src/lib/generations/cleanup.js';

/**
 * Task 8 — orphan-artifact cleanup.
 *
 * The pure sweep function is exercised with a temp SQLite DB (real repository)
 * + a fake fileClient whose `list` simulates a Blade OS directory tree and
 * whose `remove` records deletions. This pins the safety contract:
 *   - a version referenced by a DB row is NEVER removed,
 *   - an orphan older than maxAgeMs IS removed,
 *   - an orphan younger than maxAgeMs is kept (in-flight protection),
 *   - the compatibility delivery path is never scanned,
 *   - a per-file delete error does not abort the sweep.
 */
const BASE_DIR = '共享'; // dir of confirmedOutputPath "共享/prototype.html"
const NOW = Date.parse('2026-07-10T12:00:00Z');
const H = 60 * 60 * 1000;
const M = 60 * 1000;

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-cleanup-'));
}

/**
 * Build a fake fileClient over an in-memory tree. `tree` maps a directory path
 * to an array of entries {name, is_dir, modified}. list(path) returns the
 * entries for that exact path (or throws a 404-like error if absent, mirroring
 * Blade OS). remove(paths) records into `deleted` and optionally throws for
 * specific paths to exercise error tolerance.
 */
function fakeFileClient(tree, { failRemove = [] } = {}) {
  const deleted = [];
  return {
    deleted,
    async list(path) {
      const entries = tree[path];
      if (!entries) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      return entries;
    },
    async remove(paths) {
      for (const p of paths) {
        if (failRemove.includes(p)) {
          const err = new Error('forbidden');
          err.status = 403;
          throw err;
        }
        deleted.push(p);
      }
      return { ok: true };
    },
  };
}

function newRepo() {
  const dir = makeTempDir();
  const db = createDbClient({ dbPath: join(dir, 'cleanup.db') });
  runMigrations(db);
  return { dir, db, repo: createRepository(db) };
}

function seedSession(repo, projectKey = 'demo') {
  // Create an active session directly (no HTTP/auth needed for the sweep).
  return repo.createSessionWithToken({
    id: `sess-${projectKey}`,
    projectKey,
    createdAt: new Date().toISOString(),
    editTokenHash: 'seed-no-real-token',
  });
}

describe('cleanupOrphanArtifacts safety contract', () => {
  let ctx;
  beforeEach(() => { ctx = newRepo(); });
  afterEach(() => { if (ctx) rmSync(ctx.dir, { recursive: true, force: true }); });

  it('keeps a version with a DB row; reclaims an old orphan; keeps a young orphan', async () => {
    const { repo } = ctx;
    const session = seedSession(repo);

    // Commit ONLY the keep version (parentVersionId=null → root V1). Its
    // dir name in the simulated FS is this version id, and its artifact_path
    // is reconstructed by cleanup to the exact same string → DB match → keep.
    const keepVersion = repo.commitVersion({
      id: 'vid-keep',
      sessionId: session.id,
      parentVersionId: null,
      artifactPath: '共享/demo/interface-sessions/S1/versions/vid-keep/prototype.html',
      contentHash: 'sha256:keep',
      byteSize: 10,
      title: 'V1',
      createdBy: 'seed',
    });
    expect(keepVersion.id).toBe('vid-keep');

    const orphanOldPath = '共享/demo/interface-sessions/S1/versions/V_ORPHAN_OLD/prototype.html';
    const orphanYoungPath = '共享/demo/interface-sessions/S1/versions/V_ORPHAN_YOUNG/prototype.html';

    // Simulated Blade OS tree: keep dir has the real id; orphans have no DB row.
    const tree = {
      '共享/demo/interface-sessions': [{ name: 'S1', is_dir: true, modified: iso(NOW - 3 * H) }],
      '共享/demo/interface-sessions/S1/versions': [
        { name: 'vid-keep', is_dir: true, modified: iso(NOW - 2 * H) }, // keep (has row)
        { name: 'V_ORPHAN_OLD', is_dir: true, modified: iso(NOW - 2 * H) }, // orphan, old
        { name: 'V_ORPHAN_YOUNG', is_dir: true, modified: iso(NOW - 5 * M) }, // orphan, young
      ],
    };
    const fc = fakeFileClient(tree);

    const summary = await cleanupOrphanArtifacts({
      fileClient: fc,
      repository: repo,
      baseDir: BASE_DIR,
      projectKeys: ['demo'],
      maxAgeMs: 1 * H,
      now: NOW,
    });

    // Only the old orphan is removed; keep (DB row) and young orphan are kept.
    expect(summary.scanned).toBe(3);
    expect(summary.removed).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(fc.deleted).toEqual([orphanOldPath]);
    // The DB-backed artifact and the young orphan are untouched.
    expect(fc.deleted).not.toContain(orphanYoungPath);
    expect(fc.deleted).not.toContain('共享/demo/interface-sessions/S1/versions/vid-keep/prototype.html');
  });

  it('never scans or removes the compatibility delivery path', async () => {
    const { repo } = ctx;
    seedSession(repo);
    // A compat delivery file exists alongside the sessions subtree. It must
    // never appear in list/remove calls because cleanup only walks the
    // interface-sessions/ subtree.
    const tree = {
      '共享/demo/interface-sessions': [],
    };
    const fc = fakeFileClient(tree);
    await cleanupOrphanArtifacts({
      fileClient: fc,
      repository: repo,
      baseDir: BASE_DIR,
      projectKeys: ['demo'],
      maxAgeMs: 1 * H,
      now: NOW,
    });
    expect(fc.deleted).toEqual([]);
    // The compat path 共享/demo/prototype.html was never enumerated.
  });

  it('continues past a per-file delete error and records it', async () => {
    const { repo } = ctx;
    seedSession(repo);
    const bad = '共享/demo/interface-sessions/S1/versions/V_BAD/prototype.html';
    const good = '共享/demo/interface-sessions/S1/versions/V_GOOD/prototype.html';
    const tree = {
      '共享/demo/interface-sessions': [{ name: 'S1', is_dir: true, modified: iso(NOW - 3 * H) }],
      '共享/demo/interface-sessions/S1/versions': [
        { name: 'V_BAD', is_dir: true, modified: iso(NOW - 2 * H) },
        { name: 'V_GOOD', is_dir: true, modified: iso(NOW - 2 * H) },
      ],
    };
    const fc = fakeFileClient(tree, { failRemove: [bad] });

    const summary = await cleanupOrphanArtifacts({
      fileClient: fc,
      repository: repo,
      baseDir: BASE_DIR,
      projectKeys: ['demo'],
      maxAgeMs: 1 * H,
      now: NOW,
    });

    expect(summary.scanned).toBe(2);
    expect(summary.removed).toBe(1); // good one still removed
    expect(summary.errors).toBe(1); // bad one recorded, not fatal
    expect(fc.deleted).toEqual([good]);
  });

  it('treats a missing sessions dir (list 404) as nothing to scan', async () => {
    const { repo } = ctx;
    seedSession(repo);
    const fc = fakeFileClient({}); // empty tree → every list throws 404
    const summary = await cleanupOrphanArtifacts({
      fileClient: fc,
      repository: repo,
      baseDir: BASE_DIR,
      projectKeys: ['demo'],
      maxAgeMs: 1 * H,
      now: NOW,
    });
    expect(summary).toEqual({ scanned: 0, removed: 0, skipped: 0, errors: 0 });
  });

  it('no fileClient → empty summary (disabled gracefully)', async () => {
    const { repo } = ctx;
    const summary = await cleanupOrphanArtifacts({
      fileClient: null,
      repository: repo,
      baseDir: BASE_DIR,
      projectKeys: ['demo'],
      maxAgeMs: 1 * H,
      now: NOW,
    });
    expect(summary).toEqual({ scanned: 0, removed: 0, skipped: 0, errors: 0 });
  });

  it('repository helpers: listDistinctProjectKeys + hasVersionWithArtifactPath', () => {
    const { repo } = ctx;
    const a = seedSession(repo, 'alpha');
    repo.commitVersion({
      sessionId: a.id,
      parentVersionId: null,
      artifactPath: '共享/alpha/interface-sessions/S/v/prototype.html',
      contentHash: 'x',
      byteSize: 1,
      title: 'V1',
      createdBy: 'seed',
    });
    const keys = repo.listDistinctProjectKeys();
    expect(keys).toContain('alpha');
    expect(repo.hasVersionWithArtifactPath('共享/alpha/interface-sessions/S/v/prototype.html')).toBe(true);
    expect(repo.hasVersionWithArtifactPath('共享/alpha/interface-sessions/S/other/prototype.html')).toBe(false);
  });
});

function iso(ms) {
  return new Date(ms).toISOString();
}
