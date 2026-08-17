// 0721 黄金回归（离线验证，不进入 npm test）：
// 用客户提供的北邮 CSV（scene/0721/SEAHAWK.csv + hm366984000.csv）跑当前关联算法，
// 与 server/verify-0721-golden.baseline.json 中固定的 v12 基线对比。
// 用法：
//   node server/verify-0721-golden.mjs           # 校验（不一致时退出码 1）
//   node server/verify-0721-golden.mjs --write   # 重新生成基线（仅在客户确认口径变更后使用，并在修改记录.md 说明）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { analyzeVesselCarrierRelations, CARRIER_AFFILIATION_DATA_RULES } from "./carrierAffiliation.js";

const here = dirname(fileURLToPath(import.meta.url));
const csvDir = resolve(here, "..", "..", "0721");
const baselineFile = resolve(here, "verify-0721-golden.baseline.json");

const num = (s) => {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function parseTime(s) {
  // 支持 "2025/1/7 0:57" 与 "2025-06-25 01:11:54"，统一按 UTC 解析。
  const m = String(s).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString();
}

function loadCsv(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const header = lines[0].split(",");
  const col = (name) => header.indexOf(name);
  const [ciTime, ciLng, ciLat, ciSpeed, ciOrient, ciHeading] = [col("quire_time"), col("lng"), col("lat"), col("speed"), col("orientation"), col("heading")];
  const points = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(",");
    const time = parseTime(f[ciTime]);
    if (!time) continue;
    // 航向来源沿用修改前生产版本字段优先级（heading → courseDeg 兜底）：
    // CSV 的 heading 列按本体 trueHeading 语义映射 heading，orientation 列（COG 口径）映射 courseDeg。
    points.push({
      time,
      lon: num(f[ciLng]),
      lat: num(f[ciLat]),
      speedKn: num(f[ciSpeed]),
      heading: num(f[ciHeading]),
      courseDeg: num(f[ciOrient]),
    });
  }
  return points;
}

const usv = loadCsv(resolve(csvDir, "SEAHAWK.csv"));
const cvn = loadCsv(resolve(csvDir, "hm366984000.csv"));
console.log(`SEAHAWK.csv 点数 ${usv.length}，hm366984000.csv 点数 ${cvn.length}`);

const result = analyzeVesselCarrierRelations({
  vessels: [{ mmsi: "368926574", name: "海鹰" }],
  carriers: [{ mmsi: "366984000", name: "CVN-71", role: "航母" }],
  tracksByMmsi: { "368926574": usv, "366984000": cvn },
});
const lag = result.associationsByMmsi["368926574"].carriers[0].lag;

const actual = {
  dataRules: CARRIER_AFFILIATION_DATA_RULES,
  lagMinutes: lag.lagMinutes,
  lagHours: lag.lagMinutes == null ? null : lag.lagMinutes / 60,
  averageDistanceNm: lag.averageDistanceNm,
  medianDistanceNm: lag.medianDistanceNm,
  minimumDistanceNm: lag.minimumDistanceNm,
  matchedPoints: lag.matchedPoints,
  withinThresholdRatio: lag.withinThresholdRatio,
  startTime: lag.startTime,
  endTime: lag.endTime,
};
console.log("实际结果:", JSON.stringify(actual, null, 2));

if (process.argv.includes("--write")) {
  writeFileSync(baselineFile, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`基线已写入 ${baselineFile}`);
  process.exit(0);
}

if (!existsSync(baselineFile)) {
  console.error("未找到基线文件，先以 --write 生成。");
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const TOLERANCE = 1e-6;
let failed = false;
for (const key of ["lagMinutes", "matchedPoints", "startTime", "endTime"]) {
  if (baseline[key] !== actual[key]) {
    console.error(`✖ ${key}: 基线 ${baseline[key]} ≠ 实际 ${actual[key]}`);
    failed = true;
  }
}
for (const key of ["averageDistanceNm", "medianDistanceNm", "minimumDistanceNm", "withinThresholdRatio"]) {
  if (Math.abs((baseline[key] ?? NaN) - (actual[key] ?? NaN)) > TOLERANCE) {
    console.error(`✖ ${key}: 基线 ${baseline[key]} ≠ 实际 ${actual[key]}`);
    failed = true;
  }
}
if (failed) {
  console.error("黄金回归失败：结果偏离 v12 基线。若为客户确认的口径变更，用 --write 重建基线并在修改记录.md 说明。");
  process.exit(1);
}
console.log("✔ 与 v12 基线一致");
