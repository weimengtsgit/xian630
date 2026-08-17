// 弹窗航迹对比图的渲染序列请求缓存（无 React 依赖，纯逻辑便于单测）：
// - 弹窗打开时通过服务端 track?render=1 接口拉取分桶抽稀的渲染序列（非全量点数组）；
// - 同一 MMSI 复用 in-flight Promise 或已完成结果，避免重复请求；
// - 弹窗关闭/切换关联对象时对未完成的请求发出 abort；已完成的结果保留缓存供下次秒开。
// 均失败/为空时 resolve 为 null，由调用方回退快照抽稀序列并如实标注状态。

const cache = new Map();

// 避免长期打开页面一直复用过时轨迹；关联快照刷新会通过 cacheKey 立即隔离，
// 没有快照时间时也最多复用五分钟。
export const TRACK_RENDER_CACHE_TTL_MS = 5 * 60 * 1000;

function buildRenderTrackUrl(mmsi) {
  return `/api/seasats/vessels/${encodeURIComponent(mmsi)}/track?render=1`;
}

function isReusable(entry, cacheKey, now = Date.now()) {
  return Boolean(entry)
    && entry.cacheKey === cacheKey
    && now - entry.createdAt < TRACK_RENDER_CACHE_TTL_MS;
}

export function requestTrackRender(mmsi, fetchImpl = globalThis.fetch, cacheKey = "") {
  let entry = cache.get(mmsi);
  if (!isReusable(entry, cacheKey)) {
    // 同一 MMSI 对应的新关联快照或过期缓存不能复用；若旧请求还在飞行，先取消它。
    if (entry && !entry.settled) entry.controller.abort();
    const controller = new AbortController();
    entry = { controller, settled: false, points: null, promise: null, cacheKey, createdAt: Date.now() };
    entry.promise = fetchImpl(buildRenderTrackUrl(mmsi), { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      // 空轨迹/异常载荷视为拉取失败（null），调用方回退快照序列。
      .then((data) => (Array.isArray(data?.trackPoints) && data.trackPoints.length ? data.trackPoints : null))
      .catch(() => null)
      .then((points) => {
        entry.settled = true;
        entry.points = points;
        return points;
      });
    cache.set(mmsi, entry);
  }
  return entry;
}

// 弹窗关闭/切换时取消未完成请求并移除其缓存条目（下次打开重新拉取）；
// 已完成的请求保留在缓存中复用，不重复请求。
export function cancelTrackRender(mmsi, cacheKey = "") {
  const entry = cache.get(mmsi);
  // 旧弹窗卸载时不得取消已由新快照发起的同 MMSI 请求。
  if (entry && entry.cacheKey === cacheKey && !entry.settled) {
    entry.controller.abort();
    cache.delete(mmsi);
  }
}

// 双侧渲染序列都已就绪（含失败 settle 为 null）时返回结果，否则 null（继续 loading）。
export function readSettledTrackRender(referenceMmsi, carrierMmsi, cacheKey = "") {
  const reference = cache.get(referenceMmsi);
  const carrier = cache.get(carrierMmsi);
  if (reference?.settled && carrier?.settled && isReusable(reference, cacheKey) && isReusable(carrier, cacheKey)) {
    return { reference: reference.points, carrier: carrier.points };
  }
  return null;
}

// 仅供测试重置模块级缓存。
export function resetTrackRenderCacheForTests() {
  cache.clear();
}
