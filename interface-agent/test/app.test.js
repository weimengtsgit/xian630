import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

/**
 * Fix 5 (P1): The legacy backdoor routes POST /api/previews and
 * POST /api/generate are REMOVED. The compat file write + pipeline push now
 * happen ONLY via the delivery worker (confirm → deliver). A removal is
 * verified by the routes returning 404 (not registered). The delivery worker
 * tests (test/deliveries.test.js) cover the pipeline-notify path; the
 * generations worker + DeepSeek client tests cover model invocation.
 */
describe('legacy backdoors removed (Fix 5)', () => {
  it('POST /api/previews → 404 (removed; delivery worker is the only write path)', async () => {
    const app = createApp({
      config: {
        confirmedOutputPath: '共享/prototype.html',
        pipelineStageCompleteUrl: 'http://flow.example/api/stages/agent-prototype',
      },
      deepseekClient: null,
      fileClient: { uploadText: vi.fn() },
      fetchClient: vi.fn(),
    });

    const res = await request(app)
      .post('/api/previews')
      .send({ html: '<!doctype html><html><body>ok</body></html>' });

    expect(res.status).toBe(404);
  });

  it('POST /api/generate → 404 (removed; async generations endpoint is the only path)', async () => {
    const app = createApp({
      config: {
        deepseekApiKey: 'test-key',
        rateLimitWindowMs: 60000,
        rateLimitMax: 20,
      },
      deepseekClient: { generateHtml: vi.fn() },
    });

    const res = await request(app)
      .post('/api/generate')
      .send({ message: 'Create a dashboard', history: [], currentHtml: '' });

    expect(res.status).toBe(404);
  });
});
