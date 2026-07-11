import { BladeFileError } from '../bladeFiles.js';
import { validateProjectKey } from '../validation.js';

/**
 * Delivery step error: thrown at a specific step so the catch can classify the
 * error_code WITHOUT inspecting the original error's message/stack (which may
 * contain sensitive Blade OS detail or pipeline response bodies). The outer
 * catch maps it to a fixed, sanitized DB error_message. Mirrors the generation
 * worker's GenerationStepError pattern (T5).
 */
class DeliveryStepError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = 'DeliveryStepError';
    this.code = code; // 'blade' | 'config' | 'pipeline' | 'internal'
  }
}

/**
 * Map any thrown error to a sanitized { code, message }. The message is a fixed
 * string per category — it NEVER includes the Blade OS PAT, pipeline response
 * bodies, internal paths, or stack traces. The original error is logged at
 * console.error for operator debugging. Mirrors classifyError in T5.
 */
function classifyDeliveryError(error) {
  if (error instanceof DeliveryStepError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal', message: '交付过程中发生内部错误。' };
}

/**
 * Build the downstream compatibility output path (spec §确认与交付流程 + §HTML 产物):
 *   <dir of confirmedOutputPath>/<projectKey>/<filename of confirmedOutputPath>
 * e.g. confirmedOutputPath "共享/prototype.html", projectKey "demo" →
 *      "共享/demo/prototype.html"
 *
 * Mirrors the path logic in app.js POST /api/previews so confirmed deliveries
 * land exactly where downstream consumers already look. Extracted here so the
 * worker and the (legacy) previews route share one shape.
 */
function buildDeliveryPath(confirmedOutputPath, projectKey) {
  const confirmed = confirmedOutputPath || '';
  const slash = confirmed.lastIndexOf('/');
  const dir = slash >= 0 ? confirmed.slice(0, slash) : '';
  const filename = slash >= 0 ? confirmed.slice(slash + 1) : confirmed || 'prototype.html';
  // F1: validate projectKey before interpolating into the delivery path.
  const safeProject = validateProjectKey(projectKey);
  return dir ? `${dir}/${safeProject}/${filename}` : `${safeProject}/${filename}`;
}

/**
 * Create a single-instance, serial delivery worker (spec §确认与交付流程).
 *
 * Processing flow (modeled on the T5 generation worker):
 *   1. Atomic claim: tx-internal UPDATE status='delivering' WHERE status='pending'.
 *   2. IO OUTSIDE tx (the tx is synchronous, can't await):
 *      - read the pinned version's HTML from Blade OS
 *      - upload it to the compatibility path 共享/<project>/prototype.html
 *      - POST the pipeline-stage-complete callback with a deterministic
 *        idempotency key (skipped when pipelineStageCompleteUrl is empty)
 *   3. Atomic success tx (synchronous): UPDATE status='delivered' guarded on
 *      status='delivering' + delivery_delivered event. If the guard matches 0
 *      rows the delivery was superseded mid-flight → skip the event (it is now
 *      'superseded'; the new pending delivery carries the can).
 *   4. Failure path: status='failed' (guarded on 'delivering') + sanitized
 *      error_code/message + delivery_failed event. The CONFIRM is NEVER undone
 *      — confirmed_version_id is untouched here.
 *
 * Independence (spec): share / confirm / deliver are three independent
 * operations. A delivery failure does not roll back the confirm; the UI shows
 * "已确认，交付失败，可重试".
 *
 * Idempotency: retry only flips failed→pending. A delivered/superseded retry is
 * a no-op (the worker never re-claims it). The pipeline POST carries the
 * delivery's deterministic idempotency_key so even a restart-re-run (which may
 * re-post) is deduped by the pipeline side, and on the interface-agent side at
 * most one delivery row ever reaches 'delivered'.
 *
 * Restart: recover() resets 'delivering'→'pending' on boot. A crashed delivery
 * re-runs its IO (possibly re-posting the pipeline), but the status machine +
 * idempotency key prevent a duplicate successful push.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object|null} opts.fileClient - { readText(path), uploadText(path, html) }
 * @param {object} opts.config
 * @param {object} [opts.fetchClient] - WHATWG fetch for the pipeline callback
 */
export function createDeliveryWorker({ repository, fileClient, config, fetchClient }) {
  let intervalId = null;
  let processing = false;

  /** Restart recovery: reset 'delivering'→'pending'. Returns reset count. */
  function recover() {
    const count = repository.resetDeliveringToPending();
    if (count > 0) {
      console.log(`[delivery-worker] restart recovery: re-pending ${count} orphaned 'delivering' delivery(ies)`);
    }
    return count;
  }

  /**
   * POST the pipeline stage-complete callback with a deterministic idempotency
   * key so the pipeline can dedupe a restart re-run. Throws DeliveryStepError
   * ('pipeline') on a non-2xx response so the worker marks the delivery failed
   * (confirm is NOT undone). No-op when pipelineStageCompleteUrl is unset.
   *
   * Body is the legacy-compatible `{status:'completed'}` only — identical to
   * the original /api/previews callback — so existing pipeline endpoints that
   * only read status are unaffected by extra fields. The idempotency key (and
   * projectname/versionLabel hints) travel as request headers; endpoints that
   * don't know them simply ignore unknown headers, and the key is still
   * available for pipeline-side dedup where supported.
   */
  async function notifyPipeline(delivery, version, projectKey) {
    if (!config.pipelineStageCompleteUrl) {
      return { skipped: true };
    }
    if (!fetchClient) {
      throw new DeliveryStepError('config', '未配置流水线回调通道。');
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.pipelineCompleteTimeoutMs || 5000,
    );
    try {
      const response = await fetchClient(config.pipelineStageCompleteUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Idempotency travels via header so the body stays legacy-shaped.
          // projectname / version label are hints for pipeline-side logging;
          // they carry no secrets and unknown headers are safely ignored.
          'X-Idempotency-Key': delivery.idempotency_key || '',
          'X-Interface-Project': projectKey || '',
          'X-Interface-Version-Label': version?.version_label || '',
        },
        body: JSON.stringify({ status: 'completed' }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DeliveryStepError('pipeline', '流水线通知失败。');
      }
      return { skipped: false };
    } catch (error) {
      if (error instanceof DeliveryStepError) throw error;
      throw new DeliveryStepError('pipeline', '流水线通知失败。');
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Process a single delivery end-to-end. Returns true if the delivery was
   * claimed and processed (delivered / failed / superseded-mid-flight), false
   * if it was already claimed by another tick.
   */
  async function processDelivery(deliveryId) {
    /**
     * Sp1: re-read the session and test whether this delivery's version is STILL
     * the session's confirmed version. Only the currently-confirmed version's
     * delivery may produce external effects (file write / pipeline push); a
     * superseded version's delivery is inert. Used immediately before each
     * external effect (re-read each time) so a confirm landing during an await
     * is caught at the next gate. Kept alongside the status='delivering' re-check
     * (defense in depth + semantic correctness).
     */
    const isStillConfirmedVersion = (delivery) => {
      const session = repository.getSession(delivery.session_id);
      return Boolean(session) && session.confirmed_version_id === delivery.version_id;
    };
    // Step 1: atomic claim (tx-internal)
    const claimed = repository.claimDelivery(deliveryId);
    if (!claimed) return false;

    const delivery = repository.getDelivery(deliveryId);
    if (!delivery) return false;

    const session = repository.getSession(delivery.session_id);
    const version = repository.getVersion(delivery.version_id);
    if (!session || !version) {
      // Orphaned reference — shouldn't happen (FK + ownership). Fail safely.
      const failed = repository.failDelivery(deliveryId, 'internal', '交付引用的版本或会话不存在。');
      if (failed) {
        repository.insertEvent({
          sessionId: delivery.session_id,
          type: 'delivery_failed',
          payload: { deliveryId, errorCode: 'internal' },
          createdBy: 'delivery-worker',
        });
      }
      return true;
    }

    try {
      // Step 2: IO OUTSIDE tx (async; cannot be inside the synchronous tx).
      if (!fileClient) {
        throw new DeliveryStepError('config', '服务端未配置 Blade OS 文件服务。');
      }

      let html;
      try {
        html = await fileClient.readText(version.artifact_path);
      } catch (error) {
        if (error instanceof BladeFileError && error.status === 404) {
          throw new DeliveryStepError('blade', '版本文件不可读或已丢失。');
        }
        throw new DeliveryStepError('blade', '读取版本文件失败。');
      }

      // Fix 6 + Sp1: re-check the delivery is still 'delivering' (not
      // superseded) AND that its version is still the session's confirmed
      // version, BEFORE the compat file write. A supersede that landed during
      // the readText await must NOT produce a file write. Abort cleanly.
      const beforeWrite = repository.getDelivery(deliveryId);
      if (!beforeWrite || beforeWrite.status !== 'delivering') {
        console.log(`[delivery-worker] ${deliveryId} superseded before file write — aborting`);
        return true;
      }
      if (!isStillConfirmedVersion(delivery)) {
        console.log(`[delivery-worker] ${deliveryId} version no longer confirmed before file write — aborting`);
        return true;
      }

      const compatPath = buildDeliveryPath(config.confirmedOutputPath, session.project_key);
      try {
        await fileClient.uploadText(compatPath, html);
      } catch (error) {
        throw new DeliveryStepError('blade', '写入共享文件失败。');
      }

      // Fix 6 + Sp1: re-check again BEFORE the pipeline notify. A supersede that
      // landed during the uploadText await must NOT push the pipeline even
      // though the file was already written. The file write is idempotent (same
      // content), but the pipeline push is an external effect. The version gate
      // re-reads the session so a confirm that moved confirmed_version_id is
      // caught here even if the delivery row's status lagged.
      const beforeNotify = repository.getDelivery(deliveryId);
      if (!beforeNotify || beforeNotify.status !== 'delivering') {
        console.log(`[delivery-worker] ${deliveryId} superseded before pipeline notify — aborting`);
        return true;
      }
      if (!isStillConfirmedVersion(delivery)) {
        console.log(`[delivery-worker] ${deliveryId} version no longer confirmed before pipeline notify — aborting`);
        return true;
      }

      // M2: durable pipeline-notify tracking. If notified_at is already set (a
      // prior attempt notified the pipeline but crashed before marking delivered),
      // SKIP the re-notify — the downstream already got this delivery's stable
      // X-Idempotency-Key. Otherwise notify, then record notified_at (guarded tx)
      // BEFORE the delivered tx so a crash between them does not re-notify.
      // (Residual: crash DURING the HTTP itself → notified_at unset → re-notify
      // with the same stable key → downstream must durably dedup.)
      const notifyCheck = repository.getDelivery(deliveryId);
      const alreadyNotified = notifyCheck?.notified_at != null;
      if (!alreadyNotified) {
        await notifyPipeline(delivery, version, session.project_key);
        repository.markDeliveryNotified(deliveryId);
      } else {
        console.log(`[delivery-worker] ${deliveryId} already notified — skipping re-notify`);
      }

      // Step 3: atomic success tx (synchronous). Guard on status='delivering':
      // if a new confirm superseded this delivery mid-flight, this matches 0
      // rows and we skip the delivered event (it is now 'superseded'). The
      // status write + event are ONE tx so a crash between them can never leave
      // a delivered delivery without its event (or vice versa).
      let delivered = false;
      repository.tx(() => {
        delivered = repository.completeDelivery(deliveryId);
        if (delivered) {
          repository.insertEvent({
            sessionId: delivery.session_id,
            type: 'delivery_delivered',
            payload: { deliveryId, versionLabel: version.version_label },
            createdBy: 'delivery-worker',
          });
        }
      });
      console.log(`[delivery-worker] ${deliveryId} ${delivered ? 'delivered' : 'superseded mid-flight'}`);
      return true;
    } catch (error) {
      // Step 4: failure path. Confirm is NEVER undone (confirmed_version_id is
      // not touched here). Guarded on 'delivering' so a superseded-mid-flight
      // delivery is not flipped to failed either. Status + event in one tx.
      const { code, message } = classifyDeliveryError(error);
      let failed = false;
      repository.tx(() => {
        failed = repository.failDelivery(deliveryId, code, message);
        if (failed) {
          repository.insertEvent({
            sessionId: delivery.session_id,
            type: 'delivery_failed',
            payload: { deliveryId, errorCode: code },
            createdBy: 'delivery-worker',
          });
        }
      });
      console.error(`[delivery-worker] ${deliveryId} failed [${code}]: ${message}`);
      return true;
    }
  }

  /** Find and process the next pending delivery (guarded against overlap). */
  async function tick() {
    if (processing) return;
    const next = repository.findNextPendingDelivery();
    if (!next) return;
    processing = true;
    try {
      await processDelivery(next.id);
    } finally {
      processing = false;
    }
  }

  /** Start the poll loop: recover() first, then poll at deliveryPollIntervalMs. */
  function start() {
    recover();
    const intervalMs = config.deliveryPollIntervalMs || 1500;
    intervalId = setInterval(() => {
      tick().catch((error) => {
        console.error('[delivery-worker] tick error:', error.message);
      });
    }, intervalMs);
    intervalId.unref?.();
    console.log(`[delivery-worker] started (poll interval ${intervalMs}ms)`);
  }

  /** Stop the poll loop. The in-flight delivery (if any) runs to completion. */
  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      console.log('[delivery-worker] stopped');
    }
  }

  return { start, stop, tick, processDelivery, recover };
}
