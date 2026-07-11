/**
 * Migration 003 — global application settings table.
 *
 * Backs the global-once legacy-import gate (spec §旧数据迁移): after any
 * successful legacy import sets `legacy_migration_done = 'true'`, no other
 * project's session re-offers the import prompt. Stored as a simple key/value
 * pair so future global flags reuse the same table without a new migration.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interface_app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO interface_app_settings (key, value)
      VALUES ('legacy_migration_done', 'false');
  `);
}
