# 无人艇跟监告警智能体 — 改造设计

> 日期：2026-07-01
> 改造对象：`scene/seasats-test-craft-monitor`（原 SEASATS 测试艇活动监测）
> 关联前序设计：`2026-07-01-seasats-test-craft-monitor-design.md`

## 1. 概述

将现有「SEASATS 测试艇活动监测」改造为**无人艇跟监告警智能体**。在保留现有轨迹/区域/AIS 中断判据的基础上，新增：以**中国领海基线**为参照的 200 海里接近告警（三级 + 动效）、点击告警弹出的图形化小卡片、仪表盘式可视化（少文字多图表），以及规则模板生成的智能体总结分析。

整体方向：**少文字、多图表/图标/数字**。删掉密集文字面板。

## 2. 背景与现状

现有项目为纯前端 React 18 + Vite + MapLibre GL 静态应用，无后端、无 API 依赖。

- `src/logic/domain.js`：已有 `haversineNm`、`splitTrackSegments`、`detectAisGaps`、`buildAlerts`、`analyzePayload`、`scoreTarget`。`segment` 已含 `durationMinutes`、`maxSpeedKn`、`lowSpeedMinutes`、`pathDisplacementRatio`。
- `src/logic/mapData.js`：构建 GeoJSON（目标点、轨迹段、AIS 缺口、告警点、监测区域）。
- `src/app/MapPanel.jsx`：MapLibre + Esri 卫星底图，已有轨迹/目标/告警/区域图层与选中高亮。
- `src/app/App.jsx`：加载 `seasatsPayload.json`，渲染目标列表、告警列表、地图。
- 数据：`trackPoints` 19091 点（几乎全为 `mmsi=338414915` SEASATS 55，波斯湾巴林附近）；`targets` 79 个最新位置；`monitoredAreas` 4 个 radiusNm=3 小测试点。
- **数据现实**：现有目标活动于波斯湾/北美，距中国海岸数千海里，**不会触发国土告警**。这是预期行为——本应用是通用跟监告警模板，逻辑须正确，数据可替换。

## 3. 目标 / 非目标

### 目标
1. 改名「无人艇跟监告警智能体」，贯穿标题、UI、README。
2. 点击 AIS 开闭异常告警 → 图形化小卡片（速度 / 方向 / 起始位置 / 中断时长）。
3. 国土 200 海里接近告警，三级（高/中/低），脉冲动效。
4. UI 简化：大数字、图标、色块、进度条、罗盘、迷你图，取代文字句子。
5. 智能体总结分析（规则模板）：威胁等级 + 关键发现 + 建议。
6. 轨迹按速度渐变着色；最快段高亮；活动天数/报点统计。

### 非目标（YAGNI，明确排除）
- 不接入 LLM / 后端 API（保持纯前端静态边界）。
- 不做国土参数化/多国切换（国土固定为中国）。
- 不重写现有低速/往返/AIS 中断判据，只扩展。
- 不解析新的 Excel；`seasatsPayload.json` 结构不变（只读取）。

## 4. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 国土基准 | 中国海岸/领海基线（内置静态折线，无外网依赖） |
| 总结分析生成方式 | 规则模板（纯前端，无 API） |
| 三级阈值（默认，进 parameters 可调） | 高 < 80 NM / 中 80–140 NM / 低 140–200 NM |
| 告警卡片形态 | 非模态浮层，全图形化 |
| 整体风格 | 少文字、多图表 |

## 5. 详细设计

### 5.1 数据层

**➕ `src/data/chinaCoast.json`** — 中国领海基线/海岸线简化折线。

结构（GeoJSON LineString 数组，便于单测与复用）：

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "id": "mainland-north", "name": "大陆北部岸段" },
      "geometry": { "type": "LineString", "coordinates": [[lon, lat], ...] } }
  ]
}
```

- 来源：公开领海基线声明坐标 + 自然海岸简化（实现时从公开坐标集生成）。
- 采样密度：相邻点间距 ≤ 10 NM，使「点到最近顶点」近似误差 < 5%。
- 覆盖：中国大陆海岸 + 海南 + 台湾 + 主要近海岛屿领海基线关键拐点。
- 作为静态资源随 app 打包，浏览器 `fetch` 或 `import` 加载。

`seasatsPayload.json` **只读不变**。

### 5.2 逻辑层（`src/logic/domain.js` 扩展）

新增纯函数，全部可单测：

#### 5.2.1 海岸距离

```js
// 点到大圆段(p1->p2)的最近距离(NM)，返回 {distanceNm, point:[lon,lat]}
export function nearestOnSegmentNm(point, p1, p2) { /* cross-track + along-track */ }

// 点到海岸折线集合的最近距离，返回 {distanceNm, point:[lon,lat], segmentId}
export function nearestPointOnCoastNm(point, coast) {
  // 遍历所有 LineString 的所有段，取最小 nearestOnSegmentNm
}
```

算法：球面 cross-track距离（点到大圆的垂直距离）+ along-track（垂足落点），垂足落在段外则取段端点。复用 `EARTH_RADIUS_NM`。

#### 5.2.2 接近分级

```js
export const COAST_LEVELS = { high: "high", medium: "medium", low: "low" };

// 按距离与警戒范围判定等级；超出范围返回 null
export function coastProximityLevel(distanceNm, params) {
  if (distanceNm == null || distanceNm >= params.coastAlertRangeNm) return null;
  if (distanceNm < params.coastAlertHighNm) return "high";      // <80
  if (distanceNm < params.coastAlertMediumNm) return "medium";  // <140
  return "low";                                                  // 140–200
}
```

`DEFAULT_PARAMETERS` 新增：
```js
coastAlertRangeNm: 200,
coastAlertHighNm: 80,
coastAlertMediumNm: 140,
```

#### 5.2.3 目标指标补算（`analyzePayload` 内，每目标）

遍历该目标全部轨迹点，计算：
- `minCoastDistanceNm`：到海岸最近距离
- `nearestCoastPoint`：`[lon,lat]` + 对应时间
- `maxSpeedSegment`：相邻点间对地速度最高的段 `{fromPoint, toPoint, speedKn, time}`
- `activeDays`：不同 UTC 日期数
- `reportCount`：轨迹点总数
- `avgSpeedKn`：全程平均速度

这些字段并入 `target` 对象。

#### 5.2.4 国土告警（`buildAlerts` 增项）

当 `target.minCoastDistanceNm < coastAlertRangeNm` 时生成：

```js
{
  id: `${mmsi}-coast-proximity`,
  type: "coast-proximity",
  level: coastProximityLevel(minCoastDistanceNm, params),  // high|medium|low
  severity: level === "high" ? "critical" : level === "medium" ? "warning" : "info",
  title: "接近国土警戒区",
  summary: `${name} 距中国海岸最近 ${minCoastDistanceNm.toFixed(1)} 海里`,
  time: nearestCoastPoint.time,
  lon/lat: nearestCoastPoint,
  evidence: [...]
}
```

`coast-proximity` 告警参与 `scoreTarget`（high +25 / medium +15 / low +8）与 `classifyStatus`（high 视为 critical → 「异常行为目标」）。

#### 5.2.5 AIS 卡片数据

`ais-gap` 告警增补卡片所需字段（从缺口前后轨迹点取）：
- `preSpeedKn` / `postSpeedKn`：中断前/后瞬时速度
- `segmentAvgSpeedKn`：缺口所在段平均速度（区别于目标全程 `avgSpeedKn`）
- `courseDeg`：中断前航向（方向箭头）
- `trackOrigin`：该目标整条轨迹首次出现点 `{lon,lat,time}`（起始位置）

#### 5.2.6 智能体总结（`buildSummary`）

```js
export function buildSummary(analysis, params) {  // → {threatLevel, threatLabel, findings[], advice[]} }
```

规则（确定、可测）：
- `threatLevel`：`critical|high|medium|low|none`
  - 任一目标 `coast-proximity` high，或 AIS gap > 6h，或 `异常行为目标` → critical
  - coast medium / 反复活动 → high
  - 其余按 score 阈值递降
- `findings[]`：从 analysis 中抽取的关键事实条目（最近距离、最快目标、AIS 中断数、活跃目标数），每条带图标语义。
- `advice[]`：基于规则的建议（如「重点跟监 XXX，距海岸 XX 海里」「N 起 AIS 异常需核查」）。

输出是结构化对象，由 UI 渲染为图标+短句卡片，不输出长段落。

### 5.3 地图层（`src/app/MapPanel.jsx` 扩展）

- ➕ `coast-line` 源/图层：中国海岸折线（细线，醒目色）。
- ➕ `coast-buffer` 图层：200 NM 警戒带（coast 线 outward buffer 近似为半透明环，或用 `line-offset`/多边形缓冲）。
- ➕ `nearest-point` 图层：选中目标的国土最近点标注。
- 轨迹着色：`track-segments` 改为**抽稀 + 分段着色**——对每条轨迹按时间/距离抽稀（每 N 分钟或每 M 个点取一个代表点，段数控制在数百内，避免 feature 爆炸），相邻代表点连成短段（每个 feature 带 `speedKn` 属性 = 该段对地速度），图层 paint 用 `interpolate` 表达式按 `speedKn` 着色：蓝 `#3b82f6`(慢) → 黄 → 红 `#ef4444`(快)。注：MapLibre `line-gradient` 基于 line-progress 无法按速度着色，故用分段 feature + 属性插值。
- ➕ 最快段：选中目标时单独高亮 `maxSpeedSegment`（粗红线）。
- 告警脉冲动效：`coast-proximity` 与 `ais-gap` 告警点用 pulsing symbol 图层（CSS/MapLibre 自定义图层或定时 `circle-radius` 动画），等级越高脉冲越快、颜色越红（high 红波纹、medium 橙、low 黄）。
- 点击 `alert-points` → 触发 `onAction({type:"select-alert", id})`，由 App 弹卡片。

### 5.4 UI 层（`src/app/App.jsx` + 新组件）

**➕ `src/app/AlertCard.jsx`** — 非模态浮层（点击 AIS 异常告警触发）：
- ⚡ 速度：大数字（`avgSpeedKn`）+ 迷你条形（pre→post 对比）
- ➤ 方向：旋转箭头图标（`courseDeg`）+ 角度
- 📍 起始位置：`trackOrigin` 坐标 + 微缩定位标
- ⏱ 中断时长：`gapMinutes` 色块（>6h 红、>30min 橙）
- 标题图标 + 一行简述，点空白关闭

**➕ `src/app/SummaryPanel.jsx`** — 智能体总结分析（顶部或底部固定区）：
- 威胁等级大徽章（色+图标，none/low/medium/high/critical）
- findings 图标列表（每条一个图标+短句+数字）
- advice 建议条目
- 全图形，无段落文字

**目标详情**（右侧选中目标）改为仪表盘式：
- 国土距离进度条（0–200NM，到红区高亮）
- 速度条（最快 vs 平均）
- 活动天数 + 报点数大数字徽章
- 方向罗盘（图标按 `courseDeg` 旋转）
- 最近点 / 最快段按钮（点击聚焦地图）

**目标列表/告警列表**：状态用色点+图标；告警条左侧色条标三级紧急度；关键数字（最近距离、最快速度）用徽章；不用长句子。

**改名**：`index.html` title、App 标题、README、面板标题 → 「无人艇跟监告警智能体」。

### 5.5 样式（`src/styles/global.css`）

- ➕ `@keyframes` 脉冲/呼吸（告警点、列表项、high 级波纹）。
- ➕ 卡片、仪表盘、进度条、罗盘、徽章样式。
- 保持现有暗色/科技风配色，新增三级色：high `#ef4444` / medium `#f59e0b` / low `#eab308`。

## 6. 数据流

```
seasatsPayload.json ─┐
chinaCoast.json ─────┴─► analyzePayload(payload, coast) ─► analysis
                              │  (targets 含 minCoastDistance/maxSpeedSegment/activeDays...,
                              │   alerts 含 coast-proximity+level & ais-gap 卡片字段,
                              │   summary = buildSummary(analysis))
                              ▼
                         App state ─► MapPanel(图层/脉冲/速度着色/点击)
                                   ─► 目标列表 / 告警列表(图标徽章)
                                   ─► SummaryPanel(总结)
                                   ─► AlertCard(点击 AIS 告警弹出)
```

`analyzePayload` 签名从 `(payload)` 扩展为 `(payload, coast?)`；`coast` 为空时跳过国土距离/告警（向后兼容，便于测试与无数据降级）。

## 7. 测试策略（沿用 `node:test`）

**`src/logic/domain.test.js` 新增**：
- `nearestOnSegmentNm`：已知三点（垂足在段内/段外）断言距离与落点。
- `nearestPointOnCoastNm`：小 coast（2 段）断言最近段与距离。
- `coastProximityLevel`：70→high、100→medium、160→low、250→null。
- `analyzePayload` 带 coast：目标最近距离字段、`coast-proximity` 告警 level、score/status 变化。
- `buildSummary`：构造 critical/high/medium 场景断言 threatLevel 与 findings 数。

**`src/logic/mapData.test.js` 新增**：
- 轨迹按速度着色的数据组装（每段拆点+速度属性）。
- coast 线/最近点 GeoJSON 输出。

回归：现有低速/往返/AIS gap/评分用例保持通过。

## 8. 文件清单

| 文件 | 动作 |
|---|---|
| `src/data/chinaCoast.json` | ➕ 新增 |
| `src/logic/domain.js` | ✏️ 扩展（距离/分级/指标/告警/总结） |
| `src/logic/domain.test.js` | ✏️ 加测试 |
| `src/logic/mapData.js` | ✏️ 速度着色、coast/最近点/最快段 GeoJSON |
| `src/logic/mapData.test.js` | ✏️ 加测试 |
| `src/app/MapPanel.jsx` | ✏️ coast 图层、警戒带、脉冲、速度着色、最快段、点击→卡片 |
| `src/app/App.jsx` | ✏️ 改名、接 AlertCard/SummaryPanel、仪表盘详情、列表图形化 |
| `src/app/AlertCard.jsx` | ➕ 新增 |
| `src/app/SummaryPanel.jsx` | ➕ 新增 |
| `src/styles/global.css` | ✏️ 动效、卡片、仪表盘、徽章 |
| `index.html` / `README.md` | ✏️ 改名 |

## 9. 风险与权衡

- **当前数据不触发国土告警**：预期行为（模板逻辑正确）。演示时说明数据可替换；逻辑/动效/卡片可用 AIS 异常与现有告警演示。
- **海岸折线精度**：简化折线误差 < 5%，满足告警粒度（不是航海级）。如需更精，提高采样密度（文件变大，可接受）。
- **速度着色 feature 数量**：通过抽稀（段数控制在数百）避免上万 feature 拖慢渲染；抽稀粒度使损失可接受。
- **脉冲动效性能**：MapLibre 原生不支持动画 paint，用自定义 pulsing symbol 图层（额外 canvas 层）或定时器驱动 `circle-radius`；限制只对告警点（少量）启用。

## 10. 验收标准

1. 标题/README 显示「无人艇跟监告警智能体」。
2. 加载 chinaCoast 后，每目标展示到国土最近距离（数字+进度条），离岸 <200NM 生成三级告警（单测覆盖分级）。
3. 点击 AIS 异常告警弹出图形化卡片，含速度/方向/起始位置/中断时长。
4. 告警点有脉冲动效，三级颜色区分，列表项按紧急度呼吸。
5. SummaryPanel 显示威胁等级徽章 + findings + advice（规则生成）。
6. 选中目标右侧为仪表盘（无长句子），轨迹按速度着色，最快段高亮。
7. `npm test` 全绿（含新增用例）；`npm run build` 成功。
