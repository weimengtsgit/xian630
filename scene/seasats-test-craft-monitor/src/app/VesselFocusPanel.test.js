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

const { VesselFocusPanel } = await import("./VesselFocusPanel.jsx");

const selectedTarget = {
  name: "海巡 630",
  mmsi: "413000630",
  status: "AIS 异常",
  score: 86,
  maxSpeedSegment: { speedKn: 18.4 },
  avgSpeedKn: 6.7,
  orientation: 148,
  minCoastDistanceNm: 72,
  activeDays: 5,
  aisGaps: [{ id: "gap-1" }, { id: "gap-2" }, { id: "gap-3" }],
  alerts: [{ id: "alert-1" }, { id: "alert-2" }, { id: "alert-3" }, { id: "alert-4" }],
};

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(VesselFocusPanel, {
    selectedTarget,
    visibleCount: 1,
    totalCount: 12,
    focusOnly: true,
    onFocusOnlyChange: () => {},
    ...props,
  }));
}

test("renders focused vessel identity, threat score, and key metrics", () => {
  const markup = render();

  assert.match(markup, /class="[^"]*vessel-focus-panel/);
  assert.match(markup, /关注舰艇/);
  assert.match(markup, /海巡 630/);
  assert.match(markup, /413000630/);
  assert.doesNotMatch(markup, /AIS 异常/);
  assert.match(markup, /威胁分/);
  assert.match(markup, /86/);
  assert.match(markup, /最快速度/);
  assert.match(markup, /18\.4 节/);
  assert.match(markup, /平均速度/);
  assert.match(markup, /6\.7 节/);
  assert.match(markup, /航向\/方向/);
  assert.match(markup, /148°/);
  assert.match(markup, /活动天数/);
  assert.match(markup, /AIS 中断数/);
  assert.match(markup, /3 次/);
  assert.match(markup, /告警数/);
  assert.match(markup, /4 条/);
});

test("renders association below metrics with snapshot time and fallback heading", () => {
  const markup = render({
    selectedTarget: {
      ...selectedTarget,
      orientation: null,
    },
    affiliation: {
      status: "analyzed",
      carriers: [{
        carrier: { mmsi: "366984000", name: "CVN-71" },
        relationType: "时延跟随",
        lag: { lagMinutes: 120, averageDistanceNm: 62.86, minimumDistanceNm: 4.2, matchedPoints: 8, courseFilterApplied: true, maxCourseDifferenceDeg: 32 },
      }],
    },
    affiliationRefreshedAt: "2026-07-18T07:41:01.382Z",
  });

  assert.match(markup, /航母关联（历史）/);
  assert.match(markup, /快照：/);
  assert.match(markup, /西奥多·罗斯福号/);
  assert.match(markup, /西奥多·罗斯福号.*跟随 海巡 630/);
  assert.match(markup, /尚不支持仅据 AIS 定性具体任务/);
  assert.match(markup, /最小距离 4\.20 海里/);
  assert.match(markup, /航向误差不超过45°（本次最大 32°）/);
  assert.match(markup, /时延 2小时/);
  assert.ok(markup.indexOf("最快速度") < markup.indexOf("航母关联（历史）"));
  assert.match(markup, /航向\/方向[\s\S]*--/);
});

test("renders delay-aligned distance evidence only for a matched delay relation", () => {
  const markup = render({
    affiliation: {
      status: "analyzed",
      carriers: [{
        carrier: { mmsi: "366984000", name: "CVN-71" },
        relationType: "时延跟随",
        lag: {
          lagMinutes: 11520,
          averageDistanceNm: 2.34,
          minimumDistanceNm: 2.1,
          matchedPoints: 8,
          courseFilterApplied: true,
          maxCourseDifferenceDeg: 30,
          distanceSeries: [
            { time: "2026-01-01T00:00:00.000Z", distanceNm: 2.1 },
            { time: "2026-01-01T00:01:00.000Z", distanceNm: 2.6 },
          ],
        },
      }],
    },
  });

  assert.match(markup, /关联依据：西奥多·罗斯福号/);
  assert.match(markup, /8天/);
  assert.doesNotMatch(markup, /11520 分钟/);
  assert.match(markup, /距离曲线/);
  assert.match(markup, /距离（海里）/);
  assert.match(markup, /时间（北京时间）/);
  assert.match(markup, /阈值 100 海里/);
});

test("does not render NaN for invalid numeric values", () => {
  const markup = render({
    selectedTarget: {
      ...selectedTarget,
      score: Number.NaN,
    },
  });

  assert.doesNotMatch(markup, /NaN/);
  assert.match(markup, /威胁分[\s\S]*--/);
});

test("does not render removed focus status controls", () => {
  const markup = render();

  assert.doesNotMatch(markup, /当前只显示/);
  assert.doesNotMatch(markup, /type="checkbox"/);
  assert.doesNotMatch(markup, /数据加载中/);
});

test("static markup never uses forbidden wording", () => {
  const markup = render();

  assert.doesNotMatch(markup, new RegExp("\\u76ee\\u6807"));
});
