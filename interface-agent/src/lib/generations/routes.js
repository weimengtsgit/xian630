import crypto from 'node:crypto';
import express from 'express';
import { createRateLimiter } from '../rateLimit.js';

/**
 * Generation request HTTP routes (spec §API lines 117-118, task-5 brief §1).
 *
 *   POST /api/interface-sessions/:id/generations        — submit (202) / idempotent (200)
 *   GET  /api/interface-sessions/:id/generations/:requestId — progress
 *   GET  /api/interface-sessions/:id/generations         — list (optional, for T6)
 *
 * Auth reuses T3 primitives (requireSession cookie). Ownership: the :id path
 * param must match the cookie session id (requireSessionMatch). Cross-session
 * baseVersionId is rejected via assertVersionInSession → 403.
 *
 * The worker is created in app.js (app.locals.worker); these routes only create
 * queued rows and report progress — they never call the model or write files.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.sessionAuth
 * @param {number} [opts.rateLimitWindowMs] - per-IP generation window (ms)
 * @param {number} [opts.rateLimitMax] - per-IP max submissions per window
 */
export function createGenerationsRouter({ repository, sessionAuth, rateLimitWindowMs, rateLimitMax }) {
  const router = express.Router();

  // S3: per-IP rate limiter on the submit route (reuses src/lib/rateLimit.js,
  // same primitive as the old /api/generate). Built once here so the bucket map
  // is stable across requests. Applied only to the POST route (GET progress /
  // list are not throttled). Runs before the handler so a flood is rejected
  // regardless of auth.
  const generationRateLimit =
    Number.isFinite(rateLimitMax) && rateLimitMax > 0
      ? createRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax })
      : null;

  /** 403 when the path-param session id differs from the cookie session id. */
  function requireSessionMatch(req, res, next) {
    if (req.params.id !== req.session.id) {
      return res.status(403).json({ error: '无权操作此会话。' });
    }
    next();
  }

  /**
   * Shape a generation request row for the API. Never echoes the full
   * instruction (only a short summary) to avoid leaking it in progress polls
   * and logs. On succeeded, includes resultVersionId + versionLabel so the
   * frontend can auto-select the new version.
   */
  function formatRequest(request) {
    const resp = {
      id: request.id,
      status: request.status,
      createdAt: request.created_at,
    };
    if (request.started_at) resp.startedAt = request.started_at;
    if (request.finished_at) resp.finishedAt = request.finished_at;
    if (request.result_version_id) {
      resp.resultVersionId = request.result_version_id;
      const version = repository.getVersion(request.result_version_id);
      if (version) {
        resp.versionLabel = version.version_label;
        resp.versionTitle = version.title;
      }
    }
    if (request.error_code) resp.errorCode = request.error_code;
    if (request.error_message) resp.errorMessage = request.error_message;
    // NOTE: never echo any part of the instruction text — even a truncated
    // summary can leak sensitive content (PATs, secrets embedded in the prompt).
    // The version title (a truncated instruction) is available via versionTitle
    // on succeeded requests; failed requests expose only errorCode/errorMessage.
    return resp;
  }

  // ------------------------------------------------ POST /:id/generations

  /**
   * Submit an async generation request.
   *
   * Idempotency: same (session_id, idempotency_key) returns the existing
   * request (200) — no new row, no model call. The UNIQUE index is the
   * race-free guarantee for concurrent POSTs with the same key.
   *
   * Otherwise: insert status='queued', return 202 + generationRequestId. The
   * background worker picks it up.
   */
  router.post(
    '/:id/generations',
    ...(generationRateLimit ? [generationRateLimit] : []),
    sessionAuth.requireSession,
    requireSessionMatch,
    (req, res) => {
    const sessionId = req.session.id;
    const { baseVersionId, instruction, idempotencyKey } = req.body || {};

    // --- validation ---
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: '缺少 idempotencyKey。' });
    }
    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ error: '请输入要生成或调整的界面需求。' });
    }

    // Sp2: idempotency fast-path runs IMMEDIATELY after the idempotencyKey +
    // instruction presence checks, BEFORE the baseVersionId/hasVersions
    // validation. Otherwise retrying a SUCCEEDED root-generation (null
    // baseVersionId, but the session now has V1) returns 400 instead of the
    // existing succeeded request. Any retry of an existing request — regardless
    // of its baseVersionId shape — returns the existing request.
    const existing = repository.findGenerationRequestByIdempotency(sessionId, idempotencyKey);
    if (existing) {
      return res.status(200).json(formatRequest(existing));
    }

    // baseVersionId validation (Fix 1):
    // - null/omitted is allowed ONLY when the session has zero versions (first
    //   generation creates root V1 via commitVersion parent=null). The worker
    //   then passes empty history to the model.
    // - null/omitted when the session already has versions → 400 (必须选基线).
    // - non-null baseVersionId must belong to this session (cross-session guard).
    const hasVersions = repository.countVersions(sessionId) > 0;
    if (!baseVersionId) {
      if (hasVersions) {
        return res.status(400).json({ error: '需要选择基线版本。' });
      }
      // null baseVersionId on a 0-version session → root V1 generation.
    } else {
      if (typeof baseVersionId !== 'string') {
        return res.status(400).json({ error: 'baseVersionId 格式无效。' });
      }
      try {
        repository.assertVersionInSession(baseVersionId, sessionId);
      } catch (error) {
        if (error?.name === 'VersionNotInSessionError') {
          return res.status(403).json({ error: '基线版本不属于当前会话。' });
        }
        throw error;
      }
    }

    // --- create (race-safe via UNIQUE index) ---
    const requestId = crypto.randomUUID();
    try {
      repository.createGenerationRequest({
        id: requestId,
        sessionId,
        baseVersionId,
        idempotencyKey,
        instruction: instruction.trim(),
        createdBy: sessionId,
      });
    } catch (error) {
      // Concurrent POST with the same idempotencyKey: the loser hits the
      // UNIQUE(session_id, idempotency_key) constraint. Fall back to reading
      // the winner's row so both callers get the same request id.
      if (String(error?.message || '').match(/UNIQUE/i)) {
        const winner = repository.findGenerationRequestByIdempotency(sessionId, idempotencyKey);
        if (winner) {
          return res.status(200).json(formatRequest(winner));
        }
      }
      throw error;
    }

    return res.status(202).json({ generationRequestId: requestId, status: 'queued' });
  });

  // ----------------------------------- GET /:id/generations/:requestId

  /** Recover generation progress. Never echoes the full instruction. */
  router.get('/:id/generations/:requestId', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const request = repository.getGenerationRequest(req.params.requestId);
    if (!request || request.session_id !== req.session.id) {
      return res.status(404).json({ error: '生成请求不存在。' });
    }
    return res.status(200).json(formatRequest(request));
  });

  // ------------------------------------------- GET /:id/generations

  /** List all generation requests for this session (newest first). */
  router.get('/:id/generations', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const requests = repository.listGenerationRequests(req.session.id);
    return res.status(200).json({ requests: requests.map(formatRequest) });
  });

  return router;
}
