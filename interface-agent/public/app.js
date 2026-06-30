const STORAGE_KEY = 'ai-prototype-workbench-state';
const STORAGE_VERSION = 3;

export function createDefaultPrototype() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      margin: 0;
      font-family: "OPPO Sans 4.0", Inter, ui-sans-serif, system-ui, sans-serif;
      background: #243340;
      color: #E5EAFF;
    }
    main {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 40px;
      box-sizing: border-box;
      background-image:
        radial-gradient(circle, rgba(187, 203, 217, 0.12) 1px, transparent 1px);
      background-size: 22px 22px;
    }
    section {
      max-width: 860px;
      width: 100%;
      border: 1px solid rgba(187, 203, 217, 0.35);
      background: #1B2732;
      border-radius: 18px;
      padding: 40px 36px;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.45);
      text-align: center;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 400;
      color: #E5EAFF;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>在下方输入你要生成的界面需求，生成结果会显示在这里。</h1>
    </section>
  </main>
</body>
</html>`;
}

export function loadWorkbenchState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { messages: [], currentHtml: createDefaultPrototype() };
    }
    const parsed = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION) {
      localStorage.removeItem(STORAGE_KEY);
      return { messages: [], currentHtml: createDefaultPrototype() };
    }
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      currentHtml: typeof parsed.currentHtml === 'string' ? parsed.currentHtml : createDefaultPrototype(),
    };
  } catch {
    return { messages: [], currentHtml: createDefaultPrototype() };
  }
}

export function saveWorkbenchState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: STORAGE_VERSION,
    messages: state.messages,
    currentHtml: state.currentHtml,
  }));
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

async function createPreviewShareUrl(html) {
  const response = await fetch('/api/previews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '创建预览链接失败。');
  }

  return payload.url;
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
  renderPreview(iframe, state.currentHtml);
  renderMessages(messagesEl, state.messages);

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

    state.messages.push({ role: 'user', content: message });
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
      const html = await requestGeneration({ message, state });
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
    saveWorkbenchState(state);
    renderPreview(iframe, state.currentHtml);
    renderMessages(messagesEl, state.messages);
    status.textContent = '已重置';
  });

  share.addEventListener('click', async () => {
    share.disabled = true;
    status.textContent = '正在创建预览链接';

    try {
      const url = await createPreviewShareUrl(state.currentHtml);
      try {
        await navigator.clipboard.writeText(url);
        state.messages.push({ role: 'assistant', content: `预览链接已复制：${url}` });
        status.textContent = '预览链接已复制';
      } catch {
        state.messages.push({ role: 'assistant', content: `预览链接已生成，请手动复制：${url}` });
        status.textContent = '预览链接已生成';
      }
    } catch (error) {
      state.messages.push({ role: 'assistant', content: error.message });
      status.textContent = '复制预览链接失败';
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
