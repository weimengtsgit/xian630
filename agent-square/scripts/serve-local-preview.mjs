import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.resolve(process.env.DIST_DIR || path.join(projectRoot, 'dist'));
const dataFile = path.resolve(
  process.env.API_APPS_FILE ||
    path.join(projectRoot, 'runtime-data', 'api-apps.json'),
);
const port = Number(process.env.PORT || process.env.LOCAL_PREVIEW_PORT || 18016);
const host = process.env.HOST || '127.0.0.1';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const json = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
};

const readApps = async () => {
  try {
    const text = await readFile(dataFile, 'utf8');
    const apps = JSON.parse(text);
    return Array.isArray(apps) ? apps : [];
  } catch {
    return [];
  }
};

const writeApps = async (apps) => {
  await mkdir(path.dirname(dataFile), { recursive: true });
  await writeFile(dataFile, `${JSON.stringify(apps, null, 2)}\n`, 'utf8');
};

const readRequestBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error('request_body_too_large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const firstChar = (value) => Array.from(String(value || '应'))[0] || '应';

const normalizeApp = (input) => {
  const data = input || {};
  const name = data.name || data['名字'] || '未命名应用';
  const description = data.description || data['描述'] || '';
  return {
    id: data.id || `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    longDescription: data.longDescription || description,
    icon: data.icon || firstChar(name),
    category: data.category || data['类别'] || '其他',
    status: '新品',
    version: data.version || data['版本'] || 'v1.0.0',
    vendor: data.vendor || data['厂商'] || '国防科大，电子云',
    publishDate: data.publishDate || new Date().toISOString().slice(0, 10),
    link: data.link || data.url || '#',
    favorited: false,
    features: Array.isArray(data.features) ? data.features : ['外部接口注册', '新品自动推荐'],
  };
};

const handleAppsApi = async (req, res, pathname) => {
  if (req.method === 'OPTIONS') {
    json(res, 204, null);
    return;
  }

  if (req.method === 'GET') {
    json(res, 200, await readApps());
    return;
  }

  if (req.method === 'POST') {
    let input;
    try {
      input = JSON.parse(await readRequestBody(req) || '{}');
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }

    const app = normalizeApp(input);
    const apps = (await readApps()).filter((item) => item.id !== app.id && item.name !== app.name);
    apps.unshift(app);
    await writeApps(apps);
    json(res, 201, app);
    return;
  }

  if (req.method === 'DELETE') {
    const key = decodeURIComponent(pathname.replace(/^\/api\/apps\/?/, ''));
    if (!key) {
      json(res, 400, { error: 'missing_id_or_name' });
      return;
    }

    const before = await readApps();
    const after = before.filter((item) => item.id !== key && item.name !== key);
    await writeApps(after);
    json(res, 200, { deleted: before.length - after.length });
    return;
  }

  json(res, 405, { error: 'method_not_allowed' });
};

const resolveStaticFile = async (pathname) => {
  const decoded = decodeURIComponent(pathname);
  const requested = path.resolve(distRoot, decoded.replace(/^\/+/, ''));
  const insideRoot = requested === distRoot || requested.startsWith(`${distRoot}${path.sep}`);
  if (!insideRoot) return path.join(distRoot, 'index.html');

  try {
    const info = await stat(requested);
    if (info.isFile()) return requested;
    if (info.isDirectory() && existsSync(path.join(requested, 'index.html'))) {
      return path.join(requested, 'index.html');
    }
  } catch {
    return path.join(distRoot, 'index.html');
  }

  return path.join(distRoot, 'index.html');
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK');
      return;
    }

    if (url.pathname === '/api/apps' || url.pathname.startsWith('/api/apps/')) {
      await handleAppsApi(req, res, url.pathname);
      return;
    }

    const file = await resolveStaticFile(url.pathname);
    const type = contentTypes.get(path.extname(file)) || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    createReadStream(file).pipe(res);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : 'internal_error' });
  }
});

server.listen(port, host, () => {
  console.log(`local preview: http://${host}:${port}/`);
  console.log(`dist root: ${distRoot}`);
  console.log(`api apps: ${dataFile}`);
});
