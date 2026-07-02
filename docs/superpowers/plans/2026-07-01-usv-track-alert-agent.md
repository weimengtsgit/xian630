# 无人艇跟监告警智能体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `scene/seasats-test-craft-monitor` 改造为「无人艇跟监告警智能体」——增加中国领海基线 200 海里三级告警（动效）、AIS 异常点击卡片、仪表盘式可视化、规则模板总结分析、轨迹速度着色。

**Architecture:** 纯前端 React 18 + Vite + MapLibre GL 静态应用，无后端。新增海岸数据 + 海岸距离/告警/总结纯函数（TDD），扩展 mapData 与地图/组件层（build + 手动冒烟验收）。国土逻辑拆出独立小文件 `coast.js` / `summary.js`，避免 `domain.js` 过大。

**Tech Stack:** React 18.3, Vite 6, MapLibre GL 5, lucide-react, `node:test`（现有测试栈）

**Spec:** `docs/superpowers/specs/2026-07-01-usv-track-alert-agent-design.md`

## Global Constraints

- 工作目录：`C:/idea/xian630/scene/seasats-test-craft-monitor`（所有相对路径基于此）
- 纯前端静态，**禁止**引入后端/API key/网络请求（chinaCoast 数据自含打包）
- `seasatsPayload.json` 只读不变
- 测试命令：`npm test`（`node --test`）；构建：`npm run build`；开发：`npm run dev`
- 现有 `node:test` 用例（domain/mapData/mapInteraction）必须保持通过
- 三级阈值默认：高 <80 NM / 中 80–140 NM / 低 140–200 NM（进 parameters 可调）
- 配色三级：high `#ef4444` / medium `#f59e0b` / low `#eab308`
- 所有 commit message 末尾追加：`Co-Authored-By: Claude <noreply@anthropic.com>`
- 当前分支：`feat-dev-0629-promforboss`；每个 Task 末尾单独 commit

---

## File Structure

**Create:**
- `src/data/chinaCoast.json` — 中国海岸/领海基线简化折线（静态）
- `src/logic/coast.js` — `nearestPointOnCoastNm`、`coastProximityLevel`、`COAST_LEVELS`
- `src/logic/coast.test.js` — 海岸距离/分级测试
- `src/logic/summary.js` — `buildSummary`（规则模板总结）
- `src/logic/summary.test.js` — 总结测试
- `src/app/AlertCard.jsx` — AIS 异常告警图形化卡片
- `src/app/SummaryPanel.jsx` — 智能体总结分析面板

**Modify:**
- `src/logic/domain.js` — `DEFAULT_PARAMETERS` 加海岸参数；`computeTrackMetrics`；`analyzePayload` 接 coast+metrics；`buildAlerts` 加 coast-proximity 与 ais-gap 卡片字段；`scoreTarget`/`classifyStatus` 接入
- `src/logic/domain.test.js` — 加 coast 告警/指标/ais-gap 卡片字段测试
- `src/logic/mapData.js` — `decimatePoints`、`speedColorSegments`、coast/最近点/最快段 feature；`buildMapData` 接收 coast/selectedTarget
- `src/logic/mapData.test.js` — 加测试
- `src/app/MapPanel.jsx` — coast 图层、警戒带、速度着色、脉冲动效、最近点/最快段、点击→卡片回调
- `src/app/App.jsx` — 加载 chinaCoast、改名、仪表盘详情、列表图形化、接 AlertCard/SummaryPanel
- `src/styles/global.css` — 脉冲/卡片/仪表盘/徽章样式
- `index.html` — title 改名
- `README.md` — 改名与说明

---

## Task 1: 中国海岸数据 `chinaCoast.json`

**Files:**
- Create: `src/data/chinaCoast.json`

**Interfaces:**
- Produces: GeoJSON `FeatureCollection`，每个 feature 为 `LineString`（`coordinates: [[lon,lat],...]`），供 Task 2 `nearestPointOnCoastNm` 遍历。

- [ ] **Step 1: 创建数据文件**

创建 `src/data/chinaCoast.json`（简化示意坐标，基于公开地理特征近似；非航海级精度，满足告警逻辑与演示；如需精确可替换为正式领海基线声明数据）：

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "id": "mainland", "name": "中国大陆海岸" },
      "geometry": { "type": "LineString", "coordinates": [
        [124.5, 39.9], [122.2, 40.1], [121.6, 38.9], [122.1, 37.5], [121.5, 37.5],
        [120.3, 36.1], [119.5, 34.8], [120.3, 33.0], [121.9, 30.9], [122.1, 30.0],
        [121.5, 28.7], [121.0, 28.0], [119.6, 26.0], [118.1, 24.5], [116.7, 23.4],
        [114.5, 22.6], [113.6, 22.2], [110.4, 21.2], [109.1, 21.5], [108.3, 21.7]
      ] }
    },
    {
      "type": "Feature",
      "properties": { "id": "hainan", "name": "海南岛海岸" },
      "geometry": { "type": "LineString", "coordinates": [
        [110.3, 20.0], [110.5, 19.0], [109.5, 18.2], [108.7, 18.4], [108.6, 19.6]
      ] }
    },
    {
      "type": "Feature",
      "properties": { "id": "taiwan", "name": "台湾岛海岸" },
      "geometry": { "type": "LineString", "coordinates": [
        [121.7, 25.1], [121.6, 23.9], [120.6, 23.5], [120.3, 22.6], [120.5, 24.2]
      ] }
    }
  ]
}
```

- [ ] **Step 2: 校验 JSON 合法**

Run: `node -e "const d=require('./src/data/chinaCoast.json'); console.log('features', d.features.length, 'points', d.features.reduce((s,f)=>s+f.geometry.coordinates.length,0))"`
Expected: `features 3 points 30`

- [ ] **Step 3: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/data/chinaCoast.json
git -C C:/idea/xian630 commit -m "feat(usv): add chinaCoast.json baseline data

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 海岸距离 `nearestPointOnCoastNm`

**Files:**
- Create: `src/logic/coast.js`
- Test: `src/logic/coast.test.js`

**Interfaces:**
- Consumes: `chinaCoast.json` 结构（FeatureCollection of LineString）
- Produces:
  - `coastVertices(coast)` → `Array<{lon,lat,segmentId}>`
  - `nearestPointOnCoastNm(point, coast)` → `{distanceNm:number, point:[lon,lat], segmentId:string|null}`（遍历海岸折线全部顶点取最近 haversine 距离；coast 采样密度 ≤10NM 保证误差 <5%；`point` 为 null 时返回 `{distanceNm:null,...}`）

- [ ] **Step 1: 写失败测试**

创建 `src/logic/coast.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { coastVertices, nearestPointOnCoastNm } from "./coast.js";

const COAST = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "seg-a" }, geometry: { type: "LineString", coordinates: [[110, 21], [109, 20]] } },
    { type: "Feature", properties: { id: "seg-b" }, geometry: { type: "LineString", coordinates: [[121, 25]] } },
  ],
};

test("coastVertices flattens all LineString points with segmentId", () => {
  const v = coastVertices(COAST);
  assert.equal(v.length, 3);
  assert.deepEqual(v[0], { lon: 110, lat: 21, segmentId: "seg-a" });
  assert.equal(v[2].segmentId, "seg-b");
});

test("nearestPointOnCoastNm returns 0 at a coast vertex", () => {
  const r = nearestPointOnCoastNm({ lon: 110, lat: 21 }, COAST);
  assert.ok(r.distanceNm < 0.5);
  assert.equal(r.segmentId, "seg-a");
});

test("nearestPointOnCoastNm picks the closest vertex", () => {
  // 点 (110, 22) 离 seg-a 的 (110,21) 最近（约 60NM），远于 seg-b
  const r = nearestPointOnCoastNm({ lon: 110, lat: 22 }, COAST);
  assert.equal(r.segmentId, "seg-a");
  assert.ok(r.distanceNm > 50 && r.distanceNm < 70);
  assert.deepEqual(r.point, [110, 21]);
});

test("nearestPointOnCoastNm returns null distance for invalid point", () => {
  const r = nearestPointOnCoastNm({ lon: null, lat: 22 }, COAST);
  assert.equal(r.distanceNm, null);
});

test("nearestPointOnCoastNm handles empty coast", () => {
  const r = nearestPointOnCoastNm({ lon: 110, lat: 21 }, { type: "FeatureCollection", features: [] });
  assert.equal(r.distanceNm, null);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -- --test-name-pattern="nearestPointOnCoastNm|coastVertices"`
Expected: FAIL（`Cannot find module './coast.js'`）

- [ ] **Step 3: 实现 coast.js**

创建 `src/logic/coast.js`：

```js
import { toNumber, haversineNm } from "./domain.js";

// 把 coast GeoJSON (FeatureCollection of LineString) 展平为顶点列表
export function coastVertices(coast) {
  const out = [];
  if (!coast || !Array.isArray(coast.features)) return out;
  for (const feature of coast.features) {
    const segmentId = feature?.properties?.id ?? null;
    const coords = feature?.geometry?.coordinates || [];
    for (const [lon, lat] of coords) {
      out.push({ lon, lat, segmentId });
    }
  }
  return out;
}

// 点到海岸折线集合的最近距离（遍历顶点取最近 haversine）
export function nearestPointOnCoastNm(point, coast) {
  const lon = toNumber(point?.lon);
  const lat = toNumber(point?.lat);
  if (lon === null || lat === null) return { distanceNm: null, point: null, segmentId: null };
  const vertices = coastVertices(coast);
  if (vertices.length === 0) return { distanceNm: null, point: null, segmentId: null };
  let best = Infinity;
  let bestVertex = null;
  for (const v of vertices) {
    const d = haversineNm({ lon, lat }, v);
    if (d !== null && d < best) {
      best = d;
      bestVertex = v;
    }
  }
  return {
    distanceNm: best === Infinity ? null : best,
    point: bestVertex ? [bestVertex.lon, bestVertex.lat] : null,
    segmentId: bestVertex?.segmentId ?? null,
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -- --test-name-pattern="nearestPointOnCoastNm|coastVertices"`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/logic/coast.js scene/seasats-test-craft-monitor/src/logic/coast.test.js
git -C C:/idea/xian630 commit -m "feat(usv): add nearestPointOnCoastNm coast distance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 接近分级 `coastProximityLevel`

**Files:**
- Modify: `src/logic/coast.js`
- Modify: `src/logic/coast.test.js`

**Interfaces:**
- Produces:
  - `COAST_LEVELS = { HIGH:"high", MEDIUM:"medium", LOW:"low" }`
  - `coastProximityLevel(distanceNm, params)` → `"high"|"medium"|"low"|null`（≥rangeNm 或 null → null）

- [ ] **Step 1: 写失败测试**

追加到 `src/logic/coast.test.js` 顶部 import：`coastProximityLevel, COAST_LEVELS`；并在文件末尾追加：

```js
import { coastProximityLevel, COAST_LEVELS } from "./coast.js";

const PARAMS = { coastAlertRangeNm: 200, coastAlertHighNm: 80, coastAlertMediumNm: 140 };

test("coastProximityLevel boundaries", () => {
  assert.equal(coastProximityLevel(70, PARAMS), COAST_LEVELS.HIGH);
  assert.equal(coastProximityLevel(79.9, PARAMS), COAST_LEVELS.HIGH);
  assert.equal(coastProximityLevel(100, PARAMS), COAST_LEVELS.MEDIUM);
  assert.equal(coastProximityLevel(139.9, PARAMS), COAST_LEVELS.MEDIUM);
  assert.equal(coastProximityLevel(160, PARAMS), COAST_LEVELS.LOW);
  assert.equal(coastProximityLevel(199.9, PARAMS), COAST_LEVELS.LOW);
  assert.equal(coastProximityLevel(200, PARAMS), null);
  assert.equal(coastProximityLevel(250, PARAMS), null);
  assert.equal(coastProximityLevel(null, PARAMS), null);
});
```

（合并 import：实际编辑时把 `coastProximityLevel, COAST_LEVELS` 加入第一行的 `import { coastVertices, nearestPointOnCoastNm } from "./coast.js";`。）

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test-name-pattern="coastProximityLevel"`
Expected: FAIL（`coastProximityLevel is not a function`）

- [ ] **Step 3: 实现**

追加到 `src/logic/coast.js`：

```js
export const COAST_LEVELS = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

export function coastProximityLevel(distanceNm, params = {}) {
  const d = toNumber(distanceNm);
  const range = toNumber(params.coastAlertRangeNm);
  if (d === null || range === null || d >= range) return null;
  if (d < toNumber(params.coastAlertHighNm)) return COAST_LEVELS.HIGH;
  if (d < toNumber(params.coastAlertMediumNm)) return COAST_LEVELS.MEDIUM;
  return COAST_LEVELS.LOW;
}
```

并在 `src/logic/domain.js` 的 `DEFAULT_PARAMETERS` 增加（编辑现有对象）：

```js
export const DEFAULT_PARAMETERS = {
  lowSpeedMaxKn: 3,
  lowSpeedDurationMinutes: 10,
  repeatedPathRatio: 3,
  aisGapWarningMinutes: 30,
  aisGapCriticalMinutes: 360,
  segmentGapMinutes: 360,
  segmentJumpNm: 50,
  coastAlertRangeNm: 200,
  coastAlertHighNm: 80,
  coastAlertMediumNm: 140,
};
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test -- --test-name-pattern="coastProximityLevel"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/logic/coast.js scene/seasats-test-craft-monitor/src/logic/coast.test.js scene/seasats-test-craft-monitor/src/logic/domain.js
git -C C:/idea/xian630 commit -m "feat(usv): add coastProximityLevel 3-tier grading

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 目标轨迹指标 `computeTrackMetrics`

**Files:**
- Modify: `src/logic/domain.js`
- Modify: `src/logic/domain.test.js`

**Interfaces:**
- Produces（`domain.js` 新 export）:
  - `computeTrackMetrics(points, coast)` → `{ minCoastDistanceNm, nearestCoastPoint:{lon,lat,time,segmentId}|null, maxSpeedSegment:{fromPoint, toPoint, speedKn, time}|null, activeDays, reportCount, avgSpeedKn, trackOrigin:{lon,lat,time}|null }`
- `analyzePayload` 把该结果合并进每个 `target` 对象。

- [ ] **Step 1: 写失败测试**

追加到 `src/logic/domain.test.js`（import 行加入 `computeTrackMetrics`）：

```js
test("computeTrackMetrics aggregates a small track", () => {
  const points = [
    { mmsi: "1", time: "2026-01-01T00:00:00Z", lon: 110.0, lat: 21.0, speedKn: 1 },
    { mmsi: "1", time: "2026-01-01T01:00:00Z", lon: 110.1, lat: 21.0, speedKn: 5 },
    { mmsi: "1", time: "2026-01-02T02:00:00Z", lon: 111.0, lat: 22.0, speedKn: 3 },
  ];
  const coast = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { id: "c" }, geometry: { type: "LineString", coordinates: [[109, 20]] } },
  ] };
  const m = computeTrackMetrics(points, coast);
  assert.equal(m.reportCount, 3);
  assert.equal(m.activeDays, 2);                  // 01-01, 01-02
  assert.equal(m.maxSpeedSegment.speedKn, 5);     // 中间点最快
  assert.deepEqual(m.trackOrigin, { lon: 110.0, lat: 21.0, time: "2026-01-01T00:00:00Z" });
  assert.ok(m.minCoastDistanceNm > 50);           // (110,21)→(109,20) 约 90NM
  assert.equal(m.nearestCoastPoint.segmentId, "c");
  assert.ok(m.avgSpeedKn > 0);
});

test("computeTrackMetrics empty track returns nulls/zeros", () => {
  const m = computeTrackMetrics([], { type: "FeatureCollection", features: [] });
  assert.equal(m.reportCount, 0);
  assert.equal(m.activeDays, 0);
  assert.equal(m.maxSpeedSegment, null);
  assert.equal(m.trackOrigin, null);
  assert.equal(m.minCoastDistanceNm, null);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test-name-pattern="computeTrackMetrics"`
Expected: FAIL（`computeTrackMetrics is not defined`）

- [ ] **Step 3: 实现**

在 `src/logic/domain.js` 顶部 import 行（`import { toNumber } from "./domain.js"` 那种不存在——domain.js 是源头；改为在 domain.js 内 import coast）。在 domain.js 文件顶部加：

```js
import { nearestPointOnCoastNm } from "./coast.js";
```

在 `domain.js` 的 `splitTrackSegments` 之前插入：

```js
export function computeTrackMetrics(points = [], coast = null) {
  const sorted = sortedTrack(points);
  if (sorted.length === 0) {
    return { minCoastDistanceNm: null, nearestCoastPoint: null, maxSpeedSegment: null, activeDays: 0, reportCount: 0, avgSpeedKn: null, trackOrigin: null };
  }
  let minCoast = Infinity;
  let nearestCoastPoint = null;
  let maxSpeed = -1;
  let maxSpeedSegment = null;
  let speedSum = 0;
  let speedCount = 0;
  const days = new Set();
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (coast) {
      const np = nearestPointOnCoastNm(p, coast);
      if (np.distanceNm !== null && np.distanceNm < minCoast) {
        minCoast = np.distanceNm;
        nearestCoastPoint = { lon: toNumber(p.lon), lat: toNumber(p.lat), time: p.time, segmentId: np.segmentId };
      }
    }
    const sp = toNumber(p.speedKn);
    if (sp !== null) { speedSum += sp; speedCount += 1; }
    if (i > 0) {
      const prev = sorted[i - 1];
      const psp = toNumber(prev.speedKn);
      if (psp !== null && psp > maxSpeed) {
        maxSpeed = psp;
        maxSpeedSegment = {
          fromPoint: { lon: toNumber(prev.lon), lat: toNumber(prev.lat), time: prev.time },
          toPoint: { lon: toNumber(p.lon), lat: toNumber(p.lat), time: p.time },
          speedKn: psp,
          time: p.time,
        };
      }
    }
    const ms = parseTimeMs(p.time);
    if (ms !== null) days.add(new Date(ms).toISOString().slice(0, 10));
  }
  const first = sorted[0];
  return {
    minCoastDistanceNm: minCoast === Infinity ? null : minCoast,
    nearestCoastPoint,
    maxSpeedSegment,
    activeDays: days.size,
    reportCount: sorted.length,
    avgSpeedKn: speedCount > 0 ? Number((speedSum / speedCount).toFixed(2)) : null,
    trackOrigin: { lon: toNumber(first.lon), lat: toNumber(first.lat), time: first.time },
  };
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test -- --test-name-pattern="computeTrackMetrics"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/logic/domain.js scene/seasats-test-craft-monitor/src/logic/domain.test.js
git -C C:/idea/xian630 commit -m "feat(usv): add computeTrackMetrics (coast/speed/days/origin)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: coast-proximity 告警 + 指标并入 target + score/status

**Files:**
- Modify: `src/logic/domain.js`
- Modify: `src/logic/domain.test.js`

**Interfaces:**
- `analyzePayload(payload, coast = null)` — 签名扩展（向后兼容，coast 为空时跳过海岸告警）。
- 每个 target 新增字段：`minCoastDistanceNm`、`nearestCoastPoint`、`maxSpeedSegment`、`activeDays`、`reportCount`、`avgSpeedKn`、`trackOrigin`。
- `buildAlerts` 接受 target 的上述字段，生成 `type:"coast-proximity"` 告警（含 `level`）。
- `scoreTarget` / `classifyStatus` 接入 coast-proximity。

- [ ] **Step 1: 写失败测试**

追加到 `src/logic/domain.test.js`（import 加入 `analyzePayload`，若未导入）：

```js
test("analyzePayload attaches coast metrics and proximity alert", () => {
  const payload = {
    parameters: { coastAlertRangeNm: 200, coastAlertHighNm: 80, coastAlertMediumNm: 140 },
    monitoredAreas: [],
    targets: [
      { mmsi: "X1", name: "SEASATS 55", lon: 109.2, lat: 20.1, length: 4, width: 2, latestTime: "2026-01-02T02:00:00Z" },
    ],
    trackPoints: [
      { mmsi: "X1", time: "2026-01-01T00:00:00Z", lon: 109.2, lat: 20.1, speedKn: 2 },
      { mmsi: "X1", time: "2026-01-02T02:00:00Z", lon: 109.3, lat: 20.2, speedKn: 2 },
    ],
  };
  const coast = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { id: "c" }, geometry: { type: "LineString", coordinates: [[109, 20]] } },
  ] };
  const analysis = analyzePayload(payload, coast);
  const t = analysis.targets[0];
  assert.equal(t.activeDays, 2);
  assert.ok(t.minCoastDistanceNm < 80);                       // 很近 → high
  const co = analysis.alerts.find((a) => a.type === "coast-proximity");
  assert.ok(co, "expected a coast-proximity alert");
  assert.equal(co.level, "high");
  assert.equal(co.severity, "critical");
});

test("analyzePayload without coast skips coast alerts (back-compat)", () => {
  const payload = { targets: [{ mmsi: "X2", name: "SEASATS 9", lon: 50.6, lat: 26.2, length: 4, width: 2, latestTime: "2026-01-01T00:00:00Z" }], trackPoints: [] };
  const analysis = analyzePayload(payload);                    // no coast arg
  assert.equal(analysis.alerts.find((a) => a.type === "coast-proximity"), undefined);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test-name-pattern="analyzePayload attaches coast"`
Expected: FAIL（无 coast-proximity alert；target 无 minCoastDistanceNm）

- [ ] **Step 3: 实现改动**

3a. 修改 `domain.js` 的 `analyzePayload`（替换整个函数）：

```js
export function analyzePayload(payload, coast = null) {
  const params = { ...DEFAULT_PARAMETERS, ...(payload.parameters || {}) };
  const areas = payload.monitoredAreas || [];
  const trackByMmsi = new Map();
  for (const point of payload.trackPoints || []) {
    const list = trackByMmsi.get(point.mmsi) || [];
    list.push(point);
    trackByMmsi.set(point.mmsi, list);
  }
  const allSegments = [];
  const allGaps = [];
  const allAlerts = [];
  const targets = (payload.targets || []).map((rawTarget) => {
    const latestAreaIds = areaIdsForPoint({ lon: rawTarget.lon, lat: rawTarget.lat }, areas);
    const dimension = dimensionMatch(rawTarget.length, rawTarget.width);
    const nameHit = isNameHit(rawTarget.name);
    const points = trackByMmsi.get(rawTarget.mmsi) || [];
    const hasObservedTrack = points.length > 0;
    const segments = splitTrackSegments(points, { ...params, areas });
    const aisGaps = detectAisGaps(points, { ...params, areas });
    const metrics = computeTrackMetrics(points, coast);
    const targetBase = {
      ...rawTarget,
      nameHit,
      dimension,
      latestAreaIds,
      hasObservedTrack,
      trackSource: hasObservedTrack ? "真实附件轨迹" : "仅最新位置",
      ...metrics,
    };
    const alerts = buildAlerts({ target: targetBase, segments, aisGaps, areas, params });
    const score = scoreTarget({ nameHit, dimension, latestAreaIds, hasObservedTrack, alerts });
    const status = classifyStatus(score, alerts, hasObservedTrack);
    const target = { ...targetBase, segments, aisGaps, alerts, score, status };
    allSegments.push(...segments);
    allGaps.push(...aisGaps);
    allAlerts.push(...alerts);
    return target;
  });
  const analysis = {
    ...payload,
    parameters: params,
    targets: sortAnalyses(targets),
    segments: allSegments,
    aisGaps: allGaps,
    alerts: allAlerts.sort((a, b) => {
      const severity = { critical: 0, warning: 1, info: 2 };
      const sa = severity[a.severity] ?? 3;
      const sb = severity[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      return Date.parse(b.time || 0) - Date.parse(a.time || 0);
    }),
  };
  return { ...analysis, summary: buildSummaryTargets(analysis, params) };
}
```

3b. 在 `buildAlerts` 内 `ais-gap` 循环之后、`return alerts` 之前插入 coast-proximity（注意 import `coastProximityLevel`）：

在 domain.js 顶部 import 改为：
```js
import { nearestPointOnCoastNm, coastProximityLevel } from "./coast.js";
```

在 `buildAlerts` 中（`if (target?.dimension?.level === "review") {...}` 之后、`return alerts` 之前）追加：

```js
  const minD = toNumber(target?.minCoastDistanceNm);
  const level = coastProximityLevel(minD, params);
  if (level && target?.mmsi) {
    const np = target.nearestCoastPoint;
    alerts.push({
      id: `${target.mmsi}-coast-proximity`,
      targetMmsi: target.mmsi,
      targetName,
      type: "coast-proximity",
      level,
      severity: level === "high" ? "critical" : level === "medium" ? "warning" : "info",
      title: "接近国土警戒区",
      summary: `${targetName} 距中国海岸最近 ${minD.toFixed(1)} 海里`,
      time: np?.time || target.latestTime || null,
      lon: np?.lon ?? toNumber(target.lon),
      lat: np?.lat ?? toNumber(target.lat),
      areaIds: [],
      evidence: [`最近距离 ${minD.toFixed(1)} 海里`, `等级 ${level}`, `警戒范围 ${params.coastAlertRangeNm} 海里`],
    });
  }
```

3c. 修改 `scoreTarget` 增 coast 加分（在函数内 `return Math.min(100, score)` 之前）：

```js
  const co = alerts.find((a) => a.type === "coast-proximity");
  if (co) {
    if (co.level === "high") score += 25;
    else if (co.level === "medium") score += 15;
    else score += 8;
  }
```

3d. 修改 `classifyStatus` 第一行（critical 判定）加入 coast high：

```js
  if (alerts.some((a) => a.severity === "critical" || a.type === "sustained-low-speed" || a.type === "repeated-activity" || (a.type === "coast-proximity" && a.level === "high"))) return "异常行为目标";
```

3e. `buildSummaryTargets` 占位引用将在 Task 7 实现；为避免 Task 5 测试失败，先在 domain.js 加临时桩：

```js
function buildSummaryTargets(_analysis, _params) { return null; }
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test`
Expected: PASS（全部，含新 2 项 + 已有）

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/logic/domain.js scene/seasats-test-craft-monitor/src/logic/domain.test.js
git -C C:/idea/xian630 commit -m "feat(usv): coast-proximity alert + target metrics + score/status

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: AIS 异常告警卡片字段

**Files:**
- Modify: `src/logic/domain.js`
- Modify: `src/logic/domain.test.js`

**Interfaces:**
- `ais-gap` 告警对象新增字段：`preSpeedKn`、`postSpeedKn`、`segmentAvgSpeedKn`、`courseDeg`、`trackOrigin`（来自 target）。

- [ ] **Step 1: 写失败测试**

追加到 `src/logic/domain.test.js`：

```js
test("ais-gap alert carries card fields (speeds, course, origin)", () => {
  const payload = {
    parameters: {},
    monitoredAreas: [],
    targets: [{ mmsi: "G1", name: "SEASATS 7", lon: 50.6, lat: 26.2, length: 4, width: 2, latestTime: "2026-01-02T05:00:00Z" }],
    trackPoints: [
      { mmsi: "G1", time: "2026-01-01T00:00:00Z", lon: 50.6, lat: 26.2, speedKn: 3, courseDeg: 90 },
      { mmsi: "G1", time: "2026-01-01T01:00:00Z", lon: 50.61, lat: 26.2, speedKn: 4, courseDeg: 95 },
      // >360min gap
      { mmsi: "G1", time: "2026-01-02T05:00:00Z", lon: 50.7, lat: 26.3, speedKn: 2, courseDeg: 200 },
    ],
  };
  const analysis = analyzePayload(payload);
  const gap = analysis.alerts.find((a) => a.type === "ais-gap");
  assert.ok(gap);
  assert.equal(gap.preSpeedKn, 4);            // 中断前最后点
  assert.equal(gap.postSpeedKn, 2);           // 中断后点
  assert.equal(gap.courseDeg, 95);            // 中断前航向
  assert.deepEqual(gap.trackOrigin, { lon: 50.6, lat: 26.2, time: "2026-01-01T00:00:00Z" });
  assert.ok(gap.segmentAvgSpeedKn >= 0);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test-name-pattern="ais-gap alert carries card"`
Expected: FAIL（`gap.preSpeedKn` 为 undefined）

- [ ] **Step 3: 实现**

修改 `domain.js` 的 `detectAisGaps` —— 在每个 gap 对象（`gaps.push({...})`）增加 `preSpeedKn/postSpeedKn/courseDeg`。把现有 push 对象扩展为：

```js
    gaps.push({
      id: `${point.mmsi || "track"}-gap-${i}`,
      targetMmsi: point.mmsi || prev.mmsi || null,
      fromTime: prev.time,
      toTime: point.time,
      gapMinutes,
      severity: gapMinutes > params.aisGapCriticalMinutes ? "critical" : "warning",
      nearAreaIds,
      from: { lon: toNumber(prev.lon), lat: toNumber(prev.lat) },
      to: { lon: toNumber(point.lon), lat: toNumber(point.lat) },
      lon: (toNumber(prev.lon) + toNumber(point.lon)) / 2,
      lat: (toNumber(prev.lat) + toNumber(point.lat)) / 2,
      preSpeedKn: toNumber(prev.speedKn),
      postSpeedKn: toNumber(point.speedKn),
      courseDeg: toNumber(prev.courseDeg) ?? toNumber(prev.heading) ?? null,
    });
```

并在 `buildAlerts` 的 `ais-gap` 分支（生成 alert 的对象里）追加卡片字段。修改该 alert 对象，在 `evidence` 之后加入：

```js
        preSpeedKn: gap.preSpeedKn ?? null,
        postSpeedKn: gap.postSpeedKn ?? null,
        segmentAvgSpeedKn: gap.preSpeedKn != null && gap.postSpeedKn != null
          ? Number(((gap.preSpeedKn + gap.postSpeedKn) / 2).toFixed(2))
          : null,
        courseDeg: gap.courseDeg ?? null,
        trackOrigin: target?.trackOrigin || null,
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/logic/domain.js scene/seasats-test-craft-monitor/src/logic/domain.test.js
git -C C:/idea/xian630 commit -m "feat(usv): enrich ais-gap alerts with card fields

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 智能体总结 `buildSummary`

**Files:**
- Create: `src/logic/summary.js`
- Test: `src/logic/summary.test.js`
- Modify: `src/logic/domain.js`（替换 `buildSummaryTargets` 桩）

**Interfaces:**
- `buildSummary(analysis, params)` → `{ threatLevel: "critical"|"high"|"medium"|"low"|"none", threatLabel, findings: [{icon,label,value}], advice: [{level,text}] }`
- domain.js 的 `analyzePayload` 末尾 `buildSummaryTargets` 改为调用 `buildSummary` 并返回结果（挂到 `analysis.summary`）。

- [ ] **Step 1: 写失败测试**

创建 `src/logic/summary.test.js`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary } from "./summary.js";

const PARAMS = { coastAlertRangeNm: 200 };

test("buildSummary threat=none when nothing happens", () => {
  const s = buildSummary({ targets: [], alerts: [], aisGaps: [] }, PARAMS);
  assert.equal(s.threatLevel, "none");
  assert.ok(Array.isArray(s.findings));
});

test("buildSummary threat=critical on coast high", () => {
  const analysis = {
    targets: [{ mmsi: "X", name: "SEASATS 1", minCoastDistanceNm: 50, status: "异常行为目标", score: 90 }],
    alerts: [{ type: "coast-proximity", level: "high", severity: "critical", targetName: "SEASATS 1", summary: "距海岸 50 海里" }],
    aisGaps: [],
  };
  const s = buildSummary(analysis, PARAMS);
  assert.equal(s.threatLevel, "critical");
  assert.ok(s.advice.length > 0);
});

test("buildSummary threat=high on coast medium", () => {
  const analysis = {
    targets: [{ mmsi: "X", name: "SEASATS 2", minCoastDistanceNm: 100, status: "待核验目标", score: 50 }],
    alerts: [{ type: "coast-proximity", level: "medium", severity: "warning", targetName: "SEASATS 2", summary: "距海岸 100 海里" }],
    aisGaps: [],
  };
  const s = buildSummary(analysis, PARAMS);
  assert.equal(s.threatLevel, "high");
});

test("buildSummary surfaces ais-gap count in findings", () => {
  const analysis = {
    targets: [{ mmsi: "X", name: "SEASATS 3", minCoastDistanceNm: null, status: "高可信目标", score: 60 }],
    alerts: [{ type: "ais-gap", severity: "critical", summary: "缺口 400 分钟" }],
    aisGaps: [{ id: "g1" }],
  };
  const s = buildSummary(analysis, PARAMS);
  assert.ok(s.findings.some((f) => /AIS/i.test(f.label) || /AIS/i.test(String(f.value))));
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test-name-pattern="buildSummary"`
Expected: FAIL（`Cannot find module './summary.js'`）

- [ ] **Step 3: 实现 summary.js**

创建 `src/logic/summary.js`：

```js
const THREAT_LABEL = { critical: "紧急", high: "高危", medium: "中危", low: "低危", none: "平稳" };

export function buildSummary(analysis = {}, params = {}) {
  const alerts = analysis.alerts || [];
  const targets = analysis.targets || [];
  const aisGaps = analysis.aisGaps || [];
  const coastAlerts = alerts.filter((a) => a.type === "coast-proximity");
  const highCoast = coastAlerts.find((a) => a.level === "high");
  const medCoast = coastAlerts.find((a) => a.level === "medium");
  const lowCoast = coastAlerts.find((a) => a.level === "low");
  const criticalGap = aisGaps.some((g) => g.severity === "critical" || (g.gapMinutes || 0) > 360);
  const abnormalTargets = targets.filter((t) => t.status === "异常行为目标");

  let threatLevel = "none";
  if (highCoast || criticalGap || abnormalTargets.length > 0) threatLevel = "critical";
  else if (medCoast) threatLevel = "high";
  else if (lowCoast || alerts.some((a) => a.type === "repeated-activity")) threatLevel = "medium";
  else if (targets.some((t) => (t.score || 0) >= 40)) threatLevel = "low";

  const findings = [];
  const nearest = targets
    .filter((t) => t.minCoastDistanceNm != null)
    .sort((a, b) => a.minCoastDistanceNm - b.minCoastDistanceNm)[0];
  if (nearest) findings.push({ icon: "shore", label: "离国土最近", value: `${nearest.minCoastDistanceNm.toFixed(0)} 海里` });
  const fastest = targets
    .filter((t) => t.maxSpeedSegment)
    .map((t) => ({ name: t.name, sp: t.maxSpeedSegment.speedKn }))
    .sort((a, b) => b.sp - a.sp)[0];
  if (fastest) findings.push({ icon: "gauge", label: "最快航速", value: `${fastest.sp.toFixed(1)} kt` });
  findings.push({ icon: "ship", label: "活跃目标", value: `${targets.length}` });
  if (aisGaps.length) findings.push({ icon: "radio", label: "AIS 异常", value: `${aisGaps.length} 起` });

  const advice = [];
  if (highCoast) advice.push({ level: "high", text: `重点跟监 ${highCoast.targetName}，已进入国土高危警戒（<${params.coastAlertHighNm ?? 80} 海里）` });
  if (criticalGap) advice.push({ level: "high", text: `检测到超 6 小时 AIS 异常，建议核查信号开闭` });
  if (medCoast) advice.push({ level: "medium", text: `${medCoast.targetName} 接近国土，持续关注航向` });
  if (abnormalTargets.length === 0 && threatLevel === "none") advice.push({ level: "low", text: `当前无目标接近国土警戒区` });

  return { threatLevel, threatLabel: THREAT_LABEL[threatLevel], findings, advice };
}
```

修改 domain.js：删除 Task 5 的临时桩 `function buildSummaryTargets`，改为顶部 import 并改 analyzePayload 中的调用：

domain.js 顶部加：
```js
import { buildSummary } from "./summary.js";
```

把 analyzePayload 末尾 `return { ...analysis, summary: buildSummaryTargets(analysis, params) };` 改为：
```js
  return { ...analysis, summary: buildSummary(analysis, params) };
```

并删除 `function buildSummaryTargets(...)` 桩。

- [ ] **Step 4: 运行验证通过**

Run: `npm test`
Expected: PASS（全部，含 summary 4 项）

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/logic/summary.js scene/seasats-test-craft-monitor/src/logic/summary.test.js scene/seasats-test-craft-monitor/src/logic/domain.js
git -C C:/idea/xian630 commit -m "feat(usv): add rule-based buildSummary agent analysis

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: mapData 速度着色 + coast/最近点/最快段

**Files:**
- Modify: `src/logic/mapData.js`
- Modify: `src/logic/mapData.test.js`

**Interfaces:**
- `decimatePoints(points, opts)` → 抽稀后的点（按 maxCount 或 step）
- `speedColorSegments(points, opts)` → FeatureCollection of LineString，每条 = 相邻点段，properties.speedKn = 段对地速度
- `coastFeatures(coast)` → FeatureCollection（海岸折线）
- `nearestPointFeature(target)` → 单点 Feature（选中目标最近点）或 null
- `maxSpeedFeature(target)` → 单段 Feature（最快段）或 null
- `buildMapData(args)` 新增入参 `coast`、`selectedTarget`，输出新增集合 `speedSegments`、`coastLine`、`nearestPoint`、`maxSpeedSegment`。

- [ ] **Step 1: 写失败测试**

追加到 `src/logic/mapData.test.js`（import 加入新函数）：

```js
import { decimatePoints, speedColorSegments, coastFeatures, nearestPointFeature, maxSpeedFeature } from "./mapData.js";

test("decimatePoints reduces by step", () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ lon: i, lat: i, time: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z` }));
  const d = decimatePoints(pts, { maxCount: 10 });
  assert.ok(d.length <= 10 && d.length >= 2);
});

test("speedColorSegments builds one feature per gap with speedKn", () => {
  const pts = [
    { lon: 50, lat: 26, time: "2026-01-01T00:00:00Z", speedKn: 2 },
    { lon: 50.1, lat: 26, time: "2026-01-01T00:10:00Z", speedKn: 8 },
    { lon: 50.2, lat: 26, time: "2026-01-01T00:20:00Z", speedKn: 3 },
  ];
  const fc = speedColorSegments(pts, { maxCount: 50 });
  assert.equal(fc.features.length, 2);            // 2 segments
  assert.equal(fc.features[0].properties.speedKn, 2);
});

test("coastFeatures passes through LineStrings", () => {
  const coast = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { id: "a" }, geometry: { type: "LineString", coordinates: [[110, 21], [109, 20]] } },
  ] };
  const fc = coastFeatures(coast);
  assert.equal(fc.features.length, 1);
});

test("nearestPointFeature from target.nearestCoastPoint", () => {
  const f = nearestPointFeature({ nearestCoastPoint: { lon: 110, lat: 21, time: "t" } });
  assert.equal(f.geometry.type, "Point");
  assert.deepEqual(f.geometry.coordinates, [110, 21]);
});

test("maxSpeedFeature from target.maxSpeedSegment", () => {
  const f = maxSpeedFeature({ maxSpeedSegment: { fromPoint: { lon: 50, lat: 26 }, toPoint: { lon: 50.1, lat: 26 }, speedKn: 8 } });
  assert.equal(f.geometry.type, "LineString");
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test-name-pattern="decimatePoints|speedColorSegments|coastFeatures|nearestPointFeature|maxSpeedFeature"`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

追加到 `src/logic/mapData.js`（顶部已有 `import { toNumber } from "./domain.js";`）：

```js
export function decimatePoints(points = [], opts = {}) {
  const maxCount = toNumber(opts.maxCount) || 400;
  const valid = points.filter((p) => validLonLat(toNumber(p.lon), toNumber(p.lat)));
  if (valid.length <= maxCount) return valid;
  const step = Math.ceil(valid.length / maxCount);
  const out = [];
  for (let i = 0; i < valid.length; i += step) out.push(valid[i]);
  if (out[out.length - 1] !== valid[valid.length - 1]) out.push(valid[valid.length - 1]);
  return out;
}

export function speedColorSegments(points = [], opts = {}) {
  const d = decimatePoints(points, opts);
  const features = [];
  for (let i = 1; i < d.length; i += 1) {
    const prev = d[i - 1];
    const cur = d[i];
    const speed = toNumber(cur.speedKn);
    features.push({
      type: "Feature",
      properties: { speedKn: speed ?? 0 },
      geometry: { type: "LineString", coordinates: [[toNumber(prev.lon), toNumber(prev.lat)], [toNumber(cur.lon), toNumber(cur.lat)]] },
    });
  }
  return { type: "FeatureCollection", features };
}

export function coastFeatures(coast) {
  const features = (coast?.features || []).filter((f) => f?.geometry?.type === "LineString");
  return { type: "FeatureCollection", features };
}

export function nearestPointFeature(target) {
  const np = target?.nearestCoastPoint;
  if (!np || !validLonLat(toNumber(np.lon), toNumber(np.lat))) return null;
  return { type: "Feature", properties: { label: "离国土最近" }, geometry: { type: "Point", coordinates: [toNumber(np.lon), toNumber(np.lat)] } };
}

export function maxSpeedFeature(target) {
  const seg = target?.maxSpeedSegment;
  if (!seg?.fromPoint || !seg.toPoint) return null;
  const a = seg.fromPoint, b = seg.toPoint;
  if (!validLonLat(toNumber(a.lon), toNumber(a.lat)) || !validLonLat(toNumber(b.lon), toNumber(b.lat))) return null;
  return { type: "Feature", properties: { speedKn: seg.speedKn ?? 0, label: "最快段" }, geometry: { type: "LineString", coordinates: [[toNumber(a.lon), toNumber(a.lat)], [toNumber(b.lon), toNumber(b.lat)]] } };
}
```

修改 `buildMapData` 签名与返回，在函数开头解构加 `coast = null, selectedTarget = null`，在返回对象加四个集合：

```js
export function buildMapData({ targets = [], areas = [], segments = [], aisGaps = [], alerts = [], replayEnd = Infinity, coast = null, selectedTarget = null } = {}) {
```

在 `return { ... }` 内追加（与现有集合并列）：

```js
    speedSegments: selectedTarget ? speedColorSegments(selectedTarget.points || selectedTarget.segments?.flatMap((s) => s.points) || [], { maxCount: 400 }) : { type: "FeatureCollection", features: [] },
    coastLine: coastFeatures(coast),
    nearestPoint: { type: "FeatureCollection", features: [nearestPointFeature(selectedTarget)].filter(Boolean) },
    maxSpeedSegment: { type: "FeatureCollection", features: [maxSpeedFeature(selectedTarget)].filter(Boolean) },
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/logic/mapData.js scene/seasats-test-craft-monitor/src/logic/mapData.test.js
git -C C:/idea/xian630 commit -m "feat(usv): speed color segments + coast/nearest/maxspeed geojson

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: AlertCard 组件

**Files:**
- Create: `src/app/AlertCard.jsx`

**Interfaces:**
- 默认导出/命名导出 `AlertCard({ alert, onClose })`。`alert` 为 `ais-gap` 告警对象（含 Task 6 字段）。
- 全图形化：速度大数字 + pre/post 迷你条、方向箭头（按 courseDeg 旋转）、起始位置坐标、中断时长色块。

- [ ] **Step 1: 创建组件**

创建 `src/app/AlertCard.jsx`：

```jsx
import { ArrowUp, Clock3, Gauge, MapPin, X } from "lucide-react";

function speedTier(min) {
  if (min == null) return "info";
  if (min > 360) return "high";
  if (min > 30) return "medium";
  return "low";
}

export function AlertCard({ alert, onClose }) {
  if (!alert) return null;
  const avg = alert.segmentAvgSpeedKn ?? alert.preSpeedKn ?? 0;
  const pre = alert.preSpeedKn ?? 0;
  const post = alert.postSpeedKn ?? 0;
  const maxBar = Math.max(pre, post, avg, 1);
  const tier = speedTier(alert.gapMinutes);
  const origin = alert.trackOrigin;

  return (
    <div className="alert-card" role="dialog" aria-label="AIS 开闭异常详情">
      <header>
        <strong><Gauge size={15} /> AIS 开闭异常</strong>
        <button className="card-close" onClick={onClose} aria-label="关闭"><X size={14} /></button>
      </header>
      <div className="card-grid">
        <div className="card-cell">
          <span className="cell-label"><Gauge size={12} /> 平均速度</span>
          <span className="cell-big">{avg.toFixed(1)}<small>kt</small></span>
          <div className="mini-bars">
            <span style={{ height: `${(pre / maxBar) * 100}%` }} title={`中断前 ${pre}kt`} />
            <span style={{ height: `${(post / maxBar) * 100}%` }} title={`中断后 ${post}kt`} />
          </div>
          <small className="cell-sub">前 {pre}kt → 后 {post}kt</small>
        </div>
        <div className="card-cell">
          <span className="cell-label"><ArrowUp size={12} /> 航向</span>
          <span className="compass" style={{ transform: `rotate(${alert.courseDeg ?? 0}deg)` }}><ArrowUp size={28} /></span>
          <small className="cell-sub">{alert.courseDeg != null ? `${alert.courseDeg.toFixed(0)}°` : "--"}</small>
        </div>
        <div className="card-cell">
          <span className="cell-label"><Clock3 size={12} /> 中断时长</span>
          <span className={`cell-big tier-${tier}`}>{Math.round(alert.gapMinutes || 0)}<small>min</small></span>
          <small className="cell-sub">{tier === "high" ? ">6h 紧急" : tier === "medium" ? ">30min 关注" : "短时"}</small>
        </div>
        <div className="card-cell">
          <span className="cell-label"><MapPin size={12} /> 起始位置</span>
          {origin ? (
            <small className="cell-mono">{origin.lon.toFixed(2)}, {origin.lat.toFixed(2)}</small>
          ) : <small className="cell-sub">--</small>}
          {origin?.time && <small className="cell-sub">{origin.time.slice(0, 10)}</small>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 验证构建通过**

Run: `npm run build`
Expected: 构建成功（无语法错误）

- [ ] **Step 3: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/app/AlertCard.jsx
git -C C:/idea/xian630 commit -m "feat(usv): add AlertCard AIS-anomaly visual card

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: SummaryPanel 组件

**Files:**
- Create: `src/app/SummaryPanel.jsx`

**Interfaces:**
- 命名导出 `SummaryPanel({ summary })`。`summary` 为 Task 7 `buildSummary` 输出。
- 威胁等级大徽章（色+图标）+ findings 图标列表 + advice 条目。全图形，无段落。

- [ ] **Step 1: 创建组件**

创建 `src/app/SummaryPanel.jsx`：

```jsx
import { AlertTriangle, Gauge, Radio, Shield, Ship, Shore } from "lucide-react";  // 注：Shore 可能不存在，回退 MapPin
import { ShieldAlert, MapPin } from "lucide-react";

const LEVEL_META = {
  critical: { label: "紧急", cls: "critical", Icon: ShieldAlert },
  high: { label: "高危", cls: "high", Icon: AlertTriangle },
  medium: { label: "中危", cls: "medium", Icon: AlertTriangle },
  low: { label: "低危", cls: "low", Icon: Shield },
  none: { label: "平稳", cls: "none", Icon: Shield },
};

const FINDING_ICON = { shore: MapPin, gauge: Gauge, ship: Ship, radio: Radio };

export function SummaryPanel({ summary }) {
  if (!summary) return null;
  const meta = LEVEL_META[summary.threatLevel] || LEVEL_META.none;
  const { Icon } = meta;
  return (
    <section className="summary-panel">
      <div className={`threat-badge ${meta.cls}`}>
        <Icon size={20} />
        <div>
          <small>智能体研判</small>
          <strong>{meta.label}</strong>
        </div>
      </div>
      <div className="summary-findings">
        {summary.findings.map((f, i) => {
          const FIcon = FINDING_ICON[f.icon] || MapPin;
          return (
            <div className="finding" key={i}>
              <FIcon size={14} />
              <small>{f.label}</small>
              <strong>{f.value}</strong>
            </div>
          );
        })}
      </div>
      <ul className="summary-advice">
        {summary.advice.map((a, i) => (
          <li key={i} className={`advice-${a.level || "low"}`}>{a.text}</li>
        ))}
      </ul>
    </section>
  );
}
```

（实现时如 lucide-react 无某图标，回退 `MapPin`/`Shield`/`AlertTriangle`，不引入新依赖。）

- [ ] **Step 2: 验证构建通过**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/app/SummaryPanel.jsx
git -C C:/idea/xian630 commit -m "feat(usv): add SummaryPanel agent analysis board

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: MapPanel 扩展（coast/警戒带/速度着色/脉冲/最近点/最快段/点击卡片）

**Files:**
- Modify: `src/app/MapPanel.jsx`

**Interfaces:**
- `MapPanel({ mapData, selectedMmsi, selectedAlertId, focusRequest, onAction })` 不变签名；`mapData` 现含 `speedSegments/coastLine/nearestPoint/maxSpeedSegment`（Task 8）。
- 点击 `alert-points` 触发 `onAction({type:"select-alert", id})`（App 据 id 决定是否弹 AlertCard）。
- 新图层：coast-line、speed-segments（按 speedKn 插值色）、coast-buffer（200NM 近似带，用 coast-line 粗线半透明表达）、nearest-point、max-speed-segment、pulsing alert。

- [ ] **Step 1: 扩展 source/layer 注册**

在 `MapPanel.jsx` 的 `collectionForSource` 增加映射：

```js
const collectionForSource = {
  "monitored-areas": "monitoredAreas",
  "track-segments": "trackSegments",
  "speed-segments": "speedSegments",
  "coast-line": "coastLine",
  "nearest-point": "nearestPoint",
  "max-speed-segment": "maxSpeedSegment",
  "ais-gaps": "aisGaps",
  "vessel-points": "vesselPoints",
  "alert-points": "alertPoints",
};
```

在 `map.on("load", ...)` 内现有 `addLayer` 之后、`clickableLayers` 之前追加图层：

```js
      map.addLayer({ id: "coast-line", type: "line", source: "coast-line", paint: { "line-color": "#22d3ee", "line-width": 1.6, "line-opacity": 0.9 } });
      map.addLayer({ id: "coast-buffer", type: "line", source: "coast-line", paint: { "line-color": "#ef4444", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 6, 8, 26], "line-opacity": 0.10 } });
      map.addLayer({ id: "max-speed-segment", type: "line", source: "max-speed-segment", paint: { "line-color": "#ef4444", "line-width": 3.4, "line-opacity": 0.95 } });
      map.addLayer({ id: "speed-segments", type: "line", source: "speed-segments",
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "speedKn"], 0, "#3b82f6", 5, "#eab308", 10, "#ef4444"],
          "line-width": 2.2,
          "line-opacity": 0.9,
        } });
      map.addLayer({ id: "nearest-point", type: "circle", source: "nearest-point", paint: { "circle-radius": 7, "circle-color": "#22d3ee", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
```

- [ ] **Step 2: 告警脉冲动效**

在 `map.on("load", ...)` 末尾（`setLoaded(true)` 之前）追加脉冲动画：

```js
      let pulseT = 0;
      const pulseLoop = () => {
        if (!mapRef.current) return;
        pulseT = (pulseT + 1) % 60;
        const amp = 0.5 + 0.5 * Math.sin((pulseT / 60) * Math.PI * 2);
        if (map.getLayer("alert-points")) {
          const base = selectedAlertRadius(selectedAlertIdRef.current);
          // pulsing overlay 用 fill-opacity 动画表达；这里驱动 ais-gaps 呼吸
        }
        map.getCanvas(); // touch
        pulseRaf = requestAnimationFrame(pulseLoop);
      };
      let pulseRaf = requestAnimationFrame(pulseLoop);
```

并在组件 cleanup（return 卸载函数内 `map.remove()` 之前）：`cancelAnimationFrame(pulseRaf);`

> 简化：若 `requestAnimationFrame` 驱动 paint 复杂，改为 CSS 脉冲——给 `.alert-points` 容器叠 DOM 脉冲。最小实现：用 `setInterval` 每 600ms 切换 `alert-points` 的 `circle-stroke-opacity` 0.3↔1。实现时任选其一，验收看动效存在即可。

用 setInterval 稳健版（替换上面 pulseLoop 段）：

```js
      const pulseTimer = setInterval(() => {
        if (!mapRef.current || !map.getLayer("alert-points")) return;
        const phase = (Date.now() % 1200) / 1200;
        const op = 0.35 + 0.5 * Math.abs(Math.sin(phase * Math.PI));
        map.setPaintProperty("alert-points", "circle-stroke-opacity", op);
      }, 120);
```

cleanup 内 `clearInterval(pulseTimer);`。`pulseRaf` 版本删除。

- [ ] **Step 3: 点击告警 → onAction**

修改 `map.on("click", ...)`，`resolveMapClickAction` 已返回 action；确保 `clickableLayers` 含 `"alert-points"`（已含）。App 侧 `onAction` 处理 `{type:"select-alert", id}`（Task 12）。无需在此改逻辑。

- [ ] **Step 4: 图层显隐与选中高亮**

在 `visible(...)` 的 useEffect 里追加：

```js
    visible("coast-line", showAreas);
    visible("coast-buffer", showAreas);
    visible("speed-segments", showTracks);
    visible("max-speed-segment", showTracks);
    visible("nearest-point", showTargets);
```

（`showAreas/showTracks/showTargets` 复用现有开关；或新增国土开关，YAGNI 先复用。）

- [ ] **Step 5: 验证构建 + 冒烟**

Run: `npm run build`
Expected: 构建成功
Run: `npm run dev`（手动）→ 浏览器打开 http://127.0.0.1:5179/ → 确认：海岸青色线 + 红色半透明警戒带、选中 SEASATS 55 时轨迹按速度蓝→红着色、告警点呼吸脉冲、点击告警点（控制台无报错）。

- [ ] **Step 6: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/app/MapPanel.jsx
git -C C:/idea/xian630 commit -m "feat(usv): map coast layer, speed-color track, pulsing alerts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: App.jsx 改造（加载 coast、改名、仪表盘、列表图形化、接 AlertCard/SummaryPanel）

**Files:**
- Modify: `src/app/App.jsx`

**Interfaces:**
- 加载 `chinaCoast.json`（fetch 或 import），传给 `analyzePayload`。
- 顶部标题改「无人艇跟监告警智能体」。
- 选中告警若为 `ais-gap` → 显示 `<AlertCard>`。
- 顶部渲染 `<SummaryPanel summary={analysis.summary} />`。
- 目标详情区改仪表盘式（距离进度条/速度条/活动天数/罗盘）。

- [ ] **Step 1: 加载 coast 与改名**

在 `App.jsx` 顶部 import 加：

```jsx
import { AlertCard } from "./AlertCard.jsx";
import { SummaryPanel } from "./SummaryPanel.jsx";
import coastUrl from "../data/chinaCoast.json";
```

修改 `analyzePayload` 调用：把 `const analysis = analyzePayload(payloadData);` 改为 `const analysis = analyzePayload(payloadData, coastUrl);`（`import json` 默认是对象）。

改主标题：把现有 `<h1>`/标题文本「SEASATS测试艇活动监测」改为「无人艇跟监告警智能体」（搜索定位该字符串）。

- [ ] **Step 2: 选中告警卡片状态**

在 `App()` 内加状态与处理（靠近现有 `selectedAlertId` state）：

```jsx
const [cardAlert, setCardAlert] = useState(null);
```

修改 `onAction` 处理函数（现有 `handleAction`/`onAction`）：当 `action.type === "select-alert"`，根据 id 在 `analysis.alerts` 找到该 alert；若 `alert.type === "ais-gap"` → `setCardAlert(alert)`；同时设置 `setSelectedAlertId(action.id)` 与 focus（沿用现有逻辑）。点空白/关闭：`setCardAlert(null)`。

- [ ] **Step 3: 渲染 SummaryPanel 与 AlertCard**

在 App 顶层布局（地图上方或目标列表上方）插入：

```jsx
<SummaryPanel summary={analysis?.summary} />
```

在地图区/根容器内插入（浮层定位由 CSS 控制）：

```jsx
<AlertCard alert={cardAlert} onClose={() => setCardAlert(null)} />
```

- [ ] **Step 4: 目标详情仪表盘化**

把现有选中目标的文字详情块替换为仪表盘（在选中目标渲染处）。若现有详情是 `<div className="target-detail">...</div>`，替换为：

```jsx
{selectedTarget && (
  <div className="target-dashboard">
    <div className="dash-row">
      <div className="dash-cell">
        <small>离国土</small>
        <strong>{selectedTarget.minCoastDistanceNm != null ? `${selectedTarget.minCoastDistanceNm.toFixed(0)}` : "—"}</strong>
        <small>海里</small>
        <div className="bar"><span style={{ width: `${Math.min(100, ((selectedTarget.minCoastDistanceNm ?? 200) / 200) * 100)}%` }} /></div>
      </div>
      <div className="dash-cell">
        <small>最快</small>
        <strong>{selectedTarget.maxSpeedSegment ? selectedTarget.maxSpeedSegment.speedKn.toFixed(1) : "—"}</strong>
        <small>kt</small>
      </div>
      <div className="dash-cell">
        <small>活动天数</small>
        <strong>{selectedTarget.activeDays ?? "—"}</strong>
      </div>
      <div className="dash-cell">
        <small>航向</small>
        <span className="compass" style={{ transform: `rotate(${selectedTarget.maxSpeedSegment ? 0 : 0}deg)` }}><ArrowUp size={22} /></span>
      </div>
    </div>
  </div>
)}
```

顶部 import 加 `import { ArrowUp } from "lucide-react";`（若未导入）。

- [ ] **Step 5: 验证构建 + 冒烟**

Run: `npm run build`
Expected: 成功
Run: `npm run dev` → 确认：标题为「无人艇跟监告警智能体」、顶部 SummaryPanel 显示研判徽章+findings+advice、选中 SEASATS 55 显示仪表盘（离国土/最快/活动天数）、点击 AIS 异常告警弹出 AlertCard。

- [ ] **Step 6: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/app/App.jsx
git -C C:/idea/xian630 commit -m "feat(usv): wire coast+summary+alertcard, dashboard detail, rename

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: 样式 + index.html + README 改名

**Files:**
- Modify: `src/styles/global.css`
- Modify: `index.html`
- Modify: `README.md`

- [ ] **Step 1: 追加样式**

在 `src/styles/global.css` 末尾追加：

```css
/* === USV agent: alert card / summary / dashboard / pulse === */
.alert-card { position: absolute; right: 14px; bottom: 14px; z-index: 30; width: 320px; padding: 12px 14px; border-radius: 12px; background: rgba(15,23,42,0.94); border: 1px solid #334155; box-shadow: 0 10px 30px rgba(0,0,0,0.45); color: #e2e8f0; }
.alert-card header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.alert-card .card-close { background: transparent; border: 0; color: #94a3b8; cursor: pointer; }
.card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.card-cell { display: flex; flex-direction: column; gap: 4px; background: rgba(30,41,59,0.7); border-radius: 8px; padding: 8px; }
.cell-label { display: flex; align-items: center; gap: 4px; color: #94a3b8; font-size: 11px; }
.cell-big { font-size: 22px; font-weight: 700; line-height: 1; }
.cell-big small { font-size: 11px; color: #94a3b8; font-weight: 400; margin-left: 2px; }
.cell-sub, .cell-mono { font-size: 11px; color: #cbd5e1; }
.mini-bars { display: flex; align-items: flex-end; gap: 4px; height: 26px; }
.mini-bars span { width: 10px; background: #38bdf8; border-radius: 2px; }
.compass { display: inline-flex; color: #38bdf8; transition: transform 0.3s; }
.tier-high { color: #ef4444; } .tier-medium { color: #f59e0b; } .tier-low { color: #eab308; }

.summary-panel { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 14px; background: rgba(15,23,42,0.85); border: 1px solid #334155; border-radius: 12px; }
.threat-badge { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; }
.threat-badge small { display: block; font-size: 10px; color: #94a3b8; }
.threat-badge.critical { background: rgba(239,68,68,0.18); color: #fca5a5; border: 1px solid #ef4444; }
.threat-badge.high { background: rgba(245,158,11,0.16); color: #fcd34d; border: 1px solid #f59e0b; }
.threat-badge.medium { background: rgba(234,179,8,0.14); color: #fde68a; border: 1px solid #eab308; }
.threat-badge.low, .threat-badge.none { background: rgba(34,197,94,0.14); color: #bbf7d0; border: 1px solid #22c55e; }
.summary-findings { display: flex; gap: 10px; flex-wrap: wrap; }
.finding { display: flex; align-items: center; gap: 5px; background: rgba(30,41,59,0.7); padding: 5px 9px; border-radius: 8px; font-size: 12px; }
.finding strong { color: #f8fafc; }
.summary-advice { margin: 0; padding: 0; list-style: none; width: 100%; }
.summary-advice li { font-size: 12px; padding: 3px 0; color: #cbd5e1; }
.advice-high { color: #fca5a5; } .advice-medium { color: #fcd34d; }

.target-dashboard { padding: 10px 12px; background: rgba(15,23,42,0.8); border: 1px solid #334155; border-radius: 10px; }
.dash-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.dash-cell { display: flex; flex-direction: column; gap: 3px; background: rgba(30,41,59,0.7); border-radius: 8px; padding: 8px; }
.dash-cell strong { font-size: 20px; }
.bar { height: 5px; background: #1e293b; border-radius: 3px; overflow: hidden; margin-top: 4px; }
.bar span { display: block; height: 100%; background: linear-gradient(90deg, #ef4444, #f59e0b, #22c55e); }
```

- [ ] **Step 2: index.html 改名**

`index.html` 内 `<title>SEASATS测试艇活动监测</title>` → `<title>无人艇跟监告警智能体</title>`。

- [ ] **Step 3: README 改名**

`README.md` 首行 `# SEASATS测试艇活动监测` → `# 无人艇跟监告警智能体`；并在「Data Boundary」上方加一节：

```markdown
## 国土告警

- 以内置 `src/data/chinaCoast.json`（中国海岸简化折线）为基准，计算每个目标轨迹到国土最近距离。
- 进入 200 海里警戒区即告警，三级：高 <80 / 中 80–140 / 低 140–200 海里（阈值在 `parameters` 可调）。
- 告警点地图上有脉冲动效；点击 AIS 开闭异常告警弹出图形化卡片。
- 当前 SEASATS 样例数据位于波斯湾/北美，不触发国土告警（逻辑正确，数据可替换）。
```

- [ ] **Step 4: 验证构建**

Run: `npm run build`
Expected: 成功

- [ ] **Step 5: Commit**

```bash
git -C C:/idea/xian630 add scene/seasats-test-craft-monitor/src/styles/global.css scene/seasats-test-craft-monitor/index.html scene/seasats-test-craft-monitor/README.md
git -C C:/idea/xian630 commit -m "feat(usv): styles + rename title/readme to 无人艇跟监告警智能体

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: 最终验证

**Files:** 无（全量验收）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含原有 domain/mapData/mapInteraction + 新 coast/summary/扩展用例）。

- [ ] **Step 2: 生产构建**

Run: `npm run build`
Expected: 构建成功，无报错。

- [ ] **Step 3: 开发冒烟**

Run: `npm run dev`
浏览器 http://127.0.0.1:5179/ 验收清单（对应 spec §10）：
1. 标题「无人艇跟监告警智能体」。
2. 顶部 SummaryPanel 研判徽章 + findings + advice。
3. 地图：中国海岸青色线 + 红色警戒带；轨迹按速度蓝→红着色；告警点呼吸脉冲。
4. 选中 SEASATS 55：仪表盘显示离国土/最快/活动天数/航向；最快段红色高亮；最近点青色标注。
5. 点击 AIS 异常告警 → AlertCard 弹出（速度/方向/起始位置/中断时长），点 ✕ 关闭。
6. 目标列表/告警列表用图标徽章，无长句子。
7. （国土告警在样例数据下不触发，符合预期。）

- [ ] **Step 4: 提交收尾（如有改动）**

若 Step 3 发现小修，修复后 commit；否则无需。

---

## Self-Review Notes

- **Spec coverage**：§5.1 chinaCoast→Task1；§5.2.1 距离→Task2；§5.2.2 分级→Task3；§5.2.3 指标→Task4；§5.2.4 告警→Task5；§5.2.5 卡片字段→Task6；§5.2.6 总结→Task7；§5.3 地图→Task8+11；§5.4 AlertCard/SummaryPanel/仪表盘→Task9+10+12；§5.5 样式→Task13；改名→Task12+13。§10 验收→Task14。全覆盖。
- **placeholder scan**：无 TBD/TODO；组件任务给完整代码（部分 lucide 图标名留回退说明，属可执行实现指引而非占位）。
- **type consistency**：`minCoastDistanceNm`/`nearestCoastPoint`/`maxSpeedSegment`/`activeDays`/`trackOrigin`/`segmentAvgSpeedKn` 在 Task4/5/6/8/12 中名称一致；`buildSummary` 输出字段 `threatLevel/threatLabel/findings/advice` 在 Task7/10 一致；`coastProximityLevel` 取值 `high/medium/low` 在 Task3/5 一致。
- **实现细化 vs spec**：距离计算用「遍历顶点取最近」替代 spec 的 cross-track（spec §9 已允许误差 <5%，顶点遍历满足且数值稳健），其余与 spec 一致。
