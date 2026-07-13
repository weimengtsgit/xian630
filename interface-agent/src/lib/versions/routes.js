import express from 'express';
import { parseLabelPath, compareLabelPath } from '../db/numbering.js';
import { BladeFileError } from '../bladeFiles.js';

/**
 * Version tree + detail + metadata-edit + events routes (spec §API lines
 * 113-116/123, task-6 brief §A).
 *
 *   GET   /api/interface-sessions/:id/versions                    — version tree metadata
 *   GET   /api/interface-sessions/:id/versions/:versionId         — detail + branch dialogue
 *   GET   /api/interface-sessions/:id/versions/:versionId/(preview|html)
 *                                                               — immutable version HTML
 *   PATCH /api/interface-sessions/:id/versions/:versionId         — title (in place) / archive
 *   GET   /api/interface-sessions/:id/events                      — sanitized operation log
 *
 * Auth reuses T3 primitives. Every route requires requireSession (cookie) +
 * requireSessionMatch (:id === cookie session). Version-scoped routes add
 * requireSessionOwnsVersion so a cross-session version id is rejected (403)
 * even when the path-param session id is spoofed (领域规则 7/8, spec §访问控制).
 *
 * The currently SELECTED version is personal client state — nothing here ever
 * mutates the session's shared confirmed_version_id (that is T7's confirm
 * endpoint). Title edits update in place; version label + HTML are immutable.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.sessionAuth
 * @param {object|null} [opts.fileClient] - { readText(path) } for the html route
 */
export function createVersionsRouter({ repository, sessionAuth, fileClient = null }) {
  const router = express.Router();

  /** 403 when the path-param session id differs from the cookie session id. */
  function requireSessionMatch(req, res, next) {
    if (req.params.id !== req.session.id) {
      return res.status(403).json({ error: '无权操作此会话。' });
    }
    next();
  }

  const ownVersion = sessionAuth.requireSessionOwnsVersion();

  /**
   * Generation-request metadata indexed by request id, for instruction/status
   * projection onto version metadata. Reaches into the repository (NOT raw db)
   * so the SQL stays inside the repository boundary.
   */
  function requestMetaById(sessionId) {
    return new Map(
      repository
        .listGenerationRequestMetaBySession(sessionId)
        .map((r) => [r.id, r]),
    );
  }

  /** First-N-chars summary of an instruction for tree display. Shown only to
   *  the session owner (auth-gated); the full instruction never leaves the
   *  progress/events endpoints. */
  function summarizeInstruction(instruction, maxLength = 60) {
    const trimmed = String(instruction || '').trim();
    if (!trimmed) return null;
    const firstLine = trimmed.split('\n')[0].trim();
    return firstLine.length > maxLength ? firstLine.slice(0, maxLength) + '…' : firstLine;
  }

  /**
   * Format a version row (+ joined generation request) into tree metadata.
   * `confirmed` is projected from the session's confirmed_version_id so the
   * client can render the shared confirm marker without a second round trip.
   */
  function formatVersionMeta(version, session, requestById) {
    let instructionSummary = null;
    let generationStatus = null;
    if (version.generation_request_id && requestById) {
      const request = requestById.get(version.generation_request_id);
      if (request) {
        instructionSummary = summarizeInstruction(request.instruction);
        generationStatus = request.status;
      }
    }
    return {
      versionId: version.id,
      versionLabel: version.version_label,
      title: version.title,
      mainlineSequence: version.mainline_sequence,
      branchSequence: version.branch_sequence,
      labelPath: parseLabelPath(version.label_path_json),
      parentVersionId: version.parent_version_id,
      archived: version.archived_at != null,
      confirmed: session.confirmed_version_id === version.id,
      createdAt: version.created_at,
      instructionSummary,
      generationStatus,
    };
  }

  // ----------------------------------------------- GET /:id/versions

  /**
   * Version tree metadata, sorted by structured numeric label_path with
   * created_at tie-break (NOT string lex — V10 follows V2). repository
   * .getVersionTree already sorts; we re-sort the formatted output defensively
   * so any future re-ordering in the repo can't silently regress the contract.
   */
  router.get('/:id/versions', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const session = repository.getSession(req.session.id);
    if (!session) {
      return res.status(404).json({ error: '会话不存在。' });
    }

    const versions = repository.getVersionTree(session.id);
    // Index generation requests once for instruction/status projection.
    const requestById = requestMetaById(session.id);

    const formatted = versions
      .map((v) => ({ v, meta: formatVersionMeta(v, session, requestById) }))
      .sort((a, b) => {
        const byPath = compareLabelPath(a.meta.labelPath, b.meta.labelPath);
        if (byPath !== 0) return byPath;
        if (a.v.created_at < b.v.created_at) return -1;
        if (a.v.created_at > b.v.created_at) return 1;
        return 0;
      })
      .map((entry) => entry.meta);

    return res.json({ versions: formatted });
  });

  // --------------------------------------- GET /:id/versions/:versionId

  /** Version detail + ancestor-chain branch dialogue (root -> current). */
  router.get(
    '/:id/versions/:versionId',
    sessionAuth.requireSession,
    requireSessionMatch,
    ownVersion,
    (req, res) => {
      const session = repository.getSession(req.session.id);
      const version = repository.getVersion(req.params.versionId);
      // requestById for instruction/status projection on the detail node.
      const requestById = requestMetaById(session.id);

      const meta = formatVersionMeta(version, session, requestById);
      return res.json({
        ...meta,
        branchDialogue: repository.getBranchDialogue(version.id),
        contentHash: version.content_hash,
        byteSize: version.byte_size,
        artifactPath: version.artifact_path,
      });
    },
  );

  // ------------------------- GET /:id/versions/:versionId/(html|preview)

  /**
   * Immutable version HTML, proxied through Blade OS (the browser never talks
   * to Blade OS directly). 404 on a missing/unreadable artifact with a
   * sanitized message (never echoes the internal path).
   */
  router.get(
    ['/:id/versions/:versionId/html', '/:id/versions/:versionId/preview'],
    sessionAuth.requireSession,
    requireSessionMatch,
    ownVersion,
    async (req, res) => {
      const version = repository.getVersion(req.params.versionId);
      if (!fileClient) {
        return res.status(500).json({ error: '服务端未配置文件服务。' });
      }
      try {
        const html = await fileClient.readText(version.artifact_path);
        // F2: CSP sandbox with allow-scripts (SPACE not semicolon — a `;` ends
        // the sandbox directive, leaving no tokens and BLOCKING scripts). NO
        // allow-same-origin so a direct-open runs in a unique opaque origin that
        // cannot read the interface-agent edit cookie or call same-origin APIs.
        // The in-app iframe already carries sandbox="allow-scripts" (compatible).
        return res.type('text/html').set('Content-Security-Policy', 'sandbox allow-scripts').send(html);
      } catch (error) {
        if (error instanceof BladeFileError) {
          // Missing artifact → 404; other Blade OS transport faults → 502.
          // Either way the message is sanitized (never echoes the internal path).
          if (error.status === 404) {
            return res.status(404).json({ error: '版本文件不可读或已丢失。' });
          }
          console.error('[versions] read version html failed:', error.detail || error.status);
          return res.status(502).json({ error: '读取版本文件失败。' });
        }
        console.error('[versions] read version html failed:', error?.message || error);
        return res.status(502).json({ error: '读取版本文件失败。' });
      }
    },
  );

  // ------------------------------- PATCH /:id/versions/:versionId

  /**
   * Edit title (in place — does NOT create a new version; label + HTML stay
   * immutable per 领域规则 5) and/or toggle archive. Only `title` and
   * `archived` are honored; attempts to mutate version_label/html/content are
   * ignored (never silently honored).
   */
  router.patch(
    '/:id/versions/:versionId',
    sessionAuth.requireSession,
    requireSessionMatch,
    ownVersion,
    (req, res) => {
      const body = req.body || {};
      const version = repository.getVersion(req.params.versionId);
      const session = repository.getSession(req.session.id);

      const wantsTitle = Object.prototype.hasOwnProperty.call(body, 'title');
      const wantsArchived = Object.prototype.hasOwnProperty.call(body, 'archived');

      if (!wantsTitle && !wantsArchived) {
        return res.status(400).json({ error: '仅支持修改 title 或 archived。' });
      }

      let normalizedTitle = null;
      if (wantsTitle) {
        if (typeof body.title !== 'string' || !body.title.trim()) {
          return res.status(400).json({ error: '标题不能为空。' });
        }
        normalizedTitle = body.title.trim().slice(0, 120);
      }
      if (wantsArchived) {
        if (typeof body.archived !== 'boolean') {
          return res.status(400).json({ error: 'archived 必须为布尔值。' });
        }
        // F5: the confirmed version must not be archivable (spec: only
        // non-confirmed branches are archivable). Un-archiving (archived:false)
        // is always allowed. Archiving a non-confirmed version is allowed.
        if (body.archived === true && session.confirmed_version_id === version.id) {
          return res.status(409).json({ error: '已确认版本不可归档。' });
        }
      }

      repository.tx(() => {
        if (wantsTitle) repository.updateVersionTitle(version.id, normalizedTitle);
        if (wantsArchived) repository.setVersionArchived(version.id, body.archived);
      });

      const refreshed = repository.getVersion(version.id);
      const requestById = requestMetaById(session.id);
      return res.json(formatVersionMeta(refreshed, session, requestById));
    },
  );

  // ----------------------------------------------- GET /:id/events

  /**
   * Sanitized operation log, ascending seq. payloadSummary is a per-type
   * whitelist projection of the stored payload so internal artifact paths and
   * any accidental sensitive field never reach the response. Version switching
   * is personal state and is intentionally absent from this shared stream.
   */
  router.get('/:id/events', sessionAuth.requireSession, requireSessionMatch, (req, res) => {
    const events = repository.listEvents(req.session.id);
    return res.json({
      events: events.map((event) => ({
        seq: event.seq,
        type: event.type,
        payloadSummary: sanitizeEventPayload(
          event.type,
          safelyParseJson(event.payload_json),
        ),
        createdAt: event.created_at,
      })),
    });
  });

  return router;
}

/** Parse stored payload_json without throwing on malformed/empty values. */
function safelyParseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Project a stored event payload into a safe summary via a per-type whitelist.
 * Unknown fields and unknown event types collapse to an empty object, so a
 * future payload that accidentally captures an instruction or token can never
 * leak through the events endpoint.
 */
function sanitizeEventPayload(type, payload) {
  if (!payload || typeof payload !== 'object') return {};
  switch (type) {
    case 'generation_succeeded':
      return { versionId: payload.versionId, versionLabel: payload.versionLabel };
    case 'generation_failed':
      return { errorCode: payload.errorCode };
    case 'legacy_imported':
      // artifactPath is an internal Blade OS path — omit it.
      return { versionId: payload.versionId, versionLabel: payload.versionLabel };
    case 'confirm':
      return { versionId: payload.versionId, versionLabel: payload.versionLabel };
    case 'share_created':
    case 'share_revoked':
      // versionLabel only — NEVER the plaintext token or shareId-with-token.
      return { versionLabel: payload.versionLabel };
    case 'delivery_delivered':
      return { versionLabel: payload.versionLabel };
    case 'delivery_failed':
      return { errorCode: payload.errorCode };
    default:
      // Unknown types collapse to {} so a future payload that accidentally
      // captures an instruction or token can never leak via the events stream.
      return {};
  }
}
