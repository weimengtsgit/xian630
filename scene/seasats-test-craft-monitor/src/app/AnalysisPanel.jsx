import { useMemo } from "react";
import { AlertTriangle, Gauge, MapPin, Radio, ShieldAlert, Ship } from "lucide-react";
import { speedSeries, coastDistanceSeries, statusDistribution, alertDistribution } from "../logic/analytics.js";

const W = 300, H = 84, PAD = 8;

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
                <ul className="finding-list">
                  {summary.findings.map((f, i) => (<li key={i}><span>{f.label}</span><strong>{f.value}</strong></li>))}
                </ul>
                <ul className="advice-list">
                  {summary.advice.length === 0 && <li className="empty-li">暂无建议</li>}
                  {summary.advice.map((a, i) => (<li key={i} className={a.level}>{a.text}</li>))}
                </ul>
              </div>
            ) : <EmptyChart label="无研判" />}
          </div>
        </div>
      </div>
    </section>
  );
}
