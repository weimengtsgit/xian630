import express from 'express';
import { ArchivedVersionConfirmError, ConfirmConflictError } from '../db/repository.js';

/**
 * Confirmation HTTP route (spec §API line 119, §确认与交付流程, task-7 brief §B).
 *
 *   POST /api/interface-sessions/:id/confirmations
 *
 * Confirm is the ONLY operation that writes the session's shared
 * confirmed_version_id. It uses optimistic concurrency: the caller passes the
 * confirmed version id it EXPECTS to be current; if the session's
 * confirmed_version_id differs → 409 (never a silent overwrite). On success the
 * tx bumps row_version, supersedes old unfinished deliveries, and creates a new
 * pending delivery (the delivery worker owns the downstream push).
 *
 * Independence (spec): confirm never creates a share; a share never confirms.
 * Delivery failure (later, async) never undoes a confirm.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.sessionAuth
 */
export function createConfirmationsRouter({ repository, sessionAuth }) {
  const router = express.Router();

  /** 403 when the path-param session id differs from the cookie session id. */
  function requireSessionMatch(req, res, next) {
    if (req.params.id !== req.session.id) {
      return res.status(403).json({ error: '无权操作此会话。' });
    }
    next();
  }

  // ------------------------------- POST /:id/confirmations

  router.post('/:id/confirmations', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const sessionId = req.session.id;
    const { versionId, expectedConfirmedVersionId } = req.body || {};

    // --- validation ---
    if (!versionId || typeof versionId !== 'string') {
      return res.status(400).json({ error: '缺少 versionId。' });
    }
    // expectedConfirmedVersionId may be null (first confirm) or a string.
    const expected =
      expectedConfirmedVersionId === undefined ? null : expectedConfirmedVersionId;
    if (expected !== null && typeof expected !== 'string') {
      return res.status(400).json({ error: 'expectedConfirmedVersionId 格式无效。' });
    }

    // Cross-session guard: the confirmed version must belong to THIS session.
    // (领域规则 7/8, spec §访问控制 — never reference another session's version.)
    try {
      repository.assertVersionInSession(versionId, sessionId);
    } catch (error) {
      if (error?.name === 'VersionNotInSessionError') {
        return res.status(403).json({ error: '版本不属于当前会话。' });
      }
      throw error;
    }

    // --- optimistic-concurrency confirm tx ---
    try {
      const result = repository.confirmVersion({
        sessionId,
        versionId,
        expectedConfirmedVersionId: expected,
      });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof ConfirmConflictError) {
        // The caller's view is stale: report the actual confirmed version + the
        // current row_version so the UI can refresh and re-issue. Never overwrite.
        return res.status(409).json({
          error: '确认版本已变更，请刷新后重试。',
          currentConfirmedVersionId: error.currentConfirmedVersionId,
          rowVersion: error.rowVersion,
        });
      }
      if (error instanceof ArchivedVersionConfirmError) {
        return res.status(409).json({ error: '归档版本不可确认，请先恢复该版本。' });
      }
      throw error;
    }
  });

  return router;
}
