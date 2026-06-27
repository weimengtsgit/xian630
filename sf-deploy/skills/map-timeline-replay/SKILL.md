---
name: map-timeline-replay
description: Generate a real map (MapLibre GL + Esri satellite tiles) with track, event points, and timeline replay for the software factory. Prescribes the map stack, the single-instance + update-not-rebuild architecture, and the MapLibre pitfalls to avoid.
---

# Map Timeline Replay

Naval/maritime apps almost always need a real, pan/zoom-able map with tracks and a
timeline. Use this skill whenever a generated app shows geography, tracks, event points,
or time-based replay.

## Stack (the map choice)

- **MapLibre GL JS** + **public Esri World Imagery raster tiles**, **no API key / account**.
  - Tile URL: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
  - Mapbox needs a token; MapLibre is open-source and token-free. Esri public tiles are
    keyless, so generated apps run without secrets.
  - Tune the raster so colored tactical markers stay legible on imagery:
    `raster-brightness-max: 0.62`, `raster-contrast: 0.26`, `raster-saturation: -0.08`.
- Keep `attribution: "Tiles © Esri"` and a compact `AttributionControl`.
- Public tiles **require network**. Always ship a degradation state (`底图加载受限`)
  that keeps the GeoJSON business layers visible when tiles fail.

## Must Do

- Use a **single** MapLibre map instance owned by one component. Create it once in a mount
  effect guarded by a ref (StrictMode double-invoke safe). **Never re-create** it on
  selection / layer-toggle / replay changes.
- Because that mount effect has `[]` deps, its click/hover handlers would close over the
  first render's data/callbacks. **Bridge the latest props via refs** (`eventsRef.current`,
  `onSelectEventRef.current`, …) read inside the handlers, so the map stays correct if data
  ever arrives async or changes identity.
- Keep update logic in **separate effects by concern**: one pushes GeoJSON data
  (`getSource().setData`) keyed on the data memo, another pushes visibility + selection
  paint keyed on selection/toggles. Do not lump them together.
- Compute the replay time window with a **NaN-filtering** helper (`computeTimeWindow`) —
  one unparseable event time must not inject `NaN` into `min/max/span` and blank the map.
- `fitBounds` to the full data range **once**, but only set the "done" flag when bounds are
  non-null — so a later/async data load still gets framed instead of being skipped forever.
- Separate pure, side-effect-free logic from the map component so it is unit-testable:
  - a **GeoJSON adapter** module: domain records → GeoJSON FeatureCollections + initial
    bounds (`[lon, lat]` order; return `null` bounds for an empty set).
  - an **interaction** module: classify click targets and basemap errors as pure functions.
- Keep legend, layer toggles, timeline/replay slider, and hover/click detail as **React
  overlays** above the canvas (with `z-index`), not inside MapLibre.
- On selection / toggle / replay change, update the existing map — never rebuild:
  `getSource(id).setData(fc)`, `setLayoutProperty(layer, "visibility", ...)`, and
  `setPaintProperty(...)` for selection-driven style.
- Fit the view to the data **once** after initial load (`fitBounds(bounds, { padding, maxZoom: 6, duration: 0 })`).
  Do NOT refit on replay or selection — preserve the user's manual pan/zoom.
- Install a `ResizeObserver` on the container that calls `map.resize()` (Portal iframes
  resize); disconnect it and call `map.remove()` in the effect cleanup.
- Keep the map area in the East China Sea or a user-confirmed maritime area when relevant.
- Provide selected-object detail and event-detail panels; link timeline selection to the
  visible track/event state. Use mock coordinates and events when no real source is confirmed.

## Must Avoid (MapLibre pitfalls — each has cost real debugging time)

- **Malformed `match` / `case` expressions fire a *silent* `error` event.** These
  expressions need an **odd** number of args after the input (label/value pairs + one
  default). A duplicated default → even count → MapLibre emits `error` and the layer
  silently falls back. Write them carefully and prefer the pure selection-paint helpers.
- **`map.on("error", …)` is a catch-all**, not a basemap-failure signal — it also fires for
  the malformed-expression case above. Filter it (e.g. `isSatelliteSourceError(event)`) and
  only show the degradation banner for real tile/source failures.
- **Per-layer `map.on("click", layerId, h)` fires for EVERY layer with a feature at the
  point.** When features overlap (tracks under event points), multiple handlers race and
  selection toggles cancel out. Use **one** generic `map.on("click", e => …)` that runs
  `map.queryRenderedFeatures(e.point)` and resolves to a single action by priority
  (e.g. carrier marker/track first, else topmost event).
- **Selection-driven paint set at layer creation is frozen.** Re-push it via
  `setPaintProperty` in the update effect whenever the selection changes.
- **GeoJSON feature `properties` are serialized JSON** — no functions, nested objects become
  plain JSON. Recover the original domain object with `events.find(e => e.id === feature.properties.id)`
  before calling selection callbacks.
- **The map container needs an explicit height.** MapLibre will not fill a zero-height
  parent. Give the wrapper a real height (flex/grid child + `position: absolute; inset: 0`
  on the canvas).
- **Public Esri tiles need network.** Don't assume imagery loads; always keep GeoJSON
  overlays independent of basemap availability.

## Reference Implementation

`scene/carrier-air-wing-affiliation-inference/` is the canonical, browser-verified example:

- `src/logic/mapData.js` — pure adapter: `buildMapData` (events/carriers → 4
  FeatureCollections), `boundsForMapData` (mapData → `[[w,s],[e,n]]` or null), and
  `computeTimeWindow` (events → `{min,max,span}`, NaN-safe).
- `src/logic/mapInteraction.js` — pure click-resolution (`resolveMapClickAction`) and
  error classification (`isSatelliteSourceError`).
- `src/app/HeatMap.jsx` — single MapLibre instance, 4 GeoJSON layers, React overlays,
  update-not-rebuild, one priority click handler, basemap-degradation banner.
- `src/styles/global.css` — `.cai-mapcanvas-wrap` / `.cai-mapcanvas` sizing, overlays,
  responsive breakpoint.
