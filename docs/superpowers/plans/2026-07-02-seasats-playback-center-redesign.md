# Seasats Playback Center Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `scene/seasats-test-craft-monitor` into a舰艇轨迹回放中心 that embeds the remote map, supports single-vessel focus mode, and removes first-screen chart clutter.

**Architecture:** Add small pure logic helpers for remote-map URL/window/focus filtering, then build focused React components around those helpers. `App.jsx` remains the state owner, while `RemotePlaybackMap`, `PlaybackControlBar`, and `VesselFocusPanel` isolate map embed, playback explanation, and selected-vessel context. Keep local MapLibre as a fallback path instead of deleting it.

**Tech Stack:** React 18, Vite, Node `node:test`, MapLibre fallback, remote iframe map at `http://218.61.33.200:18000/`, lucide-react icons.

---

## File Structure

- Create: `scene/seasats-test-craft-monitor/src/logic/playback.js`
  - Pure functions for remote map URL construction, timestamp conversion, replay window resolution, and focus-mode filtering. The focused result keeps collection data scoped to the selected vessel; selected-vessel summary copy is rendered from `selectedTarget`, `focusedAlerts`, and `focusedGaps` rather than from the global `summary`.
- Create: `scene/seasats-test-craft-monitor/src/logic/playback.test.js`
  - Node tests for the pure playback helpers.
- Create: `scene/seasats-test-craft-monitor/src/app/RemotePlaybackMap.jsx`
  - iframe wrapper with loading, timeout, link-out, and optional fallback slot.
- Create: `scene/seasats-test-craft-monitor/src/app/PlaybackControlBar.jsx`
  - Bottom control/explanation bar for replay window, speed color, direction, and abnormal point legend.
- Create: `scene/seasats-test-craft-monitor/src/app/VesselFocusPanel.jsx`
  - Right-side selected-vessel summary and current warnings.
- Modify: `scene/seasats-test-craft-monitor/src/app/App.jsx`
  - Replace map-first layout with playback-center state, single-vessel focus mode, and new components.
- Modify: `scene/seasats-test-craft-monitor/src/app/AnalysisPanel.jsx`
  - Replace chart grid with a compact, collapsible judgment panel.
- Modify: `scene/seasats-test-craft-monitor/src/styles/global.css`
  - New page framework, iframe map shell, focus panels, responsive behavior; remove or override obsolete chart-first layout.

---

### Task 1: Playback Helper Tests

**Files:**
- Create: `scene/seasats-test-craft-monitor/src/logic/playback.test.js`
- Create later: `scene/seasats-test-craft-monitor/src/logic/playback.js`

- [ ] **Step 1: Write the failing helper tests**

Create `src/logic/playback.test.js` with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteMapUrl,
  filterForFocusMode,
  resolveReplayWindow,
  toEpochSeconds,
} from "./playback.js";

test("toEpochSeconds converts ISO strings and second timestamps", () => {
  assert.equal(toEpochSeconds("2025-01-01T00:00:00Z"), 1735689600);
  assert.equal(toEpochSeconds(1735689600), 1735689600);
  assert.equal(toEpochSeconds("bad"), null);
  assert.equal(toEpochSeconds(null), null);
});

test("resolveReplayWindow prefers selected target track window", () => {
  const selectedTarget = {
    segments: [
      { startTime: "2025-01-02T00:00:00Z", endTime: "2025-01-03T00:00:00Z" },
      { startTime: "2025-01-01T00:00:00Z", endTime: "2025-01-04T00:00:00Z" },
    ],
  };
  const metadata = {
    dataWindow: {
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-02T00:00:00Z",
    },
  };

  assert.deepEqual(resolveReplayWindow({ selectedTarget, metadata }), {
    start: 1735689600,
    end: 1735948800,
    source: "selected-target",
  });
});

test("resolveReplayWindow falls back to metadata then fixed window", () => {
  assert.deepEqual(
    resolveReplayWindow({
      selectedTarget: {},
      metadata: { dataWindow: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" } },
    }),
    { start: 1767225600, end: 1767312000, source: "metadata" }
  );

  assert.deepEqual(resolveReplayWindow({ selectedTarget: {}, metadata: {} }), {
    start: 1735689600,
    end: 1783036799,
    source: "fallback",
  });
});

test("buildRemoteMapUrl encodes mmsi and replay window", () => {
  assert.equal(
    buildRemoteMapUrl({
      baseUrl: "http://218.61.33.200:18000/",
      mmsi: "338414915",
      startTime: 1735689600,
      endTime: 1783036799,
    }),
    "http://218.61.33.200:18000/?mmsi=338414915&start_time=1735689600&end_time=1783036799"
  );
});

test("filterForFocusMode keeps only selected vessel data when focus mode is enabled", () => {
  const analysis = {
    targets: [{ mmsi: "1" }, { mmsi: "2" }],
    alerts: [{ id: "a", targetMmsi: "1" }, { id: "b", targetMmsi: "2" }],
    segments: [{ id: "s1", targetMmsi: "1" }, { id: "s2", targetMmsi: "2" }],
    aisGaps: [{ id: "g1", targetMmsi: "1" }, { id: "g2", targetMmsi: "2" }],
  };

  const focused = filterForFocusMode({ analysis, selectedMmsi: "1", focusOnly: true });
  assert.deepEqual(focused.targets.map((item) => item.mmsi), ["1"]);
  assert.deepEqual(focused.alerts.map((item) => item.id), ["a"]);
  assert.deepEqual(focused.segments.map((item) => item.id), ["s1"]);
  assert.deepEqual(focused.aisGaps.map((item) => item.id), ["g1"]);

  const all = filterForFocusMode({ analysis, selectedMmsi: "1", focusOnly: false });
  assert.equal(all.targets.length, 2);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run from `scene/seasats-test-craft-monitor`:

```powershell
npm test -- src/logic/playback.test.js
```

Expected: FAIL with an import error similar to `Cannot find module .../playback.js`.

- [ ] **Step 3: Commit the failing test**

```powershell
git add src/logic/playback.test.js
git commit -m "test: define playback helper behavior"
```

---

### Task 2: Playback Helper Implementation

**Files:**
- Create: `scene/seasats-test-craft-monitor/src/logic/playback.js`
- Test: `scene/seasats-test-craft-monitor/src/logic/playback.test.js`

- [ ] **Step 1: Implement the minimal helper module**

Create `src/logic/playback.js` with:

```js
export const DEFAULT_REMOTE_MAP_BASE_URL = "http://218.61.33.200:18000/";
export const DEFAULT_REPLAY_WINDOW = { start: 1735689600, end: 1783036799 };

export function toEpochSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 9999999999 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function targetTrackWindow(target) {
  const points = Array.isArray(target?.segments)
    ? target.segments.flatMap((segment) => [
        segment.startTime,
        segment.endTime,
        ...(segment.points || []).map((point) => point.time),
      ])
    : [];
  const times = points.map(toEpochSeconds).filter((time) => time !== null);
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times), source: "selected-target" };
}

export function resolveReplayWindow({ selectedTarget, metadata, fallback = DEFAULT_REPLAY_WINDOW } = {}) {
  const targetWindow = targetTrackWindow(selectedTarget);
  if (targetWindow) return targetWindow;

  const metaStart = toEpochSeconds(metadata?.dataWindow?.start);
  const metaEnd = toEpochSeconds(metadata?.dataWindow?.end);
  if (metaStart !== null && metaEnd !== null) {
    return { start: metaStart, end: metaEnd, source: "metadata" };
  }

  return { start: fallback.start, end: fallback.end, source: "fallback" };
}

export function buildRemoteMapUrl({
  baseUrl = DEFAULT_REMOTE_MAP_BASE_URL,
  mmsi,
  startTime,
  endTime,
} = {}) {
  const url = new URL(baseUrl);
  if (mmsi) url.searchParams.set("mmsi", String(mmsi));
  const start = toEpochSeconds(startTime);
  const end = toEpochSeconds(endTime);
  if (start !== null) url.searchParams.set("start_time", String(start));
  if (end !== null) url.searchParams.set("end_time", String(end));
  return url.toString();
}

export function filterForFocusMode({ analysis, selectedMmsi, focusOnly }) {
  if (!focusOnly || !selectedMmsi) return analysis;
  const sameVessel = (item) => item?.targetMmsi === selectedMmsi || item?.mmsi === selectedMmsi;
  return {
    ...analysis,
    targets: (analysis.targets || []).filter((target) => target.mmsi === selectedMmsi),
    alerts: (analysis.alerts || []).filter(sameVessel),
    segments: (analysis.segments || []).filter(sameVessel),
    aisGaps: (analysis.aisGaps || []).filter(sameVessel),
  };
}
```

- [ ] **Step 2: Run helper tests and verify they pass**

```powershell
npm test -- src/logic/playback.test.js
```

Expected: PASS for all playback helper tests.

- [ ] **Step 3: Run existing logic tests**

```powershell
npm test
```

Expected: all existing `node:test` tests pass.

- [ ] **Step 4: Commit helper implementation**

```powershell
git add src/logic/playback.js src/logic/playback.test.js
git commit -m "feat: add playback map helpers"
```

---

### Task 3: Remote Map Component

**Files:**
- Create: `scene/seasats-test-craft-monitor/src/app/RemotePlaybackMap.jsx`
- Modify later: `scene/seasats-test-craft-monitor/src/app/App.jsx`

- [ ] **Step 1: Create the iframe map wrapper**

Create `src/app/RemotePlaybackMap.jsx` with:

```jsx
import { useEffect, useState } from "react";
import { ExternalLink, Map, RefreshCw, WifiOff } from "lucide-react";

export function RemotePlaybackMap({ src, title = "舰艇轨迹回放地图", fallback = null }) {
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), 12000);
    return () => window.clearTimeout(timer);
  }, [src]);

  return (
    <section className="remote-map-shell">
      <header className="remote-map-head">
        <div>
          <h2><Map size={16} />{title}</h2>
          <span>{loaded ? "远程地图已加载" : "正在加载远程地图"}</span>
        </div>
        <a className="map-open-link" href={src} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />原始地图
        </a>
      </header>
      <div className="remote-map-frame-wrap">
        <iframe
          key={src}
          className="remote-map-frame"
          title={title}
          src={src}
          loading="eager"
          onLoad={() => setLoaded(true)}
          allow="fullscreen"
        />
        {!loaded && (
          <div className="remote-map-loading">
            <RefreshCw size={22} />
            <strong>轨迹加载中</strong>
            <span>正在打开远程回放地图</span>
          </div>
        )}
        {timedOut && !loaded && (
          <div className="remote-map-fallback">
            <WifiOff size={22} />
            <strong>远程地图暂不可见</strong>
            <span>可打开原始地图，或查看本地兜底轨迹。</span>
            <a href={src} target="_blank" rel="noreferrer">打开原始地图</a>
            {fallback}
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit the component**

```powershell
git add src/app/RemotePlaybackMap.jsx
git commit -m "feat: add remote playback map component"
```

---

### Task 4: Playback Control Bar and Vessel Focus Panel

**Files:**
- Create: `scene/seasats-test-craft-monitor/src/app/PlaybackControlBar.jsx`
- Create: `scene/seasats-test-craft-monitor/src/app/VesselFocusPanel.jsx`

- [ ] **Step 1: Create playback control bar**

Create `src/app/PlaybackControlBar.jsx` with:

```jsx
import { ArrowUp, Clock3, Gauge, RadioTower, Route } from "lucide-react";

function fmtWindowTime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const d = new Date(seconds * 1000);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function PlaybackControlBar({ replayWindow, focusOnly, onFocusOnlyChange }) {
  return (
    <section className="playback-bar">
      <div className="playback-window">
        <Clock3 size={15} />
        <div>
          <strong>{fmtWindowTime(replayWindow?.start)} - {fmtWindowTime(replayWindow?.end)}</strong>
          <span>回放时间窗 · {replayWindow?.source === "selected-target" ? "当前舰艇轨迹" : replayWindow?.source === "metadata" ? "全局数据窗口" : "默认窗口"}</span>
        </div>
      </div>
      <div className="playback-legend">
        <span><i className="speed-low" /><Gauge size={13} />慢速</span>
        <span><i className="speed-mid" /><Route size={13} />巡航</span>
        <span><i className="speed-high" /><Gauge size={13} />高速</span>
        <span><ArrowUp size={13} />箭头表示方向</span>
        <span><RadioTower size={13} />异常点随回放高亮</span>
      </div>
      <label className="focus-toggle">
        <input
          type="checkbox"
          checked={focusOnly}
          onChange={(event) => onFocusOnlyChange(event.target.checked)}
        />
        <span>只看关注舰艇</span>
      </label>
    </section>
  );
}
```

- [ ] **Step 2: Create selected vessel focus panel**

Create `src/app/VesselFocusPanel.jsx` with:

```jsx
import { AlertTriangle, ArrowUp, Gauge, RadioTower, ShieldAlert, Ship } from "lucide-react";
import { fmtDuration } from "../logic/domain.js";

function fmtDateTime(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function severityText(severity) {
  if (severity === "critical") return "高风险";
  if (severity === "warning") return "关注";
  return "提示";
}

export function VesselFocusPanel({ vessel, alerts = [], gaps = [] }) {
  if (!vessel) {
    return <aside className="vessel-focus-panel empty">请选择一艘舰艇</aside>;
  }
  const latestAlert = alerts[0] || null;
  const totalGapMinutes = gaps.reduce((sum, gap) => sum + (Number(gap.gapMinutes) || 0), 0);
  const direction = vessel.orientation ?? vessel.courseDeg ?? 0;

  return (
    <aside className="vessel-focus-panel">
      <header>
        <div>
          <span className="eyebrow"><Ship size={14} />关注舰艇</span>
          <h2>{vessel.name}</h2>
          <p>MMSI {vessel.mmsi}</p>
        </div>
        <strong className="risk-score">威胁分 {vessel.score ?? "--"}</strong>
      </header>
      <div className="focus-metrics">
        <div><small>最高速度</small><strong>{vessel.maxSpeedSegment ? vessel.maxSpeedSegment.speedKn.toFixed(1) : vessel.speedKn ?? "--"} kt</strong><Gauge size={16} /></div>
        <div><small>AIS 中断</small><strong>{gaps.length} 次</strong><RadioTower size={16} /></div>
        <div><small>中断总时长</small><strong>{fmtDuration(totalGapMinutes)}</strong><AlertTriangle size={16} /></div>
        <div><small>当前航向</small><strong>{Number.isFinite(direction) ? `${Math.round(direction)}°` : "--"}</strong><ArrowUp className="heading-arrow" size={17} style={{ transform: `rotate(${direction}deg)` }} /></div>
      </div>
      <section className="focus-section">
        <h3><ShieldAlert size={14} />研判摘要</h3>
        <p>
          {vessel.hasObservedTrack
            ? "该舰艇有可回放轨迹，重点观察速度颜色、航向箭头和异常点变化。"
            : "该舰艇当前仅有最新位置，远程回放可能无法返回完整轨迹。"}
        </p>
        <p>最近时间：{fmtDateTime(vessel.latestTime)}</p>
      </section>
      <section className="focus-section">
        <h3><AlertTriangle size={14} />最近告警</h3>
        {latestAlert ? (
          <div className={`focus-alert ${latestAlert.severity}`}>
            <span>{severityText(latestAlert.severity)}</span>
            <strong>{latestAlert.title}</strong>
            <p>{latestAlert.summary}</p>
          </div>
        ) : (
          <p>当前舰艇暂无告警。</p>
        )}
      </section>
    </aside>
  );
}
```

- [ ] **Step 3: Commit the UI support components**

```powershell
git add src/app/PlaybackControlBar.jsx src/app/VesselFocusPanel.jsx
git commit -m "feat: add playback context panels"
```

---

### Task 5: App Layout Integration

**Files:**
- Modify: `scene/seasats-test-craft-monitor/src/app/App.jsx`
- Uses: `src/app/RemotePlaybackMap.jsx`
- Uses: `src/app/PlaybackControlBar.jsx`
- Uses: `src/app/VesselFocusPanel.jsx`
- Uses: `src/logic/playback.js`

- [ ] **Step 1: Replace imports in `App.jsx`**

Update the import block to include new components/helpers and remove unused `MapPanel`, `ArrowUp`, `X`, and `fmtDuration` imports if no longer referenced:

```jsx
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, Database, Filter, Navigation, Search, Ship, Target } from "lucide-react";
import { analyzePayload } from "../logic/domain.js";
import { buildMapData } from "../logic/mapData.js";
import { buildRemoteMapUrl, filterForFocusMode, resolveReplayWindow } from "../logic/playback.js";
import { RemotePlaybackMap } from "./RemotePlaybackMap.jsx";
import { PlaybackControlBar } from "./PlaybackControlBar.jsx";
import { VesselFocusPanel } from "./VesselFocusPanel.jsx";
import { MapPanel } from "./MapPanel.jsx";
import { AnalysisPanel } from "./AnalysisPanel.jsx";
import coastData from "../data/chinaCoast.json";
```

- [ ] **Step 2: Rename user-visible row labels from target to vessel**

Change `TargetRow` copy while leaving function names for a small diff:

```jsx
{target.hasObservedTrack
  ? <span className="track-mark has" title="有轨迹"><Navigation size={12} />轨迹</span>
  : <span className="track-mark" title="仅最新位置">仅位置</span>}
```

No code change is needed in this snippet if current copy already matches; verify the surrounding panel title and placeholders are changed in Step 4.

- [ ] **Step 3: Add focus mode and replay URL state inside `Dashboard`**

Inside `Dashboard`, add:

```jsx
const [focusOnly, setFocusOnly] = useState(false);
```

After `selectedTarget` and `visibleAlerts` are computed, add:

```jsx
const focusedAnalysis = useMemo(
  () => filterForFocusMode({ analysis, selectedMmsi: selectedTarget?.mmsi, focusOnly }),
  [analysis, focusOnly, selectedTarget?.mmsi]
);
const focusedAlerts = useMemo(
  () => focusedAnalysis.alerts.filter((alert) => !selectedTarget?.mmsi || alert.targetMmsi === selectedTarget.mmsi),
  [focusedAnalysis.alerts, selectedTarget?.mmsi]
);
const focusedGaps = useMemo(
  () => focusedAnalysis.aisGaps.filter((gap) => !selectedTarget?.mmsi || gap.targetMmsi === selectedTarget.mmsi),
  [focusedAnalysis.aisGaps, selectedTarget?.mmsi]
);
const replayWindow = useMemo(
  () => resolveReplayWindow({ selectedTarget, metadata: analysis.metadata }),
  [analysis.metadata, selectedTarget]
);
const remoteMapUrl = useMemo(
  () => buildRemoteMapUrl({
    mmsi: selectedTarget?.mmsi,
    startTime: replayWindow.start,
    endTime: replayWindow.end,
  }),
  [replayWindow.end, replayWindow.start, selectedTarget?.mmsi]
);
```

- [ ] **Step 4: Replace the returned dashboard layout**

Replace the `return (` block inside `Dashboard` with:

```jsx
return (
  <main className="stm-shell playback-shell">
    <header className="topbar playback-topbar">
      <div className="brand">
        <Ship size={22} />
        <div>
          <h1>舰艇轨迹回放中心</h1>
          <p>{focusOnly ? "仅显示关注舰艇动向" : "全局态势 + 当前舰艇高亮"}</p>
        </div>
      </div>
      <div className="top-metrics">
        <span><Database size={14} />舰艇 {focusOnly ? 1 : analysis.metadata.targetCount}</span>
        <span><AlertTriangle size={14} />告警 {focusOnly ? focusedAlerts.length : analysis.alerts.length}</span>
        <span><Clock3 size={14} />数据至 {fmtDateTime(analysis.metadata.dataWindow.end)}</span>
      </div>
    </header>

    <section className="playback-workspace">
      <aside className={`vessel-panel ${focusOnly ? "focused" : ""}`}>
        <div className="panel-head">
          <h2><Target size={15} />舰艇</h2>
          <span>{focusOnly ? 1 : visibleTargets.length}/{analysis.targets.length}</span>
        </div>
        {!focusOnly && (
          <div className="filters">
            <label className="searchbox"><Search size={13} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="舰名 / MMSI" /></label>
            <label><Filter size={13} /><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>{statusOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
        )}
        <div className="target-list">
          {(focusOnly && selectedTarget ? [selectedTarget] : visibleTargets).map((target) => (
            <TargetRow key={target.mmsi} target={target} selected={target.mmsi === selectedTarget?.mmsi} onSelect={handleTargetSelect} />
          ))}
        </div>
      </aside>

      <div className="playback-map-area">
        <RemotePlaybackMap
          src={remoteMapUrl}
          title={selectedTarget ? `${selectedTarget.name} 轨迹回放` : "舰艇轨迹回放地图"}
          fallback={
            <details className="local-map-fallback">
              <summary>查看本地兜底地图</summary>
              <MapPanel mapData={mapData} selectedMmsi={selectedTarget?.mmsi} selectedAlertId={selectedAlert?.id} focusRequest={mapFocus} onAction={handleMapAction} />
            </details>
          }
        />
      </div>

      <VesselFocusPanel vessel={selectedTarget} alerts={focusedAlerts} gaps={focusedGaps} />
    </section>

    <PlaybackControlBar replayWindow={replayWindow} focusOnly={focusOnly} onFocusOnlyChange={setFocusOnly} />
    <AnalysisPanel analysis={focusedAnalysis} selectedTarget={selectedTarget} coast={coastData} />
  </main>
);
```

- [ ] **Step 5: Run unit tests**

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit layout integration**

```powershell
git add src/app/App.jsx
git commit -m "feat: integrate remote playback center layout"
```

---

### Task 6: Simplify Analysis Panel

**Files:**
- Modify: `scene/seasats-test-craft-monitor/src/app/AnalysisPanel.jsx`

- [ ] **Step 1: Replace the large chart return with a compact details section**

Keep existing helper functions temporarily if removing them makes the diff too noisy, but replace `AnalysisPanel` export with:

```jsx
export function AnalysisPanel({ analysis, selectedTarget }) {
  const summary = analysis.summary;
  const alerts = selectedTarget?.alerts || [];
  const criticalCount = alerts.filter((alert) => alert.severity === "critical").length;
  const warningCount = alerts.filter((alert) => alert.severity === "warning").length;

  return (
    <details className="analysis-panel compact-analysis">
      <summary>
        <ShieldAlert size={14} />
        <span>研判详情</span>
        <strong>{summary?.threatLabel || "无研判"}</strong>
      </summary>
      <div className="compact-analysis-grid">
        <section>
          <h3><Ship size={14} />当前舰艇</h3>
          <p>{selectedTarget?.name || "--"} · MMSI {selectedTarget?.mmsi || "--"}</p>
          <p>威胁分：{selectedTarget?.score ?? "--"}，状态：{selectedTarget?.status || "--"}</p>
        </section>
        <section>
          <h3><AlertTriangle size={14} />告警概览</h3>
          <p>高风险 {criticalCount} 个，关注 {warningCount} 个，总计 {alerts.length} 个。</p>
        </section>
        <section>
          <h3><ShieldAlert size={14} />智能体研判</h3>
          <p>{summary?.narrative || "暂无研判摘要。"}</p>
        </section>
      </div>
    </details>
  );
}
```

- [ ] **Step 2: Remove unused imports**

At the top of `AnalysisPanel.jsx`, reduce imports to:

```jsx
import { AlertTriangle, ShieldAlert, Ship } from "lucide-react";
```

Remove unused analytics imports and chart helper imports only after the export no longer references them.

- [ ] **Step 3: Run build to catch JSX/import errors**

```powershell
npm run build
```

Expected: Vite build exits with code 0.

- [ ] **Step 4: Commit analysis simplification**

```powershell
git add src/app/AnalysisPanel.jsx
git commit -m "refactor: simplify playback analysis panel"
```

---

### Task 7: Playback Center CSS

**Files:**
- Modify: `scene/seasats-test-craft-monitor/src/styles/global.css`

- [ ] **Step 1: Append new playback layout styles**

Append to `src/styles/global.css`:

```css
/* === Playback center redesign === */
.playback-shell {
  min-height: 100vh;
  height: 100vh;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  gap: 10px;
  background: #050914;
}

.playback-topbar .brand p {
  display: block;
  margin: 4px 0 0;
  color: #94a3b8;
  font-size: 12px;
}

.playback-workspace {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 340px);
  gap: 10px;
  position: relative;
}

.vessel-panel,
.vessel-focus-panel,
.remote-map-shell,
.compact-analysis {
  min-width: 0;
  min-height: 0;
  background: rgba(15, 23, 42, 0.94);
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  overflow: hidden;
}

.vessel-panel {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
}

.vessel-panel.focused {
  grid-template-rows: auto minmax(0, 1fr);
}

.playback-map-area,
.remote-map-shell {
  min-height: 0;
}

.remote-map-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.remote-map-head {
  min-height: 48px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

.remote-map-head h2,
.vessel-focus-panel h2 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  color: #f8fafc;
  font-size: 15px;
}

.remote-map-head span {
  display: block;
  margin-top: 3px;
  color: #94a3b8;
  font-size: 12px;
}

.map-open-link,
.remote-map-fallback a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 7px;
  color: #dbeafe;
  background: rgba(30, 41, 59, 0.8);
  border: 1px solid rgba(148, 163, 184, 0.28);
  text-decoration: none;
  font-size: 12px;
}

.remote-map-frame-wrap {
  position: relative;
  min-height: 0;
  background: #020617;
}

.remote-map-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}

.remote-map-loading,
.remote-map-fallback {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: #dbeafe;
  background: radial-gradient(circle at 50% 36%, rgba(56, 189, 248, 0.15), rgba(2, 6, 23, 0.92) 52%);
}

.remote-map-loading svg,
.remote-map-fallback svg {
  color: #38bdf8;
}

.remote-map-loading span,
.remote-map-fallback span {
  max-width: 340px;
  color: #94a3b8;
  font-size: 12px;
}

.local-map-fallback {
  width: min(760px, 90%);
  margin-top: 10px;
}

.local-map-fallback summary {
  cursor: pointer;
  color: #bae6fd;
  font-size: 12px;
}

.local-map-fallback .map-panel {
  height: 360px;
  margin-top: 8px;
}

.vessel-focus-panel {
  padding: 14px;
  overflow: auto;
}

.vessel-focus-panel.empty {
  display: grid;
  place-items: center;
  color: #94a3b8;
}

.vessel-focus-panel header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.vessel-focus-panel p {
  margin: 4px 0 0;
  color: #cbd5e1;
  font-size: 12px;
  line-height: 1.55;
}

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #38bdf8;
  font-size: 11px;
}

.risk-score {
  flex: 0 0 auto;
  padding: 5px 10px;
  border-radius: 999px;
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.14);
  border: 1px solid rgba(251, 191, 36, 0.28);
  font-size: 12px;
}

.focus-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.focus-metrics div,
.focus-section,
.focus-alert {
  border-radius: 8px;
  background: rgba(30, 41, 59, 0.58);
  border: 1px solid rgba(148, 163, 184, 0.16);
}

.focus-metrics div {
  min-height: 76px;
  padding: 9px;
  display: grid;
  gap: 4px;
}

.focus-metrics small {
  color: #94a3b8;
  font-size: 11px;
}

.focus-metrics strong {
  color: #f8fafc;
  font-size: 17px;
}

.focus-metrics svg {
  color: #38bdf8;
}

.heading-arrow {
  transform-origin: center;
}

.focus-section {
  margin-top: 10px;
  padding: 10px;
}

.focus-section h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  color: #f1f5f9;
  font-size: 13px;
}

.focus-alert {
  padding: 8px;
}

.focus-alert span {
  display: inline-flex;
  margin-bottom: 5px;
  padding: 2px 6px;
  border-radius: 999px;
  background: #f8fafc;
  color: #0f172a;
  font-size: 11px;
}

.focus-alert.critical {
  border-color: rgba(239, 68, 68, 0.45);
}

.focus-alert.warning {
  border-color: rgba(245, 158, 11, 0.45);
}

.playback-bar {
  min-height: 58px;
  display: grid;
  grid-template-columns: minmax(260px, auto) minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.94);
  border: 1px solid rgba(148, 163, 184, 0.22);
}

.playback-window,
.playback-legend,
.playback-legend span,
.focus-toggle {
  display: flex;
  align-items: center;
}

.playback-window {
  gap: 8px;
}

.playback-window strong {
  display: block;
  color: #f8fafc;
  font-size: 12px;
}

.playback-window span {
  display: block;
  margin-top: 2px;
  color: #94a3b8;
  font-size: 11px;
}

.playback-legend {
  flex-wrap: wrap;
  gap: 8px;
}

.playback-legend span {
  gap: 5px;
  color: #cbd5e1;
  font-size: 11px;
}

.playback-legend i {
  width: 18px;
  height: 4px;
  border-radius: 999px;
}

.speed-low { background: #22c55e; }
.speed-mid { background: #fbbf24; }
.speed-high { background: #ef4444; }

.focus-toggle {
  gap: 7px;
  color: #e2e8f0;
  font-size: 12px;
  white-space: nowrap;
}

.focus-toggle input {
  accent-color: #38bdf8;
}

.compact-analysis {
  padding: 0;
}

.compact-analysis summary {
  min-height: 42px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #f8fafc;
}

.compact-analysis summary strong {
  margin-left: auto;
  color: #fbbf24;
  font-size: 12px;
}

.compact-analysis-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding: 0 12px 12px;
}

.compact-analysis-grid section {
  padding: 10px;
  border-radius: 8px;
  background: rgba(30, 41, 59, 0.5);
  border: 1px solid rgba(148, 163, 184, 0.14);
}

.compact-analysis-grid h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  color: #f1f5f9;
  font-size: 13px;
}

.compact-analysis-grid p {
  margin: 4px 0 0;
  color: #cbd5e1;
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 1180px) {
  .playback-shell {
    height: auto;
    min-height: 100vh;
    overflow: auto;
  }

  .playback-workspace {
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  }

  .vessel-focus-panel {
    grid-column: 1 / -1;
  }

  .remote-map-frame-wrap {
    min-height: 580px;
  }

  .playback-bar {
    grid-template-columns: 1fr;
    align-items: start;
  }

  .compact-analysis-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .playback-workspace {
    grid-template-columns: 1fr;
  }

  .vessel-panel {
    max-height: 360px;
  }

  .remote-map-frame-wrap {
    min-height: 520px;
  }

  .focus-metrics {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 2: Run build**

```powershell
npm run build
```

Expected: Vite build exits with code 0.

- [ ] **Step 3: Commit CSS**

```powershell
git add src/styles/global.css
git commit -m "style: add playback center layout"
```

---

### Task 8: Visible Copy Audit

**Files:**
- Modify: `scene/seasats-test-craft-monitor/src/app/App.jsx`
- Modify: `scene/seasats-test-craft-monitor/src/app/AnalysisPanel.jsx`
- Modify: `scene/seasats-test-craft-monitor/src/app/SummaryPanel.jsx` if it remains imported or rendered after Task 5.
- Modify: `scene/seasats-test-craft-monitor/src/logic/domain.js`
- Modify: `scene/seasats-test-craft-monitor/src/logic/summary.js`
- Modify: `scene/seasats-test-craft-monitor/src/styles/global.css`
- Modify tests under `scene/seasats-test-craft-monitor/src/logic/*.test.js` if status labels are asserted.

- [ ] **Step 1: Search for user-visible `目标` text**

```powershell
rg -n "目标" src
```

Expected: occurrences remain only in internal function names or historical constants where changing them would break logic. User-facing JSX strings, generated alert summaries, and visible status labels should use `舰艇`.

- [ ] **Step 2: Replace safe user-facing strings**

Examples to apply where found:

```jsx
<h2><Target size={15} />舰艇</h2>
<span><Database size={14} />舰艇 {analysis.metadata.targetCount}</span>
placeholder="舰名 / MMSI"
```

For logic-produced user-facing labels in `domain.js` or `summary.js`, replace strings like:

```js
"异常行为目标"
"高可信目标"
"待核验目标"
```

with:

```js
"异常行为舰艇"
"高可信舰艇"
"待核验舰艇"
```

Also update matching status filter options and CSS class selectors if the status strings change.

- [ ] **Step 3: Run tests after copy changes**

```powershell
npm test
```

Expected: all tests pass. If tests fail because status labels changed, update assertions to the new user-facing labels.

- [ ] **Step 4: Commit copy audit**

```powershell
git add src
git commit -m "refactor: rename visible target copy to vessel copy"
```

---

### Task 9: Browser Verification

**Files:**
- No source edits unless verification reveals defects.

- [ ] **Step 1: Run tests and build**

```powershell
npm test
npm run build
```

Expected: both commands exit with code 0.

- [ ] **Step 2: Start or reuse the dev server**

If `http://127.0.0.1:5179/` is already serving the app, reuse it. Otherwise run:

```powershell
npm run dev -- --host 127.0.0.1 --port 5179
```

Expected: Vite serves the app at `http://127.0.0.1:5179/`.

- [ ] **Step 3: Verify in browser**

Open `http://127.0.0.1:5179/` and check:

- Header title is `舰艇轨迹回放中心`.
- Main area contains the remote map iframe.
- The iframe URL includes `mmsi=338414915`, `start_time`, and `end_time` for the initial selected舰艇.
- “只看关注舰艇” hides or collapses other舰艇 information.
- Switching a舰艇 updates the iframe `src`.
- If the iframe does not render within 12 seconds, the fallback with “打开原始地图” appears.
- The page does not show the removed chart grid as first-screen content.

- [ ] **Step 4: Fix verification defects with TDD where possible**

If a pure behavior fails, write or update a failing test first. Example for URL regression:

```js
test("buildRemoteMapUrl updates selected mmsi", () => {
  const url = buildRemoteMapUrl({ mmsi: "338555323", startTime: 1, endTime: 2 });
  assert.equal(url, "http://218.61.33.200:18000/?mmsi=338555323&start_time=1&end_time=2");
});
```

Run:

```powershell
npm test -- src/logic/playback.test.js
```

Expected before fix: FAIL for the regression. Expected after fix: PASS.

- [ ] **Step 5: Final commit**

Only if verification required source changes:

```powershell
git add src
git commit -m "fix: verify playback center behavior"
```

---

## Self-Review Checklist

- Spec goal “轨迹回放中心” maps to Tasks 3, 5, 7, and 9.
- Remote iframe embedding maps to Tasks 2, 3, 5, and 9.
- Single-vessel focus mode maps to Tasks 1, 2, 4, 5, and 9.
- “目标”改“舰艇” maps to Task 8.
- Removing redundant complex charts maps to Task 6.
- Testing and verification map to Tasks 1, 2, 5, 6, 7, 8, and 9.
- No backend service or remote-map source changes are planned.
