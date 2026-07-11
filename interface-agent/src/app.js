import express from 'express';
import helmet from 'helmet';
import fetch from 'node-fetch';
import { BladeFileError } from './lib/bladeFiles.js';
import { createRepository } from './lib/db/repository.js';
import { createSessionAuth } from './lib/auth/cookieSession.js';
import { createAuthRouter } from './lib/auth/routes.js';
import { createSessionRouter } from './lib/sessions/routes.js';
import { createGenerationsRouter } from './lib/generations/routes.js';
import { createGenerationWorker } from './lib/generations/worker.js';
import { createVersionsRouter } from './lib/versions/routes.js';
import { createSharesRouter } from './lib/shares/routes.js';
import { createConfirmationsRouter } from './lib/confirmations/routes.js';
import { createDeliveriesRouter } from './lib/deliveries/routes.js';
import { createDeliveryWorker } from './lib/deliveries/worker.js';
import { createArtifactCleanup } from './lib/generations/cleanup.js';

function isNotFoundError(error) {
  return error?.status === 404 || (error instanceof BladeFileError && error.status === 404);
}

export function createApp({ config, deepseekClient, fileClient = null, fetchClient = fetch, db = null }) {
  const app = express();
  // `db` (better-sqlite3 handle) is opened and migrated at boot by server.js
  // and reserved for the versioning routes added in later tasks. Kept on the
  // closure so this factory remains the single wiring point.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static('public'));

  // Session auth primitives (edit token -> one-time start code -> signed
  // HttpOnly cookie). Mounted only when a DB handle is wired in; the version
  // routes (T4-T7) reuse repository + sessionAuth stashed on app.locals.
  if (db) {
    const repository = createRepository(db);
    const sessionAuth = createSessionAuth({
      repository,
      sessionSecret: config.sessionSecret,
      secureCookies: config.secureCookies,
    });
    app.locals.repository = repository;
    app.locals.sessionAuth = sessionAuth;

    // Background generation worker (not auto-started; server.js calls start()).
    // Injectable: tests drive it via app.locals.worker.tick() with fake clients.
    const worker = createGenerationWorker({
      repository,
      deepseekClient,
      fileClient,
      config,
    });
    app.locals.worker = worker;

    // Background delivery worker (spec §确认与交付流程). Same lifecycle pattern
    // as the generation worker: atomic claim, IO outside the sync tx, atomic
    // guarded status tx, restart recovery. Not auto-started; server.js calls
    // start(). Injectable fetchClient for the pipeline callback + tests.
    const deliveryWorker = createDeliveryWorker({
      repository,
      fileClient,
      config,
      fetchClient,
    });
    app.locals.deliveryWorker = deliveryWorker;

    // Orphan-artifact cleanup (T8). Reclaims version prototype.html files
    // whose DB commit never landed, after an age threshold so in-flight tx
    // files are never touched. Startup-delayed + optional periodic. Not
    // auto-started; server.js calls start() (and stop() on shutdown).
    const artifactCleanup = createArtifactCleanup({ fileClient, repository, config });
    app.locals.artifactCleanup = artifactCleanup;

    app.use(
      '/api/auth',
      createAuthRouter({
        repository,
        sessionAuth,
        startCodeTtlMs: config.startCodeTtlMs,
        rateLimitWindowMs: config.rateLimitWindowMs,
        rateLimitMax: config.rateLimitMax,
      }),
    );
    app.use(
      '/api/interface-sessions',
      createSessionRouter({
        repository,
        sessionAuth,
        startCodeTtlMs: config.startCodeTtlMs,
        fileClient,
        config,
        rateLimitWindowMs: config.rateLimitWindowMs,
        rateLimitMax: config.rateLimitMax,
      }),
    );
    app.use(
      '/api/interface-sessions',
      createGenerationsRouter({
        repository,
        sessionAuth,
        rateLimitWindowMs: config.rateLimitWindowMs,
        rateLimitMax: config.rateLimitMax,
      }),
    );
    app.use(
      '/api/interface-sessions',
      createVersionsRouter({ repository, sessionAuth, fileClient }),
    );
    // Confirmations + deliveries are independent operations on the same session
    // prefix (spec: share / confirm / deliver are three independent ops).
    app.use(
      '/api/interface-sessions',
      createConfirmationsRouter({ repository, sessionAuth }),
    );
    app.use(
      '/api/interface-sessions',
      createDeliveriesRouter({ repository, sessionAuth }),
    );
    // Shares spans both session-scoped (create/list) and public (no-cookie)
    // paths plus the human-facing /share/:token viewer, so it owns its full
    // paths from root. Mounted last so the other /api/interface-sessions
    // routers handle their routes first; shares only matches its own paths.
    app.use('/', createSharesRouter({ repository, sessionAuth, fileClient, config }));
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/pending-input', async (_req, res) => {
    const pollIntervalMs = config.pendingPollIntervalMs || 3000;
    if (!config.pendingInputPath) {
      res.json({ available: false, pollIntervalMs });
      return;
    }
    if (!fileClient) {
      res.status(500).json({ error: '服务端未配置 Blade OS 文件服务。' });
      return;
    }

    try {
      const content = await fileClient.readText(config.pendingInputPath);
      if (!content.trim()) {
        res.json({ available: false, path: config.pendingInputPath, pollIntervalMs });
        return;
      }
      res.json({
        available: true,
        content,
        path: config.pendingInputPath,
        pollIntervalMs,
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        res.json({ available: false, path: config.pendingInputPath, pollIntervalMs });
        return;
      }
      console.error(error);
      res.status(502).json({ error: '读取待定输入文件失败。' });
    }
  });

  return app;
}
