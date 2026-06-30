import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { createRateLimiter } from './lib/rateLimit.js';
import { validateGenerateRequest } from './lib/validation.js';

export function createApp({ config, deepseekClient }) {
  const app = express();
  const previews = new Map();
  const rateLimit = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
  });

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static('public'));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/previews', (req, res) => {
    const html = typeof req.body?.html === 'string' ? req.body.html.trim() : '';
    if (!html) {
      res.status(400).json({ error: '没有可分享的预览内容。' });
      return;
    }

    const id = crypto.randomUUID();
    previews.set(id, html);
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.json({
      id,
      url: `${baseUrl.replace(/\/$/, '')}/preview/${id}`,
    });
  });

  app.get('/preview/:id', (req, res) => {
    const html = previews.get(req.params.id);
    if (!html) {
      res.status(404).type('text/plain').send('Preview not found or expired.');
      return;
    }

    res.type('html').send(html);
  });

  app.post('/api/generate', rateLimit, async (req, res) => {
    if (!config.deepseekApiKey) {
      res.status(500).json({ error: '服务端未配置 DeepSeek API Key。' });
      return;
    }

    const validation = validateGenerateRequest(req.body);
    if (!validation.ok) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }

    try {
      const html = await deepseekClient.generateHtml(validation.value);
      res.json({ html });
    } catch (error) {
      console.error(error);
      res.status(502).json({ error: '调用 DeepSeek 失败，请稍后重试。' });
    }
  });

  return app;
}
