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

function lagRelation(overrides = {}) {
  return {
    carrier: { mmsi: "366984000", name: "CVN-71" },
    relationType: "时延跟随",
    lag: { lagMinutes: 120, averageDistanceNm: 62.86, minimumDistanceNm: 4.2, matchedPoints: 8, courseFilterApplied: true, maxCourseDifferenceDeg: 32, ...overrides.lag },
    ...overrides,
  };
}

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

test("header prefers the code-prefixed display name over the raw retrieved name", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, displayName: "CVN-73 华盛顿号", name: "USS George Washington(US GOV VESSEL)" },
  });
  assert.match(markup, /CVN-73 华盛顿号/);
  assert.doesNotMatch(markup, /USS George Washington/);
});

test("renders a compact affiliation summary below metrics with snapshot time", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, orientation: null },
    affiliation: { status: "analyzed", carriers: [lagRelation()] },
    affiliationRefreshedAt: "2026-07-18T07:41:01.382Z",
  });

  assert.match(markup, /与航母打击群关联分析（历史）/);
  assert.match(markup, /与航母打击群关联分析（预测）/);
  assert.match(markup, /暂无可用的关联预测数据。/);
  assert.match(markup, /快照：/);
  // 紧凑摘要：固定结论、双方名称、关系方向、时延天数。
  assert.match(markup, /海巡 630 无人艇 与 西奥多·罗斯福号.*存在中等强度关联/);
  assert.match(markup, /存在中等强度关联/);
  assert.match(markup, /关系为 西奥多·罗斯福号.*跟随 海巡 630 无人艇/);
  assert.match(markup, /时延0\.08天/);
  assert.match(markup, /<button[^>]*affiliation-summary-row/);
  assert.match(markup, /affiliation-summary-arrow/);
  assert.match(markup, /aria-label="查看海巡 630 无人艇与西奥多·罗斯福号.*的关联详情"/);
  // 右侧栏不再直接输出完整研判依据与距离证据。
  assert.doesNotMatch(markup, /研判依据：/);
  assert.doesNotMatch(markup, /class="affiliation-evidence"/);
  assert.doesNotMatch(markup, /距离曲线/);
  assert.ok(markup.indexOf("最快速度") < markup.indexOf("与航母打击群关联分析（历史）"));
  assert.match(markup, /航向\/方向[\s\S]*--/);
});

test("shows the empty state text exactly when no affiliation matches the threshold", () => {
  const markup = render({
    affiliation: { status: "analyzed", carriers: [{ carrier: { mmsi: "366984000" }, relationType: "未命中", lag: { matched: false } }] },
  });
  assert.match(markup, /暂无满足历史关联阈值的航母关联。/);
  assert.doesNotMatch(markup, /查看详情/);
  assert.doesNotMatch(markup, /存在中等强度关联/);
});

test("keeps the no-track / source-error states unchanged", () => {
  assert.match(render({ affiliation: { status: "no-track" } }), /历史窗口内未获取到该舰艇 AIS 轨迹。/);
  assert.match(render({ affiliation: { status: "source-error", error: "x" } }), /本体轨迹查询失败，暂不生成航母关联结论。/);
  assert.match(render({ affiliation: { status: "refreshing" } }), /暂无可用的航母关联历史快照。/);
});

test("formats the relation lag as two-decimal days in the summary, e.g. 时延12.83天", () => {
  const markup = render({
    affiliation: { status: "analyzed", carriers: [lagRelation({ lag: { lagMinutes: 18480, averageDistanceNm: 62.86, minimumDistanceNm: 4.2, matchedPoints: 8, courseFilterApplied: true } })] },
  });
  assert.match(markup, /时延12\.83天/);
});

test("formats 19008 minutes as 13.20 days", () => {
  const markup = render({
    affiliation: { status: "analyzed", carriers: [lagRelation({ lag: { lagMinutes: 19008, averageDistanceNm: 62.86, minimumDistanceNm: 4.2, matchedPoints: 8, courseFilterApplied: true } })] },
  });
  assert.match(markup, /时延13\.20天/);
});

test("renders 时延未知 instead of NaN天 for an invalid or missing lag", () => {
  for (const lagMinutes of [null, undefined, NaN, "abc"]) {
    const markup = render({
      affiliation: { status: "analyzed", carriers: [lagRelation({ lag: { lagMinutes, averageDistanceNm: 62.86, minimumDistanceNm: 4.2, matchedPoints: 8, courseFilterApplied: true } })] },
    });
    assert.match(markup, /时延未知/);
    assert.doesNotMatch(markup, /NaN天/);
    assert.doesNotMatch(markup, /时延undefined/);
  }
});

test("renders a sync-association summary without a faked lag", () => {
  const markup = render({
    affiliation: {
      status: "analyzed",
      carriers: [{
        carrier: { mmsi: "366984000", name: "CVN-71" },
        relationType: "同步伴随",
        sync: { matchedPoints: 30, averageDistanceNm: 8, minimumDistanceNm: 4.2, matched: true },
        lag: { matched: false },
      }],
    },
  });
  assert.match(markup, /海巡 630 无人艇 与 西奥多·罗斯福号.*存在中等强度关联/);
  assert.match(markup, /关系为 海巡 630 无人艇 与 西奥多·罗斯福号.*同步伴随/);
  // 同步伴随没有有效时延，摘要不带“时延X天”，也不出现 NaN。
  assert.doesNotMatch(markup, /时延[\d.]+天/);
  assert.doesNotMatch(markup, /NaN/);
});

test("renders a distinct, stable aria-label per relation so each button opens its own dialog", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, name: "海猎号", mmsi: "368926574" },
    affiliation: {
      status: "analyzed",
      carriers: [
        { carrier: { mmsi: "368913000", name: "CVN-71" }, relationType: "时延跟随", lag: { lagMinutes: 19008, averageDistanceNm: 21.9, minimumDistanceNm: 1.3, matchedPoints: 48, courseFilterApplied: true } },
        { carrier: { mmsi: "366984000", name: "CVN-72" }, relationType: "时延跟随", lag: { lagMinutes: 41760, averageDistanceNm: 22.5, minimumDistanceNm: 2.1, matchedPoints: 40, courseFilterApplied: true } },
      ],
    },
  });
  // 两条摘要各含双方名称，aria-label 可区分。
  assert.match(markup, /海猎号 无人艇 与 乔治·华盛顿号.*存在中等强度关联[\s\S]*<\/button>/);
  assert.match(markup, /海猎号 无人艇 与 西奥多·罗斯福号.*存在中等强度关联[\s\S]*<\/button>/);
  const labels = [...markup.matchAll(/aria-label="查看[^"]*的关联详情"/g)].map((m) => m[0]);
  assert.equal(labels.length, 2);
  assert.notEqual(labels[0], labels[1]);
  // 关系方向沿用业务口径：航母 跟随 另一方。
  assert.match(markup, /乔治·华盛顿号.*跟随 海猎号 无人艇/);
});

test("renders snapshot generating status while affiliation refresh is pending", () => {
  const markup = renderToStaticMarkup(React.createElement(VesselFocusPanel, {
    selectedTarget,
    affiliation: { status: "refreshing" },
  }));
  assert.match(markup, /快照：生成中/);
});

test("labels a coded escort follower as 属舰 in the summary and suppresses the USV assessment in the sidebar", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, name: "霍珀", mmsi: "367197000", code: "DDG-70" },
    allTargets: [{ mmsi: "367197000", name: "霍珀", code: "DDG-70" }],
    affiliation: {
      status: "analyzed",
      reference: { mmsi: "367197000", name: "霍珀", role: "无人艇" },
      carriers: [{
        carrier: { mmsi: "366984000", name: "CVN-71" },
        relationType: "时延跟随",
        lag: { lagMinutes: 120, averageDistanceNm: 8, minimumDistanceNm: 4.2, matchedPoints: 30, courseFilterApplied: true, distanceSeriesSource: "interpolated", distanceSeries: [{ time: "2026-01-01T00:00:00.000Z", distanceNm: 4.2 }, { time: "2026-01-01T00:01:00.000Z", distanceNm: 4.8 }] },
      }],
    },
  });
  assert.match(markup, /跟随 霍珀 属舰/);
  // 侧栏不再直接渲染距离证据与无人艇任务研判（已迁移到详情弹窗）。
  assert.doesNotMatch(markup, /关联依据：霍珀 属舰 实际轨迹/);
  assert.doesNotMatch(markup, /承担协同巡逻或侦察任务/);
  assert.doesNotMatch(markup, /霍珀 无人艇/);
});

test("treats a fleet oiler (T-AO) hull code as an escort", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, name: "瓜达卢佩", mmsi: "367219000", code: "T-AO-200" },
    allTargets: [{ mmsi: "367219000", name: "瓜达卢佩", code: "T-AO-200" }],
    affiliation: {
      status: "analyzed",
      reference: { mmsi: "367219000", name: "瓜达卢佩", role: "无人艇" },
      carriers: [{ carrier: { mmsi: "366984000", name: "CVN-71" }, relationType: "时延跟随", lag: { lagMinutes: 120, averageDistanceNm: 8, minimumDistanceNm: 4.2, matchedPoints: 30, courseFilterApplied: true } }],
    },
  });
  assert.match(markup, /跟随 瓜达卢佩 属舰/);
  assert.doesNotMatch(markup, /瓜达卢佩 无人艇/);
});

test("keeps T-AKE and T-AOE hull types distinct and labels both as escorts", () => {
  for (const [code, name, mmsi] of [
    ["T-AKE-11", "钱伯斯", "367276000"],
    ["T-AOE-6", "供应号", "367276001"],
  ]) {
    const markup = render({
      selectedTarget: { ...selectedTarget, name, mmsi, code },
      allTargets: [{ mmsi, name, code }],
      affiliation: {
        status: "analyzed",
        reference: { mmsi, name, role: "无人艇" },
        carriers: [{
          carrier: { mmsi: "366984000", name: "CVN-71" },
          relationType: "时延跟随",
          lag: { lagMinutes: 120, averageDistanceNm: 8, minimumDistanceNm: 4.2, matchedPoints: 30, courseFilterApplied: true },
        }],
      },
    });
    assert.match(markup, new RegExp(`跟随 ${name} 属舰`));
    assert.doesNotMatch(markup, new RegExp(`${name} 无人艇`));
  }
});

test("labels an unknown or missing hull code as 无人艇 regardless of the snapshot role", () => {
  for (const code of ["AO-123", undefined]) {
    const markup = render({
      selectedTarget: { ...selectedTarget, name: "测试艇", mmsi: "369000001", code },
      allTargets: [{ mmsi: "369000001", name: "测试艇", code }],
      affiliation: {
        status: "analyzed",
        reference: { mmsi: "369000001", name: "测试艇", role: "航母" },
        carriers: [{
          carrier: { mmsi: "366984000", name: "CVN-71" },
          relationType: "时延跟随",
          lag: { lagMinutes: 120, averageDistanceNm: 8, minimumDistanceNm: 4.2, matchedPoints: 30, courseFilterApplied: true },
        }],
      },
    });
    assert.match(markup, /跟随 测试艇 无人艇/);
    assert.doesNotMatch(markup, /测试艇 属舰/);
  }
});

test("labels related escorts as 属舰 when the selected vessel is a carrier", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, name: "西奥多·罗斯福号 (USS Theodore Roosevelt)", mmsi: "366984000", code: "CVN-71" },
    allTargets: [
      { mmsi: "366984000", name: "西奥多·罗斯福号 (USS Theodore Roosevelt)", code: "CVN-71" },
      { mmsi: "367197000", name: "霍珀", code: "DDG-70" },
    ],
    affiliation: { status: "carrier" },
    allAffiliations: {
      "367197000": {
        reference: { mmsi: "367197000", role: "无人艇" },
        carriers: [{ carrier: { mmsi: "366984000" }, relationType: "时延跟随", lag: { lagMinutes: 120, averageDistanceNm: 8, minimumDistanceNm: 4.2, matchedPoints: 30, courseFilterApplied: true } }],
      },
    },
  });
  assert.match(markup, /跟随 霍珀 属舰/);
  assert.doesNotMatch(markup, /霍珀 无人艇/);
});

test("does not render NaN for invalid numeric values", () => {
  const markup = render({ selectedTarget: { ...selectedTarget, score: Number.NaN } });
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

test("renders the analysis overlay toggle with correct aria state when closed and open", () => {
  const closed = render();
  assert.match(closed, /class="analysis-overlay-toggle"/);
  assert.match(closed, /aria-label="展开分析面板"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /title="展开分析面板"/);
  // 关闭时悬浮框不入 DOM，AnalysisPanel 不提前渲染。
  assert.doesNotMatch(closed, /class="analysis-overlay"/);
  assert.doesNotMatch(closed, /analysis-overlay-body/);

  const open = renderToStaticMarkup(React.createElement(VesselFocusPanel, {
    selectedTarget,
    showAnalysisOverlay: true,
    onToggleAnalysisOverlay: () => {},
    analysisPanel: React.createElement("div", { id: "fake-analysis" }, "FAKE_ANALYSIS_CONTENT"),
  }));
  assert.match(open, /aria-label="收起分析面板"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /class="analysis-overlay"/);
  assert.match(open, /role="dialog"/);
  assert.match(open, /aria-modal="false"/);
  assert.doesNotMatch(open, /aria-modal="true"/);
  assert.match(open, /aria-labelledby="analysis-overlay-title"/);
  assert.match(open, /id="analysis-overlay-title"/);
  assert.match(open, /舰艇综合分析/);
  assert.match(open, /FAKE_ANALYSIS_CONTENT/);
  assert.match(open, /class="analysis-overlay-body"/);
});

test("renders prediction entries when a prediction payload is provided", () => {
  const markup = render({
    prediction: {
      status: "analyzed",
      entries: [{
        carrier: { mmsi: "366984000", name: "CVN-71" },
        relationType: "时延跟随",
        predictedWindow: { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" },
        confidence: 0.62,
        note: "基于历史伴随规律推测，仅作参考。",
      }],
    },
  });
  assert.match(markup, /海巡 630 预计与 西奥多·罗斯福号 时延跟随/);
  assert.match(markup, /置信度 62%/);
  assert.match(markup, /基于历史伴随规律推测，仅作参考。/);
});

test("prediction payload with null or carrier-less entries is handled safely", () => {
  const markup = render({
    prediction: {
      status: "analyzed",
      entries: [
        null,
        { carrier: { mmsi: "366984000", name: "CVN-71" }, relationType: "同步伴随", confidence: 0.5 },
        { relationType: "时延跟随" },
      ],
    },
  });
  assert.match(markup, /海巡 630 预计与 西奥多·罗斯福号 同步伴随/);
  assert.match(markup, /海巡 630 预计与 未知关联对象 时延跟随/);
  assert.doesNotMatch(markup, /航母 MMSI undefined/);
});

test("prediction payload with only null entries falls back to the empty state", () => {
  const markup = render({
    prediction: { status: "analyzed", entries: [null, null] },
  });
  assert.match(markup, /暂无可用的关联预测数据。/);
  assert.doesNotMatch(markup, /预计与/);
});
