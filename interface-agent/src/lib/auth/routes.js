import express from 'express';
import { verifyEditToken } from './editToken.js';
import { issueStartCode, consumeStartCode } from './startCode.js';
import { createRateLimiter } from '../rateLimit.js';

/**
 * Express router for the two auth endpoints (spec §API / task-3 brief §5).
 *
 * All logic lives here and in the auth modules; app.js only mounts this router
 * under `/api/auth`. No plaintext edit token or start code is ever logged or
 * echoed in an error response — failures return a generic 401/400.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {{ setSessionCookie: (res: import('express').Response, sessionId: string) => void, clearSessionCookie: (res: import('express').Response) => void }} opts.sessionAuth
 * @param {number} [opts.startCodeTtlMs]
 */
export function createAuthRouter({ repository, sessionAuth, startCodeTtlMs, rateLimitWindowMs, rateLimitMax }) {
  const router = express.Router();

  // F7: per-IP rate limiter on the restore endpoint (the editToken is a
  // long-lived credential — bound guessing attempts).
  const restoreRateLimit =
    Number.isFinite(rateLimitMax) && rateLimitMax > 0
      ? createRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax })
      : null;

  /**
   * POST /api/auth/start-code
   * Server-to-server (agent-pipeline holds the plaintext edit token).
   * Body: { sessionId, editToken } -> { startCode, expiresAt }
   * Verifies the token against the session's stored scrypt hash, then mints a
   * one-time code. 401 on any failure; the token is never echoed.
   */
  router.post('/start-code', (req, res) => {
    const { sessionId, editToken } = req.body || {};
    if (!sessionId || !editToken) {
      return res.status(400).json({ error: '缺少 sessionId 或 editToken。' });
    }

    // All credential failures return the same generic 401 so the response body
    // leaks nothing about whether the session or token exists. (A timing
    // difference remains: a missing session skips the scrypt verify. Enumerating
    // random-UUID session ids is infeasible, so this is accepted.)
    const session = repository.getSession(sessionId);
    if (!session || session.status !== 'active' || !session.edit_token_hash) {
      return res.status(401).json({ error: '凭证无效。' });
    }

    if (!verifyEditToken(editToken, session.edit_token_hash)) {
      return res.status(401).json({ error: '凭证无效。' });
    }

    const { startCode, expiresAt } = issueStartCode(repository, sessionId, {
      ttlMs: startCodeTtlMs,
    });
    return res.json({ startCode, expiresAt });
  });

  /**
   * POST /api/auth/exchange
   * Browser-side: consumes the one-time code from the URL and sets the signed
   * HttpOnly session cookie. Body: { startCode } -> { sessionId, ok: true }
   * 401 on consumed / expired / unknown code; the code is never echoed.
   */
  router.post('/exchange', (req, res) => {
    const { startCode } = req.body || {};
    const result = startCode ? consumeStartCode(repository, startCode) : null;
    if (!result) {
      return res.status(401).json({ error: '启动码无效或已使用。' });
    }
    sessionAuth.setSessionCookie(res, result.sessionId);
    return res.json({ sessionId: result.sessionId, ok: true });
  });

  /**
   * F7: POST /api/auth/restore { editToken } — recover an independent session on
   * a new device / after losing the cookie. The editToken was returned ONCE by
   * /independent as a recovery code. This validates it against every active
   * session's scrypt hash (the hash is salted so it can't be queried directly),
   * then sets the signed HttpOnly cookie. Rate-limited per IP. 401 on any
   * failure (no leakage of which sessions exist).
   */
  router.post('/restore', ...(restoreRateLimit ? [restoreRateLimit] : []), (req, res) => {
    const { editToken } = req.body || {};
    if (!editToken || typeof editToken !== 'string') {
      return res.status(400).json({ error: '缺少 editToken。' });
    }

    // Iterate active sessions with an edit-token hash; verify each (scrypt).
    // Bounded by at-most-one-active-session-per-project. The first match wins.
    const candidates = repository.listActiveSessionsWithEditToken();
    for (const candidate of candidates) {
      if (verifyEditToken(editToken, candidate.edit_token_hash)) {
        sessionAuth.setSessionCookie(res, candidate.id);
        return res.json({ sessionId: candidate.id });
      }
    }
    return res.status(401).json({ error: '恢复码无效。' });
  });

  /** POST /api/auth/logout — clear the session cookie. */
  router.post('/logout', (_req, res) => {
    sessionAuth.clearSessionCookie(res);
    return res.json({ ok: true });
  });

  /**
   * GET /api/auth/session (Fix 2): cookie-based session restore on page refresh.
   * Uses requireSession (reads the signed cookie). Returns the session id +
   * projectKey so the frontend can restore currentSessionId and re-init the
   * version UI without a ?start code. 401 when no valid cookie → the frontend
   * shows "请从流水线打开项目".
   */
  router.get('/session', sessionAuth.requireSession, (req, res) => {
    return res.json({
      sessionId: req.session.id,
      projectKey: req.session.projectKey,
      status: req.session.status,
    });
  });

  return router;
}
