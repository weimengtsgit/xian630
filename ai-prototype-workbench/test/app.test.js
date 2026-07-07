import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

function createTestConfig(overrides = {}) {
  return {
    publicBaseUrl: '',
    rateLimitWindowMs: 60000,
    rateLimitMax: 20,
    pendingPollIntervalMs: 3000,
    pendingInputPath: '',
    confirmedOutputPath: '共享/prototype.html',
    pipelineStageCompleteUrl: 'http://flow.example/api/stages/agent-prototype',
    pipelineCompleteTimeoutMs: 1000,
    ...overrides,
  };
}

describe('POST /api/previews', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the prototype stage completed after confirmation succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn() });
    vi.stubGlobal('fetch', fetchMock);
    const fileClient = { uploadText: vi.fn().mockResolvedValue() };
    const app = createApp({
      config: createTestConfig(),
      deepseekClient: null,
      fileClient,
      fetchClient: fetchMock,
    });

    await request(app)
      .post('/api/previews')
      .send({ html: '<!doctype html><html><body>ok</body></html>' })
      .expect(200);

    expect(fetchMock).toHaveBeenCalledWith('http://flow.example/api/stages/agent-prototype', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
      signal: expect.any(AbortSignal),
    });
  });
});
