import { useMemo, useState } from "react";
import { Map as MapIcon, Layers } from "lucide-react";
import { fmtDateTime } from "./statusHelpers.js";
import { WORLD_HEIGHT, WORLD_WIDTH, projectWorld } from "../logic/worldProjection.js";

// Lower-right panel — 起降热力地图 (inline SVG, no map tiles).
// Layers: red sea takeoff/landing heat points, blue carrier tracks, optional
// land/unknown audit points. Timeline replay scrubs the visible window. Hover/
// click an event → detail popover.
const W = WORLD_WIDTH;
const H = WORLD_HEIGHT;
const LATITUDE_LINES = [-60, -30, 0, 30, 60];
const LONGITUDE_LINES = [-120, -60, 0, 60, 120];

export function HeatMap({
  events,
  carriers,
  selectedIcao,
  selectedCarrierId,
  onSelectEvent,
  onSelectCarrier,
}) {
  const [hover, setHover] = useState(null);
  const [showSea, setShowSea] = useState(true);
  const [showTracks, setShowTracks] = useState(true);
  const [showAudit, setShowAudit] = useState(true);
  // timeline replay: a window [startMs, endMs]; default = full range.
  const allTimes = useMemo(
    () => events.map((e) => Date.parse(e.time)).sort((a, b) => a - b),
    [events]
  );
  const minT = allTimes[0] ?? 0;
  const maxT = allTimes[allTimes.length - 1] ?? 1;
  const span = Math.max(1, maxT - minT);
  const [winFrac, setWinFrac] = useState(1); // 0..1, fraction of timeline windowed from the start
  const winStart = minT;
  const winEnd = minT + span * winFrac;

  const inWindow = (e) => {
    const t = Date.parse(e.time);
    return t >= winStart && t <= winEnd;
  };

  const seaEvents = events.filter((e) => e.suspected && inWindow(e));
  const auditEvents = events.filter(
    (e) => (e.surfaceType === "land" || e.surfaceType === "unknown") && inWindow(e)
  );

  const pop = hover
    ? (() => {
        const [px, py] = projectWorld(hover.lat, hover.lon, W, H);
        // position popover near the point, clamped to the SVG box
        const left = Math.min(Math.max(px, 0), W - 250);
        const top = py > H / 2 ? py - 120 : py + 12;
        return { evt: hover, left, top };
      })()
    : null;

  return (
    <section className="cai-mapwrap">
      <div className="cai-panel-head" style={{ borderTop: "none" }}>
        <h2>
          <MapIcon size={14} style={{ verticalAlign: "-2px" }} /> 全球起降热力地图
        </h2>
        <span className="meta">
          海上 {seaEvents.length} · 审计 {auditEvents.length}
        </span>
      </div>
      <div className="cai-mapsvg-wrap">
        <svg className="cai-mapsvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
          {/* graticule + frame */}
          <rect x={0} y={0} width={W} height={H} fill="rgba(4,16,28,0.4)" stroke="rgba(104,221,255,0.18)" />
          {LATITUDE_LINES.map((la) => {
            const [, y] = projectWorld(la, 0, W, H);
            return <line key={"la" + la} x1={0} y1={y} x2={W} y2={y} stroke="rgba(104,221,255,0.08)" />;
          })}
          {LONGITUDE_LINES.map((lo) => {
            const [x] = projectWorld(0, lo, W, H);
            return <line key={"lo" + lo} x1={x} y1={0} x2={x} y2={H} stroke="rgba(104,221,255,0.08)" />;
          })}

          {/* Honshu land hint (upper-right band) */}
          <path
            d={`M ${projectWorld(37.5, 139.5, W, H)[0]} ${projectWorld(37.5, 139.5, W, H)[1]}
                L ${projectWorld(37.5, 142, W, H)[0]} ${projectWorld(37.5, 142, W, H)[1]}
                L ${projectWorld(35.8, 142, W, H)[0]} ${projectWorld(35.8, 142, W, H)[1]}
                L ${projectWorld(35.8, 139.5, W, H)[0]} ${projectWorld(35.8, 139.5, W, H)[1]} Z`}
            fill="rgba(80,110,90,0.18)"
            stroke="rgba(127,235,155,0.25)"
          />
          <text x={projectWorld(36.5, 140.5, W, H)[0]} y={projectWorld(36.5, 140.5, W, H)[1]} fill="rgba(143,176,191,0.6)" fontSize={9}>
            本州（陆）
          </text>

          {/* carrier tracks (blue) */}
          {showTracks &&
            carriers.map((c) => {
              const pts = c.track
                .filter((p) => {
                  const t = Date.parse(p.time);
                  return t >= winStart && t <= winEnd;
                })
                .map((p) => projectWorld(p.lat, p.lon, W, H));
              const isHi = selectedCarrierId === c.id;
              if (pts.length < 1) return null;
              const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
              return (
                <g key={c.id} style={{ cursor: "pointer" }} onClick={() => onSelectCarrier && onSelectCarrier(c.id)}>
                  <path d={d} fill="none" stroke={isHi ? "#68ddff" : "rgba(104,221,255,0.55)"} strokeWidth={isHi ? 2 : 1.2} />
                  {pts.map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={isHi ? 3 : 2} fill={isHi ? "#68ddff" : "rgba(104,221,255,0.7)"} />
                  ))}
                </g>
              );
            })}

          {/* audit points (land/unknown) — hollow */}
          {showAudit &&
            auditEvents.map((e) => {
              const [x, y] = projectWorld(e.lat, e.lon, W, H);
              const hi = e.icao === selectedIcao;
              return (
                <rect
                  key={e.id}
                  x={x - 4}
                  y={y - 4}
                  width={8}
                  height={8}
                  fill="none"
                  stroke={e.surfaceType === "land" ? "rgba(127,235,155,0.7)" : "rgba(143,176,191,0.7)"}
                  strokeWidth={1.2}
                  style={{ cursor: "pointer" }}
                  onClick={() => setHover(e)}
                  onMouseEnter={() => setHover(e)}
                >
                  <title>{e.icao} · {e.surfaceType}（审计）</title>
                </rect>
              );
            })}

          {/* sea events (red heat points) */}
          {showSea &&
            seaEvents.map((e) => {
              const [x, y] = projectWorld(e.lat, e.lon, W, H);
              const hi = e.icao === selectedIcao;
              const isTo = e.eventType === "takeoff";
              return (
                <g
                  key={e.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => { setHover(e); onSelectEvent && onSelectEvent(e); }}
                  onMouseEnter={() => setHover(e)}
                >
                  {hi && (
                    <circle cx={x} cy={y} r={11} fill="none" stroke="#ff665e" strokeWidth={1.2} className="cai-ev-pulse" />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={hi ? 6 : 4}
                    fill={isTo ? "#ff665e" : "#ff9a78"}
                    stroke={hi ? "#edfaff" : "rgba(0,0,0,0.5)"}
                    strokeWidth={hi ? 1.2 : 0.5}
                    opacity={e.bindingStatus === "bound" ? 0.95 : 0.55}
                  >
                    <title>{e.icao} · {isTo ? "起飞" : "降落"} · {e.bindingStatus}</title>
                  </circle>
                </g>
              );
            })}
        </svg>

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

        {/* hover popover */}
        {pop && (
          <div className="cai-popover" style={{ left: pop.left, top: pop.top }}>
            <h5>{pop.evt.icao} · {pop.evt.eventType === "takeoff" ? "起飞" : "降落"}</h5>
            <div className="pr"><span className="k">机型</span><span className="v">{pop.evt.aircraftType}</span></div>
            <div className="pr"><span className="k">时间</span><span className="v">{fmtDateTime(pop.evt.time)}</span></div>
            <div className="pr"><span className="k">高度过渡</span><span className="v">{pop.evt.altitudeTransition.from}→{pop.evt.altitudeTransition.to} ft</span></div>
            <div className="pr"><span className="k">速度</span><span className="v">{pop.evt.speedKt != null ? `${pop.evt.speedKt} 节` : "—"}</span></div>
            <div className="pr"><span className="k">坐标</span><span className="v">{pop.evt.lat.toFixed(2)}, {pop.evt.lon.toFixed(2)}</span></div>
            <div className="pr"><span className="k">海陆分类</span><span className="v">{pop.evt.surfaceType}（{(pop.evt.surfaceConfidence * 100).toFixed(0)}%）</span></div>
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
