import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("./AnalysisPanel.jsx", import.meta.url), "utf8");
const focusPanelSource = readFileSync(new URL("./VesselFocusPanel.jsx", import.meta.url), "utf8");

test("selected-vessel ontology requests expose loading and failure feedback", () => {
  assert.match(appSource, /setTrackLoading\(true\)/);
  assert.match(appSource, /setTrackError\(null\)/);
  assert.match(appSource, /setTrackError\(error instanceof Error/);
  assert.match(appSource, /\?fresh=1/);
  assert.match(appSource, /forceRefreshMmsiRef\.current === selectedMmsi/);
  assert.match(appSource, /if \(repeatedSelection\) setTrackRefreshVersion/);
  assert.match(appSource, /target\.dataUnavailable \? "--" : target\.score/);
  assert.match(appSource, /trackLoading=\{trackLoading\}/);
  assert.match(appSource, /trackError=\{trackError\}/);
  assert.match(panelSource, /本体轨迹统计加载中/);
  assert.match(panelSource, /本体轨迹统计加载失败/);
  assert.match(panelSource, /value === null \|\| value === undefined \|\| value === ""/);
  assert.match(focusPanelSource, /partial-source-error/);
  assert.match(focusPanelSource, /部分航母轨迹查询失败/);
});
