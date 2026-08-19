import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCarrierAffiliations, analyzeVesselCarrierRelations, cleanTrack, courseDifference, resolveAnalysisHeading } from "./carrierAffiliation.js";

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

test("按 0721 粗扫+细扫识别候选舰船领先的时延跟随", () => {
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
  // 与 0721 一致：距离曲线恒为判定采用的插值对齐序列。
  assert.equal(result.relations[0].lag.distanceSeriesSource, "interpolated");
});

test("细扫以 1 小时精度定位非整天时延（与 0721 一致）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  // 真实时延 8 天 5 小时，不在 24 小时粗扫网格上；只有细扫能精确定位。
  const lagMs = (8 * 24 + 5) * 60 * 60_000;
  const mkTrack = (mmsi, offsetMs) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 3 * 60 * 60_000).toISOString(),
    // 二次曲线机动：偏离真实时延的插值必有误差，保证细扫能严格优于粗扫。
    lon: 120 + 0.01 * index * index,
    lat: 20,
    speedKn: 5,
    heading: 90,
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs), CVN: mkTrack("CVN", 0) },
  });
  assert.equal(result.relations[0].relationType, "时延跟随");
  assert.equal(result.relations[0].lag.lagMinutes, (8 * 24 + 5) * 60);
});

test("阈值内占比低于 70% 的时延按 0721 门槛弃用", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = 8 * 24 * 60 * 60_000;
  // 10 个匹配点中 5 个重合、5 个相距约 560 海里：平均距离约 282nm 过 500nm 阈值，
  // 但阈值内占比仅 50% < 70%，按 0721 的 localRatioThresh 该时延必须弃用。
  const mkTrack = (mmsi, offsetMs, farOffset) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.0001 + (index >= 5 ? farOffset : 0),
    lat: 20,
    speedKn: 5,
    heading: 90,
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs, 10), CVN: mkTrack("CVN", 0, 0) },
  });
  assert.equal(result.relations[0].relationType, "未发现满足阈值的关联");
  assert.equal(result.relations[0].lag.matched, false);
});

test("航向筛选后不足 8 个匹配点的时延按 0721 作废（不回退全部点）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = 8 * 24 * 60 * 60_000;
  // 10 个重合点中 7 个双方航向一致、3 个航母航向相反：45° 筛选后仅 7 点 < minMatchedPoints。
  // 旧逻辑会回退到全部 10 点命中；0721 口径下该时延直接作废。
  const mkTrack = (mmsi, offsetMs, headingFor) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.001,
    lat: 20,
    speedKn: 5,
    heading: headingFor(index),
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs, () => 90), CVN: mkTrack("CVN", 0, (index) => (index < 7 ? 90 : 270)) },
  });
  assert.equal(result.relations[0].relationType, "未发现满足阈值的关联");
  assert.equal(result.relations[0].lag.matched, false);
});

test("航向按 0721 unwrap：0°/360° 跨界插值不产生假跳变", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = 8 * 24 * 60 * 60_000;
  // 双方航向从 355° 平滑越过 0°；无人艇报点错开 30 秒，使航母航向必须插值。
  // 未 unwrap 时 359° 与 1° 的插值结果约 180°，会产生 ~179° 假差值把该点筛掉。
  const headings = [355, 356, 357, 358, 359, 1, 2, 3, 4, 5];
  const mkTrack = (mmsi, offsetMs, extraPoint = false) => {
    const list = headings.map((heading, index) => ({
      mmsi,
      time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
      lon: 120 + index * 0.001,
      lat: 20,
      speedKn: 5,
      heading,
    }));
    // 航母轨迹多补一个尾点，确保错开 30 秒的无人艇末点仍落在插值区间内。
    if (extraPoint) list.push({ mmsi, time: new Date(startMs + offsetMs + headings.length * 60_000).toISOString(), lon: 120 + headings.length * 0.001, lat: 20, speedKn: 5, heading: 6 });
    return list;
  };
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs + 30_000), CVN: mkTrack("CVN", 0, true) },
  });
  const relation = result.relations[0];
  assert.equal(relation.relationType, "时延跟随");
  assert.equal(relation.lag.courseFilterApplied, true);
  // unwrap 后跨界点插值正确，10 个匹配点全部通过 45° 筛选。
  assert.equal(relation.lag.matchedPoints, 10);
});

test("距离曲线恒为判定采用的插值对齐序列（0721 口径）", () => {
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

test("courseDifference 取模后始终落在 [0,180]（unwrap 大漂移不产生负值）", () => {
  // 883° 漂移：%360 = 163°（旧公式 360-883 = -523，会错误通过 45° 筛选）。
  assert.equal(courseDifference(0, 883), 163);
  assert.equal(courseDifference(883, 0), 163);
  assert.equal(courseDifference(350, 10), 20);
  assert.equal(courseDifference(0, 370), 10);
  assert.equal(courseDifference(0, 540), 180);
  assert.equal(courseDifference(0, 181), 179);
  assert.equal(courseDifference(-10, 350), 0);
});

// === 2026-08-15 客户确认的数据规则 ===

test("同一秒多条不同毫秒记录保留输入顺序第一条（截断到秒，不四舍五入）", () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const track = cleanTrack([
    // 输入顺序在前但时间戳更大：排序按 (秒, sourceIndex)，同秒必须保留输入第一条。
    { time: new Date(base + 400).toISOString(), lon: 121, lat: 21, heading: 100 },
    { time: new Date(base + 100).toISOString(), lon: 120, lat: 20, heading: 90 },
    { time: new Date(base + 1500).toISOString(), lon: 122, lat: 22, heading: 110 },
  ]);
  assert.equal(track.length, 2);
  assert.equal(track[0].timeMs, base);
  assert.equal(track[0].lon, 121);
  assert.equal(track[0].heading, 100);
  assert.equal(track[1].timeMs, base + 1000);
});

test("同一毫秒重复记录保留输入第一条", () => {
  const base = Date.UTC(2026, 0, 1);
  const track = cleanTrack([
    { time: new Date(base).toISOString(), lon: 120, lat: 20, heading: 90 },
    { time: new Date(base).toISOString(), lon: 121, lat: 21, heading: 100 },
  ]);
  assert.equal(track.length, 1);
  assert.equal(track[0].lon, 120);
});

test("航向字段优先级沿用修改前生产版本：heading 优先，null/undefined 才兜底 courseDeg", () => {
  // heading 有效：直接使用，即使 courseDeg 不同也不用它。
  assert.equal(resolveAnalysisHeading({ heading: 90, courseDeg: 200 }), 90);
  // heading 为 null/undefined：按旧版 ?? 语义兜底 courseDeg。
  assert.equal(resolveAnalysisHeading({ heading: null, courseDeg: 200 }), 200);
  assert.equal(resolveAnalysisHeading({ courseDeg: 200 }), 200);
  // 两侧都缺失：航向缺失。
  assert.equal(resolveAnalysisHeading({ heading: null, courseDeg: null }), null);
  assert.equal(resolveAnalysisHeading({}), null);
  // 字符串数值按旧版 finite 语义可解析。
  assert.equal(resolveAnalysisHeading({ heading: "88.5" }), 88.5);
});

test("客户缺失规则作用于解析结果：511/空串/非数值视为该点航向缺失（不因 511 触发兜底）", () => {
  // 511 为 AIS“不可用”标记：解析结果为 511 时直接缺失；旧版 ?? 优先级保持不变（511 非空，不回退 courseDeg）。
  assert.equal(resolveAnalysisHeading({ heading: 511, courseDeg: 200 }), null);
  assert.equal(resolveAnalysisHeading({ heading: "511" }), null);
  // 空串/非数值同样缺失。
  assert.equal(resolveAnalysisHeading({ heading: "" }), null);
  assert.equal(resolveAnalysisHeading({ heading: "abc" }), null);
  assert.equal(resolveAnalysisHeading({ heading: NaN }), null);
  assert.equal(resolveAnalysisHeading({ heading: Infinity }), null);
  // courseDeg 兜底值同样受缺失规则约束。
  assert.equal(resolveAnalysisHeading({ heading: null, courseDeg: 511 }), null);
  assert.equal(resolveAnalysisHeading({ heading: null, courseDeg: "" }), null);
});

test("heading 为 511 时按旧版优先级不兜底 courseDeg（cleanTrack 集成）", () => {
  const base = Date.UTC(2026, 0, 1);
  const track = cleanTrack([
    { time: new Date(base).toISOString(), lon: 120, lat: 20, heading: 511, courseDeg: 90 },
    { time: new Date(base + 60_000).toISOString(), lon: 120.001, lat: 20, heading: null, courseDeg: 90 },
    { time: new Date(base + 120_000).toISOString(), lon: 120.002, lat: 20, heading: 90, courseDeg: 90 },
  ]);
  // 511 视为缺失（不回退）；heading 缺失时 courseDeg 兜底生效；heading 有效直接使用。
  assert.deepEqual(track.map((point) => point.heading), [null, 90, 90]);
});

test("heading 为 511（AIS 不可用标记）视为航向缺失", () => {
  const base = Date.UTC(2026, 0, 1);
  const track = cleanTrack([
    { time: new Date(base).toISOString(), lon: 120, lat: 20, heading: 511 },
    { time: new Date(base + 60_000).toISOString(), lon: 120.001, lat: 20, heading: "511" },
    { time: new Date(base + 120_000).toISOString(), lon: 120.002, lat: 20, heading: 90 },
  ]);
  assert.deepEqual(track.map((point) => point.heading), [null, null, 90]);
});

test("unwrap 严格 180° 边界：±180° 不翻转，仅严格大于 180° 才跨界修正", () => {
  const base = Date.UTC(2026, 0, 1);
  const mk = (headings) => headings.map((heading, index) => ({
    time: new Date(base + index * 60_000).toISOString(), lon: 120, lat: 20, heading,
  }));
  // 0 → 180：差值恰好 +180，不翻转。
  assert.deepEqual(cleanTrack(mk([0, 180])).map((point) => point.heading), [0, 180]);
  // 180 → 0：差值恰好 -180，不翻转。
  assert.deepEqual(cleanTrack(mk([180, 0])).map((point) => point.heading), [180, 0]);
  // 0 → 181：差值严格大于 180，修正为 -179 方向。
  assert.deepEqual(cleanTrack(mk([0, 181])).map((point) => point.heading), [0, -179]);
  // 359 → 0：跨界连续展开为 360。
  assert.deepEqual(cleanTrack(mk([359, 0])).map((point) => point.heading), [359, 360]);
});

test("unwrap 跳过缺失点，航向恢复后与前一个有效值衔接（缺失后跨界恢复）", () => {
  const base = Date.UTC(2026, 0, 1);
  const track = cleanTrack([10, null, 350].map((heading, index) => ({
    time: new Date(base + index * 60_000).toISOString(), lon: 120, lat: 20, heading,
  })));
  // 中间点缺失不参与 unwrap；恢复点 350 与前一有效值 10 衔接：差值 340>180，修正为 -20 方向。
  assert.deepEqual(track.map((point) => point.heading), [10, null, -10]);
});

test("航向中间缺失后恢复，恢复点重新参与 45° 筛选（缺失点保留）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = 8 * 24 * 60 * 60_000;
  // 10 个重合点：航母 4 点航向一致 + 2 点缺失(511) + 恢复后 4 点航向相反。
  // 恢复点必须参与筛选（被筛掉），缺失点保留：采用点数 4+2=6 < 8，该时延作废。
  const mkTrack = (mmsi, offsetMs, headingFor) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.001,
    lat: 20,
    speedKn: 5,
    heading: headingFor(index),
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: {
      USV: mkTrack("USV", lagMs, () => 90),
      CVN: mkTrack("CVN", 0, (index) => (index < 4 ? 90 : index < 6 ? 511 : 270)),
    },
  });
  assert.equal(result.relations[0].relationType, "未发现满足阈值的关联");
});

test("可判定航向点不足 3 个时不执行航向筛选（0721 口径）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = 8 * 24 * 60 * 60_000;
  // 航母仅 2 点航向有效且与无人艇相反，其余 8 点为 511：eligible=2<3，不筛选，10 点全部保留命中。
  const mkTrack = (mmsi, offsetMs, headingFor) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.001,
    lat: 20,
    speedKn: 5,
    heading: headingFor(index),
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: {
      USV: mkTrack("USV", lagMs, () => 90),
      CVN: mkTrack("CVN", 0, (index) => (index < 2 ? 270 : 511)),
    },
  });
  const relation = result.relations[0];
  assert.equal(relation.relationType, "时延跟随");
  assert.equal(relation.lag.courseFilterApplied, false);
  assert.equal(relation.lag.matchedPoints, 10);
});

test("任一整条轨迹经旧版字段优先级解析后无有效航向时不进行该配对分析", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const noOrientation = (mmsi, offsetMs = 0) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.001,
    lat: 20,
    speedKn: 5,
    heading: 511,
  }));
  // 无人艇整轨 511：未分析。
  const byVessel = analyzeVesselCarrierRelations({
    vessels: [{ mmsi: "USV", name: "USV" }, { mmsi: "CVN", name: "CVN", role: "航母" }],
    carriers: [{ mmsi: "CVN", name: "CVN", role: "航母" }],
    tracksByMmsi: { USV: noOrientation("USV"), CVN: points({ mmsi: "CVN", startMs }) },
  });
  const relV = byVessel.associationsByMmsi.USV.carriers[0];
  assert.equal(relV.relationType, "未分析");
  assert.equal(relV.reason, "insufficient_heading_data");
  assert.equal(relV.referenceTrackSeries, undefined);
  assert.equal(relV.carrierTrackSeries, undefined);
  // 航母整轨无航向（字段整体缺失）：同样未分析。
  const noField = Array.from({ length: 10 }, (_, index) => ({
    mmsi: "CVN",
    time: new Date(startMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.001,
    lat: 20,
    speedKn: 5,
  }));
  const byCarrier = analyzeVesselCarrierRelations({
    vessels: [{ mmsi: "USV", name: "USV" }, { mmsi: "CVN", name: "CVN", role: "航母" }],
    carriers: [{ mmsi: "CVN", name: "CVN", role: "航母" }],
    tracksByMmsi: { USV: points({ mmsi: "USV", startMs }), CVN: noField },
  });
  assert.equal(byCarrier.associationsByMmsi.USV.carriers[0].relationType, "未分析");
  // analyzeCarrierAffiliations 入口同样遵守。
  const byPair = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: noOrientation("USV"), CVN: points({ mmsi: "CVN", startMs }) },
  });
  assert.equal(byPair.relations[0].relationType, "未分析");
  assert.equal(byPair.relations[0].reason, "insufficient_heading_data");
});

test("阈值内占比恰好 0.70 时通过（严格边界：>=0.70）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = 8 * 24 * 60 * 60_000;
  // 10 个点中 7 个重合、3 个相距约 560 海里（>500）：ratio = 7/10 = 0.70 恰好过线；
  // 平均距离约 169 海里 < 500。7/10 与字面量 0.7 是同一个 double，边界成立。
  const mkTrack = (mmsi, offsetMs, farOffset) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.0001 + (index >= 7 ? farOffset : 0),
    lat: 20,
    speedKn: 5,
    heading: 90,
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs, 10), CVN: mkTrack("CVN", 0, 0) },
  });
  const relation = result.relations[0];
  assert.equal(relation.relationType, "时延跟随");
  assert.equal(relation.lag.withinThresholdRatio, 0.7);
  assert.equal(relation.lag.matchedPoints, 10);
});

test("平均距离达到 500 海里阈值时弃用（严格小于才算命中）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = 8 * 24 * 60 * 60_000;
  // 8 个重合点 + 2 个远点：ratio=0.8 过占比门槛；远点约 2587 海里时平均距离约 517>500，必须弃用；
  // 远点约 2280 海里时平均距离约 456<500，命中。两组对照验证平均距离门槛独立生效。
  const mkTrack = (mmsi, offsetMs, farOffset) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.0001 + (index >= 8 ? farOffset : 0),
    lat: 20,
    speedKn: 5,
    heading: 90,
  }));
  const rejected = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs, 46), CVN: mkTrack("CVN", 0, 0) },
  });
  assert.equal(rejected.relations[0].relationType, "未发现满足阈值的关联");
  const accepted = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs, 40.5), CVN: mkTrack("CVN", 0, 0) },
  });
  assert.equal(accepted.relations[0].relationType, "时延跟随");
  assert.ok(accepted.relations[0].lag.averageDistanceNm < 500);
});

test("同步伴随：航向缺失/低速点的航向相似度按 1 参与平均（0721 merge_asof 口径）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  // 8 个同步匹配点：4 个航向差 60°（cos=0.5）、4 个航母航向缺失（511）。
  // Python cos_sim 初始化全 1：平均值 = (4×0.5 + 4×1)/8 = 0.75；旧口径忽略后平均会得 0.5。
  const mkTrack = (mmsi, headingFor) => Array.from({ length: 8 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + index * 60_000).toISOString(),
    lon: 120 + index * 0.001,
    lat: 20,
    speedKn: 5,
    heading: headingFor(index),
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: {
      USV: mkTrack("USV", () => 90),
      CVN: mkTrack("CVN", (index) => (index < 4 ? 150 : 511)),
    },
  });
  const sync = result.relations[0].sync;
  assert.equal(sync.matchedPoints, 8);
  assert.ok(Math.abs(sync.averageCourseCosine - 0.75) < 1e-9, `期望 0.75，实际 ${sync.averageCourseCosine}`);
});

test("最终距离序列与统计来自细扫后的最终 best（非粗扫 best）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const lagMs = (8 * 24 + 5) * 60 * 60_000;
  const mkTrack = (mmsi, offsetMs) => Array.from({ length: 10 }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 3 * 60 * 60_000).toISOString(),
    lon: 120 + 0.01 * index * index,
    lat: 20,
    speedKn: 5,
    heading: 90,
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs), CVN: mkTrack("CVN", 0) },
  });
  const lag = result.relations[0].lag;
  assert.equal(lag.lagMinutes, (8 * 24 + 5) * 60);
  // 细扫精确定位后插值严格落在报点上：距离序列为全 0；若来自粗扫 best 则首点距离 >0。
  assert.equal(lag.distanceSeries.length, 10);
  assert.ok(lag.distanceSeries.every((item) => item.distanceNm === 0));
  assert.equal(lag.startTime, new Date(startMs + lagMs).toISOString());
  assert.equal(lag.matchedPoints, 10);
});

test("十五万点轨迹关联计算不抛 RangeError（无展开传参）", () => {
  const startMs = Date.UTC(2026, 0, 1);
  const count = 150_000;
  const lagMs = 8 * 24 * 60 * 60_000;
  const mkTrack = (mmsi, offsetMs) => Array.from({ length: count }, (_, index) => ({
    mmsi,
    time: new Date(startMs + offsetMs + index * 1000).toISOString(),
    lon: 120 + index * 0.0001,
    lat: 20,
    speedKn: 5,
    heading: 90,
  }));
  const result = analyzeCarrierAffiliations({
    reference: { mmsi: "USV" },
    candidates: [{ mmsi: "CVN", name: "CVN" }],
    tracksByMmsi: { USV: mkTrack("USV", lagMs), CVN: mkTrack("CVN", 0) },
  });
  const relation = result.relations[0];
  assert.equal(relation.relationType, "时延跟随");
  assert.equal(relation.lag.matchedPoints, count);
  assert.equal(relation.lag.distanceSeries.length, count);
  assert.equal(relation.lag.minimumDistanceNm, 0);
});
