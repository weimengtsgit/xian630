// 渲染层抽稀纯函数（无 React/JSX 依赖，前后端共享）：
// 仅影响 SVG 绘制路径，不改变关联计算、距离统计、命中结论或完整数据导出。

// 航迹渲染序列上限：兼顾细节与弹窗打开性能（服务端 render=1 接口与前端兜底共用）。
export const RENDER_POINT_LIMIT = 3000;

// 空窗判定阈值：相邻报点间隔超过该值视为数据空窗（距离曲线断线与航迹空窗虚线共用）。
export const GAP_BREAK_MS = 7 * 24 * 60 * 60 * 1000;

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// 合法经纬度过滤：有限数值、在经纬度范围内、排除 (0,0) 占位点。
export function isValidTrackCoord(point) {
  const lon = finiteNumber(point?.lon);
  const lat = finiteNumber(point?.lat);
  return lon !== null && lat !== null && lon !== 0 && lat !== 0 && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

// 航迹渲染抽稀：按序分桶，每桶保留经纬度极值点（最多 4 个），并始终保留首尾点。
// 输入必须已为合法经纬度（调用方先用 isValidTrackCoord 过滤）。
export function decimateTrackForRender(series, limit = RENDER_POINT_LIMIT) {
  if (series.length <= limit) return series;
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 4));
  const kept = new Set([0, series.length - 1]);
  const bucketSize = series.length / bucketCount;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.min(series.length, Math.max(start + 1, Math.floor((bucket + 1) * bucketSize)));
    let minLonIndex = start;
    let maxLonIndex = start;
    let minLatIndex = start;
    let maxLatIndex = start;
    for (let index = start; index < end; index += 1) {
      const point = series[index];
      if (point.lon < series[minLonIndex].lon) minLonIndex = index;
      if (point.lon > series[maxLonIndex].lon) maxLonIndex = index;
      if (point.lat < series[minLatIndex].lat) minLatIndex = index;
      if (point.lat > series[maxLatIndex].lat) maxLatIndex = index;
    }
    kept.add(minLonIndex);
    kept.add(maxLonIndex);
    kept.add(minLatIndex);
    kept.add(maxLatIndex);
  }
  return [...kept].sort((a, b) => a - b).map((index) => series[index]);
}

// 距离曲线渲染抽稀：entries 为 { index, distance }，分桶保留距离极值点与首尾。
export function decimateDistanceForRender(entries, limit = RENDER_POINT_LIMIT) {
  if (entries.length <= limit) return entries;
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
  const kept = new Set([0, entries.length - 1]);
  const bucketSize = entries.length / bucketCount;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.min(entries.length, Math.max(start + 1, Math.floor((bucket + 1) * bucketSize)));
    let minIndex = start;
    let maxIndex = start;
    for (let index = start; index < end; index += 1) {
      if (entries[index].distance < entries[minIndex].distance) minIndex = index;
      if (entries[index].distance > entries[maxIndex].distance) maxIndex = index;
    }
    kept.add(minIndex);
    kept.add(maxIndex);
  }
  return [...kept].sort((a, b) => a - b).map((index) => entries[index]);
}

// 在全量轨迹上检测时间空窗（相邻报点间隔 > GAP_BREAK_MS）。
// 必须在全量序列上检测：渲染抽稀序列的相邻点间隔是抽稀产物（平均数天），不能用来判定空窗。
// 返回空窗两端的真实报点（供前端画虚线跳变连接与标注）；gapCount 为总数，gaps 按间隔从大到小保留前 limit 条。
export function findTimeGaps(points, limit = 50) {
  const gaps = [];
  let gapCount = 0;
  for (let index = 1; index < points.length; index += 1) {
    const gapMs = Date.parse(points[index].time) - Date.parse(points[index - 1].time);
    if (!Number.isFinite(gapMs) || gapMs <= GAP_BREAK_MS) continue;
    gapCount += 1;
    gaps.push({
      fromTime: points[index - 1].time,
      toTime: points[index].time,
      gapMs,
      from: { lon: points[index - 1].lon, lat: points[index - 1].lat },
      to: { lon: points[index].lon, lat: points[index].lat },
    });
  }
  gaps.sort((a, b) => b.gapMs - a.gapMs);
  return { gapCount, gaps: gaps.slice(0, limit) };
}

// 服务端航迹渲染序列：合法经纬度过滤 + 分桶极值抽稀 + 保留首尾 + 全量空窗检测。
// 返回源点数与渲染点数，供接口如实标注 renderedFromFullTrack。
export function buildTrackRenderSeries(points, limit = RENDER_POINT_LIMIT) {
  const source = Array.isArray(points) ? points : [];
  const valid = [];
  for (const point of source) {
    if (isValidTrackCoord(point)) valid.push(point);
  }
  const { gapCount, gaps } = findTimeGaps(valid);
  return {
    sourcePointCount: source.length,
    points: decimateTrackForRender(valid, limit),
    gapCount,
    gaps,
  };
}
