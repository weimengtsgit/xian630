import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteMapUrl,
  DEFAULT_REPLAY_WINDOW,
  filterPayloadByReplayWindow,
  filterForFocusMode,
  resolveReplayWindow,
  toEpochSeconds,
} from "./playback.js";

test("toEpochSeconds converts supported inputs", () => {
  assert.equal(toEpochSeconds("2025-01-01T00:00:00Z"), 1735689600);
  assert.equal(toEpochSeconds(1735689600), 1735689600);
  assert.equal(toEpochSeconds(1735689600000), 1735689600);
  assert.equal(toEpochSeconds("bad"), null);
  assert.equal(toEpochSeconds(null), null);
  assert.equal(toEpochSeconds(undefined), null);
  assert.equal(toEpochSeconds(""), null);
});

test("resolveReplayWindow prefers selected target track window", () => {
  const selectedTarget = {
    segments: [
      { startTime: "2025-01-02T00:00:00Z", endTime: "2025-01-03T00:00:00Z" },
      { startTime: "2025-01-01T00:00:00Z", endTime: "2025-01-04T00:00:00Z" },
    ],
  };
  const metadata = {
    dataWindow: {
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-02T00:00:00Z",
    },
  };

  assert.deepEqual(resolveReplayWindow({ selectedTarget, metadata }), {
    start: 1735689600,
    end: 1735948800,
    source: "selected-target",
  });
});

test("resolveReplayWindow accepts top-level selected target points", () => {
  const selectedTarget = {
    points: [
      { time: "2025-01-03T00:00:00Z" },
      { time: "2025-01-01T00:00:00Z" },
    ],
  };

  assert.deepEqual(
    resolveReplayWindow({
      selectedTarget,
      metadata: { dataWindow: { start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" } },
    }),
    { start: 1735689600, end: 1735862400, source: "selected-target" }
  );
});

test("resolveReplayWindow falls back to metadata then fixed window", () => {
  assert.deepEqual(
    resolveReplayWindow({
      selectedTarget: {},
      metadata: { dataWindow: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" } },
    }),
    { start: 1767225600, end: 1767312000, source: "metadata" }
  );

  assert.deepEqual(resolveReplayWindow({ selectedTarget: {}, metadata: {} }), {
    start: 1764954060,
    end: 1784131200,
    source: "fallback",
  });
});

test("resolveReplayWindow can force the configured playback window", () => {
  assert.deepEqual(
    resolveReplayWindow({
      forceFallback: true,
      selectedTarget: {
        points: [
          { time: "2025-01-01T00:00:00Z" },
          { time: "2025-01-02T00:00:00Z" },
        ],
      },
      metadata: { dataWindow: { start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" } },
    }),
    { ...DEFAULT_REPLAY_WINDOW, source: "fallback" }
  );
});

test("buildRemoteMapUrl encodes mmsi and replay window", () => {
  assert.equal(
    buildRemoteMapUrl({
      baseUrl: "http://218.61.33.200:18000/",
      mmsi: "338414915",
      startTime: DEFAULT_REPLAY_WINDOW.start,
      endTime: DEFAULT_REPLAY_WINDOW.end,
    }),
    "http://218.61.33.200:18000/?mmsi=338414915&start_time=1764954060&end_time=1784131200"
  );

  assert.equal(
    buildRemoteMapUrl({
      baseUrl: "http://218.61.33.200:18000/?foo=bar&mmsi=old",
      mmsi: "338414915",
      startTime: DEFAULT_REPLAY_WINDOW.start * 1000,
      endTime: DEFAULT_REPLAY_WINDOW.end * 1000,
    }),
    "http://218.61.33.200:18000/?foo=bar&mmsi=338414915&start_time=1764954060&end_time=1784131200"
  );
});

test("filterPayloadByReplayWindow keeps only track points inside the configured time window", () => {
  const payload = {
    metadata: { dataWindow: { start: "old", end: "old" } },
    targets: [{ mmsi: "338414915" }],
    trackPoints: [
      { mmsi: "338414915", time: "2025-12-05T17:00:59Z", speedKn: 1 },
      { mmsi: "338414915", time: "2025-12-05T17:01:00Z", speedKn: 2 },
      { mmsi: "338414915", time: "2026-06-23T18:00:06Z", speedKn: 3 },
      { mmsi: "338414915", time: "2026-06-23T18:00:07Z", speedKn: 4 },
      { mmsi: "other", time: "2026-01-01T00:00:00Z", speedKn: 5 },
    ],
  };

  const filtered = filterPayloadByReplayWindow(payload, DEFAULT_REPLAY_WINDOW);

  assert.deepEqual(filtered.trackPoints.map((point) => point.speedKn), [2, 3, 4, 5]);
  assert.equal(filtered.metadata.dataWindow.start, "2025-12-05T17:01:00.000Z");
  assert.equal(filtered.metadata.dataWindow.end, "2026-07-15T16:00:00.000Z");
  assert.equal(payload.trackPoints.length, 5);
});

test("filterForFocusMode keeps only selected vessel data when focus mode is enabled", () => {
  const analysis = {
    targets: [{ mmsi: "1" }, { mmsi: "2" }],
    alerts: [{ id: "a", targetMmsi: "1" }, { id: "b", targetMmsi: "2" }],
    segments: [{ id: "s1", targetMmsi: "1" }, { id: "s2", targetMmsi: "2" }],
    aisGaps: [{ id: "g1", targetMmsi: "1" }, { id: "g2", targetMmsi: "2" }],
  };

  const focused = filterForFocusMode({ analysis, selectedMmsi: "1", focusOnly: true });
  assert.deepEqual(focused.targets.map((item) => item.mmsi), ["1"]);
  assert.deepEqual(focused.alerts.map((item) => item.id), ["a"]);
  assert.deepEqual(focused.segments.map((item) => item.id), ["s1"]);
  assert.deepEqual(focused.aisGaps.map((item) => item.id), ["g1"]);

  const all = filterForFocusMode({ analysis, selectedMmsi: "1", focusOnly: false });
  assert.equal(all.targets.length, 2);
  assert.deepEqual(all.alerts.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(all.segments.map((item) => item.id), ["s1", "s2"]);
  assert.deepEqual(all.aisGaps.map((item) => item.id), ["g1", "g2"]);
});
