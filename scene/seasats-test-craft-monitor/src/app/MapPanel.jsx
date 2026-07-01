import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Layers, MapPin, Satellite } from "lucide-react";
import { boundsForMapData } from "../logic/mapData.js";
import { isSatelliteSourceError, resolveMapClickAction } from "../logic/mapInteraction.js";

const tileUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const mapStyle = {
  version: 8,
  sources: { satellite: { type: "raster", tiles: [tileUrl], tileSize: 256, attribution: "Tiles © Esri" } },
  layers: [{
    id: "satellite",
    type: "raster",
    source: "satellite",
    paint: { "raster-brightness-max": 0.62, "raster-contrast": 0.26, "raster-saturation": -0.08 },
  }],
};

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
const emptyCollection = { type: "FeatureCollection", features: [] };
const selectedTargetRadius = (mmsi) => ["case", ["==", ["get", "mmsi"], mmsi ?? null], 8, 4.5];
const selectedTargetStroke = (mmsi) => ["case", ["==", ["get", "mmsi"], mmsi ?? null], 2, 0.8];
const selectedTrackWidth = (mmsi) => ["case", ["==", ["get", "targetMmsi"], mmsi ?? null], 3, 1.3];
const selectedTrackOpacity = (mmsi) => ["case", ["==", ["get", "targetMmsi"], mmsi ?? null], 0.95, 0.42];
const selectedAlertRadius = (alertId) => ["case", ["==", ["get", "id"], alertId ?? null], 12, ["match", ["get", "severity"], "critical", 9, "warning", 7, 5]];
const selectedAlertStroke = (alertId) => ["case", ["==", ["get", "id"], alertId ?? null], 2.6, 1.4];

function isValidLngLat(lon, lat) {
  return typeof lon === "number" && Number.isFinite(lon) && typeof lat === "number" && Number.isFinite(lat);
}

export function MapPanel({ mapData, selectedMmsi, selectedAlertId, focusRequest, onAction }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const fitDoneRef = useRef(false);
  const lastFitMmsi = useRef(null);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const [loaded, setLoaded] = useState(false);
  const [basemapLimited, setBasemapLimited] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [showAreas, setShowAreas] = useState(true);
  const [showTracks, setShowTracks] = useState(true);
  const [showAlerts, setShowAlerts] = useState(true);
  const [showTargets, setShowTargets] = useState(true);
  const bounds = useMemo(() => boundsForMapData(mapData), [mapData]);

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    let map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: mapStyle,
        center: [120, 21],
        zoom: 3,
        attributionControl: false,
        scrollZoom: true,
        dragPan: true,
        doubleClickZoom: true,
        touchZoomRotate: true,
      });
    } catch (error) {
      setBasemapLimited(true);
      setMapError(error?.message || "当前环境无法初始化 WebGL 地图");
      return undefined;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "nautical" }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("error", (event) => {
      if (isSatelliteSourceError(event)) setBasemapLimited(true);
      if (String(event?.error?.message || "").includes("WebGL")) {
        setMapError("当前环境无法初始化 WebGL 地图");
      }
    });
    map.on("load", () => {
      for (const sourceId of Object.keys(collectionForSource)) {
        map.addSource(sourceId, { type: "geojson", data: emptyCollection });
      }
      map.addLayer({ id: "monitored-area-fill", type: "fill", source: "monitored-areas", paint: { "fill-color": "#13b8a6", "fill-opacity": 0.13 } });
      map.addLayer({ id: "monitored-area-outline", type: "line", source: "monitored-areas", paint: { "line-color": "#43f5d6", "line-width": 1.2, "line-opacity": 0.8 } });
      map.addLayer({ id: "track-segments", type: "line", source: "track-segments", filter: ["!=", ["get", "targetMmsi"], selectedMmsi ?? null], paint: { "line-color": "#64748b", "line-width": 1.4, "line-opacity": 0.4 } });
      map.addLayer({ id: "ais-gaps", type: "circle", source: "ais-gaps", paint: { "circle-radius": 6, "circle-color": ["match", ["get", "severity"], "critical", "#ef4444", "warning", "#f59e0b", "#9ca3af"], "circle-stroke-color": "#fff7ed", "circle-stroke-width": 1, "circle-opacity": 0.95 } });
      map.addLayer({ id: "vessel-points", type: "circle", source: "vessel-points", paint: { "circle-radius": selectedTargetRadius(selectedMmsi), "circle-color": ["match", ["get", "status"], "异常行为目标", "#ef4444", "高可信目标", "#22c55e", "待核验目标", "#eab308", "#94a3b8"], "circle-stroke-color": "#f8fafc", "circle-stroke-width": selectedTargetStroke(selectedMmsi), "circle-opacity": 0.92 } });
      map.addLayer({ id: "alert-points", type: "circle", source: "alert-points", paint: { "circle-radius": selectedAlertRadius(selectedAlertId), "circle-color": ["match", ["get", "severity"], "critical", "#dc2626", "warning", "#f97316", "#38bdf8"], "circle-stroke-color": "#fef2f2", "circle-stroke-width": selectedAlertStroke(selectedAlertId), "circle-opacity": 0.86 } });
      map.addLayer({ id: "coast-line", type: "line", source: "coast-line", paint: { "line-color": "#22d3ee", "line-width": 1.6, "line-opacity": 0.9 } });
      map.addLayer({ id: "coast-buffer", type: "line", source: "coast-line", paint: { "line-color": "#ef4444", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 6, 8, 26], "line-opacity": 0.10 } });
      map.addLayer({ id: "max-speed-segment", type: "line", source: "max-speed-segment", paint: { "line-color": "#ef4444", "line-width": 3.4, "line-opacity": 0.95 } });
      map.addLayer({ id: "speed-segments-halo", type: "line", source: "speed-segments", paint: { "line-color": "#fbbf24", "line-width": 7, "line-opacity": 0.4, "line-blur": 1.4 } });
      map.addLayer({ id: "speed-segments", type: "line", source: "speed-segments", paint: { "line-color": ["interpolate", ["linear"], ["get", "speedKn"], 0, "#3b82f6", 5, "#eab308", 10, "#ef4444"], "line-width": 3.5, "line-opacity": 0.95 } });
      map.addLayer({ id: "nearest-point", type: "circle", source: "nearest-point", paint: { "circle-radius": 7, "circle-color": "#22d3ee", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
      const clickableLayers = ["alert-points", "vessel-points", "ais-gaps", "track-segments", "monitored-area-fill", "monitored-area-outline"];
      map.on("click", (event) => {
        const action = resolveMapClickAction(map.queryRenderedFeatures(event.point, { layers: clickableLayers }));
        if (action) onActionRef.current?.(action);
      });
      clickableLayers.forEach((layer) => {
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
      });
      const pulseTimer = setInterval(() => {
        if (!mapRef.current || !map.getLayer("alert-points")) return;
        const phase = (Date.now() % 1200) / 1200;
        const op = 0.35 + 0.5 * Math.abs(Math.sin(phase * Math.PI));
        map.setPaintProperty("alert-points", "circle-stroke-opacity", op);
      }, 120);
      mapRef.current._pulseTimer = pulseTimer;
      setLoaded(true);
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    return () => {
      if (mapRef.current?._pulseTimer) clearInterval(mapRef.current._pulseTimer);
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const [sourceId, collectionName] of Object.entries(collectionForSource)) {
      const source = map.getSource(sourceId);
      if (source) source.setData(mapData[collectionName] || emptyCollection);
    }
    if (!fitDoneRef.current && bounds) {
      map.fitBounds(bounds, { padding: 44, maxZoom: 7, duration: 0 });
      fitDoneRef.current = true;
    }
  }, [bounds, loaded, mapData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const visible = (layer, on) => map.getLayer(layer) && map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    visible("monitored-area-fill", showAreas);
    visible("monitored-area-outline", showAreas);
    visible("track-segments", showTracks);
    visible("ais-gaps", showAlerts);
    visible("alert-points", showAlerts);
    visible("vessel-points", showTargets);
    visible("coast-line", showAreas);
    visible("coast-buffer", showAreas);
    visible("speed-segments-halo", showTracks);
    visible("speed-segments", showTracks);
    visible("max-speed-segment", showTracks);
    visible("nearest-point", showTargets);
    if (map.getLayer("vessel-points")) {
      map.setPaintProperty("vessel-points", "circle-radius", selectedTargetRadius(selectedMmsi));
      map.setPaintProperty("vessel-points", "circle-stroke-width", selectedTargetStroke(selectedMmsi));
    }
    if (map.getLayer("track-segments")) {
      map.setFilter("track-segments", ["!=", ["get", "targetMmsi"], selectedMmsi ?? null]);
    }
    if (map.getLayer("alert-points")) {
      map.setPaintProperty("alert-points", "circle-radius", selectedAlertRadius(selectedAlertId));
      map.setPaintProperty("alert-points", "circle-stroke-width", selectedAlertStroke(selectedAlertId));
    }
  }, [loaded, selectedAlertId, selectedMmsi, showAlerts, showAreas, showTargets, showTracks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !focusRequest || !isValidLngLat(focusRequest.lon, focusRequest.lat)) return;
    map.flyTo({
      center: [focusRequest.lon, focusRequest.lat],
      zoom: focusRequest.zoom || 10,
      duration: 900,
      essential: true,
    });
  }, [focusRequest, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !selectedMmsi) return;
    if (lastFitMmsi.current === selectedMmsi) return;
    lastFitMmsi.current = selectedMmsi;
    const b = boundsForMapData({ trackSegments: mapData.speedSegments });
    if (b) map.fitBounds(b, { padding: 60, maxZoom: 11, duration: 700 });
  }, [selectedMmsi, loaded, mapData]);

  return (
    <section className="map-panel">
      <header className="panel-head map-head">
        <div>
          <h2><MapPin size={16} />轨迹与重点区域</h2>
          <span>{basemapLimited ? "底图加载受限" : "Esri World Imagery"}</span>
        </div>
        <div className="map-badges">
          <span><Satellite size={13} />在线底图</span>
          <span><Layers size={13} />GeoJSON 图层</span>
        </div>
      </header>
      <div className="map-canvas-wrap">
        <div ref={containerRef} className="map-canvas" />
        {mapError && (
          <div className="map-fallback">
            <strong>地图渲染受限</strong>
            <span>当前浏览器环境无法初始化 WebGL，目标、告警和轨迹数据仍可在两侧面板查看。</span>
          </div>
        )}
        {basemapLimited && <div className="map-warning">底图加载受限</div>}
        <div className="map-toggles" aria-label="图层">
          <button className={showTargets ? "on" : ""} onClick={() => setShowTargets((v) => !v)}>目标</button>
          <button className={showTracks ? "on" : ""} onClick={() => setShowTracks((v) => !v)}>轨迹</button>
          <button className={showAreas ? "on" : ""} onClick={() => setShowAreas((v) => !v)}>区域</button>
          <button className={showAlerts ? "on" : ""} onClick={() => setShowAlerts((v) => !v)}>告警</button>
        </div>
        <div className="map-legend">
          <span><i className="dot critical" />异常</span>
          <span><i className="dot warning" />待核验</span>
          <span><i className="line" />轨迹片段</span>
          <span><i className="area" />重点区域</span>
        </div>
      </div>
    </section>
  );
}
