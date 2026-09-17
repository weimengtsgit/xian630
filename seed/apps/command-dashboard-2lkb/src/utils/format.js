// 展示格式化工具（时间/数字/时长，中文界面文案）

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtTimeShort(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtTime(ms)}`;
}

export function fmtMonthDay(ms) {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 倒计时/滞后时长：mm:ss（超过 1 小时显示 h:mm:ss）
export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

// 商船数（整数，等宽渲染由 CSS tabular-nums 保证）
export function fmtCount(v) {
  return Number.isFinite(v) ? String(v) : '—';
}

// 基线值（1 位小数）
export function fmtBaseline(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}

// 比率百分比（整数）
export function fmtPct(pct) {
  return Number.isFinite(pct) ? `${pct}%` : '—';
}
