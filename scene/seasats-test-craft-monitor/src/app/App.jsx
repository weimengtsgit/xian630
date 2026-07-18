import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, Database, Filter, Navigation, Search, Ship, X } from "lucide-react";
import { analyzePayload } from "../logic/domain.js";
import { buildMapData } from "../logic/mapData.js";
import { buildRemoteMapUrl, filterForFocusMode, resolveReplayWindow } from "../logic/playback.js";
import { buildSummary } from "../logic/summary.js";
import { MapPanel } from "./MapPanel.jsx";
import { AlertCard } from "./AlertCard.jsx";
import { AnalysisPanel } from "./AnalysisPanel.jsx";
import { PlaybackControlBar } from "./PlaybackControlBar.jsx";
import { RemotePlaybackMap } from "./RemotePlaybackMap.jsx";
import { VesselFocusPanel } from "./VesselFocusPanel.jsx";
import coastData from "../data/chinaCoast.json";

const statusOptions = ["全部状态", "异常行为舰艇", "高可信舰艇", "待核验舰艇", "仅最新位置"];
const sourceOptions = ["全部来源", "真实 AIS 轨迹", "仅最新位置"];

function replaySourceLabel(source) {
  if (source === "selected-target") return "当前舰艇轨迹";
  if (source === "metadata") return "数据集时间范围";
  if (source === "fallback") return "默认回放时间范围";
  return source || "未提供时间来源";
}

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

function isGenericVesselName(name) {
  return /^(?:US\s+GOV(?:ERNMENT)?(?:\s+VESSEL)?|US\s+WARSHIP|WARSHIP|美国政府船只)$/i.test(String(name || "").trim());
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
      {target.latestOnly
        ? <span className="track-mark has" title="最新 AIS 点位">点位</span>
        : target.hasObservedTrack
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
  const [loadingMessage, setLoadingMessage] = useState("数据加载中，正在计算全部舰艇的最新点位威胁分…");
  useEffect(() => {
    let cancelled = false;
    let retryTimer;
    const loadSnapshot = async () => {
      try {
        const response = await fetch("/api/seasats/summary");
        if (response.status === 202) {
          if (!cancelled) setLoadingMessage("数据加载中，正在更新全部舰艇的最新点位威胁分…");
          retryTimer = window.setTimeout(loadSnapshot, 5000);
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) setPayloadData(data);
      } catch (error) {
        if (!cancelled) setLoadError(error);
      }
    };
    loadSnapshot();
    return () => { cancelled = true; window.clearTimeout(retryTimer); };
  }, []);
  if (loadError) {
    return <main className="stm-shell loading-shell"><section className="loading-panel error"><AlertTriangle size={22} /><h1>数据加载失败</h1><p>{loadError.message}</p></section></main>;
  }
  if (!payloadData) {
    return <main className="stm-shell loading-shell"><section className="loading-panel"><Database size={22} /><h1>“光鱼”无人艇跟监告警智能体</h1><p>{loadingMessage}</p></section></main>;
  }
  return <Dashboard payload={payloadData} />;
}

function Dashboard({ payload }) {
  const [livePayload, setLivePayload] = useState(payload);
  const [affiliationHistory, setAffiliationHistory] = useState(null);
  const [trackLoading, setTrackLoading] = useState(false);
  // 每次点选均递增，用于即使重复点击同一艘舰艇也强制重新拉取实时 AIS 数据。
  const [trackRefreshVersion, setTrackRefreshVersion] = useState(0);
  // 进入页面时以当前时刻生成远程地图结束时间，不在页面内定时重载地图。
  const [remoteMapEndTime] = useState(() => Math.floor(Date.now() / 1000));
  // 单船轨迹由服务端按窗口过滤；首屏评分只使用后端计算好的最新点位结果。
  const scopedPayload = livePayload;
  const analysis = useMemo(() => {
    // 服务端批量快照已完成全量研判，首屏直接使用结果，避免浏览器再次遍历所有历史报点。
    if (scopedPayload.precomputedAnalysis) return scopedPayload;
    return analyzePayload(scopedPayload, coastData);
  }, [scopedPayload]);
  const [selectedMmsi, setSelectedMmsi] = useState(() => analysis.targets[0]?.mmsi);
  const [selectedAlertId, setSelectedAlertId] = useState(() => analysis.alerts[0]?.id || null);
  const [statusFilter, setStatusFilter] = useState(statusOptions[0]);
  const [sourceFilter, setSourceFilter] = useState(sourceOptions[0]);
  const [query, setQuery] = useState("");
  const [mapFocus, setMapFocus] = useState(null);
  const [mapMode, setMapMode] = useState("remote");
  const [focusOnly, setFocusOnly] = useState(true);
  const [cardAlert, setCardAlert] = useState(null);
  const [showAlertDrawer, setShowAlertDrawer] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const loadHistory = () => fetch("/api/seasats/affiliations")
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled) setAffiliationHistory(data); })
      // 轮询瞬时失败时保留上一份已展示快照，不能把关联卡片清空。
      .catch(() => {});
    loadHistory();
    // 历史关联只在新快照完整落盘后替换；定时拉取可让页面无感更新而不展示计算中状态。
    const intervalId = window.setInterval(loadHistory, 30 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);
  useEffect(() => {
    if (!selectedMmsi) return undefined;
    let cancelled = false;
    setTrackLoading(true);
    fetch(`/api/seasats/vessels/${encodeURIComponent(selectedMmsi)}/track`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const points = data.trackPoints || [];
        const latest = points.at(-1);
        // 轨迹统计只重新计算当前点选舰艇，保留首屏已原子发布的其它舰艇态势，避免页面出现逐艘跳变。
        const currentTarget = livePayload.targets.find((target) => target.mmsi === selectedMmsi);
        const detailed = currentTarget ? analyzePayload({
          metadata: {}, parameters: livePayload.parameters, monitoredAreas: livePayload.monitoredAreas,
          // 至少两个有效报点才称为轨迹；仅返回最新单点时须继续标记为“点位”。
          targets: [{ ...currentTarget, latestOnly: points.length <= 1 }], trackPoints: points,
        }, coastData) : null;
        const detailedTarget = detailed?.targets?.[0] || null;
        setLivePayload((current) => ({
          ...current,
          trackPoints: [...current.trackPoints.filter((point) => point.mmsi !== selectedMmsi), ...points],
          targets: current.targets.map((target) => target.mmsi !== selectedMmsi || !latest ? target : {
            ...target,
            ...detailedTarget,
            // 球形地图轨迹不稳定提供船名；通用名或空值均不能覆盖首页已识别的标准船名。
            name: latest.name && !isGenericVesselName(latest.name) ? latest.name : target.name,
            latestTime: latest.time, lon: latest.lon, lat: latest.lat,
            speedKn: latest.speedKn, speedRawDiv10: latest.speedKn == null ? null : latest.speedKn * 10,
            courseDeg: latest.courseDeg, rawTypeCode: latest.aisSourceType || target.rawTypeCode,
          }),
          segments: [...current.segments.filter((segment) => segment.targetMmsi !== selectedMmsi), ...(detailed?.segments || [])],
          aisGaps: [...current.aisGaps.filter((gap) => gap.targetMmsi !== selectedMmsi), ...(detailed?.aisGaps || [])],
          alerts: [...current.alerts.filter((alert) => alert.targetMmsi !== selectedMmsi), ...(detailed?.alerts || [])],
        }));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setTrackLoading(false); });
    return () => { cancelled = true; };
  }, [selectedMmsi, trackRefreshVersion]);
  const selectableTargets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return analysis.targets.filter((target) => {
      if (statusFilter !== "全部状态" && target.status !== statusFilter) return false;
      if (sourceFilter !== "全部来源" && target.trackSource !== sourceFilter) return false;
      if (q && !`${target.name} ${target.mmsi}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [analysis.targets, query, sourceFilter, statusFilter]);
  const selectedTarget = selectableTargets.find((target) => target.mmsi === selectedMmsi) || selectableTargets[0] || null;
  const displaySeedTargets = useMemo(() => {
    if (focusOnly && selectedTarget) return [selectedTarget];
    return selectableTargets;
  }, [focusOnly, selectableTargets, selectedTarget]);
  const displayMmsi = useMemo(() => new Set(displaySeedTargets.map((target) => target.mmsi)), [displaySeedTargets]);
  const displaySeedAnalysis = useMemo(() => ({
    ...analysis,
    targets: displaySeedTargets,
    segments: analysis.segments.filter((segment) => displayMmsi.has(segment.targetMmsi)),
    aisGaps: analysis.aisGaps.filter((gap) => displayMmsi.has(gap.targetMmsi)),
    alerts: analysis.alerts.filter((alert) => displayMmsi.has(alert.targetMmsi)),
  }), [analysis, displayMmsi, displaySeedTargets]);
  const displayAnalysis = useMemo(() => {
    const filtered = filterForFocusMode({ analysis: displaySeedAnalysis, selectedMmsi: selectedTarget?.mmsi, focusOnly });
    return { ...filtered, summary: buildSummary(filtered, filtered.parameters) };
  }, [displaySeedAnalysis, focusOnly, selectedTarget?.mmsi]);
  const visibleTargets = displayAnalysis.targets;
  const visibleSegments = displayAnalysis.segments;
  const visibleGaps = displayAnalysis.aisGaps;
  const visibleAlerts = displayAnalysis.alerts;
  const selectedTargetForDisplay = useMemo(
    () => selectedTarget ? { ...selectedTarget } : selectedTarget,
    [selectedTarget],
  );
  const selectedAlert = visibleAlerts.find((alert) => alert.id === selectedAlertId) || selectedTarget?.alerts?.find((alert) => visibleAlerts.some((item) => item.id === alert.id)) || visibleAlerts[0] || null;
  const visibleCardAlert = cardAlert && visibleAlerts.some((alert) => alert.id === cardAlert.id) ? cardAlert : null;
  const mapData = useMemo(() => buildMapData({ targets: visibleTargets, areas: analysis.monitoredAreas, segments: visibleSegments, aisGaps: visibleGaps, alerts: visibleAlerts, coast: coastData, selectedTarget }), [analysis.monitoredAreas, visibleAlerts, visibleGaps, visibleSegments, visibleTargets, selectedTarget]);
  const playbackWindow = useMemo(() => ({
    ...resolveReplayWindow({ forceFallback: true }),
    end: remoteMapEndTime,
    source: "当前时间",
  }), [remoteMapEndTime]);
  const remoteMapUrl = useMemo(() => selectedTarget ? buildRemoteMapUrl({
    mmsi: selectedTarget.mmsi,
    startTime: playbackWindow.start,
    endTime: playbackWindow.end,
  }) : "", [playbackWindow, selectedTarget]);
  const summary = displayAnalysis.summary;
  const handleTargetSelect = (mmsi) => {
    const target = analysis.targets.find((item) => item.mmsi === mmsi);
    setSelectedMmsi(mmsi);
    // 每次点击都从服务端取最新 AIS 并在返回后一次性更新底部图表，绝不复用旧轨迹。
    setTrackRefreshVersion((version) => version + 1);
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
        <div className="brand"><Ship size={22} /><div><h1>“光鱼”无人艇跟监告警智能体</h1></div></div>
        <div className="top-metrics">
          <span><Database size={14} />舰艇 {analysis.metadata.targetCount}</span>
          <span><AlertTriangle size={14} />告警 {analysis.alerts.length}</span>
          <span><Clock3 size={14} />数据至 {fmtDateTime(analysis.metadata.dataWindow.end)}</span>
        </div>
      </header>

      <PlaybackControlBar
        mapMode={mapMode}
        onMapModeChange={setMapMode}
        focusOnly={focusOnly}
        onFocusOnlyChange={setFocusOnly}
        playbackWindow={{ ...playbackWindow, source: replaySourceLabel(playbackWindow.source) }}
        selectedTarget={selectedTargetForDisplay}
        remoteMapUrl={remoteMapUrl}
      />

      <section className="workspace">
        <aside className="target-panel">
          <div className="panel-head"><h2><Ship size={15} />舰艇</h2><span>{selectableTargets.length}/{analysis.targets.length}</span></div>
          <div className="filters">
            <label className="searchbox"><Search size={13} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="船名 / MMSI" /></label>
            <label><Filter size={13} /><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>{statusOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label><Filter size={13} /><select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>{sourceOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          </div>
          <div className="target-list">{selectableTargets.map((target) => <TargetRow key={target.mmsi} target={target} selected={target.mmsi === selectedTarget?.mmsi} onSelect={handleTargetSelect} />)}</div>
        </aside>

        <div className="map-stack">
          {mapMode === "remote" ? (
            <RemotePlaybackMap
              src={remoteMapUrl}
              title="远程球面轨迹回放地图"
              selectedTarget={selectedTarget}
              windowSource={replaySourceLabel(playbackWindow.source)}
            />
          ) : (
            <MapPanel mapData={mapData} selectedMmsi={selectedTarget?.mmsi} selectedAlertId={selectedAlert?.id} focusRequest={mapFocus} onAction={handleMapAction} />
          )}
          <section className="insight-strip">
            {summary?.advice?.length > 0 && (
              <div className={`advice-strip advice-${summary.advice[0].level || "low"}`}>{summary.advice[0].text}</div>
            )}
          </section>
        </div>

        <VesselFocusPanel
          selectedTarget={selectedTargetForDisplay}
          visibleCount={visibleTargets.length}
          totalCount={analysis.targets.length}
          focusOnly={focusOnly}
          onFocusOnlyChange={setFocusOnly}
          affiliation={affiliationHistory?.associationsByMmsi?.[selectedTarget?.mmsi] || affiliationHistory}
          affiliationRefreshedAt={affiliationHistory?.refreshedAt || null}
          allAffiliations={affiliationHistory?.associationsByMmsi || {}}
          allTargets={analysis.targets}
          visibleAlertCount={visibleAlerts.length}
          onAlertToggle={() => setShowAlertDrawer((value) => !value)}
        />

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

      <AnalysisPanel analysis={displayAnalysis} selectedTarget={selectedTarget} coastData={coastData} />
      <AlertCard alert={visibleCardAlert} onClose={() => setCardAlert(null)} />
    </main>
  );
}
