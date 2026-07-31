// 本体 AIS 拉取的窗口拆分与轨迹合并纯函数；独立成模块便于单测。
// 背景：本体接口单次查询匹配量超过 20w 行时会静默截断（其分页模式返回重复/错误页，不可用），
// 因此每个请求的 recordTotal 必须控制在 FETCH_LIMIT 以内，超限窗口递归细分。

// 安全阈值留 25% 余量：探测到实际拉取之间数据突增也不易越过 20w 硬上限。
export const SAFE_RECORD_THRESHOLD = 150_000;
export const FETCH_LIMIT = 200_000;
// 细分下限：窗口小于 1 小时仍超限则不再拆分，硬拉并标记截断。
export const MIN_WINDOW_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
// 跨度超过 45 天按自然月拆，超过 2 天按自然日拆，更小的窗口直接二分。
const MONTH_SPLIT_SPAN_MS = 45 * DAY_MS;
const DAY_SPLIT_SPAN_MS = 2 * DAY_MS;

function monthFloor(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function monthNext(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function dayFloor(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// 按日历边界（月/日）把 [startMs, endMs) 切成首尾对齐边界的连续子窗口。
function splitByCalendar(startMs, endMs, floorFn, nextFn) {
  const boundaries = [];
  let cursor = floorFn(startMs);
  if (cursor <= startMs) cursor = nextFn(cursor);
  while (cursor < endMs) {
    boundaries.push(cursor);
    cursor = nextFn(cursor);
  }
  const edges = [startMs, ...boundaries, endMs];
  return edges.slice(0, -1).map((edge, index) => [edge, edges[index + 1]]);
}

// 返回子窗口数组；窗口已触底（≤1 小时）无法再分时返回 null，由调用方决定硬拉。
export function splitWindow(startMs, endMs) {
  if (!(endMs > startMs) || endMs - startMs <= MIN_WINDOW_MS) return null;
  const span = endMs - startMs;
  if (span > MONTH_SPLIT_SPAN_MS) return splitByCalendar(startMs, endMs, monthFloor, monthNext);
  if (span > DAY_SPLIT_SPAN_MS) return splitByCalendar(startMs, endMs, dayFloor, (ms) => ms + DAY_MS);
  const mid = startMs + Math.floor(span / 2);
  return [[startMs, mid], [mid, endMs]];
}

// 业务字段组合键：本体同一报点会被重复 ingest（实测约 32 倍重复），按此键去重。
export function trackPointKey(point) {
  return [point.mmsi, point.time, point.lon, point.lat, point.speedKn, point.courseDeg, point.heading, point.navStatus].join("|");
}

// 合并已有轨迹与新报点：无效点（缺经纬度/时间不可解析）丢弃，按键去重后按时间升序。
export function mergeTrackPoints(existing, incoming) {
  const unique = new Map();
  for (const point of [...(existing || []), ...(incoming || [])]) {
    if (!point || point.lon === null || point.lat === null || !Number.isFinite(Date.parse(point.time))) continue;
    unique.set(trackPointKey(point), point);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
