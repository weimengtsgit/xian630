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

test("renders focused vessel identity, status, threat score, and key metrics", () => {
  const markup = render();

  assert.match(markup, /class="[^"]*vessel-focus-panel/);
  assert.match(markup, /关注舰艇/);
  assert.match(markup, /海巡 630/);
  assert.match(markup, /413000630/);
  assert.match(markup, /AIS 异常/);
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

test("renders focus display status and fallback heading", () => {
  const markup = render({
    selectedTarget: {
      ...selectedTarget,
      orientation: null,
    },
    focusOnly: false,
    visibleCount: 12,
    totalCount: 12,
  });

  assert.match(markup, /class="[^"]*focus-mode-status/);
  assert.match(markup, /全部 12 艘舰艇/);
  assert.match(markup, /航向\/方向[\s\S]*--/);
  assert.doesNotMatch(markup, /checked=""/);
});

test("does not render NaN for invalid numeric values", () => {
  const markup = render({
    selectedTarget: {
      ...selectedTarget,
      score: Number.NaN,
    },
    visibleCount: Number.NaN,
    totalCount: Number.NaN,
    focusOnly: false,
  });

  assert.doesNotMatch(markup, /NaN/);
  assert.match(markup, /全部 -- 艘舰艇/);
});

test("renders focused-only status", () => {
  const markup = render();

  assert.match(markup, /当前只显示 1 艘关注舰艇/);
  assert.match(markup, /type="checkbox"/);
  assert.match(markup, /checked=""/);
});

test("static markup never uses forbidden wording", () => {
  const markup = render();

  assert.doesNotMatch(markup, new RegExp("\\u76ee\\u6807"));
});
