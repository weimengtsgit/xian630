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
});

test("ontology-only snapshots, timezone handling, and shared requests are enforced", () => {
  assert.match(serverSource, /python-select-v8-track-window-2025-01-01/);
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
