import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("./app-server.js", import.meta.url), "utf8");
const trackWindowsSource = readFileSync(new URL("./trackWindows.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/app/App.jsx", import.meta.url), "utf8");
const playbackSource = readFileSync(new URL("../src/logic/playback.js", import.meta.url), "utf8");

test("server-side track consumers use ontology without calling BUPT", () => {
  assert.doesNotMatch(serverSource, /0x0157|0x5101|requestRemoteMapTrack|requestRemoteMapLatest|buildRemoteMapTrack/);
  assert.match(serverSource, /async function getOntologyTrack\(mmsi, \{ force = false \} = \{\}\)[\s\S]*?buildTrack\(mmsi\)/);
  assert.match(serverSource, /buildOntologyTrackOrEmpty\(mmsi, context, options\)[\s\S]*?await getOntologyTrack\(mmsi, options\)/);
  assert.match(serverSource, /buildAffiliationTrack\(mmsi\)[\s\S]*?buildOntologyTrackOrEmpty\(mmsi, "affiliation"\)/);
  assert.match(serverSource, /mapConcurrent\(MONITORED_VESSELS, 3,[\s\S]*?buildOntologyTrackOrEmpty\(vessel\.mmsi, "fleet-summary", \{ force: true \}\)/);
  assert.match(serverSource, /trackMatch\)[\s\S]*?await getOntologyTrack\(trackMatch\[1\], \{ force: url\.searchParams\.get\("fresh"\) === "1" \}\)/);
});

test("BUPT remote iframe remains the only remote map track path", () => {
  assert.match(playbackSource, /DEFAULT_REMOTE_MAP_BASE_URL\s*=\s*"http:\/\/218\.61\.33\.200:18000\/"/);
  assert.match(appSource, /useState\("remote"\)/);
  assert.match(appSource, /<RemotePlaybackMap[\s\S]*?src=\{remoteMapUrl\}/);
});

test("ontology history uses bounded windows and fleet concurrency", () => {
  // 单次请求硬上限 20w（超过会被接口静默截断），安全阈值必须更低；禁止使用分页模式。
  assert.match(trackWindowsSource, /FETCH_LIMIT = 200_000/);
  assert.match(trackWindowsSource, /SAFE_RECORD_THRESHOLD = 150_000/);
  assert.doesNotMatch(serverSource, /pageSize|pageIndex: pageIndex|pageCount/);
  assert.match(serverSource, /pageParam: \{ pageIndex: 1, limit: FETCH_LIMIT \}/);
  assert.match(serverSource, /mapConcurrent\(MONITORED_VESSELS, 3,/);
});

test("time-windowed batching and incremental refresh are enforced", () => {
  // 窗口化分批：先探测 recordTotal，超限按 月→日→二分 细分，触底硬拉并标记截断。
  assert.match(serverSource, /probeRecordCount\(mmsi, startMs, endMs\)/);
  assert.match(serverSource, /collectWindowedPoints\(mmsi, startMs, endMs/);
  assert.match(serverSource, /total <= SAFE_RECORD_THRESHOLD/);
  assert.match(serverSource, /window\.complete/);
  assert.match(serverSource, /splitWindow\(startMs, endMs\)/);
  assert.match(serverSource, /stats\.truncated = true/);
  // 增量：水位线回退 2h 重叠，钳制到 now，轨迹落盘供重启复用。
  assert.match(serverSource, /TRACK_OVERLAP_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(serverSource, /Math\.min\(lastTimeMs, nowMs\)/);
  assert.match(serverSource, /trackStoreRoot = resolve\(dataRoot, "tracks"\)/);
  assert.match(serverSource, /await saveTrackStore\(mmsi, trackPoints\)/);
  // 基准窗口 2025-01-01；旧窗口快照/缓存判废。
  assert.match(serverSource, /trackBaselineStartMs = Date\.UTC\(2025, 0, 1\)/);
  assert.match(serverSource, /metadata\?\.trackWindowStart === new Date\(trackBaselineStartMs\)\.toISOString\(\)/);
  assert.match(serverSource, /store\?\.windowStart !== new Date\(trackBaselineStartMs\)\.toISOString\(\)/);
  // 轨迹存储版本判废：本体回填"水位线之前"的历史报点后，旧缓存必须全量重拉（增量拉不到回填段）。
  assert.match(serverSource, /const trackStoreVersion = "v3-20260818-ontology-backfill"/);
  assert.match(serverSource, /store\?\.trackStoreVersion !== trackStoreVersion/);
  assert.match(serverSource, /trackStoreVersion,\s*\n\s*updatedAt: new Date\(\)\.toISOString\(\),\s*\n\s*trackPoints,/);
});

test("ontology-only snapshots, timezone handling, and shared requests are enforced", () => {
  assert.match(serverSource, /customer-confirmed-v14-20260818/);
  // 快照判废必须同时比较算法版本、RULES 与 dataRules（航向来源/时间精度/去重规则）。
  assert.match(serverSource, /JSON\.stringify\(snapshot\?\.dataRules \|\| \{\}\) !== JSON\.stringify\(CARRIER_AFFILIATION_DATA_RULES\)/);
  // 航迹图渲染序列接口：服务端从全量轨迹生成分桶抽稀序列，前端不再下载十万级点数组。
  assert.match(serverSource, /url\.searchParams\.get\("render"\) === "1"/);
  assert.match(serverSource, /buildTrackRenderSeries\(track\.trackPoints\)/);
  assert.match(serverSource, /renderedFromFullTrack: true/);
  // 空窗信息由服务端在全量轨迹上检测并随渲染序列下发（前端断线/虚线/标注）。
  assert.match(serverSource, /renderGaps: rendered\.gaps/);
  assert.match(serverSource, /renderGapCount: rendered\.gapCount/);
  assert.match(serverSource, /affiliationNeedsRefresh[\s\S]*?affiliationHistory = null/);
  assert.match(serverSource, /AbortSignal\.timeout\(120_000\)/);
  assert.match(serverSource, /trackInFlight\.has\(mmsi\)/);
  assert.match(serverSource, /trackCache\.set\(mmsi, \{ track \}\)/);
  assert.match(serverSource, /if \(!force && cached\) return cached\.track/);
  assert.match(serverSource, /target\.score = null/);
  assert.match(serverSource, /status: "source-error"/);
  assert.match(serverSource, /status: "partial-source-error"/);
  assert.match(serverSource, /monitoredMmsiSet\.has\(trackMatch\[1\]\)/);
  assert.match(serverSource, /snapshot\?\.metadata\?\.source === "ontology-daas"/);
  assert.match(serverSource, /summaryReady = summarySnapshotUsable\(summarySnapshot\)/);
  assert.match(serverSource, /if \(fleetRefreshPromise\) await fleetRefreshPromise/);
  assert.match(serverSource, /\+08:00/);
  assert.match(serverSource, /timeMs \+ 8 \* 60 \* 60 \* 1000/);
});
