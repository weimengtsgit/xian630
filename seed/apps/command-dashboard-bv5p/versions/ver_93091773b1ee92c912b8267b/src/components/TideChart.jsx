import React, { useMemo } from 'react';
import { DRAFT_LIMIT_M, FORECAST_HOURS } from '../config/ports.js';
import { fmtLocalShort } from '../utils/time.js';

const HOUR_MS = 3600 * 1000;
const W = 760;
const H = 250;
const ML = 48;
const MR = 16;
const MT = 16;
const MB = 34;

// 72 小时潮汐曲线（SVG，真实序列驱动）：青色潮高曲线 + 琥珀虚线判定阈值 +
// 绿色窗口带 + 当前时刻线；横轴为港口当地时间，纵轴为该港基准下的潮高（米）。
export default function TideChart({ entry, now }) {
  const { port, assessment } = entry;
  const model = useMemo(() => {
    const series = entry.state.data.series;
    const x0 = now - HOUR_MS;
    const coverageEnd = assessment.coverageEndMs || now + FORECAST_HOURS * HOUR_MS;
    const x1 = Math.min(now + (FORECAST_HOURS + 1) * HOUR_MS, coverageEnd);
    const visible = series.filter((p) => p.t >= x0 && p.t <= x1);
    if (visible.length < 2) return null;
    const threshold = DRAFT_LIMIT_M - port.chartedDepthM; // 判定阈值（与潮高同基准）
    return { x0, x1, visible, threshold };
  }, [entry, now, assessment, port]);

  if (!model) {
    return <div className="chart-unavailable">潮汐序列不足以绘图（等待下次刷新）</div>;
  }

  const { x0, x1, visible, threshold: thr } = model;

  let yMin = Math.min(thr, ...visible.map((p) => p.heightM));
  let yMax = Math.max(thr, ...visible.map((p) => p.heightM));
  if (yMax - yMin < 0.2) { yMin -= 0.1; yMax += 0.1; }
  const pad = (yMax - yMin) * 0.15;
  yMin -= pad;
  yMax += pad;

  const x = (t) => ML + ((t - x0) / (x1 - x0)) * (W - ML - MR);
  const y = (h) => MT + ((yMax - h) / (yMax - yMin)) * (H - MT - MB);

  const points = visible.map((p) => `${x(p.t).toFixed(1)},${y(p.heightM).toFixed(1)}`).join(' ');
  const bands = (assessment.windows || [])
    .map((w) => ({ left: Math.max(x(w.startMs), ML), right: Math.min(x(w.endMs), W - MR) }))
    .filter((b) => b.right - b.left > 0.5);

  const xTicks = [];
  for (let i = 0; i <= FORECAST_HOURS; i += 12) {
    const t = now + i * HOUR_MS;
    xTicks.push({ px: x(t), label: i === 0 ? '现在' : fmtLocalShort(t, port.timezone) });
  }
  const yTicks = [];
  for (let i = 0; i <= 4; i += 1) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    yTicks.push({ v, py: y(v) });
  }
  const cur = assessment.currentHeightM;

  return (
    <div className="tide-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${port.portName} 72 小时潮汐曲线`}>
        {yTicks.map((tk, i) => (
          <g key={`y${i}`}>
            <line x1={ML} x2={W - MR} y1={tk.py} y2={tk.py} className="grid" />
            <text x={ML - 6} y={tk.py + 3} className="tick tick-y num" textAnchor="end">{tk.v.toFixed(1)}</text>
          </g>
        ))}
        {xTicks.map((tk, i) => (
          <g key={`x${i}`}>
            <line x1={tk.px} x2={tk.px} y1={MT} y2={H - MB} className="grid" />
            <text x={tk.px} y={H - MB + 14} className="tick tick-x num" textAnchor="middle">{tk.label}</text>
          </g>
        ))}

        {bands.map((b, i) => (
          <rect key={`b${i}`} x={b.left} y={MT} width={b.right - b.left} height={H - MT - MB} className="band" />
        ))}

        <line x1={ML} x2={W - MR} y1={y(thr)} y2={y(thr)} className="threshold-line" />
        <text x={W - MR} y={y(thr) - 5} className="thr-label num" textAnchor="end">
          判定阈值 {thr.toFixed(2)} m（{port.tideDatumShort}）
        </text>

        <polyline points={points} className="curve" />

        <line x1={x(now)} x2={x(now)} y1={MT} y2={H - MB} className="now-line" />
        {cur != null && <circle cx={x(now)} cy={y(cur)} r={3.5} className="now-dot" />}
        <text x={x(now) + 4} y={MT + 10} className="tick now-label">现在</text>
      </svg>
      <div className="chart-caption">
        横轴：港口当地时间（{port.timezone}） · 纵轴：潮高 m（{port.tideDatum}） · 绿带=可出港窗口 · 琥珀虚线=判定阈值
      </div>
    </div>
  );
}
