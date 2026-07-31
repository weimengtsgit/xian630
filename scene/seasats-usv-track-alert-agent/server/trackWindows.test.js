import assert from "node:assert/strict";
import test from "node:test";
import { FETCH_LIMIT, MIN_WINDOW_MS, SAFE_RECORD_THRESHOLD, mergeTrackPoints, splitWindow, trackPointKey } from "./trackWindows.js";

const DAY = 24 * 60 * 60 * 1000;

test("constants enforce the 200k single-request hard limit", () => {
  assert.equal(FETCH_LIMIT, 200_000);
  assert.ok(SAFE_RECORD_THRESHOLD < FETCH_LIMIT, "安全阈值必须低于 20w 硬上限");
  assert.equal(MIN_WINDOW_MS, 60 * 60 * 1000);
});

test("splitWindow returns null for windows at or below the 1-hour floor", () => {
  assert.equal(splitWindow(0, MIN_WINDOW_MS), null);
  assert.equal(splitWindow(0, MIN_WINDOW_MS / 2), null);
  assert.equal(splitWindow(1000, 500), null, "无效窗口不可拆分");
});

test("splitWindow bisects small windows (<= 2 days)", () => {
  const start = Date.UTC(2026, 6, 15, 3, 30);
  const end = start + 6 * 60 * 60 * 1000;
  const parts = splitWindow(start, end);
  assert.equal(parts.length, 2);
  assert.deepEqual([parts[0][0], parts.at(-1)[1]], [start, end], "子窗口必须无缝覆盖原窗口");
  assert.equal(parts[0][1], parts[1][0]);
});

test("splitWindow uses calendar days for multi-day spans", () => {
  const start = Date.UTC(2026, 6, 14, 12, 0);
  const end = Date.UTC(2026, 6, 18, 9, 0);
  const parts = splitWindow(start, end);
  // 首末窗口对齐到自然日边界，中间为完整天
  assert.deepEqual(parts[0], [start, Date.UTC(2026, 6, 15)]);
  assert.deepEqual(parts.at(-1), [Date.UTC(2026, 6, 18), end]);
  assert.equal(parts.length, 5);
  for (let i = 1; i < parts.length; i += 1) assert.equal(parts[i - 1][1], parts[i][0], "子窗口必须连续无空洞");
});

test("splitWindow uses calendar months for spans over 45 days", () => {
  const start = Date.UTC(2025, 0, 1);
  const end = Date.UTC(2025, 4, 12);
  const parts = splitWindow(start, end);
  assert.equal(parts.length, 5, "1 月至 5 月共 5 个月度窗口");
  assert.deepEqual(parts[0], [start, Date.UTC(2025, 1, 1)]);
  assert.deepEqual(parts.at(-1), [Date.UTC(2025, 4, 1), end]);
  for (let i = 1; i < parts.length; i += 1) assert.equal(parts[i - 1][1], parts[i][0], "子窗口必须连续无空洞");
  // 每个月度窗口自身仍可继续细分（兜底链：月→日→二分）
  assert.ok(splitWindow(parts[0][0], parts[0][1]) !== null);
});

test("mergeTrackPoints dedupes by business key, sorts by time, drops invalid points", () => {
  const base = { mmsi: "123", lon: 100, lat: 30, speedKn: 5, courseDeg: 90, heading: 90, navStatus: "Underway" };
  const p1 = { ...base, time: "2026-07-01T00:00:00.000Z" };
  const p1dup = { ...base, time: "2026-07-01T00:00:00.000Z" };
  const p2 = { ...base, time: "2026-06-01T00:00:00.000Z" };
  const noCoord = { ...base, time: "2026-05-01T00:00:00.000Z", lat: null };
  const noTime = { ...base, time: "not-a-time" };
  const merged = mergeTrackPoints([p1], [p1dup, p2, noCoord, noTime]);
  assert.deepEqual(merged.map((p) => p.time), [p2.time, p1.time], "去重后按时间升序");
});

test("trackPointKey distinguishes different positions at the same time", () => {
  const base = { mmsi: "123", time: "2026-07-01T00:00:00.000Z", lon: 100, lat: 30, speedKn: 5, courseDeg: 90, heading: 90, navStatus: "Underway" };
  assert.notEqual(trackPointKey(base), trackPointKey({ ...base, lon: 101 }));
  assert.equal(trackPointKey(base), trackPointKey({ ...base }));
});

test("mergeTrackPoints handles null/empty inputs", () => {
  assert.deepEqual(mergeTrackPoints(null, undefined), []);
});
