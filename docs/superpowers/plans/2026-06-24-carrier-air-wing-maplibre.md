# Carrier Air-Wing MapLibre Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the carrier-air-wing dashboard's SVG heat map with a responsive MapLibre GL satellite map while preserving all existing event, carrier, replay, and cross-panel interactions.

**Architecture:** Keep judgement data and React selection state unchanged. Add a pure map-data adapter that turns existing event/carrier records into time-windowed GeoJSON feature collections and initial bounds. A MapLibre-backed `HeatMap` owns one map instance, updates its sources as React state changes, and leaves legends, controls, and details in React overlays.

**Tech Stack:** React 18, MapLibre GL 5.24, Vite 6, Node built-in test runner, Esri World Imagery raster tiles.

---

## File Structure

- Create: `scene/carrier-air-wing-affiliation-inference/src/logic/mapData.js` - pure event/carrier filtering, GeoJSON conversion, and bounds calculation.
- Create: `scene/carrier-air-wing-affiliation-inference/src/logic/mapData.test.js` - Node tests for map-data behavior.
- Modify: `scene/carrier-air-wing-affiliation-inference/src/app/HeatMap.jsx` - replace SVG rendering with a single MapLibre instance and React overlays.
- Modify: `scene/carrier-air-wing-affiliation-inference/src/styles/global.css` - responsive board rules and MapLibre map/overlay styling.
- Modify: `scene/carrier-air-wing-affiliation-inference/package.json` - add `maplibre-gl`.
- Modify: `scene/carrier-air-wing-affiliation-inference/package-lock.json` - lock the installed dependency.
- Modify: `scene/carrier-air-wing-affiliation-inference/README.md` - document public online satellite tiles and the limited-basemap state.
- Delete: `scene/carrier-air-wing-affiliation-inference/src/logic/worldProjection.js` - obsolete SVG projection.
- Delete: `scene/carrier-air-wing-affiliation-inference/src/logic/worldProjection.test.js` - obsolete SVG projection test.

### Task 1: Create the pure map-data adapter with tests

**Files:**
- Create: `scene/carrier-air-wing-affiliation-inference/src/logic/mapData.js`
- Create: `scene/carrier-air-wing-affiliation-inference/src/logic/mapData.test.js`

- [ ] **Step 1: Write failing tests for window filtering and GeoJSON features**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMapData, boundsForMapData } from "./mapData.js";

test("buildMapData keeps suspected sea events and audit events separate", () => {
  const data = buildMapData({
    events: [
      { id: "sea", icao: "A1", eventType: "takeoff", time: "2024-06-01T00:00:00.000Z", lat: 30, lon: 140, suspected: true, bindingStatus: "bound" },
      { id: "land", icao: "A2", eventType: "landing", time: "2024-06-01T00:00:00.000Z", lat: 36, lon: 140, surfaceType: "land", suspected: false },
    ],
    carriers: [],
    winStart: Date.parse("2024-05-31T00:00:00.000Z"),
    winEnd: Date.parse("2024-06-02T00:00:00.000Z"),
  });

  assert.equal(data.seaEvents.features.length, 1);
  assert.equal(data.auditEvents.features.length, 1);
  assert.deepEqual(data.seaEvents.features[0].geometry.coordinates, [140, 30]);
});

test("buildMapData clips carrier tracks to the replay window", () => {
  const data = buildMapData({
    events: [],
    carriers: [{ id: "CVN-78", name: "Ford", track: [
      { time: "2024-06-01T00:00:00.000Z", lat: 30, lon: 140 },
      { time: "2024-06-02T00:00:00.000Z", lat: 31, lon: 141 },
      { time: "2024-06-03T00:00:00.000Z", lat: 32, lon: 142 },
    ] }],
    winStart: Date.parse("2024-06-01T00:00:00.000Z"),
    winEnd: Date.parse("2024-06-02T00:00:00.000Z"),
  });

  assert.deepEqual(data.carrierTracks.features[0].geometry.coordinates, [[140, 30], [141, 31]]);
  assert.deepEqual(data.carrierPositions.features[0].geometry.coordinates, [141, 31]);
});

test("boundsForMapData encloses points and tracks in longitude-latitude order", () => {
  const bounds = boundsForMapData({
    seaEvents: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [140, 30] } }] },
    auditEvents: { type: "FeatureCollection", features: [], },
    carrierTracks: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[138, 29], [142, 32]] } }] },
    carrierPositions: { type: "FeatureCollection", features: [], },
  });

  assert.deepEqual(bounds, [[138, 29], [142, 32]]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the module is absent**

Run: `cd scene/carrier-air-wing-affiliation-inference && node --test src/logic/mapData.test.js`

Expected: `ERR_MODULE_NOT_FOUND` for `mapData.js`.

- [ ] **Step 3: Implement the minimal adapter**

Implement and export `buildMapData({ events, carriers, winStart, winEnd })` and
`boundsForMapData(mapData)`. `buildMapData` must:

```js
const inWindow = (time) => {
  const ms = Date.parse(time);
  return ms >= winStart && ms <= winEnd;
};

const pointFeature = (event) => ({
  type: "Feature",
  id: event.id,
  properties: { ...event },
  geometry: { type: "Point", coordinates: [event.lon, event.lat] },
});
```

Return exactly four FeatureCollections: `seaEvents` for `event.suspected === true`,
`auditEvents` for `surfaceType === "land" || surfaceType === "unknown"`,
`carrierTracks` with one LineString Feature for every carrier having at least two track
samples in the window, and `carrierPositions` with the most recent in-window Point for
every carrier. `boundsForMapData` must include all four collections, flatten only valid
numeric coordinates, and return `null` for an empty collection.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `cd scene/carrier-air-wing-affiliation-inference && node --test src/logic/mapData.test.js`

Expected: 3 passing tests.

### Task 2: Add MapLibre and replace the SVG map renderer

**Files:**
- Modify: `scene/carrier-air-wing-affiliation-inference/package.json`
- Modify: `scene/carrier-air-wing-affiliation-inference/package-lock.json`
- Modify: `scene/carrier-air-wing-affiliation-inference/src/app/HeatMap.jsx`

- [ ] **Step 1: Install the dependency**

Run: `cd scene/carrier-air-wing-affiliation-inference && npm install maplibre-gl@^5.24.0`

Expected: `package.json` and `package-lock.json` record `maplibre-gl`; no unrelated dependency update.

- [ ] **Step 2: Replace only the SVG rendering portion of `HeatMap.jsx`**

Keep the public component props and the existing replay, legend, layer-toggle, detail,
and source-boundary UI contracts. Remove imports and code used only by
`worldProjection.js`, `WORLD_WIDTH`, `WORLD_HEIGHT`, SVG grid lines, SVG paths, and
SVG circles.

Import `maplibregl` and `maplibre-gl/dist/maplibre-gl.css`, then use refs for the
container and one map instance. Use this raster style without a token:

```js
const tileUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const mapStyle = {
  version: 8,
  sources: {
    satellite: { type: "raster", tiles: [tileUrl], tileSize: 256, attribution: "Tiles © Esri" },
  },
  layers: [{
    id: "satellite",
    type: "raster",
    source: "satellite",
    paint: { "raster-brightness-max": 0.62, "raster-contrast": 0.26, "raster-saturation": -0.08 },
  }],
};
```

On `load`, add GeoJSON sources named `sea-events`, `audit-events`, `carrier-tracks`,
and `carrier-positions`. Add the following MapLibre layers, in this order:

1. `carrier-tracks` line layer, cyan; style width/opacity through expressions that
   compare feature property `carrierId` with the selected carrier id.
2. `carrier-positions` circle layer, cyan, with a larger radius for the selected carrier.
3. `audit-events` circle layer, transparent fill and color by `surfaceType`.
4. `sea-events` circle layer, `#ff665e` for takeoffs and `#ff9a78` for landings;
   circle radius and stroke respond to the selected ICAO.

Map click handlers must call the existing callbacks with the original event object or
carrier id. Bind the carrier-selection handler to both `carrier-tracks` and
`carrier-positions`. Feature properties are serialized by MapLibre, so derive the
original event by `events.find((event) => event.id === feature.properties.id)` before
calling `onSelectEvent`. Hovering a point must continue to show the existing event
details.

Add `NavigationControl`, `ScaleControl`, and compact `AttributionControl`. Install a
`ResizeObserver` that calls `map.resize()` and remove both observer and map instance in
the effect cleanup. Do not re-create the map on selection, toggle, or replay changes;
use `getSource(...).setData(...)` in an update effect.

Map `error` events to a visible `底图加载受限` status label but do not remove or hide
the GeoJSON layers. Call `fitBounds(boundsForMapData(initialMapData), { padding: 48,
maxZoom: 6, duration: 0 })` only once after initial load when bounds are non-null.

- [ ] **Step 3: Run focused logic tests and build after the renderer change**

Run: `cd scene/carrier-air-wing-affiliation-inference && npm test && npm run build`

Expected: all pre-existing logic tests plus `mapData.test.js` pass; Vite produces `dist/`.

### Task 3: Make the dashboard and map container responsive

**Files:**
- Modify: `scene/carrier-air-wing-affiliation-inference/src/styles/global.css`

- [ ] **Step 1: Replace the fixed-shell constraints**

Remove `min-width: 1366px`, `min-height: 760px`, and the small-viewport suggestion
overlay. Preserve the full-screen dashboard at large sizes, but make the application
able to shrink within a Portal iframe:

```css
.cai-shell { min-width: 0; min-height: 0; }
.cai-main {
  grid-template-columns: minmax(0, 1.35fr) minmax(360px, 1fr);
  min-width: 0;
  min-height: 0;
}
.cai-mapwrap, .cai-mapsvg-wrap { min-width: 0; min-height: 0; }
```

Rename SVG-specific container rules to MapLibre-neutral names such as
`.cai-mapcanvas-wrap` and `.cai-mapcanvas`. The canvas must fill available panel space.
Keep existing legend, layer controls, source footer, replay bar, and detail popover
above the canvas with suitable `z-index` values.

- [ ] **Step 2: Add a narrow desktop breakpoint**

At `max-width: 1100px`, keep table, tree, and map reachable without clipping by using a
single-column main grid, `overflow: auto` on the board, and a minimum map-panel height
of `320px`. Do not hide any data panel. Ensure panel-control text wraps rather than
overlapping the map.

- [ ] **Step 3: Rebuild after CSS changes**

Run: `cd scene/carrier-air-wing-affiliation-inference && npm run build`

Expected: successful Vite build with no CSS syntax warning.

### Task 4: Remove obsolete SVG projection and update documentation

**Files:**
- Delete: `scene/carrier-air-wing-affiliation-inference/src/logic/worldProjection.js`
- Delete: `scene/carrier-air-wing-affiliation-inference/src/logic/worldProjection.test.js`
- Modify: `scene/carrier-air-wing-affiliation-inference/README.md`

- [ ] **Step 1: Remove the obsolete projection module and test**

Delete both files only after confirming `rg -n "worldProjection|WORLD_WIDTH|WORLD_HEIGHT|projectWorld" scene/carrier-air-wing-affiliation-inference/src` returns no production reference.

- [ ] **Step 2: Update the README map section**

State that the lower-right panel uses MapLibre GL and public Esri World Imagery raster
tiles, therefore requires network access for the satellite base map. State that event
and carrier GeoJSON overlays remain available when the base map is limited. Do not
change the mock-data or judgement-rule contracts.

- [ ] **Step 3: Run the complete scene verification**

Run:

```bash
cd scene/carrier-air-wing-affiliation-inference
npm test
npm run build
git -C ../.. diff --check
```

Expected: every test passes, build succeeds, and the diff check has no output.

### Task 5: Browser verification and focused review

**Files:**
- Verify only; no expected source additions.

- [ ] **Step 1: Start the scene locally**

Run: `cd scene/carrier-air-wing-affiliation-inference && npm run dev -- --host 127.0.0.1 --port 5185`

Expected: Vite serves `http://127.0.0.1:5185/`.

- [ ] **Step 2: Verify the required visual behavior at 1280×720**

Confirm all of the following in a browser:

1. A MapLibre canvas and satellite imagery appear in the lower-right map panel.
2. The initial view includes red/orange sea events and cyan carrier tracks, rather
   than clipping them at the right edge.
3. Turning each layer toggle off removes only its corresponding map layer.
4. Clicking a sea event expands its aircraft row; clicking a carrier track filters the
   aircraft list and highlights that track.
5. Moving the replay slider changes map features without resetting user pan/zoom.
6. The console has no errors; when imagery cannot load, the UI shows `底图加载受限`
   while overlay features still remain.

- [ ] **Step 3: Review scope before reporting**

Run: `git status --short` and inspect the diff. Confirm no change touches ADS-B mock
data, affiliation judgement logic, Factory server, Portal, `CONTEXT.md`, or unrelated
ADR files. Report changed files and the exact commands run. Do not commit or push unless
the user explicitly requests it.
