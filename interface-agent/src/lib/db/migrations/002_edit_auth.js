/**
 * Migration 002 — session edit credentials + one-time start codes.
 *
 * Adds the edit-token hash columns omitted from 001's data-model section but
 * required by spec §访问控制: each active session stores ONLY the scrypt hash
 * of its high-entropy edit token (never the plaintext). A new
 * `interface_start_codes` table backs the one-time codes that agent-pipeline
 * exchanges (via the browser) for an HttpOnly session cookie, so the long
 * edit token never rides in URLs / Referer / logs.
 *
 * Start codes are also stored only as hashes. They are 192-bit random values,
 * so a deterministic SHA-256 (no salt) is sufficient and — crucially — lets
 * `consumeStartCode` look the row up by `WHERE code_hash = ?` within the
 * consume transaction.
 *
 * Idempotent: guarded objects use IF NOT EXISTS; the ALTER COLUMNs run once
 * because runMigrations only applies a migration whose version is not yet in
 * `schema_migrations`.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  // edit_token_hash is nullable: legacy sessions (and a freshly created session
  // before T4's resolve mints a token) have no credential yet.
  db.exec(`
    ALTER TABLE interface_design_sessions ADD COLUMN edit_token_hash TEXT;
    ALTER TABLE interface_design_sessions ADD COLUMN edit_token_set_at TEXT;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS interface_start_codes (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL
                    REFERENCES interface_design_sessions(id) ON DELETE CASCADE,
      code_hash   TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_start_codes_hash
      ON interface_start_codes(code_hash);
    CREATE INDEX IF NOT EXISTS idx_start_codes_session
      ON interface_start_codes(session_id);
  `);
}
