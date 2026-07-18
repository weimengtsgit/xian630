// 与使用方提供的 corralation.m 保持一致的关联阈值与计算口径。
const RULES = {
  syncDistThreshNm: 10,
  syncCourseThreshDeg: 30,
  lagMaxMinutes: 120,
  lagStepMinutes: 60,
  lagDistThreshNm: 100,
  lagCourseThreshDeg: 45,
  minMatchedPoints: 8,
  timeMatchWindowSyncSec: 30,
  timeMatchWindowLagSec: 120,
};

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
  const averageCourseCosine = courseCosines.length ? avg(courseCosines) : 1;
  return { matchedPoints: distances.length, averageDistanceNm, averageCourseCosine, ...range(times), matched: distances.length >= RULES.minMatchedPoints && averageDistanceNm < RULES.syncDistThreshNm && averageCourseCosine > Math.cos(RULES.syncCourseThreshDeg * Math.PI / 180) };
}

function analyzeLag(leader, follower) {
  let best = null;
  for (let lagMinutes = -RULES.lagMaxMinutes; lagMinutes <= RULES.lagMaxMinutes; lagMinutes += RULES.lagStepMinutes) {
    const distances = [];
    const times = [];
    for (const point of leader) {
      const matched = nearestWithin(follower, point.timeMs + lagMinutes * 60_000, RULES.timeMatchWindowLagSec * 1000);
      if (!matched) continue;
      if (point.speedKn > 0.5 && matched.point.speedKn > 0.5) {
        let headingDiff = Math.abs(point.heading - matched.point.heading);
        if (headingDiff > 180) headingDiff = 360 - headingDiff;
        if (headingDiff > RULES.lagCourseThreshDeg) continue;
      }
      distances.push(distanceNm(point, matched.point));
      times.push(point.timeMs);
    }
    if (distances.length < RULES.minMatchedPoints) continue;
    const averageDistanceNm = avg(distances);
    if (!best || averageDistanceNm < best.averageDistanceNm) best = { lagMinutes, averageDistanceNm, matchedPoints: distances.length, ...range(times) };
  }
  return { ...(best || { lagMinutes: null, averageDistanceNm: null, matchedPoints: 0, startTime: null, endTime: null }), matched: Boolean(best && best.averageDistanceNm < RULES.lagDistThreshNm) };
}

export function analyzeCarrierAffiliations({ reference, candidates, tracksByMmsi }) {
  const referenceTrack = cleanTrack(tracksByMmsi[reference.mmsi] || []);
  const relations = candidates.map((candidate) => {
    const candidateTrack = cleanTrack(tracksByMmsi[candidate.mmsi] || []);
    // 压缩包的文件排序会使候选舰船位于 usv338414915.csv 前；此处同样以候选舰船为“先导”，无人艇为“跟随”。
    const sync = analyzeSync(candidateTrack, referenceTrack);
    const lag = analyzeLag(candidateTrack, referenceTrack);
    const relationType = sync.matched ? "同步伴随" : lag.matched ? "时延跟随" : "未发现满足阈值的关联";
    return { candidate, leaderMmsi: candidate.mmsi, followerMmsi: reference.mmsi, referenceMmsi: reference.mmsi, candidatePointCount: candidateTrack.length, referencePointCount: referenceTrack.length, relationType, sync, lag };
  });
  return { reference, rules: RULES, generatedAt: new Date().toISOString(), relations };
}

export function analyzeVesselCarrierRelations({ vessels, carriers, tracksByMmsi }) {
  const associationsByMmsi = {};
  for (const vessel of vessels) {
    if (carriers.some((carrier) => carrier.mmsi === vessel.mmsi)) {
      associationsByMmsi[vessel.mmsi] = { status: "carrier", carriers: [] };
      continue;
    }
    const vesselTrack = cleanTrack(tracksByMmsi[vessel.mmsi] || []);
    const carriersResult = carriers.map((carrier) => {
      const carrierTrack = cleanTrack(tracksByMmsi[carrier.mmsi] || []);
      // 与 MATLAB 的成对比较逻辑一致：前者作为先导轨迹，后者作为跟随轨迹计算时延。
      const sync = analyzeSync(vesselTrack, carrierTrack);
      const lag = analyzeLag(vesselTrack, carrierTrack);
      const relationType = sync.matched ? "同步伴随" : lag.matched ? "时延跟随" : "未命中";
      return { carrier, relationType, vesselPointCount: vesselTrack.length, carrierPointCount: carrierTrack.length, sync, lag };
    });
    associationsByMmsi[vessel.mmsi] = { status: vesselTrack.length ? "analyzed" : "no-track", carriers: carriersResult };
  }
  return { rules: RULES, generatedAt: new Date().toISOString(), associationsByMmsi };
}
