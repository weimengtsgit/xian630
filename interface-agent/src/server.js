import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDeepSeekClient } from './lib/deepseek.js';
import { createBladeFileClient } from './lib/bladeFiles.js';
import { createDbClient } from './lib/db/client.js';
import { runMigrations } from './lib/db/migrations/index.js';

const config = loadConfig();

// Fix 4: fail-closed startup warning when the server-to-server secret is not
// configured. Without it, resolve refuses ALL session creates — agent-pipeline
// cannot launch new projects. This is intentional (never silently allow creates
// without the shared secret).
if (!config.internalToken) {
  console.warn(
    '[config] INTERFACE_AGENT_INTERNAL_TOKEN 未配置：resolve 将拒绝所有会话创建（fail-closed）。生产必须配置与 agent-pipeline 相同的共享密钥。',
  );
}

// Persistent SQLite store for the versioning feature. Opened before the HTTP
// server so schema migrations run exactly once at boot. A failure here is
// fatal and reported clearly (never silent), because later tasks persist
// version history through this handle.
let db = null;
try {
  db = createDbClient({ dbPath: config.dbPath });
  const applied = runMigrations(db);
  console.log(`[db] opened ${config.dbPath}; migrations applied: ${applied.length ? applied.join(', ') : 'none (up to date)'}`);
} catch (error) {
  console.error(`[db] 初始化失败，无法启动：${error.message}`);
  process.exitCode = 1;
  process.exit(1);
}

const app = createApp({
  config,
  deepseekClient: createDeepSeekClient(config),
  fileClient: config.bladeOsBaseUrl && config.bladeOsPat ? createBladeFileClient(config) : null,
  db,
});

// Start the background generation worker (restart-safe: recovers orphaned
// 'generating' requests on boot). Only when a DB is wired in.
if (app.locals.worker) {
  app.locals.worker.start();
}

// Start the background delivery worker (restart-safe: recovers orphaned
// 'delivering' rows on boot). Mirrors the generation worker lifecycle.
if (app.locals.deliveryWorker) {
  app.locals.deliveryWorker.start();
}

// Start the orphan-artifact cleanup driver (startup-delayed + optional
// periodic). No-op unless ARTIFACT_CLEANUP_ENABLED != 0.
if (app.locals.artifactCleanup) {
  app.locals.artifactCleanup.start();
}

const server = app.listen(config.port, config.host, () => {
  console.log(`AI Prototype Workbench listening on http://${config.host}:${config.port}`);
  console.log(`Local URL: http://localhost:${config.port}`);
});

// Close the database handle cleanly on shutdown so WAL is checkpointed. A
// force-exit timeout guards against a hung connection (e.g. a stuck
// server.close waiting on an open keep-alive socket) so the container runtime
// never has to SIGKILL us.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  app.locals.worker?.stop();
  app.locals.deliveryWorker?.stop();
  app.locals.artifactCleanup?.stop();
  const forceExit = setTimeout(() => {
    console.error('[server] graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  server.close(() => {
    try {
      db?.close();
    } catch (error) {
      console.error(`[db] close error: ${error.message}`);
    }
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
