import { buildArtifactBaseDir } from './artifactPath.js';

/**
 * Task 8 — orphan-artifact cleanup (spec §HTML 产物: "数据库提交失败产生的孤立
 * 文件由清理任务按路径和年龄回收").
 *
 * Safety contract (strict):
 *   - Only files under the version-artifact path pattern are ever candidates:
 *       <base>/<projectname>/interface-sessions/<sid>/versions/<vid>/prototype.html
 *     The compatibility delivery path (<base>/<projectname>/prototype.html) and
 *     every other directory are NEVER scanned or removed.
 *   - A candidate is removed ONLY when BOTH hold:
 *       1. no version row references its exact artifact_path (truly orphaned),
 *       2. its age (by the listing's modified time) ≥ maxAgeMs (default 1h),
 *          so an in-flight transaction whose DB commit hasn't landed yet is
 *          never deleted.
 *   - Per-file / per-directory errors are logged (sanitized: relative path +
 *     reason only; never the PAT) and the sweep continues. Returns a summary.
 */

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1h — protects in-flight tx files

/**
 * Compute a file/dir age in ms from a Blade OS listing `modified` field.
 * Returns null when the timestamp is missing/unparseable/implausible — callers
 * treat null as "age unknown → keep" (never delete without a confident age),
 * which is the safe direction for in-flight protection.
 *
 * The floor guards against a misparsed value (e.g. an epoch-seconds number
 * misread as ms, landing in 1970) making a file appear ancient and being
 * deleted prematurely; a future timestamp yields a negative age clamped to 0
 * (kept, since age < maxAge).
 */
const MODIFIED_FLOOR_MS = Date.UTC(2020, 0, 1);
function ageOfModified(modified, now) {
  if (!modified) return null;
  const t = Date.parse(modified);
  if (!Number.isFinite(t) || t < MODIFIED_FLOOR_MS) return null;
  return Math.max(0, now - t);
}

/**
 * Run one orphan-artifact sweep. Pure-ish: takes the file client + repository
 * + projectKeys explicitly so tests inject fakes. Discovers version artifacts
 * via fileClient.list, removes those with no matching DB version row AND age ≥
 * maxAgeMs via fileClient.remove.
 *
 * @param {object} opts
 * @param {object} opts.fileClient - { list(path), remove(paths) }
 * @param {object} opts.repository - { hasVersionWithArtifactPath(path) }
 * @param {string} opts.baseDir - directory portion of confirmedOutputPath
 * @param {string[]} opts.projectKeys - distinct project names to scan
 * @param {number} [opts.maxAgeMs] - min age to reclaim (default 1h)
 * @param {number|Date} [opts.now] - injectable clock (default Date.now())
 * @returns {Promise<{scanned:number, removed:number, skipped:number, errors:number}>}
 */
export async function cleanupOrphanArtifacts({
  fileClient,
  repository,
  baseDir,
  projectKeys,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
}) {
  const clock = typeof now === 'number' ? now : now.getTime();
  const summary = { scanned: 0, removed: 0, skipped: 0, errors: 0 };

  if (!fileClient || typeof fileClient.list !== 'function') {
    return summary;
  }
  const safeMaxAge = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS;
  const keys = Array.isArray(projectKeys) ? projectKeys.filter(Boolean) : [];

  for (const projectKey of keys) {
    // <base>/<projectname>/interface-sessions — the ONLY subtree scanned.
    const sessionsRoot = baseDir
      ? `${baseDir}/${projectKey}/interface-sessions`
      : `${projectKey}/interface-sessions`;

    let sessionDirs;
    try {
      sessionDirs = await fileClient.list(sessionsRoot);
    } catch (error) {
      // No sessions dir yet (fresh project) → nothing to scan. Log sanitized.
      console.log(
        `[artifact-cleanup] skip ${relRoot(sessionsRoot)}: ${sanitizedReason(error)}`,
      );
      continue;
    }

    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry || sessionEntry.is_dir === false) continue;
      const sid = sessionEntry.name;
      if (!sid) continue;
      const versionsRoot = `${sessionsRoot}/${sid}/versions`;

      let versionDirs;
      try {
        versionDirs = await fileClient.list(versionsRoot);
      } catch (error) {
        console.log(
          `[artifact-cleanup] skip ${relRoot(versionsRoot)}: ${sanitizedReason(error)}`,
        );
        continue;
      }

      for (const versionEntry of versionDirs) {
        if (!versionEntry || versionEntry.is_dir === false) continue;
        const vid = versionEntry.name;
        if (!vid) continue;

        const artifactPath = `${versionsRoot}/${vid}/prototype.html`;
        summary.scanned += 1;

        // Guard 1: a real version row references this path → keep.
        try {
          if (repository.hasVersionWithArtifactPath(artifactPath)) {
            summary.skipped += 1;
            continue;
          }
        } catch (error) {
          // DB hiccup → do NOT delete on uncertainty. Count as error, keep file.
          summary.errors += 1;
          console.log(
            `[artifact-cleanup] db-check failed for ${relArtifact(artifactPath)}: ${sanitizedReason(error)}`,
          );
          continue;
        }

        // Guard 2: age by the version dir's modified time. Unknown age → keep
        // (protects in-flight writes whose timestamp hasn't settled).
        const ageMs = ageOfModified(versionEntry.modified, clock);
        if (ageMs === null || ageMs < safeMaxAge) {
          summary.skipped += 1;
          continue;
        }

        try {
          await fileClient.remove([artifactPath]);
          summary.removed += 1;
          console.log(
            `[artifact-cleanup] reclaimed orphan ${relArtifact(artifactPath)} (age ${Math.round(ageMs / 1000)}s)`,
          );
        } catch (error) {
          summary.errors += 1;
          console.log(
            `[artifact-cleanup] remove failed for ${relArtifact(artifactPath)}: ${sanitizedReason(error)}`,
          );
        }
      }
    }
  }

  return summary;
}

// ── sanitized logging helpers ──────────────────────────────────────────────
// Never log the PAT. BladeFileError carries status + detail; we keep only the
// status and a generic reason word. For other errors we use the message with
// any `Bearer …` / `sk-blade…` token stripped defensively.
function sanitizedReason(error) {
  if (!error) return 'unknown';
  if (error.status) {
    return `http ${error.status}`;
  }
  return String(error.message || error).replace(/sk-blade-v3-\S+/gi, '<pat>').slice(0, 120);
}

// Log only the project/session/version tail, never a full absolute path that
// might echo a configured base prefix.
function relRoot(p) {
  const idx = p.indexOf('interface-sessions');
  return idx >= 0 ? p.slice(idx) : p;
}
function relArtifact(p) {
  const idx = p.indexOf('interface-sessions');
  return idx >= 0 ? p.slice(idx) : p;
}

/**
 * Create a scheduled cleanup driver: one startup-delayed sweep + an optional
 * periodic sweep (spec §异步生成 — 孤立文件回收). Mirrors the worker lifecycle
 * pattern (start/stop); server.js owns the lifecycle.
 *
 * Config:
 *   - artifactCleanupEnabled ('1' to run; otherwise no-op start)
 *   - artifactCleanupStartupDelayMs (avoid the boot spike)
 *   - artifactCleanupIntervalMs (0 = no periodic sweep; startup run still fires)
 *   - artifactCleanupMaxAgeMs (min age to reclaim)
 *
 * The driver closes over `repository` + `fileClient` + `config`; projectKeys
 * are re-read from the sessions table on each sweep so newly created projects
 * are covered without a restart.
 */
export function createArtifactCleanup({ fileClient, repository, config }) {
  let startupTimer = null;
  let intervalTimer = null;

  async function sweep(reason) {
    if (!fileClient || !repository) return null;
    if (config.artifactCleanupEnabled !== '1') return null;
    const baseDir = buildArtifactBaseDir(config.confirmedOutputPath);
    let projectKeys;
    try {
      projectKeys = repository.listDistinctProjectKeys();
    } catch (error) {
      console.log(`[artifact-cleanup] abort ${reason}: ${sanitizedReason(error)}`);
      return null;
    }
    const summary = await cleanupOrphanArtifacts({
      fileClient,
      repository,
      baseDir,
      projectKeys,
      maxAgeMs: config.artifactCleanupMaxAgeMs,
    });
    console.log(
      `[artifact-cleanup] ${reason}: scanned=${summary.scanned} removed=${summary.removed} skipped=${summary.skipped} errors=${summary.errors}`,
    );
    return summary;
  }

  function start() {
    if (config.artifactCleanupEnabled !== '1') {
      console.log('[artifact-cleanup] disabled (ARTIFACT_CLEANUP_ENABLED != 1)');
      return;
    }
    const delay = Number(config.artifactCleanupStartupDelayMs);
    const safeDelay = Number.isFinite(delay) && delay > 0 ? delay : 30000;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      sweep('startup').catch((error) => {
        console.log(`[artifact-cleanup] startup error: ${sanitizedReason(error)}`);
      });
    }, safeDelay);
    startupTimer.unref?.();

    const intervalMs = Number(config.artifactCleanupIntervalMs);
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      intervalTimer = setInterval(() => {
        sweep('periodic').catch((error) => {
          console.log(`[artifact-cleanup] periodic error: ${sanitizedReason(error)}`);
        });
      }, intervalMs);
      intervalTimer.unref?.();
      console.log(
        `[artifact-cleanup] scheduled (startup +${safeDelay}ms, periodic ${intervalMs}ms, maxAge ${config.artifactCleanupMaxAgeMs || DEFAULT_MAX_AGE_MS}ms)`,
      );
    } else {
      console.log(
        `[artifact-cleanup] scheduled (startup +${safeDelay}ms, periodic off, maxAge ${config.artifactCleanupMaxAgeMs || DEFAULT_MAX_AGE_MS}ms)`,
      );
    }
  }

  function stop() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return { start, stop, sweep };
}
