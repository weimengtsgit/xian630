import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * Opens a better-sqlite3 database at `dbPath` and applies the durability
 * pragmas required by the versioning design (spec §部署):
 *   - WAL: concurrent readers, crash-safe, append-only writes.
 *   - foreign_keys: enforce ON DELETE CASCADE / FK constraints.
 *   - busy_timeout: tolerate short lock contention under single-instance writes.
 *
 * The parent directory is created when missing so that a configured volume
 * path (e.g. /var/lib/interface-agent) works on a fresh container. `:memory:`
 * databases skip directory creation.
 *
 * @param {{ dbPath: string }} opts
 * @returns {import('better-sqlite3').Database}
 */
export function createDbClient({ dbPath }) {
  if (!dbPath) {
    throw new Error('createDbClient: dbPath is required');
  }

  if (dbPath !== ':memory:') {
    const dir = dirname(resolve(dbPath));
    mkdirSync(dir, { recursive: true });
  }

  // Lazy require: keep the native dependency out of the module-evaluation path
  // so that code paths which never touch SQLite (and environments without the
  // compiled binary) still load. The caller decides whether a failure here is
  // fatal.
  const Database = loadDriver();
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

function loadDriver() {
  // Lazy-load the native driver so a missing/broken better-sqlite3 build only
  // affects code that actually opens a database. `createRequire` is required
  // here because this package is ESM ("type":"module") where `require` is not
  // defined; the try/catch turns a hard module-resolution error into a clear
  // message for the operator (spec: "缺 DB 时优雅处理，清晰报错而非静默").
  try {
    const require = createRequire(import.meta.url);
    return require('better-sqlite3');
  } catch (error) {
    throw new Error(
      `better-sqlite3 驱动加载失败（需在 Node ${process.version} 上编译原生模块）：${error.message}`,
    );
  }
}
