import { up as initialUp } from './001_initial.js';
import { up as editAuthUp } from './002_edit_auth.js';
import { up as appSettingsUp } from './003_app_settings.js';
import { up as stagedHtmlUp } from './004_staged_html.js';
import { up as deliveryNotifiedAtUp } from './005_delivery_notified_at.js';

/**
 * Ordered migration definitions. Append new migrations here; never edit or
 * reorder an applied one. Each entry exposes an idempotent `up(db)`.
 */
const MIGRATIONS = [
  { version: '001_initial', up: initialUp },
  { version: '002_edit_auth', up: editAuthUp },
  { version: '003_app_settings', up: appSettingsUp },
  { version: '004_staged_html', up: stagedHtmlUp },
  { version: '005_delivery_notified_at', up: deliveryNotifiedAtUp },
];

/**
 * Forward-compatible, idempotent migration runner.
 *
 * Tracks applied migrations in a `schema_migrations(version, applied_at)`
 * table, then runs every not-yet-applied migration in order inside a single
 * transaction. Safe to call on every boot and on already-migrated databases.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]} the versions applied during this run (empty on no-op)
 */
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare(`SELECT version FROM schema_migrations`).all().map((r) => r.version),
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    return [];
  }

  const insertMigration = db.prepare(
    `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
  );

  db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      insertMigration.run(migration.version, new Date().toISOString());
    }
  })();

  return pending.map((m) => m.version);
}

export function listMigrations() {
  return MIGRATIONS.map((m) => m.version);
}
