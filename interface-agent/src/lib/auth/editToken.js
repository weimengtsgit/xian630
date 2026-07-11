import crypto from 'node:crypto';

/**
 * High-entropy edit credentials for an interface design session (spec §访问控制).
 *
 * The plaintext edit token is generated ONCE (by T4's resolve/restart), handed
 * to agent-pipeline, and used server-side only to mint short-lived start codes
 * (see startCode.js). The database stores ONLY a self-describing scrypt hash;
 * verification re-derives the hash with the stored parameters and salt and
 * compares in constant time.
 *
 * Why scrypt (not sha256) for the token: the token, unlike a random start
 * code, is a long-lived secret held by an external caller, so a memory-hard,
 * salted KDF is the right defence against an offline DB compromise. Start
 * codes are 192-bit random and expire in ~90s, so sha256 is adequate there.
 */

const PREFIX = 'iaet_';
// OWASP-ish scrypt parameters: N=2^14, r=8, p=1. Tunable; encoded into the
// stored string so future hashes can use stronger params while old ones still
// verify (self-describing envelope).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/**
 * @returns {string} a fresh plaintext edit token, e.g. `iaet_<64 base64url>`
 */
export function generateEditToken() {
  return PREFIX + crypto.randomBytes(48).toString('base64url');
}

/**
 * Hash a plaintext edit token into a self-describing scrypt envelope.
 * Output format: `scrypt$N=<n>,r=<r>,p=<p>$<saltB64>$<hashB64>`.
 * A fresh random salt is drawn per call, so the same token hashes differently
 * each time.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashEditToken(token) {
  if (!token) throw new Error('hashEditToken: token is required');
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(token, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Verify a plaintext token against a stored envelope in constant time.
 * Never throws on a malformed envelope — returns false so callers can map all
 * failures to a single 401 without side channels.
 *
 * @param {string} token
 * @param {string} stored
 * @returns {boolean}
 */
export function verifyEditToken(token, stored) {
  if (!token || typeof token !== 'string' || !stored || typeof stored !== 'string') {
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const params = Object.fromEntries(
    parts[1]
      .split(',')
      .map((kv) => kv.split('='))
      .map(([k, v]) => [k, Number(v)]),
  );
  const N = params.N;
  const r = params.r;
  const p = params.p;
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[2], 'base64');
    expected = Buffer.from(parts[3], 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let computed;
  try {
    computed = crypto.scryptSync(token, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}
