import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { createRateLimiter } from './lib/rateLimit.js';
import { validateGenerateRequest } from './lib/validation.js';
import { BladeFileError } from './lib/bladeFiles.js';

function isNotFoundError(error) {
  return error?.status === 404 || (error instanceof BladeFileError && error.status === 404);
}

export function createApp({ config, deepseekClient, fileClient = null }) {
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

  app.get('/api/pending-input', async (_req, res) => {
    const pollIntervalMs = config.pendingPollIntervalMs || 3000;
    if (!config.pendingInputPath) {
      res.json({ available: false, pollIntervalMs });
      return;
    }
    if (!fileClient) {
      res.status(500).json({ error: '服务端未配置 Blade OS 文件服务。' });
      return;
    }

    try {
      const content = await fileClient.readText(config.pendingInputPath);
      if (!content.trim()) {
        res.json({ available: false, path: config.pendingInputPath, pollIntervalMs });
        return;
      }
      res.json({
        available: true,
        content,
        path: config.pendingInputPath,
        pollIntervalMs,
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        res.json({ available: false, path: config.pendingInputPath, pollIntervalMs });
        return;
      }
      console.error(error);
      res.status(502).json({ error: '读取待定输入文件失败。' });
    }
  });

  app.post('/api/previews', async (req, res) => {
    const html = typeof req.body?.html === 'string' ? req.body.html.trim() : '';
    if (!html) {
      res.status(400).json({ error: '没有可分享的预览内容。' });
      return;
    }

    const id = crypto.randomUUID();
    const baseUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const payload = {
      id,
      url: `${baseUrl.replace(/\/$/, '')}/preview/${id}`,
    };

    if (config.confirmedOutputPath && !fileClient) {
      res.status(500).json({ error: '服务端未配置 Blade OS 文件服务。' });
      return;
    }

    if (fileClient && config.confirmedOutputPath) {
      try {
        await fileClient.uploadText(config.confirmedOutputPath, html);
        payload.confirmedOutputPath = config.confirmedOutputPath;
      } catch (error) {
        console.error(error);
        res.status(502).json({ error: '共享文件写入失败，请稍后重试。' });
        return;
      }
    }

    previews.set(id, html);
    res.json(payload);
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
