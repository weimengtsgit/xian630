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

describe('POST /api/generate', () => {
  it('returns generated HTML from the injected client', async () => {
    const deepseekClient = {
      generateHtml: vi.fn().mockResolvedValue('<main>Generated</main>'),
    };
    const app = createApp({
      config: {
        deepseekApiKey: 'test-key',
        deepseekBaseUrl: 'https://example.test',
        deepseekModel: 'deepseek-chat',
        publicBaseUrl: 'http://192.168.1.109:3100',
        port: 3000,
      },
      deepseekClient,
    });

    const response = await request(app)
      .post('/api/generate')
      .send({ message: 'Create a dashboard', history: [], currentHtml: '' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ html: '<main>Generated</main>' });
    expect(deepseekClient.generateHtml).toHaveBeenCalledWith({
      message: 'Create a dashboard',
      history: [],
      currentHtml: '',
    });
  });

  it('rejects requests when the API key is not configured', async () => {
    const app = createApp({
      config: {
        deepseekApiKey: '',
        deepseekBaseUrl: 'https://example.test',
        deepseekModel: 'deepseek-chat',
        port: 3000,
      },
      deepseekClient: { generateHtml: vi.fn() },
    });

    const response = await request(app)
      .post('/api/generate')
      .send({ message: 'Create a dashboard' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('服务端未配置 DeepSeek API Key。');
  });
});

describe('preview-only sharing', () => {
  it('creates a preview URL and serves only the generated HTML', async () => {
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

    const createResponse = await request(app)
      .post('/api/previews')
      .set('Host', 'workbench.test')
      .send({ html: '<main><h1>Shared Preview</h1></main>' });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.url).toMatch(/^http:\/\/192\.168\.1\.109:3100\/preview\/[a-f0-9-]+$/);

    const previewPath = new URL(createResponse.body.url).pathname;
    const previewResponse = await request(app).get(previewPath);

    expect(previewResponse.status).toBe(200);
    expect(previewResponse.text).toContain('Shared Preview');
    expect(previewResponse.text).not.toContain('chat-panel');
  });
});

describe('rate limiting', () => {
  it('limits repeated generate requests from the same IP', async () => {
    const app = createApp({
      config: {
        deepseekApiKey: 'test-key',
        deepseekBaseUrl: 'https://example.test',
        deepseekModel: 'deepseek-chat',
        port: 3000,
        rateLimitWindowMs: 60000,
        rateLimitMax: 1,
      },
      deepseekClient: {
        generateHtml: vi.fn().mockResolvedValue('<main>Generated</main>'),
      },
    });

    await request(app).post('/api/generate').send({ message: 'Create one' }).expect(200);
    const response = await request(app).post('/api/generate').send({ message: 'Create two' });

    expect(response.status).toBe(429);
    expect(response.body.error).toBe('请求过于频繁，请稍后再试。');
  });
});
