// 潮汐数据层：真实公开数据源运行时取数（浏览器发起、经 nginx 同源代理）。
// 诺福克/圣迭戈/布雷默顿 → NOAA CO-OPS 官方预测 API（免鉴权，MLLW 基准逐时预测）。
// 横须贺 → JCG 日本海上保安厅潮汐推算页面（免鉴权，毎時潮高 cm → m，平均海面基准）。
// 本文件只做取数与归一化；窗口判定等运算在 src/utils/windowCalc.js（诚实数据审计要求）。

import { PORT_BY_KEY, FETCH_TIMEOUT_MS, FORECAST_HOURS } from '../config/ports.js';
import { zonedWallToUtc, ymdInZone, datePartsInZone } from '../utils/time.js';
import { jcgDaySeries } from './jcgParser.js';

const NOAA_PROXY_BASE = '/api/noaa/'; // nginx → https://api.tidesandcurrents.noaa.gov
const JCG_PROXY_BASE = '/api/jcg/';   // nginx → https://www1.kaiho.mlit.go.jp/TIDE/pred2

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const pad2 = (n) => String(n).padStart(2, '0');

function codedError(code, detail) {
  const err = new Error(`${code}：${detail}`);
  err.code = code;
  return err;
}

async function fetchText(path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: controller.signal });
    if (!res.ok) throw codedError(`HTTP_${res.status}`, `数据源返回 HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err && err.code) throw err;
    if (err && err.name === 'AbortError') {
      throw codedError('SOURCE_TIMEOUT', `取数超时（${timeoutMs}ms 内无响应）`);
    }
    throw codedError('SOURCE_UNREACHABLE', (err && err.message) || '网络错误（源不可达或代理不可用）');
  } finally {
    clearTimeout(timer);
  }
}

function dedupeSort(series) {
  const map = new Map();
  for (const p of series) map.set(p.t, p.heightM);
  return [...map.entries()]
    .map(([t, heightM]) => ({ t, heightM }))
    .sort((a, b) => a.t - b.t);
}

function validateCoverage(series, now) {
  if (series.length < 24) {
    throw codedError('SOURCE_RESPONSE_INVALID', `有效潮汐点不足（${series.length} < 24）`);
  }
  if (series[0].t > now) {
    throw codedError('INSUFFICIENT_COVERAGE', '序列起点晚于当前时刻，无法插值当前潮高');
  }
  const need = now + FORECAST_HOURS * HOUR_MS - HOUR_MS; // 允许末端 1 小时缺口
  if (series[series.length - 1].t < need) {
    throw codedError('INSUFFICIENT_COVERAGE', `序列仅覆盖至 ${new Date(series[series.length - 1].t).toISOString()}，不足 72 小时`);
  }
}

// NOAA CO-OPS DataGetter：MLLW 基准逐时预测，时间戳为站点当地时（lst_ldt）。
async function fetchNoaaSeries(port, now) {
  const begin = ymdInZone(now - DAY_MS, port.timezone); // 多取一天，保证当前时刻有插值支点
  const end = ymdInZone(now + 4 * DAY_MS, port.timezone);
  const query = [
    `station=${port.portId}`,
    'product=predictions',
    'datum=MLLW',
    'units=metric',
    'format=json',
    'interval=h',
    `begin_date=${begin}`,
    `end_date=${end}`,
    'time_zone=lst_ldt',
  ].join('&');
  const text = await fetchText(`${NOAA_PROXY_BASE}api/prod/datagetter?${query}`, FETCH_TIMEOUT_MS);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw codedError('SOURCE_RESPONSE_INVALID', 'NOAA 返回非 JSON 内容');
  }
  if (json.error) {
    throw codedError('SOURCE_RESPONSE_INVALID', `NOAA 错误：${json.error.message || JSON.stringify(json.error).slice(0, 160)}`);
  }
  if (!Array.isArray(json.predictions) || !json.predictions.length) {
    throw codedError('SOURCE_RESPONSE_INVALID', 'NOAA 返回缺少 predictions 数组');
  }
  const series = json.predictions
    .map((p) => ({ t: zonedWallToUtc(p.t, port.timezone), heightM: Number(p.v) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.heightM));
  const sorted = dedupeSort(series);
  validateCoverage(sorted, now);
  return sorted;
}

// JCG 潮汐推算：当日起 4 个日页保证 ≥72h 覆盖；昨日页尽力而为（当日 0 点必在序列内）。
async function fetchJcgSeries(port, now) {
  const days = [{ optional: true, ...datePartsInZone(now - DAY_MS, 'Asia/Tokyo') }];
  for (let i = 0; i < 4; i += 1) {
    days.push({ optional: false, ...datePartsInZone(now + i * DAY_MS, 'Asia/Tokyo') });
  }
  const results = await Promise.allSettled(days.map((d) =>
    fetchText(
      `${JCG_PROXY_BASE}cgi-bin/TidePredCgi.cgi?area=${port.portId}&year=${d.year}&month=${d.month}&day=${d.day}`,
      FETCH_TIMEOUT_MS,
    ).then((html) => {
      if (/input error/i.test(html.slice(0, 400))) {
        throw codedError('JCG_CGI_INPUT_ERROR', 'JCG CGI 返回 input error（参数或入口可能已变化）');
      }
      return jcgDaySeries(html, d.year, d.month, d.day);
    })));
  const series = [];
  const failedDays = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      series.push(...r.value);
    } else if (!days[i].optional) {
      const d = days[i];
      failedDays.push(`${d.year}-${pad2(d.month)}-${pad2(d.day)}：${(r.reason && r.reason.message) || String(r.reason)}`);
    }
  });
  if (failedDays.length) {
    throw codedError('JCG_FETCH_PARTIAL', `JCG 推算页取数失败 — ${failedDays.join('；').slice(0, 300)}`);
  }
  const sorted = dedupeSort(series);
  validateCoverage(sorted, now);
  return sorted;
}

// 取一个港口的 72 小时真实潮汐序列（失败抛错，由调用方按港口独立降级）。
export async function fetchTideSeries(portKey, now = Date.now()) {
  const port = PORT_BY_KEY[portKey];
  if (!port) throw codedError('INVALID_INPUT', `未知港口：${portKey}`);
  const series = port.sourceKind === 'jcg'
    ? await fetchJcgSeries(port, now)
    : await fetchNoaaSeries(port, now);
  return { key: portKey, series, dataSourceName: port.dataSourceName, fetchedAt: now };
}

// 并发取四港；单港失败不拖垮其他港（Promise.allSettled）。
export async function fetchAllPorts(portKeys, now = Date.now()) {
  const results = await Promise.allSettled(portKeys.map((k) => fetchTideSeries(k, now)));
  return results.map((r, i) => ({
    key: portKeys[i],
    ok: r.status === 'fulfilled',
    data: r.status === 'fulfilled' ? r.value : null,
    error: r.status === 'fulfilled' ? null : (r.reason instanceof Error ? r.reason : new Error(String(r.reason))),
  }));
}
