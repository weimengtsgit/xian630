import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUp, Clock3, Database, Filter, Navigation, Search, ShieldAlert, Ship, Target, X } from "lucide-react";
import { analyzePayload } from "../logic/domain.js";
import { buildMapData } from "../logic/mapData.js";
import { MapPanel } from "./MapPanel.jsx";
import { AlertCard } from "./AlertCard.jsx";
import coastData from "../data/chinaCoast.json";

const payloadUrl = new URL("../data/seasatsPayload.json", import.meta.url).href;
const statusOptions = ["全部状态", "异常行为目标", "高可信目标", "待核验目标", "仅最新位置"];
const sourceOptions = ["全部来源", "真实附件轨迹", "仅最新位置"];

function fmtDateTime(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtShort(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function severityLabel(severity) {
  if (severity === "critical") return "高风险";
  if (severity === "warning") return "关注";
  return "提示";
}

function pointFocus(kind, item, zoom) {
  if (!item || typeof item.lon !== "number" || typeof item.lat !== "number") return null;
  return { key: `${kind}:${item.id || item.mmsi || item.time || item.lon},${item.lat}`, kind, lon: item.lon, lat: item.lat, zoom };
}

function TargetRow({ target, selected, onSelect }) {
  return (
    <button className={`target-row ${selected ? "selected" : ""}`} onClick={() => onSelect(target.mmsi)}>
      <span className={`status-dot ${target.status}`} />
      <span className="target-main"><strong>{target.name}</strong><small>{target.mmsi}</small></span>
      {target.hasObservedTrack
        ? <span className="track-mark has" title="有轨迹"><Navigation size={12} />轨迹</span>
        : <span className="track-mark" title="仅最新位置">仅位置</span>}
      <span className="target-score">{target.score}</span>
    </button>
  );
}

function AlertRow({ alert, selected, onSelect }) {
  return (
    <button className={`alert-row ${alert.severity} ${selected ? "selected" : ""}`} onClick={() => onSelect(alert)}>
      <span className="alert-severity">{severityLabel(alert.severity)}</span>
      <span className="alert-body"><strong>{alert.title}</strong><small>{alert.summary}</small></span>
      <time>{fmtShort(alert.time)}</time>
    </button>
  );
}

export function App() {
  const [payloadData, setPayloadData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(payloadUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => { if (!cancelled) setPayloadData(data); })
      .catch((error) => { if (!cancelled) setLoadError(error); });
    return () => { cancelled = true; };
  }, []);
  if (loadError) {
    return <main className="stm-shell loading-shell"><section className="loading-panel error"><AlertTriangle size={22} /><h1>数据加载失败</h1><p>{loadError.message}</p></section></main>;
  }
  if (!payloadData) {
    return <main className="stm-shell loading-shell"><section className="loading-panel"><Database size={22} /><h1>无人艇跟监告警智能体</h1><p>加载附件分析数据</p></section></main>;
  }
  return <Dashboard payload={payloadData} />;
}

function Dashboard({ payload }) {
  const analysis = useMemo(() => analyzePayload(payload, coastData), [payload]);
  const [selectedMmsi, setSelectedMmsi] = useState(() => analysis.targets[0]?.mmsi);
  const [selectedAlertId, setSelectedAlertId] = useState(() => analysis.alerts[0]?.id || null);
  const [statusFilter, setStatusFilter] = useState(statusOptions[0]);
  const [sourceFilter, setSourceFilter] = useState(sourceOptions[0]);
  const [areaFilter, setAreaFilter] = useState("全部区域");
  const [query, setQuery] = useState("");
  const [replayFrac, setReplayFrac] = useState(1);
  const [mapFocus, setMapFocus] = useState(null);
  const [cardAlert, setCardAlert] = useState(null);
  const [showAlertDrawer, setShowAlertDrawer] = useState(false);
  const minTime = Date.parse(analysis.metadata.dataWindow.start);
  const maxTime = Date.parse(analysis.metadata.dataWindow.end);
  const replayEnd = Number.isFinite(minTime) && Number.isFinite(maxTime) ? minTime + (maxTime - minTime) * replayFrac : Infinity;
  const replayEndIso = Number.isFinite(replayEnd) ? new Date(replayEnd).toISOString() : analysis.metadata.dataWindow.end;
  const visibleTargets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return analysis.targets.filter((target) => {
      if (statusFilter !== "全部状态" && target.status !== statusFilter) return false;
      if (sourceFilter !== "全部来源" && target.trackSource !== sourceFilter) return false;
      if (areaFilter !== "全部区域" && !target.latestAreaIds.includes(areaFilter)) return false;
      if (q && !`${target.name} ${target.mmsi}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [analysis.targets, areaFilter, query, sourceFilter, statusFilter]);
  const visibleMmsi = useMemo(() => new Set(visibleTargets.map((target) => target.mmsi)), [visibleTargets]);
  const visibleSegments = useMemo(() => analysis.segments.filter((segment) => visibleMmsi.has(segment.targetMmsi)), [analysis.segments, visibleMmsi]);
  const visibleGaps = useMemo(() => analysis.aisGaps.filter((gap) => visibleMmsi.has(gap.targetMmsi)), [analysis.aisGaps, visibleMmsi]);
  const visibleAlerts = useMemo(() => analysis.alerts.filter((alert) => visibleMmsi.has(alert.targetMmsi)), [analysis.alerts, visibleMmsi]);
  const selectedTarget = analysis.targets.find((target) => target.mmsi === selectedMmsi) || visibleTargets[0] || analysis.targets[0];
  const selectedAlert = analysis.alerts.find((alert) => alert.id === selectedAlertId) || selectedTarget?.alerts?.[0] || visibleAlerts[0] || null;
  const mapData = useMemo(() => buildMapData({ targets: visibleTargets, areas: analysis.monitoredAreas, segments: visibleSegments, aisGaps: visibleGaps, alerts: visibleAlerts, replayEnd, coast: coastData, selectedTarget }), [analysis.monitoredAreas, replayEnd, visibleAlerts, visibleGaps, visibleSegments, visibleTargets, selectedTarget]);
  const summary = analysis.summary;
  const handleTargetSelect = (mmsi) => {
    const target = analysis.targets.find((item) => item.mmsi === mmsi);
    setSelectedMmsi(mmsi);
    setSelectedAlertId(target?.alerts?.[0]?.id || null);
    if (!target?.hasObservedTrack) setMapFocus(pointFocus("target", target, 11));
  };
  const handleAlertSelect = (alert) => {
    setSelectedAlertId(alert.id);
    if (alert.targetMmsi) setSelectedMmsi(alert.targetMmsi);
    setMapFocus(pointFocus("alert", alert, 11));
    if (alert.type === "ais-gap") setCardAlert(alert);
  };
  const handleMapAction = (action) => {
    if (action.kind === "target") handleTargetSelect(action.mmsi);
    if (action.kind === "alert") {
      const alert = analysis.alerts.find((item) => item.id === action.id);
      if (alert) handleAlertSelect(alert);
    }
    if ((action.kind === "ais-gap" || action.kind === "segment") && action.targetMmsi) handleTargetSelect(action.targetMmsi);
  };

  return (
    <main className="stm-shell">
      <header className="topbar">
        <div className="brand"><Ship size={22} /><div><h1>无人艇跟监告警智能体</h1></div></div>
        {summary && (
          <div className={`threat-badge inline ${summary.threatLevel}`}>
            <ShieldAlert size={15} /><span>研判</span><strong>{summary.threatLabel}</strong>
          </div>
        )}
        <div className="top-metrics">
          <span><Database size={14} />目标 {analysis.metadata.targetCount}</span>
          <span><AlertTriangle size={14} />告警 {analysis.alerts.length}</span>
          <span><Clock3 size={14} />{fmtDateTime(replayEndIso)}</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="target-panel">
          <div className="panel-head"><h2><Target size={15} />目标</h2><span>{visibleTargets.length}/{analysis.targets.length}</span></div>
          <div className="filters">
            <label className="searchbox"><Search size={13} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="船名 / MMSI" /></label>
            <label><Filter size={13} /><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>{statusOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="target-list">{visibleTargets.map((target) => <TargetRow key={target.mmsi} target={target} selected={target.mmsi === selectedTarget?.mmsi} onSelect={handleTargetSelect} />)}</div>
        </aside>

        <div className="map-stack">
          <MapPanel mapData={mapData} selectedMmsi={selectedTarget?.mmsi} selectedAlertId={selectedAlert?.id} focusRequest={mapFocus} onAction={handleMapAction} />
          <section className="dashstrip">
            <div className="dashstrip-title">
              <h3>{selectedTarget?.name}</h3><span>{selectedTarget?.mmsi}</span>
              <strong className="score-pill">评分 {selectedTarget?.score}</strong>
            </div>
            <div className="dash-cells">
              <div className="dash-cell">
                <small>离国土</small>
                <strong>{selectedTarget?.minCoastDistanceNm != null ? selectedTarget.minCoastDistanceNm.toFixed(0) : "—"}</strong>
                <small>海里</small>
                <div className="bar"><span style={{ width: `${Math.min(100, ((selectedTarget?.minCoastDistanceNm ?? 200) / 200) * 100)}%` }} /></div>
              </div>
              <div className="dash-cell"><small>最快</small><strong>{selectedTarget?.maxSpeedSegment ? selectedTarget.maxSpeedSegment.speedKn.toFixed(1) : "—"}</strong><small>kt</small></div>
              <div className="dash-cell"><small>活动天数</small><strong>{selectedTarget?.activeDays ?? "—"}</strong></div>
              <div className="dash-cell compass-cell"><small>航向</small><span className="compass" style={{ transform: `rotate(${selectedTarget?.courseDeg ?? 0}deg)` }}><ArrowUp size={20} /></span></div>
            </div>
            {summary?.advice?.length > 0 && (
              <div className={`advice-strip advice-${summary.advice[0].level || "low"}`}>{summary.advice[0].text}</div>
            )}
          </section>
        </div>

        <button className={`alert-fab ${visibleAlerts.length ? "has" : ""}`} onClick={() => setShowAlertDrawer((v) => !v)} aria-label="告警列表">
          <AlertTriangle size={18} /><span>{visibleAlerts.length}</span>
        </button>
        {showAlertDrawer && (
          <aside className="alert-drawer">
            <div className="panel-head"><h2><AlertTriangle size={15} />告警</h2><button className="card-close" onClick={() => setShowAlertDrawer(false)}><X size={14} /></button></div>
            {selectedAlert && (
              <section className={`selected-alert-card ${selectedAlert.severity}`}>
                <header><span>{severityLabel(selectedAlert.severity)}</span><strong>{selectedAlert.title}</strong></header>
                <p>{selectedAlert.summary}</p>
              </section>
            )}
            <div className="alert-list">{visibleAlerts.map((alert) => <AlertRow key={alert.id} alert={alert} selected={alert.id === selectedAlert?.id} onSelect={handleAlertSelect} />)}</div>
          </aside>
        )}
      </section>

      <AlertCard alert={cardAlert} onClose={() => setCardAlert(null)} />
      <footer className="timeline">
        <div><strong>回放</strong><span>{fmtDateTime(analysis.metadata.dataWindow.start)} → {fmtDateTime(analysis.metadata.dataWindow.end)}</span></div>
        <input type="range" min="0" max="100" value={Math.round(replayFrac * 100)} onChange={(e) => setReplayFrac(Number(e.target.value) / 100)} />
        <time>{fmtDateTime(replayEndIso)}</time>
      </footer>
    </main>
  );
}
