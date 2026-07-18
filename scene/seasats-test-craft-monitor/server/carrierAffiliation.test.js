import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCarrierAffiliations, analyzeVesselCarrierRelations } from "./carrierAffiliation.js";

function points({ mmsi, startMs, offsetMs = 0, lon = 120, lat = 20 }) {
  return Array.from({ length: 8 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: lon + index * 0.001,
    lat,
    speedKn: 5,
    heading: 90,
  }));
}

test("按 Python 阈值识别同步伴随", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: points({ mmsi: "USV", startMs }), CVN: points({ mmsi: "CVN", startMs, lon: 120.01 }) },
  });
  assert.equal(result.relations[0].relationType, "同步伴随");
  assert.equal(result.relations[0].sync.matchedPoints, 8);
  assert.ok(result.relations[0].sync.minimumDistanceNm > 0);
});

test("按 Python 的 24 小时时延步长识别候选舰船领先的时延跟随", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: points({ mmsi: "USV", startMs, offsetMs: 8 * 24 * 60 * 60_000 }), CVN: points({ mmsi: "CVN", startMs }) },
  });
  assert.equal(result.relations[0].relationType, "时延跟随");
  assert.equal(result.relations[0].lag.lagMinutes, 8 * 24 * 60);
  assert.equal(result.relations[0].lag.distanceSeries.length, 8);
  // 两条轨迹可完全重合，仅时间偏移，因此最小距离允许为 0。
  assert.equal(result.relations[0].lag.minimumDistanceNm, 0);
});

test("为每艘非航母舰艇保存其与候选航母的历史关联", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const result = analyzeVesselCarrierRelations({
    vessels: [{ mmsi: "USV", name: "USV" }, { mmsi: "CVN", name: "CVN", role: "航母" }],
    carriers: [{ mmsi: "CVN", name: "CVN", role: "航母" }],
    tracksByMmsi: { USV: points({ mmsi: "USV", startMs }), CVN: points({ mmsi: "CVN", startMs, lon: 120.01 }) },
  });
  assert.equal(result.associationsByMmsi.USV.carriers[0].relationType, "同步伴随");
  assert.equal(result.associationsByMmsi.CVN.status, "carrier");
  assert.equal(result.associationsByMmsi.USV.reference.mmsi, "USV");
});
