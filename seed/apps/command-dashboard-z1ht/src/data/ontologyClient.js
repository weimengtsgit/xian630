// 本体 DaaS 请求客户端（ AviationCarrier / RawAISData 共用）
// 契约（carrier-affiliation-data-skill 实测口径）：
//   - 同源代理路径 /api/ontology/daasDMS/entity/<Entity>/list（鉴权头由 nginx 注入）
//   - 请求体 pageParam:{pageIndex,limit} + rowType:"map"
//   - 成功 resultCode===200（部分实体成功码嵌套于 details.resultCode，两者兼容）
//   - 行取 details.rows，并兼容按 columnNames 展开的数组行
// 本文件仅做取数，不含任何几何/随机运算。
export const ONTOLOGY_PROXY_BASE = '/api/ontology';
export const ONTOLOGY_TIMEOUT_MS = 15000;

const ENTITY_PATH = `${ONTOLOGY_PROXY_BASE}/daasDMS/entity`;

export function numSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 兼容 map 行与按 columnNames 展开的数组行
export function normalizeRows(details) {
  const names = (details && details.columnNames) || [];
  const rows = (details && details.rows) || [];
  return rows.map((row) => {
    if (Array.isArray(row)) return Object.fromEntries(names.map((n, i) => [n, row[i]]));
    return row || {};
  });
}

export async function fetchEntity(entity, columns, filters = [], limit = 100, timeoutMs = ONTOLOGY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENTITY_PATH}/${entity}/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns, pageParam: { pageIndex: 1, limit }, rowType: 'map', filters }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // 成功判定 resultCode===200（部分实体成功码嵌套于 details.resultCode，两者兼容）
    const ok = json && (json.resultCode === 200 || (json.details && json.details.resultCode === 200));
    if (!ok) {
      const code = json && (json.resultCode != null ? json.resultCode : json.details && json.details.resultCode);
      const msg = (json && (json.message || json.resultDesc)) || (json && json.details && json.details.resultDesc) || '';
      throw new Error(`API ${code}${msg ? `：${msg}` : ''}`);
    }
    return normalizeRows(json.details);
  } finally {
    clearTimeout(timer);
  }
}
