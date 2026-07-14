import crypto from 'node:crypto';
import { buildArtifactPath } from './artifactPath.js';

/**
 * Thrown at a specific generation step so the catch block can classify the
 * error_code without inspecting stack traces or messages (which might contain
 * sensitive data). The outer catch maps it to a sanitized DB error_message.
 */
class GenerationStepError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = 'GenerationStepError';
    this.code = code; // 'model' | 'html' | 'blade' | 'internal'
  }
}

/**
 * Heuristic check that the model returned a usable HTML document: non-empty and
 * contains an <html ...> or <!doctype html> tag. Catches the common failure
 * mode where the model returns error text or an empty string.
 */
function isValidGeneratedHtml(html) {
  if (typeof html !== 'string') return false;
  const trimmed = html.trim();
  if (!trimmed) return false;
  return /<html[\s>]/i.test(trimmed) || /<!doctype\s+html>/i.test(trimmed);
}

/**
 * Short title from the instruction (first line, truncated). Used as the version
 * title when the user has not provided one — the full instruction is never
 * stored as the title to avoid leaking it in list views.
 */
function summarizeInstruction(instruction, maxLength = 40) {
  const trimmed = String(instruction || '').trim();
  if (!trimmed) return '生成的界面稿';
  const firstLine = trimmed.split('\n')[0].trim();
  return firstLine.length > maxLength ? firstLine.slice(0, maxLength) + '…' : firstLine;
}

/**
 * Map any thrown error to a sanitized { code, message }. The message is a
 * fixed string per error category — it NEVER includes the instruction, the
 * Blade OS PAT, model response bodies, or stack traces. The original error is
 * logged separately at console.error for operator debugging.
 */
function classifyError(error) {
  if (error instanceof GenerationStepError) {
    return { code: error.code, message: error.message };
  }
  // Unexpected errors (DB faults, programming bugs) get a generic message so
  // no internal detail leaks to the API response.
  return { code: 'internal', message: '生成过程中发生内部错误。' };
}

/**
 * Create a single-instance, serial generation worker.
 *
 * Processing flow (spec §异步生成流程):
 *   1. Atomic claim: tx-internal UPDATE status='generating' WHERE status='queued'.
 *   2. IO OUTSIDE tx (tx is synchronous, can't await):
 *      - read base version HTML from Blade OS
 *      - project ancestor instructions (root → base only — never siblings/descendants)
 *      - call deepseekClient.generateHtml
 *      - validate the returned HTML
 *      - upload the immutable artifact to Blade OS
 *   3. Atomic success tx: commitVersion + completeGenerationRequest +
 *      insertEvent — all in one synchronous tx. Any failure rolls back: no
 *      version, no label consumed, no half-baked state.
 *   4. Failure path: mark request failed (no version, no label). The orphaned
 *      uploaded file (if any) is left for T8's sweep.
 *
 * Concurrency: the worker processes one request at a time. For two requests on
 * the same mainline head, the first's commitVersion advances the head; the
 * second re-reads head inside its tx and becomes a branch (T2 serialization).
 * The worker NEVER caches the head or pre-computes a label.
 *
 * Restart: recover() resets all 'generating' requests to 'queued' on boot. A
 * crashed request re-runs from scratch (may call the model a second time), but
 * because the success tx is atomic and commitVersion is idempotent per version
 * id, at most one version is ever produced.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.deepseekClient - { generateHtml({message, history, currentHtml}) }
 * @param {object|null} opts.fileClient - { readText(path), uploadText(path, html) }
 * @param {object} opts.config
 */
export function createGenerationWorker({ repository, deepseekClient, fileClient, config }) {
  let intervalId = null;
  let processing = false;

  /**
   * Reset all 'generating' requests to 'queued' (restart recovery). Returns
   * the count of reset rows so the caller can log how many were recovered.
   */
  function recover() {
    const count = repository.resetGeneratingToQueued();
    if (count > 0) {
      console.log(`[worker] restart recovery: re-queued ${count} orphaned 'generating' request(s)`);
    }
    return count;
  }

  /**
   * Process a single generation request end-to-end. Returns true if the
   * request was claimed and processed (succeeded or failed), false if it was
   * already claimed by another tick.
   */
  async function processRequest(requestId) {
    // Step 1: atomic claim (tx-internal)
    const claimed = repository.claimGenerationRequest(requestId);
    if (!claimed) return false;

    const request = repository.getGenerationRequest(requestId);
    if (!request) return false;

    try {
      let html;

      // Sp5: restart resume. If the model already returned on a prior attempt
      // (staged_html persisted before the crash), SKIP the model call and proceed
      // straight from the staged HTML — honoring "no duplicate model call" across
      // restart. Otherwise run the full first-attempt flow (base read + ancestor
      // context + model call) and stage the result immediately after it returns.
      if (request.staged_html) {
        console.log(`[worker] ${requestId} resuming from staged_html (skipping model call)`);
        html = request.staged_html;
      } else {
        // Step 2: IO OUTSIDE tx (async, can't be inside the sync tx)
        const baseVersion = request.base_version_id
          ? repository.getVersion(request.base_version_id)
          : null;

        let baseHtml = '';
        if (baseVersion && fileClient) {
          try {
            baseHtml = await fileClient.readText(baseVersion.artifact_path);
          } catch (error) {
            throw new GenerationStepError('blade', '读取基线版本文件失败。');
          }
        }

        // Ancestor instructions: root → base only. getBranchInstructions walks
        // parent_version_id, so siblings/descendants are excluded by construction
        // (领域规则 8). Map to the {role, content} shape buildMessages expects.
        const ancestorInstructions = request.base_version_id
          ? repository.getBranchInstructions(request.base_version_id)
          : [];
        const history = ancestorInstructions.map((content) => ({ role: 'user', content }));

        try {
          html = await deepseekClient.generateHtml({
            message: request.instruction,
            history,
            currentHtml: baseHtml,
          });
        } catch (error) {
          throw new GenerationStepError('model', '模型生成失败。');
        }

        // M3: persist staged_html as the FIRST statement after the model returns
        // — before validation, upload, or any other await/processing — to
        // minimize the crash-window in which a restart would re-call the model.
        // (Residual: a crash in the sub-millisecond window between model return
        // and this synchronous write may re-call the model once. Exactly-once
        // needs model-side idempotency, which DeepSeek does not offer — roadmap.)
        // Sp5: on restart resume, staged_html presence skips the model call.
        repository.setStagedHtml(requestId, html);
      }

      if (!isValidGeneratedHtml(html)) {
        throw new GenerationStepError('html', '生成的 HTML 内容无效。');
      }

      // F6: transition generating → saving right before the upload + readback +
      // hash-verify step (after model success + staged_html). Restart recovery
      // treats 'saving' like 'generating' (re-queue, resume from staged_html).
      repository.markGenerationSaving(requestId);

      // Pre-generate the version id so the artifact path is stable. Hash and
      // size are computed from the final HTML (no mutation after upload).
      const versionId = crypto.randomUUID();
      const session = repository.getSession(request.session_id);
      const artifactPath = buildArtifactPath(
        config.confirmedOutputPath,
        session.project_key,
        session.id,
        versionId,
      );
      const buf = Buffer.from(html, 'utf8');
      const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
      const byteSize = buf.byteLength;

      try {
        await fileClient.uploadText(artifactPath, html);
      } catch (error) {
        throw new GenerationStepError('blade', '文件写入失败。');
      }

      // Fix 7: read back the uploaded artifact and verify the SHA-256 matches
      // the pre-upload hash (spec §HTML 产物: "写入后计算并校验 SHA-256"). A
      // mismatch (silent corruption, partial write, storage proxy mutation)
      // fails the request — NO version is created, NO label consumed. The
      // orphaned upload is left for T8's sweep.
      let readBack;
      try {
        readBack = await fileClient.readText(artifactPath);
      } catch (error) {
        throw new GenerationStepError('blade', '写入后校验读取失败。');
      }
      const readBackHash = crypto
        .createHash('sha256')
        .update(Buffer.from(readBack, 'utf8'))
        .digest('hex');
      if (readBackHash !== contentHash) {
        throw new GenerationStepError('blade', '写入后哈希校验不一致。');
      }

      // Step 3: atomic success tx (synchronous). commitVersion re-reads the
      // mainline head INSIDE this tx, so concurrent commits serialize: first
      // advances mainline, second branches. Any throw rolls back everything.
      repository.tx(() => {
        const version = repository.commitVersion({
          sessionId: request.session_id,
          parentVersionId: request.base_version_id,
          id: versionId,
          generationRequestId: requestId,
          artifactPath,
          contentHash,
          byteSize,
          title: summarizeInstruction(request.instruction),
          createdBy: request.created_by,
        });
        repository.completeGenerationRequest(requestId, version.id);
        repository.insertEvent({
          sessionId: request.session_id,
          type: 'generation_succeeded',
          payload: { versionId: version.id, versionLabel: version.version_label },
          createdBy: request.created_by,
        });
      });

      // 回调 agent-pipeline:生成成功 → running(best-effort,不影响生成结果;
      // 用户仍在调整界面,尚未交付 → 卡片保持"进行中")
      if (config.pipelineStageCompleteUrl && session?.project_key) {
        try {
          await fetch(config.pipelineStageCompleteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectname: session.project_key, status: 'running' }),
            signal: AbortSignal.timeout(config.pipelineCompleteTimeoutMs || 5000),
          });
        } catch { /* best-effort:回调失败不影响已成功的生成 */ }
      }

      console.log(`[worker] generation ${requestId} succeeded`);
      return true;
    } catch (error) {
      // Step 4: failure path — no version, no label consumed, no event ambiguity.
      const { code, message } = classifyError(error);
      try {
        repository.failGenerationRequest(requestId, code, message);
        repository.insertEvent({
          sessionId: request.session_id,
          type: 'generation_failed',
          payload: { errorCode: code },
          createdBy: request.created_by,
        });
      } catch (failError) {
        // If even the failure write breaks (e.g. DB gone), the request stays
        // 'generating' and restart recovery will re-queue it. Log loudly.
        console.error(`[worker] CRITICAL: could not mark request ${requestId} as failed:`, failError.message);
      }
      // Log the sanitized category + message (never the original error which
      // may contain the instruction, PAT, or model response body).
      console.error(`[worker] generation ${requestId} failed [${code}]: ${message}`);
      return true;
    }
  }

  /**
   * Find and process the next queued request. Guarded by `processing` so the
   * setInterval tick never overlaps with an in-flight request. Tests call this
   * directly (without start()) for deterministic processing.
   */
  async function tick() {
    if (processing) return;
    const next = repository.findNextQueuedRequest();
    if (!next) return;
    processing = true;
    try {
      await processRequest(next.id);
    } finally {
      processing = false;
    }
  }

  /**
   * Start the poll loop. Runs recover() first so orphaned requests from a
   * previous crash are re-queued, then polls at generationPollIntervalMs.
   */
  function start() {
    recover();
    const intervalMs = config.generationPollIntervalMs || 1500;
    intervalId = setInterval(() => {
      tick().catch((error) => {
        console.error('[worker] tick error:', error.message);
      });
    }, intervalMs);
    // Don't keep the process alive just for the poll loop (server.listen does).
    intervalId.unref?.();
    console.log(`[worker] started (poll interval ${intervalMs}ms)`);
  }

  /** Stop the poll loop. The current in-flight request (if any) runs to completion. */
  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      console.log('[worker] stopped');
    }
  }

  return { start, stop, tick, processRequest, recover };
}
