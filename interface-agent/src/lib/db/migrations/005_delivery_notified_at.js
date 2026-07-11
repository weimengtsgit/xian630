/**
 * Migration 005 — durable pipeline-notify tracking (M2 mitigation).
 *
 * Exactly-once pipeline notification is impossible without the DOWNSTREAM
 * durably deduping on X-Idempotency-Key. interface-agent guarantees at-least-
 * once + a STABLE per-delivery key. This migration closes the crash-after-notify-
 * before-delivered window: the worker sets `notified_at` (guarded tx) right
 * after a successful pipeline HTTP, BEFORE the `delivered` tx. On restart
 * recovery, a delivery with `notified_at` set is NOT re-notified (it skips
 * straight to marking delivered). (Residual: crash DURING the HTTP itself →
 * at-least-once with the same stable key → downstream must dedup.)
 *
 * Idempotent: ALTER TABLE ADD COLUMN is guarded by a column-existence check.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  const cols = db
    .prepare(`PRAGMA table_info(interface_deliveries)`)
    .all()
    .map((r) => r.name);
  if (!cols.includes('notified_at')) {
    db.exec(`ALTER TABLE interface_deliveries ADD COLUMN notified_at TEXT;`);
  }
}
