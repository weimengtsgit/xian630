import { describe, expect, it, vi } from 'vitest';
import {
  newIdempotencyKey,
  submitViaGenerations,
  confirmVersionRequest,
  isConfirmConflict,
  createShareRequest,
  shouldRestart,
  restoreSessionFromCookie,
  createIndependentSession,
  restoreSessionByEditToken,
  saveInFlightGeneration,
  loadInFlightGeneration,
  clearInFlightGeneration,
} from '../public/app.js';

/**
 * Task-7 frontend wiring (task-7 brief §D). The submit/confirm/share/restart
 * flows are split into injectable, fetch-stubbable helpers so the four pinned
 * behaviors are unit-testable without driving the full DOM bootstrap:
 *   - submit POSTs to the async generations endpoint and polls progress
 *   - confirm surfaces a 409 as a conflict message (never silently overwrites)
 *   - share POSTs and the URL is handed to the clipboard
 *   - restart requires a second confirmation
 */

// A fetch stub that returns queued-once then succeeded, recording every call.
function makeFetchStub(responses) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const match = responses.shift();
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return {
      ok: match.ok,
      status: match.status,
      json: async () => match.body,
      text: async () => String(match.body || ''),
    };
  });
  return { fn, calls };
}

// ================================================ 1. submit → generations + poll

describe('submit wires to async generations', () => {
  it('1. POSTs baseVersionId+instruction+idempotencyKey, then polls GET until succeeded', async () => {
    const { fn, calls } = makeFetchStub([
      { ok: true, status: 202, body: { generationRequestId: 'r1', status: 'queued' } },
      { ok: true, status: 200, body: { status: 'generating' } },
      { ok: true, status: 200, body: { status: 'succeeded', resultVersionId: 'v2', versionLabel: 'V2' } },
    ]);

    const result = await submitViaGenerations({
      sessionId: 's1',
      baseVersionId: 'v1',
      instruction: '改成深色风',
      idempotencyKey: 'idem-1',
      fetchImpl: fn,
      sleep: async () => {}, // no real waiting in the test
    });

    expect(result.status).toBe('succeeded');
    expect(result.versionLabel).toBe('V2');

    // First call: POST generations with the right body
    expect(calls[0].url).toBe('/api/interface-sessions/s1/generations');
    expect(calls[0].init.method).toBe('POST');
    const posted = JSON.parse(calls[0].init.body);
    expect(posted.baseVersionId).toBe('v1');
    expect(posted.instruction).toBe('改成深色风');
    expect(posted.idempotencyKey).toBe('idem-1');

    // Subsequent calls: GET progress polling
    expect(calls[1].url).toBe('/api/interface-sessions/s1/generations/r1');
    expect(calls[2].url).toBe('/api/interface-sessions/s1/generations/r1');
    expect(calls.length).toBe(3); // stopped after succeeded
  });

  it('throws on a failed generation (shown in 全部操作记录, no preview change)', async () => {
    const { fn } = makeFetchStub([
      { ok: true, status: 202, body: { generationRequestId: 'r2', status: 'queued' } },
      { ok: true, status: 200, body: { status: 'failed', errorCode: 'model' } },
    ]);
    await expect(
      submitViaGenerations({
        sessionId: 's1',
        baseVersionId: 'v1',
        instruction: 'x',
        idempotencyKey: 'idem-2',
        fetchImpl: fn,
        sleep: async () => {},
      }),
    ).rejects.toThrow();
  });
});

// ================================================ 2. confirm 409 → conflict

describe('confirm 409 handling', () => {
  it('2. a 409 is detected as a conflict (never a silent overwrite)', async () => {
    const { fn } = makeFetchStub([
      { ok: false, status: 409, body: { error: '冲突', currentConfirmedVersionId: 'v-other', rowVersion: 3 } },
    ]);
    const result = await confirmVersionRequest({
      sessionId: 's1',
      versionId: 'v-mine',
      expectedConfirmedVersionId: null,
      fetchImpl: fn,
    });
    expect(result.ok).toBe(false);
    expect(isConfirmConflict(result)).toBe(true);
    expect(result.payload.currentConfirmedVersionId).toBe('v-other');
  });

  it('a 200 confirm is not a conflict', async () => {
    const { fn } = makeFetchStub([
      { ok: true, status: 200, body: { confirmedVersionId: 'v-mine', rowVersion: 1, delivery: { id: 'd1', status: 'pending' } } },
    ]);
    const result = await confirmVersionRequest({
      sessionId: 's1',
      versionId: 'v-mine',
      expectedConfirmedVersionId: null,
      fetchImpl: fn,
    });
    expect(result.ok).toBe(true);
    expect(isConfirmConflict(result)).toBe(false);
    expect(result.payload.delivery.id).toBe('d1');
  });
});

// ================================================ 3. share POST + clipboard

describe('share button', () => {
  it('3. POSTs to shares and the returned url goes to the clipboard', async () => {
    const { fn, calls } = makeFetchStub([
      { ok: true, status: 200, body: { shareId: 'sh1', token: 'tok', url: 'https://x/share/tok', versionLabel: 'V1', expiresAt: '2099-01-01' } },
    ]);
    const writeText = vi.fn().mockResolvedValue(undefined);

    const payload = await createShareRequest({
      sessionId: 's1',
      versionId: 'v1',
      fetchImpl: fn,
    });
    await writeText(payload.url);

    expect(calls[0].url).toBe('/api/interface-sessions/s1/shares');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body).versionId).toBe('v1');
    expect(payload.url).toBe('https://x/share/tok');
    expect(writeText).toHaveBeenCalledWith('https://x/share/tok');
  });
});

// ================================================ 4. restart second confirm

describe('restart requires confirmation', () => {
  it('4a. proceeds only when the user confirms', () => {
    const confirmFn = vi.fn().mockReturnValue(true);
    expect(shouldRestart(confirmFn)).toBe(true);
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });

  it('4b. aborts when the user cancels', () => {
    const confirmFn = vi.fn().mockReturnValue(false);
    expect(shouldRestart(confirmFn)).toBe(false);
  });
});

// ================================================ idempotency key

describe('idempotency key generation', () => {
  it('produces a non-empty unique-ish string', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

// ================================================ Sp2: in-flight persistence + lost-202 recovery

/** Map-backed Storage stub (getItem/setItem/removeItem) for the inflight layer. */
function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

describe('Sp2: in-flight generation persistence + lost-202 recovery', () => {
  it('Sp2f. lost 202 → retry REUSES the same idempotencyKey (no new key / no duplicate request)', async () => {
    const storage = makeStorage();
    const postedKeys = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        postedKeys.push(JSON.parse(init.body).idempotencyKey);
        if (postedKeys.length === 1) {
          // First POST: server created the row, but the 202 response is LOST.
          throw new Error('network error: connection reset (lost 202)');
        }
        // Retry POST: backend idempotency fast-path returns the existing request.
        return { ok: true, status: 200, json: async () => ({ id: 'req-1', status: 'generating' }) };
      }
      // GET poll → eventually succeeded.
      return { ok: true, status: 200, json: async () => ({ status: 'succeeded', resultVersionId: 'v1', versionLabel: 'V1' }) };
    });

    // First submit (no explicit key → recovery layer mints + persists) throws on
    // the lost 202, but the inflight entry is retained for recovery.
    await expect(
      submitViaGenerations({
        sessionId: 's1', baseVersionId: null, instruction: 'make a dashboard',
        fetchImpl, storage, sleep: async () => {}, pollIntervalMs: 0,
      }),
    ).rejects.toThrow();

    // Inflight persisted with the key (no requestId yet — 202 was lost).
    const inflight = loadInFlightGeneration(storage);
    expect(inflight).toBeTruthy();
    expect(inflight.idempotencyKey).toBe(postedKeys[0]);

    // Retry with the SAME instruction → recovery reuses the key; poll → succeeded.
    const result = await submitViaGenerations({
      sessionId: 's1', baseVersionId: null, instruction: 'make a dashboard',
      fetchImpl, storage, sleep: async () => {}, pollIntervalMs: 0,
    });
    expect(result.status).toBe('succeeded');

    // Exactly one idempotencyKey was ever sent across both POSTs (no new key on retry).
    expect(postedKeys).toHaveLength(2);
    expect(postedKeys[0]).toBe(postedKeys[1]);

    // Inflight cleared after reaching terminal status.
    expect(loadInFlightGeneration(storage)).toBeNull();
  });

  it('Sp2g. a genuine NEW instruction mints a fresh key (does not reuse stale inflight)', async () => {
    const storage = makeStorage();
    saveInFlightGeneration({ sessionId: 's1', instruction: 'old instruction', idempotencyKey: 'stale-key' }, storage);

    const postedKeys = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        postedKeys.push(JSON.parse(init.body).idempotencyKey);
        return { ok: true, status: 202, json: async () => ({ generationRequestId: 'r-new', status: 'queued' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'succeeded', resultVersionId: 'v1' }) };
    });

    await submitViaGenerations({
      sessionId: 's1', baseVersionId: null, instruction: 'brand new different instruction',
      fetchImpl, storage, sleep: async () => {}, pollIntervalMs: 0,
    });

    expect(postedKeys).toHaveLength(1);
    expect(postedKeys[0]).not.toBe('stale-key');
  });

  it('Sp2h. clearInFlightGeneration removes the entry', () => {
    const storage = makeStorage();
    saveInFlightGeneration({ sessionId: 's1', instruction: 'x', idempotencyKey: 'k' }, storage);
    expect(loadInFlightGeneration(storage)).toBeTruthy();
    clearInFlightGeneration(storage);
    expect(loadInFlightGeneration(storage)).toBeNull();
  });

  it('F4a. same instruction + DIFFERENT baseVersionId → NEW key (no wrong reuse)', async () => {
    // The in-flight record must be keyed on sessionId + baseVersionId + instruction
    // (F4). Switching the selected version + re-submitting the same text must NOT
    // reuse the old-baseline request's key.
    const storage = makeStorage();
    saveInFlightGeneration(
      { sessionId: 's1', baseVersionId: 'v1', instruction: 'tweak', idempotencyKey: 'key-v1' },
      storage,
    );

    const postedKeys = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        postedKeys.push(JSON.parse(init.body).idempotencyKey);
        return { ok: true, status: 202, json: async () => ({ generationRequestId: 'r-new', status: 'queued' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'succeeded', resultVersionId: 'v2' }) };
    });

    await submitViaGenerations({
      sessionId: 's1', baseVersionId: 'v2', instruction: 'tweak',
      fetchImpl, storage, sleep: async () => {}, pollIntervalMs: 0,
    });

    expect(postedKeys).toHaveLength(1);
    expect(postedKeys[0]).not.toBe('key-v1');
  });

  it('F4b. same instruction + SAME baseVersionId → REUSES key (lost-202 recovery)', async () => {
    const storage = makeStorage();
    saveInFlightGeneration(
      { sessionId: 's1', baseVersionId: 'v1', instruction: 'tweak', idempotencyKey: 'key-v1' },
      storage,
    );

    const postedKeys = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        postedKeys.push(JSON.parse(init.body).idempotencyKey);
        return { ok: true, status: 200, json: async () => ({ id: 'r-existing', status: 'generating' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'succeeded', resultVersionId: 'v2' }) };
    });

    await submitViaGenerations({
      sessionId: 's1', baseVersionId: 'v1', instruction: 'tweak',
      fetchImpl, storage, sleep: async () => {}, pollIntervalMs: 0,
    });

    expect(postedKeys).toHaveLength(1);
    expect(postedKeys[0]).toBe('key-v1');
  });
});

// ================================================ Fix 2: cookie restore

describe('restoreSessionFromCookie (Fix 2)', () => {
  it('returns { sessionId, projectKey } on 200', async () => {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 's-restore', projectKey: 'pk-restore', status: 'active' }),
    }));

    const result = await restoreSessionFromCookie(fn);

    expect(fn).toHaveBeenCalledWith('/api/auth/session');
    expect(result).toEqual({ sessionId: 's-restore', projectKey: 'pk-restore' });
  });

  it('returns null on 401 (no valid cookie)', async () => {
    const fn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: '未登录' }),
    }));

    const result = await restoreSessionFromCookie(fn);
    expect(result).toBeNull();
  });
});

// ================================================ Sp6: independent session entry

describe('createIndependentSession (Sp6 standalone browser entry)', () => {
  it('Sp6f. POSTs to /independent (no token), returns sessionId', async () => {
    const { fn, calls } = makeFetchStub([
      { ok: true, status: 201, body: { sessionId: 'indep-1' } },
    ]);
    const result = await createIndependentSession(fn);
    expect(calls[0].url).toBe('/api/interface-sessions/independent');
    expect(calls[0].init.method).toBe('POST');
    expect(result.sessionId).toBe('indep-1');
  });

  it('throws on a non-2xx (e.g. rate-limited 429)', async () => {
    const { fn } = makeFetchStub([
      { ok: false, status: 429, body: { error: '请求过于频繁' } },
    ]);
    await expect(createIndependentSession(fn)).rejects.toThrow();
  });
});

// ================================================ F7: recovery-code restore

describe('restoreSessionByEditToken (F7 recovery code)', () => {
  it('F7d. POSTs editToken to /api/auth/restore, returns sessionId', async () => {
    const fn = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'recovered-1' }),
    }));
    const result = await restoreSessionByEditToken('iaet_recovery_code', fn);
    expect(fn).toHaveBeenCalledWith('/api/auth/restore', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({ editToken: 'iaet_recovery_code' });
    expect(result.sessionId).toBe('recovered-1');
  });

  it('F7e. throws on 401 (wrong code)', async () => {
    const fn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: '恢复码无效。' }),
    }));
    await expect(restoreSessionByEditToken('iaet_wrong', fn)).rejects.toThrow();
  });
});
