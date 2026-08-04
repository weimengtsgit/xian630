import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".jsx")) {
      return {
        format: "module",
        shortCircuit: true,
        source: transformSync(readFileSync(fileURLToPath(url), "utf8"), {
          loader: "jsx",
          format: "esm",
        }).code,
      };
    }

    return nextLoad(url, context);
  },
});

const { AnalysisPanel } = await import("./AnalysisPanel.jsx");

const selectedTarget = {
  name: "SEASATS 55",
  mmsi: "338414915",
  status: "异常行为舰艇",
  score: 79,
  minCoastDistanceNm: 1,
  activeDays: 46,
  reportCount: 338,
  maxSpeedSegment: { speedKn: 55.4 },
  aisGaps: [{ id: "gap-1", gapMinutes: 120 }],
  alerts: [{ id: "alert-1", title: "AIS 中断", summary: "回放窗口内存在中断", time: "2026-01-01T00:00:00Z", severity: "warning" }],
  segments: [{
    points: [
      { time: "2025-12-06T00:00:00Z", lon: 120, lat: 30, speedKn: 1.2, orientation: 10 },
      { time: "2026-01-01T00:00:00Z", lon: 121, lat: 31, speedKn: 4.0, orientation: 45 },
      { time: "2026-02-01T00:00:00Z", lon: 122, lat: 32, speedKn: 2.4, orientation: 90 },
      { time: "2026-03-01T00:00:00Z", lon: 123, lat: 33, speedKn: 8.6, orientation: 120 },
    ],
  }],
};

const analysis = {
  summary: {
    threatLevel: "medium",
    threatLabel: "关注",
    narrative: "当前舰艇存在异常活动，需要持续跟踪。",
    advice: [{ level: "medium", text: "保持回放和告警联动观察。" }],
  },
};

const coastData = [{ lon: 121, lat: 30 }, { lon: 122, lat: 31 }];

test("renders current-data AIS charts with Chinese speed units", () => {
  const markup = renderToStaticMarkup(React.createElement(AnalysisPanel, { analysis, selectedTarget, coastData }));

  assert.match(markup, /AIS 轨迹图表/);
  assert.equal((markup.match(/class="analysis-chart-card(?: wide)?"/g) || []).length, 4);
  // 速度变化、速度 vs 国土距离、航向分布、活动时段四个图，均不占整栏（无 wide）。
  assert.equal((markup.match(/class="analysis-chart-card wide"/g) || []).length, 0);
  assert.match(markup, /速度变化 · 全时段/);
  assert.doesNotMatch(markup, /低速停留/);
  assert.match(markup, /航向分布/);
  assert.doesNotMatch(markup, /速度分布直方图/);
  assert.match(markup, /速度 vs 国土距离/);
  assert.match(markup, /活动时段/);
  assert.match(markup, /样本/);
  assert.match(markup, /均值/);
  assert.match(markup, /最高/);
  assert.match(markup, /最活跃/);
  assert.match(markup, /低速占比/);
  assert.match(markup, /55\.4 节/);
  assert.doesNotMatch(markup, /\bkt\b/i);
  assert.equal((markup.match(/class="chart-axis-label"/g) || []).length, 5);
  assert.equal((markup.match(/class="chart-line-hit-area"/g) || []).length, 3);
  assert.match(markup, /\u901f\u5ea6\uff08\u8282\uff09/);
  assert.match(markup, /\u8ddd\u79bb\uff08\u6d77\u91cc\uff09/);
  assert.match(markup, /\u70b9\u4f4d\u6570/);
  assert.match(markup, /\u62a5\u70b9\u6570/);
});

test("places concise conclusion at the top of the analysis panel", () => {
  const markup = renderToStaticMarkup(React.createElement(AnalysisPanel, { analysis, selectedTarget, coastData }));

  assert.ok(markup.indexOf("研判结论") < markup.indexOf("AIS 轨迹图表"));
  assert.ok(markup.indexOf("研判结论") < markup.indexOf("建议动作"));
  assert.doesNotMatch(markup, /analysis-metric-row/);
});

test("uses a larger chart viewBox so line charts fill the card", () => {
  const markup = renderToStaticMarkup(React.createElement(AnalysisPanel, { analysis, selectedTarget, coastData }));

  assert.match(markup, /viewBox="0 0 760 280"/);
});

test("static markup never uses forbidden wording", () => {
  const markup = renderToStaticMarkup(React.createElement(AnalysisPanel, { analysis, selectedTarget, coastData }));

  assert.doesNotMatch(markup, new RegExp("\\u76ee\\u6807"));
});
