import { useMemo } from "react";
import { AlertTriangle, Clock3, Gauge, MapPin, Navigation, Radio, ShieldAlert, Ship } from "lucide-react";
import { speedSeries, coastDistanceSeries, statusDistribution, alertDistribution, hourDistribution, headingDistribution, targetDistanceDistribution, activityDaysTop } from "../logic/analytics.js";

const W = 320, H = 130, PAD = 12;

function EmptyChart({ label }) {
  return <div className="chart-empty">{label}</div>;
}

function SpeedChart({ target }) {
  const data = useMemo(() => speedSeries(target), [target]);
  if (data.length < 2) return <EmptyChart label="轨迹点不足" />;
  const xs = data.map((_, i) => PAD + (i / (data.length - 1)) * (W - 2 * PAD));
  const maxV = Math.max(...data.map((d) => d.v), 3);
  const ys = data.map((d) => H - PAD - (d.v / maxV) * (H - 2 * PAD));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const lowY = H - PAD - (3 / maxV) * (H - 2 * PAD);
  const maxIdx = data.reduce((mi, d, i, arr) => (d.v > arr[mi].v ? i : mi), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <rect x={PAD} y={lowY} width={W - 2 * PAD} height={Math.max(0, H - PAD - lowY)} fill="rgba(34,197,94,0.10)" />
      <line x1={PAD} y1={lowY} x2={W - PAD} y2={lowY} stroke="#22c55e" strokeDasharray="3 3" strokeWidth="0.8" opacity="0.6" />
      <path d={path} fill="none" stroke="#fbbf24" strokeWidth="1.8" />
      <circle cx={xs[maxIdx]} cy={ys[maxIdx]} r="3" fill="#ef4444" />
      <text x={PAD} y={13} fill="#94a3b8" fontSize="9">最快 {data[maxIdx].v.toFixed(1)}kt · 低速线 3kt</text>
    </svg>
  );
}

function DistanceChart({ target, coast }) {
  const data = useMemo(() => coastDistanceSeries(target, coast), [target, coast]);
  if (data.length < 2) return <EmptyChart label="离国土距离数据不足" />;
  const xs = data.map((_, i) => PAD + (i / (data.length - 1)) * (W - 2 * PAD));
  const maxV = Math.max(...data.map((d) => d.v), 250);
  const ys = data.map((d) => H - PAD - (d.v / maxV) * (H - 2 * PAD));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const lineY = (nm) => H - PAD - (nm / maxV) * (H - 2 * PAD);
  const minD = Math.min(...data.map((d) => d.v));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <line x1={PAD} y1={lineY(200)} x2={W - PAD} y2={lineY(200)} stroke="#eab308" strokeDasharray="3 3" strokeWidth="0.8" />
      <line x1={PAD} y1={lineY(140)} x2={W - PAD} y2={lineY(140)} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth="0.8" />
      <line x1={PAD} y1={lineY(80)} x2={W - PAD} y2={lineY(80)} stroke="#ef4444" strokeDasharray="3 3" strokeWidth="0.8" />
      <path d={path} fill="none" stroke="#38bdf8" strokeWidth="1.8" />
      <text x={PAD} y={13} fill="#94a3b8" fontSize="9">最近 {minD.toFixed(0)}海里 · 红80/橙140/黄200</text>
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
  const xOf = (t) => PAD + ((t - t0) / span) * (W - 2 * PAD);
  const ticks = times.map(xOf);
  const gapRects = gaps.map((g) => {
    const a = Date.parse(g.fromTime), b = Date.parse(g.toTime);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { x: xOf(a), w: Math.max(2, xOf(b) - xOf(a)) };
  }).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="#334155" strokeWidth="0.8" />
      {ticks.map((x, i) => (<line key={i} x1={x} y1={H / 2 - 7} x2={x} y2={H / 2 + 7} stroke="#38bdf8" strokeWidth="0.5" opacity="0.45" />))}
      {gapRects.map((r, i) => (<rect key={i} x={r.x} y={PAD} width={r.w} height={H - 2 * PAD} fill="rgba(239,68,68,0.4)" />))}
      <text x={PAD} y={13} fill="#94a3b8" fontSize="9">{points.length} 报点 · {gaps.length} 中断</text>
    </svg>
  );
}

function StatusBars({ dist }) {
  const slot = (W - 2 * PAD) / dist.length;
  const bw = slot - 6;
  const max = Math.max(...dist.map((d) => d.count), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      {dist.map((d, i) => {
        const x = PAD + i * slot + 3;
        const h = (d.count / max) * (H - 2 * PAD - 14);
        return (
          <g key={d.key}>
            <rect x={x} y={H - PAD - 12 - h} width={bw} height={h} fill={d.color} rx="2" />
            <text x={x + bw / 2} y={H - PAD - 12 - h - 2} fill="#f1f5f9" fontSize="10" textAnchor="middle" fontWeight="700">{d.count}</text>
            <text x={x + bw / 2} y={H - 3} fill="#94a3b8" fontSize="8" textAnchor="middle">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function HourBars({ target }) {
  const data = useMemo(() => hourDistribution(target), [target]);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <EmptyChart label="无时间数据" />;
  const slot = (W - 2 * PAD) / 24;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      {data.map((d, i) => {
        const x = PAD + i * slot;
        const h = (d.count / max) * (H - 2 * PAD - 14);
        return <rect key={i} x={x} y={H - PAD - 12 - h} width={slot - 1} height={h} fill={d.h >= 6 && d.h <= 18 ? "#fbbf24" : "#475569"} rx="1" />;
      })}
      <text x={PAD} y={13} fill="#94a3b8" fontSize="9">昼(黄)/夜(灰) UTC 报点</text>
    </svg>
  );
}

function HeadingRose({ target }) {
  const data = useMemo(() => headingDistribution(target), [target]);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <EmptyChart label="无航向数据" />;
  const slot = (W - 2 * PAD) / 8;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      {data.map((d, i) => {
        const x = PAD + i * slot;
        const h = (d.count / max) * (H - 2 * PAD - 14);
        return (
          <g key={i}>
            <rect x={x} y={H - PAD - 12 - h} width={slot - 1} height={h} fill="#38bdf8" rx="1" />
            <text x={x + slot / 2} y={H - 3} fill="#94a3b8" fontSize="7" textAnchor="middle">{d.dir}</text>
          </g>
        );
      })}
      <text x={PAD} y={13} fill="#94a3b8" fontSize="9">航向 8 方向</text>
    </svg>
  );
}

function DistanceScatter({ targets }) {
  const data = targetDistanceDistribution(targets);
  if (data.length === 0) return <EmptyChart label="无距离数据" />;
  const maxV = Math.max(...data.map((d) => d.dist), 250);
  const slot = (W - 2 * PAD) / Math.max(data.length, 1);
  const lineY = (nm) => H - PAD - (nm / maxV) * (H - 2 * PAD);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <line x1={PAD} y1={lineY(200)} x2={W - PAD} y2={lineY(200)} stroke="#eab308" strokeDasharray="3 3" strokeWidth="0.8" />
      <line x1={PAD} y1={lineY(80)} x2={W - PAD} y2={lineY(80)} stroke="#ef4444" strokeDasharray="3 3" strokeWidth="0.8" />
      {data.map((d, i) => {
        const x = PAD + i * slot + slot / 2;
        const near = d.dist < 200;
        return <circle key={d.mmsi} cx={x} cy={lineY(d.dist)} r={near ? 3.5 : 2.5} fill={near ? "#ef4444" : "#38bdf8"} opacity={near ? 1 : 0.5} />;
      })}
      <text x={PAD} y={13} fill="#94a3b8" fontSize="9">{data.length} 目标 · 红&lt;200海里</text>
    </svg>
  );
}

function DaysTopBars({ targets }) {
  const data = activityDaysTop(targets, 6);
  if (data.length === 0) return <EmptyChart label="无活动天数" />;
  const max = Math.max(...data.map((d) => d.days), 1);
  const rowH = (H - 2 * PAD) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      {data.map((d, i) => {
        const y = PAD + i * rowH;
        const w = (d.days / max) * (W - 2 * PAD - 44);
        return (
          <g key={d.name}>
            <text x={PAD} y={y + rowH / 2 + 3} fill="#94a3b8" fontSize="8">{String(d.name).slice(0, 8)}</text>
            <rect x={PAD + 38} y={y + 2} width={Math.max(2, w)} height={rowH - 5} fill="#fbbf24" rx="2" />
            <text x={PAD + 38 + w + 2} y={y + rowH / 2 + 3} fill="#f8fafc" fontSize="8">{d.days}</text>
          </g>
        );
      })}
    </svg>
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
          <div className="chart-card"><header><Gauge size={12} />速度时序</header><SpeedChart target={selectedTarget} /></div>
          <div className="chart-card"><header><MapPin size={12} />离国土距离</header><DistanceChart target={selectedTarget} coast={coast} /></div>
          <div className="chart-card"><header><Radio size={12} />AIS 信号</header><AisTimeline target={selectedTarget} /></div>
          <div className="chart-card"><header><Clock3 size={12} />活动时段</header><HourBars target={selectedTarget} /></div>
          <div className="chart-card"><header><Navigation size={12} />航向分布</header><HeadingRose target={selectedTarget} /></div>
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
