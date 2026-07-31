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
  assert.equal(result.relations[0].lag.distanceSeriesSource, "observed");
});

test("原始 AIS 报点稀疏时仍保留插值对齐距离图表数据", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: {
      USV: points({ mmsi: "USV", startMs, offsetMs: 8 * 24 * 60 * 60_000 }),
      CVN: [
        { mmsi: "CVN", time: new Date(startMs - 10 * 60_000).toISOString(), lon: 119.99, lat: 20, speedKn: 5, heading: 90 },
        { mmsi: "CVN", time: new Date(startMs + 10 * 60_000).toISOString(), lon: 120.01, lat: 20, speedKn: 5, heading: 90 },
      ],
    },
  });
  assert.equal(result.relations[0].relationType, "时延跟随");
  assert.equal(result.relations[0].lag.distanceSeriesSource, "interpolated");
  assert.equal(result.relations[0].lag.distanceSeries.length, 8);
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

test("命中时延关联时下发抽稀航迹序列并计算中位距离与阈值内比例", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const result = analyzeVesselCarrierRelations({
    vessels: [{ mmsi: "USV", name: "USV" }, { mmsi: "CVN", name: "CVN", role: "航母" }],
    carriers: [{ mmsi: "CVN", name: "CVN", role: "航母" }],
    tracksByMmsi: { USV: points({ mmsi: "USV", startMs, offsetMs: 8 * 24 * 60 * 60_000 }), CVN: points({ mmsi: "CVN", startMs }) },
  });
  const relation = result.associationsByMmsi.USV.carriers[0];
  assert.equal(relation.relationType, "时延跟随");
  // 中位距离与阈值内比例均由本轮判定已计算的距离聚合，与 select0721.py 口径一致。
  assert.equal(typeof relation.lag.medianDistanceNm, "number");
  assert.ok(relation.lag.medianDistanceNm >= 0);
  assert.equal(typeof relation.lag.withinThresholdRatio, "number");
  assert.ok(relation.lag.withinThresholdRatio >= 0 && relation.lag.withinThresholdRatio <= 1);
  // 命中关联才下发双方抽稀航迹，仅含时间/经纬度，且数量受限（<=90）控制响应体积。
  assert.ok(Array.isArray(relation.referenceTrackSeries) && relation.referenceTrackSeries.length >= 2);
  assert.ok(Array.isArray(relation.carrierTrackSeries) && relation.carrierTrackSeries.length >= 2);
  assert.ok(relation.referenceTrackSeries.length <= 60);
  assert.ok(relation.carrierTrackSeries.length <= 60);
  assert.deepEqual(Object.keys(relation.referenceTrackSeries[0]).sort(), ["lat", "lon", "time"]);
  assert.equal(relation.referenceTrackSeries[0].lat, 20);
  assert.ok(Number.isFinite(relation.referenceTrackSeries[0].lon));
});

test("超量 AIS 轨迹抽稀后航迹序列不超过上限", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const bigTrack = Array.from({ length: 200 }, (_, index) => ({
    mmsi: "USV", time: new Date(startMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.001, lat: 20 + index * 0.0005, speedKn: 5, heading: 90,
  }));
  const result = analyzeVesselCarrierRelations({
    vessels: [{ mmsi: "USV", name: "USV" }, { mmsi: "CVN", name: "CVN", role: "航母" }],
    carriers: [{ mmsi: "CVN", name: "CVN", role: "航母" }],
    tracksByMmsi: { USV: bigTrack, CVN: bigTrack },
  });
  const relation = result.associationsByMmsi.USV.carriers[0];
  if (relation.relationType !== "未命中") {
    assert.ok(relation.referenceTrackSeries.length <= 60);
    assert.ok(relation.carrierTrackSeries.length <= 60);
  }
});

test("未命中关联不下发航迹序列，中位距离与阈值内比例为空", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const result = analyzeVesselCarrierRelations({
    vessels: [{ mmsi: "USV", name: "USV" }, { mmsi: "CVN", name: "CVN", role: "航母" }],
    carriers: [{ mmsi: "CVN", name: "CVN", role: "航母" }],
    // 时间窗口相距 35 天（超过 30 天 lagMax），任何时延都无时间交集 -> 未命中且 best 为空。
    tracksByMmsi: { USV: points({ mmsi: "USV", startMs }), CVN: points({ mmsi: "CVN", startMs, lon: 120.01, offsetMs: 35 * 24 * 60 * 60_000 }) },
  });
  const relation = result.associationsByMmsi.USV.carriers[0];
  assert.equal(relation.relationType, "未命中");
  assert.equal(relation.referenceTrackSeries, undefined);
  assert.equal(relation.carrierTrackSeries, undefined);
  assert.equal(relation.lag.medianDistanceNm, null);
  assert.equal(relation.lag.withinThresholdRatio, null);
});
