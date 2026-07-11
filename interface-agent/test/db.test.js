import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';
import { createRepository } from '../src/lib/db/repository.js';
import { loadConfig } from '../src/config.js';

const DOMAIN_TABLES = [
  'interface_design_sessions',
  'interface_draft_versions',
  'interface_generation_requests',
  'interface_session_events',
  'interface_shares',
  'interface_deliveries',
];

const EXPECTED_INDEXES = [
  'idx_sessions_project_key',
  'idx_sessions_active_project',
  'idx_versions_session_label',
  'idx_versions_parent_branch',
  'idx_versions_session',
  'idx_versions_created',
  'idx_genreq_session_idem',
  'idx_genreq_session',
  'idx_genreq_status',
  'idx_events_session_seq',
  'idx_shares_version',
  'idx_shares_token',
  'idx_deliveries_session_idem',
  'idx_deliveries_session',
  'idx_deliveries_status',
];

function nowIso() {
  return new Date().toISOString();
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ia-db-'));
}

function objectNames(db, type) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
    .all(type)
    .map((r) => r.name);
}

/**
 * Bootstraps a session + root version pair, navigating the deferred
 * sessions<->versions foreign-key cycle inside a single transaction.
 */
function bootstrapSession(db, sessionId, versionId, projectKey = 'proj-test') {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO interface_design_sessions (id, project_key, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    ).run(sessionId, projectKey, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO interface_draft_versions
        (id, session_id, parent_version_id, version_label, mainline_sequence, branch_sequence,
         artifact_path, content_hash, created_at)
       VALUES (?, ?, NULL, 'V1', 1, 0, '/p/prototype.html', 'sha256:abc', ?)`,
    ).run(versionId, sessionId, nowIso());
    db.prepare(
      `UPDATE interface_design_sessions SET mainline_head_version_id = ? WHERE id = ?`,
    ).run(versionId, sessionId);
  })();
}

describe('sqlite db foundation', () => {
  let dir;
  let dbPath;
  let db;

  beforeEach(() => {
    dir = makeTempDir();
    dbPath = join(dir, 'test.db');
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      db = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function openAndMigrate() {
    db = createDbClient({ dbPath });
    runMigrations(db);
    return db;
  }

  it('1. first migration creates all 6 tables and expected indexes', () => {
    db = openAndMigrate();

    const tables = objectNames(db, 'table');
    for (const name of DOMAIN_TABLES) {
      expect(tables).toContain(name);
    }
    // framework table present as well
    expect(tables).toContain('schema_migrations');

    const indexes = objectNames(db, 'index');
    for (const name of EXPECTED_INDEXES) {
      expect(indexes, `missing index ${name}`).toContain(name);
    }
  });

  it('2. repeated migration is idempotent (no error, no duplicate records)', () => {
    db = openAndMigrate();
    const before = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all();

    // running again on the open handle must not throw and must not add records
    expect(() => runMigrations(db)).not.toThrow();

    const after = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all();
    expect(after.map((r) => r.version)).toEqual(before.map((r) => r.version));
  });

  it('3. deleting a session cascades to versions/requests/events/shares/deliveries', () => {
    db = openAndMigrate();
    const sessionId = 's-1';
    const versionId = 'v-1';
    bootstrapSession(db, sessionId, versionId);

    // seed children referencing the session / version
    db.prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, idempotency_key, instruction, status, created_at)
       VALUES ('g-1', ?, 'idem-1', 'do it', 'succeeded', ?)`,
    ).run(sessionId, nowIso());
    db.prepare(
      `INSERT INTO interface_session_events
        (id, session_id, seq, type, created_at)
       VALUES ('e-1', ?, 1, 'version_created', ?)`,
    ).run(sessionId, nowIso());
    db.prepare(
      `INSERT INTO interface_shares
        (id, session_id, version_id, token_hash, created_at)
       VALUES ('sh-1', ?, ?, 'hash-1', ?)`,
    ).run(sessionId, versionId, nowIso());
    db.prepare(
      `INSERT INTO interface_deliveries
        (id, session_id, version_id, status, attempts, idempotency_key, created_at, updated_at)
       VALUES ('d-1', ?, ?, 'pending', 0, 'didem-1', ?, ?)`,
    ).run(sessionId, versionId, nowIso(), nowIso());

    // sanity: rows exist before delete
    expect(db.prepare(`SELECT COUNT(*) c FROM interface_draft_versions`).get().c).toBe(1);

    db.prepare(`DELETE FROM interface_design_sessions WHERE id = ?`).run(sessionId);

    expect(db.prepare(`SELECT COUNT(*) c FROM interface_draft_versions`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM interface_generation_requests`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM interface_session_events`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM interface_shares`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM interface_deliveries`).get().c).toBe(0);
  });

  it('4. unique constraints reject duplicate (session_id, version_label) and (session_id, idempotency_key)', () => {
    db = openAndMigrate();
    bootstrapSession(db, 's-uniq', 'v-uniq', 'proj-uniq');

    // duplicate version label for the same session
    expect(() =>
      db.prepare(
        `INSERT INTO interface_draft_versions
          (id, session_id, parent_version_id, version_label, artifact_path, content_hash, created_at)
         VALUES ('v-dup', 's-uniq', NULL, 'V1', '/p/x.html', 'sha256:z', ?)`,
      ).run(nowIso()),
    ).toThrowError(/UNIQUE/i);

    // duplicate idempotency key for the same session
    db.prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, idempotency_key, status, created_at)
       VALUES ('g-uniq', 's-uniq', 'idem-uniq', 'queued', ?)`,
    ).run(nowIso());
    expect(() =>
      db.prepare(
        `INSERT INTO interface_generation_requests
          (id, session_id, idempotency_key, status, created_at)
         VALUES ('g-dup', 's-uniq', 'idem-uniq', 'queued', ?)`,
      ).run(nowIso()),
    ).toThrowError(/UNIQUE/i);
  });

  it('5. reopening the same db file preserves data', () => {
    db = openAndMigrate();
    bootstrapSession(db, 's-persist', 'v-persist', 'proj-persist');
    db.close();
    db = null;

    // reopen fresh and migrate again
    db = createDbClient({ dbPath });
    runMigrations(db);

    const session = db
      .prepare(`SELECT id, project_key, mainline_head_version_id FROM interface_design_sessions WHERE id = ?`)
      .get('s-persist');
    expect(session).toBeDefined();
    expect(session.project_key).toBe('proj-persist');
    expect(session.mainline_head_version_id).toBe('v-persist');
  });

  it('6. enables WAL, foreign_keys and busy_timeout pragmas', () => {
    db = openAndMigrate();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('7. config honors INTERFACE_AGENT_DB_PATH override and default', () => {
    const override = '/custom/path/interface-agent.db';
    expect(loadConfig({ INTERFACE_AGENT_DB_PATH: override }).dbPath).toBe(override);
    expect(loadConfig({}).dbPath).toBe('/var/lib/interface-agent/interface-agent.db');
  });
});

describe('repository boundary', () => {
  let dir;
  let dbPath;
  let db;

  beforeEach(() => {
    dir = makeTempDir();
    dbPath = join(dir, 'repo.db');
    db = createDbClient({ dbPath });
    runMigrations(db);
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      db = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('tx() commits on success and rolls back on throw', () => {
    const repo = createRepository(db);

    repo.tx(() => {
      repo.createSession({ id: 'r-1', projectKey: 'proj-r', createdAt: nowIso() });
    });
    expect(repo.getSession('r-1')).toBeDefined();

    expect(() =>
      repo.tx(() => {
        repo.createSession({ id: 'r-2', projectKey: 'proj-r2', createdAt: nowIso() });
        throw new Error('boom');
      }),
    ).toThrowError(/boom/);
    expect(repo.getSession('r-2')).toBeUndefined();
  });

  it('createDbClient creates the db file at the configured path', () => {
    expect(existsSync(dbPath)).toBe(true);
  });
});

// Fix 3 (review round 1): routes must not reach past the repository boundary into
// raw SQL for generation-request metadata. The repository method returns only
// the projection the version-tree routes need (id, instruction, status).

describe('listGenerationRequestMetaBySession (repository boundary)', () => {
  let dir;
  let db;
  let repo;

  beforeEach(() => {
    dir = makeTempDir();
    db = createDbClient({ dbPath: join(dir, 'repo.db') });
    runMigrations(db);
    repo = createRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only id/instruction/status for the session (no extra columns, no raw db in routes)', () => {
    repo.createSession({ id: 'sess-meta', projectKey: 'pk-meta', createdAt: nowIso() });

    db.prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, base_version_id, idempotency_key, instruction, status, created_at)
       VALUES (?, ?, NULL, ?, ?, 'succeeded', ?)`,
    ).run('r-1', 'sess-meta', 'idem-1', 'build a dashboard', nowIso());
    db.prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, base_version_id, idempotency_key, instruction, status, created_at)
       VALUES (?, ?, NULL, ?, ?, 'failed', ?)`,
    ).run('r-2', 'sess-meta', 'idem-2', 'fix colors', nowIso());

    const rows = repo.listGenerationRequestMetaBySession('sess-meta');

    expect(rows).toHaveLength(2);
    // Only the three projected columns are exposed.
    expect(rows[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), instruction: expect.any(String), status: expect.any(String) }),
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['r-1'].instruction).toBe('build a dashboard');
    expect(byId['r-1'].status).toBe('succeeded');
    expect(byId['r-2'].status).toBe('failed');
    // No internal columns (result_version_id, error_code, ...) leak through.
    expect(Object.keys(byId['r-1']).sort()).toEqual(['id', 'instruction', 'status']);
  });
});
