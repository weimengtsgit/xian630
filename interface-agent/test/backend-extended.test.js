import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { stripHtmlFences } from '../src/lib/html.js';
import { validateGenerateRequest } from '../src/lib/validation.js';
import { buildMessages, createDeepSeekClient, createTimeoutSignal, resolveFetch } from '../src/lib/deepseek.js';

describe('app smoke routes', () => {
  it('returns health status', async () => {
    const app = createApp({
      config: {
        deepseekApiKey: 'test-key',
        deepseekBaseUrl: 'https://example.test',
        deepseekModel: 'deepseek-chat',
        publicBaseUrl: 'http://192.168.1.109:3100',
        port: 3000,
      },
      deepseekClient: { generateHtml: vi.fn() },
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});

describe('config loading', () => {
  it('loads host binding from environment', () => {
    const config = loadConfig({
      HOST: '0.0.0.0',
      PORT: '3100',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3100);
  });

  it('uses Anthropic-compatible token variables when DeepSeek variables are absent', () => {
    const config = loadConfig({
      ANTHROPIC_AUTH_TOKEN: 'token-from-anthropic-env',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
    });

    expect(config.deepseekApiKey).toBe('token-from-anthropic-env');
    expect(config.deepseekModel).toBe('deepseek-v4-pro');
  });

  it('loads an optional public base URL for share links', () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'http://192.168.1.109:3100',
    });

    expect(config.publicBaseUrl).toBe('http://192.168.1.109:3100');
  });

  it('loads file-server paths for pending input and confirmed output', () => {
    const config = loadConfig({
      BLADE_OS_BASE_URL: 'http://115.190.152.1/',
      BLADE_OS_PAT: 'sk-test',
      PENDING_INPUT_PATH: '共享/pending.md',
      CONFIRMED_OUTPUT_PATH: '共享/prototype.html',
      PENDING_POLL_INTERVAL_MS: '5000',
    });

    expect(config.bladeOsBaseUrl).toBe('http://115.190.152.1');
    expect(config.bladeOsPat).toBe('sk-test');
    expect(config.pendingInputPath).toBe('共享/pending.md');
    expect(config.confirmedOutputPath).toBe('共享/prototype.html');
    expect(config.pendingPollIntervalMs).toBe(5000);
  });
});

describe('generate request validation', () => {
  it('accepts a normal generation request', () => {
    const result = validateGenerateRequest({
      message: 'Make a CRM dashboard',
      history: [{ role: 'user', content: 'Create dashboard' }],
      currentHtml: '<main>Hello</main>',
    });

    expect(result.ok).toBe(true);
    expect(result.value.message).toBe('Make a CRM dashboard');
  });

  it('rejects empty messages', () => {
    const result = validateGenerateRequest({ message: '   ' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('请输入要生成或调整的界面需求。');
  });
});

describe('HTML normalization', () => {
  it('strips markdown html fences', () => {
    expect(stripHtmlFences('```html\n<section>Hi</section>\n```')).toBe('<section>Hi</section>');
  });

  it('extracts fenced HTML when the model adds prose around it', () => {
    expect(stripHtmlFences('Here is the page:\n```html\n<main>Hi</main>\n```\nThanks')).toBe('<main>Hi</main>');
  });

  it('keeps plain HTML unchanged except trimming', () => {
    expect(stripHtmlFences('  <div>Plain</div>  ')).toBe('<div>Plain</div>');
  });
});

describe('DeepSeek prompt construction', () => {
  it('includes current HTML when adjusting an existing prototype', () => {
    const messages = buildMessages({
      message: 'Make buttons flatter',
      history: [{ role: 'user', content: 'Create a dashboard' }],
      currentHtml: '<button>Save</button>',
    });

    expect(messages[0].role).toBe('system');
    expect(messages.at(-1).content).toContain('Make buttons flatter');
    expect(messages.at(-1).content).toContain('<button>Save</button>');
  });

  it('applies the uploaded dark technology style guide to generated prototypes', () => {
    const messages = buildMessages({
      message: 'Create a dashboard',
      history: [],
      currentHtml: '',
    });

    expect(messages[0].content).toContain('#243340');
    expect(messages[0].content).toContain('#1B2732');
    expect(messages[0].content).toContain('OPPO Sans');
    expect(messages[0].content).toContain('YouSheBiaoTiHei');
    expect(messages[0].content).toContain('Leaflet');
    expect(messages[0].content).toContain('ECharts');
    expect(messages[0].content).toContain('dataZoom');
    expect(messages[0].content).toContain('markLine');
  });
});

describe('DeepSeek runtime compatibility', () => {
  it('falls back to a bundled fetch implementation when global fetch is missing', () => {
    expect(typeof resolveFetch(undefined)).toBe('function');
  });

  it('creates timeout signals without requiring AbortSignal.timeout', () => {
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = undefined;

    try {
      const signal = createTimeoutSignal(10);

      expect(signal).toBeDefined();
      expect(typeof signal.aborted).toBe('boolean');
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });
});

describe('pending input polling', () => {
  it('returns pending text from the configured shared input file', async () => {
    const fileClient = {
      readText: vi.fn().mockResolvedValue('# 生成态势页面\n请使用深色风格'),
    };
    const app = createApp({
      config: {
        deepseekApiKey: 'test-key',
        deepseekBaseUrl: 'https://example.test',
        deepseekModel: 'deepseek-chat',
        pendingInputPath: '共享/pending.md',
        port: 3000,
      },
      deepseekClient: { generateHtml: vi.fn() },
      fileClient,
    });

    const response = await request(app).get('/api/pending-input');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      available: true,
      content: '# 生成态势页面\n请使用深色风格',
      path: '共享/pending.md',
      pollIntervalMs: 3000,
    });
    expect(fileClient.readText).toHaveBeenCalledWith('共享/pending.md');
  });

  it('returns unavailable when the pending input file is not found', async () => {
    const notFound = new Error('not found');
    notFound.status = 404;
    const fileClient = {
      readText: vi.fn().mockRejectedValue(notFound),
    };
    const app = createApp({
      config: {
        deepseekApiKey: 'test-key',
        deepseekBaseUrl: 'https://example.test',
        deepseekModel: 'deepseek-chat',
        pendingInputPath: '共享/pending.md',
        port: 3000,
      },
      deepseekClient: { generateHtml: vi.fn() },
      fileClient,
    });

    const response = await request(app).get('/api/pending-input');

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(false);
  });
});

// Fix 5: POST /api/generate and POST /api/previews removed — the rate-limit
// test (which targeted /api/generate) and the preview-sharing tests are
// removed. The DeepSeek client + buildMessages remain covered above; the
// async generations flow + delivery pipeline-notify are covered by
// test/generations.test.js and test/deliveries.test.js respectively.
