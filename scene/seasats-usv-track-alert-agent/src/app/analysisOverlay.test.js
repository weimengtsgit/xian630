import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// App.jsx 含 JSX 且 Dashboard 依赖远端数据，难以直接 SSR；结构性与样式约定按源码校验，
// 关键交互（按钮 aria、悬浮框输出）由 VesselFocusPanel.test.js 的服务端渲染覆盖。
const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const focusSource = readFileSync(new URL("./VesselFocusPanel.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

test("AnalysisPanel is built once and passed as a prop, no longer rendered below the workspace", () => {
  // 源码中 <AnalysisPanel 仅出现一次，且位于 analysisPanel 常量内，作为 prop 传入右侧栏。
  assert.equal((appSource.match(/<AnalysisPanel/g) || []).length, 1);
  assert.match(appSource, /const analysisPanel = \(\s*<AnalysisPanel/);
  assert.match(appSource, /analysisPanel=\{analysisPanel\}/);
});

test("Dashboard manages overlay state and Escape-to-close", () => {
  assert.match(appSource, /const \[showAnalysisOverlay, setShowAnalysisOverlay\] = useState\(false\)/);
  assert.match(appSource, /onToggleAnalysisOverlay=\{\(\) => setShowAnalysisOverlay\(\(value\) => !value\)\}/);
  assert.match(appSource, /if \(!showAnalysisOverlay\) return undefined/);
  assert.match(appSource, /subscribeEscapeKey\(window, \(\) => setShowAnalysisOverlay\(false\)\)/);
});

test("overlay content container has vertical scroll styling and clamp width", () => {
  assert.match(css, /\.analysis-overlay-body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.analysis-overlay-body\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.match(css, /\.analysis-overlay\s*\{[^}]*width:\s*clamp\(520px,\s*48vw,\s*900px\)/);
});

test("affiliation block stacks snapshot time below the title", () => {
  // 快照时间换行到栏名下方，不再与标题同行。
  assert.match(css, /\.vessel-affiliation\s+h3\s*\{[^}]*flex-direction:\s*column/);
});

test("overlay switches to a viewport-bounded fixed panel on narrow screens", () => {
  assert.match(css, /@media \(max-width: 1320px\)[\s\S]*?\.analysis-overlay\s*\{[^}]*max-height:\s*calc\(100vh - 24px\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.analysis-overlay\s*\{[^}]*bottom:\s*12px/);
});

test("focus panel reserves a prediction data interface and never fakes prediction data", () => {
  assert.match(focusSource, /function predictionContent\(prediction, selectedName, allTargets\)/);
  assert.match(focusSource, /暂无可用的关联预测数据。/);
  // 预测区块只接收 prediction 入参，不挪用历史 affiliation 数据冒充预测。
  assert.doesNotMatch(focusSource, /predictionContent\(affiliation/);
});
