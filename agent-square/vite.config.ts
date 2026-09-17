import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本地 dev 的 /api/apps：生产由容器内 nginx njs（deploy/ops-store-api.js）提供，
// 本地 vite dev 没有该服务，这里用 middleware 读写 runtime-data/api-apps.json，
// 行为与 njs 对齐（GET 列表 / POST 注册·按 id 幂等 upsert / DELETE 下架）。
// factory-server 部署成功后经 FACTORY_APP_SQUARE_URL 指向本端口即完成自动上架。
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const storeFile = path.join(projectRoot, 'runtime-data', 'api-apps.json');

type StoreApp = Record<string, any>;

function readApps(): StoreApp[] {
  try {
    const apps = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    return Array.isArray(apps) ? apps : [];
  } catch {
    return [];
  }
}

function writeApps(apps: StoreApp[]) {
  fs.writeFileSync(storeFile, JSON.stringify(apps, null, 2));
}

function firstChar(value: string): string {
  return Array.from(String(value || '应').trim())[0] || '应';
}

// 与 njs normalizeApp 同构：缺省字段补齐，输出即卡片数据形状。
function normalizeApp(input: any): StoreApp {
  const data = input || {};
  const name = data.name || data['名字'] || '未命名应用';
  const description = data.description || data['描述'] || '';
  return {
    id: data.id || `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    longDescription: data.longDescription || description,
    icon: firstChar(name),
    category: data.category || data['类别'] || '其他',
    status: '新品',
    version: data.version || data['版本'] || 'v1.0.0',
    vendor: data.vendor || data['厂商'] || '电子云',
    publishDate: data.publishDate || new Date().toISOString().slice(0, 10),
    link: data.link || data.url || '#',
    favorited: false,
    features: Array.isArray(data.features) ? data.features : ['外部接口注册', '新品自动推荐'],
  };
}

function sendJSON(res: any, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function storeApiPlugin(): Plugin {
  return {
    name: 'agent-square-store-api',
    configureServer(server) {
      server.middlewares.use('/api/apps', (req, res, next) => {
        // req.url 形如 ""（/api/apps）或 "/<id>"（/api/apps/<id>）
        const id = decodeURIComponent((req.url || '').replace(/^\//, ''));
        if (req.method === 'GET' && !id) {
          sendJSON(res, 200, readApps());
          return;
        }
        if (req.method === 'POST' && !id) {
          readBody(req).then((raw) => {
            let incoming: any;
            try {
              incoming = JSON.parse(raw);
            } catch {
              sendJSON(res, 400, { error: 'invalid JSON' });
              return;
            }
            const app = normalizeApp(incoming);
            const apps = readApps();
            const existingIdx = apps.findIndex((a) => a && a.id === app.id);
            if (existingIdx >= 0) {
              // 幂等 upsert：重新部署更新卡片内容，保留用户收藏与原上架日期。
              app.favorited = !!apps[existingIdx].favorited;
              app.publishDate = apps[existingIdx].publishDate || app.publishDate;
              apps[existingIdx] = app;
            } else {
              apps.push(app);
            }
            writeApps(apps);
            sendJSON(res, existingIdx >= 0 ? 200 : 201, app);
          });
          return;
        }
        if (req.method === 'DELETE' && id) {
          const apps = readApps();
          const next = apps.filter((a) => a && a.id !== id && a.name !== id);
          if (next.length === apps.length) {
            sendJSON(res, 404, { error: 'not found' });
            return;
          }
          writeApps(next);
          sendJSON(res, 200, { deleted: id });
          return;
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), storeApiPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
