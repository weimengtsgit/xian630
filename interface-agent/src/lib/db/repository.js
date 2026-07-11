import { randomUUID } from 'node:crypto';
import {
  VersionNotInSessionError,
  branchNumbering,
  compareLabelPath,
  mainlineNumbering,
  parseLabelPath,
  rootNumbering,
} from './numbering.js';

/**
 * Thrown inside confirmVersion when the session's current confirmed_version_id
 * does not match the caller's expectedConfirmedVersionId (optimistic concurrency
 * conflict). The route maps it to HTTP 409 with { currentConfirmedVersionId,
 * rowVersion }. It must NEVER be silently overwritten (spec §API line 125).
 */
export class ConfirmConflictError extends Error {
  constructor(currentConfirmedVersionId, rowVersion) {
    super('confirm version conflict');
    this.name = 'ConfirmConflictError';
    this.currentConfirmedVersionId = currentConfirmedVersionId;
    this.rowVersion = rowVersion;
  }
}

/**
 * Repository boundary for the interface-agent versioning feature.
 *
 * T1 shipped the transaction helper and a minimal session accessor pair. T2
 * adds version-numbering (atomic commit, ancestor projection, cross-session
 * guards, version-tree retrieval) on the same seam. The raw better-sqlite3
 * handle stays exposed for migrations and ad-hoc queries during bring-up;
 * production code should grow dedicated methods here instead of scattering SQL
 * across routes.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createRepository(db) {
  /**
   * Run `fn` inside a transaction: commit on normal return, roll back on
   * throw. better-sqlite3 transactions are synchronous and reentrant
   * (nested calls become SAVEPOINTs), so `tx` can wrap other `tx` callers.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function tx(fn) {
    return db.transaction(fn)();
  }

  /** Insert a new active design session. Throws on UNIQUE violation. */
  function createSession({ id, projectKey, createdAt, mainlineHeadVersionId = null }) {
    db.prepare(
      `INSERT INTO interface_design_sessions
        (id, project_key, status, mainline_head_version_id, row_version, created_at, updated_at)
       VALUES (?, ?, 'active', ?, 0, ?, ?)`,
    ).run(id, projectKey, mainlineHeadVersionId, createdAt, createdAt);
    return getSession(id);
  }

  function getSession(id) {
    return db
      .prepare(`SELECT * FROM interface_design_sessions WHERE id = ?`)
      .get(id);
  }

  // ---------------------------------------------------------------- versions

  function getVersion(versionId) {
    return db
      .prepare(`SELECT * FROM interface_draft_versions WHERE id = ?`)
      .get(versionId);
  }

  /**
   * Cross-session guard: a version referenced as parent / base / confirm
   * target must exist AND belong to the session performing the write.
   * Throws VersionNotInSessionError otherwise. Returns the version row on
   * success so callers can chain without a second read.
   */
  function assertVersionInSession(versionId, sessionId) {
    const version = getVersion(versionId);
    if (!version || version.session_id !== sessionId) {
      throw new VersionNotInSessionError(versionId, sessionId);
    }
    return version;
  }

  function maxBranchSequenceUnder(parentVersionId) {
    const row = db
      .prepare(
        `SELECT MAX(branch_sequence) AS m
         FROM interface_draft_versions
         WHERE parent_version_id = ?`,
      )
      .get(parentVersionId);
    return row?.m ?? null;
  }

  const insertVersionStmt = db.prepare(
    `INSERT INTO interface_draft_versions
       (id, session_id, parent_version_id, version_label, mainline_sequence,
        branch_sequence, label_path_json, title, generation_request_id,
        source_version_id, artifact_path, content_hash, byte_size, created_at,
        created_by)
     VALUES (@id, @sessionId, @parentVersionId, @versionLabel,
             @mainlineSequence, @branchSequence, @labelPathJson, @title,
             @generationRequestId, @sourceVersionId, @artifactPath,
             @contentHash, @byteSize, @createdAt, @createdBy)`,
  );

  function insertVersion(cols) {
    insertVersionStmt.run(cols);
  }

  function setMainlineHead(sessionId, versionId, updatedAt) {
    db.prepare(
      `UPDATE interface_design_sessions
         SET mainline_head_version_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(versionId, updatedAt, sessionId);
  }

  /**
   * Atomically commit a new version under a session.
   *
   * All numbering decisions (root / mainline advance / branch) and the head
   * update happen inside one synchronous `tx`, serialised by SQLite's write
   * lock. The mainline head is re-read WITHIN the tx (never cached outside),
   * so two commits racing on the same head are naturally ordered: the first
   * advances the mainline and moves head forward; the second re-reads head,
   * finds its base no longer equals head, and becomes a branch of the original
   * baseline. No version is ever left half-written — any error rolls the whole
   * tx back (numbering, head, artifact link).
   *
   * Event emission is intentionally deferred to the events task; T2 owns only
   * numbering + projection + guards.
   *
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string | null} args.parentVersionId - null for the root version
   * @param {string} [args.id] - version id; generated when omitted
   * @param {string | null} [args.generationRequestId]
   * @param {string | null} [args.sourceVersionId] - legacy/import provenance only
   * @param {string} args.artifactPath
   * @param {string} args.contentHash
   * @param {number | null} [args.byteSize]
   * @param {string | null} [args.title]
   * @param {string | null} [args.createdBy]
   * @returns {object} the committed version row
   */
  function commitVersion({
    sessionId,
    parentVersionId,
    id,
    generationRequestId = null,
    sourceVersionId = null,
    artifactPath,
    contentHash,
    byteSize = null,
    title = null,
    createdBy = null,
  }) {
    return tx(() => {
      const now = new Date().toISOString();
      const versionId = id ?? randomUUID();

      const session = getSession(sessionId);
      if (!session) {
        throw new Error(`commitVersion: 会话 ${sessionId} 不存在`);
      }
      const headId = session.mainline_head_version_id;

      let numbering;
      if (parentVersionId == null) {
        numbering = rootNumbering();
      } else {
        // Cross-session guard: the parent must belong to THIS session. This
        // also rejects references to a missing version (undefined row).
        const parent = assertVersionInSession(parentVersionId, sessionId);
        numbering =
          parentVersionId === headId
            ? mainlineNumbering(parent)
            : branchNumbering(parent, maxBranchSequenceUnder(parentVersionId));
      }

      insertVersion({
        id: versionId,
        sessionId,
        parentVersionId: parentVersionId ?? null,
        versionLabel: numbering.versionLabel,
        mainlineSequence: numbering.mainlineSequence,
        branchSequence: numbering.branchSequence,
        labelPathJson: JSON.stringify(numbering.labelPath),
        title,
        generationRequestId,
        sourceVersionId,
        artifactPath,
        contentHash,
        byteSize,
        createdAt: now,
        createdBy,
      });

      // Only a root commit or a mainline advance moves the head. Branches
      // never touch it (history edits stay off the mainline).
      if (parentVersionId == null || parentVersionId === headId) {
        setMainlineHead(sessionId, versionId, now);
      }

      return getVersion(versionId);
    });
  }

  /**
   * Root -> current ancestor chain (inclusive of the given version). Walks
   * parent_version_id up to the root then reverses so callers always see
   * chronological order. Returns [] for an unknown id.
   *
   * @param {string} versionId
   * @returns {object[]}
   */
  function getAncestorChain(versionId) {
    const chain = [];
    let current = getVersion(versionId);
    while (current) {
      chain.push(current);
      current = current.parent_version_id
        ? getVersion(current.parent_version_id)
        : null;
    }
    return chain.reverse();
  }

  /**
   * Project the model context for a version: the instructions of its ancestor
   * chain only (root -> current), in order. Per 领域规则 8 this NEVER includes
   * siblings or descendants — walking parent_version_id excludes them by
   * construction. Versions without a generation request (e.g. legacy root
   * imports) contribute nothing and are silently skipped.
   *
   * @param {string} versionId
   * @returns {string[]}
   */
  function getBranchInstructions(versionId) {
    const instructionStmt = db.prepare(
      `SELECT instruction FROM interface_generation_requests WHERE id = ?`,
    );
    const instructions = [];
    for (const version of getAncestorChain(versionId)) {
      if (!version.generation_request_id) continue;
      const request = instructionStmt.get(version.generation_request_id);
      if (request && request.instruction != null) {
        instructions.push(request.instruction);
      }
    }
    return instructions;
  }

  /**
   * All versions of a session sorted by structured label_path (numeric per
   * segment) with created_at as the tie-break, so the tree is presented in a
   * strict, stable order rather than string lex order (where V10 < V2).
   *
   * @param {string} sessionId
   * @returns {object[]}
   */
  function getVersionTree(sessionId) {
    const rows = db
      .prepare(
        `SELECT * FROM interface_draft_versions WHERE session_id = ?`,
      )
      .all(sessionId);
    return rows
      .map((row) => ({ row, path: parseLabelPath(row.label_path_json) }))
      .sort((a, b) => {
        const byPath = compareLabelPath(a.path, b.path);
        if (byPath !== 0) return byPath;
        if (a.row.created_at < b.row.created_at) return -1;
        if (a.row.created_at > b.row.created_at) return 1;
        return 0;
      })
      .map((entry) => entry.row);
  }

  // ------------------------------------------------------------- sessions T4

  /**
   * At most one active session per project_key (partial unique index
   * idx_sessions_active_project). Returns the row or undefined.
   */
  function getActiveSessionByProjectKey(projectKey) {
    return db
      .prepare(
        `SELECT * FROM interface_design_sessions
         WHERE project_key = ? AND status = 'active'`,
      )
      .get(projectKey);
  }

  /**
   * F7: list all active sessions that have an edit-token hash, for the restore
   * endpoint (POST /api/auth/restore). The edit-token hash is scrypt-salted, so
   * it cannot be queried by value; the route verifies each candidate. Bounded by
   * the at-most-one-active-session-per-project invariant. Returns minimal
   * projection { id, edit_token_hash } — no other secrets.
   */
  function listActiveSessionsWithEditToken() {
    return db
      .prepare(
        `SELECT id, edit_token_hash FROM interface_design_sessions
         WHERE status = 'active' AND edit_token_hash IS NOT NULL`,
      )
      .all();
  }

  /** Archive a session (status -> 'archived', set archived_at). Preserves versions. */
  function archiveSession(sessionId) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE interface_design_sessions
         SET status = 'archived', archived_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, sessionId);
    return getSession(sessionId);
  }

  /** Create a session with a pre-set edit-token hash (T4 resolve/restart). */
  function createSessionWithToken({ id, projectKey, createdAt, editTokenHash }) {
    db.prepare(
      `INSERT INTO interface_design_sessions
        (id, project_key, status, mainline_head_version_id, row_version,
         created_at, updated_at, edit_token_hash, edit_token_set_at)
       VALUES (?, ?, 'active', NULL, 0, ?, ?, ?, ?)`,
    ).run(id, projectKey, createdAt, createdAt, editTokenHash, createdAt);
    return getSession(id);
  }

  function countVersions(sessionId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM interface_draft_versions WHERE session_id = ?`,
      )
      .get(sessionId);
    return row?.n ?? 0;
  }

  /** Delivery status -> count for the session summary endpoint. */
  function getDeliveryCounts(sessionId) {
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS n
         FROM interface_deliveries
         WHERE session_id = ?
         GROUP BY status`,
      )
      .all(sessionId);
    const counts = { pending: 0, delivering: 0, delivered: 0, failed: 0, superseded: 0 };
    for (const row of rows) {
      if (counts[row.status] !== undefined) counts[row.status] = row.n;
    }
    return counts;
  }

  // ----------------------------------------------------- generation requests

  /**
   * Insert a new generation request (status='queued'). Callers must check
   * findGenerationRequestByIdempotency first; the UNIQUE(session_id,
   * idempotency_key) index is the race-free safety net for concurrent POSTs.
   */
  function createGenerationRequest({
    id,
    sessionId,
    baseVersionId,
    idempotencyKey,
    instruction,
    createdBy = null,
  }) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO interface_generation_requests
        (id, session_id, base_version_id, idempotency_key, instruction, status,
         created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(id, sessionId, baseVersionId ?? null, idempotencyKey, instruction, now, createdBy);
    return getGenerationRequest(id);
  }

  function getGenerationRequest(requestId) {
    return db
      .prepare(`SELECT * FROM interface_generation_requests WHERE id = ?`)
      .get(requestId);
  }

  function findGenerationRequestByIdempotency(sessionId, idempotencyKey) {
    return db
      .prepare(
        `SELECT * FROM interface_generation_requests
         WHERE session_id = ? AND idempotency_key = ?`,
      )
      .get(sessionId, idempotencyKey);
  }

  function listGenerationRequests(sessionId) {
    return db
      .prepare(
        `SELECT * FROM interface_generation_requests
         WHERE session_id = ?
         ORDER BY created_at DESC`,
      )
      .all(sessionId);
  }

  /**
   * Slim projection of a session's generation requests for the version-tree /
   * detail routes: just id, instruction, status. Used to project an instruction
   * summary + generation status onto version metadata WITHOUT routes reaching
   * past the repository boundary into raw SQL (routes must not touch `db`).
   * Order is unspecified; callers index by id.
   *
   * @param {string} sessionId
   * @returns {{ id: string, instruction: string, status: string }[]}
   */
  function listGenerationRequestMetaBySession(sessionId) {
    return db
      .prepare(
        `SELECT id, instruction, status FROM interface_generation_requests
         WHERE session_id = ?`,
      )
      .all(sessionId);
  }

  /**
   * Atomically claim a queued request: UPDATE only if status is still 'queued'.
   * Returns true if this caller won the claim (changes === 1), false if the
   * request was already claimed by another worker tick. The WHERE-status guard
   * makes this safe under concurrent workers without explicit row locks.
   */
  function claimGenerationRequest(requestId) {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE interface_generation_requests
           SET status = 'generating', started_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, requestId);
    return result.changes === 1;
  }

  /** Oldest queued request (FIFO). Returns undefined when none. */
  function findNextQueuedRequest() {
    return db
      .prepare(
        `SELECT * FROM interface_generation_requests
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get();
  }

  /**
   * F6: transition a request from 'generating' → 'saving' (guarded). Called by
   * the worker right before the upload + readback + hash-verify step, after the
   * model has returned and staged_html is persisted. Restart recovery treats
   * 'saving' exactly like 'generating' (re-queue, resume from staged_html).
   * Returns true if the row transitioned.
   */
  function markGenerationSaving(requestId) {
    const result = db
      .prepare(
        `UPDATE interface_generation_requests
           SET status = 'saving'
         WHERE id = ? AND status = 'generating'`,
      )
      .run(requestId);
    return result.changes === 1;
  }

  /**
   * Restart recovery: reset all in-flight requests ('generating' AND 'saving',
   * F6) back to 'queued'. Called once at worker start so requests orphaned by a
   * crash are re-processed. A request with staged_html resumes from it (no
   * duplicate model call); otherwise it re-runs from scratch. commitVersion +
   * request idempotency guarantee at most one version is ever produced.
   * Returns the number of reset rows.
   */
  function resetGeneratingToQueued() {
    return db
      .prepare(
        `UPDATE interface_generation_requests
           SET status = 'queued', started_at = NULL
         WHERE status IN ('generating', 'saving')`,
      )
      .run().changes;
  }

  /** Mark a request succeeded and link the resulting version. */
  function completeGenerationRequest(requestId, versionId) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE interface_generation_requests
         SET status = 'succeeded', result_version_id = ?, finished_at = ?,
             staged_html = NULL, staged_at = NULL
       WHERE id = ?`,
    ).run(versionId, now, requestId);
  }

  /** Mark a request failed with a sanitized error code + message. */
  function failGenerationRequest(requestId, errorCode, errorMessage) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE interface_generation_requests
         SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?,
             staged_html = NULL, staged_at = NULL
       WHERE id = ?`,
    ).run(errorCode, errorMessage, now, requestId);
  }

  /**
   * Sp5: persist the model's HTML output (staged) immediately after a successful
   * model call, before validation/write/commit. On restart resume, if staged_html
   * is present the worker skips the model call and proceeds from the staged HTML
   * — honoring "no duplicate model call" across restart.
   */
  function setStagedHtml(requestId, html) {
    db.prepare(
      `UPDATE interface_generation_requests
         SET staged_html = ?, staged_at = ?
       WHERE id = ?`,
    ).run(html, new Date().toISOString(), requestId);
  }

  /** Sp5: clear staged_html (called on terminal status to save space). */
  function clearStagedHtml(requestId) {
    db.prepare(
      `UPDATE interface_generation_requests
         SET staged_html = NULL, staged_at = NULL
       WHERE id = ?`,
    ).run(requestId);
  }

  // ------------------------------------------------------------- versions T6

  /**
   * Rich branch dialogue for the version-detail endpoint (T6). Walks the
   * ancestor chain (root -> given version, reusing getAncestorChain) and joins
   * each version's generation_request instruction. Per 领域规则 8 this NEVER
   * includes siblings or descendants. Versions without a generation request
   * (e.g. legacy root imports) contribute a null instruction but still appear
   * so the dialogue shows every step on the branch.
   *
   * @param {string} versionId
   * @returns {{ versionLabel: string, instruction: string | null, createdAt: string }[]}
   */
  function getBranchDialogue(versionId) {
    const instructionStmt = db.prepare(
      `SELECT instruction FROM interface_generation_requests WHERE id = ?`,
    );
    return getAncestorChain(versionId).map((version) => {
      let instruction = null;
      if (version.generation_request_id) {
        const request = instructionStmt.get(version.generation_request_id);
        if (request && request.instruction != null) {
          instruction = request.instruction;
        }
      }
      return {
        versionLabel: version.version_label,
        instruction,
        createdAt: version.created_at,
      };
    });
  }

  /**
   * Editable metadata for a version: title (in place, no new version) and the
   * archive flag (set/clear archived_at). Version label + HTML stay immutable
   * (领域规则 5). Both return the refreshed row.
   */
  function updateVersionTitle(versionId, title) {
    db.prepare(`UPDATE interface_draft_versions SET title = ? WHERE id = ?`).run(
      title,
      versionId,
    );
    return getVersion(versionId);
  }

  function setVersionArchived(versionId, archived) {
    if (archived) {
      db.prepare(
        `UPDATE interface_draft_versions SET archived_at = ? WHERE id = ? AND archived_at IS NULL`,
      ).run(new Date().toISOString(), versionId);
    } else {
      db.prepare(
        `UPDATE interface_draft_versions SET archived_at = NULL WHERE id = ?`,
      ).run(versionId);
    }
    return getVersion(versionId);
  }

  // --------------------------------------------------------- settings + events

  /**
   * Distinct project_key values across all sessions (incl. archived). Used by
   * the orphan-artifact cleanup to know which project subtrees to scan under
   * <base>/<projectname>/interface-sessions/. Deleted sessions are excluded so
   * a session-delete (which clears its own versions) eventually lets stale
   * dirs be reclaimed too — but cleanup still cross-checks the artifact_path
   * against ALL version rows, so a soft-deleted session's still-referenced
   * artifacts are never removed.
   */
  function listDistinctProjectKeys() {
    return db
      .prepare(
        `SELECT DISTINCT project_key AS key
         FROM interface_design_sessions
         WHERE status != 'deleted' AND project_key != ''`,
      )
      .all()
      .map((r) => r.key);
  }

  /**
   * Does any version row reference this exact artifact_path? Used by cleanup
   * to distinguish a real version (keep) from an orphan left by a failed
   * SQLite commit after a successful Blade OS write (reclaim). The path is the
   * full relative path stored in artifact_path (e.g.
   * "共享/demo/interface-sessions/<sid>/versions/<vid>/prototype.html").
   */
  function hasVersionWithArtifactPath(artifactPath) {
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM interface_draft_versions WHERE artifact_path = ? LIMIT 1`,
      )
      .get(artifactPath);
    return Boolean(row);
  }

  function getSetting(key) {
    const row = db
      .prepare(`SELECT value FROM interface_app_settings WHERE key = ?`)
      .get(key);
    return row?.value ?? null;
  }

  function setSetting(key, value) {
    db.prepare(
      `INSERT INTO interface_app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  function insertEvent({ sessionId, type, payload = null, createdBy = null }) {
    const seqRow = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
         FROM interface_session_events WHERE session_id = ?`,
      )
      .get(sessionId);
    const seq = (seqRow?.max_seq ?? 0) + 1;
    db.prepare(
      `INSERT INTO interface_session_events
        (id, session_id, seq, type, payload_json, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      sessionId,
      seq,
      type,
      payload ? JSON.stringify(payload) : null,
      new Date().toISOString(),
      createdBy,
    );
  }

  /**
   * All events for a session in ascending seq order (T6 events endpoint). Raw
   * rows — the route layer is responsible for sanitizing payload_json into a
   * safe summary so internal paths / accidental sensitive fields never reach
   * the API response.
   */
  function listEvents(sessionId) {
    return db
      .prepare(
        `SELECT seq, type, payload_json, created_at, created_by
         FROM interface_session_events
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(sessionId);
  }

  // ----------------------------------------------------- T7 shares
  // The route layer hashes the plaintext token (sha256 of a 256-bit random
  // value) and only the hash ever reaches the DB. The plaintext is returned to
  // the caller exactly once at creation time; there is no way to recover it.

  function createShare({ id, sessionId, versionId, tokenHash, createdBy, expiresAt }) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO interface_shares
        (id, session_id, version_id, token_hash, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, versionId, tokenHash, createdBy ?? null, now, expiresAt ?? null);
    return getShare(id);
  }

  function getShare(shareId) {
    return db.prepare(`SELECT * FROM interface_shares WHERE id = ?`).get(shareId);
  }

  function getShareByTokenHash(tokenHash) {
    return db
      .prepare(`SELECT * FROM interface_shares WHERE token_hash = ?`)
      .get(tokenHash);
  }

  function listSharesBySession(sessionId) {
    return db
      .prepare(
        `SELECT * FROM interface_shares WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId);
  }

  /**
   * Revoke a share (idempotent: setting revoked_at again is a no-op write).
   * Returns the refreshed row. Ownership is enforced by the route before this
   * call (share.session_id === req.session.id).
   */
  function revokeShare(shareId) {
    const existing = getShare(shareId);
    if (!existing) return null;
    if (!existing.revoked_at) {
      db.prepare(`UPDATE interface_shares SET revoked_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        shareId,
      );
    }
    return getShare(shareId);
  }

  // ------------------------------------------------ T7 confirmations
  /**
   * Atomically confirm a version under optimistic concurrency (spec §确认与交付流程).
   *
   * Inside ONE synchronous tx (holds SQLite's write lock):
   *   1. SELECT confirmed_version_id, row_version (re-read WITHIN the tx — never
   *      trust a stale outside read). If confirmed_version_id !== expected →
   *      throw ConfirmConflictError (mapped to 409; never silent overwrite).
   *   2. UPDATE sessions SET confirmed_version_id=?, row_version=row_version+1.
   *   3. Supersede ALL unfinished deliveries (pending/delivering/failed) for
   *      the session → status='superseded', superseded_by_delivery_id=<new>.
   *      The worker only claims status='pending', so superseded ones are never
   *      processed; a delivery mid-flight has its success tx guarded on
   *      status='delivering' (see completeDelivery).
   *   4. Create a new pending delivery with a deterministic idempotency key
   *      `confirm-<sessionId>-<newRowVersion>` so each confirm is uniquely keyed
   *      and the pipeline can dedupe retries.
   *   5. Emit a confirm event (sanitized at the route layer).
   *
   * versionId ownership is asserted by the route BEFORE this call. Delivery
   * failure later never undoes the confirm (delivery status is independent).
   *
   * @returns {{ confirmedVersionId: string, rowVersion: number, delivery: { id: string, status: string, idempotencyKey: string } }}
   */
  function confirmVersion({ sessionId, versionId, expectedConfirmedVersionId }) {
    return tx(() => {
      const session = getSession(sessionId);
      if (!session) {
        throw new Error(`confirmVersion: 会话 ${sessionId} 不存在`);
      }

      // Optimistic concurrency: compare against the row read INSIDE this tx.
      const current = session.confirmed_version_id; // null when no confirmation yet
      if (current !== expectedConfirmedVersionId) {
        throw new ConfirmConflictError(current, session.row_version);
      }

      const now = new Date().toISOString();
      const newRowVersion = session.row_version + 1;

      db.prepare(
        `UPDATE interface_design_sessions
           SET confirmed_version_id = ?, row_version = ?, updated_at = ?
         WHERE id = ?`,
      ).run(versionId, newRowVersion, now, sessionId);

      // Create the new delivery id first so superseded rows can reference it.
      const newDeliveryId = randomUUID();
      const idempotencyKey = `confirm-${sessionId}-${newRowVersion}`;

      // Insert the NEW delivery BEFORE the supersede UPDATE: the
      // superseded_by_delivery_id self-FK is non-deferrable, so it checks
      // immediately and would reject a forward reference to a not-yet-inserted
      // row. The supersede then excludes the new row (id != ?) so it stays
      // pending while all OTHER unfinished deliveries flip to superseded.
      db.prepare(
        `INSERT INTO interface_deliveries
          (id, session_id, version_id, status, attempts, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).run(newDeliveryId, sessionId, versionId, idempotencyKey, now, now);

      db.prepare(
        `UPDATE interface_deliveries
           SET status = 'superseded', superseded_by_delivery_id = ?, updated_at = ?
         WHERE session_id = ? AND id != ? AND status IN ('pending','delivering','failed')`,
      ).run(newDeliveryId, now, sessionId, newDeliveryId);

      insertEvent({
        sessionId,
        type: 'confirm',
        payload: { versionId, versionLabel: getVersion(versionId)?.version_label || null },
        createdBy: sessionId,
      });

      return {
        confirmedVersionId: versionId,
        rowVersion: newRowVersion,
        delivery: { id: newDeliveryId, status: 'pending', idempotencyKey },
      };
    });
  }

  // ------------------------------------------------ T7 deliveries
  /**
   * Atomic claim: UPDATE only if status is still 'pending'. Returns true if
   * this caller won the claim, false otherwise. The WHERE-status guard makes
   * this safe under a concurrent worker without explicit row locks. Mirrors
   * claimGenerationRequest.
   */
  function claimDelivery(deliveryId) {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE interface_deliveries
           SET status = 'delivering', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, deliveryId);
    return result.changes === 1;
  }

  function findNextPendingDelivery() {
    return db
      .prepare(
        `SELECT * FROM interface_deliveries
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get();
  }

  function getDelivery(deliveryId) {
    return db
      .prepare(`SELECT * FROM interface_deliveries WHERE id = ?`)
      .get(deliveryId);
  }

  /**
   * M2: mark that the pipeline was successfully notified for this delivery
   * (guarded WHERE status='delivering' AND notified_at IS NULL). Called right
   * after a successful pipeline HTTP, BEFORE the delivered tx. On restart
   * recovery a delivery with notified_at set is NOT re-notified (skips straight
   * to delivered), closing the crash-after-notify-before-delivered window.
   * Returns true if the row was newly marked.
   */
  function markDeliveryNotified(deliveryId) {
    const result = db
      .prepare(
        `UPDATE interface_deliveries
           SET notified_at = ?
         WHERE id = ? AND status = 'delivering' AND notified_at IS NULL`,
      )
      .run(new Date().toISOString(), deliveryId);
    return result.changes === 1;
  }

  /**
   * Complete a delivery (success tx), guarded on status='delivering'. If the
   * delivery was superseded mid-flight (a new confirm ran while the worker was
   * doing IO outside the tx), this affects 0 rows and returns false — the
   * caller must then NOT emit a delivered event. This is the race fix: a
   * superseded delivery can never flip back to 'delivered'.
   */
  function completeDelivery(deliveryId) {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE interface_deliveries
           SET status = 'delivered', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'delivering'`,
      )
      .run(now, deliveryId);
    return result.changes === 1;
  }

  /**
   * Mark a delivery failed with a sanitized error code + message. Guarded on
   * status='delivering' so a superseded-mid-flight delivery is not flipped to
   * failed either. Confirm is never undone by this (confirmed_version_id is
   * untouched). Returns true if the row transitioned.
   */
  function failDelivery(deliveryId, errorCode, errorMessage) {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE interface_deliveries
           SET status = 'failed', error_code = ?, error_message = ?,
               attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'delivering'`,
      )
      .run(errorCode, errorMessage, now, deliveryId);
    return result.changes === 1;
  }

  /**
   * Restart recovery: reset all 'delivering' deliveries back to 'pending'.
   * Called once at worker start so deliveries orphaned by a crash are
   * re-processed. A delivery that re-runs does IO again, but the idempotency
   * key on the pipeline call + the status machine guarantee at most one
   * successful push is recorded. Returns the number of reset rows.
   */
  function resetDeliveringToPending() {
    return db
      .prepare(
        `UPDATE interface_deliveries
           SET status = 'pending', updated_at = ?
         WHERE status = 'delivering'`,
      )
      .run(new Date().toISOString()).changes;
  }

  /**
   * Retry: only failed → pending (guarded). Delivered / superseded / pending /
   * delivering are no-ops (idempotent: they return the current row unchanged
   * so the caller reports status without re-triggering the worker). Returns
   * the refreshed delivery row.
   */
  function retryDelivery(deliveryId) {
    const existing = getDelivery(deliveryId);
    if (!existing) return null;
    if (existing.status === 'failed') {
      db.prepare(
        `UPDATE interface_deliveries
           SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed'`,
      ).run(new Date().toISOString(), deliveryId);
    }
    return getDelivery(deliveryId);
  }

  function listDeliveriesBySession(sessionId) {
    return db
      .prepare(
        `SELECT * FROM interface_deliveries WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId);
  }

  return {
    db,
    tx,
    createSession,
    getSession,
    getVersion,
    assertVersionInSession,
    commitVersion,
    getAncestorChain,
    getBranchInstructions,
    getVersionTree,
    // T6 version detail / metadata edits / events
    getBranchDialogue,
    updateVersionTitle,
    setVersionArchived,
    listEvents,
    // T4 session + settings + events
    getActiveSessionByProjectKey,
    listActiveSessionsWithEditToken,
    archiveSession,
    createSessionWithToken,
    countVersions,
    getDeliveryCounts,
    // T8 orphan-artifact cleanup support
    listDistinctProjectKeys,
    hasVersionWithArtifactPath,
    getSetting,
    setSetting,
    insertEvent,
    // T5 generation requests
    createGenerationRequest,
    getGenerationRequest,
    findGenerationRequestByIdempotency,
    listGenerationRequests,
    listGenerationRequestMetaBySession,
    claimGenerationRequest,
    findNextQueuedRequest,
    markGenerationSaving,
    resetGeneratingToQueued,
    completeGenerationRequest,
    failGenerationRequest,
    setStagedHtml,
    clearStagedHtml,
    // T7 shares
    createShare,
    getShare,
    getShareByTokenHash,
    listSharesBySession,
    revokeShare,
    // T7 confirmations
    confirmVersion,
    // T7 deliveries
    claimDelivery,
    findNextPendingDelivery,
    getDelivery,
    markDeliveryNotified,
    completeDelivery,
    failDelivery,
    resetDeliveringToPending,
    retryDelivery,
    listDeliveriesBySession,
  };
}
