// agent-square 运行时应用接口（njs）：/api/apps 的 GET/POST/DELETE。
// 源自线上捕获 docs/online-18016/ops-store-api.js，仅把 normalizeApp 默认分类
// 由 '情报分析' 改为 '其他'（与前端 src/App.tsx 分类体系一致）。
// 运行时数据存 /var/cache/nginx/appstore/runtime-apps.json（部署时 bind-mount 持久化）。
import fs from 'fs';

const storePath = '/var/cache/nginx/appstore/runtime-apps.json';

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
  return Array.from(String(value || '应').trim())[0] || '应';
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
    const showAll = (r.args && r.args.all === '1');
    const all = readApps();
    json(r, 200, showAll ? all : all.filter(item => !item.deleted));
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
    const apps = readApps();

    // 如果同名/id 已存在（包括软删除的），在旧记录位置原地替换，保留 deleted 以外的字段不变
    const idx = apps.findIndex(item => item.id === app.id || item.name === app.name);
    if (idx >= 0) {
      const prev = apps[idx];
      apps[idx] = Object.assign({}, prev, app, { deleted: false });
    } else {
      apps.unshift(app);
    }

    writeApps(apps);
    json(r, 201, apps[idx >= 0 ? idx : 0]);
    return;
  }

  if (r.method === 'DELETE') {
    const key = decodeURIComponent(r.uri.replace(/^\/api\/apps\/?/, ''));
    if (!key) {
      json(r, 400, { error: 'missing_id_or_name' });
      return;
    }

    const apps = readApps();
    let deleted = 0;
    for (let i = 0; i < apps.length; i++) {
      if (apps[i].id === key || apps[i].name === key) {
        apps[i].deleted = true;
        deleted += 1;
      }
    }
    writeApps(apps);
    json(r, 200, { deleted });
    return;
  }

  json(r, 405, { error: 'method_not_allowed' });
}

export default { apps };
