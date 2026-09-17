// 时间与数值格式化：ISO8601 UTC 存储、本地时区展示。

const pad = (n) => String(n).padStart(2, '0');

export function toMs(iso) {
  return Date.parse(iso);
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClockSec(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDateTime(iso) {
  const d = new Date(Date.parse(iso));
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(iso) {
  const d = new Date(Date.parse(iso));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 倒计时秒数 → mm:ss
export function fmtCountdown(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// 相对现在多久之前（值守口径的简短中文）
export function fmtAgo(ms, nowMs) {
  const diffMin = Math.floor((nowMs - ms) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function fmtPct(v) {
  return `${Math.round(v * 100)}%`;
}
