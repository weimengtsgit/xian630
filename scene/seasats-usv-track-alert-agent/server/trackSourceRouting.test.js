import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("./app-server.js", import.meta.url), "utf8");
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

test("ontology history uses bounded page and fleet concurrency", () => {
  assert.match(serverSource, /const pageSize = 10_000/);
  assert.match(serverSource, /mapConcurrent\(MONITORED_VESSELS, 3,/);
});

test("ontology-only snapshots, timezone handling, and shared requests are enforced", () => {
  assert.match(serverSource, /python-select-v7-affiliation-detail-tracks/);
  assert.match(serverSource, /affiliationNeedsRefresh[\s\S]*?affiliationHistory = null/);
  assert.match(serverSource, /AbortSignal\.timeout\(120_000\)/);
  assert.match(serverSource, /trackInFlight\.has\(mmsi\)/);
  assert.match(serverSource, /trackCache\.set\(mmsi,/);
  assert.match(serverSource, /if \(!force && cached\?\.expiresAt > Date\.now\(\)\) return cached\.track/);
  assert.match(serverSource, /target\.score = null/);
  assert.match(serverSource, /status: "source-error"/);
  assert.match(serverSource, /status: "partial-source-error"/);
  assert.match(serverSource, /monitoredMmsiSet\.has\(trackMatch\[1\]\)/);
  assert.match(serverSource, /trackCache\.delete\(mmsi\)/);
  assert.match(serverSource, /snapshot\?\.metadata\?\.source === "ontology-daas"/);
  assert.match(serverSource, /summaryReady = summarySnapshotUsable\(summarySnapshot\)/);
  assert.match(serverSource, /if \(fleetRefreshPromise\) await fleetRefreshPromise/);
  assert.match(serverSource, /\+08:00/);
  assert.match(serverSource, /timeMs \+ 8 \* 60 \* 60 \* 1000/);
});
