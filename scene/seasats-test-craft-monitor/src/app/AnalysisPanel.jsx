import { useMemo } from "react";
import { Activity, AlertTriangle, Clock3, Gauge, MapPin, Navigation, Radio, ShieldAlert, Ship } from "lucide-react";
import { fmtDuration } from "../logic/domain.js";
import { speedSeries, coastDistanceSeries, statusDistribution, alertDistribution, hourDistribution, headingDistribution, targetDistanceDistribution, activityDaysTop, scoreBreakup, classifyPattern, signalQuality, perTargetAlertBreakdown, combinedSpeedDistanceSeries } from "../logic/analytics.js";

const W = 360, H = 170, PL = 38, PR = 22, PT = 14, PB = 24;
const IW = W - PL - PR, IH = H - PT - PB;

function fmtDay(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "--";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function EmptyChart({ label }) {
  return <div className="chart-empty">{label}</div>;
}

// Y 网格 + 刻度（4 档）
function Grid({ maxV }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return ticks.map((g, i) => {
    const y = PT + IH - g * IH;
    return (
      <g key={i}>
        <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#1e293b" strokeWidth="0.6" strokeDasharray="2 3" />
        <text x={PL - 4} y={y + 3} fill="#64748b" fontSize="9" textAnchor="end">{Math.round(g * maxV)}</text>
      </g>
    );
  });
}

function SpeedChart({ target }) {
  const data = useMemo(() => speedSeries(target), [target]);
  if (data.length < 2) return <EmptyChart label="轨迹点不足" />;
  const xs = data.map((_, i) => PL + (i / (data.length - 1)) * IW);
  const maxV = Math.max(...data.map((d) => d.v), 3);
  const yOf = (v) => PT + IH - (v / maxV) * IH;
  const ys = data.map((d) => yOf(d.v));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area = `${path} L${xs[xs.length - 1].toFixed(1)},${(PT + IH).toFixed(1)} L${xs[0].toFixed(1)},${(PT + IH).toFixed(1)} Z`;
  const lowY = yOf(3);
  const maxIdx = data.reduce((mi, d, i, arr) => (d.v > arr[mi].v ? i : mi), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <defs><linearGradient id="gSpeed" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fbbf24" stopOpacity="0.45" /><stop offset="100%" stopColor="#fbbf24" stopOpacity="0" /></linearGradient></defs>
      <Grid maxV={maxV} />
      <rect x={PL} y={lowY} width={IW} height={Math.max(0, PT + IH - lowY)} fill="rgba(34,197,94,0.10)" />
      <line x1={PL} y1={lowY} x2={W - PR} y2={lowY} stroke="#22c55e" strokeDasharray="3 3" strokeWidth="0.8" />
      <text x={W - PR} y={lowY - 2} fill="#22c55e" fontSize="8" textAnchor="end">低速 3kt</text>
      <path d={area} fill="url(#gSpeed)" />
      <path d={path} fill="none" stroke="#fbbf24" strokeWidth="2" />
      <circle cx={xs[maxIdx]} cy={ys[maxIdx]} r="4" fill="#ef4444" stroke="#fff" strokeWidth="1.2"><title>最快 {data[maxIdx].v.toFixed(1)} kt</title></circle>
      <text x={PL} y={H - 6} fill="#64748b" fontSize="9">{fmtDay(data[0].t)}</text>
      <text x={W - PR} y={H - 6} fill="#64748b" fontSize="9" textAnchor="end">{fmtDay(data[data.length - 1].t)}</text>
      <text x={4} y={12} fill="#94a3b8" fontSize="9">kt</text>
    </svg>
  );
}

function DistanceChart({ target, coast }) {
  const data = useMemo(() => coastDistanceSeries(target, coast), [target, coast]);
  if (data.length < 2) return <EmptyChart label="离国土距离数据不足" />;
  const xs = data.map((_, i) => PL + (i / (data.length - 1)) * IW);
  const maxV = Math.max(...data.map((d) => d.v), 250);
  const yOf = (nm) => PT + IH - (nm / maxV) * IH;
  const ys = data.map((d) => yOf(d.v));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area = `${path} L${xs[xs.length - 1].toFixed(1)},${(PT + IH).toFixed(1)} L${xs[0].toFixed(1)},${(PT + IH).toFixed(1)} Z`;
  const zones = [
    { to: 80, c: "rgba(239,68,68,0.12)" },
    { to: 140, c: "rgba(245,158,11,0.10)" },
    { to: 200, c: "rgba(234,179,8,0.08)" },
  ];
  const minD = Math.min(...data.map((d) => d.v));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <defs><linearGradient id="gDist" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#38bdf8" stopOpacity="0.4" /><stop offset="100%" stopColor="#38bdf8" stopOpacity="0" /></linearGradient></defs>
      <Grid maxV={maxV} />
      {maxV > 200 && zones.map((z, i) => (
        <rect key={i} x={PL} y={yOf(Math.min(z.to, maxV))} width={IW} height={Math.max(0, yOf(0) - yOf(Math.min(z.to, maxV)))} fill={z.c} />
      ))}
      {[80, 140, 200].filter((nm) => maxV > nm).map((nm) => (
        <g key={nm}>
          <line x1={PL} y1={yOf(nm)} x2={W - PR} y2={yOf(nm)} stroke={nm === 80 ? "#ef4444" : nm === 140 ? "#f59e0b" : "#eab308"} strokeDasharray="3 3" strokeWidth="0.8" />
          <text x={W - PR} y={yOf(nm) - 2} fill={nm === 80 ? "#ef4444" : nm === 140 ? "#f59e0b" : "#eab308"} fontSize="8" textAnchor="end">{nm}</text>
        </g>
      ))}
      <path d={area} fill="url(#gDist)" />
      <path d={path} fill="none" stroke="#38bdf8" strokeWidth="2" />
      <text x={PL} y={H - 6} fill="#64748b" fontSize="9">{fmtDay(data[0].t)}</text>
      <text x={W - PR} y={H - 6} fill="#64748b" fontSize="9" textAnchor="end">{fmtDay(data[data.length - 1].t)}</text>
      <text x={4} y={12} fill="#94a3b8" fontSize="9">海里 · 最近 {minD.toFixed(0)}</text>
    </svg>
  );
}

function AisTimeline({ target }) {
  const gaps = target?.aisGaps || [];
  const points = target?.segments?.flatMap((s) => s.points || []) || [];
  if (points.length === 0) return <EmptyChart label="无 AIS 数据" />;
  const times = points.map((p) => Date.parse(p.time)).filter((t) => Number.isFinite(t));
  if (times.length === 0) return <EmptyChart label="无 AIS 数据" />;
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const span = t1 - t0 || 1;
  const xOf = (t) => PL + ((t - t0) / span) * IW;
  const gapRects = gaps.map((g) => {
    const a = Date.parse(g.fromTime), b = Date.parse(g.toTime);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { x: xOf(a), w: Math.max(2, xOf(b) - xOf(a)), g };
  }).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <line x1={PL} y1={PT + IH / 2} x2={W - PR} y2={PT + IH / 2} stroke="#334155" strokeWidth="1" />
      {times.map((t, i) => <line key={i} x1={xOf(t)} y1={PT + IH / 2 - 16} x2={xOf(t)} y2={PT + IH / 2 + 16} stroke="#38bdf8" strokeWidth="0.6" opacity="0.4" />)}
      {gapRects.map((r, i) => <rect key={i} x={r.x} y={PT} width={r.w} height={IH} fill="rgba(239,68,68,0.5)"><title>{fmtDuration(r.g.gapMinutes)} 中断</title></rect>)}
      <text x={PL} y={PT + IH / 2 - 20} fill="#38bdf8" fontSize="9">{points.length} 报点</text>
      <text x={W - PR} y={PT + IH / 2 - 20} fill="#ef4444" fontSize="9" textAnchor="end">{gaps.length} 中断</text>
      <text x={PL} y={H - 6} fill="#64748b" fontSize="9">{fmtDay(t0)}</text>
      <text x={W - PR} y={H - 6} fill="#64748b" fontSize="9" textAnchor="end">{fmtDay(t1)}</text>
    </svg>
  );
}

function HourBars({ target }) {
  const data = useMemo(() => hourDistribution(target), [target]);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <EmptyChart label="无时间数据" />;
  const slot = IW / 24;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <Grid maxV={max} />
      {data.map((d, i) => {
        const x = PL + i * slot;
        const h = (d.count / max) * IH;
        const day = d.h >= 6 && d.h <= 18;
        return <rect key={i} x={x} y={PT + IH - h} width={slot - 1} height={h} fill={day ? "#fbbf24" : "#475569"} rx="1"><title>{d.h}:00 · {d.count} 报点</title></rect>;
      })}
      {[0, 6, 12, 18, 23].map((h) => <text key={h} x={PL + h * slot + slot / 2} y={H - 6} fill="#64748b" fontSize="8" textAnchor="middle">{h}</text>)}
      <text x={4} y={12} fill="#94a3b8" fontSize="9">UTC时</text>
    </svg>
  );
}

function HeadingRose({ target }) {
  const data = useMemo(() => headingDistribution(target), [target]);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <EmptyChart label="无航向数据" />;
  const slot = IW / 8;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <Grid maxV={max} />
      {data.map((d, i) => {
        const x = PL + i * slot;
        const h = (d.count / max) * IH;
        return (
          <g key={i}>
            <rect x={x} y={PT + IH - h} width={slot - 2} height={h} fill="#38bdf8" rx="2"><title>{d.dir} · {d.count}</title></rect>
            {d.count > 0 && <text x={x + slot / 2} y={PT + IH - h - 2} fill="#f1f5f9" fontSize="9" textAnchor="middle" fontWeight="700">{d.count}</text>}
            <text x={x + slot / 2} y={H - 6} fill="#64748b" fontSize="9" textAnchor="middle">{d.dir}</text>
          </g>
        );
      })}
    </svg>
  );
}

function StatusBars({ dist }) {
  const slot = IW / dist.length;
  const bw = slot - 8;
  const max = Math.max(...dist.map((d) => d.count), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <Grid maxV={max} />
      {dist.map((d, i) => {
        const x = PL + i * slot + 4;
        const h = (d.count / max) * IH;
        return (
          <g key={d.key}>
            <rect x={x} y={PT + IH - h} width={bw} height={h} fill={d.color} rx="3"><title>{d.label} · {d.count}</title></rect>
            {d.count > 0 && <text x={x + bw / 2} y={PT + IH - h - 3} fill="#f1f5f9" fontSize="11" textAnchor="middle" fontWeight="700">{d.count}</text>}
            <text x={x + bw / 2} y={H - 6} fill="#94a3b8" fontSize="9" textAnchor="middle">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function DistanceScatter({ targets }) {
  const data = targetDistanceDistribution(targets);
  if (data.length === 0) return <EmptyChart label="无距离数据" />;
  const maxV = Math.max(...data.map((d) => d.dist), 250);
  const slot = IW / Math.max(data.length, 1);
  const yOf = (nm) => PT + IH - (nm / maxV) * IH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <Grid maxV={maxV} />
      {[80, 200].filter((nm) => maxV > nm).map((nm) => (
        <line key={nm} x1={PL} y1={yOf(nm)} x2={W - PR} y2={yOf(nm)} stroke={nm === 80 ? "#ef4444" : "#eab308"} strokeDasharray="3 3" strokeWidth="0.8" />
      ))}
      {data.map((d, i) => {
        const x = PL + i * slot + slot / 2;
        const near = d.dist < 200;
        return <circle key={d.mmsi} cx={x} cy={yOf(d.dist)} r={near ? 4 : 3} fill={near ? "#ef4444" : "#38bdf8"} stroke="#0b1220" strokeWidth="0.8"><title>{d.name} · {d.dist.toFixed(0)}海里</title></circle>;
      })}
      <text x={PL} y={H - 6} fill="#64748b" fontSize="9">{data.length} 目标·升序</text>
      <text x={4} y={12} fill="#94a3b8" fontSize="9">海里</text>
    </svg>
  );
}

function DaysTopBars({ targets }) {
  const data = activityDaysTop(targets, 6);
  if (data.length === 0) return <EmptyChart label="无活动天数" />;
  const max = Math.max(...data.map((d) => d.days), 1);
  const labelW = 58;
  const barX = PL + labelW;
  const barW = W - PR - barX - 18;
  const rowH = IH / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      {data.map((d, i) => {
        const y = PT + i * rowH;
        const w = (d.days / max) * barW;
        return (
          <g key={d.name}>
            <text x={PL} y={y + rowH / 2 + 3} fill="#94a3b8" fontSize="9">{String(d.name).slice(0, 8)}</text>
            <rect x={barX} y={y + 3} width={Math.max(2, w)} height={rowH - 7} fill="#fbbf24" rx="3"><title>{d.name} · {d.days}天</title></rect>
            <text x={barX + w + 4} y={y + rowH / 2 + 3} fill="#f8fafc" fontSize="10" fontWeight="700">{d.days}</text>
          </g>
        );
      })}
    </svg>
  );
}

function SpeedDistanceChart({ target, coast }) {
  const data = useMemo(() => combinedSpeedDistanceSeries(target, coast), [target, coast]);
  if (data.length < 2) return <EmptyChart label="数据不足" />;
  const xs = data.map((_, i) => PL + (i / (data.length - 1)) * IW);
  const speeds = data.map((d) => d.speed).filter((v) => v != null);
  const maxSp = speeds.length ? Math.max(...speeds, 3) : 3;
  const dists = data.map((d) => d.dist).filter((v) => v != null);
  const maxDist = dists.length ? Math.max(...dists, 250) : 250;
  const ySp = (v) => PT + IH - (v / maxSp) * IH;
  const yDi = (v) => PT + IH - (v / maxDist) * IH;
  const spPts = data.map((d, i) => ({ x: xs[i], y: d.speed != null ? ySp(d.speed) : null })).filter((p) => p.y !== null);
  const diPts = data.map((d, i) => ({ x: xs[i], y: d.dist != null ? yDi(d.dist) : null })).filter((p) => p.y !== null);
  const spPath = spPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const spArea = spPts.length ? `${spPath} L${spPts[spPts.length - 1].x.toFixed(1)},${(PT + IH).toFixed(1)} L${spPts[0].x.toFixed(1)},${(PT + IH).toFixed(1)} Z` : "";
  const diPath = diPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  let mv = -1, maxIdx = -1;
  data.forEach((d, i) => { if (d.speed != null && d.speed > mv) { mv = d.speed; maxIdx = i; } });
  return (
    <div className="stacked-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
        <defs><linearGradient id="gSD" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fbbf24" stopOpacity="0.4" /><stop offset="100%" stopColor="#fbbf24" stopOpacity="0" /></linearGradient></defs>
        {[0, 0.5, 1].map((g) => { const y = PT + IH - g * IH; return <line key={g} x1={PL} y1={y} x2={W - PR} y2={y} stroke="#1e293b" strokeWidth="0.6" strokeDasharray="2 3" />; })}
        {[0, 0.5, 1].map((g) => { const y = PT + IH - g * IH; return <text key={"s" + g} x={PL - 4} y={y + 3} fill="#fbbf24" fontSize="8" textAnchor="end">{Math.round(g * maxSp)}</text>; })}
        {[0, 0.5, 1].map((g) => { const y = PT + IH - g * IH; return <text key={"d" + g} x={W - PR + 4} y={y + 3} fill="#38bdf8" fontSize="8">{Math.round(g * maxDist)}</text>; })}
        {[80, 140, 200].filter((nm) => maxDist > nm).map((nm) => <line key={nm} x1={PL} y1={yDi(nm)} x2={W - PR} y2={yDi(nm)} stroke={nm === 80 ? "#ef4444" : nm === 140 ? "#f59e0b" : "#eab308"} strokeDasharray="3 3" strokeWidth="0.7" opacity="0.6" />)}
        {diPath && <path d={diPath} fill="none" stroke="#38bdf8" strokeWidth="1.8" />}
        {spArea && <path d={spArea} fill="url(#gSD)" />}
        {spPath && <path d={spPath} fill="none" stroke="#fbbf24" strokeWidth="2" />}
        {maxIdx >= 0 && <circle cx={xs[maxIdx]} cy={ySp(data[maxIdx].speed)} r="4" fill="#ef4444" stroke="#fff" strokeWidth="1.2"><title>最快 {data[maxIdx].speed.toFixed(1)}kt · 距海岸 {data[maxIdx].dist != null ? data[maxIdx].dist.toFixed(0) : "?"}海里</title></circle>}
        <text x={PL} y={H - 6} fill="#64748b" fontSize="9">{fmtDay(data[0].t)}</text>
        <text x={W - PR} y={H - 6} fill="#64748b" fontSize="9" textAnchor="end">{fmtDay(data[data.length - 1].t)}</text>
        <text x={4} y={12} fill="#fbbf24" fontSize="9">kt</text>
        <text x={W - 4} y={12} fill="#38bdf8" fontSize="9" textAnchor="end">海里</text>
      </svg>
      <div className="stacked-legend">
        <span><i style={{ background: "#fbbf24" }} />速度 kt</span>
        <span><i style={{ background: "#38bdf8" }} />离国土距离 海里</span>
        {maxIdx >= 0 && <span><i style={{ background: "#ef4444" }} />最快点(悬停看位置)</span>}
      </div>
    </div>
  );
}

function StackedAlerts({ targets }) {
  const { rows, types } = useMemo(() => perTargetAlertBreakdown(targets), [targets]);
  if (rows.length === 0) return <EmptyChart label="无告警目标" />;
  const slot = IW / rows.length;
  const bw = Math.min(slot - 6, 26);
  const max = Math.max(...rows.map((r) => r.total), 1);
  const present = types.filter((ty) => rows.some((r) => r.counts[ty.key]));
  return (
    <div className="stacked-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
        <Grid maxV={max} />
        {rows.map((r, i) => {
          const x = PL + i * slot + (slot - bw) / 2;
          let yBase = PT + IH;
          return (
            <g key={r.mmsi}>
              {types.map((ty) => {
                const c = r.counts[ty.key] || 0;
                if (!c) return null;
                const h = (c / max) * IH;
                yBase -= h;
                return <rect key={ty.key} x={x} y={yBase} width={bw} height={h} fill={ty.color}><title>{r.name} · {ty.label} {c}</title></rect>;
              })}
              <text x={x + bw / 2} y={H - 6} fill="#64748b" fontSize="7" textAnchor="middle">{String(r.name).slice(0, 6)}</text>
            </g>
          );
        })}
      </svg>
      <div className="stacked-legend">
        {present.map((ty) => <span key={ty.key}><i style={{ background: ty.color }} />{ty.label}</span>)}
      </div>
    </div>
  );
}

function PatternCard({ target }) {
  const p = useMemo(() => classifyPattern(target), [target]);
  const icon = { loiter: "🔄", linger: "⏸", transit: "➡️", none: "—" }[p.key] || "—";
  return (
    <div className="info-card">
      <div className="info-icon">{icon}</div>
      <div className="info-body"><strong>{p.label}</strong><small>{p.detail || "—"}</small></div>
    </div>
  );
}

function SignalCard({ target }) {
  const q = useMemo(() => signalQuality(target), [target]);
  return (
    <div className="signal-card">
      <div className="signal-cell"><small>报点</small><strong>{q.reportCount.toLocaleString()}</strong></div>
      <div className="signal-cell"><small>中断</small><strong>{q.gapCount}</strong></div>
      <div className="signal-cell"><small>中断总时长</small><strong>{fmtDuration(q.gapMinutes)}</strong></div>
    </div>
  );
}

function ScoreBreakupCard({ target }) {
  const b = useMemo(() => scoreBreakup(target), [target]);
  if (b.items.length === 0) return <EmptyChart label="无威胁构成" />;
  return (
    <div className="breakup-card">
      {b.items.map((it) => (
        <div className="breakup-row" key={it.key}>
          <span className="breakup-label">{it.label}</span>
          <div className="breakup-bar"><span style={{ width: `${Math.min(100, (it.value / 30) * 100)}%` }} /></div>
          <strong>+{it.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function AnalysisPanel({ analysis, selectedTarget, coast }) {
  const summary = analysis.summary;
  const statusDist = useMemo(() => statusDistribution(analysis.targets), [analysis.targets]);
  const alertDist = useMemo(() => alertDistribution(analysis.alerts), [analysis.alerts]);
  return (
    <section className="analysis-panel">
      <div className="analysis-group">
        <h3><Gauge size={14} />{selectedTarget?.name || "—"} 轨迹分析</h3>
        <div className="chart-grid">
          <div className="chart-card"><header><Gauge size={12} />速度 vs 国土距离</header><SpeedDistanceChart target={selectedTarget} coast={coast} /></div>
          <div className="chart-card"><header><Radio size={12} />AIS 信号</header><AisTimeline target={selectedTarget} /></div>
          <div className="chart-card"><header><Clock3 size={12} />活动时段</header><HourBars target={selectedTarget} /></div>
          <div className="chart-card"><header><Navigation size={12} />航向分布</header><HeadingRose target={selectedTarget} /></div>
          <div className="chart-card"><header><Activity size={12} />轨迹模式</header><PatternCard target={selectedTarget} /></div>
          <div className="chart-card"><header><Radio size={12} />信号质量</header><SignalCard target={selectedTarget} /></div>
          <div className="chart-card"><header><ShieldAlert size={12} />威胁构成</header><ScoreBreakupCard target={selectedTarget} /></div>
        </div>
      </div>
      <div className="analysis-group">
        <h3><Ship size={14} />全局态势</h3>
        <div className="chart-grid">
          <div className="chart-card"><header><Ship size={12} />目标状态分布</header><StatusBars dist={statusDist} /></div>
          <div className="chart-card alert-dist-card"><header><AlertTriangle size={12} />告警分布</header>
            <div className="alert-dist-body">
              <div className="sev-row">
                {alertDist.bySeverity.map((s) => (<span key={s.key} className="sev-chip"><i style={{ background: s.color }} />{s.label} {s.count}</span>))}
              </div>
              <ul className="type-list">
                {alertDist.byType.length === 0 && <li className="empty-li">无告警</li>}
                {alertDist.byType.map((t) => (<li key={t.key}><span>{t.label}</span><strong>{t.count}</strong></li>))}
              </ul>
            </div>
          </div>
          <div className="chart-card"><header><AlertTriangle size={12} />各目标告警堆叠</header><StackedAlerts targets={analysis.targets} /></div>
          <div className="chart-card summary-detail-card">
            <header><ShieldAlert size={12} />智能体研判</header>
            {summary ? (
              <div className="summary-detail">
                <div className={`threat-line ${summary.threatLevel}`}>威胁等级 <strong>{summary.threatLabel}</strong></div>
                <p className="narrative">{summary.narrative}</p>
              </div>
            ) : <EmptyChart label="无研判" />}
          </div>
          <div className="chart-card"><header><MapPin size={12} />目标离国土距离</header><DistanceScatter targets={analysis.targets} /></div>
          <div className="chart-card"><header><Ship size={12} />活动天数 Top</header><DaysTopBars targets={analysis.targets} /></div>
        </div>
      </div>
    </section>
  );
}
