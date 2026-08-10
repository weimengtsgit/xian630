import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary } from "./summary.js";

const PARAMS = { coastAlertRangeNm: 200, coastAlertHighNm: 80 };

test("buildSummary threat=none when nothing happens", () => {
  const s = buildSummary({ targets: [], alerts: [], aisGaps: [] }, PARAMS);
  assert.equal(s.threatLevel, "none");
  assert.ok(Array.isArray(s.findings));
});

test("uses the Chinese-preferred display name in expanded analysis narrative", () => {
  const summary = buildSummary({
    targets: [{ mmsi: "368926574", name: "SEAHAWK", rightDisplayName: "海鹰号", hasObservedTrack: true, reportCount: 12, activeDays: 2, minCoastDistanceNm: 300 }],
    alerts: [],
    aisGaps: [],
  }, PARAMS);
  assert.match(summary.narrative, /海鹰号/);
  assert.doesNotMatch(summary.narrative, /SEAHAWK/);
});

test("buildSummary threat=critical on coast high", () => {
  const analysis = {
    targets: [{ mmsi: "X", name: "SEASATS 1", minCoastDistanceNm: 50, status: "异常行为舰艇", score: 90 }],
    alerts: [{ type: "coast-proximity", level: "high", severity: "critical", targetName: "SEASATS 1", summary: "距海岸 50 海里" }],
    aisGaps: [],
  };
  const s = buildSummary(analysis, PARAMS);
  assert.equal(s.threatLevel, "critical");
  assert.ok(s.advice.length > 0);
});

test("buildSummary threat=high on coast medium", () => {
  const analysis = {
    targets: [{ mmsi: "X", name: "SEASATS 2", minCoastDistanceNm: 100, status: "待核验舰艇", score: 50 }],
    alerts: [{ type: "coast-proximity", level: "medium", severity: "warning", targetName: "SEASATS 2", summary: "距海岸 100 海里" }],
    aisGaps: [],
  };
  const s = buildSummary(analysis, PARAMS);
  assert.equal(s.threatLevel, "high");
});

test("buildSummary surfaces ais-gap count in findings", () => {
  const analysis = {
    targets: [{ mmsi: "X", name: "SEASATS 3", minCoastDistanceNm: null, status: "高可信舰艇", score: 60 }],
    alerts: [{ type: "ais-gap", severity: "critical", summary: "缺口 400 分钟" }],
    aisGaps: [{ id: "g1" }],
  };
  const s = buildSummary(analysis, PARAMS);
  assert.ok(s.findings.some((f) => /AIS/i.test(f.label) || /AIS/i.test(String(f.value))));
});

test("buildSummary formats long AIS gap duration as days and hours", () => {
  const s = buildSummary({
    targets: [{
      mmsi: "X",
      name: "SEASATS 55",
      status: "异常行为舰艇",
      score: 90,
      hasObservedTrack: true,
      reportCount: 300,
      activeDays: 42,
    }],
    alerts: [],
    aisGaps: [{ id: "g1", gapMinutes: 4166, severity: "critical" }],
  }, PARAMS);

  assert.match(s.narrative, /2天21小时26分钟/);
  assert.doesNotMatch(s.narrative, /4166\s*分钟/);
});
