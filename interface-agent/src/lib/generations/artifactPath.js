import { validateProjectKey } from '../validation.js';

/**
 * Extract the `<base>` directory portion of `confirmedOutputPath` — the prefix
 * under which version artifacts AND the compatibility delivery live (spec
 * §HTML 产物). e.g. "共享/prototype.html" → "共享"; "prototype.html" → "".
 *
 * Shared by buildArtifactPath (version artifacts) and the orphan-artifact
 * cleanup driver (which scans <base>/<projectname>/interface-sessions/).
 */
export function buildArtifactBaseDir(confirmedOutputPath) {
  const confirmed = confirmedOutputPath || '';
  const slash = confirmed.lastIndexOf('/');
  return slash >= 0 ? confirmed.slice(0, slash) : '';
}

/**
 * Build the immutable Blade OS artifact path for a version (spec §HTML 产物):
 *   <base>/<projectname>/interface-sessions/<session-id>/versions/<version-id>/prototype.html
 *
 * `<base>` is the directory portion of `confirmedOutputPath` so version
 * artifacts live alongside the compatibility delivery path. Extracted here so
 * both the session legacy-import route and the generation worker share one
 * implementation (no drift).
 *
 * @param {string} confirmedOutputPath - e.g. "共享/prototype.html"
 * @param {string} projectKey
 * @param {string} sessionId
 * @param {string} versionId
 * @returns {string}
 */
export function buildArtifactPath(confirmedOutputPath, projectKey, sessionId, versionId) {
  // F1: validate projectKey before it is interpolated into a Blade OS path.
  // Blocks `../../` path traversal (confused-deputy on agent-pipeline).
  validateProjectKey(projectKey);
  const base = buildArtifactBaseDir(confirmedOutputPath);
  const rel = `${projectKey}/interface-sessions/${sessionId}/versions/${versionId}/prototype.html`;
  return base ? `${base}/${rel}` : rel;
}
