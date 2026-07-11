import crypto from 'node:crypto';

/**
 * Signed HttpOnly session-cookie middleware (spec §访问控制, scheme A).
 *
 * The cookie carries only the session id plus an HMAC-SHA256 of it; the secret
 * is `INTERFACE_AGENT_SESSION_SECRET`. The long edit token itself never reaches
 * the browser, so it cannot leak via logs, Referer, or shared links. If the
 * secret is unset, an ephemeral random secret is generated with a loud warning
 * (cookies survive only until the next restart; production must configure one).
 *
 * Cookie flags: HttpOnly; SameSite=Lax; Path=/; Secure only when `secureCookies`
 * is set (production behind TLS). Parsing is hand-rolled to avoid a new runtime
 * dependency (keeps the Alpine build / package-lock untouched).
 */

const DEFAULT_COOKIE_NAME = 'ia_session';

/**
 * Split a Cookie header into a { name: value } map. Values are URI-decoded
 * defensively; our own signed values are base64url-safe so decoding is a no-op.
 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {{ getSession: (id: string) => unknown }} opts.repository
 * @param {string} [opts.sessionSecret] - HMAC secret; if empty an ephemeral one is generated
 * @param {boolean} [opts.secureCookies] - add the Secure flag (production)
 * @param {string} [opts.cookieName]
 */
export function createSessionAuth({
  repository,
  sessionSecret = '',
  secureCookies = false,
  cookieName = DEFAULT_COOKIE_NAME,
}) {
  let secret = sessionSecret;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    // No plaintext leak risk here: this is a generated random secret, not a
    // user credential. Restart-unsafe by design.
    console.warn(
      '[auth] INTERFACE_AGENT_SESSION_SECRET 未配置：使用临时随机密钥，重启后所有会话 Cookie 失效（生产必须配置）。',
    );
  }
  const keyBuf = Buffer.from(secret);

  /** Sign a session id: `<sessionId>.<base64url(hmac-sha256(sessionId))>`. */
  function sign(sessionId) {
    const sig = crypto.createHmac('sha256', keyBuf).update(sessionId).digest('base64url');
    return `${sessionId}.${sig}`;
  }

  /** Verify a signed value; return the session id or null (constant-time compare). */
  function unsign(value) {
    if (!value || typeof value !== 'string') return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const sessionId = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = crypto.createHmac('sha256', keyBuf).update(sessionId).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || sigBuf.length === 0) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    return sessionId;
  }

  function readSessionCookie(req) {
    const cookies = parseCookies(req.headers?.cookie);
    const raw = cookies[cookieName];
    if (!raw) return null;
    return unsign(raw);
  }

  function cookieAttributes() {
    const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  function setSessionCookie(res, sessionId) {
    res.setHeader('Set-Cookie', `${cookieName}=${sign(sessionId)}; ${cookieAttributes()}`);
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${cookieName}=; ${cookieAttributes()}; Max-Age=0`);
  }

  /** Middleware: require a valid, active session. Sets req.session or 401. */
  function requireSession(req, res, next) {
    const sessionId = readSessionCookie(req);
    if (!sessionId) {
      return res.status(401).json({ error: '未登录或会话已失效。' });
    }
    const session = repository.getSession(sessionId);
    if (!session || session.status !== 'active') {
      return res.status(401).json({ error: '会话不存在或已归档。' });
    }
    req.session = {
      id: session.id,
      projectKey: session.project_key,
      status: session.status,
      rowVersion: session.row_version,
      mainlineHeadVersionId: session.mainline_head_version_id,
      confirmedVersionId: session.confirmed_version_id,
    };
    next();
  }

  /**
   * Ownership guard factory for version write routes (T4-T7). Must run AFTER
   * requireSession. Reuses repository.assertVersionInSession so cross-session
   * parent/base/confirm references are rejected uniformly (403, never silently).
   *
   * @param {{ getVersionId?: (req: import('express').Request) => string }} [opts]
   */
  function requireSessionOwnsVersion({ getVersionId = (req) => req.params.versionId } = {}) {
    return function ownVersionGuard(req, res, next) {
      if (!req.session) {
        return res.status(401).json({ error: '未登录。' });
      }
      const versionId = getVersionId(req);
      try {
        repository.assertVersionInSession(versionId, req.session.id);
        next();
      } catch (error) {
        if (error?.name === 'VersionNotInSessionError') {
          return res.status(403).json({ error: '版本不属于当前会话。' });
        }
        next(error);
      }
    };
  }

  return {
    sign,
    unsign,
    readSessionCookie,
    setSessionCookie,
    clearSessionCookie,
    requireSession,
    requireSessionOwnsVersion,
    cookieName,
  };
}
