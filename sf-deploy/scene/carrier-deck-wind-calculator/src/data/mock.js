// Mock deck-wind data provider for the carrier deck-wind calculator.
//
// All data here is MOCK / DEMO. The payload is shaped like a future GFS-style
// public gridded 10 m wind feed so a real adapter can later replace this file.
//
// No fetch, no API keys, no backend, no cloud.

// Customer-specified values (verbatim, tagged [客户口径] in the UI).
export const DECK_WIND_MIN_KT = 20; // 舰载机起降所需甲板风最小值
export const CARRIER_MAX_SPEED_KT = 30; // 航母最大航速

// NOTE: The customer supplied ONLY 20 kt, 30 kt, and the achievable range
// [|W−30|, W+30]. The 满足 / 临界 / 不满足 grading below is a DEMO
// visualization derived purely from how that achievable range relates to the
// 20 kt line — it is NOT a customer-supplied rule. Every verdict is tagged
// [演示分级·待客户确认] in the UI, and 20 / 30 / range are tagged [客户口径].
// There are NO other operational thresholds (no 15 kt floor, no 45 kt ceiling,
// no 5 kt margin): those customer-unprovided numbers were removed when the
// 客户口径 / 演示分级 separation was introduced.

export const DATA_SOURCE_NAME = "公开格点风场（mock）";
export const REFRESH_CADENCE = "每 5 分钟更新";
export const DEMO_TICK_MS = 6000;

// Seed regions with a spread of true 10 m wind speeds so the demo shows BOTH
// 满足 and 临界 for each condition. Grading is range-vs-20kt only:
//   lo = |W−30|, hi = W+30
//   满足: lo ≥ 20      (any heading gives ≥ 20 kt deck wind; W ≤ 10 or W ≥ 50)
//   临界: lo < 20 ≤ hi (reaches 20 kt only heading into the wind; 10 < W < 50)
//   不满足: hi < 20    (cannot reach 20 kt; unreachable at W≥0 with a 30 kt
//                        carrier since hi = W+30 ≥ 30 > 20)
// Seeds: 6, 14, 26, 42, 58, 72 →
//   6 -> [24,36] 满足 | 14 -> [16,44] 临界 | 26 -> [4,56] 临界
//   42 -> [12,72] 临界 | 58 -> [28,88] 满足 | 72 -> [42,102] 满足
// (3 满足 + 3 临界; 不满足 is a defined legend state, not normally reachable.)
const SEED_REGIONS = [
  {
    id: "south-china-sea",
    region: "南海",
    carrier: "航母编队 A（南海巡逻区）",
    lat: 15.2,
    lon: 114.5,
    windSpeedKt: 6,
    windFromDeg: 70,
  },
  {
    id: "east-china-sea",
    region: "东海",
    carrier: "航母编队 B（东海训练区）",
    lat: 29.8,
    lon: 125.3,
    windSpeedKt: 14,
    windFromDeg: 320,
  },
  {
    id: "western-pacific",
    region: "西太平洋",
    carrier: "航母编队 C（西太机动区）",
    lat: 22.4,
    lon: 138.7,
    windSpeedKt: 26,
    windFromDeg: 200,
  },
  {
    id: "arabian-sea",
    region: "阿拉伯海",
    carrier: "航母编队 D（阿拉伯海待命区）",
    lat: 19.1,
    lon: 64.8,
    windSpeedKt: 42,
    windFromDeg: 250,
  },
  {
    id: "mediterranean",
    region: "地中海",
    carrier: "航母编队 E（地中海戒备区）",
    lat: 35.6,
    lon: 18.2,
    windSpeedKt: 58,
    windFromDeg: 290,
  },
  {
    id: "caribbean",
    region: "加勒比海",
    carrier: "航母编队 F（加勒比巡航区）",
    lat: 17.3,
    lon: -75.9,
    windSpeedKt: 72,
    windFromDeg: 110,
  },
];

/**
 * Compute the achievable deck-wind range [lo, hi] (kt) for a carrier at max
 * speed choosing heading relative to the true wind.
 *   into the wind -> max deck wind = W + 30
 *   with the wind -> min = |W - 30|  (absolute value: a 30 kt carrier
 *                                     outrunning a light following wind still
 *                                     sees its own apparent deck wind)
 */
export function computeAchievableRange(windSpeedKt, maxSpeedKt = CARRIER_MAX_SPEED_KT) {
  const lo = Math.abs(windSpeedKt - maxSpeedKt);
  const hi = windSpeedKt + maxSpeedKt;
  return { lo, hi };
}

/**
 * DEMO grading: how does the achievable deck-wind range relate to the
 * customer's 20 kt minimum? This is the ONLY basis for any verdict — there are
 * no other operational thresholds (no 15 kt floor, no 45 kt ceiling, no margin).
 *
 *   满足:   lo >= DECK_WIND_MIN_KT   (whole range at/above 20 kt; any heading OK)
 *   临界:   lo < DECK_WIND_MIN_KT <= hi  (reaches 20 kt only heading into wind)
 *   不满足: hi < DECK_WIND_MIN_KT    (cannot reach 20 kt)
 *
 * With a 30 kt carrier, hi = W + 30 >= 30 > 20, so 不满足 is not reachable in
 * normal conditions — it is a defined legend state only. Tagged
 * [演示分级·待客户确认] in the UI.
 */
function gradeRangeVs20Kt(achievableRange) {
  const { lo, hi } = achievableRange;
  if (lo >= DECK_WIND_MIN_KT) {
    return { status: "ok", label: "满足" };
  }
  if (hi >= DECK_WIND_MIN_KT) {
    return { status: "warn", label: "临界" };
  }
  return { status: "fail", label: "不满足" };
}

/**
 * "无弹射器辅助" (launch without catapult assist): can the carrier generate the
 * required deck wind from its own motion + ambient wind alone, at ANY heading?
 * Graded on the achievable range vs the 20 kt minimum (same basis as 安全着舰).
 */
export function assessNoCatapult(windSpeedKt) {
  return gradeRangeVs20Kt(computeAchievableRange(windSpeedKt));
}

/**
 * "安全着舰" (safe recovery): can the carrier hold deck wind at/above the 20 kt
 * minimum during recovery? Graded on the achievable range vs the 20 kt minimum
 * (same basis as 无弹射器辅助). Both conditions share the identical range-vs-20kt
 * basis; they differ only in operational framing.
 */
export function assessSafeRecovery(achievableRange) {
  return gradeRangeVs20Kt(achievableRange);
}

// Convert a wind "from" direction to a cardinal label (zh).
function cardinal(deg) {
  const dirs = [
    "北", "东北偏北", "东北", "东北偏东",
    "东", "东南偏东", "东南", "东南偏南",
    "南", "西南偏南", "西南", "西南偏西",
    "西", "西北偏西", "西北", "西北偏北",
  ];
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return dirs[idx];
}

/**
 * Build the full per-region payload from a base wind speed. This is what a
 * future GFS-like adapter would replace; the shape stays the same.
 */
export function buildRegionRecord(seed) {
  const windSpeedKt = Math.round(seed.windSpeedKt * 10) / 10;
  const achievableRange = computeAchievableRange(windSpeedKt);
  const noCatapult = assessNoCatapult(windSpeedKt);
  const safeRecovery = assessSafeRecovery(achievableRange);
  return {
    id: seed.id,
    region: seed.region,
    carrier: seed.carrier,
    lat: seed.lat,
    lon: seed.lon,
    // Gridded 10 m wind (mock GFS-like).
    windSpeedKt,
    windFromDeg: seed.windFromDeg,
    windFromCardinal: cardinal(seed.windFromDeg),
    // Carrier platform parameters (customer口径).
    maxSpeedKt: CARRIER_MAX_SPEED_KT,
    deckWindMinKt: DECK_WIND_MIN_KT,
    // Computed.
    achievableRange,
    conditions: {
      noCatapult,
      safeRecovery,
    },
  };
}

// A small deterministic nudge so the demo tick visibly changes W and verdicts,
// while keeping the seed structure and the "每 5 分钟更新" cadence intact.
function nudgeWind(seed, tick) {
  const amplitude = 2.2;
  const phase = (seed.id.charCodeAt(0) + seed.id.length) % 7;
  const delta = Math.sin((tick + phase) * 0.9) * amplitude;
  return Math.max(0, Math.round((seed.windSpeedKt + delta) * 10) / 10);
}

/**
 * Produce a full snapshot for the board at a given demo tick.
 * @param {number} tick monotonically increasing demo tick
 * @param {Date} now current time
 */
export function getSnapshot(tick = 0, now = new Date()) {
  const regions = SEED_REGIONS.map((seed) =>
    buildRegionRecord({ ...seed, windSpeedKt: nudgeWind(seed, tick) })
  );

  const noCatapultOk = regions.filter(
    (r) => r.conditions.noCatapult.status === "ok"
  ).length;
  const safeRecoveryOk = regions.filter(
    (r) => r.conditions.safeRecovery.status === "ok"
  ).length;

  return {
    source: DATA_SOURCE_NAME,
    isMock: true,
    refreshCadence: REFRESH_CADENCE,
    snapshotAt: now,
    tickMs: DEMO_TICK_MS,
    regionCount: regions.length,
    // Thresholds surfaced in KPI strip.
    deckWindMinKt: DECK_WIND_MIN_KT,
    carrierMaxSpeedKt: CARRIER_MAX_SPEED_KT,
    summary: {
      noCatapultOk,
      safeRecoveryOk,
    },
    regions,
  };
}

export const SEED_REGIONS_RAW = SEED_REGIONS;
