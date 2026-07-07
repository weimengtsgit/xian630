# SEASATS Test Craft Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `SEASATS测试艇活动监测` preset scene app from the two customer Excel attachments.

**Architecture:** A Vite/React scene under `scene/seasats-test-craft-monitor/` reads a generated JSON payload, computes all scoring/alert/map state in pure modules, and renders a MapLibre command dashboard. The Excel parsing script is build-time tooling only; the browser consumes `src/data/seasatsPayload.json`.

**Tech Stack:** React 18, Vite, MapLibre GL JS with Esri World Imagery raster tiles, lucide-react, Node test runner, Python/openpyxl for data extraction.

---

### Task 1: Data Extraction And Domain Logic

**Files:**
- Create: `scene/seasats-test-craft-monitor/scripts/build-data.py`
- Create: `scene/seasats-test-craft-monitor/src/data/seasatsPayload.json`
- Create: `scene/seasats-test-craft-monitor/src/logic/domain.js`
- Create: `scene/seasats-test-craft-monitor/src/logic/domain.test.js`

- [ ] Write failing tests for `normalizeTargetSpeedKn`, `isNameHit`, `dimensionMatch`, `splitTrackSegments`, `detectAisGaps`, `scoreTarget`, and `buildAlerts`.
- [ ] Run `cd scene/seasats-test-craft-monitor && npm test` and verify the test fails because `src/logic/domain.js` does not exist.
- [ ] Implement `domain.js` with pure functions only. Use nautical miles for distance, `0 <= speed <= 3` for low speed, 30 minutes / 6 hours for AIS gaps, and 10 minutes for sustained low speed.
- [ ] Run `npm test` and verify the domain tests pass.
- [ ] Run `scripts/build-data.py` against the two Excel files and inspect the generated JSON summary.

### Task 2: Map GeoJSON Adapter

**Files:**
- Create: `scene/seasats-test-craft-monitor/src/logic/mapData.js`
- Create: `scene/seasats-test-craft-monitor/src/logic/mapData.test.js`
- Create: `scene/seasats-test-craft-monitor/src/logic/mapInteraction.js`
- Create: `scene/seasats-test-craft-monitor/src/logic/mapInteraction.test.js`

- [ ] Write failing tests for converting visible targets, monitored areas, track segments, AIS gaps, and alert events into GeoJSON FeatureCollections.
- [ ] Run `npm test` and verify the tests fail because the adapter files do not exist.
- [ ] Implement `mapData.js` with `buildMapData`, `boundsForMapData`, and `emptyFeatureCollection`.
- [ ] Implement `mapInteraction.js` with click priority: alert point, vessel point, AIS gap, track segment, monitored area.
- [ ] Run `npm test` and verify all logic tests pass.

### Task 3: React Application And MapLibre Canvas

**Files:**
- Create: `scene/seasats-test-craft-monitor/package.json`
- Create: `scene/seasats-test-craft-monitor/index.html`
- Create: `scene/seasats-test-craft-monitor/vite.config.js`
- Create: `scene/seasats-test-craft-monitor/src/main.jsx`
- Create: `scene/seasats-test-craft-monitor/src/app/App.jsx`
- Create: `scene/seasats-test-craft-monitor/src/app/MapPanel.jsx`
- Create: `scene/seasats-test-craft-monitor/src/styles/global.css`

- [ ] Add Vite/React dependencies: `react`, `react-dom`, `lucide-react`, `maplibre-gl`, `vite`, and `@vitejs/plugin-react`.
- [ ] Build `App.jsx` with top metrics, target filters/list, MapLibre center panel, alert/detail rail, and timeline controls.
- [ ] Build `MapPanel.jsx` as a single MapLibre instance using Esri World Imagery tiles, GeoJSON sources/layers, one-time fit bounds, layer visibility updates, selection paint updates, and `底图加载受限` fallback.
- [ ] Build responsive CSS with stable grid dimensions, non-overlapping panels, and operational color semantics.
- [ ] Run `npm run build` and fix any Vite or React errors.

### Task 4: Preset Registration And Documentation

**Files:**
- Create: `scene/seasats-test-craft-monitor/.factory/app.json`
- Create: `scene/seasats-test-craft-monitor/README.md`
- Modify: `.factory/scene-catalog.json`
- Modify: `docs/customer-scenarios-preset-apps-plan.md`

- [ ] Add `.factory/app.json` with slug `seasats-test-craft-monitor`, name `SEASATS测试艇活动监测`, type `command-dashboard`, source `preset`, and default port `5179`.
- [ ] Add the slug to `.factory/scene-catalog.json` as `surface: "application"` with the next available application order.
- [ ] Add README data-boundary, MapLibre network dependency, and verification notes.
- [ ] Ensure the customer scenario plan mentions the confirmed slug and application surface.

### Task 5: Verification

**Files:**
- No new source files unless verification reveals defects.

- [ ] Run `cd scene/seasats-test-craft-monitor && npm test`.
- [ ] Run `cd scene/seasats-test-craft-monitor && npm run build`.
- [ ] Run scanner tests that validate scene catalog behavior.
- [ ] Start `npm run dev -- --host 127.0.0.1 --port 5179`.
- [ ] Use browser automation or Playwright to open `http://127.0.0.1:5179`, capture desktop and mobile screenshots, and verify MapLibre canvas, overlays, list, alerts, and timeline are visible.
