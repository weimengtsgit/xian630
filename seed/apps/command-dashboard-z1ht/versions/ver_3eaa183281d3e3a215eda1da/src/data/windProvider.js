// 风场数据接入：Open-Meteo 公开朗格 10 米风（真实公开源，免鉴权）
// 路径：浏览器 → 同源 /api/wind/（nginx 反代）→ https://api.open-meteo.com
// 降级序（数据接入方案确认）：tier1 /v1/gfs → tier2 /v1/forecast?models=best_match
//   → 全部失败返回 SOURCE_ALL_FAILED（调用方呈现显式错误态，绝不以合成值顶替）
// 请求：hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=1&timezone=UTC
// 本文件仅做取数与归一化（当前 UTC 小时槽抽取），不含任何几何/随机运算。
import { REQUEST_TIMEOUT_MS, WIND_REQUEST_RETRY, SOURCE_LABELS } from '../constants.js';
import { currentUtcHourKey, windSlotAgeHours } from '../utils/timeFormat.js';
import { directionCardinal16 } from '../utils/deckWind.js';

const WIND_PROXY_BASE = '/api/wind';

const TIERS = [
  { id: 'open-meteo-gfs', label: 'Open-Meteo GFS（/v1/gfs）', path: '/v1/gfs', extraParams: '' },
  { id: 'open-meteo-bestmatch', label: 'Open-Meteo best_match（/v1/forecast）', path: '/v1/forecast', extraParams: '&models=best_match' },
];

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(tier, points) {
  const lats = points.map((p) => p.lat).join(',');
  const lons = points.map((p) => p.lon).join(',');
  return `${WIND_PROXY_BASE}${tier.path}?latitude=${encodeURIComponent(lats)}&longitude=${encodeURIComponent(lons)}` +
    `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=1&timezone=UTC${tier.extraParams}`;
}

// 从单点响应中抽取当前 UTC 小时槽（无匹配时回退到 ≤now 的最近槽，再回退首槽）
function extractCurrentSlot(payload, nowKey) {
  const h = payload && payload.hourly;
  if (!h || !Array.isArray(h.time) || h.time.length === 0) return null;
  let idx = h.time.indexOf(nowKey);
  if (idx === -1) {
    for (let i = h.time.length - 1; i >= 0; i -= 1) {
      if (String(h.time[i]) <= nowKey) { idx = i; break; }
    }
  }
  if (idx === -1) idx = 0;
  const speed = Number(h.wind_speed_10m != null ? h.wind_speed_10m[idx] : NaN);
  const dir = Number(h.wind_direction_10m != null ? h.wind_direction_10m[idx] : NaN);
  if (!Number.isFinite(speed) || !Number.isFinite(dir)) return null;
  return {
    speedKt: speed,
    directionDeg: dir,
    directionText: directionCardinal16(dir),
    validTime: String(h.time[idx]),
    gridLat: Number(payload.latitude),
    gridLon: Number(payload.longitude),
  };
}

// 单请求失败重试（固定次数），仍失败抛最后一次错误
async function fetchWithRetry(url, timeoutMs, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fetchJsonWithTimeout(url, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * 拉取多个区域代表点的当前 10 米风。
 * @param {Array<{key:string, lat:number, lon:number}>} points
 * @returns {Promise<{ok:boolean, source:string, sourceLabel:string,
 *   perKey:Object, tried:string[], error:Error|null}>} ok=false 时 perKey 为空对象
 */
export async function fetchRegionWinds(points) {
  const tried = [];
  if (!points.length) {
    return { ok: false, source: '', sourceLabel: '', perKey: {}, tried, error: new Error('无有效区域代表点') };
  }
  const nowKey = currentUtcHourKey();
  let lastError = null;

  for (const tier of TIERS) {
    tried.push(tier.label);
    try {
      // 优先多坐标批量（1 次请求取全舰）
      const batch = await fetchWithRetry(buildUrl(tier, points), REQUEST_TIMEOUT_MS, WIND_REQUEST_RETRY);
      const responses = Array.isArray(batch) ? batch : [batch];
      const perKey = {};
      const missing = [];
      points.forEach((p, i) => {
        const slot = responses[i] ? extractCurrentSlot(responses[i], nowKey) : null;
        if (slot) perKey[p.key] = { ...slot, source: tier.id, sourceLabel: SOURCE_LABELS[tier.id] || tier.label, slotAgeHours: windSlotAgeHours(slot.validTime) };
        else missing.push(p);
      });
      // 批量部分缺失时退回逐舰单点补齐（当前 tier）
      if (missing.length && missing.length < points.length) {
        const singles = await Promise.all(missing.map(async (p) => {
          try {
            const single = await fetchWithRetry(buildUrl(tier, [p]), REQUEST_TIMEOUT_MS, WIND_REQUEST_RETRY);
            const slot = extractCurrentSlot(single, nowKey);
            return slot ? [p.key, { ...slot, source: tier.id, sourceLabel: SOURCE_LABELS[tier.id] || tier.label, slotAgeHours: windSlotAgeHours(slot.validTime) }] : null;
          } catch (err) {
            return null;
          }
        }));
        singles.forEach((pair) => { if (pair) perKey[pair[0]] = pair[1]; });
      }
      if (Object.keys(perKey).length > 0) {
        return { ok: true, source: tier.id, sourceLabel: SOURCE_LABELS[tier.id] || tier.label, perKey, tried, error: null };
      }
      lastError = new Error(`${tier.label} 未返回有效风场槽`);
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ok: false,
    source: '',
    sourceLabel: '',
    perKey: {},
    tried,
    error: new Error(`SOURCE_ALL_FAILED：已尝试 ${tried.join('、')}，最后错误：${lastError ? lastError.message : '未知'}`),
  };
}
