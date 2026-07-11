import crypto from 'node:crypto';
import express from 'express';
import { BladeFileError } from '../bladeFiles.js';

/**
 * Share HTTP routes (spec §API lines 120-121, §分享、确认与交付, §访问控制,
 * task-7 brief §A).
 *
 * A share is an INDEPENDENT, unguessable, read-only, revocable, expirable link
 * that is PINNED to the version at creation time. Creating a share never
 * confirms; confirming never creates a share (spec: three independent ops).
 *
 *   POST   /api/interface-sessions/:id/shares   — create (cookie + version ownership)
 *   GET    /api/interface-sessions/:id/shares   — owner list (with status)
 *   GET    /api/shares/:token                   — public read-only metadata (no cookie)
 *   GET    /api/shares/:token/preview           — public read-only version HTML
 *   DELETE /api/shares/:shareId                 — revoke (cookie + ownership)
 *   GET    /share/:token                        — human-facing viewer page
 *
 * Token handling: the plaintext token is generated with crypto.randomBytes(32)
 * (256-bit, unguessable) and returned to the caller EXACTLY ONCE. The DB stores
 * only sha256(token). The public lookup re-hashes the path token and matches.
 * The plaintext token may appear in a share URL (it authorizes only preview of
 * the pinned version); the long edit token / PAT never appears in any share
 * response, event payload, or log.
 *
 * Pinned version: the share records version_id at creation; even if the session
 * later confirms or archives a different version, the share keeps pointing at
 * the original. Revoked / expired / missing shares return 404 (no leakage of
 * existence vs. state beyond "not available").
 *
 * Mounted at '/' so it can own both the /api/* endpoints and the /share/:token
 * viewer page in one module.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.sessionAuth
 * @param {object|null} [opts.fileClient] - { readText(path) } for the preview
 * @param {object} opts.config
 */
export function createSharesRouter({ repository, sessionAuth, fileClient = null, config }) {
  const router = express.Router();

  /** sha256 hex of the plaintext token — what we store and index. */
  function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /** Build the human-facing share URL from the plaintext token. */
  function shareUrl(token) {
    const base = (config.publicBaseUrl || '').replace(/\/$/, '');
    const path = `/share/${token}`;
    return base ? `${base}${path}` : path;
  }

  /** Compute expires_at: explicit expiresInMs wins, else the configured default. */
  function computeExpiresAt(expiresInMs) {
    const ms =
      Number.isFinite(expiresInMs) && expiresInMs > 0
        ? expiresInMs
        : Number.isFinite(config.shareDefaultExpiresMs) && config.shareDefaultExpiresMs > 0
          ? config.shareDefaultExpiresMs
          : null;
    return ms ? new Date(Date.now() + ms).toISOString() : null;
  }

  /** True when the share row is revoked or past its expiry. */
  function isUnavailable(share) {
    if (!share) return true;
    if (share.revoked_at) return true;
    if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) return true;
    return false;
  }

  /** 403 when the path-param session id differs from the cookie session id. */
  function requireSessionMatch(req, res, next) {
    if (req.params.id !== req.session.id) {
      return res.status(403).json({ error: '无权操作此会话。' });
    }
    next();
  }

  // -------------------- POST /api/interface-sessions/:id/shares

  router.post(
    '/api/interface-sessions/:id/shares',
    sessionAuth.requireSession,
    requireSessionMatch,
    (req, res) => {
      const sessionId = req.session.id;
      const { versionId, expiresInMs } = req.body || {};

      if (!versionId || typeof versionId !== 'string') {
        return res.status(400).json({ error: '缺少 versionId。' });
      }

      // Cross-session guard: the shared version must belong to THIS session.
      let version;
      try {
        version = repository.assertVersionInSession(versionId, sessionId);
      } catch (error) {
        if (error?.name === 'VersionNotInSessionError') {
          return res.status(403).json({ error: '版本不属于当前会话。' });
        }
        throw error;
      }

      // Generate the unguessable plaintext token; store ONLY its hash.
      const token = crypto.randomBytes(32).toString('base64url');
      const shareId = crypto.randomUUID();
      const expiresAt = computeExpiresAt(expiresInMs);
      repository.createShare({
        id: shareId,
        sessionId,
        versionId: version.id, // PINNED — never re-pointed
        tokenHash: hashToken(token),
        createdBy: sessionId,
        expiresAt,
      });

      // Sanitized event: versionLabel only. The plaintext token must NEVER
      // appear in any event payload (it would then leak via the events stream).
      repository.insertEvent({
        sessionId,
        type: 'share_created',
        payload: { versionLabel: version.version_label },
        createdBy: sessionId,
      });

      return res.status(200).json({
        shareId,
        token, // plaintext — returned exactly once
        url: shareUrl(token),
        versionLabel: version.version_label,
        expiresAt,
      });
    },
  );

  // --------------------- GET /api/interface-sessions/:id/shares (owner list)

  /** Owner-facing list with status (revoked / expired flags). No tokens. */
  router.get(
    '/api/interface-sessions/:id/shares',
    sessionAuth.requireSession,
    requireSessionMatch,
    (req, res) => {
      const shares = repository.listSharesBySession(req.session.id);
      return res.status(200).json({
        shares: shares.map((s) => {
          const version = repository.getVersion(s.version_id);
          return {
            shareId: s.id,
            versionId: s.version_id,
            versionLabel: version?.version_label || null,
            createdAt: s.created_at,
            expiresAt: s.expires_at,
            revokedAt: s.revoked_at,
            expired: s.expires_at ? new Date(s.expires_at).getTime() <= Date.now() : false,
          };
        }),
      });
    },
  );

  // -------------------- public GET /api/shares/:token (metadata)

  /**
   * Public read-only metadata. No cookie. No instruction, no edit token, no
   * session id, no PAT. Returns the PINNED version's label + title only.
   * Revoked / expired / unknown → 404.
   */
  router.get('/api/shares/:token', (req, res) => {
    const share = repository.getShareByTokenHash(hashToken(req.params.token));
    if (isUnavailable(share)) {
      return res.status(404).json({ error: '分享不存在或已失效。' });
    }
    const version = repository.getVersion(share.version_id);
    if (!version) {
      return res.status(404).json({ error: '分享不存在或已失效。' });
    }
    return res.status(200).json({
      versionLabel: version.version_label,
      title: version.title,
      createdAt: share.created_at,
      expiresAt: share.expires_at,
    });
  });

  // -------------------- public GET /api/shares/:token/preview (HTML)

  /**
   * Public read-only version HTML (the pinned version). content-type text/html.
   * Revoked / expired / unknown / unreadable artifact → 404. Never echoes the
   * internal artifact path.
   */
  router.get('/api/shares/:token/preview', async (req, res) => {
    const share = repository.getShareByTokenHash(hashToken(req.params.token));
    if (isUnavailable(share)) {
      return res.status(404).type('text/plain').send('分享不存在或已失效。');
    }
    const version = repository.getVersion(share.version_id);
    if (!version) {
      return res.status(404).type('text/plain').send('分享不存在或已失效。');
    }
    if (!fileClient) {
      return res.status(404).type('text/plain').send('分享内容暂不可用。');
    }
    try {
      const html = await fileClient.readText(version.artifact_path);
      // F2: CSP sandbox with allow-scripts (SPACE not semicolon — a `;` ends
      // the sandbox directive, leaving no tokens and BLOCKING scripts). NO
      // allow-same-origin so the generated HTML is isolated on direct-open from
      // the interface-agent origin (opaque origin cannot read cookies or call
      // same-origin APIs).
      return res
        .type('text/html')
        .set('Content-Security-Policy', 'sandbox allow-scripts')
        .send(html);
    } catch (error) {
      // Missing artifact or transport fault → 404 (sanitized, no path leak).
      if (error instanceof BladeFileError && error.status === 404) {
        return res.status(404).type('text/plain').send('分享内容暂不可用。');
      }
      console.error('[shares] read preview failed:', error?.message || error);
      return res.status(404).type('text/plain').send('分享内容暂不可用。');
    }
  });

  // -------------------- DELETE /api/shares/:shareId (revoke)

  /**
   * Revoke a share. Requires a cookie session AND the share must belong to it
   * (cross-session delete → 403). Idempotent: revoking an already-revoked share
   * is a 200. Emits a share_revoked event.
   */
  router.delete('/api/shares/:shareId', sessionAuth.requireSession, (req, res) => {
    const share = repository.getShare(req.params.shareId);
    if (!share || share.session_id !== req.session.id) {
      return res.status(403).json({ error: '无权撤销此分享。' });
    }
    repository.revokeShare(share.id);
    repository.insertEvent({
      sessionId: req.session.id,
      type: 'share_revoked',
      payload: { versionLabel: repository.getVersion(share.version_id)?.version_label || null },
      createdBy: req.session.id,
    });
    return res.status(200).json({ shareId: share.id, revokedAt: repository.getShare(share.id).revoked_at });
  });

  // -------------------- GET /share/:token (human-facing viewer)

  /**
   * Thin read-only viewer page for the public share URL. It fetches the public
   * metadata + preview endpoints and renders the pinned version in a sandboxed
   * iframe. No instruction / edit-token / session info is embedded. The token
   * is read from the URL client-side; if the share is revoked/expired the
   * preview endpoint returns 404 and the page shows a fallback notice.
   */
  router.get('/share/:token', (req, res) => {
    // Do NOT hash/validate here — the page is static; the actual access check
    // happens when it calls /api/shares/:token. Serving the shell to an invalid
    // token leaks nothing (no version metadata is embedded).
    res.type('text/html').send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>分享的原型预览</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0a0e14;color:#e8eef5}
  .bar{padding:10px 16px;background:#111823;border-bottom:1px solid rgba(130,160,190,.16);display:flex;align-items:center;gap:10px}
  .bar .lbl{font-size:13px;font-weight:600}
  .bar .meta{color:#9fb2c6;font-size:12px}
  iframe{border:0;width:100%;height:calc(100vh - 45px);background:#fff}
  .err{padding:40px;text-align:center;color:#9fb2c6}
</style>
</head>
<body>
  <div class="bar"><span class="lbl">分享的原型预览</span><span class="meta" id="meta"></span></div>
  <iframe id="f" title="分享预览" sandbox="allow-scripts"></iframe>
  <div class="err" id="err" hidden>分享不存在或已失效。</div>
<script>
  var t = location.pathname.split('/').pop();
  fetch('/api/shares/' + encodeURIComponent(t)).then(function(r){return r.ok?r.json():null;}).then(function(m){
    if(!m){ document.getElementById('f').hidden=true; document.getElementById('err').hidden=false; return; }
    document.getElementById('meta').textContent = (m.versionLabel||'') + (m.title?(' · '+m.title):'');
  }).catch(function(){});
  document.getElementById('f').src = '/api/shares/' + encodeURIComponent(t) + '/preview';
</script>
</body>
</html>`);
  });

  return router;
}
