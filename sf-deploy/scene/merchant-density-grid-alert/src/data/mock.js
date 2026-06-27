// Mock AIS merchant-density provider.
//
// All data here is DEMO/MOCK, shaped for the future real AIS aggregation adapter.
// No fetch, no backend, no keys. When a real AIS source is wired in, this file is
// replaced by an adapter that emits the same { gridSizeNm, cells: [...] } shape.
//
// Customer口径 (verbatim):
//   - 接入 AIS 船舶位置数据流 (here: mock provider named "AIS 船舶位置（mock）")
//   - 将美在外活动航母区域按边长 50 海里划分网格监控
//   - 统计各网格内正在活动的商船数量
//   - 基准线取 30 天滑动平均
//   - 当前数量低于基准线 70% 时黄灯，低于 50% 时红灯
//   - 每 3 分钟刷新一次 (the UI shows this string; the local demo tick is faster)

export const SOURCE_NAME = "AIS 船舶位置（mock）";
export const REFRESH_CADENCE = "每 3 分钟刷新一次";
export const GRID_SIZE_NM = 50;
export const YELLOW_RATIO = 0.7;
export const RED_RATIO = 0.5;
export const DEMO_TICK_MS = 6000; // local demo tick (UI still shows the real cadence)

// Sea-area operating zones for US carriers abroad. Each zone is a labelled
// cluster of 50-nm grid cells. Coordinates are illustrative cell centres.
const ZONES = [
  {
    zone: "西太平洋-菲律宾海",
    origin: { lat: 16.0, lon: 132.0 },
    rows: 3,
    cols: 3,
  },
  {
    zone: "阿拉伯海-北阿拉伯海",
    origin: { lat: 24.0, lon: 58.0 },
    rows: 2,
    cols: 3,
  },
  {
    zone: "东地中海水域",
    origin: { lat: 34.0, lon: 30.0 },
    rows: 2,
    cols: 2,
  },
];

// Cell size in degrees. 1 degree latitude ~ 60 nm, so 50 nm ~ 0.833 deg lat.
// Using ~0.83 deg for lat and a longitude compaction near the equator.
const CELL_LAT_DEG = 0.83;
const CELL_LON_DEG = 0.83;

// Deterministic pseudo-random so seeded cells stay stable across renders until
// the demo tick nudges them. Seeded so green/yellow/red all appear on first load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a 30-point history around a baseline, ending at currentCount.
function buildHistory(baseline, currentCount, rng, jitter = 0.12) {
  const points = 30;
  const series = [];
  for (let i = 0; i < points; i++) {
    // gradual drift from baseline toward current so the curve shows the dip
    const progress = i / (points - 1);
    const drift = baseline + (currentCount - baseline) * progress;
    const noise = (rng() - 0.5) * 2 * baseline * jitter;
    const v = Math.max(0, Math.round(drift + noise));
    series.push(v);
  }
  // last point is exactly the current count
  series[points - 1] = currentCount;
  return series;
}

// Seed ratios spread across red / yellow / green so all three statuses appear.
// Cycles through target ratios so the board visibly contains every status.
const SEED_RATIOS = [0.38, 0.55, 0.62, 0.78, 0.92, 1.08, 1.22, 0.48, 0.85];

function buildCell(zoneName, row, col, idx, rng) {
  const id = `${zoneName}-${row}${col}`;
  const lat = +(zoneOriginLat(zoneName) + row * CELL_LAT_DEG).toFixed(3);
  const lon = +(zoneOriginLon(zoneName) + col * CELL_LON_DEG).toFixed(3);

  // baseline = 30-day sliding average merchant count for this cell
  const baseline = 20 + Math.floor(rng() * 90); // 20..109
  const targetRatio = SEED_RATIOS[idx % SEED_RATIOS.length];
  let currentCount = Math.max(0, Math.round(baseline * targetRatio));
  // small per-cell variation so counts don't look templated
  currentCount = Math.max(0, currentCount + Math.floor((rng() - 0.5) * 6));

  const history = buildHistory(baseline, currentCount, rng);

  return {
    id,
    zone: zoneName,
    row,
    col,
    lat,
    lon,
    baseline30d: baseline,
    currentCount,
    history,
    // size label surfaced in the UI
    sizeNm: GRID_SIZE_NM,
    lastUpdated: 0, // filled at runtime
  };
}

function zoneOriginLat(zoneName) {
  return ZONES.find((z) => z.zone === zoneName).origin.lat;
}
function zoneOriginLon(zoneName) {
  return ZONES.find((z) => z.zone === zoneName).origin.lon;
}

function buildInitialCells() {
  const rng = mulberry32(20260618);
  const cells = [];
  let idx = 0;
  for (const z of ZONES) {
    for (let r = 0; r < z.rows; r++) {
      for (let c = 0; c < z.cols; c++) {
        cells.push(buildCell(z.zone, r, c, idx, rng));
        idx++;
      }
    }
  }
  return cells;
}

// ---- Status rule (derived directly from customer numbers) ----
// ratio = currentCount / baseline30d
//   ratio >= 0.70 -> green
//   0.50 <= ratio < 0.70 -> yellow
//   ratio < 0.50 -> red
export function computeStatus(cell) {
  const ratio = cell.baseline30d > 0 ? cell.currentCount / cell.baseline30d : 1;
  if (ratio < RED_RATIO) return { level: "red", label: "红灯", ratio };
  if (ratio < YELLOW_RATIO) return { level: "yellow", label: "黄灯", ratio };
  return { level: "green", label: "绿灯", ratio };
}

// Build the initial snapshot. `snapshot()` produces the shape a future adapter
// would return, with a runtime `fetchedAt` timestamp.
export function initialSnapshot() {
  const cells = buildInitialCells();
  return {
    source: SOURCE_NAME,
    isMock: true,
    gridSizeNm: GRID_SIZE_NM,
    fetchedAt: Date.now(),
    cells,
    thresholds: { yellow: YELLOW_RATIO, red: RED_RATIO, baselineWindowDays: 30 },
  };
}

// Advance the demo state: nudge each cell's current count, push it onto the
// history series, and refresh fetchedAt. This makes last-refresh, curves, ratios
// and statuses visibly move while the UI keeps showing "每 3 分钟刷新一次".
export function tickSnapshot(prev) {
  const rng = mulberry32((Date.now() & 0xffffffff) ^ 0x9e3779b9);
  const cells = prev.cells.map((cell) => {
    // random walk the current count by up to +/-12% of baseline
    const delta = Math.round((rng() - 0.45) * cell.baseline30d * 0.24);
    const next = Math.max(0, cell.currentCount + delta);
    const history = [...cell.history.slice(-29), next];
    return { ...cell, currentCount: next, history };
  });
  return { ...prev, cells, fetchedAt: Date.now() };
}
