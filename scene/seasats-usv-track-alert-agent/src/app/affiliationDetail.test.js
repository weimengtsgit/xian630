import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".jsx")) {
      return {
        format: "module",
        shortCircuit: true,
        source: readFileSync(fileURLToPath(url), "utf8"),
      };
    }
    return nextLoad(url, context);
  },
});

const {
  AffiliationDetailDialog,
  formatLagDays,
  affiliationDetailKey,
  buildAffiliationSummary,
  buildAffiliationAssessment,
  reduceActiveAffiliationKey,
  isDialogMaskClick,
  trapDialogFocus,
  trackSourceNote,
} = await import("./VesselFocusPanel.jsx");
const { decimateTrackForRender, decimateDistanceForRender, buildTrackRenderSeries, RENDER_POINT_LIMIT } = await import("../logic/renderDecimation.js");

const lagRelation = {
  carrier: { mmsi: "366984000", name: "CVN-71" },
  relationType: "时延跟随",
  lag: {
    lagMinutes: 19008, averageDistanceNm: 21.9, minimumDistanceNm: 1.3, medianDistanceNm: 18.5,
    withinThresholdRatio: 0.75, matchedPoints: 48, courseFilterApplied: true, maxCourseDifferenceDeg: 12,
    startTime: "2026-07-13T16:00:00.000Z", endTime: "2026-07-16T02:57:00.000Z",
    distanceSeriesSource: "interpolated",
    distanceSeries: [
      { time: "2026-07-13T16:00:00.000Z", distanceNm: 564.6 },
      { time: "2026-07-14T16:00:00.000Z", distanceNm: 80 },
      { time: "2026-07-15T16:00:00.000Z", distanceNm: 6.2 },
      { time: "2026-07-16T02:57:00.000Z", distanceNm: 12.4 },
    ],
  },
  referenceTrackSeries: [
    { time: "2026-07-13T16:00:00.000Z", lon: 120.1, lat: 20.1 },
    { time: "2026-07-14T16:00:00.000Z", lon: 120.5, lat: 20.3 },
    { time: "2026-07-15T16:00:00.000Z", lon: 121.0, lat: 20.6 },
  ],
  carrierTrackSeries: [
    { time: "2026-07-13T16:00:00.000Z", lon: 119.9, lat: 20.0 },
    { time: "2026-07-14T16:00:00.000Z", lon: 120.4, lat: 20.2 },
    { time: "2026-07-15T16:00:00.000Z", lon: 120.9, lat: 20.5 },
  ],
};

function renderDialog(props = {}) {
  return renderToStaticMarkup(React.createElement(AffiliationDetailDialog, {
    relation: lagRelation,
    name: "西奥多·罗斯福号",
    followerName: "海猎号",
    followerCode: undefined,
    index: 1,
    snapshotTime: "2026-07-18 15:41:01",
    onClose: () => {},
    closeRef: { current: null },
    onMaskClick: () => {},
    ...props,
  }));
}

// === 纯逻辑：时延天数格式化 ===
test("formatLagDays renders two-decimal days for valid lags", () => {
  assert.equal(formatLagDays(18480), "12.83天");
  assert.equal(formatLagDays(19008), "13.20天");
  assert.equal(formatLagDays(120), "0.08天");
});

test("formatLagDays renders 时延未知 for invalid or missing lags without NaN", () => {
  for (const value of [null, undefined, NaN, Infinity, "abc", Number.NaN]) {
    assert.equal(formatLagDays(value), "时延未知");
  }
  assert.doesNotMatch(formatLagDays(NaN), /NaN/);
});

// === 纯逻辑：稳定唯一 key ===
test("affiliationDetailKey is stable for the same relation and unique across relations", () => {
  const base = { selectedMmsi: "413000630", otherMmsi: "366984000", relationType: "时延跟随", lagMinutes: 19008 };
  assert.equal(affiliationDetailKey(base), affiliationDetailKey({ ...base }));
  assert.notEqual(
    affiliationDetailKey(base),
    affiliationDetailKey({ ...base, otherMmsi: "368913000" }),
  );
  assert.notEqual(
    affiliationDetailKey(base),
    affiliationDetailKey({ ...base, lagMinutes: 41760 }),
  );
  // 同步伴随没有有效时延，key 以 nolag 占位，仍可与跟随区分。
  assert.equal(
    affiliationDetailKey({ selectedMmsi: "413000630", otherMmsi: "366984000", relationType: "同步伴随", lagMinutes: null }),
    "413000630::366984000::同步伴随::nolag",
  );
});

// === 纯逻辑：摘要文案 ===
test("buildAffiliationSummary produces the lag sentence with the existing relationship direction", () => {
  const summary = buildAffiliationSummary({ relation: lagRelation, name: "西奥多·罗斯福号", followerName: "海猎号", followerCode: undefined });
  assert.equal(summary.relationship, "西奥多·罗斯福号 跟随 海猎号 无人艇");
  assert.match(summary.sentence, /海猎号 无人艇 与 西奥多·罗斯福号.*存在中等强度关联，关系为 西奥多·罗斯福号.*跟随 海猎号 无人艇，时延13\.20天。/);
});

test("buildAffiliationSummary produces a sync sentence without a faked lag", () => {
  const syncRelation = { relationType: "同步伴随", lag: { lagMinutes: null } };
  const summary = buildAffiliationSummary({ relation: syncRelation, name: "CVN-71", followerName: "海猎号", followerCode: undefined });
  assert.match(summary.sentence, /关系为 海猎号 无人艇 与 CVN-71 同步伴随。$/);
  assert.doesNotMatch(summary.sentence, /时延/);
});

test("buildAffiliationSummary treats a 0-day lag follow as sync, dropping 时延0天", () => {
  const zeroLagRelation = { ...lagRelation, lag: { ...lagRelation.lag, lagMinutes: 0 } };
  const summary = buildAffiliationSummary({ relation: zeroLagRelation, name: "西奥多·罗斯福号", followerName: "海猎号", followerCode: undefined });
  assert.match(summary.relationship, /海猎号 无人艇 与 西奥多·罗斯福号.*同步伴随/);
  assert.match(summary.sentence, /同步伴随。$/);
  assert.doesNotMatch(summary.sentence, /时延0|0\.00天|\+0\.0d/);
});

// === 纯逻辑：弹窗状态机 ===
test("reduceActiveAffiliationKey opens, switches, closes, and auto-closes on vessel switch / stale snapshot", () => {
  const valid = new Set(["a", "b"]);
  assert.equal(reduceActiveAffiliationKey(null, { type: "open", key: "a" }), "a");
  assert.equal(reduceActiveAffiliationKey("a", { type: "open", key: "b" }), "b");
  assert.equal(reduceActiveAffiliationKey("b", { type: "close" }), null);
  assert.equal(reduceActiveAffiliationKey("a", { type: "vessel-switch" }), null);
  assert.equal(reduceActiveAffiliationKey("a", { type: "snapshot-refresh", validKeys: valid }), "a");
  assert.equal(reduceActiveAffiliationKey("c", { type: "snapshot-refresh", validKeys: valid }), null);
  assert.equal(reduceActiveAffiliationKey("a", { type: "unknown" }), "a");
  assert.equal(reduceActiveAffiliationKey("a", { type: "open", key: "" }), null);
});

// === 纯逻辑：遮罩点击判定 ===
test("isDialogMaskClick only returns true when the mask itself is clicked", () => {
  const mask = {};
  const dialog = {};
  assert.equal(isDialogMaskClick({ target: mask, currentTarget: mask }), true);
  assert.equal(isDialogMaskClick({ target: dialog, currentTarget: mask }), false);
  assert.equal(isDialogMaskClick(null), false);
});

test("trapDialogFocus wraps Tab and Shift+Tab inside the modal dialog", () => {
  let focused = null;
  let prevented = 0;
  const first = { hidden: false, getAttribute: () => null, focus: () => { focused = "first"; } };
  const last = { hidden: false, getAttribute: () => null, focus: () => { focused = "last"; } };
  const dialog = {
    querySelectorAll: () => [first, last],
    contains: (element) => element === first || element === last,
    ownerDocument: { activeElement: last },
  };
  assert.equal(trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault: () => { prevented += 1; } }, dialog), true);
  assert.equal(focused, "first");
  dialog.ownerDocument.activeElement = first;
  assert.equal(trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault: () => { prevented += 1; } }, dialog), true);
  assert.equal(focused, "last");
  assert.equal(prevented, 2);
  assert.equal(trapDialogFocus({ key: "Enter" }, dialog), false);
});

// === 弹窗 SSR：分区结构与真实字段 ===
test("dialog renders title, index, tag, direction, and lag tag from real relation data", () => {
  const markup = renderDialog();
  assert.match(markup, /航母关联分析/);
  assert.match(markup, /#1/);
  assert.match(markup, /class="affiliation-detail-tag[^"]*"/);
  assert.match(markup, /时延跟随/);
  assert.match(markup, /西奥多·罗斯福号 → 海猎号 无人艇/);
  assert.match(markup, /\+13\.2d 时延跟随/);
  assert.match(markup, /快照：2026-07-18 15:41:01/);
});

test("dialog lag tag uses a single sign for negative lags (no +-)", () => {
  const negLagRelation = { ...lagRelation, lag: { ...lagRelation.lag, lagMinutes: -7200 } };
  const markup = renderDialog({ relation: negLagRelation });
  assert.match(markup, /-5\.0d 时延跟随/);
  assert.doesNotMatch(markup, /\+-/);
});

test("dialog renders conclusion strength, relationship, lag hours/days, and threshold ratio", () => {
  const markup = renderDialog();
  assert.match(markup, /中等关联/);
  assert.match(markup, /关系描述：西奥多·罗斯福号 跟随 海猎号 无人艇/);
  assert.match(markup, /时延：316\.8小时（13\.20天）/);
  assert.match(markup, /阈值内比例：75%/);
});

test("dialog renders a 0-day lag follow as sync without 时延0天", () => {
  const zeroLagRelation = { ...lagRelation, lag: { ...lagRelation.lag, lagMinutes: 0 } };
  const markup = renderDialog({ relation: zeroLagRelation });
  assert.match(markup, /class="affiliation-detail-tag sync"/);
  assert.match(markup, /同步伴随（无时延）/);
  assert.doesNotMatch(markup, /时延0天|0\.00天|\+0\.0d 时延跟随|延迟 0分钟/);
});

test("buildAffiliationAssessment uses 同步匹配 for a 0-day lag follow", () => {
  const zeroLagRelation = { ...lagRelation, lag: { ...lagRelation.lag, lagMinutes: 0 } };
  const { assessment } = buildAffiliationAssessment({ relation: zeroLagRelation, name: "西奥多·罗斯福号", followerLabel: "海猎号 无人艇", followerCode: undefined });
  assert.match(assessment, /同步匹配/);
  assert.doesNotMatch(assessment, /时延匹配/);
});

test("dialog evidence cards show real values and time range from the relation", () => {
  const markup = renderDialog();
  assert.match(markup, /匹配点数[\s\S]*?<strong>48<\/strong>/);
  assert.match(markup, /最小距离[\s\S]*?1\.30 海里/);
  assert.match(markup, /平均距离[\s\S]*?21\.90 海里/);
  assert.match(markup, /中位距离[\s\S]*?18\.50 海里/);
  assert.match(markup, /航向偏差[\s\S]*?<strong>≤45°<\/strong>/);
  assert.match(markup, /阈值内比例[\s\S]*?75%/);
  assert.match(markup, /关联时间范围/);
});

test("dialog distance chart keeps the threshold line, interpolation note, Beijing time, and median line", () => {
  const markup = renderDialog();
  assert.match(markup, /距离曲线图/);
  assert.match(markup, /海猎号 无人艇 实际轨迹的插值对齐距离/);
  assert.match(markup, /阈值 500 海里/);
  assert.match(markup, /中位距离 18\.50 海里/);
  assert.match(markup, /无人艇实际时间（北京时间）/);
  assert.match(markup, /航母轨迹按关联算法插值对齐/);
  assert.match(markup, /class="affiliation-chart-plot"/);
  assert.match(markup, /aria-label="距离图例"/);
});

test("dialog shows 关联依据 as a standalone full-width section above both charts", () => {
  const markup = renderDialog();
  assert.match(markup, /class="affiliation-detail-basis"[\s\S]*?<h4>关联依据<\/h4>/);
  // 关联依据是独立 section，不与图表同卡片：自身 section 闭合后才是图表区。
  assert.match(markup, /affiliation-detail-basis[\s\S]*?<\/section>[\s\S]*?class="affiliation-detail-charts"/);
  // 关联依据必须位于航迹对比图与距离曲线图之上。
  const basisIndex = markup.indexOf("affiliation-detail-basis");
  const trackIndex = markup.indexOf("航迹对比图");
  const distanceIndex = markup.indexOf("距离曲线图");
  assert.ok(basisIndex !== -1 && trackIndex !== -1 && distanceIndex !== -1);
  assert.ok(basisIndex < trackIndex && basisIndex < distanceIndex);
  // 关联依据不再嵌在距离曲线图内部。
  assert.doesNotMatch(markup, /关联依据：/);
});

test("dialog track chart draws both real tracks and keeps overlapping series distinguishable", () => {
  const markup = renderDialog();
  assert.match(markup, /航迹对比图/);
  assert.match(markup, /class="affiliation-track-line ref" data-series="reference"/);
  assert.match(markup, /class="affiliation-track-line carrier" data-series="carrier"/);
  assert.match(markup, /class="affiliation-track-point ref start"/);
  assert.match(markup, /class="affiliation-track-point carrier start"/);
  assert.match(markup, /class="affiliation-track-point ref end"/);
  assert.match(markup, /class="affiliation-track-point carrier end"/);
  assert.match(markup, /aria-label="航迹图例"/);
  assert.match(markup, /海猎号 无人艇/);
  assert.match(markup, /○ 起点　□ 终点/);
  assert.match(markup, /红线覆盖在蓝线之上/);
  // 起止时间与“航迹对比图”标题同行（标题行内右对齐），且浮层船名不带“无人艇”后缀。
  assert.match(markup, /class="affiliation-track-head"[\s\S]*?航迹对比图[\s\S]*?aria-label="航迹起止时间"/);
  assert.match(markup, /aria-label="航迹起止时间"/);
  assert.match(markup, /<span class="ref">海猎号<\/span>/);
  assert.doesNotMatch(markup, /<span class="ref">海猎号 无人艇<\/span>/);
  assert.match(markup, /26\/07\/14 00:00 ~ 26\/07\/16 00:00/);
  // “真实航迹”开头的两行说明文字已删除。
  assert.doesNotMatch(markup, /真实航迹：/);
  assert.doesNotMatch(markup, /双方 AIS 经纬度序列按统一地理比例绘制/);
  // SSR/全量轨迹未就绪时回退快照抽稀序列，注释如实标注抽稀。
  assert.match(markup, /真实 AIS 航迹抽稀后绘制/);
});

test("trajectory chart drops the middle longitude tick when projected labels would overlap", () => {
  const narrowLongitudeRelation = {
    ...lagRelation,
    referenceTrackSeries: [
      { time: "2026-07-13T16:00:00.000Z", lon: 139.383, lat: 13.432 },
      { time: "2026-07-14T16:00:00.000Z", lon: 140.1, lat: 35.314 },
    ],
    carrierTrackSeries: [
      { time: "2026-07-13T16:00:00.000Z", lon: 134.0, lat: 15.0 },
      { time: "2026-07-14T16:00:00.000Z", lon: 144.767, lat: 13.432 },
    ],
  };
  const markup = renderDialog({ relation: narrowLongitudeRelation });
  const longitudeLabels = [...markup.matchAll(/class="affiliation-track-label">(\d+\.\d{3})<\/text>/g)]
    .map((match) => match[1]);
  assert.deepEqual(longitudeLabels.slice(0, 2), ["134.000", "144.767"]);
  assert.doesNotMatch(markup, />139\.384<\/text>/);
  assert.match(markup, /text-anchor="end" class="affiliation-track-label">134\.000/);
  assert.match(markup, /text-anchor="start" class="affiliation-track-label">144\.767/);
});

test("dialog renders the migrated agent assessment and the USV conservative task assessment", () => {
  const markup = renderDialog();
  assert.match(markup, /海猎号 无人艇 疑似在 西奥多·罗斯福号.*航行活动中承担协同巡逻或侦察任务/);
  assert.doesNotMatch(markup, /研判：|仅据 AIS 无法确认具体任务/);
});

test("dialog suppresses the USV task assessment for an escort follower", () => {
  const markup = renderDialog({ followerName: "霍珀", followerCode: "DDG-70" });
  assert.match(markup, /跟随 霍珀 属舰/);
  assert.doesNotMatch(markup, /承担协同巡逻或侦察任务/);
});

test("dialog has dialog role, aria-modal, labelledby, and an accessible close button", () => {
  const markup = renderDialog();
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /aria-labelledby="affiliation-detail-title-1"/);
  assert.match(markup, /id="affiliation-detail-title-1"/);
  assert.match(markup, /tabindex="-1"/);
  assert.match(markup, /aria-label="关闭关联详情"/);
});

test("dialog shows -- and never NaN/undefined for missing evidence fields", () => {
  const sparseRelation = {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: { lagMinutes: 19008, matchedPoints: 48, distanceSeriesSource: "interpolated", distanceSeries: [{ time: "2026-07-13T16:00:00.000Z", distanceNm: 5 }, { time: "2026-07-14T16:00:00.000Z", distanceNm: 6 }] },
  };
  const markup = renderDialog({ relation: sparseRelation });
  assert.match(markup, /最小距离[\s\S]*?--/);
  assert.match(markup, /平均距离[\s\S]*?--/);
  assert.match(markup, /中位距离[\s\S]*?--/);
  assert.match(markup, /阈值内比例[\s\S]*?--/);
  assert.match(markup, /关联时间范围[\s\S]*?--/);
  assert.doesNotMatch(markup, /NaN/);
  assert.doesNotMatch(markup, /undefined/);
});

test("dialog treats explicit null evidence and coordinates as missing instead of numeric zero", () => {
  const relation = {
    ...lagRelation,
    lag: {
      ...lagRelation.lag,
      minimumDistanceNm: null,
      averageDistanceNm: null,
      medianDistanceNm: null,
      withinThresholdRatio: null,
    },
    referenceTrackSeries: [
      { time: "2026-07-13T16:00:00.000Z", lon: null, lat: 20 },
      { time: "2026-07-14T16:00:00.000Z", lon: 120, lat: null },
    ],
    carrierTrackSeries: [],
  };
  const markup = renderDialog({ relation });
  assert.match(markup, /最小距离[\s\S]*?-- 海里/);
  assert.match(markup, /平均距离[\s\S]*?-- 海里/);
  assert.match(markup, /中位距离[\s\S]*?-- 海里/);
  assert.match(markup, /暂无可用的航迹对比数据。/);
  assert.doesNotMatch(markup, /最小距离[\s\S]*?0\.00 海里/);
});

test("dialog shows an explicit empty state when no real track series is available", () => {
  const noTrackRelation = {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: { lagMinutes: 19008, matchedPoints: 48, distanceSeriesSource: "interpolated", distanceSeries: [{ time: "2026-07-13T16:00:00.000Z", distanceNm: 5 }, { time: "2026-07-14T16:00:00.000Z", distanceNm: 6 }] },
  };
  const markup = renderDialog({ relation: noTrackRelation });
  assert.match(markup, /暂无可用的航迹对比数据。/);
  assert.doesNotMatch(markup, /class="affiliation-track-line/);
});

test("dialog labels the distance series as algorithm-interpolated (0721 口径)", () => {
  const interpolatedRelation = {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: {
      lagMinutes: 120, minimumDistanceNm: 4.2, matchedPoints: 8, medianDistanceNm: 4.5,
      distanceSeriesSource: "interpolated",
      distanceSeries: [{ time: "2026-01-01T00:00:00.000Z", distanceNm: 4.2 }, { time: "2026-01-01T00:01:00.000Z", distanceNm: 4.8 }],
    },
  };
  const markup = renderDialog({ relation: interpolatedRelation });
  assert.match(markup, /插值对齐距离/);
  assert.match(markup, /航母轨迹按关联算法插值对齐/);
});

test("dialog does not fake a 0-day lag when a delay relation is missing lagMinutes", () => {
  const missingLagRelation = {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: { lagMinutes: null, matchedPoints: 8, distanceSeriesSource: "interpolated", distanceSeries: [{ time: "2026-01-01T00:00:00.000Z", distanceNm: 5 }, { time: "2026-01-01T00:01:00.000Z", distanceNm: 6 }] },
  };
  const markup = renderDialog({ relation: missingLagRelation });
  assert.match(markup, /时延：--/);
  assert.match(markup, /\?d 时延跟随/);
  assert.doesNotMatch(markup, /\+0\.0d/);
  assert.doesNotMatch(markup, /0\.0小时（0\.00天）/);
});

test("each relation renders its own detail data when the dialog is bound to it", () => {
  const relationA = { carrier: { mmsi: "368913000", name: "CVN-71" }, relationType: "时延跟随", lag: { lagMinutes: 19008, matchedPoints: 48, averageDistanceNm: 21.9, distanceSeriesSource: "interpolated", distanceSeries: [{ time: "2026-07-13T16:00:00.000Z", distanceNm: 5 }, { time: "2026-07-14T16:00:00.000Z", distanceNm: 6 }] } };
  const relationB = { carrier: { mmsi: "366984000", name: "CVN-72" }, relationType: "时延跟随", lag: { lagMinutes: 41760, matchedPoints: 40, averageDistanceNm: 33.1, distanceSeriesSource: "interpolated", distanceSeries: [{ time: "2026-07-13T16:00:00.000Z", distanceNm: 8 }, { time: "2026-07-14T16:00:00.000Z", distanceNm: 9 }] } };
  const markupA = renderDialog({ relation: relationA, name: "乔治·华盛顿号", index: 1 });
  const markupB = renderDialog({ relation: relationB, name: "西奥多·罗斯福号", index: 2 });
  assert.match(markupA, /乔治·华盛顿号.* → 海猎号 无人艇/);
  assert.match(markupA, /#1/);
  assert.match(markupA, /\+13\.2d 时延跟随/);
  assert.match(markupB, /西奥多·罗斯福号.* → 海猎号 无人艇/);
  assert.match(markupB, /#2/);
  assert.match(markupB, /\+29\.0d 时延跟随/);
  // 两条关联各自展示自己的平均距离，互不串数据。
  assert.match(markupA, /平均距离[\s\S]*?21\.90 海里/);
  assert.match(markupB, /平均距离[\s\S]*?33\.10 海里/);
});

// === 2026-08-15 客户确认规则的前端落实 ===

test("trackSourceNote only claims server-rendered series when both sides loaded", () => {
  assert.match(trackSourceNote("full"), /服务端自 2025-01-01 起全量轨迹生成的渲染序列/);
  // 单侧失败/未完成：必须明确标注快照回退，不得宣称双侧渲染序列。
  assert.match(trackSourceNote("partial"), /快照抽稀回退/);
  assert.doesNotMatch(trackSourceNote("partial"), /双方航迹为服务端/);
  assert.match(trackSourceNote("snapshot"), /抽稀后绘制/);
});

test("dialog shows a loading placeholder and no SVG while track render series loads", () => {
  // 传入 MMSI 时弹窗进入 loading 态：只显示占位、不挂载航迹 SVG，杜绝“快照图→全量图”两阶段跳变。
  const markup = renderDialog({ followerMmsi: "413000630" });
  assert.match(markup, /正在加载航迹数据…/);
  assert.match(markup, /class="affiliation-chart-plot affiliation-track-loading"/);
  assert.doesNotMatch(markup, /class="affiliation-track-line/);
});

test("decimateTrackForRender keeps first/last and per-bucket extremes within the limit", () => {
  const series = Array.from({ length: 150_000 }, (_, index) => ({
    lon: 120 + Math.sin(index / 1000) * 5,
    lat: 20 + Math.cos(index / 997) * 3,
  }));
  const decimated = decimateTrackForRender(series);
  assert.ok(decimated.length <= RENDER_POINT_LIMIT + 2, `抽稀后 ${decimated.length} 点应在上限内`);
  assert.equal(decimated[0], series[0]);
  assert.equal(decimated[decimated.length - 1], series[series.length - 1]);
  // 全局经纬度极值点必是其所在桶的极值，必须保留。
  const globalMaxLat = series.reduce((best, point) => (point.lat > best.lat ? point : best), series[0]);
  const globalMinLon = series.reduce((best, point) => (point.lon < best.lon ? point : best), series[0]);
  assert.ok(decimated.includes(globalMaxLat));
  assert.ok(decimated.includes(globalMinLon));
  // 小序列原样返回（同一引用，不复制）。
  const small = [{ lon: 120, lat: 20 }, { lon: 121, lat: 21 }];
  assert.equal(decimateTrackForRender(small), small);
});

test("decimateDistanceForRender keeps first/last and distance extremes within the limit", () => {
  const entries = Array.from({ length: 150_000 }, (_, index) => ({ index, distance: 100 + Math.sin(index / 500) * 90 }));
  const decimated = decimateDistanceForRender(entries);
  assert.ok(decimated.length <= RENDER_POINT_LIMIT + 2);
  assert.equal(decimated[0], entries[0]);
  assert.equal(decimated[decimated.length - 1], entries[entries.length - 1]);
  const globalMax = entries.reduce((best, entry) => (entry.distance > best.distance ? entry : best), entries[0]);
  const globalMin = entries.reduce((best, entry) => (entry.distance < best.distance ? entry : best), entries[0]);
  assert.ok(decimated.includes(globalMax));
  assert.ok(decimated.includes(globalMin));
});

test("buildTrackRenderSeries filters invalid coords and reports source/render counts", () => {
  const points = [];
  for (let index = 0; index < 150_000; index += 1) {
    points.push({ time: new Date(index * 1000).toISOString(), lon: 120 + Math.sin(index / 1000) * 5, lat: 20 + Math.cos(index / 997) * 3 });
  }
  // 混入非法经纬度点，必须在生成渲染序列前被过滤。
  points.push({ time: "2026-01-01T00:00:00.000Z", lon: 0, lat: 0 });
  points.push({ time: "2026-01-01T00:00:01.000Z", lon: null, lat: 20 });
  points.push({ time: "2026-01-01T00:00:02.000Z", lon: 200, lat: 20 });
  const rendered = buildTrackRenderSeries(points);
  assert.equal(rendered.sourcePointCount, points.length);
  assert.ok(rendered.points.length <= RENDER_POINT_LIMIT + 2);
  assert.ok(rendered.points.every((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat)));
});

test("distance chart x-axis shows the year when the series spans multiple years", () => {
  // 海鹰实际场景：匹配区间 2025-06-30 ~ 2026-08-08，跨 13 个月；刻度必须带年份避免误读为当年 7 月。
  const longSpanRelation = {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: {
      lagMinutes: -4900, matchedPoints: 5038, minimumDistanceNm: 2.26, medianDistanceNm: 2.34,
      distanceSeriesSource: "interpolated",
      distanceSeries: [
        { time: "2025-06-30T23:25:00.000Z", distanceNm: 2.3 },
        { time: "2026-08-06T16:34:00.000Z", distanceNm: 65 },
        { time: "2026-08-08T04:57:00.000Z", distanceNm: 2.3 },
      ],
    },
  };
  const markup = renderDialog({ relation: longSpanRelation });
  assert.match(markup, /25\/07\/01 07:25/);
  assert.match(markup, /26\/08\/08 12:57/);
  // 横轴按真实时间线性比例：中间刻度是日历中点（2026-01-18），不是点数中点（2026-08-06）。
  assert.match(markup, /26\/01\/18 22:11/);
});

test("distance chart x-axis always shows the year (customer-confirmed)", () => {
  // 默认 lagRelation 序列在 2026-07-14 ~ 07-16（北京时间）内：同样带两位年份。
  const markup = renderDialog();
  assert.match(markup, /26\/07\/14 00:00/);
  assert.match(markup, /26\/07\/16 10:57/);
});

test("dialog renders 150k-point full tracks and distance series without RangeError", () => {
  const big = Array.from({ length: 150_000 }, (_, index) => ({
    time: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    lon: 120 + (index % 5000) * 0.001,
    lat: 20 + (index % 3000) * 0.001,
  }));
  const relation = {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: {
      lagMinutes: 19008, matchedPoints: 150_000, minimumDistanceNm: 0.5, medianDistanceNm: 120,
      distanceSeriesSource: "interpolated",
      distanceSeries: big.map((point, index) => ({ time: point.time, distanceNm: index % 400 })),
    },
    referenceTrackSeries: big,
    carrierTrackSeries: big,
  };
  const markup = renderDialog({ relation });
  assert.match(markup, /航迹对比图/);
  assert.match(markup, /距离曲线图/);
  assert.match(markup, /class="affiliation-track-line ref"/);
  assert.doesNotMatch(markup, /NaN/);
});

test("关联依据在字段缺失时显示 -- 而非 NaN/undefined", () => {
  const sparseRelation = {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: {
      lagMinutes: null, matchedPoints: null, minimumDistanceNm: null,
      distanceSeriesSource: "interpolated",
      distanceSeries: [{ time: "2026-01-01T00:00:00.000Z", distanceNm: 5 }, { time: "2026-01-01T00:01:00.000Z", distanceNm: 6 }],
    },
  };
  const markup = renderDialog({ relation: sparseRelation });
  assert.match(markup, /affiliation-detail-basis/);
  assert.match(markup, /延迟 --/);
  assert.match(markup, /最小距离 -- 海里/);
  assert.match(markup, /-- 个匹配点/);
  assert.doesNotMatch(markup, /NaN|undefined/);
});

test("buildAffiliationAssessment keeps the medium/strong grading and the conservative USV note", () => {
  const strong = buildAffiliationAssessment({ relation: { relationType: "时延跟随", lag: { averageDistanceNm: 8, minimumDistanceNm: 4, matchedPoints: 30, courseFilterApplied: true } }, name: "CVN-71", followerLabel: "海猎号 无人艇", followerCode: undefined });
  assert.match(strong.assessment, /存在较强协同伴随线索/);
  assert.match(strong.operationalAssessment, /承担协同巡逻或侦察任务/);

  const escort = buildAffiliationAssessment({ relation: { relationType: "时延跟随", lag: { averageDistanceNm: 8, minimumDistanceNm: 4, matchedPoints: 30, courseFilterApplied: true } }, name: "CVN-71", followerLabel: "霍珀 属舰", followerCode: "DDG-70" });
  assert.equal(escort.operationalAssessment, null);
});
