// 时间工具：时区墙钟 ↔ UTC 转换、各时区格式化、倒计时格式化。
// 纯时间运算，不涉及取数；覆盖 NOAA lst_ldt（当地标准/夏令时）与 JCG 日本时间的解析。

const dtfCache = new Map();

function zoneFormatter(timeZone) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

function zonedParts(ms, timeZone) {
  const parts = {};
  for (const p of zoneFormatter(timeZone).formatToParts(new Date(ms))) {
    parts[p.type] = p.value;
  }
  return parts;
}

function partsAsUtcMs(p) {
  const hour = String(Number(p.hour) % 24).padStart(2, '0'); // en-US hour12:false 午夜会给出 24
  return Date.parse(`${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}Z`);
}

function displayHour(p) {
  return p.hour === '24' ? '00' : p.hour;
}

// 把「时区墙钟时间」（如 NOAA 的 "YYYY-MM-DD HH:mm"）转换为 UTC 毫秒。
// 两轮偏移修正，DST 边界不可唯一收敛时保留第一轮标准解。
export function zonedWallToUtc(wall, timeZone) {
  const iso = String(wall).trim().replace(' ', 'T');
  const padded = iso.length === 16 ? `${iso}:00` : iso;
  const naive = Date.parse(`${padded}Z`);
  if (Number.isNaN(naive)) return NaN;
  const firstOffset = partsAsUtcMs(zonedParts(naive, timeZone)) - naive;
  let utc = naive - firstOffset;
  const secondOffset = partsAsUtcMs(zonedParts(utc, timeZone)) - utc;
  if (secondOffset !== firstOffset) {
    const candidate = naive - secondOffset;
    if (partsAsUtcMs(zonedParts(candidate, timeZone)) - candidate === secondOffset) {
      utc = candidate;
    }
  }
  return utc;
}

export function ymdInZone(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}${p.month}${p.day}`;
}

export function datePartsInZone(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

// 港口当地时间："MM-dd HH:mm"
export function fmtLocalShort(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.month}-${p.day} ${displayHour(p)}:${p.minute}`;
}

// 北京时间："MM-dd HH:mm:ss"
export function fmtBeijingShort(ms) {
  const p = zonedParts(ms, 'Asia/Shanghai');
  return `${p.month}-${p.day} ${displayHour(p)}:${p.minute}:${p.second}`;
}

// 倒计时（绝对时长，时区无关）：≥1 天用 "N天 HH:mm:ss"，否则 "HH:mm:ss"
export function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return d > 0 ? `${d}天 ${hms}` : hms;
}

// 窗口时长："N小时M分" / "N分钟"
export function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
  return `${m}分钟`;
}
