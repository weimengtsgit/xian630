const MAX_MESSAGE_LENGTH = 4000;
const MAX_HTML_LENGTH = 120000;
const MAX_HISTORY_ITEMS = 20;

export function validateGenerateRequest(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: '请求格式不正确。' };
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return { ok: false, status: 400, error: '请输入要生成或调整的界面需求。' };
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, status: 413, error: '输入内容过长，请精简后再提交。' };
  }

  const currentHtml = typeof body.currentHtml === 'string' ? body.currentHtml : '';
  if (currentHtml.length > MAX_HTML_LENGTH) {
    return { ok: false, status: 413, error: '当前原型内容过大，请重置后再生成。' };
  }

  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history = rawHistory
    .slice(-MAX_HISTORY_ITEMS)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content || '').slice(0, MAX_MESSAGE_LENGTH),
    }))
    .filter((item) => item.content.trim());

  return {
    ok: true,
    value: {
      message,
      history,
      currentHtml,
    },
  };
}
