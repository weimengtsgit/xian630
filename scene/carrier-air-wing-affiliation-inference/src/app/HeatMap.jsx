import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapIcon, Layers } from "lucide-react";
import { fmtDateTime } from "./statusHelpers.js";
import { buildMapData, boundsForMapData, computeTimeWindow } from "../logic/mapData.js";
import { isSatelliteSourceError, resolveMapClickAction } from "../logic/mapInteraction.js";

// Lower-right panel — 起降热力地图 (MapLibre GL satellite basemap + GeoJSON overlays).
// Layers: red/orange sea takeoff/landing heat points, cyan carrier tracks, optional
// land/unknown audit points. Timeline replay scrubs the visible window. Hover/click an
// event → detail popover.
const tileUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const mapStyle = {
  version: 8,
  sources: {
    satellite: { type: "raster", tiles: [tileUrl], tileSize: 256, attribution: "Tiles © Esri" },
  },
  layers: [
    {
      id: "satellite",
      type: "raster",
      source: "satellite",
      paint: { "raster-brightness-max": 0.62, "raster-contrast": 0.26, "raster-saturation": -0.08 },
    },
  ],
};

const SOURCE_NAMES = ["sea-events", "audit-events", "carrier-tracks", "carrier-positions"];
const COLLECTION_FOR = {
  "sea-events": "seaEvents",
  "audit-events": "auditEvents",
  "carrier-tracks": "carrierTracks",
  "carrier-positions": "carrierPositions",
};

const EMPTY_FC = { type: "FeatureCollection", features: [] };

// --- Selection-dependent MapLibre paint-expression helpers ---
// Each returns a MapLibre expression comparing the feature's carrierId / icao
// property to the current selection. When nothing is selected, no feature
// matches the highlight branch (falls back to the default value).
const trackLineWidth = (sel) => ["case", ["==", ["get", "carrierId"], sel ?? null], 2.5, 1.2];
const trackLineOpacity = (sel) => ["case", ["==", ["get", "carrierId"], sel ?? null], 0.95, 0.55];
const positionRadius = (sel) => ["case", ["==", ["get", "carrierId"], sel ?? null], 6, 3.5];
const seaRadius = (sel) => ["case", ["==", ["get", "icao"], sel ?? null], 6, 4];
const seaStrokeColor = (sel) => [
  "case",
  ["==", ["get", "icao"], sel ?? null],
  "#edfaff",
  "rgba(0,0,0,0.5)",
];
const seaStrokeWidth = (sel) => ["case", ["==", ["get", "icao"], sel ?? null], 1.2, 0.5];

// Single source of truth for which selection-driven paint properties to re-push
// when the selection changes. `sel` selects which selection value feeds the expr.
const SELECTION_PAINT = [
  { layer: "carrier-tracks", prop: "line-width", sel: "carrier", expr: trackLineWidth },
  { layer: "carrier-tracks", prop: "line-opacity", sel: "carrier", expr: trackLineOpacity },
  { layer: "carrier-positions", prop: "circle-radius", sel: "carrier", expr: positionRadius },
  { layer: "sea-events", prop: "circle-radius", sel: "icao", expr: seaRadius },
  { layer: "sea-events", prop: "circle-stroke-color", sel: "icao", expr: seaStrokeColor },
  { layer: "sea-events", prop: "circle-stroke-width", sel: "icao", expr: seaStrokeWidth },
];

export function HeatMap({
  events,
  carriers,
  selectedIcao,
  selectedCarrierId,
  onSelectEvent,
  onSelectCarrier,
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const initialFitDone = useRef(false);

  // Refs bridge the latest props into the create-once map handlers, so click/hover
  // resolve against current data/callbacks even though the mount effect has [] deps
  // (this keeps the map reusable if events ever arrive async or change identity).
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const onSelectEventRef = useRef(onSelectEvent);
  onSelectEventRef.current = onSelectEvent;
  const onSelectCarrierRef = useRef(onSelectCarrier);
  onSelectCarrierRef.current = onSelectCarrier;

  const [mapError, setMapError] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [hover, setHover] = useState(null);
  const [showSea, setShowSea] = useState(true);
  const [showTracks, setShowTracks] = useState(true);
  const [showAudit, setShowAudit] = useState(true);

  // timeline replay: a window [startMs, endMs]; default = full range.
  // computeTimeWindow ignores unparseable times so one bad timestamp can't NaN
  // the whole window and blank the map.
  const { min: minT, max: maxT, span } = useMemo(() => computeTimeWindow(events), [events]);
  const [winFrac, setWinFrac] = useState(1); // 0..1, fraction of timeline windowed from the start
  const winStart = minT;
  const winEnd = minT + span * winFrac;

  // Live windowed map data (drives the data effect).
  const mapData = useMemo(
    () => buildMapData({ events, carriers, winStart, winEnd }),
    [events, carriers, winStart, winEnd]
  );

  // Full-range bounds for the one-time initial fit (reactive, so async data still fits).
  const fullRangeBounds = useMemo(
    () => boundsForMapData(buildMapData({ events, carriers, winStart: minT, winEnd: maxT })),
    [events, carriers, minT, maxT]
  );

  // --- Mount effect: create the map ONCE ---
  useEffect(() => {
    if (mapRef.current) return; // StrictMode double-invoke guard
    if (!mapContainerRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: mapStyle,
      center: [140, 35],
      zoom: 2,
      attributionControl: false,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl(), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "nautical" }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map.on("error", (event) => {
      if (isSatelliteSourceError(event)) {
        setMapError(true);
      }
    });

    map.on("load", () => {
      // 4 GeoJSON sources
      map.addSource("sea-events", { type: "geojson", data: EMPTY_FC });
      map.addSource("audit-events", { type: "geojson", data: EMPTY_FC });
      map.addSource("carrier-tracks", { type: "geojson", data: EMPTY_FC });
      map.addSource("carrier-positions", { type: "geojson", data: EMPTY_FC });

      // Layer order: tracks → positions → audit → sea (sea on top)
      map.addLayer({
        id: "carrier-tracks",
        type: "line",
        source: "carrier-tracks",
        layout: { visibility: "visible" },
        paint: {
          "line-color": "#68ddff",
          "line-width": trackLineWidth(selectedCarrierId),
          "line-opacity": trackLineOpacity(selectedCarrierId),
        },
      });

      map.addLayer({
        id: "carrier-positions",
        type: "circle",
        source: "carrier-positions",
        layout: { visibility: "visible" },
        paint: {
          "circle-radius": positionRadius(selectedCarrierId),
          "circle-color": "#68ddff",
          "circle-stroke-color": "#0a1a24",
          "circle-stroke-width": 1,
          "circle-opacity": 0.9,
        },
      });

      map.addLayer({
        id: "audit-events",
        type: "circle",
        source: "audit-events",
        layout: { visibility: "visible" },
        paint: {
          "circle-radius": 5,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": [
            "match",
            ["get", "surfaceType"],
            "land",
            "rgba(127,235,155,0.85)",
            "rgba(143,176,191,0.85)",
          ],
          "circle-stroke-width": 1.4,
        },
      });

      map.addLayer({
        id: "sea-events",
        type: "circle",
        source: "sea-events",
        layout: { visibility: "visible" },
        paint: {
          "circle-radius": seaRadius(selectedIcao),
          "circle-color": [
            "match",
            ["get", "eventType"],
            "takeoff",
            "#ff665e",
            "#ff9a78",
          ],
          "circle-stroke-color": seaStrokeColor(selectedIcao),
          "circle-stroke-width": seaStrokeWidth(selectedIcao),
          "circle-opacity": [
            "case",
            ["==", ["get", "bindingStatus"], "bound"],
            0.95,
            0.55,
          ],
        },
      });

      // MapLibre returns every rendered feature under the pointer. Resolve that
      // set to a single action so an event on a track still drills into its row.
      map.on("click", (e) => {
        const action = resolveMapClickAction(map.queryRenderedFeatures(e.point));
        if (!action) return;
        if (action.kind === "carrier") {
          onSelectCarrierRef.current?.(action.carrierId);
          return;
        }
        const evt = eventsRef.current.find((ev) => ev.id === action.eventId);
        if (!evt) return;
        setHover(evt);
        if (action.kind === "event") onSelectEventRef.current?.(evt);
      });

      // --- hover handlers ---
      const enterPointer = () => {
        map.getCanvas().style.cursor = "pointer";
      };
      const leaveCursor = () => {
        map.getCanvas().style.cursor = "";
      };
      const handleEventHover = (e) => {
        enterPointer();
        const f = e.features && e.features[0];
        if (!f || !f.properties) return;
        const evt = eventsRef.current.find((ev) => ev.id === f.properties.id);
        if (evt) setHover(evt);
      };
      const clearHover = () => {
        leaveCursor();
        setHover(null);
      };

      map.on("mouseenter", "sea-events", handleEventHover);
      map.on("mouseenter", "audit-events", handleEventHover);
      map.on("mouseenter", "carrier-tracks", enterPointer);
      map.on("mouseenter", "carrier-positions", enterPointer);
      map.on("mouseleave", "sea-events", clearHover);
      map.on("mouseleave", "audit-events", clearHover);
      map.on("mouseleave", "carrier-tracks", leaveCursor);
      map.on("mouseleave", "carrier-positions", leaveCursor);

      setMapLoaded(true);
    });

    // ResizeObserver keeps the map sized to the panel.
    const ro = new ResizeObserver(() => {
      map.resize();
    });
    ro.observe(mapContainerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      setMapLoaded(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Data effect: push windowed GeoJSON + one-time, data-aware fit ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    for (const name of SOURCE_NAMES) {
      const src = map.getSource(name);
      if (src) src.setData(mapData[COLLECTION_FOR[name]]);
    }

    // Fit to the full data range exactly once, but only once bounds exist — so a
    // later/async data load still gets framed (the flag flips only on a real fit).
    if (!initialFitDone.current && fullRangeBounds) {
      map.fitBounds(fullRangeBounds, { padding: 48, maxZoom: 6, duration: 0 });
      initialFitDone.current = true;
    }
  }, [mapData, mapLoaded, fullRangeBounds]);

  // --- Style effect: layer visibility + selection-driven paint (no data push) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const setVis = (layer, on) => {
      if (map.getLayer(layer)) {
        map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
      }
    };
    setVis("sea-events", showSea);
    setVis("carrier-tracks", showTracks);
    setVis("carrier-positions", showTracks);
    setVis("audit-events", showAudit);

    for (const { layer, prop, sel, expr } of SELECTION_PAINT) {
      if (map.getLayer(layer)) {
        map.setPaintProperty(layer, prop, expr(sel === "carrier" ? selectedCarrierId : selectedIcao));
      }
    }
  }, [selectedCarrierId, selectedIcao, showSea, showTracks, showAudit, mapLoaded]);

  // Popover renders at a fixed anchor at the top of the map panel (no pixel projection).
  const pop = hover ? { evt: hover } : null;
  const altitudeText = pop?.evt?.altitudeTransition
    ? `${pop.evt.altitudeTransition.from}→${pop.evt.altitudeTransition.to} ft`
    : "—";
  const coordText =
    pop?.evt?.lat != null && pop?.evt?.lon != null
      ? `${pop.evt.lat.toFixed(2)}, ${pop.evt.lon.toFixed(2)}`
      : "—";
  const surfaceText =
    pop?.evt?.surfaceType != null
      ? `${pop.evt.surfaceType}（${pop.evt.surfaceConfidence != null ? `${(pop.evt.surfaceConfidence * 100).toFixed(0)}%` : "—"}）`
      : "—";

  return (
    <section className="cai-mapwrap">
      <div className="cai-panel-head" style={{ borderTop: "none" }}>
        <h2>
          <MapIcon size={14} style={{ verticalAlign: "-2px" }} /> 全球起降热力地图
        </h2>
        <span className="meta">
          海上 {mapData.seaEvents.features.length} · 审计 {mapData.auditEvents.features.length}
        </span>
      </div>
      <div className="cai-mapcanvas-wrap">
        <div ref={mapContainerRef} className="cai-mapcanvas" />

        {/* basemap failure status */}
        {mapError && (
          <div className="cai-map-status">底图加载受限</div>
        )}

        {/* legend */}
        <div className="cai-map-legend">
          <div className="row"><span style={{ color: "#ff665e" }}>●</span> 海上起飞（红）</div>
          <div className="row"><span style={{ color: "#ff9a78" }}>●</span> 海上降落（橙红）</div>
          <div className="row"><span style={{ color: "#68ddff" }}>●</span> 航母已知航迹（蓝）</div>
          <div className="row"><span style={{ color: "rgba(127,235,155,0.8)" }}>▢</span> 陆地审计点</div>
          <div className="row"><span style={{ color: "rgba(143,176,191,0.8)" }}>▢</span> 未知审计点</div>
          <div className="row" style={{ color: "var(--text-muted)" }}>半透明 = 未绑定</div>
        </div>

        {/* layer toggles */}
        <div className="cai-map-layers">
          <span className="lbl"><Layers size={10} style={{ verticalAlign: "-1px" }} /> 图层</span>
          <button className={showSea ? "active" : ""} onClick={() => setShowSea((v) => !v)}>
            <span className="led" style={{ background: showSea ? "#ff665e" : "#3a5563" }} /> 海上起降
          </button>
          <button className={showTracks ? "active" : ""} onClick={() => setShowTracks((v) => !v)}>
            <span className="led" style={{ background: showTracks ? "#68ddff" : "#3a5563" }} /> 航母航迹
          </button>
          <button className={showAudit ? "active" : ""} onClick={() => setShowAudit((v) => !v)}>
            <span className="led" style={{ background: showAudit ? "#7feb9b" : "#3a5563" }} /> 审计点
          </button>
        </div>

        {/* hover popover (fixed anchor at top of map panel) */}
        {pop && (
          <div className="cai-popover" style={{ left: 12, top: 12 }}>
            <h5>{pop.evt.icao} · {pop.evt.eventType === "takeoff" ? "起飞" : "降落"}</h5>
            <div className="pr"><span className="k">机型</span><span className="v">{pop.evt.aircraftType ?? "—"}</span></div>
            <div className="pr"><span className="k">时间</span><span className="v">{fmtDateTime(pop.evt.time)}</span></div>
            <div className="pr"><span className="k">高度过渡</span><span className="v">{altitudeText}</span></div>
            <div className="pr"><span className="k">速度</span><span className="v">{pop.evt.speedKt != null ? `${pop.evt.speedKt} 节` : "—"}</span></div>
            <div className="pr"><span className="k">坐标</span><span className="v">{coordText}</span></div>
            <div className="pr"><span className="k">海陆分类</span><span className="v">{surfaceText}</span></div>
            <div className="pr"><span className="k">绑定航母</span><span className="v">{pop.evt.boundCarrierId || "未绑定"}</span></div>
            <div className="pr"><span className="k">距航母</span><span className="v">{pop.evt.distanceNm != null ? `${pop.evt.distanceNm.toFixed(0)} 海里` : "—"}</span></div>
            <div className="pr"><span className="k">航母位置时差</span><span className="v">{pop.evt.carrierPositionTimeDeltaMinutes != null ? `${pop.evt.carrierPositionTimeDeltaMinutes} 分钟` : "—"}</span></div>
            <div className="pr"><span className="k">绑定结果</span><span className="v">{pop.evt.bindingStatus === "bound" ? "已绑定" : pop.evt.suspected ? "未绑定（疑似）" : "非海上（审计）"}</span></div>
          </div>
        )}

        {/* source-boundary footer */}
        <div className="cai-source-footer">
          <b>数据接入边界（mock）</b><br />
          ADS-B 历史数据库 · 美航母已知位置库 · 海陆掩膜
        </div>
      </div>

      {/* timeline replay */}
      <div className="cai-replay">
        <span className="win">回放窗口</span>
        <input
          type="range"
          min={0.02}
          max={1}
          step={0.01}
          value={winFrac}
          onChange={(e) => setWinFrac(parseFloat(e.target.value))}
        />
        <span className="win">
          {fmtDateTime(new Date(winStart).toISOString())} → {fmtDateTime(new Date(winEnd).toISOString())}
        </span>
        <button className={winFrac >= 0.999 ? "active" : ""} onClick={() => setWinFrac(1)}>全部</button>
      </div>
    </section>
  );
}
