import crypto from 'node:crypto';

/**
 * One-time start codes that bridge the long-lived edit token (held server-side
 * by agent-pipeline) to a browser HttpOnly session cookie (spec §访问控制).
 *
 * Flow:
 *   1. agent-pipeline, holding the plaintext edit token, calls
 *      `POST /api/auth/start-code` with { sessionId, editToken }. The server
 *      verifies the token against `interface_design_sessions.edit_token_hash`
 *      (scrypt, see editToken.js) and returns a fresh one-time code.
 *   2. The browser is pointed at the interface-agent with the code in a URL
 *      query param; the page calls `POST /api/auth/exchange` { startCode }.
 *      `consumeStartCode` atomically marks the code used inside one transaction
 *      (so two concurrent exchanges can't both succeed) and the response sets a
 *      signed HttpOnly cookie. The page then strips the code from the URL.
 *
 * Storage: only the SHA-256 of the code is persisted. The code is 192 bits of
 * randomness, so a dictionary attack is infeasible and a deterministic hash
 * (no salt) is acceptable — and necessary, because consume must look the row up
 * by `WHERE code_hash = ?`.
 */

const DEFAULT_TTL_MS = 90_000; // 90s, within the spec's 60-120s window

/**
 * @returns {string} a fresh high-entropy one-time code (base64url, 24 bytes)
 */
export function generateStartCode() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Deterministic SHA-256 of a start code. Determinism is required so the row can
 * be found by hash during consume; the code's own entropy provides the
 * brute-force resistance that a per-row salt would otherwise add.
 *
 * @param {string} code
 * @returns {string} lowercase hex digest
 */
export function hashStartCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

const insertStartCodeStmt = (db) =>
  db.prepare(
    `INSERT INTO interface_start_codes
       (id, session_id, code_hash, expires_at, used_at, created_at)
     VALUES (@id, @sessionId, @codeHash, @expiresAt, NULL, @createdAt)`,
  );

/**
 * Mint a one-time code for a session and persist only its hash. The plaintext
 * code is returned to the caller exactly once (to build the browser URL) and is
 * never stored or logged.
 *
 * @param {{ db: import('better-sqlite3').Database, tx: (fn: () => unknown) => unknown }} repository
 * @param {string} sessionId
 * @param {{ ttlMs?: number }} [opts]
 * @returns {{ startCode: string, expiresAt: string }}
 */
export function issueStartCode(repository, sessionId, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!sessionId) throw new Error('issueStartCode: sessionId is required');
  const code = generateStartCode();
  const codeHash = hashStartCode(code);
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();

  insertStartCodeStmt(repository.db).run({
    id: crypto.randomUUID(),
    sessionId,
    codeHash,
    expiresAt,
    createdAt: new Date(now).toISOString(),
  });

  return { startCode: code, expiresAt };
}

/**
 * Consume (atomically, one-time) a start code and resolve it to a session id.
 *
 * Validation and the `used_at` mutation happen inside a single synchronous
 * `repository.tx`. On a second call with the same code, the SELECT finds
 * `used_at` already set and returns null. The UPDATE additionally carries
 * `WHERE used_at IS NULL` and its `changes()` is checked, so even under a
 * future multi-writer setup a code can only ever be consumed once.
 *
 * @param {{ db: import('better-sqlite3').Database, tx: (fn: () => unknown) => unknown }} repository
 * @param {string} code
 * @returns {{ sessionId: string } | null}
 */
export function consumeStartCode(repository, code) {
  if (!code || typeof code !== 'string') return null;
  const codeHash = hashStartCode(code);

  return repository.tx(() => {
    const row = repository.db
      .prepare(
        `SELECT id, session_id, expires_at, used_at
         FROM interface_start_codes
         WHERE code_hash = ?`,
      )
      .get(codeHash);
    if (!row) return null;
    if (row.used_at !== null) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;

    const result = repository.db
      .prepare(`UPDATE interface_start_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`)
      .run(new Date().toISOString(), row.id);

    // changes() === 0 means a concurrent consumer won the race inside this tx
    // window — treat as already consumed.
    if (result.changes !== 1) return null;
    return { sessionId: row.session_id };
  });
}
