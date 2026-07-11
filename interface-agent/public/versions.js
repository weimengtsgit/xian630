/**
 * Version navigation controls for the interface-agent workbench (task 6, spec
 * §前端行为).
 *
 * Split into two layers:
 *   - Pure / dependency-injected helpers (sort, filter, auto-select, switch,
 *     api client). Exported so the four pinned behaviors are unit-testable
 *     without a DOM: numeric label_path sort, switch-updates-preview-not-
 *     confirmed, auto-select-on-success, archive toggle.
 *   - A DOM controller (`initVersionControls`) that wires those helpers to the
 *     workbench: the toolbar version button, the version-tree overlay, branch
 *     chat vs. all-events views, baseline display, inline title edit, archive
 *     toggle, and auto-select polling.
 *
 * Domain rule 7 is load-bearing throughout: the currently SELECTED version is
 * personal client state (localStorage). Switching it NEVER writes the shared
 * confirmed_version_id — only an explicit confirm action (T7) does. Title
 * edits PATCH in place (no new version); version label + HTML are immutable.
 */

// ------------------------------------------------------------------- pure sort

/**
 * Numeric per-segment comparison of two version label paths. Shorter prefixes
 * (ancestors) sort before their longer descendants. This is NOT string lex
 * order, so [10] correctly follows [2] (V10 after V2). Mirrors the backend
 * `compareLabelPath` so the client can re-sort local mutations deterministically.
 *
 * @param {{ labelPath: number[] }} a
 * @param {{ labelPath: number[] }} b
 * @returns {number}
 */
export function compareVersionLabelPath(a, b) {
  const pa = a.labelPath || [];
  const pb = b.labelPath || [];
  const shared = Math.min(pa.length, pb.length);
  for (let i = 0; i < shared; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return pa.length - pb.length;
}

/**
 * Stable sort of version metadata by structured label_path with created_at as
 * the tie-break. Returns a new array (does not mutate the input). The backend
 * already returns sorted output; this keeps the view correct after local
 * filtering or re-rendering.
 *
 * @param {Array<{ labelPath: number[], createdAt?: string }>} versions
 * @returns {Array}
 */
export function sortVersionTree(versions) {
  return [...versions].sort((a, b) => {
    const byPath = compareVersionLabelPath(a, b);
    if (byPath !== 0) return byPath;
    const ac = a.createdAt || '';
    const bc = b.createdAt || '';
    if (ac < bc) return -1;
    if (ac > bc) return 1;
    return 0;
  });
}

/**
 * Hide archived versions unless the user has toggled "show archived". Archived
 * nodes are a personal view concern — archiving never deletes (领域规则 6).
 *
 * @param {Array<{ archived: boolean }>} versions
 * @param {{ showArchived: boolean }} opts
 * @returns {Array}
 */
export function filterVisibleVersions(versions, { showArchived }) {
  if (showArchived) return [...versions];
  return versions.filter((v) => !v.archived);
}

// ------------------------------------------------------------- auto-select

/**
 * Decide whether a generation that JUST transitioned to succeeded should be
 * auto-selected. This is TRANSITION-based, NOT state-based: it returns the
 * newest succeeded request only when its id differs from the last-seen
 * succeeded request id (i.e. a request that succeeded since the previous
 * poll), else null. The backend lists generations newest-first, so the first
 * succeeded entry is the latest.
 *
 * Transition (not state) is load-bearing: comparing against the selected
 * version would re-yank a user who deliberately browsed an older version —
 * every 3s poll would see newest≠selected and snap them back. Tracking the
 * last-seen succeeded request id means a manual selection to an older version
 * stays stable across subsequent polls; only a genuinely new success triggers
 * a re-select.
 *
 * @param {Array<{ id: string, status: string, resultVersionId: string|null }>} requests
 * @param {string | null} lastSeenSucceededRequestId
 * @returns {{ requestId: string, resultVersionId: string } | null}
 */
export function selectAutoOnSuccess(requests, lastSeenSucceededRequestId) {
  // Only the NEWEST succeeded request can trigger an auto-select (the backend
  // lists generations newest-first).
  const newest = requests.find((r) => r.status === 'succeeded' && r.resultVersionId);
  if (!newest) return null;
  // Suppress unless this is a genuine transition we haven't seen yet.
  if (newest.id === lastSeenSucceededRequestId) return null;
  return { requestId: newest.id, resultVersionId: newest.resultVersionId };
}

/**
 * Sp3: the id of the newest succeeded request (newest-first list), or null.
 * Used to SEED `lastSeenSucceededRequestId` at init (after loading the session +
 * generations list) so the first poll after a refresh does NOT treat the
 * existing newest-succeeded as a transition and yank the user off their
 * persisted selection. Mirrors the find clause in selectAutoOnSuccess.
 *
 * @param {Array<{ id: string, status: string, resultVersionId: string|null }>} requests
 * @returns {string | null}
 */
export function newestSucceededRequestId(requests) {
  const newest = requests.find((r) => r.status === 'succeeded' && r.resultVersionId);
  return newest ? newest.id : null;
}

// --------------------------------------------------------------- api client

/**
 * Session-scoped version API client. `fetchImpl` is injected so tests bypass
 * the network; the browser passes the global fetch. Every method targets the
 * T6 endpoints and throws a descriptive Error on a non-2xx response.
 *
 * @param {{ fetchImpl?: typeof fetch, sessionId: string }} opts
 */
export function createVersionApiClient({ fetchImpl, sessionId }) {
  const f = fetchImpl || ((typeof fetch !== 'undefined' ? fetch : null));
  if (!f) throw new Error('versions.js: fetch 未可用');
  const base = `/api/interface-sessions/${sessionId}`;

  async function call(path, init = {}) {
    const response = await f(`${base}${path}`, init);
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.json()).error || '';
      } catch {
        /* non-json error body */
      }
      throw new Error(detail || `请求失败（${response.status}）`);
    }
    return response;
  }

  return {
    async fetchTree() {
      const r = await call('/versions');
      return (await r.json()).versions || [];
    },
    async fetchSession() {
      const r = await call('');
      return r.json();
    },
    async fetchDetail(versionId) {
      const r = await call(`/versions/${versionId}`);
      return r.json();
    },
    async fetchHtml(versionId) {
      const r = await call(`/versions/${versionId}/html`);
      return r.text();
    },
    async patchTitle(versionId, title) {
      const r = await call(`/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      return r.json();
    },
    async patchArchived(versionId, archived) {
      const r = await call(`/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      return r.json();
    },
    async fetchEvents() {
      const r = await call('/events');
      return (await r.json()).events || [];
    },
    async fetchGenerations() {
      const r = await call('/generations');
      return (await r.json()).requests || [];
    },
  };
}

// ------------------------------------------------------------------- switch

/**
 * Switch the personal selected version: fetch its immutable HTML, render it
 * into the preview, and notify the baseline display. This is PERSONAL state
 * (领域规则 7) — it performs only a GET and must NEVER write shared confirm
 * state. The injected `client` exposes only read methods to the caller; the
 * unit test asserts no write/confirm method fires.
 *
 * @param {object} deps
 * @param {object} deps.client - version api client
 * @param {{ versionId: string, versionLabel?: string, title?: string }} deps.version
 * @param {(html: string) => void} deps.renderPreview - receives the html string
 * @param {(version: object) => void} [deps.onBaselineChange]
 * @returns {Promise<{ version: object, html: string }>}
 */
export async function switchVersion({ client, version, renderPreview, onBaselineChange }) {
  const html = await client.fetchHtml(version.versionId);
  renderPreview(html);
  onBaselineChange?.(version);
  return { version, html };
}

// ============================================================ DOM controller

const SELECTED_STORAGE_KEY = 'interface-agent-selected-version';

function loadSelectedVersionId(sessionId) {
  try {
    const raw = localStorage.getItem(SELECTED_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.sessionId === sessionId ? parsed.versionId : null;
  } catch {
    return null;
  }
}

function saveSelectedVersionId(sessionId, versionId) {
  try {
    localStorage.setItem(SELECTED_STORAGE_KEY, JSON.stringify({ sessionId, versionId }));
  } catch {
    /* storage may be unavailable (private mode); selection is best-effort */
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Format the compact baseline label shown in the composer + toolbar button,
 * e.g. "V1.2 · 调整导航配色".
 */
function formatBaselineLabel(version) {
  if (!version) return '';
  const label = version.versionLabel || '';
  const title = version.title ? ` · ${version.title}` : '';
  return `${label}${title}`;
}

/**
 * Build the version button for the preview toolbar (C2 icon-button style with
 * a text label). Clicking opens the overlay.
 */
function buildVersionButton() {
  const btn = el('button', 'version-button', '');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = '版本树';
  const dot = el('span', 'version-button-dot', '');
  const text = el('span', 'version-button-text', '版本');
  btn.append(dot, text);
  return { btn, text };
}

/**
 * Initialize the version controls and return a controller handle. The handle
 * lets app.js drive refresh / polling after the session is established.
 *
 * @param {object} deps
 * @param {string} deps.sessionId
 * @param {object} deps.client - createVersionApiClient result
 * @param {HTMLElement} deps.toolbar - .preview-toolbar (version button mount)
 * @param {HTMLIFrameElement} deps.iframe - #preview
 * @param {HTMLElement} deps.messagesEl - #messages
 * @param {HTMLElement} [deps.baselineHost] - composer baseline mount
 * @param {(text: string) => void} [deps.onStatus] - status pill updater
 * @param {(iframe: HTMLIFrameElement, html: string) => void} deps.renderPreviewFn
 */
export function initVersionControls({
  sessionId,
  client,
  toolbar,
  iframe,
  messagesEl,
  baselineHost = null,
  onStatus = () => {},
  renderPreviewFn,
}) {
  let versions = [];
  let selectedVersionId = loadSelectedVersionId(sessionId);
  let showArchived = false;
  let chatView = 'branch'; // 'branch' | 'events'
  let pollTimer = null;
  // Last generation-request id observed transitioning to succeeded. Auto-select
  // fires only on a genuine TRANSITION (new id), never on a state mismatch, so a
  // user browsing an older version is not yanked back each poll (fix 1).
  let lastSeenSucceededRequestId = null;
  // Sp3: seed lastSeenSucceededRequestId from the current generations exactly
  // once (on the first refresh). Without seeding, the first poll after a page
  // refresh treats the existing newest-succeeded as a transition and yanks the
  // user off their persisted selection.
  let seenSucceededSeeded = false;

  // ---- toolbar version button ----
  const { btn: versionButton, text: versionButtonText } = buildVersionButton();
  toolbar.prepend(versionButton);

  // ---- baseline display (composer) ----
  let baselineLabel = null;
  if (baselineHost) {
    baselineHost.classList.add('composer-baseline');
    baselineLabel = el('span', 'composer-baseline-text', '');
    baselineHost.append(el('span', 'composer-baseline-key', '当前基线'), baselineLabel);
  }

  // ---- overlay (C2 panel) ----
  const overlay = el('div', 'version-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '版本树');
  overlay.hidden = true;
  const panel = el('div', 'c2-panel version-panel');
  const panelHead = el('div', 'version-panel-head');
  panelHead.append(el('p', 'eyebrow', 'Version Tree'), el('span', 'version-panel-title', '版本历史'));
  const archiveToggle = el('button', 'secondary version-archive-toggle', '显示归档');
  const closeBtn = el('button', 'icon-button version-close', '✕');
  closeBtn.title = '关闭';
  panelHead.append(archiveToggle, closeBtn);
  const listEl = el('div', 'version-list');
  listEl.setAttribute('role', 'list');
  panel.append(panelHead, listEl);
  overlay.append(panel);
  document.body.append(overlay);

  function openOverlay() {
    overlay.hidden = false;
    versionButton.setAttribute('aria-expanded', 'true');
    renderTree();
  }
  function closeOverlay() {
    overlay.hidden = true;
    versionButton.setAttribute('aria-expanded', 'false');
  }

  versionButton.addEventListener('click', () => {
    if (overlay.hidden) openOverlay();
    else closeOverlay();
  });
  closeBtn.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeOverlay();
  });
  archiveToggle.addEventListener('click', () => {
    showArchived = !showArchived;
    archiveToggle.textContent = showArchived ? '隐藏归档' : '显示归档';
    archiveToggle.classList.toggle('is-on', showArchived);
    renderTree();
  });

  // ---- chat view switch (branch dialogue / all events) ----
  // Inject a small segmented control into the chat session header.
  const chatSwitch = el('div', 'chat-view-switch');
  const branchBtn = el('button', 'chat-view-tab is-active', '当前分支');
  const eventsBtn = el('button', 'chat-view-tab', '全部操作记录');
  chatSwitch.append(branchBtn, eventsBtn);
  const chatHeader = messagesEl?.closest('.chat-session')?.querySelector('.chat-session-header');
  if (chatHeader) chatHeader.append(chatSwitch);
  branchBtn.addEventListener('click', () => setChatView('branch'));
  eventsBtn.addEventListener('click', () => setChatView('events'));

  function selectedVersion() {
    return versions.find((v) => v.versionId === selectedVersionId) || null;
  }

  function updateBaselineDisplay() {
    const v = selectedVersion();
    const label = formatBaselineLabel(v);
    versionButtonText.textContent = label || '版本';
    if (baselineLabel) baselineLabel.textContent = label || '（未选择）';
    versionButton.classList.toggle('is-confirmed', Boolean(v && v.confirmed));
  }

  function renderTree() {
    listEl.replaceChildren();
    const visible = filterVisibleVersions(sortVersionTree(versions), { showArchived });
    if (visible.length === 0) {
      listEl.append(el('div', 'version-empty', '暂无版本。'));
      return;
    }
    for (const v of visible) {
      listEl.append(renderTreeNode(v));
    }
  }

  function renderTreeNode(v) {
    const depth = (v.labelPath?.length || 1) - 1;
    const node = el('div', 'version-node');
    node.setAttribute('role', 'listitem');
    // data-version-id is the scroll-into-view anchor for pollGenerations —
    // without it scrollIntoView is unreachable (fix 2).
    node.setAttribute('data-version-id', v.versionId);
    node.style.setProperty('--node-depth', String(depth));
    node.classList.toggle('is-selected', v.versionId === selectedVersionId);
    node.classList.toggle('is-archived', v.archived);
    node.classList.toggle('is-confirmed', v.confirmed);

    const rail = el('div', 'version-node-rail');
    rail.append(el('span', 'version-node-label', v.versionLabel || ''));
    if (v.confirmed) rail.append(el('span', 'version-flag version-flag-confirmed', '已确认'));
    if (v.archived) rail.append(el('span', 'version-flag version-flag-archived', '归档'));

    const body = el('div', 'version-node-body');
    const title = el('span', 'version-node-title', v.title || '（无标题）');
    const meta = el('span', 'version-node-meta');
    if (v.createdAt) meta.append(el('time', '', formatTime(v.createdAt)));
    if (v.instructionSummary) {
      meta.append(el('span', 'version-node-instr', v.instructionSummary));
    }
    body.append(title, meta);

    const actions = el('div', 'version-node-actions');
    const editBtn = el('button', 'icon-button version-edit', '✎');
    editBtn.title = '编辑标题';
    const archiveBtn = el('button', 'icon-button version-archive-btn', v.archived ? '↩' : '▤');
    archiveBtn.title = v.archived ? '恢复' : '归档';
    actions.append(editBtn, archiveBtn);

    node.append(rail, body, actions);

    node.addEventListener('click', (event) => {
      // Ignore clicks that originate from the action buttons.
      if (event.target.closest('button')) return;
      void selectVersion(v.versionId);
    });
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void editTitle(v);
    });
    archiveBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggleArchive(v);
    });

    return node;
  }

  async function selectVersion(versionId) {
    const v = versions.find((x) => x.versionId === versionId);
    if (!v) return;
    onStatus('正在切换版本…');
    try {
      await switchVersion({
        client,
        version: v,
        renderPreview: (html) => renderPreviewFn(iframe, html),
        onBaselineChange: (version) => {
          selectedVersionId = version.versionId;
          saveSelectedVersionId(sessionId, version.versionId);
          updateBaselineDisplay();
        },
      });
      onStatus(`已切换至 ${v.versionLabel}`);
      renderTree();
      await refreshChatView();
    } catch (error) {
      onStatus(error.message || '切换版本失败');
    }
  }

  async function editTitle(v) {
    const next = window.prompt('编辑版本标题', v.title || '');
    if (next == null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed || trimmed === v.title) return;
    onStatus('正在保存标题…');
    try {
      const updated = await client.patchTitle(v.versionId, trimmed);
      const idx = versions.findIndex((x) => x.versionId === v.versionId);
      if (idx >= 0) versions[idx] = { ...versions[idx], ...updated };
      renderTree();
      updateBaselineDisplay();
      onStatus('标题已更新');
    } catch (error) {
      onStatus(error.message || '标题保存失败');
    }
  }

  async function toggleArchive(v) {
    onStatus(v.archived ? '正在恢复…' : '正在归档…');
    try {
      const updated = await client.patchArchived(v.versionId, !v.archived);
      const idx = versions.findIndex((x) => x.versionId === v.versionId);
      if (idx >= 0) versions[idx] = { ...versions[idx], ...updated };
      renderTree();
      onStatus(updated.archived ? '已归档' : '已恢复');
    } catch (error) {
      onStatus(error.message || '操作失败');
    }
  }

  // ---- chat views ----
  function setChatView(view) {
    chatView = view;
    branchBtn.classList.toggle('is-active', view === 'branch');
    eventsBtn.classList.toggle('is-active', view === 'events');
    void refreshChatView();
  }

  async function refreshChatView() {
    if (!messagesEl) return;
    if (chatView === 'branch') return renderBranchChat();
    return renderEventsChat();
  }

  async function renderBranchChat() {
    const v = selectedVersion();
    messagesEl.replaceChildren();
    if (!v) {
      messagesEl.append(el('div', 'message message-assistant', '请先选择一个版本以查看其分支对话。'));
      return;
    }
    try {
      const detail = await client.fetchDetail(v.versionId);
      if (!detail.branchDialogue || detail.branchDialogue.length === 0) {
        messagesEl.append(el('div', 'message message-assistant', '该分支暂无生成指令记录。'));
        return;
      }
      for (const step of detail.branchDialogue) {
        const userMsg = el('div', 'message message-user');
        userMsg.append(el('span', 'message-version-tag', step.versionLabel || ''));
        userMsg.append(document.createTextNode(step.instruction || '（无指令）'));
        messagesEl.append(userMsg);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (error) {
      messagesEl.append(el('div', 'message message-assistant', error.message || '加载分支对话失败'));
    }
  }

  async function renderEventsChat() {
    messagesEl.replaceChildren();
    try {
      const events = await client.fetchEvents();
      if (events.length === 0) {
        messagesEl.append(el('div', 'message message-assistant', '暂无操作记录。'));
        return;
      }
      for (const event of events) {
        const node = el('div', 'message message-event');
        node.append(el('span', 'message-event-seq', `#${event.seq}`));
        node.append(el('span', `message-event-type message-event-${event.type}`, describeEventType(event.type)));
        const summary = describeEventSummary(event);
        if (summary) node.append(el('span', 'message-event-summary', summary));
        if (event.createdAt) node.append(el('time', 'message-event-time', formatTime(event.createdAt)));
        messagesEl.append(node);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (error) {
      messagesEl.append(el('div', 'message message-assistant', error.message || '加载操作记录失败'));
    }
  }

  // ---- auto-select polling ----
  async function pollGenerations() {
    try {
      const requests = await client.fetchGenerations();
      const target = selectAutoOnSuccess(requests, lastSeenSucceededRequestId);
      if (!target) return;
      // A new generation JUST succeeded: refresh the tree so the node exists,
      // then auto-select + scroll to it. Mark the request as seen BEFORE the
      // async work so a rapid re-poll can't double-fire.
      lastSeenSucceededRequestId = target.requestId;
      await refresh();
      const node = listEl.querySelector(`[data-version-id="${target.resultVersionId}"]`);
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      await selectVersion(target.resultVersionId);
      openOverlay();
      onStatus('新版本已生成');
    } catch {
      /* transient poll failure; next tick retries */
    }
  }

  function startPolling(intervalMs = 3000) {
    if (pollTimer) return;
    pollTimer = setInterval(pollGenerations, intervalMs);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** Fetch the tree + (lazily) restore/seed the selected version, then render. */
  async function refresh() {
    try {
      // Sp3: on the FIRST refresh (init), seed lastSeenSucceededRequestId from
      // the current generations so the first poll sees no transition. Done
      // before fetchTree so a failure here doesn't block the tree render.
      if (!seenSucceededSeeded) {
        seenSucceededSeeded = true;
        try {
          const reqs = await client.fetchGenerations();
          lastSeenSucceededRequestId = newestSucceededRequestId(reqs);
        } catch {
          /* best-effort; leaving lastSeen null re-introduces the yank only if the
             generations endpoint is down, which is transient */
        }
      }
      versions = await client.fetchTree();
      // Restore a persisted selection, otherwise default to the confirmed
      // version, otherwise the session's mainline head. We deliberately do NOT
      // fall back to versions[length-1]: the highest labelPath can be a branch
      // tip (e.g. [2,1] sorts after [2]) rather than the mainline head (fix 4).
      if (!selectedVersionId || !versions.some((v) => v.versionId === selectedVersionId)) {
        const confirmed = versions.find((v) => v.confirmed);
        if (confirmed) {
          selectedVersionId = confirmed.versionId;
        } else {
          const session = await client.fetchSession();
          selectedVersionId = session?.mainlineHead?.versionId || null;
        }
        if (selectedVersionId) saveSelectedVersionId(sessionId, selectedVersionId);
      }
      renderTree();
      updateBaselineDisplay();
      await refreshChatView();
    } catch (error) {
      onStatus(error.message || '加载版本失败');
    }
  }

  /** Render the selected version's HTML into the preview (called on init). */
  async function renderSelectedPreview() {
    const v = selectedVersion();
    if (!v) return;
    try {
      const html = await client.fetchHtml(v.versionId);
      renderPreviewFn(iframe, html);
    } catch {
      /* leave the existing preview in place */
    }
  }

  return {
    refresh,
    selectVersion,
    openOverlay,
    closeOverlay,
    startPolling,
    stopPolling,
    renderSelectedPreview,
    getSelectedVersionId: () => selectedVersionId,
  };
}

// --------------------------------------------------------------- formatters

function formatTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function describeEventType(type) {
  const map = {
    generation_succeeded: '生成成功',
    generation_failed: '生成失败',
    legacy_imported: '旧稿导入',
    confirm: '确认采用',
    share_created: '创建分享',
    share_revoked: '撤销分享',
    delivery_delivered: '已交付',
    delivery_failed: '交付失败',
  };
  return map[type] || type;
}

function describeEventSummary(event) {
  const p = event.payloadSummary || {};
  const parts = [];
  if (p.versionLabel) parts.push(p.versionLabel);
  else if (p.versionId) parts.push(p.versionId);
  if (p.errorCode) parts.push(`错误：${p.errorCode}`);
  return parts.join(' · ');
}
