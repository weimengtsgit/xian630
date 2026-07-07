const STORAGE_KEY = 'ai-prototype-workbench-state';
const STORAGE_VERSION = 5;

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

async function requestGeneration({ message, state }) {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      history: state.messages,
      currentHtml: state.currentHtml,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '生成失败，请稍后重试。');
  }

  return payload.html;
}

async function requestPendingInput() {
  const response = await fetch('/api/pending-input');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '读取待定输入文件失败。');
  }
  return payload;
}

async function createPreviewSharePayload(html) {
  const response = await fetch('/api/previews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '创建预览链接失败。');
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
  const reset = document.querySelector('#reset');
  const share = document.querySelector('#share');
  const fullscreen = document.querySelector('#fullscreen');
  const submit = document.querySelector('#submit');

  const state = loadWorkbenchState();
  let pendingTimer = null;
  let pendingPollIntervalMs = 3000;
  renderPreview(iframe, state.currentHtml);
  renderMessages(messagesEl, state.messages);

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

    const generationSubmission = prepareGenerationSubmission(state, message);
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
      const html = await requestGeneration({ message, state: generationSubmission.requestState });
      state.currentHtml = html;
      state.messages.push({ role: 'assistant', content: '已更新上方原型界面。' });
      renderPreview(iframe, html);
      status.textContent = '已更新';
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

  reset.addEventListener('click', () => {
    state.messages = [];
    state.currentHtml = createDefaultPrototype();
    state.pendingPollingStopped = false;
    saveWorkbenchState(state);
    renderPreview(iframe, state.currentHtml);
    renderMessages(messagesEl, state.messages);
    status.textContent = '已重置';
    startPendingPolling();
  });

  share.addEventListener('click', async () => {
    share.disabled = true;
    status.textContent = '正在创建预览链接';

    try {
      const payload = await createPreviewSharePayload(state.currentHtml);
      try {
        await navigator.clipboard.writeText(payload.url);
        state.messages.push({ role: 'assistant', content: createShareSuccessMessage({ ...payload, copied: true }) });
        status.textContent = payload.confirmedOutputPath ? '已确认并写入共享文件' : '预览链接已复制';
      } catch {
        state.messages.push({ role: 'assistant', content: createShareSuccessMessage({ ...payload, copied: false }) });
        status.textContent = payload.confirmedOutputPath ? '已确认并写入共享文件' : '预览链接已生成';
      }
    } catch (error) {
      state.messages.push({ role: 'assistant', content: error.message });
      status.textContent = '确认共享失败';
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
