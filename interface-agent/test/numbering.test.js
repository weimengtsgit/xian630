import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbClient } from '../src/lib/db/client.js';
import { runMigrations } from '../src/lib/db/migrations/index.js';
import { createRepository } from '../src/lib/db/repository.js';
import {
  VersionNotInSessionError,
  compareLabelPath,
  parseLabelPath,
} from '../src/lib/db/numbering.js';

/**
 * Task 2 — version numbering, ancestor projection and cross-session guards.
 *
 * Each test boots a fresh temp SQLite file, migrates, and builds a repository.
 * Generation requests are seeded via raw SQL (their creation is T5's job; T2
 * only stores generation_request_id and projects instructions from it).
 */
describe('interface-agent version numbering', () => {
  let dir;
  let dbPath;
  let db;
  let repo;
  let sessionCounter = 0;
  let versionCounter = 0;
  let requestCounter = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ia-num-'));
    dbPath = join(dir, 'numbering.db');
    db = createDbClient({ dbPath });
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

  function nowIso() {
    return new Date().toISOString();
  }

  function newSession(projectKey = 'proj-num') {
    sessionCounter += 1;
    const id = `sess-${sessionCounter}`;
    repo.createSession({ id, projectKey, createdAt: nowIso() });
    return id;
  }

  function newVersionId() {
    versionCounter += 1;
    return `ver-${versionCounter}`;
  }

  /**
   * Inserts a generation_request row and returns its id. T2 does not own
   * request creation; tests seed requests directly to drive instruction
   * projection.
   */
  function seedGenerationRequest(sessionId, instruction, idempotencyKey) {
    requestCounter += 1;
    const id = `req-${requestCounter}`;
    db.prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, idempotency_key, instruction, status, created_at)
       VALUES (?, ?, ?, ?, 'succeeded', ?)`,
    ).run(id, sessionId, idempotencyKey, instruction, nowIso());
    return id;
  }

  /** Convenience: commit a version, letting the repo assign the id. */
  function commit(opts) {
    return repo.commitVersion({ id: newVersionId(), ...opts });
  }

  it('1. root commit is V1, mainline_sequence=1, and becomes the session head', () => {
    const sessionId = newSession();
    const v1 = commit({
      sessionId,
      parentVersionId: null,
      artifactPath: '/p/v1.html',
      contentHash: 'sha256:v1',
      byteSize: 11,
      title: 'root',
      createdBy: 'tester',
    });

    expect(v1.version_label).toBe('V1');
    expect(v1.mainline_sequence).toBe(1);
    expect(parseLabelPath(v1.label_path_json)).toEqual([1]);

    const session = repo.getSession(sessionId);
    expect(session.mainline_head_version_id).toBe(v1.id);
  });

  it('2. mainline commits V1->V2->V3 advance the head and increment mainline_sequence', () => {
    const sessionId = newSession();
    const v1 = commit({ sessionId, parentVersionId: null, artifactPath: '/p/v1', contentHash: 'h1' });
    const v2 = commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v2', contentHash: 'h2' });
    const v3 = commit({ sessionId, parentVersionId: v2.id, artifactPath: '/p/v3', contentHash: 'h3' });

    expect(v2.version_label).toBe('V2');
    expect(v3.version_label).toBe('V3');
    expect(v2.mainline_sequence).toBe(2);
    expect(v3.mainline_sequence).toBe(3);
    expect(parseLabelPath(v3.label_path_json)).toEqual([3]);

    const session = repo.getSession(sessionId);
    expect(session.mainline_head_version_id).toBe(v3.id);
  });

  it('3. branching off history yields V1.1 then V1.2 without moving the head', () => {
    const sessionId = newSession();
    const v1 = commit({ sessionId, parentVersionId: null, artifactPath: '/p/v1', contentHash: 'h1' });
    const v2 = commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v2', contentHash: 'h2' });
    const v3 = commit({ sessionId, parentVersionId: v2.id, artifactPath: '/p/v3', contentHash: 'h3' });

    const v11 = commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v1.1', contentHash: 'h11' });
    const v12 = commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v1.2', contentHash: 'h12' });

    expect(v11.version_label).toBe('V1.1');
    expect(v12.version_label).toBe('V1.2');
    expect(v11.branch_sequence).toBe(1);
    expect(v12.branch_sequence).toBe(2);
    expect(v11.mainline_sequence).toBe(1); // inherited, not advanced
    expect(parseLabelPath(v11.label_path_json)).toEqual([1, 1]);
    expect(parseLabelPath(v12.label_path_json)).toEqual([1, 2]);

    // head untouched by branches
    const session = repo.getSession(sessionId);
    expect(session.mainline_head_version_id).toBe(v3.id);
  });

  it('4. a deep branch V1.1 -> V1.1.1 reuses branch_sequence=1 under its parent', () => {
    const sessionId = newSession();
    const v1 = commit({ sessionId, parentVersionId: null, artifactPath: '/p/v1', contentHash: 'h1' });
    // advance the mainline past V1 so V1 is no longer the head, then branch it
    const v2 = commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v2', contentHash: 'h2' });
    expect(repo.getSession(sessionId).mainline_head_version_id).toBe(v2.id);

    const v11 = commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v1.1', contentHash: 'h11' });
    const v111 = commit({ sessionId, parentVersionId: v11.id, artifactPath: '/p/v1.1.1', contentHash: 'h111' });

    expect(v11.version_label).toBe('V1.1');
    expect(v111.version_label).toBe('V1.1.1');
    expect(v111.branch_sequence).toBe(1);
    expect(v111.mainline_sequence).toBe(1);
    expect(parseLabelPath(v111.label_path_json)).toEqual([1, 1, 1]);
  });

  it('5. concurrent same-head commits: first advances mainline, second branches off the original baseline', () => {
    const sessionId = newSession();
    const v1 = commit({ sessionId, parentVersionId: null, artifactPath: '/p/v1', contentHash: 'h1' });
    const v2 = commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v2', contentHash: 'h2' });
    const v3 = commit({ sessionId, parentVersionId: v2.id, artifactPath: '/p/v3', contentHash: 'h3' });
    // head is now V3

    // Simulated race: both commits base the "current head" V3. Commit A enters
    // its tx first and advances the mainline (head -> V4). Commit B then enters
    // its tx with the *original* head V3 as base; it re-reads head inside the
    // tx, finds V3 no longer equals head, and branches off V3 -> V3.1.
    const a = commit({ sessionId, parentVersionId: v3.id, artifactPath: '/p/a', contentHash: 'ha' });
    const b = commit({ sessionId, parentVersionId: v3.id, artifactPath: '/p/b', contentHash: 'hb' });

    expect(a.version_label).toBe('V4');
    expect(b.version_label).toBe('V3.1');
    expect(a.branch_sequence).toBe(0);
    expect(b.branch_sequence).toBe(1);

    // both succeed, head points at the mainline advance, no constraint violation
    const session = repo.getSession(sessionId);
    expect(session.mainline_head_version_id).toBe(a.id);
    expect(repo.getVersion(b.id)).toBeDefined();
  });

  it('6. ancestor projection returns only the root->current chain instructions (no siblings/descendants)', () => {
    const sessionId = newSession();

    // Each version carries a generation_request with a distinct instruction.
    const r1 = seedGenerationRequest(sessionId, 'instr-V1', 'idem-1');
    const r2 = seedGenerationRequest(sessionId, 'instr-V2', 'idem-2');
    const r3 = seedGenerationRequest(sessionId, 'instr-V3', 'idem-3');
    const r11 = seedGenerationRequest(sessionId, 'instr-V1.1', 'idem-11');
    const r12 = seedGenerationRequest(sessionId, 'instr-V1.2', 'idem-12');
    const r111 = seedGenerationRequest(sessionId, 'instr-V1.1.1', 'idem-111');

    const v1 = commit({ sessionId, parentVersionId: null, generationRequestId: r1, artifactPath: '/p/v1', contentHash: 'h1' });
    const v2 = commit({ sessionId, parentVersionId: v1.id, generationRequestId: r2, artifactPath: '/p/v2', contentHash: 'h2' });
    const v3 = commit({ sessionId, parentVersionId: v2.id, generationRequestId: r3, artifactPath: '/p/v3', contentHash: 'h3' });
    const v11 = commit({ sessionId, parentVersionId: v1.id, generationRequestId: r11, artifactPath: '/p/v1.1', contentHash: 'h11' });
    const v12 = commit({ sessionId, parentVersionId: v1.id, generationRequestId: r12, artifactPath: '/p/v1.2', contentHash: 'h12' });
    const v111 = commit({ sessionId, parentVersionId: v11.id, generationRequestId: r111, artifactPath: '/p/v1.1.1', contentHash: 'h111' });

    const chain = repo.getAncestorChain(v111.id).map((v) => v.version_label);
    expect(chain).toEqual(['V1', 'V1.1', 'V1.1.1']);

    const instructions = repo.getBranchInstructions(v111.id);
    expect(instructions).toEqual(['instr-V1', 'instr-V1.1', 'instr-V1.1.1']);
    // explicitly excludes mainline descendants (V2/V3) and the sibling (V1.2)
    expect(instructions).not.toContain('instr-V2');
    expect(instructions).not.toContain('instr-V3');
    expect(instructions).not.toContain('instr-V1.2');
  });

  it('7. cross-session parent reference is rejected with VersionNotInSessionError', () => {
    const sessionA = newSession('proj-a');
    const sessionB = newSession('proj-b');
    const aRoot = commit({ sessionId: sessionA, parentVersionId: null, artifactPath: '/p/a1', contentHash: 'ha' });

    // direct guard API
    expect(() => repo.assertVersionInSession(aRoot.id, sessionB)).toThrowError(VersionNotInSessionError);

    // and via commitVersion: using A's version as B's base must throw, not branch
    expect(() =>
      commit({ sessionId: sessionB, parentVersionId: aRoot.id, artifactPath: '/p/b1', contentHash: 'hb' }),
    ).toThrowError(VersionNotInSessionError);

    // session B is untouched
    expect(repo.getSession(sessionB).mainline_head_version_id).toBeNull();
    expect(repo.getVersionTree(sessionB)).toHaveLength(0);
  });

  it('8. label_path numeric sort orders V1..V12 correctly (not string lex where V10<V2)', () => {
    const sessionId = newSession();
    let prev = commit({ sessionId, parentVersionId: null, artifactPath: '/p/v1', contentHash: 'h1' });
    for (let i = 2; i <= 12; i += 1) {
      prev = commit({ sessionId, parentVersionId: prev.id, artifactPath: `/p/v${i}`, contentHash: `h${i}` });
    }

    const ordered = repo.getVersionTree(sessionId).map((v) => v.version_label);
    expect(ordered).toEqual([
      'V1', 'V2', 'V3', 'V4', 'V5', 'V6',
      'V7', 'V8', 'V9', 'V10', 'V11', 'V12',
    ]);

    // sanity: the pure comparator agrees
    const paths = [[1], [2], [3], [10], [11], [12]];
    expect([...paths].sort(compareLabelPath)).toEqual([[1], [2], [3], [10], [11], [12]]);
  });

  it('9. atomic failure: a unique-constraint collision mid-commit rolls back leaving no half-baked version and head unchanged', () => {
    const sessionId = newSession();
    const v1 = commit({ sessionId, parentVersionId: null, artifactPath: '/p/v1', contentHash: 'h1' });
    // head = V1; the next mainline commit would produce label 'V2' under parent V1.

    // Pre-sabotage: insert a row that collides on (session_id, version_label)='V2'
    // but uses a distinct branch_sequence so only the label collides.
    db.prepare(
      `INSERT INTO interface_draft_versions
        (id, session_id, parent_version_id, version_label, mainline_sequence, branch_sequence,
         artifact_path, content_hash, created_at)
       VALUES (?, ?, ?, 'V2', 1, 99, '/p/sabotage', 'sha256:sab', ?)`,
    ).run('ver-sabotage', sessionId, v1.id, nowIso());

    const versionsBefore = repo.getVersionTree(sessionId).length;
    expect(() =>
      commit({ sessionId, parentVersionId: v1.id, artifactPath: '/p/v2', contentHash: 'h2' }),
    ).toThrowError(/UNIQUE/i);

    // tx rolled back: head unchanged, no extra version beyond the sabotage row
    expect(repo.getSession(sessionId).mainline_head_version_id).toBe(v1.id);
    expect(repo.getVersionTree(sessionId).length).toBe(versionsBefore);
  });
});
