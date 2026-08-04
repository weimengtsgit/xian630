# 综合分析弹窗图表轴标题与悬浮提示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一综合分析弹窗四张 AIS 图表的纵轴标题与响应式布局，并在折线或柱体悬浮时只显示最近数据点的纵轴值。

**Architecture:** 保留现有原生 SVG 图表，在独立纯函数模块中实现“按指针横坐标选择最近有效点”，由 `AnalysisPanel.jsx` 的折线和柱状图共用一个 SVG tooltip。通过透明宽描边扩大折线命中范围，通过 CSS 统一两列两行卡片布局、轴标题和 tooltip 视觉。

**Tech Stack:** React 18、原生 SVG、CSS Grid、Node.js `node:test`、React 服务端静态渲染测试、Vite 6。

## Global Constraints

- 保留现有四张图及其数据来源、统计摘要和颜色语义。
- tooltip 只显示纵轴值，不显示日期、时段、方向等横轴信息。
- 双折线分别命中速度线与距离线，并只显示被命中序列的值。
- 不引入第三方图表库，不修改分析数据计算或弹窗其他业务内容。
- 数据不足时继续显示现有空状态；空值数据点不参与最近点选择。
- 保留目标文件中的全部现有未提交改动。目标文件已包含用户修改，因此实施阶段不暂存或提交这些文件。

---

### Task 1: 最近有效数据点选择函数

**Files:**
- Create: `scene/seasats-usv-track-alert-agent/src/app/analysisChartInteraction.js`
- Create: `scene/seasats-usv-track-alert-agent/src/app/analysisChartInteraction.test.js`

**Interfaces:**
- Consumes: 数据数组、纵轴字段名、SVG 内指针横坐标、绘图区左边界与宽度。
- Produces: `nearestValidPointIndex(data, valueKey, pointerX, plotLeft, plotWidth): number | null`，供两类折线图指针事件调用。

- [ ] **Step 1: 写失败测试，覆盖最近点和空值过滤**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { nearestValidPointIndex } from "./analysisChartInteraction.js";

test("selects the valid point nearest to the pointer x coordinate", () => {
  const data = [{ v: 2 }, { v: 4 }, { v: 8 }, { v: 16 }];
  assert.equal(nearestValidPointIndex(data, "v", 92, 20, 120), 2);
});

test("skips null values while selecting the nearest point", () => {
  const data = [{ v: 2 }, { v: null }, { v: 8 }];
  assert.equal(nearestValidPointIndex(data, "v", 100, 20, 100), 2);
});

test("returns null when the series has no valid y values", () => {
  assert.equal(nearestValidPointIndex([{ v: null }, {}], "v", 40, 20, 100), null);
});
```

- [ ] **Step 2: 运行新测试并确认因模块不存在而失败**

Run: `npm test -- --test-name-pattern="nearest|skips null|no valid"`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: FAIL，错误指出无法找到 `analysisChartInteraction.js`。

- [ ] **Step 3: 实现最小纯函数**

```js
import { toNumber } from "../logic/domain.js";

export function nearestValidPointIndex(data, valueKey, pointerX, plotLeft, plotWidth) {
  if (!Array.isArray(data) || data.length === 0 || plotWidth <= 0) return null;

  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  data.forEach((item, index) => {
    if (toNumber(item?.[valueKey]) === null) return;
    const x = plotLeft + (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth);
    const distance = Math.abs(x - pointerX);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  return bestIndex;
}
```

- [ ] **Step 4: 运行纯函数测试并确认通过**

Run: `node --test src/app/analysisChartInteraction.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: 3 tests passed，0 failed。

---

### Task 2: 折线图自定义纵轴值 tooltip

**Files:**
- Modify: `scene/seasats-usv-track-alert-agent/src/app/AnalysisPanel.jsx`
- Modify: `scene/seasats-usv-track-alert-agent/src/app/AnalysisPanel.test.js`
- Test: `scene/seasats-usv-track-alert-agent/src/app/analysisChartInteraction.test.js`

**Interfaces:**
- Consumes: Task 1 的 `nearestValidPointIndex`、现有 `chartPoint`、`fmtNumber`、折线数据与单位。
- Produces: `SvgValueTooltip({ x, y, value })`；速度折线一个命中层，速度/距离双折线两个独立命中层。

- [ ] **Step 1: 写失败的静态结构测试**

在 `AnalysisPanel.test.js` 的主图表测试中加入：

```js
assert.equal((markup.match(/class="chart-axis-label"/g) || []).length, 5);
assert.equal((markup.match(/class="chart-line-hit-area"/g) || []).length, 3);
assert.match(markup, /速度（节）/);
assert.match(markup, /距离（海里）/);
assert.match(markup, /点位数/);
assert.match(markup, /报点数/);
```

- [ ] **Step 2: 运行组件测试并确认缺少折线命中层**

Run: `node --test src/app/AnalysisPanel.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: FAIL，`chart-line-hit-area` 数量为 0。

- [ ] **Step 3: 增加共用 SVG tooltip 与指针坐标换算**

在 `AnalysisPanel.jsx` 中将 React 导入改为 `import React, { useState } from "react";`，导入 `nearestValidPointIndex`，并加入：

```jsx
function pointerXInViewBox(event) {
  const svg = event.currentTarget.ownerSVGElement;
  const bounds = svg?.getBoundingClientRect();
  if (!bounds?.width) return null;
  return ((event.clientX - bounds.left) / bounds.width) * chartWidth;
}

function SvgValueTooltip({ x, y, value }) {
  const width = Math.max(72, value.length * 15 + 24);
  const centerX = Math.min(chartWidth - pad.right - width / 2, Math.max(pad.left + width / 2, x));
  const top = y - 42 < pad.top ? y + 14 : y - 36;
  return (
    <g className="chart-value-tooltip" transform={`translate(${centerX - width / 2} ${top})`} pointerEvents="none">
      <rect width={width} height="28" rx="5" />
      <text x={width / 2} y="19" textAnchor="middle">{value}</text>
    </g>
  );
}
```

- [ ] **Step 4: 为单折线实现最近点状态和透明命中层**

在 `LineMiniChart` 中维护 `{ x, y, value }` 状态。透明路径与可见路径使用相同 `d`：

```jsx
<path
  className="chart-line-hit-area"
  d={path}
  fill="none"
  stroke="transparent"
  strokeWidth="18"
  onPointerMove={(event) => {
    const pointerX = pointerXInViewBox(event);
    const index = pointerX === null ? null : nearestValidPointIndex(data, valueKey, pointerX, pad.left, plotWidth);
    if (index === null) return;
    const value = toNumber(data[index][valueKey]);
    const [x, y] = chartPoint(index, data.length, value, min, max).split(",").map(Number);
    setHover({ x, y, value: `${fmtNumber(value, 1)} ${unit}` });
  }}
/>
```

在 SVG 的 `onPointerLeave` 清空状态，删除现有透明圆点内的原生 `<title>`，在可见折线与坐标文字之后渲染高亮圆点和 `SvgValueTooltip`。

- [ ] **Step 5: 为双折线分别实现速度与距离命中层**

抽取组件内的 `showSeriesValue(event, key, min, max, unit, digits)` 处理器，分别为速度路径和距离路径添加 `className="chart-line-hit-area"`，并用 `data-series="speed"`、`data-series="distance"` 区分序列。速度格式为 1 位小数加“节”，距离格式为 0 位小数加“海里”，tooltip 文本不拼接日期或另一序列值。

- [ ] **Step 6: 运行折线相关测试**

Run: `node --test src/app/analysisChartInteraction.test.js src/app/AnalysisPanel.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: 全部通过，静态标记中有 3 个折线命中层和 5 个竖向轴标题。

---

### Task 3: 柱状图 tooltip 与统一最优布局

**Files:**
- Modify: `scene/seasats-usv-track-alert-agent/src/app/AnalysisPanel.jsx`
- Modify: `scene/seasats-usv-track-alert-agent/src/app/AnalysisPanel.test.js`
- Modify: `scene/seasats-usv-track-alert-agent/src/styles/global.css`
- Modify: `scene/seasats-usv-track-alert-agent/src/styles/global.test.js`

**Interfaces:**
- Consumes: Task 2 的 `SvgValueTooltip`、现有柱体坐标与四图卡片结构。
- Produces: 柱体纵轴值 tooltip；桌面两列两行等高卡片；窄屏单列布局。

- [ ] **Step 1: 写失败的柱体与布局测试**

在 `AnalysisPanel.test.js` 主图表测试中加入：

```js
assert.ok((markup.match(/class="chart-bar-hit-area"/g) || []).length > 0);
```

将 `global.test.js` 的旧柱状图高度断言替换为：

```js
assert.match(css, /\.analysis-chart-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,[^}]*align-items:\s*stretch;/s);
assert.match(css, /\.analysis-chart-card\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*height:\s*100%;/s);
assert.match(css, /\.chart-value-tooltip rect\s*\{/);
assert.match(css, /@media \(max-width:\s*820px\)[\s\S]*\.analysis-chart-grid\s*\{\s*grid-template-columns:\s*1fr;/);
```

- [ ] **Step 2: 运行组件和样式测试并确认失败**

Run: `node --test src/app/AnalysisPanel.test.js src/styles/global.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: FAIL，缺少 `chart-bar-hit-area`、卡片 flex 等高规则和 tooltip 样式。

- [ ] **Step 3: 为柱体增加只含纵轴值的 tooltip**

在 `BarMiniChart` 中维护 hover 状态。柱体 `rect` 增加 `className="chart-bar-hit-area"`、`onPointerEnter` 与 `onPointerMove`，状态值为：

```js
setHover({
  x: x + barWidth / 2,
  y,
  value: fmtNumber(value, 0),
});
```

在 SVG `onPointerLeave` 时清空状态，移除柱体中的原生 `<title>`，最后渲染 `SvgValueTooltip`。零值柱保持至少 4 SVG 单位的可命中高度并显示 `0`。

- [ ] **Step 4: 统一轴边距和卡片对齐**

将四图共用边距设为足够容纳双轴标题与刻度的对称值，并把轴标题放在安全区：

```js
const pad = { top: 22, right: 76, bottom: 40, left: 76 };
const axisTitleX = 18;
```

左轴标题使用 `x={axisTitleX}`，右轴标题使用 `x={chartWidth - axisTitleX}`；右轴最大刻度位于 `chartWidth - pad.right + 10`，避免与右轴标题重叠。

在 `global.css` 中应用：

```css
.analysis-chart-grid { align-items: stretch; }
.analysis-chart-card { display: flex; flex-direction: column; height: 100%; }
.analysis-chart-card .analysis-line-chart { flex: 0 0 auto; }
.analysis-chart-stats { margin-top: auto; padding-top: 8px; }
.chart-line-hit-area { cursor: crosshair; pointer-events: stroke; }
.chart-bar-hit-area { cursor: pointer; }
.chart-value-tooltip rect { fill: rgba(2, 6, 23, 0.96); stroke: rgba(103, 232, 249, 0.75); }
.chart-value-tooltip text { fill: #f8fafc; font-size: 17px; font-weight: 700; }
```

保留现有 `@media (max-width: 820px)` 下 `.analysis-chart-grid { grid-template-columns: 1fr; }`。

- [ ] **Step 5: 运行定向测试**

Run: `node --test src/app/analysisChartInteraction.test.js src/app/AnalysisPanel.test.js src/styles/global.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: 全部通过。

- [ ] **Step 6: 运行项目完整测试**

Run: `npm test`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: 0 failed。

- [ ] **Step 7: 运行生产构建**

Run: `npm run build`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: Vite build 成功生成 `dist`，无编译错误。

- [ ] **Step 8: 浏览器视觉与交互验证**

启动本地应用，打开右侧栏第一栏的综合分析弹窗，验证：桌面为整齐的 2×2 图表网格；窄屏为单列；5 个纵轴标题均竖排且不与刻度重叠；速度、距离两条折线分别显示最近点的单个纵轴值；柱体只显示整数；tooltip 在首尾数据点和最高点附近不越界。

- [ ] **Step 9: 检查最终差异且不覆盖现有用户改动**

Run: `git diff --check -- scene/seasats-usv-track-alert-agent/src/app/AnalysisPanel.jsx scene/seasats-usv-track-alert-agent/src/app/AnalysisPanel.test.js scene/seasats-usv-track-alert-agent/src/app/analysisChartInteraction.js scene/seasats-usv-track-alert-agent/src/app/analysisChartInteraction.test.js scene/seasats-usv-track-alert-agent/src/styles/global.css scene/seasats-usv-track-alert-agent/src/styles/global.test.js`

Expected: 无空白错误；`git diff` 中保留实施前已存在的分析面板、样式及测试改动。
