// 与使用方提供的 Python select.py 保持一致的关联阈值与计算口径。
export const CARRIER_AFFILIATION_RULES = Object.freeze({
  syncDistThreshNm: 20,
  syncCourseThreshDeg: 30,
  lagMaxMinutes: 30 * 24 * 60,
  lagStepMinutes: 24 * 60,
  lagDistThreshNm: 100,
  lagCourseThreshDeg: 45,
  minMatchedPoints: 8,
  timeMatchWindowSyncSec: 30 * 60,
  timeMatchWindowLagSec: 120,
});

const RULES = CARRIER_AFFILIATION_RULES;

const EARTH_RADIUS_NM = 3440.065;

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cleanTrack(points = []) {
  const validPoints = [];
  for (const point of points) {
    const timeMs = Date.parse(point.time);
    const lon = finite(point.lon);
    const lat = finite(point.lat);
    if (!Number.isFinite(timeMs) || lon === null || lat === null || lon === 0 || lat === 0 || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    validPoints.push({ ...point, timeMs, lon, lat, speedKn: finite(point.speedKn), heading: finite(point.heading ?? point.courseDeg) });
  }
  validPoints.sort((a, b) => a.timeMs - b.timeMs);
  const byTime = new Map();
  // MATLAB 对时间排序后按 quire_time 去重；同一时刻保留排序后的第一条。
  for (const point of validPoints) if (!byTime.has(point.timeMs)) byTime.set(point.timeMs, point);
  return [...byTime.values()];
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
  return values.length ? Math.min(...values) : null;
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
  // 详情弹窗航迹对比图需要双方真实经纬度；对全量 AIS 抽稀并只保留时间/经纬度，控制快照体积。
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
    if (point.speedKn > 1 && matched.point.speedKn > 1 && point.heading !== null && matched.point.heading !== null) {
      courseCosines.push(Math.cos((point.heading - matched.point.heading) * Math.PI / 180));
    }
  }
  const averageDistanceNm = avg(distances);
  const minimumDistanceNm = minimum(distances);
  const averageCourseCosine = courseCosines.length ? avg(courseCosines) : 1;
  return { matchedPoints: distances.length, averageDistanceNm, minimumDistanceNm, averageCourseCosine, ...range(times), matched: distances.length >= RULES.minMatchedPoints && averageDistanceNm < RULES.syncDistThreshNm && averageCourseCosine > Math.cos(RULES.syncCourseThreshDeg * Math.PI / 180) };
}

function analyzeLag(leader, follower) {
  let best = null;
  for (let lagMinutes = -RULES.lagMaxMinutes; lagMinutes <= RULES.lagMaxMinutes; lagMinutes += RULES.lagStepMinutes) {
    const lagMs = lagMinutes * 60_000;
    // 没有时间交集时直接跳过，等价 Python 对平移后轨迹的快速判断。
    if (!leader.length || !follower.length || follower[0].timeMs + lagMs > leader.at(-1).timeMs || follower.at(-1).timeMs + lagMs < leader[0].timeMs) continue;
    const rawMatches = [];
    const cursor = { index: 0 };
    for (const point of leader) {
      // Python 版将候选航母时间向 lag 方向平移；换算到原始时间即为 leader - lag。
      const interpolated = interpolateFollowerAt(follower, point.timeMs - lagMs, cursor);
      if (!interpolated || interpolated.lon === null || interpolated.lat === null) continue;
      rawMatches.push({ point, interpolated, distanceNm: distanceNm(point, interpolated) });
    }
    if (rawMatches.length < RULES.minMatchedPoints) continue;

    // 与对方 Python 程序一致：仅当航向过滤后仍有足够点，才采用航向过滤结果；否则回退到全部有效插值点。
    const courseMatched = rawMatches.filter(({ point, interpolated }) => point.heading !== null && interpolated.heading !== null
      && courseDifference(point.heading, interpolated.heading) <= RULES.lagCourseThreshDeg);
    const courseFilterApplied = courseMatched.length >= RULES.minMatchedPoints;
    const matches = courseFilterApplied ? courseMatched : rawMatches;
    const distances = matches.map((match) => match.distanceNm);
    const averageDistanceNm = avg(distances);
    const minimumDistanceNm = minimum(distances);
    if (!best || averageDistanceNm < best.averageDistanceNm) {
      // 图表回退序列沿用本轮关联判定已使用的插值点，不能因原始报点稀疏而丢失证据。
      const alignedDistanceSeries = downsampleSeries(matches.map(({ point, distanceNm: matchedDistanceNm }) => ({
        time: new Date(point.timeMs).toISOString(),
        distanceNm: matchedDistanceNm,
      })));
      best = {
        lagMinutes,
        averageDistanceNm,
        minimumDistanceNm,
        // median/withinThresholdRatio 与 select0721.py 的 median_dist/ratio 口径一致，
        // 均由本轮判定已计算的距离聚合而来，纯展示字段，不参与命中判定。
        medianDistanceNm: median(distances),
        withinThresholdRatio: rawMatches.length ? rawMatches.filter((match) => match.distanceNm < RULES.lagDistThreshNm).length / rawMatches.length : null,
        matchedPoints: matches.length,
        courseFilterApplied,
        maxCourseDifferenceDeg: courseFilterApplied ? Math.max(...matches.map(({ point, interpolated }) => courseDifference(point.heading, interpolated.heading))) : null,
        ...range(matches.map((match) => match.point.timeMs)),
        alignedDistanceSeries,
      };
    }
  }
  if (!best || best.averageDistanceNm >= RULES.lagDistThreshNm) {
    const { alignedDistanceSeries, ...lagResult } = best || { lagMinutes: null, averageDistanceNm: null, minimumDistanceNm: null, medianDistanceNm: null, withinThresholdRatio: null, matchedPoints: 0, courseFilterApplied: false, maxCourseDifferenceDeg: null, startTime: null, endTime: null };
    return { ...lagResult, distanceSeries: [], distanceSeriesSource: null, matched: false };
  }

  // 图表只保留已按最佳时延对齐、且真实报点时间相近的距离，避免将插值点误当作 AIS 实测点。
  const distanceSeries = [];
  for (const point of leader) {
    const matched = nearestWithin(follower, point.timeMs - best.lagMinutes * 60_000, RULES.timeMatchWindowLagSec * 1000);
    if (!matched) continue;
    distanceSeries.push({ time: new Date(point.timeMs).toISOString(), distanceNm: distanceNm(point, matched.point) });
  }
  const { alignedDistanceSeries, ...lagResult } = best;
  const hasObservedSeries = distanceSeries.length >= 2;
  return {
    ...lagResult,
    // 原始 AIS 同时刻报点不足时展示计算判定实际采用的插值序列，并通过来源字段供前端如实标注。
    distanceSeries: hasObservedSeries ? downsampleSeries(distanceSeries) : alignedDistanceSeries,
    distanceSeriesSource: hasObservedSeries ? "observed" : "interpolated",
    matched: true,
  };
}

export function analyzeCarrierAffiliations({ reference, candidates, tracksByMmsi }) {
  const referenceTrack = cleanTrack(tracksByMmsi[reference.mmsi] || []);
  const relations = candidates.map((candidate) => {
    const candidateTrack = cleanTrack(tracksByMmsi[candidate.mmsi] || []);
    // 与 Python 程序一致：用户选择的无人艇为参考轨迹，逐一对比候选航母。
    const sync = analyzeSync(referenceTrack, candidateTrack);
    const lag = analyzeLag(referenceTrack, candidateTrack);
    const relationType = sync.matched ? "同步伴随" : lag.matched ? "时延跟随" : "未发现满足阈值的关联";
    return { candidate, leaderMmsi: reference.mmsi, followerMmsi: candidate.mmsi, referenceMmsi: reference.mmsi, candidatePointCount: candidateTrack.length, referencePointCount: referenceTrack.length, relationType, sync, lag };
  });
  return { reference, rules: RULES, generatedAt: new Date().toISOString(), relations };
}

export function analyzeVesselCarrierRelations({ vessels, carriers, tracksByMmsi }) {
  const associationsByMmsi = {};
  for (const vessel of vessels) {
    if (carriers.some((carrier) => carrier.mmsi === vessel.mmsi)) {
      associationsByMmsi[vessel.mmsi] = { status: "carrier", reference: vessel, carriers: [] };
      continue;
    }
    const vesselTrack = cleanTrack(tracksByMmsi[vessel.mmsi] || []);
    const carriersResult = carriers.map((carrier) => {
      const carrierTrack = cleanTrack(tracksByMmsi[carrier.mmsi] || []);
      // 与 MATLAB 的成对比较逻辑一致：前者作为先导轨迹，后者作为跟随轨迹计算时延。
      const sync = analyzeSync(vesselTrack, carrierTrack);
      const lag = analyzeLag(vesselTrack, carrierTrack);
      const relationType = sync.matched ? "同步伴随" : lag.matched ? "时延跟随" : "未命中";
      const relation = { carrier, relationType, vesselPointCount: vesselTrack.length, carrierPointCount: carrierTrack.length, sync, lag };
      // 命中关联才随快照下发双方抽稀航迹，供详情弹窗绘制航迹对比图；未命中不下发，控制响应体积。
      if (relationType !== "未命中") {
        relation.referenceTrackSeries = downsampleTrack(vesselTrack);
        relation.carrierTrackSeries = downsampleTrack(carrierTrack);
      }
      return relation;
    });
    associationsByMmsi[vessel.mmsi] = { status: vesselTrack.length ? "analyzed" : "no-track", reference: vessel, carriers: carriersResult };
  }
  return { rules: RULES, generatedAt: new Date().toISOString(), associationsByMmsi };
}
