import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  createLoadingText,
  createDefaultPrototype,
  appendPendingInputToState,
  createShareSuccessMessage,
  prepareGenerationSubmission,
  loadWorkbenchState,
  renderPreview,
  requestPreviewFullscreen,
  shouldSubmitOnKeydown,
  setPreviewLoading,
  saveWorkbenchState,
} from '../public/app.js';

describe('frontend workbench state', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><iframe id="preview"></iframe>', {
      url: 'http://localhost/',
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.localStorage = dom.window.localStorage;
  });

  it('saves and loads chat plus current HTML', () => {
    const state = {
      messages: [{ role: 'user', content: 'Create dashboard' }],
      currentHtml: '<main>Dashboard</main>',
      pendingPollingStopped: false,
    };

    saveWorkbenchState(state);

    expect(loadWorkbenchState()).toEqual(state);
  });

  it('adds pending file text to the conversation state for manual generation', () => {
    const state = { messages: [], currentHtml: createDefaultPrototype() };

    const value = appendPendingInputToState(state, '# 页面需求\n生成监控大屏');

    expect(value).toBe('# 页面需求\n生成监控大屏');
    expect(state.messages).toEqual([{ role: 'user', content: '# 页面需求\n生成监控大屏', pendingInput: true }]);
  });

  it('does not duplicate an unchanged pending input when generating', () => {
    const state = {
      messages: [{ role: 'user', content: '生成监控大屏', pendingInput: true }],
      currentHtml: createDefaultPrototype(),
      pendingPollingStopped: true,
    };

    const result = prepareGenerationSubmission(state, '生成监控大屏');

    expect(result.requestState.messages).toEqual([]);
    expect(state.messages).toHaveLength(1);
  });

  it('formats share success messages with the confirmed shared output path', () => {
    const message = createShareSuccessMessage({
      url: 'http://localhost/preview/abc',
      confirmedOutputPath: '共享/prototype.html',
      copied: true,
    });

    expect(message).toContain('预览链接已复制：http://localhost/preview/abc');
    expect(message).toContain('共享文件已写入：共享/prototype.html');
  });

  it('renders HTML into the sandboxed iframe srcdoc', () => {
    const iframe = document.querySelector('#preview');

    renderPreview(iframe, '<main>Preview</main>');

    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toContain('<main>Preview</main>');
  });

  it('provides a non-empty default prototype', () => {
    expect(createDefaultPrototype()).toContain('在下方输入你要生成的界面需求，生成结果会显示在这里。');
  });

  it('formats visible loading text with elapsed seconds', () => {
    expect(createLoadingText(12)).toBe('正在生成，已等待 12 秒...');
  });

  it('toggles the preview loading overlay', () => {
    const loading = document.createElement('div');

    setPreviewLoading(loading, true, 5);

    expect(loading.hidden).toBe(false);
    expect(loading.textContent).toContain('已等待 5 秒');

    setPreviewLoading(loading, false, 0);

    expect(loading.hidden).toBe(true);
  });

  it('submits on Enter but keeps Shift+Enter for new lines', () => {
    expect(shouldSubmitOnKeydown({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitOnKeydown({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitOnKeydown({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });

  it('requests fullscreen for the preview target', async () => {
    let requested = false;
    const target = {
      async requestFullscreen() {
        requested = true;
      },
      classList: { add() {} },
    };

    await requestPreviewFullscreen(target);

    expect(requested).toBe(true);
  });

  it('renders the new agent title and fullscreen control', () => {
    const html = readFileSync('public/index.html', 'utf8');

    expect(html).toContain('界面解析智能体');
    expect(html).not.toContain('AI 原型样式工作台');
    expect(html).toContain('id="fullscreen"');
  });
});
