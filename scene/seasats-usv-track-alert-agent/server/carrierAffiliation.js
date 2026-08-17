// 关联分析基线：使用方提供的 select0721.py（2026-07-21 给定）。
// 客户确认的覆盖：
//  - lagDistThreshNm = 500 海里（2026-08-03 客户新需求，覆盖 0721 默认的 100）；
//  - 2026-08-15 客户确认的数据规则：UTC 秒级截断、同秒保留第一条、航向缺失(511/null/空/非数值)点保留参与
//    距离匹配但不算航向、缺失恢复后继续参与 45° 筛选、整轨无有效航向不分析。
// 航向字段来源沿用修改前（v10 之前）生产版本的字段优先级（heading → courseDeg 兜底），
// 不做"只读客户 CSV 的 orientation 列"的强行映射——客户字段名与本体 AIS 字段不完全一致。
export const CARRIER_AFFILIATION_RULES = Object.freeze({
  syncDistThreshNm: 20,
  syncCourseThreshDeg: 30,
  lagMaxMinutes: 30 * 24 * 60,
  lagStepMinutes: 24 * 60,
  fineRangeMinutes: 24 * 60,
  fineStepMinutes: 60,
  lagDistThreshNm: 500,
  localRatioThresh: 0.70,
  lagCourseThreshDeg: 45,
  minMatchedPoints: 8,
  timeMatchWindowSyncSec: 30 * 60,
});

// 数据规则随快照持久化，便于审计当前结果是按哪套口径算出的。
// headingSource 为事实性描述：修改前生产版本的字段优先级，不是 orientation-only。
export const CARRIER_AFFILIATION_DATA_RULES = Object.freeze({
  version: "v12-20260815",
  timePrecision: "utc-second-truncate",
  sameSecondRule: "keep-first-by-current-store-order",
  headingSource: "legacy-pre-v11-field-precedence",
  headingFieldPrecedence: ["heading", "courseDeg"],
  invalidHeading: "null-empty-nonfinite-or-511",
  headingRecovery: "unwrap-skips-missing-and-resumes",
  unwrapBoundary: "correct-only-when-abs-delta-gt-180",
  lagDistThreshNm: 500,
});

const RULES = CARRIER_AFFILIATION_RULES;

const EARTH_RADIUS_NM = 3440.065;

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// 航向解析：逐字沿用修改前（v10 之前）生产版本的字段优先级——heading（本体 trueHeading）优先，
// heading 为 null/undefined 时才兜底 courseDeg（本体 courseOverGround）；
// 客户 2026-08-15 确认的缺失规则作用于该解析结果：511/null/空串/非数值 → 该点航向缺失。
export function resolveAnalysisHeading(point) {
  const raw = point?.heading ?? point?.courseDeg;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric === 511) return null;
  return numeric;
}

function mod360(value) {
  return ((value % 360) + 360) % 360;
}

// 供测试直接验证清洗与 unwrap 口径（同秒首条、秒级截断、旧版航向字段优先级、unwrap 边界）。
export function cleanTrack(points = []) {
  const validPoints = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const timeMs = Date.parse(point.time);
    const lon = finite(point.lon);
    const lat = finite(point.lat);
    if (!Number.isFinite(timeMs) || lon === null || lat === null || lon === 0 || lat === 0 || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    // 客户确认：原始毫秒时间截断到秒（不四舍五入）；sourceIndex 记录输入位置，供排序/去重保持确定性。
    // 注意：本体 AIS 无稳定原始记录序字段，sourceIndex 是当前轨迹存储顺序的位置，
    // 同秒"第一条"按当前存储顺序确定，不是源数据严格意义的第一条（数据源限制，见修改记录）。
    validPoints.push({
      ...point,
      timeMs: Math.floor(timeMs / 1000) * 1000,
      sourceIndex: index,
      lon,
      lat,
      speedKn: finite(point.speedKn),
      heading: resolveAnalysisHeading(point),
    });
  }
  // 客户确认：同一秒内多条记录保留第一条；按 (秒, 输入位置) 排序，保证对同一输入数组结果可重复。
  validPoints.sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex);
  const byTime = new Map();
  for (const point of validPoints) if (!byTime.has(point.timeMs)) byTime.set(point.timeMs, point);
  const cleaned = [...byTime.values()];
  // 与 np.unwrap(period=360) 对齐：%360 归一后按时间展开；仅当相邻有效值差严格大于 180°（或小于 -180°）
  // 才跨界修正，±180° 不反向翻转。缺失点跳过，后续有效值与前一个有效值衔接恢复（不让一个缺失使后续全部失效）。
  let lastUnwrapped = null;
  for (const point of cleaned) {
    if (point.heading === null) continue;
    const normalized = mod360(point.heading);
    let unwrapped = normalized;
    if (lastUnwrapped !== null) {
      const delta = normalized - mod360(lastUnwrapped);
      unwrapped = lastUnwrapped + (delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta);
    }
    point.heading = unwrapped;
    lastUnwrapped = unwrapped;
  }
  return cleaned;
}

// 任一参与关联的整条轨迹经旧版字段优先级解析后没有任何有效航向时，
// 该配对不进行关联分析（客户 2026-08-15 确认；判定基于解析结果，不基于字面字段存在性）。
function hasUsableHeading(track) {
  for (const point of track) if (point.heading !== null) return true;
  return false;
}

function distanceNm(a, b) {
  const lat1 = a.lat * Math.PI / 180;
  const lon1 = a.lon * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const lon2 = b.lon * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function lowerBound(points, timeMs) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (points[middle].timeMs < timeMs) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

function nearestWithin(points, targetMs, windowMs) {
  const right = lowerBound(points, targetMs);
  const options = [right - 1, right].filter((index) => index >= 0 && index < points.length);
  let best = null;
  for (const index of options) {
    const point = points[index];
    const deltaMs = Math.abs(point.timeMs - targetMs);
    // 同等时间差时取更早点，等价 MATLAB min 返回第一个匹配索引的行为。
    if (deltaMs <= windowMs && (!best || deltaMs < best.deltaMs || (deltaMs === best.deltaMs && index < best.index))) best = { point, index, deltaMs };
  }
  return best;
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function minimum(values) {
  // 循环取最小值：禁止 Math.min(...values)，十万级数组展开会触发 V8 参数上限 RangeError。
  if (!values.length) return null;
  let result = values[0];
  for (const value of values) if (value < result) result = value;
  return result;
}

function median(values) {
  // 与 select0721.py 的 median_dist 一致：对判定采用的匹配距离取中位数，仅作展示，不影响命中。
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function range(times) {
  if (!times.length) return { startTime: null, endTime: null };
  let minTime = times[0];
  let maxTime = times[0];
  for (const time of times) {
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
  }
  return { startTime: new Date(minTime).toISOString(), endTime: new Date(maxTime).toISOString() };
}

function courseDifference(a, b) {
  let difference = Math.abs(a - b);
  if (difference > 180) difference = 360 - difference;
  return difference;
}

function interpolateFollowerAt(follower, targetTimeMs, cursor) {
  // 轨迹已按时间升序。游标避免在百万级 AIS 中对每一个点重复二分查找。
  // cursor 只允许在单次、时间单调的遍历中复用；每个 lag 候选/每次完整评估必须新建游标。
  while (cursor.index < follower.length && follower[cursor.index].timeMs < targetTimeMs) cursor.index += 1;
  if (cursor.index < follower.length && follower[cursor.index].timeMs === targetTimeMs) {
    const exact = follower[cursor.index];
    return { lon: exact.lon, lat: exact.lat, heading: exact.heading };
  }
  if (cursor.index === 0 || cursor.index >= follower.length) return null;
  const before = follower[cursor.index - 1];
  const after = follower[cursor.index];
  const span = after.timeMs - before.timeMs;
  if (span <= 0) return null;
  const ratio = (targetTimeMs - before.timeMs) / span;
  const interpolate = (key) => {
    if (before[key] === null || after[key] === null) return null;
    return before[key] + (after[key] - before[key]) * ratio;
  };
  return { lon: interpolate("lon"), lat: interpolate("lat"), heading: interpolate("heading") };
}

function downsampleSeries(series, limit = 160) {
  if (series.length <= limit) return series;
  const sampled = [];
  for (let index = 0; index < limit; index += 1) {
    sampled.push(series[Math.round(index * (series.length - 1) / (limit - 1))]);
  }
  return sampled;
}

function downsampleTrack(points, limit = 60) {
  // 详情弹窗航迹对比图的快照回退序列：对全量 AIS 抽稀并只保留时间/经纬度，控制快照体积。
  // 弹窗打开后前端会按需拉取全量轨迹覆盖绘制，抽稀序列仅为首帧/失败回退。
  if (!points.length) return [];
  const sampled = points.length <= limit ? points : downsampleSeries(points, limit);
  return sampled.map((point) => ({
    time: new Date(point.timeMs).toISOString(),
    lon: Math.round(point.lon * 1e4) / 1e4,
    lat: Math.round(point.lat * 1e4) / 1e4,
  }));
}

function analyzeSync(leader, follower) {
  const distances = [];
  const courseCosines = [];
  const times = [];
  for (const point of leader) {
    const matched = nearestWithin(follower, point.timeMs, RULES.timeMatchWindowSyncSec * 1000);
    if (!matched) continue;
    distances.push(distanceNm(point, matched.point));
    times.push(point.timeMs);
    // 与 select0721.py 的 merge_asof 口径一致：空间已匹配但航向不可判定/速度不满足的点，
    // 航向相似度按 1 参与平均（cos_sim 初始化为全 1），而不是忽略后再平均。
    if (point.speedKn > 1 && matched.point.speedKn > 1 && point.heading !== null && matched.point.heading !== null) {
      courseCosines.push(Math.cos((point.heading - matched.point.heading) * Math.PI / 180));
    } else {
      courseCosines.push(1);
    }
  }
  const averageDistanceNm = avg(distances);
  const minimumDistanceNm = minimum(distances);
  const averageCourseCosine = courseCosines.length ? avg(courseCosines) : 1;
  return { matchedPoints: distances.length, averageDistanceNm, minimumDistanceNm, averageCourseCosine, ...range(times), matched: distances.length >= RULES.minMatchedPoints && averageDistanceNm < RULES.syncDistThreshNm && averageCourseCosine > Math.cos(RULES.syncCourseThreshDeg * Math.PI / 180) };
}

// 单次 lag 评估的插值遍历抽公共：visit(distance, point, interpolated) 按 leader 时间单调推进。
// 返回有效插值点数；cursor 不跨调用复用。
function forEachInterpolatedMatch(leader, follower, lagMinutes, visit) {
  const lagMs = lagMinutes * 60_000;
  // 没有时间交集时直接跳过，等价 Python 对平移后轨迹的快速判断。
  if (!leader.length || !follower.length || follower[0].timeMs + lagMs > leader.at(-1).timeMs || follower.at(-1).timeMs + lagMs < leader[0].timeMs) return 0;
  const cursor = { index: 0 };
  let validCount = 0;
  for (const point of leader) {
    // Python 版将候选航母时间向 lag 方向平移；换算到原始时间即为 leader - lag。
    const interpolated = interpolateFollowerAt(follower, point.timeMs - lagMs, cursor);
    if (!interpolated || interpolated.lon === null || interpolated.lat === null) continue;
    validCount += 1;
    visit(point, interpolated, distanceNm(point, interpolated));
  }
  return validCount;
}

// 流式统计：扫描阶段（粗扫 61 个 + 细扫 49 个候选）不为每个 lag 创建全量匹配/距离数组，
// 只维护判定所需的计数与分组累计量；结果与 buildLagResult 的全量重建口径严格一致
//（相同的迭代顺序与相同的分组求和顺序，浮点结果逐位相同）。
function evaluateLagOffsetStats(leader, follower, lagMinutes) {
  let validCount = 0;
  let belowThresholdCount = 0;
  let eligibleCount = 0;
  let eligibleDistanceSum = 0;
  let eligibleMinDistance = Infinity;
  let passCount = 0;
  let passDistanceSum = 0;
  let passMinDistance = Infinity;
  let missingCount = 0;
  let missingDistanceSum = 0;
  let missingMinDistance = Infinity;
  const valid = forEachInterpolatedMatch(leader, follower, lagMinutes, (point, interpolated, distance) => {
    validCount += 1;
    if (distance < RULES.lagDistThreshNm) belowThresholdCount += 1;
    if (point.heading === null || interpolated.heading === null) {
      missingCount += 1;
      missingDistanceSum += distance;
      if (distance < missingMinDistance) missingMinDistance = distance;
      return;
    }
    eligibleCount += 1;
    eligibleDistanceSum += distance;
    if (distance < eligibleMinDistance) eligibleMinDistance = distance;
    if (courseDifference(point.heading, interpolated.heading) <= RULES.lagCourseThreshDeg) {
      passCount += 1;
      passDistanceSum += distance;
      if (distance < passMinDistance) passMinDistance = distance;
    }
  });
  // 有效插值点不足 minMatchedPoints，该时延直接弃用（对应 evaluate_lag 的 n_valid 检查）。
  if (validCount < RULES.minMatchedPoints) return null;
  // 航向筛选与 0721 一致：可判定航向的匹配点 ≥3 即执行 45° 筛选；航向缺失的点保留在结果中、
  // 不参与筛选（0721 的 valid_combined 只剔除“有航向但超差”的点）；筛选后不足 minMatchedPoints 点，
  // 该时延直接作废——0721 没有“航向不足回退到全部点”的逻辑。
  const courseFilterApplied = eligibleCount >= 3;
  const keptCount = courseFilterApplied ? missingCount + passCount : validCount;
  if (keptCount < RULES.minMatchedPoints) return null;
  const keptDistanceSum = courseFilterApplied ? missingDistanceSum + passDistanceSum : missingDistanceSum + eligibleDistanceSum;
  const keptMinDistance = courseFilterApplied
    ? Math.min(missingMinDistance, passMinDistance)
    : Math.min(missingMinDistance, eligibleMinDistance);
  return {
    lagMinutes,
    averageDistanceNm: keptDistanceSum / keptCount,
    minimumDistanceNm: keptMinDistance,
    // ratio 与 0721 一致：全部有效插值点（未筛选）中距离 < 阈值的比例。
    withinThresholdRatio: belowThresholdCount / validCount,
    matchedPoints: keptCount,
    courseFilterApplied,
  };
}

// 完整评估：仅在最终最佳 lag 确定后执行一次，产出 distanceSeries、median、匹配区间等展示字段。
// 统计口径与 evaluateLagOffsetStats 的分组求和完全一致（缺失组/通过组分别累计再合并）。
function buildLagResult(leader, follower, lagMinutes) {
  const matches = [];
  let validCount = 0;
  let belowThresholdCount = 0;
  let eligibleCount = 0;
  let eligibleDistanceSum = 0;
  let eligibleMinDistance = Infinity;
  let passCount = 0;
  let passDistanceSum = 0;
  let passMinDistance = Infinity;
  let missingCount = 0;
  let missingDistanceSum = 0;
  let missingMinDistance = Infinity;
  forEachInterpolatedMatch(leader, follower, lagMinutes, (point, interpolated, distance) => {
    validCount += 1;
    if (distance < RULES.lagDistThreshNm) belowThresholdCount += 1;
    if (point.heading === null || interpolated.heading === null) {
      missingCount += 1;
      missingDistanceSum += distance;
      if (distance < missingMinDistance) missingMinDistance = distance;
      matches.push({ point, interpolated, distanceNm: distance, courseMissing: true });
      return;
    }
    eligibleCount += 1;
    eligibleDistanceSum += distance;
    if (distance < eligibleMinDistance) eligibleMinDistance = distance;
    const difference = courseDifference(point.heading, interpolated.heading);
    const passed = difference <= RULES.lagCourseThreshDeg;
    if (passed) {
      passCount += 1;
      passDistanceSum += distance;
      if (distance < passMinDistance) passMinDistance = distance;
    }
    matches.push({ point, interpolated, distanceNm: distance, courseMissing: false, coursePassed: passed, courseDifferenceDeg: difference });
  });
  if (validCount < RULES.minMatchedPoints) return null;
  const courseFilterApplied = eligibleCount >= 3;
  // 0721 valid_combined 语义：筛选只剔除“有航向但超差”的点，航向缺失点保留。
  const kept = courseFilterApplied
    ? matches.filter((match) => match.courseMissing || match.coursePassed)
    : matches;
  if (kept.length < RULES.minMatchedPoints) return null;
  const keptDistanceSum = courseFilterApplied ? missingDistanceSum + passDistanceSum : missingDistanceSum + eligibleDistanceSum;
  const keptMinDistance = courseFilterApplied
    ? Math.min(missingMinDistance, passMinDistance)
    : Math.min(missingMinDistance, eligibleMinDistance);
  const distances = kept.map((match) => match.distanceNm);
  // 最大航向差只在航向齐全的匹配点上统计（航向缺失点保留在匹配中但不参与航向度量）；循环取最大值，禁止展开传参。
  let maxCourseDifferenceDeg = null;
  if (courseFilterApplied) {
    let maxDifference = -Infinity;
    for (const match of kept) {
      if (match.courseMissing) continue;
      if (match.courseDifferenceDeg > maxDifference) maxDifference = match.courseDifferenceDeg;
    }
    maxCourseDifferenceDeg = maxDifference === -Infinity ? null : maxDifference;
  }
  return {
    lagMinutes,
    averageDistanceNm: keptDistanceSum / kept.length,
    minimumDistanceNm: keptMinDistance,
    // median 与 select0721.py 的 median_dist 一致：取筛选后采用点距离的中位数，仅展示，不影响命中。
    medianDistanceNm: median(distances),
    withinThresholdRatio: belowThresholdCount / validCount,
    matchedPoints: kept.length,
    courseFilterApplied,
    maxCourseDifferenceDeg,
    ...range(kept.map((match) => match.point.timeMs)),
    matches: kept,
  };
}

// 与 select0721.py 的 search_best_lag 一致：粗扫（±30 天、24 小时步长、含两端）
// + 细扫（粗扫最佳 ±24 小时、1 小时步长、含两端，允许略超 ±30 天边界）。
function analyzeLag(leader, follower) {
  // 候选门槛与 0721 扫描内过滤一致：阈值内占比 >= localRatioThresh（严格边界：等于 0.70 通过）
  // 且平均距离 < lagDistThreshNm（严格小于：等于 500 弃用）。
  const acceptable = (stats) => stats !== null
    && stats.withinThresholdRatio >= RULES.localRatioThresh
    && stats.averageDistanceNm < RULES.lagDistThreshNm;
  let best = null;
  for (let lagMinutes = -RULES.lagMaxMinutes; lagMinutes <= RULES.lagMaxMinutes; lagMinutes += RULES.lagStepMinutes) {
    const stats = evaluateLagOffsetStats(leader, follower, lagMinutes);
    if (acceptable(stats) && (!best || stats.averageDistanceNm < best.averageDistanceNm)) best = stats;
  }
  if (!best) {
    return { lagMinutes: null, averageDistanceNm: null, minimumDistanceNm: null, medianDistanceNm: null, withinThresholdRatio: null, matchedPoints: 0, courseFilterApplied: false, maxCourseDifferenceDeg: null, startTime: null, endTime: null, distanceSeries: [], distanceSeriesSource: null, matched: false };
  }
  let bestLagMinutes = best.lagMinutes;
  let bestAverage = best.averageDistanceNm;
  for (let lagMinutes = bestLagMinutes - RULES.fineRangeMinutes; lagMinutes <= bestLagMinutes + RULES.fineRangeMinutes; lagMinutes += RULES.fineStepMinutes) {
    const stats = evaluateLagOffsetStats(leader, follower, lagMinutes);
    if (acceptable(stats) && stats.averageDistanceNm < bestAverage) {
      bestLagMinutes = stats.lagMinutes;
      bestAverage = stats.averageDistanceNm;
    }
  }
  // 最终 best 确定后单独做一次完整评估，distanceSeries/median/匹配区间均来自最终 best 而非粗扫 best。
  const result = buildLagResult(leader, follower, bestLagMinutes);
  if (!result) {
    // 完整评估与流式统计口径一致，理论上不会走到；防御性返回未命中，绝不展示口径不明的结果。
    return { lagMinutes: null, averageDistanceNm: null, minimumDistanceNm: null, medianDistanceNm: null, withinThresholdRatio: null, matchedPoints: 0, courseFilterApplied: false, maxCourseDifferenceDeg: null, startTime: null, endTime: null, distanceSeries: [], distanceSeriesSource: null, matched: false };
  }
  const { matches, ...lagResult } = result;
  return {
    ...lagResult,
    // 距离曲线与 0721 一致：展示最终获选时延、最终筛选后的完整插值对齐序列（不抽稀、不做实测点优先），
    // 横轴为参考艇实际报点时间。
    distanceSeries: matches.map(({ point, distanceNm: matchedDistanceNm }) => ({ time: new Date(point.timeMs).toISOString(), distanceNm: matchedDistanceNm })),
    distanceSeriesSource: "interpolated",
    matched: true,
  };
}

// 逐 MMSI 缓存清洗结果：同一航母对多艘无人艇重复关联时，不重复 cleanTrack。
function createTrackCleaner(tracksByMmsi) {
  const cache = new Map();
  return (mmsi) => {
    if (!cache.has(mmsi)) cache.set(mmsi, cleanTrack(tracksByMmsi[mmsi] || []));
    return cache.get(mmsi);
  };
}

export function analyzeCarrierAffiliations({ reference, candidates, tracksByMmsi }) {
  const cleanedTrackFor = createTrackCleaner(tracksByMmsi);
  const referenceTrack = cleanedTrackFor(reference.mmsi);
  const relations = candidates.map((candidate) => {
    const candidateTrack = cleanedTrackFor(candidate.mmsi);
    // 客户 2026-08-15 确认：任一侧整条轨迹无有效航向（旧版字段优先级解析后）时，该配对不进行关联分析。
    if (referenceTrack.length && candidateTrack.length && (!hasUsableHeading(referenceTrack) || !hasUsableHeading(candidateTrack))) {
      return { candidate, leaderMmsi: reference.mmsi, followerMmsi: candidate.mmsi, referenceMmsi: reference.mmsi, candidatePointCount: candidateTrack.length, referencePointCount: referenceTrack.length, relationType: "未分析", reason: "insufficient_heading_data", sync: null, lag: null };
    }
    // 与 Python 程序一致：用户选择的无人艇为参考轨迹，逐一对比候选航母。
    const sync = analyzeSync(referenceTrack, candidateTrack);
    const lag = analyzeLag(referenceTrack, candidateTrack);
    const relationType = sync.matched ? "同步伴随" : lag.matched ? "时延跟随" : "未发现满足阈值的关联";
    return { candidate, leaderMmsi: reference.mmsi, followerMmsi: candidate.mmsi, referenceMmsi: reference.mmsi, candidatePointCount: candidateTrack.length, referencePointCount: referenceTrack.length, relationType, sync, lag };
  });
  return { reference, rules: RULES, dataRules: CARRIER_AFFILIATION_DATA_RULES, generatedAt: new Date().toISOString(), relations };
}

export function analyzeVesselCarrierRelations({ vessels, carriers, tracksByMmsi }) {
  const cleanedTrackFor = createTrackCleaner(tracksByMmsi);
  const associationsByMmsi = {};
  for (const vessel of vessels) {
    if (carriers.some((carrier) => carrier.mmsi === vessel.mmsi)) {
      associationsByMmsi[vessel.mmsi] = { status: "carrier", reference: vessel, carriers: [] };
      continue;
    }
    const vesselTrack = cleanedTrackFor(vessel.mmsi);
    const carriersResult = carriers.map((carrier) => {
      const carrierTrack = cleanedTrackFor(carrier.mmsi);
      // 客户 2026-08-15 确认：任一侧整条轨迹经旧版字段优先级解析后无有效航向时，
      // 该配对不进行关联分析，返回可识别原因供前端展示“航向数据不足，未进行关联分析”。
      if (vesselTrack.length && carrierTrack.length && (!hasUsableHeading(vesselTrack) || !hasUsableHeading(carrierTrack))) {
        return { carrier, relationType: "未分析", reason: "insufficient_heading_data", vesselPointCount: vesselTrack.length, carrierPointCount: carrierTrack.length, sync: null, lag: null };
      }
      // 与 MATLAB 的成对比较逻辑一致：前者作为先导轨迹，后者作为跟随轨迹计算时延。
      const sync = analyzeSync(vesselTrack, carrierTrack);
      const lag = analyzeLag(vesselTrack, carrierTrack);
      const relationType = sync.matched ? "同步伴随" : lag.matched ? "时延跟随" : "未命中";
      const relation = { carrier, relationType, vesselPointCount: vesselTrack.length, carrierPointCount: carrierTrack.length, sync, lag };
      // 命中关联才随快照下发双方抽稀航迹（首帧/拉取失败回退）；未命中/未分析不下发，控制响应体积。
      if (relationType === "同步伴随" || relationType === "时延跟随") {
        relation.referenceTrackSeries = downsampleTrack(vesselTrack);
        relation.carrierTrackSeries = downsampleTrack(carrierTrack);
      }
      return relation;
    });
    associationsByMmsi[vessel.mmsi] = { status: vesselTrack.length ? "analyzed" : "no-track", reference: vessel, carriers: carriersResult };
  }
  return { rules: RULES, dataRules: CARRIER_AFFILIATION_DATA_RULES, generatedAt: new Date().toISOString(), associationsByMmsi };
}
