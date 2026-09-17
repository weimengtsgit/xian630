// 时间解析、时效分级与展示格式化
// 时效口径（数据接入方案确认值）：
//   位置 dataUpdateTime ≤72h 正常；72h–7d 陈旧（结论仅供参考）；>7d 深度陈旧（醒目警示）
//   风场以当前 UTC 小时槽 validTime 为准，槽龄 >2h 标注陈旧
import { POSITION_FRESH_HOURS, POSITION_STALE_DAYS, WIND_SLOT_STALE_HOURS } from '../constants.js';

const pad2 = (n) => String(n).padStart(2, '0');

// 宽松解析本体/接口时间字段（兼容 "2026-06-14"、"2026-06-14 08:00:00"、ISO 带时区）。
// naiveAsUtc=true：无时区后缀的字符串按 UTC 解析——用于 Open-Meteo hourly.time
// （请求固定 timezone=UTC，字符串语义即 UTC，避免被宿主本地时区偏移）。
// 默认按本地解析（本体时间字段时区未声明，时效分级阈值粒度为小时级，可容忍偏差）。
export function parseTimeSafe(value, { naiveAsUtc = false } = {}) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  let d = new Date(hasZone || !naiveAsUtc ? normalized : `${normalized}Z`);
  if (Number.isNaN(d.getTime()) && !hasZone && !naiveAsUtc) d = new Date(`${normalized}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 位置时效分级
export function positionAgeInfo(observedAt, now = new Date()) {
  const t = parseTimeSafe(observedAt);
  if (!t) return { ageHours: null, ageLabel: '不可用', staleLevel: 'unavailable' };
  const ageHours = Math.max(0, (now.getTime() - t.getTime()) / 3600000);
  const staleDays = POSITION_STALE_DAYS;
  if (ageHours <= POSITION_FRESH_HOURS) {
    return { ageHours, ageLabel: formatAge(ageHours), staleLevel: 'normal' };
  }
  if (ageHours <= staleDays * 24) {
    return { ageHours, ageLabel: formatAge(ageHours), staleLevel: 'stale' };
  }
  return { ageHours, ageLabel: formatAge(ageHours), staleLevel: 'deep-stale' };
}

export function formatAge(ageHours) {
  if (!Number.isFinite(ageHours)) return '不可用';
  if (ageHours < 1) return `${Math.round(ageHours * 60)} 分钟前`;
  if (ageHours < 48) return `${ageHours.toFixed(1)} 小时前`;
  return `${(ageHours / 24).toFixed(1)} 天前`;
}

// 风场槽龄（相对当前 UTC 小时槽；validTime 为无时区后缀的 UTC 字符串）
export function windSlotAgeHours(validTime, now = new Date()) {
  const t = parseTimeSafe(validTime, { naiveAsUtc: true });
  if (!t) return null;
  return Math.max(0, (now.getTime() - t.getTime()) / 3600000);
}

export function isWindSlotStale(validTime, now = new Date()) {
  const h = windSlotAgeHours(validTime, now);
  return h != null && h > WIND_SLOT_STALE_HOURS;
}

// yyyy-MM-dd HH:mm（utc=true：无时区字符串按 UTC 解析并按 UTC 分量展示）
export function formatDateTime(value, { utc = false } = {}) {
  const t = parseTimeSafe(value, { naiveAsUtc: utc });
  if (!t) return '—';
  const y = utc ? t.getUTCFullYear() : t.getFullYear();
  const mo = utc ? t.getUTCMonth() : t.getMonth();
  const d = utc ? t.getUTCDate() : t.getDate();
  const h = utc ? t.getUTCHours() : t.getHours();
  const mi = utc ? t.getUTCMinutes() : t.getMinutes();
  return `${y}-${pad2(mo + 1)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}`;
}

// 当前 UTC 小时槽 key，形如 "2026-09-17T04:00"（与 Open-Meteo hourly.time 对齐）
export function currentUtcHourKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}:00`;
}

// 倒计时 mm:ss
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
