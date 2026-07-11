/**
 * Migration 004 — staged model output for restart-safe generation resume.
 *
 * Spec: the same idempotent generation request must NOT re-call the model across
 * a restart. Previously `resetGeneratingToQueued` re-queued a mid-flight
 * 'generating' request and the worker re-ran the whole flow (including the
 * DeepSeek call) on the second attempt.
 *
 * This adds `staged_html` (+ `staged_at`) to `interface_generation_requests`.
 * The worker persists the model's HTML output there immediately after a
 * successful model call (before validation/write/commit). On restart resume, if
 * `staged_html` is already present the worker SKIPS the model call and proceeds
 * straight to validate + write + commit using the staged HTML — honoring "no
 * duplicate model call" across restart. The column is cleared on terminal status.
 *
 * Idempotent: ALTER TABLE ADD COLUMN is guarded by a column-existence check
 * (SQLite lacks IF NOT EXISTS for ADD COLUMN).
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  const cols = db
    .prepare(`PRAGMA table_info(interface_generation_requests)`)
    .all()
    .map((r) => r.name);
  if (!cols.includes('staged_html')) {
    db.exec(`ALTER TABLE interface_generation_requests ADD COLUMN staged_html TEXT;`);
  }
  if (!cols.includes('staged_at')) {
    db.exec(`ALTER TABLE interface_generation_requests ADD COLUMN staged_at TEXT;`);
  }
}
