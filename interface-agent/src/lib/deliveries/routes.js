import express from 'express';

/**
 * Delivery HTTP routes (spec §API line 122, task-7 brief §C).
 *
 *   POST /api/interface-sessions/:id/deliveries/:deliveryId/retry  — idempotent retry
 *   GET  /api/interface-sessions/:id/deliveries/:deliveryId        — sanitized status
 *
 * Auth reuses T3 primitives. retry only flips failed→pending; delivered /
 * superseded / pending / delivering are no-ops (the caller gets the current
 * status and the worker is never re-triggered, so the pipeline is never pushed
 * twice for one delivery). The worker itself lives in worker.js and is created
 * in app.js (app.locals.deliveryWorker).
 *
 * Confirm is the only thing that creates deliveries (inside confirmVersion's
 * tx), so there is no "create delivery" endpoint here — the three operations
 * stay cleanly separated (spec: share / confirm / deliver are independent).
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.sessionAuth
 */
export function createDeliveriesRouter({ repository, sessionAuth }) {
  const router = express.Router();

  /** 403 when the path-param session id differs from the cookie session id. */
  function requireSessionMatch(req, res, next) {
    if (req.params.id !== req.session.id) {
      return res.status(403).json({ error: '无权操作此会话。' });
    }
    next();
  }

  /**
   * Shape a delivery row for the API. error_message is sanitized already at the
   * worker (fixed category string), but we surface only the code + a short
   * message so nothing internal (Blade OS paths, pipeline bodies) leaks. The
   * idempotency key is intentionally NOT echoed: it is an internal dedupe token
   * for the pipeline, not something the client needs or should log.
   */
  function formatDelivery(delivery) {
    const resp = {
      id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      createdAt: delivery.created_at,
    };
    if (delivery.error_code) resp.errorCode = delivery.error_code;
    if (delivery.error_message) resp.errorMessage = delivery.error_message;
    return resp;
  }

  /** Fetch + ownership-guard the delivery (must belong to the cookie session). */
  function loadOwnedDelivery(req, res) {
    const delivery = repository.getDelivery(req.params.deliveryId);
    if (!delivery || delivery.session_id !== req.session.id) {
      res.status(404).json({ error: '交付记录不存在。' });
      return null;
    }
    return delivery;
  }

  // ----------------------- POST /:id/deliveries/:deliveryId/retry

  /**
   * Idempotent retry. Only failed→pending transitions and re-triggers the
   * worker; every other status is a no-op that returns the current row. This
   * guarantees the pipeline is pushed at most once per delivery: a delivered
   * retry returns {status:'delivered'} without re-queueing.
   */
  router.post(
    '/:id/deliveries/:deliveryId/retry',
    sessionAuth.requireSession,
    requireSessionMatch,
    (req, res) => {
      const existing = loadOwnedDelivery(req, res);
      if (!existing) return;
      const refreshed = repository.retryDelivery(existing.id);
      return res.status(200).json(formatDelivery(refreshed));
    },
  );

  // --------------------------- GET /:id/deliveries/:deliveryId

  /** Read-only sanitized status (for the UI to show 交付状态 + retry button). */
  router.get(
    '/:id/deliveries/:deliveryId',
    sessionAuth.requireSession,
    requireSessionMatch,
    (req, res) => {
      const delivery = loadOwnedDelivery(req, res);
      if (!delivery) return;
      return res.status(200).json(formatDelivery(delivery));
    },
  );

  return router;
}
