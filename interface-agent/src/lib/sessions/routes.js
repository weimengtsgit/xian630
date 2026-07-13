import crypto from 'node:crypto';
import express from 'express';
import { generateEditToken, hashEditToken, verifyEditToken } from '../auth/editToken.js';
import { issueStartCode } from '../auth/startCode.js';
import { buildArtifactPath } from '../generations/artifactPath.js';
import { createRateLimiter } from '../rateLimit.js';
import { isValidProjectKey } from '../validation.js';

/**
 * Session API routes for the interface-agent versioning feature (spec §API,
 * task-4 brief §A). All session logic lives here — app.js only mounts the
 * router. Auth reuses T3 primitives (requireSession, edit-token scrypt
 * verify, one-time start codes); version writes reuse T2 commitVersion.
 *
 * Credential flow: the long edit token NEVER reaches the browser.
 * agent-pipeline calls resolve server-to-server (holding the plaintext token),
 * gets back a one-time startCode, and only that code goes into the browser URL.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.sessionAuth
 * @param {number} [opts.startCodeTtlMs]
 * @param {object|null} [opts.fileClient]
 * @param {object} opts.config
 */
/**
 * Thrown inside the legacy-import tx when the global flag is already set,
 * i.e. a concurrent import won the write lock. Mapped to HTTP 409 outside.
 */
class LegacyAlreadyDoneError extends Error {
  constructor() {
    super('legacy migration already done');
    this.name = 'LegacyAlreadyDoneError';
  }
}

export function createSessionRouter({ repository, sessionAuth, startCodeTtlMs, fileClient = null, config, rateLimitWindowMs, rateLimitMax }) {
  const router = express.Router();

  // Sp6: per-IP rate limiter on the standalone /independent entry (abuse guard
  // for the no-token browser flow). Built once so the bucket map is stable.
  const independentRateLimit =
    Number.isFinite(rateLimitMax) && rateLimitMax > 0
      ? createRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax })
      : null;

  // ----------------------------------------------------------------- helpers

  /**
   * Convenience wrapper around the shared buildArtifactPath that takes a
   * session row (the call site has the full object).
   */
  function artifactPathFor(session, versionId) {
    return buildArtifactPath(config.confirmedOutputPath, session.project_key, session.id, versionId);
  }

  /** Heuristic: reject empty strings and the built-in default template. */
  function isDefaultOrEmpty(html) {
    if (typeof html !== 'string') return true;
    const trimmed = html.trim();
    if (!trimmed) return true;
    // Unique markers from createDefaultPrototype() in public/app.js
    return trimmed.includes('UNCLASSIFIED // NOTIONAL PROTOTYPE');
  }

  /**
   * Mint a new session. By default generates a fresh edit token (resolve CREATE).
   * When editTokenHash is provided (restart), reuses the existing hash so
   * agent-pipeline's stored plaintext token still verifies against the new
   * session (Fix 3: restart must NOT rotate the project edit token).
   * Returns { session, editToken } — editToken is null when reusing.
   */
  function mintSession(projectKey, opts = {}) {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    if (opts.editTokenHash) {
      const session = repository.createSessionWithToken({
        id: sessionId,
        projectKey,
        createdAt: now,
        editTokenHash: opts.editTokenHash,
      });
      return { session, editToken: null };
    }
    const editToken = generateEditToken();
    const session = repository.createSessionWithToken({
      id: sessionId,
      projectKey,
      createdAt: now,
      editTokenHash: hashEditToken(editToken),
    });
    return { session, editToken };
  }

  /** 403 when the path param session id differs from the cookie session id. */
  function requireSessionMatch(req, res, next) {
    if (req.params.id !== req.session.id) {
      return res.status(403).json({ error: '无权操作此会话。' });
    }
    next();
  }

  // --------------------------------------------------------------- /resolve

  /**
   * POST /api/interface-sessions/resolve
   * Server-to-server: agent-pipeline holds the plaintext edit token.
   * Body: { projectKey, editToken? }
   *
   * - No active session for projectKey → create one → 201 { sessionId, editToken, startCode, expiresAt }
   * - Active session + valid editToken → 200 { sessionId, startCode, expiresAt } (no editToken echoed)
   * - Active session + invalid/missing editToken → 401
   * - Missing projectKey → 400
   */
  router.post('/resolve', (req, res) => {
    const { projectKey, editToken } = req.body || {};
    if (!projectKey || typeof projectKey !== 'string') {
      return res.status(400).json({ error: '缺少 projectKey。' });
    }
    // F1: strict project-key validation at the resolve entry point. Blocks
    // path traversal (`../../`, `/`, spaces) before the key is ever used to
    // build an artifact/delivery path.
    if (!isValidProjectKey(projectKey)) {
      return res.status(400).json({ error: '项目标识只能包含小写字母、数字和连字符，长度 1-32。' });
    }

    const existing = repository.getActiveSessionByProjectKey(projectKey);

    if (!existing) {
      // Fix 4: resolve CREATE requires a server-to-server shared secret
      // (X-Internal-Token). Network isolation alone is not a code guarantee;
      // this ensures only agent-pipeline (which holds the secret) can mint the
      // long edit token. Fail-closed: if the secret is not configured at all,
      // refuse ALL creates (never silently allow). The VERIFY branch below is
      // editToken-gated and unaffected by this check.
      if (!config.internalToken) {
        return res.status(401).json({ error: '未配置内部令牌，拒绝创建会话。' });
      }
      if (req.get('X-Internal-Token') !== config.internalToken) {
        return res.status(401).json({ error: '内部令牌无效。' });
      }

      // First time for this project: mint a new active session + token.
      const { session, editToken: token } = mintSession(projectKey);
      const { startCode, expiresAt } = issueStartCode(repository, session.id, {
        ttlMs: startCodeTtlMs,
      });
      return res.status(201).json({
        sessionId: session.id,
        editToken: token,
        startCode,
        expiresAt,
      });
    }

    // Active session exists: must prove credential to get a start code.
    if (!editToken || !verifyEditToken(editToken, existing.edit_token_hash)) {
      return res.status(401).json({ error: '凭证无效或会话已被占用。' });
    }

    const { startCode, expiresAt } = issueStartCode(repository, existing.id, {
      ttlMs: startCodeTtlMs,
    });
    return res.status(200).json({ sessionId: existing.id, startCode, expiresAt });
  });

  // -------------------------------------------------- /independent (Sp6)

  /**
   * POST /api/interface-sessions/independent
   * Standalone browser entry (spec/prompt: direct access without a projectname).
   * Distinct from resolve: NO internal-token required, NO start-code dance — the
   * browser IS the owner. Creates a session with a synthetic projectKey
   * (`independent-<hex>`, ≤32 chars to satisfy the F1 regex), generates an edit
   * token (F7: returned ONCE inside a project-targeted recovery code), and sets the
   * signed HttpOnly edit cookie DIRECTLY. Rate-limited per IP so the no-token
   * entry can't be abused.
   */
  router.post('/independent', ...(independentRateLimit ? [independentRateLimit] : []), (req, res) => {
    // F1: synthetic key must satisfy validateProjectKey (≤32 chars, lowercase
    // alnum + hyphen). 16 hex chars keep the `independent-` prefix within bounds.
    const projectKey = `independent-${crypto.randomBytes(8).toString('hex')}`;
    const { session, editToken } = mintSession(projectKey);
    sessionAuth.setSessionCookie(res, session.id);
    // The non-secret project key stays stable across session restart and selects
    // exactly one active salted hash. The edit token remains the credential.
    const recoveryCode = `${session.project_key}.${editToken}`;
    return res.status(201).json({ sessionId: session.id, recoveryCode });
  });

  // --------------------------------------------------------------- /:id/restart

  /**
   * POST /api/interface-sessions/:id/restart
   * Atomically archive the current session and create a new active one for the
   * same project. The browser is browser-callable (cookie-authenticated), so
   * the response carries only the startCode — never the long editToken (Fix 2).
   * The browser re-exchanges the startCode for a cookie on the new session.
   *
   * archive + create run inside one repository.tx (Fix 4): a crash between the
   * two statements can never leave zero active sessions or two active sessions
   * for one project_key. The partial unique index on active sessions still
   * guarantees at-most-one at the DB level.
   */
  router.post('/:id/restart', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const oldSession = repository.getSession(req.session.id);
    if (!oldSession) {
      return res.status(404).json({ error: '会话不存在。' });
    }

    const newSession = repository.tx(() => {
      repository.archiveSession(oldSession.id);
      // Fix 3: reuse the old session's edit_token_hash so agent-pipeline's
      // stored plaintext token still verifies against the new session
      // (resolve-verify succeeds, not 401). The browser gets a fresh startCode
      // (below) to re-exchange a cookie for the NEW session.
      return mintSession(oldSession.project_key, {
        editTokenHash: oldSession.edit_token_hash,
      }).session;
    });
    const { startCode, expiresAt } = issueStartCode(repository, newSession.id, {
      ttlMs: startCodeTtlMs,
    });

    return res.status(200).json({
      sessionId: newSession.id,
      startCode,
      expiresAt,
    });
  });

  // --------------------------------------------------------------- GET /:id

  /**
   * GET /api/interface-sessions/:id — session summary.
   */
  router.get('/:id', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const session = repository.getSession(req.session.id);
    if (!session) {
      return res.status(404).json({ error: '会话不存在。' });
    }

    function versionSummary(versionId) {
      if (!versionId) return null;
      const v = repository.getVersion(versionId);
      if (!v) return null;
      return { versionId: v.id, versionLabel: v.version_label, title: v.title };
    }

    const deliveries = repository.getDeliveryCounts(session.id);
    const versionCount = repository.countVersions(session.id);

    return res.json({
      id: session.id,
      projectKey: session.project_key,
      status: session.status,
      mainlineHead: versionSummary(session.mainline_head_version_id),
      confirmedVersion: versionSummary(session.confirmed_version_id),
      // row_version backs the confirm endpoint's optimistic concurrency
      // (spec §API line 125): the client echoes confirmedVersion.versionId as
      // expectedConfirmedVersionId and the server 409s on a stale view.
      rowVersion: session.row_version,
      deliveries,
      versionCount,
    });
  });

  // ------------------------------------------------------- /:id/legacy-import

  /**
   * POST /api/interface-sessions/:id/legacy-import
   * One-time global import of a historical local draft as root V1.
   *
   * Preconditions (any failure → 409 or 400):
   *   - session has no versions (versionCount === 0)
   *   - global legacy_migration_done flag is false
   *   - html is non-empty and non-default
   *
   * On success: writes the artifact, commits root V1 (parent=null), sets the
   * global flag, and records a legacy_imported event — all in one tx.
   */
  router.post('/:id/legacy-import', sessionAuth.requireSession, requireSessionMatch, async (req, res) => {
    const { html, title } = req.body || {};

    if (isDefaultOrEmpty(html)) {
      return res.status(400).json({ error: '内容为空或为默认模板，无法导入。' });
    }

    const session = repository.getSession(req.session.id);
    if (!session) {
      return res.status(404).json({ error: '会话不存在。' });
    }

    if (repository.countVersions(session.id) > 0) {
      return res.status(409).json({ error: '会话已有版本，无法导入旧稿。' });
    }

    // Cheap pre-check outside the tx to short-circuit the common case. The
    // authoritative race-free re-check happens INSIDE the tx below (Fix 1):
    // two concurrent legacy-import requests from different sessions can both
    // pass this outside check, both upload, then race for the write lock; the
    // loser's inner re-check sees the flag set and throws → 409. The orphaned
    // upload on the losing path is left for T8's sweep (spec §HTML 产物).
    if (repository.getSetting('legacy_migration_done') === 'true') {
      return res.status(409).json({ error: '旧稿迁移已完成，不可重复导入。' });
    }

    if (!fileClient) {
      return res.status(500).json({ error: '服务端未配置 Blade OS 文件服务。' });
    }

    const versionId = crypto.randomUUID();
    const artifactPath = artifactPathFor(session, versionId);
    const buf = Buffer.from(html, 'utf8');
    const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
    const byteSize = buf.byteLength;

    // Write the artifact first; if the DB tx fails the orphaned file is
    // cleaned by a future sweep (spec §HTML 产物). Awaiting is not possible
    // inside the synchronous tx, so upload happens before it.
    try {
      await fileClient.uploadText(artifactPath, html);
    } catch (error) {
      console.error('[legacy-import] artifact upload failed:', error);
      return res.status(502).json({ error: '旧稿文件写入失败，请稍后重试。' });
    }

    // Sp4: read back the uploaded artifact and verify the SHA-256 matches the
    // pre-upload hash (spec §HTML 产物: "写入后计算并校验 SHA-256"). Mirrors the
    // generations worker (Fix 7). A mismatch (silent corruption, partial write,
    // storage proxy mutation) → NO version is created and the global migration
    // flag is NOT set, so the user can retry.
    try {
      const readBack = await fileClient.readText(artifactPath);
      const readBackHash = crypto
        .createHash('sha256')
        .update(Buffer.from(readBack, 'utf8'))
        .digest('hex');
      if (readBackHash !== contentHash) {
        console.error('[legacy-import] post-write hash mismatch');
        return res.status(500).json({ error: '写入后内容校验不一致，请稍后重试。' });
      }
    } catch (error) {
      console.error('[legacy-import] post-write verify read failed:', error);
      return res.status(500).json({ error: '写入后内容校验失败，请稍后重试。' });
    }

    const resolvedTitle = title || '导入的历史界面稿';

    // Race-free global-once guard (Fix 1): the synchronous tx holds SQLite's
    // write lock, so the inner re-check is authoritative. commitVersion's
    // internal tx becomes a savepoint under this outer tx. createdBy matches
    // the spec source string 'legacy_local' (spec §旧数据迁移 行 168).
    try {
      const version = repository.tx(() => {
        if (repository.getSetting('legacy_migration_done') === 'true') {
          throw new LegacyAlreadyDoneError();
        }

        const v = repository.commitVersion({
          sessionId: session.id,
          parentVersionId: null,
          id: versionId,
          artifactPath,
          contentHash,
          byteSize,
          title: resolvedTitle,
          sourceVersionId: null,
          generationRequestId: null,
          createdBy: 'legacy_local',
        });

        repository.setSetting('legacy_migration_done', 'true');
        repository.insertEvent({
          sessionId: session.id,
          type: 'legacy_imported',
          payload: { versionId: v.id, versionLabel: v.version_label },
          createdBy: 'legacy_local',
        });

        return v;
      });

      return res.status(200).json({
        version: {
          versionId: version.id,
          versionLabel: version.version_label,
          title: version.title,
          parentVersionId: version.parent_version_id,
          artifactPath: version.artifact_path,
          contentHash: version.content_hash,
          byteSize: version.byte_size,
          createdBy: version.created_by,
          createdAt: version.created_at,
        },
      });
    } catch (error) {
      if (error instanceof LegacyAlreadyDoneError) {
        return res.status(409).json({ error: '旧稿迁移已完成，不可重复导入。' });
      }
      throw error;
    }
  });

  // ----------------------------------------------- /:id/legacy-import/status

  /**
   * GET /api/interface-sessions/:id/legacy-import/status
   * Returns whether the legacy import prompt should be offered. The backend
   * reports the server-side gates (no versions + global flag); the frontend
   * additionally checks localStorage for non-default HTML before prompting.
   */
  router.get('/:id/legacy-import/status', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const session = repository.getSession(req.session.id);
    if (!session) {
      return res.status(404).json({ error: '会话不存在。' });
    }

    const hasVersions = repository.countVersions(session.id) > 0;
    const globallyDone = repository.getSetting('legacy_migration_done') === 'true';

    if (hasVersions) {
      return res.json({ offered: false, reason: '会话已有版本。' });
    }
    if (globallyDone) {
      return res.json({ offered: false, reason: '旧稿迁移已全局完成。' });
    }
    return res.json({ offered: true, reason: '可导入旧稿。' });
  });

  return router;
}
