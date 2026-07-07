import fs from 'fs';

const storePath = '/usr/share/nginx/html/assets/runtime-apps.json';

function json(r, status, data) {
  r.headersOut['Content-Type'] = 'application/json; charset=utf-8';
  r.return(status, JSON.stringify(data));
}

function readApps() {
  try {
    const text = fs.readFileSync(storePath, 'utf8');
    const apps = JSON.parse(text);
    return Array.isArray(apps) ? apps : [];
  } catch (error) {
    return [];
  }
}

function writeApps(apps) {
  fs.writeFileSync(storePath, JSON.stringify(apps, null, 2));
}

function firstChar(value) {
  return Array.from(String(value || '应'))[0] || '应';
}

function normalizeApp(input) {
  const data = input || {};
  const name = data.name || data['名字'] || '未命名应用';
  const description = data.description || data['描述'] || '';
  return {
    id: data.id || `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    longDescription: data.longDescription || description,
    icon: firstChar(name),
    category: data.category || data['类别'] || '情报分析',
    status: '新品',
    version: data.version || data['版本'] || 'v1.0.0',
    vendor: data.vendor || data['厂商'] || '电子云',
    publishDate: data.publishDate || new Date().toISOString().slice(0, 10),
    link: data.link || data.url || '#',
    favorited: false,
    features: Array.isArray(data.features) ? data.features : ['外部接口注册', '新品自动推荐'],
  };
}

function apps(r) {
  if (r.method === 'OPTIONS') {
    r.headersOut['Access-Control-Allow-Origin'] = '*';
    r.headersOut['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    r.headersOut['Access-Control-Allow-Headers'] = 'Content-Type';
    r.return(204);
    return;
  }

  r.headersOut['Access-Control-Allow-Origin'] = '*';

  if (r.method === 'GET') {
    json(r, 200, readApps());
    return;
  }

  if (r.method === 'POST') {
    let input;
    try {
      input = JSON.parse(r.requestText || '{}');
    } catch (error) {
      json(r, 400, { error: 'invalid_json' });
      return;
    }

    const app = normalizeApp(input);
    const apps = readApps().filter(item => item.id !== app.id && item.name !== app.name);
    apps.unshift(app);
    writeApps(apps);
    json(r, 201, app);
    return;
  }

  if (r.method === 'DELETE') {
    const key = decodeURIComponent(r.uri.replace(/^\/api\/apps\/?/, ''));
    if (!key) {
      json(r, 400, { error: 'missing_id_or_name' });
      return;
    }

    const before = readApps();
    const after = before.filter(item => item.id !== key && item.name !== key);
    writeApps(after);
    json(r, 200, { deleted: before.length - after.length });
    return;
  }

  json(r, 405, { error: 'method_not_allowed' });
}

export default { apps };
