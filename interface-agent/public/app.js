const STORAGE_KEY = 'interface-agent-state';
const STORAGE_VERSION = 5;

/**
 * Read the `projectname` query param lazily (deferred into a function on
 * purpose). Touching `location` at module top-level breaks jsdom/Node imports
 * of this module (`location is not defined`), so the access lives here and is
 * guarded for non-browser environments.
 */
function getProjectName() {
  try {
    if (typeof location === 'undefined' || !location) return '';
    return new URLSearchParams(location.search).get('projectname') || '';
  } catch {
    return '';
  }
}

export function createDefaultPrototype() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg-base: #0a0e14;
      --bg-panel: #111823;
      --bg-elevated: #18212e;
      --bg-inset: #0c1119;
      --border-subtle: rgba(120, 150, 180, 0.10);
      --border-default: rgba(130, 160, 190, 0.16);
      --border-strong: rgba(140, 170, 200, 0.30);
      --accent-cyan: #38b6e6;
      --accent-cyan-bright: #63d2f7;
      --accent-cyan-dim: rgba(56, 182, 230, 0.14);
      --critical: #e5484d;
      --critical-bg: rgba(229, 72, 77, 0.13);
      --approve: #3fbd6b;
      --approve-bg: rgba(63, 189, 107, 0.13);
      --warning: #e0a339;
      --warning-bg: rgba(224, 163, 57, 0.13);
      --text-primary: #e8eef5;
      --text-secondary: #9fb2c6;
      --text-muted: #647689;
      --clsf-unclass: #4a9e57;
      --font-sans: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      --font-mono: "Cascadia Code", "Consolas", ui-monospace, "SFMono-Regular", Menlo, monospace;
    }
    * {
      box-sizing: border-box;
    }
    html,
    body {
      margin: 0;
      min-height: 100%;
    }
    body {
      min-height: 100vh;
      background:
        linear-gradient(rgba(56, 182, 230, 0.020) 1px, transparent 1px),
        linear-gradient(90deg, rgba(56, 182, 230, 0.020) 1px, transparent 1px),
        var(--bg-base);
      background-size: 40px 40px;
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.5;
    }
    .c2-clsf-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 22px;
      background: var(--clsf-unclass);
      border-bottom: 1px solid rgba(0, 0, 0, 0.3);
      color: #d6f0da;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 3px;
      text-transform: uppercase;
    }
    .c2-clsf-banner .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    main {
      min-height: calc(100vh - 22px);
      display: grid;
      place-items: center;
      padding: 32px;
      background:
        radial-gradient(circle at 50% 42%, rgba(56, 182, 230, 0.10), transparent 56%),
        transparent;
    }
    .c2-panel {
      width: 100%;
      max-width: 900px;
      overflow: hidden;
      border: 1px solid var(--border-default);
      border-radius: 8px;
      background: var(--bg-panel);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-default);
      background: linear-gradient(180deg, rgba(56, 182, 230, 0.05), transparent);
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--accent-cyan);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      color: var(--text-primary);
      font-size: 20px;
      font-weight: 600;
      line-height: 1.25;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 3px;
      background: var(--approve-bg);
      box-shadow: inset 0 0 0 1px rgba(63, 189, 107, 0.35);
      color: var(--approve);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .badge .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .panel-body {
      display: grid;
      gap: 16px;
      padding: 16px;
    }
    .situation {
      border: 1px solid var(--border-default);
      border-left: 3px solid var(--accent-cyan);
      border-radius: 5px;
      background: var(--bg-elevated);
      padding: 14px 16px;
    }
    .situation strong {
      display: block;
      margin-bottom: 4px;
      font-size: 14px;
      font-weight: 600;
    }
    .situation span {
      color: var(--text-secondary);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .metric {
      min-height: 86px;
      border: 1px solid var(--border-default);
      border-radius: 5px;
      background: var(--bg-inset);
      padding: 12px;
    }
    .metric .label {
      display: block;
      margin-bottom: 6px;
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    .metric .value {
      display: block;
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 20px;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .timeline {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--border-default);
      border-radius: 5px;
      background: var(--bg-inset);
      padding: 12px;
    }
    .bar {
      height: 18px;
      width: 62%;
      border: 1px solid var(--accent-cyan);
      border-radius: 3px;
      background: linear-gradient(180deg, rgba(56, 182, 230, 0.50), rgba(56, 182, 230, 0.28));
      box-shadow: 0 0 10px rgba(56, 182, 230, 0.25);
    }
    .timeline span {
      display: block;
      margin-top: 8px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 1px;
    }
    @media (max-width: 720px) {
      main {
        padding: 16px;
      }
      .panel-head,
      .metrics {
        grid-template-columns: 1fr;
      }
      .panel-head {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div class="c2-clsf-banner"><span class="dot"></span>UNCLASSIFIED // NOTIONAL PROTOTYPE<span class="dot"></span></div>
  <main>
    <section class="c2-panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Prototype Preview</p>
          <h1>在下方输入界面需求，生成结果会显示在这里。</h1>
        </div>
        <span class="badge"><span class="dot"></span>Ready</span>
      </div>
      <div class="panel-body">
        <div class="situation">
          <strong>等待生成任务</strong>
          <span>描述目标页面、组件和交互约束后，智能体会在此沙箱预览区生成可检查的 HTML 原型。</span>
        </div>
        <div class="metrics">
          <div class="metric"><span class="label">Input</span><span class="value">0</span></div>
          <div class="metric"><span class="label">Preview</span><span class="value">READY</span></div>
          <div class="metric"><span class="label">Mode</span><span class="value">C2</span></div>
        </div>
        <div class="timeline">
          <div class="bar"></div>
          <span>STAGE 01 // REQUIREMENT INTAKE</span>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

export function loadWorkbenchState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { messages: [], currentHtml: createDefaultPrototype(), pendingPollingStopped: false };
    }
    const parsed = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION) {
      localStorage.removeItem(STORAGE_KEY);
      return { messages: [], currentHtml: createDefaultPrototype() };
    }
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      currentHtml: typeof parsed.currentHtml === 'string' ? parsed.currentHtml : createDefaultPrototype(),
      pendingPollingStopped: Boolean(parsed.pendingPollingStopped),
    };
  } catch {
    return { messages: [], currentHtml: createDefaultPrototype(), pendingPollingStopped: false };
  }
}

export function saveWorkbenchState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: STORAGE_VERSION,
    messages: state.messages,
    currentHtml: state.currentHtml,
    pendingPollingStopped: Boolean(state.pendingPollingStopped),
  }));
}

export function appendPendingInputToState(state, content) {
  const value = String(content || '').trim();
  if (!value) return '';

  state.messages.push({ role: 'user', content: value, pendingInput: true });
  state.pendingPollingStopped = true;
  return value;
}

export function createShareSuccessMessage({ url, confirmedOutputPath, copied }) {
  const firstLine = copied ? `预览链接已复制：${url}` : `预览链接已生成，请手动复制：${url}`;
  if (!confirmedOutputPath) {
    return firstLine;
  }
  return `${firstLine}\n共享文件已写入：${confirmedOutputPath}`;
}

export function prepareGenerationSubmission(state, message) {
  const lastMessage = state.messages.at(-1);
  const reusingPendingInput = lastMessage?.pendingInput && lastMessage.content === message;
  if (!reusingPendingInput) {
    state.messages.push({ role: 'user', content: message });
    return { requestState: state, reusingPendingInput: false };
  }

  // 待定文件内容已作为本次 message 发送时，不再作为历史重复传给模型。
  return {
    requestState: { ...state, messages: state.messages.slice(0, -1) },
    reusingPendingInput: true,
  };
}

export function renderPreview(iframe, html) {
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = html;
}

export function createLoadingText(seconds) {
  return `正在生成，已等待 ${seconds} 秒...`;
}

export function setPreviewLoading(loadingEl, active, seconds = 0) {
  if (!loadingEl) return;

  loadingEl.hidden = !active;
  if (!active) return;

  const textTarget = loadingEl.querySelector('[data-loading-text]') || loadingEl;
  textTarget.textContent = createLoadingText(seconds);
}

export function shouldSubmitOnKeydown(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

export async function requestPreviewFullscreen(target) {
  if (!target) return;

  if (typeof target.requestFullscreen === 'function') {
    await target.requestFullscreen();
    return;
  }

  target.classList.add('is-fullscreen-fallback');
}

// =================================================================== T7 wiring
// Share / confirm / async-generation helpers. Each is dependency-injected
// (fetchImpl / sleep / confirmFn) so the four pinned behaviors are unit-
// testable without driving the full DOM bootstrap, then wired into bootstrap()
// with the real browser primitives. The three operations stay independent:
// sharing never confirms; a confirm never creates a share; delivery failure
// (handled server-side) never undoes a confirm.

/**
 * Restore the session from a signed HttpOnly cookie on page refresh (Fix 2).
 * Called when no ?start code is present. Returns { sessionId, projectKey } on
 * success, or null when there is no valid cookie (the caller shows the
 * "open from pipeline" prompt).
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ sessionId: string, projectKey: string } | null>}
 */
export async function restoreSessionFromCookie(fetchImpl) {
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  if (!f) return null;
  try {
    const res = await f('/api/auth/session');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.sessionId) return null;
    return { sessionId: data.sessionId, projectKey: data.projectKey };
  } catch {
    return null;
  }
}

/**
 * Sp6: create a standalone independent session (direct browser access, no
 * projectname / no agent-pipeline). POSTs to /api/interface-sessions/independent
 * (no internal-token — the browser IS the owner). The server sets the signed
 * HttpOnly edit cookie DIRECTLY in the response; the cookie is the credential.
 * Returns { sessionId }. On failure throws (e.g. rate-limited 429).
 */
export async function createIndependentSession(fetchImpl) {
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  if (!f) throw new Error('网络不可用。');
  const res = await f('/api/interface-sessions/independent', { method: 'POST' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || '创建独立会话失败。');
  }
  return payload;
}

/**
 * F7: recover an independent session via the one-time recovery code (editToken).
 * POSTs to /api/auth/restore; the server validates the editToken against active
 * sessions and sets the signed HttpOnly cookie. Returns { sessionId }. Throws on
 * 401 (wrong code) / 429 (rate-limited). The recovery code was shown once when
 * the independent session was created.
 */
export async function restoreSessionByEditToken(editToken, fetchImpl) {
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  if (!f) throw new Error('网络不可用。');
  const res = await f('/api/auth/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editToken }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || '恢复码无效。');
  }
  return payload;
}

/**
 * Generate an idempotency key for an async generation submission. Uses
 * crypto.randomUUID when available (browsers + Node 19+), else a time+random
 * fallback. Each submit gets a fresh key so a genuine retry is a NEW request
 * (a replay of the same key would return the prior request idempotently).
 */
export function newIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* crypto may be unavailable in some sandboxes */
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---- Sp2: in-flight generation persistence (lost-202 / refresh recovery) ----
// The in-flight generation's {sessionId, instruction, idempotencyKey, requestId}
// is persisted to localStorage on submit so a lost 202 (network drop after the
// server created the row) or a page refresh mid-generation can RECOVER the same
// idempotencyKey instead of minting a new one — which would create a duplicate
// request (and a duplicate model call). The entry is cleared on terminal status.

const INFLIGHT_KEY = 'interface-agent-inflight-generation';

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

/** Read the persisted in-flight generation entry (or null). */
export function loadInFlightGeneration(storage) {
  const s = resolveStorage(storage);
  if (!s) return null;
  try {
    const raw = s.getItem(INFLIGHT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the in-flight generation entry (overwrites any prior entry). */
export function saveInFlightGeneration(entry, storage) {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.setItem(INFLIGHT_KEY, JSON.stringify(entry));
  } catch {
    /* storage may be unavailable (private mode); recovery is best-effort */
  }
}

/** Clear the in-flight generation entry (called on terminal status). */
export function clearInFlightGeneration(storage) {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.removeItem(INFLIGHT_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Submit an async generation request and poll until it reaches a terminal
 * state (spec §异步生成流程, task-7 brief §D.2). On succeeded the T6 auto-select
 * polling (versions.js) picks up the new version and renders it, so this only
 * owns the submit + wait + status text. On failed it throws so the bootstrap
 * can record the error in the operation log without changing the preview.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.baseVersionId - getSelectedVersionId() at submit time
 * @param {string} opts.instruction
 * @param {string} [opts.idempotencyKey] - when omitted, the in-flight recovery
 *   layer mints (or reuses) a key so a lost-202 / refresh recovers the same key
 *   instead of creating a duplicate request.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.maxAttempts]
 * @param {Storage} [opts.storage] - injectable localStorage for the recovery layer
 * @returns {Promise<{ status: string, versionLabel?: string, resultVersionId?: string }>}
 */
export async function submitViaGenerations({
  sessionId,
  baseVersionId,
  instruction,
  idempotencyKey,
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 1000,
  maxAttempts = 180,
  storage,
}) {
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  if (!f) throw new Error('网络不可用。');

  // Sp2: in-flight recovery. When no explicit idempotencyKey is provided (the
  // bootstrap path), look up a persisted in-flight entry for THIS session +
  // baseVersionId + instruction. If one exists (a lost 202 or a refresh
  // mid-generation), REUSE its key — re-POSTing with the same key is deduped by
  // the backend idempotency fast-path, so no duplicate request / model call is
  // created. F4: baseVersionId is part of the identity — switching the selected
  // version + re-submitting the same text must mint a NEW key (the old-baseline
  // request is a different generation). A genuine NEW instruction also mints a
  // fresh key. The entry is persisted BEFORE the POST so a lost 202 leaves it in
  // place for the retry to recover.
  let key = idempotencyKey;
  if (!key) {
    const inflight = loadInFlightGeneration(storage);
    if (
      inflight &&
      inflight.sessionId === sessionId &&
      inflight.baseVersionId === (baseVersionId ?? null) &&
      inflight.instruction === instruction
    ) {
      key = inflight.idempotencyKey;
    } else {
      key = newIdempotencyKey();
    }
  }
  saveInFlightGeneration({ sessionId, baseVersionId: baseVersionId ?? null, instruction, idempotencyKey: key }, storage);

  const res = await f(`/api/interface-sessions/${sessionId}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersionId, instruction, idempotencyKey: key }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || '提交生成失败。');
  }
  // The POST returns either { generationRequestId } (202 new) or { id } (200
  // existing, idempotency fast-path). Normalize to one requestId and persist it
  // so a refresh mid-generation can poll the known request.
  const requestId = payload.generationRequestId || payload.id;
  if (!requestId) throw new Error('未返回生成请求 id。');
  saveInFlightGeneration({ sessionId, baseVersionId: baseVersionId ?? null, instruction, idempotencyKey: key, requestId }, storage);

  for (let i = 0; i < maxAttempts; i += 1) {
    await sleep(pollIntervalMs);
    const pr = await f(`/api/interface-sessions/${sessionId}/generations/${requestId}`);
    const p = await pr.json().catch(() => ({}));
    if (p.status === 'succeeded') {
      clearInFlightGeneration(storage);
      return { status: 'succeeded', versionLabel: p.versionLabel, resultVersionId: p.resultVersionId };
    }
    if (p.status === 'failed') {
      clearInFlightGeneration(storage);
      throw new Error('生成失败，请稍后重试。');
    }
    // queued / generating → keep polling
  }
  // Timeout: leave the inflight entry so a later refresh can still recover it.
  throw new Error('生成超时，请稍后在版本树中查看结果。');
}

/**
 * Confirm a version with optimistic concurrency (task-7 brief §D.3). Returns the
 * raw result envelope; the caller uses isConfirmConflict() to detect a 409 and
 * show "已被他人确认变更" without silently overwriting. Never throws on 409.
 */
export async function confirmVersionRequest({
  sessionId,
  versionId,
  expectedConfirmedVersionId,
  fetchImpl,
}) {
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  const res = await f(`/api/interface-sessions/${sessionId}/confirmations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionId, expectedConfirmedVersionId }),
  });
  const payload = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, payload };
}

/** A 409 means the caller's view of the confirmed version is stale. */
export function isConfirmConflict(result) {
  return Boolean(result && result.status === 409);
}

/** The user-facing conflict message (never a silent overwrite). */
export const CONFIRM_CONFLICT_MESSAGE = '已被他人确认变更，请刷新后重试。';

/**
 * Sp2: recover an in-flight generation persisted across a page refresh. If the
 * in-flight entry matches this session AND carries a requestId, poll that
 * request to a terminal state and clear the entry — so a refresh mid-generation
 * does NOT mint a new key (which would duplicate the request). Returns the
 * terminal result, or null when there is nothing to recover. Best-effort: any
 * error leaves the entry in place for the next attempt.
 *
 * @returns {Promise<{ status: string, versionLabel?: string, resultVersionId?: string } | null>}
 */
export async function recoverInFlightGeneration({
  sessionId,
  fetchImpl,
  storage,
  onStatus = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 1500,
  maxAttempts = 200,
}) {
  const inflight = loadInFlightGeneration(storage);
  if (!inflight || inflight.sessionId !== sessionId || !inflight.requestId) {
    return null;
  }
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  if (!f) return null;
  onStatus('正在恢复进行中的生成…');
  for (let i = 0; i < maxAttempts; i += 1) {
    await sleep(pollIntervalMs);
    let p;
    try {
      const pr = await f(`/api/interface-sessions/${sessionId}/generations/${inflight.requestId}`);
      p = await pr.json().catch(() => ({}));
    } catch {
      continue; // transient; next tick retries
    }
    if (p.status === 'succeeded') {
      clearInFlightGeneration(storage);
      return { status: 'succeeded', versionLabel: p.versionLabel, resultVersionId: p.resultVersionId };
    }
    if (p.status === 'failed') {
      clearInFlightGeneration(storage);
      return { status: 'failed' };
    }
    // queued / generating → keep polling
  }
  return null;
}

/**
 * Create a share link pinned to a version (task-7 brief §D.4). Returns the
 * server payload ({ url, token, versionLabel, ... }); the caller copies url to
 * the clipboard. Share never confirms (independent operation).
 */
export async function createShareRequest({ sessionId, versionId, fetchImpl }) {
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  const res = await f(`/api/interface-sessions/${sessionId}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionId }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || '创建分享失败。');
  }
  return payload;
}

/**
 * Restart gate (task-7 brief §D.5): 重新开始 REPLACES the old destructive 重置
 * and requires an explicit second confirmation. Returns the confirmFn result so
 * the caller aborts the restart on cancel.
 */
export function shouldRestart(confirmFn) {
  const confirm =
    confirmFn ||
    ((typeof window !== 'undefined' && window.confirm) || (() => false));
  return confirm('确定要重新开始吗？当前会话将被归档，并创建一个新会话。');
}

// Version navigation (T6): toolbar version button, version-tree overlay,
// switching, branch chat / all-events views, baseline display, archive +
// title edits, and auto-select polling. The module owns the personal selected
// version (localStorage); it never writes the shared confirmed version.
import { createVersionApiClient, initVersionControls } from './versions.js';

function createMessageElement(message) {
  const item = document.createElement('div');
  item.className = `message message-${message.role}`;
  if (message.pending) {
    item.classList.add('message-pending');
    item.setAttribute('aria-live', 'polite');
  }
  item.textContent = message.content;
  return item;
}

function renderMessages(container, messages) {
  container.replaceChildren(...messages.map(createMessageElement));
  container.scrollTop = container.scrollHeight;
}

async function requestPendingInput() {
  const response = await fetch('/api/pending-input');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '读取待定输入文件失败。');
  }
  return payload;
}

function bootstrap() {
  const form = document.querySelector('#chat-form');
  if (!form) return;

  const iframe = document.querySelector('#preview');
  const previewLoading = document.querySelector('#preview-loading');
  const messagesEl = document.querySelector('#messages');
  const input = document.querySelector('#prompt');
  const status = document.querySelector('#status');
  const restart = document.querySelector('#restart');
  const share = document.querySelector('#share');
  const confirmBtn = document.querySelector('#confirm');
  const fullscreen = document.querySelector('#fullscreen');
  const submit = document.querySelector('#submit');

  const state = loadWorkbenchState();
  let pendingTimer = null;
  let pendingPollIntervalMs = 3000;
  let currentSessionId = null;
  let versionControls = null;
  // Shared confirmed-version state (optimistic-concurrency baseline for the
  // confirm button). null until the session summary is loaded.
  let currentConfirmedVersionId = null;
  // Tracks the delivery created by the last confirm so the UI can poll its
  // status and surface "已确认，交付失败，可重试".
  let lastDeliveryId = null;
  renderPreview(iframe, state.currentHtml);
  renderMessages(messagesEl, state.messages);

  // 启动码换 Cookie → 旧稿导入检查 → 版本控件初始化（均异步，不阻塞 UI）
  // Fix 2: if no ?start code, try restoring the session from the signed cookie
  // (page refresh). If neither succeeds, show "请从流水线打开项目".
  const startParams = new URLSearchParams(location.search);
  if (startParams.get('start')) {
    handleStartCodeExchange().then((ok) => {
      if (!ok) return;
      checkLegacyImport();
      void initVersionUI();
    });
  } else {
    restoreSessionFromCookie().then((restored) => {
      if (!restored) {
        // Sp6: direct access (no projectname, no cookie). Offer a standalone
        // "创建独立会话" entry — the browser IS the owner, the cookie is the
        // credential (no start-code dance). The pipeline-open path remains the
        // primary flow; this is the fallback for direct access.
        status.textContent = '请从流水线打开项目，或创建一个独立会话。';
        appendIndependentSessionAction();
        return;
      }
      currentSessionId = restored.sessionId;
      status.textContent = '会话已恢复';
      checkLegacyImport();
      void initVersionUI();
    });
  }

  // Sp6: append a one-shot "创建独立会话" button for direct (no-projectname)
  // access. On click it creates an independent session (cookie set by the
  // response) and initializes the version UI. F7: also appends a recovery-code
  // restore field so a lost cookie / new device can recover the session.
  function appendIndependentSessionAction() {
    if (!messagesEl) return;
    const node = document.createElement('div');
    node.className = 'message message-assistant independent-session-action';
    const text = document.createElement('span');
    text.textContent = '未检测到流水线会话。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary independent-session-btn';
    btn.textContent = '创建独立会话';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      status.textContent = '正在创建独立会话…';
      try {
        const result = await createIndependentSession();
        currentSessionId = result.sessionId;
        status.textContent = '独立会话已创建';
        node.remove();
        // F7: show the recovery code (editToken) ONCE so the user can save it
        // to recover the session on a new device / lost cookie. The cookie is
        // already set; this is a separate one-time disclosure.
        if (result.editToken) {
          appendRecoveryCodeNotice(result.editToken);
        }
        void initVersionUI();
      } catch (error) {
        status.textContent = error.message || '创建独立会话失败。';
        btn.disabled = false;
      }
    });

    // F7: recovery-code restore field. Lets a user who saved their recovery code
    // restore the session without the cookie.
    const restoreWrap = document.createElement('div');
    restoreWrap.className = 'restore-code-field';
    restoreWrap.style.cssText = 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap';
    const restoreInput = document.createElement('input');
    restoreInput.type = 'text';
    restoreInput.placeholder = '输入恢复码以恢复会话';
    restoreInput.className = 'restore-code-input';
    restoreInput.style.cssText = 'flex:1;min-width:200px';
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'secondary restore-code-btn';
    restoreBtn.textContent = '恢复会话';
    restoreBtn.addEventListener('click', async () => {
      const code = restoreInput.value.trim();
      if (!code) return;
      restoreBtn.disabled = true;
      status.textContent = '正在恢复会话…';
      try {
        const result = await restoreSessionByEditToken(code);
        currentSessionId = result.sessionId;
        status.textContent = '会话已恢复';
        node.remove();
        void initVersionUI();
      } catch (error) {
        status.textContent = error.message || '恢复失败。';
        restoreBtn.disabled = false;
      }
    });
    restoreWrap.append(restoreInput, restoreBtn);
    node.append(text, btn, restoreWrap);
    messagesEl.append(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // F7: one-time recovery-code disclosure after independent session creation.
  function appendRecoveryCodeNotice(editToken) {
    if (!messagesEl) return;
    const node = document.createElement('div');
    node.className = 'message message-assistant recovery-code-notice';
    const label = document.createElement('div');
    label.textContent = '请保存此恢复码（仅显示一次），用于在新设备或丢失 Cookie 时恢复会话：';
    label.style.cssText = 'margin-bottom:6px';
    const code = document.createElement('code');
    code.textContent = editToken;
    code.style.cssText = 'display:block;padding:8px;background:#111823;border:1px solid rgba(130,160,190,.3);border-radius:4px;word-break:break-all;user-select:all';
    node.append(label, code);
    messagesEl.append(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---- 版本控件：工具栏版本按钮 / 版本树弹层 / 切换 / 分支对话 / 基线 ----
  async function initVersionUI() {
    if (!currentSessionId) return;
    const toolbar = document.querySelector('.preview-toolbar');
    const baselineHost = document.querySelector('#baseline');
    if (!toolbar) return;

    const client = createVersionApiClient({ sessionId: currentSessionId });
    versionControls = initVersionControls({
      sessionId: currentSessionId,
      client,
      toolbar,
      iframe,
      messagesEl,
      baselineHost,
      onStatus: (text) => { status.textContent = text; },
      renderPreviewFn: renderPreview,
    });

    await versionControls.refresh();
    // Render the selected version's HTML into the preview (overrides the
    // default template once a session + version exists).
    await versionControls.renderSelectedPreview();
    versionControls.startPolling();
    // Sp2: recover an in-flight generation persisted across a refresh (polls the
    // stored requestId to terminal instead of minting a new key). Best-effort;
    // the versions.js auto-select poller renders the result either way.
    void recoverInFlightGeneration({
      sessionId: currentSessionId,
      onStatus: (text) => { status.textContent = text; },
    }).then((r) => {
      if (r && r.status === 'succeeded') {
        status.textContent = r.versionLabel ? `已生成 ${r.versionLabel}` : '已生成新版本';
        void versionControls.refresh?.();
      }
    });
    // Load the shared confirm baseline so the confirm button can pass the
    // correct expectedConfirmedVersionId (optimistic concurrency).
    void loadSessionInfo();
  }

  // ---- 读取会话摘要：确认基线（乐观并发）+ 交付状态 ----
  async function loadSessionInfo() {
    if (!currentSessionId) return;
    try {
      const res = await fetch(`/api/interface-sessions/${currentSessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      currentConfirmedVersionId = data.confirmedVersion?.versionId ?? null;
    } catch {
      /* best-effort; the confirm button re-reads on demand */
    }
  }

  // ---- 交付状态轮询：confirm 后跟踪交付，失败显示"已确认，交付失败，可重试" ----
  // 交付失败不撤销确认（三个独立操作）；此处只展示状态并提供重试入口。
  async function pollDeliveryStatus(deliveryId) {
    if (!currentSessionId || !deliveryId) return;
    let attempts = 0;
    const maxAttempts = 60;
    const interval = setInterval(async () => {
      attempts += 1;
      try {
        const res = await fetch(
          `/api/interface-sessions/${currentSessionId}/deliveries/${deliveryId}`,
        );
        const data = await res.json();
        if (data.status === 'delivered') {
          clearInterval(interval);
          status.textContent = '已确认，已交付';
        } else if (data.status === 'failed') {
          clearInterval(interval);
          status.textContent = '已确认，交付失败，可重试';
          appendDeliveryRetryAction(deliveryId);
        } else if (data.status === 'superseded') {
          clearInterval(interval);
          // A newer confirm superseded this delivery; stop tracking it.
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
        }
      } catch {
        /* transient; next tick retries */
      }
    }, 3000);
  }

  // Retry a failed delivery (idempotent: delivered/superseded are no-ops).
  async function retryDelivery(deliveryId) {
    if (!currentSessionId || !deliveryId) return;
    try {
      const res = await fetch(
        `/api/interface-sessions/${currentSessionId}/deliveries/${deliveryId}/retry`,
        { method: 'POST' },
      );
      const data = await res.json().catch(() => ({}));
      if (data.status === 'pending') {
        status.textContent = '正在重新交付…';
        pollDeliveryStatus(deliveryId);
      } else {
        status.textContent = `交付状态：${data.status}`;
      }
    } catch {
      status.textContent = '重试交付失败。';
    }
  }

  // Append a one-shot "重试交付" button to the chat when a delivery fails.
  // Delivery failure does NOT undo the confirm (three independent ops); this
  // only re-queues the delivery for the worker. Appended directly so it
  // survives until the next full message re-render.
  function appendDeliveryRetryAction(deliveryId) {
    if (!messagesEl) return;
    const node = document.createElement('div');
    node.className = 'message message-assistant delivery-retry-action';
    const text = document.createElement('span');
    text.textContent = '已确认，交付失败。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary delivery-retry-btn';
    btn.textContent = '重试交付';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void retryDelivery(deliveryId);
      node.remove();
    });
    node.append(text, btn);
    messagesEl.append(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---- 启动码换 Cookie（agent-pipeline 打开时 ?start=一次性码） ----
  async function handleStartCodeExchange() {
    const params = new URLSearchParams(location.search);
    const startCode = params.get('start');
    if (!startCode) return true;

    try {
      const res = await fetch('/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startCode }),
      });
      if (!res.ok) {
        status.textContent = '启动码无效或已过期，请从流水线重新打开。';
        return false;
      }
      const data = await res.json();
      currentSessionId = data.sessionId;
      // 从 URL 中移除一次性启动码，避免 Referer / 历史记录泄露
      history.replaceState(null, '', location.pathname);
      status.textContent = '会话已恢复';
      return true;
    } catch {
      status.textContent = '会话恢复失败，请从流水线重新打开。';
      return false;
    }
  }

  // ---- 旧稿导入提示（全局仅一次） ----
  async function checkLegacyImport() {
    if (!currentSessionId) return;
    try {
      const statusRes = await fetch(`/api/interface-sessions/${currentSessionId}/legacy-import/status`);
      if (!statusRes.ok) return;
      const statusData = await statusRes.json();
      if (!statusData.offered) return;

      // 前端检查 localStorage 是否有非默认 HTML
      const storedHtml = state.currentHtml || '';
      const isDefault = !storedHtml.trim() || storedHtml.includes('UNCLASSIFIED // NOTIONAL PROTOTYPE');
      if (isDefault) return;

      // 弹一次性确认
      const confirmed = window.confirm('检测到历史界面稿，是否导入为版本 V1？\n（此操作全局仅执行一次）');
      if (!confirmed) return;

      const importRes = await fetch(`/api/interface-sessions/${currentSessionId}/legacy-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: storedHtml, title: '导入的历史界面稿' }),
      });
      if (!importRes.ok) return;

      const { version } = await importRes.json();
      if (version) {
        status.textContent = `已导入历史界面稿（${version.versionLabel}）`;
        // Refresh the version tree + select the freshly imported root.
        if (versionControls) {
          await versionControls.refresh();
          await versionControls.selectVersion(version.versionId);
        }
      }
    } catch {
      // 静默失败，不影响正常使用
    }
  }

  const stopPendingPolling = () => {
    if (!pendingTimer) return;
    clearInterval(pendingTimer);
    pendingTimer = null;
  };

  const checkPendingInput = async () => {
    if (state.pendingPollingStopped) {
      stopPendingPolling();
      return;
    }

    try {
      const payload = await requestPendingInput();
      if (Number.isFinite(payload.pollIntervalMs) && payload.pollIntervalMs > 0) {
        pendingPollIntervalMs = payload.pollIntervalMs;
      }
      if (!payload.available) return;

      const pendingText = appendPendingInputToState(state, payload.content);
      if (!pendingText) return;

      // 待定文件只作为输入来源，不做移动/复制/删除；加载后由用户手动决定是否生成。
      input.value = pendingText;
      status.textContent = '已加载待定需求';
      renderMessages(messagesEl, state.messages);
      saveWorkbenchState(state);
      stopPendingPolling();
    } catch (error) {
      status.textContent = error.message;
    }
  };

  const startPendingPolling = () => {
    if (state.pendingPollingStopped || pendingTimer) return;
    checkPendingInput();
    pendingTimer = setInterval(checkPendingInput, pendingPollIntervalMs);
  };

  startPendingPolling();

  input.addEventListener('keydown', (event) => {
    if (!shouldSubmitOnKeydown(event)) return;

    event.preventDefault();
    form.requestSubmit();
  });

  fullscreen.addEventListener('click', async () => {
    await requestPreviewFullscreen(document.querySelector('.preview-panel'));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    prepareGenerationSubmission(state, message);
    const pendingMessage = { role: 'assistant', content: createLoadingText(0), pending: true };
    const startedAt = Date.now();
    const renderPending = () => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      pendingMessage.content = createLoadingText(elapsedSeconds);
      status.textContent = `生成中 ${elapsedSeconds}s`;
      setPreviewLoading(previewLoading, true, elapsedSeconds);
      renderMessages(messagesEl, [...state.messages, pendingMessage]);
    };

    input.value = '';
    input.disabled = true;
    submit.disabled = true;
    renderPending();
    const loadingTimer = setInterval(renderPending, 1000);
    saveWorkbenchState(state);

    try {
      // Fix 1: ALWAYS submit via the async generations endpoint — no legacy
      // fallback. baseVersionId is the selected version, or null when the
      // session has zero versions (first generation creates root V1). The
      // server rejects null only when versions already exist.
      const baseVersionId = versionControls?.getSelectedVersionId?.() || null;
      // Sp2: no explicit idempotencyKey — the recovery layer mints (or reuses
      // on lost-202/refresh) the key, so a duplicate submission can never create
      // a duplicate request / model call.
      const result = await submitViaGenerations({
        sessionId: currentSessionId,
        baseVersionId,
        instruction: message,
      });
      state.messages.push({
        role: 'assistant',
        content: result.versionLabel ? `已生成 ${result.versionLabel}（见版本树/预览）。` : '已生成新版本。',
      });
      status.textContent = '已更新';
      // The T6 auto-select poller renders the new version into the preview;
      // refresh the tree so the node is present immediately.
      await versionControls?.refresh?.();
    } catch (error) {
      state.messages.push({ role: 'assistant', content: error.message });
      status.textContent = '生成失败';
    } finally {
      clearInterval(loadingTimer);
      input.disabled = false;
      submit.disabled = false;
      setPreviewLoading(previewLoading, false);
      renderMessages(messagesEl, state.messages);
      saveWorkbenchState(state);
    }
  });

  restart.addEventListener('click', async () => {
    // 重新开始 replaces the old destructive 重置 and requires a second
    // confirmation (task-7 brief §D.5). It archives the session server-side
    // and reloads into a fresh session via the returned start code.
    if (!shouldRestart()) return;
    if (!currentSessionId) {
      status.textContent = '无活跃会话可重新开始。';
      return;
    }
    restart.disabled = true;
    status.textContent = '正在重新开始…';
    try {
      const res = await fetch(`/api/interface-sessions/${currentSessionId}/restart`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        status.textContent = data.error || '重新开始失败。';
        return;
      }
      // Reload into the new session via its one-time start code. handleStartCodeExchange
      // runs on load to exchange it for a cookie and re-init the version UI.
      const start = data.startCode;
      if (start) {
        location.href = `${location.pathname}?start=${encodeURIComponent(start)}`;
      } else {
        location.reload();
      }
    } catch (error) {
      status.textContent = error.message || '重新开始失败。';
    } finally {
      restart.disabled = false;
    }
  });

  confirmBtn.addEventListener('click', async () => {
    // 确认采用：write the shared confirmed_version_id with optimistic
    // concurrency (task-7 brief §D.3). On 409 surface the conflict without
    // silently overwriting. Confirm creates a pending delivery; we poll its
    // status. Delivery failure does NOT undo the confirm.
    const versionId = versionControls?.getSelectedVersionId?.();
    if (!currentSessionId) {
      status.textContent = '无活跃会话。';
      return;
    }
    if (!versionId) {
      status.textContent = '请先选择要确认采用的版本。';
      return;
    }
    confirmBtn.disabled = true;
    status.textContent = '正在确认采用…';
    try {
      const result = await confirmVersionRequest({
        sessionId: currentSessionId,
        versionId,
        expectedConfirmedVersionId: currentConfirmedVersionId,
      });
      if (isConfirmConflict(result)) {
        // Stale view: another confirm landed first. Refresh and do NOT overwrite.
        status.textContent = CONFIRM_CONFLICT_MESSAGE;
        currentConfirmedVersionId = result.payload.currentConfirmedVersionId ?? null;
        await versionControls?.refresh?.();
        return;
      }
      if (!result.ok) {
        status.textContent = result.payload?.error || '确认失败。';
        return;
      }
      currentConfirmedVersionId = result.payload.confirmedVersionId;
      lastDeliveryId = result.payload.delivery?.id || null;
      status.textContent = '已确认采用';
      await versionControls?.refresh?.();
      if (lastDeliveryId) pollDeliveryStatus(lastDeliveryId);
    } catch (error) {
      status.textContent = error.message || '确认失败。';
    } finally {
      confirmBtn.disabled = false;
    }
  });

  share.addEventListener('click', async () => {
    // 分享：independent read-only link pinned to the selected version. Sharing
    // never confirms (three independent operations). Copies the link to the
    // clipboard and toasts which version it was pinned to.
    const versionId = versionControls?.getSelectedVersionId?.();
    if (!currentSessionId) {
      status.textContent = '无活跃会话。';
      return;
    }
    if (!versionId) {
      status.textContent = '请先选择要分享的版本。';
      return;
    }
    share.disabled = true;
    status.textContent = '正在创建分享链接';
    try {
      const payload = await createShareRequest({ sessionId: currentSessionId, versionId });
      const label = payload.versionLabel || '';
      try {
        await navigator.clipboard.writeText(payload.url);
        state.messages.push({
          role: 'assistant',
          content: `分享链接已复制（固定到 ${label}）：${payload.url}`,
        });
        status.textContent = `分享链接已复制（固定到 ${label}）`;
      } catch {
        state.messages.push({
          role: 'assistant',
          content: `分享链接已生成（固定到 ${label}），请手动复制：${payload.url}`,
        });
        status.textContent = `分享链接已生成（固定到 ${label}）`;
      }
    } catch (error) {
      state.messages.push({ role: 'assistant', content: error.message });
      status.textContent = '分享失败';
    } finally {
      share.disabled = false;
      renderMessages(messagesEl, state.messages);
      saveWorkbenchState(state);
    }
  });
}

if (typeof document !== 'undefined') {
  bootstrap();
}
