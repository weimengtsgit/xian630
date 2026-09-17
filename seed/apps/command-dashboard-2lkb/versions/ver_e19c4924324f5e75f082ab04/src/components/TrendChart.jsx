// 30 天走势大图（下钻详情）：小时粒度数量曲线 + 10% 面积填充 + 30 天基线虚线 + 网格线/日期轴 + 悬停十字线/气泡
// 图例：双键说明（实线=数量 / 虚线=基线）。
import { useMemo, useState } from 'react';
import { useElementWidth } from '../hooks/useElementWidth.js';
import { fmtCount, fmtBaseline, fmtTimeShort, fmtMonthDay } from '../utils/format.js';

const H = 190;
const PAD_T = 10;
const PAD_B = 20; // 底部日期轴留白
const PAD_R = 34; // 右侧数值刻度留白

export default function TrendChart({ series, baseline, t0Ms, stepMs }) {
  const [ref, width] = useElementWidth(320);
  const [hoverIdx, setHoverIdx] = useState(null);

  const model = useMemo(() => {
    const n = series ? series.length : 0;
    if (!n) return null;
    const plotW = Math.max(60, width - PAD_R);
    const innerH = H - PAD_T - PAD_B;
    const maxV = Math.max(Math.max(...series), Math.ceil(baseline || 0), 1) * 1.12;
    const x = (i) => (i / (n - 1)) * plotW;
    const y = (v) => PAD_T + innerH - (v / maxV) * innerH;
    const pts = series.map((v, i) => [x(i), y(v)]);
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const area = `${line}L${x(n - 1).toFixed(1)},${(PAD_T + innerH).toFixed(1)}L0,${(PAD_T + innerH).toFixed(1)}Z`;
    // 网格线与刻度（4 档）
    const ticks = [];
    for (let k = 0; k <= 3; k++) {
      const v = (maxV / 1.12) * (k / 3);
      ticks.push({ v: Math.round(v), y: y(v) });
    }
    // 日期轴刻度（约每 6 天一个）
    const dayStep = Math.max(1, Math.round(n / 5));
    const seen = new Set();
    const xTicks = [];
    for (let i = 0; i < n; i += dayStep) {
      if (!seen.has(i)) { xTicks.push({ x: x(i), ms: t0Ms + i * stepMs }); seen.add(i); }
    }
    if (!seen.has(n - 1)) xTicks.push({ x: x(n - 1), ms: t0Ms + (n - 1) * stepMs });
    return { n, plotW, pts, line, area, ticks, xTicks, baseY: baseline > 0 ? y(baseline) : null, end: pts[n - 1] };
  }, [series, baseline, width, t0Ms, stepMs]);

  const onMove = (e) => {
    if (!model) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, px / model.plotW));
    setHoverIdx(Math.round(ratio * (model.n - 1)));
  };

  if (!model) {
    return <div className="skel skel-trend" aria-hidden="true" />;
  }

  const hasHover = hoverIdx !== null;
  const hoverPt = hasHover ? model.pts[hoverIdx] : null;
  const hoverMs = hasHover ? t0Ms + hoverIdx * stepMs : 0;
  // 气泡像素级定位并夹在两端，避免溢出裁切
  const tipLeft = hoverPt ? Math.min(Math.max(hoverPt[0], 70), Math.max(70, model.plotW - 70)) : 0;

  return (
    <div className="trend-wrap">
      <div className="trend-legend" aria-hidden="true">
        <span className="lg-key lg-line">实线 = 商船数量</span>
        <span className="lg-key lg-dash">虚线 = 30 天基线</span>
      </div>
      <div className="trend-plot" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        <svg width={width} height={H} role="img" aria-label="近 30 天商船数量走势与 30 天滑动平均基线对比图">
          {model.ticks.map((t, k) => (
            <g key={`t${k}`}>
              <line x1={0} x2={model.plotW} y1={t.y} y2={t.y} className="trend-grid" />
              <text x={model.plotW + 5} y={t.y + 3.5} className="trend-tick">{t.v}</text>
            </g>
          ))}
          {model.baseY !== null && (
            <line x1={0} x2={model.plotW} y1={model.baseY} y2={model.baseY} className="trend-baseline" />
          )}
          <path d={model.area} className="trend-area" />
          <path d={model.line} className="trend-line" />
          <circle cx={model.end[0]} cy={model.end[1]} r={5.5} className="spark-end-ring" />
          <circle cx={model.end[0]} cy={model.end[1]} r={4} className="spark-end" />
          {hoverPt && (
            <g>
              <line x1={hoverPt[0]} x2={hoverPt[0]} y1={PAD_T - 6} y2={H - PAD_B} className="spark-cross" />
              <circle cx={hoverPt[0]} cy={hoverPt[1]} r={3.5} className="spark-hover-dot" />
            </g>
          )}
          {model.xTicks.map((xt, k) => (
            <text key={`x${k}`} x={Math.min(xt.x, model.plotW - 26)} y={H - 6} className="trend-tick trend-tick-x">
              {fmtMonthDay(xt.ms)}
            </text>
          ))}
        </svg>
        {hoverPt && (
          <span className="spark-tip trend-tip" style={{ left: `${tipLeft}px` }}>
            <span className="tip-time">{fmtMonthDay(hoverMs)} {fmtTimeShort(hoverMs)}</span>
            <span className="tip-row">
              数量 <b className="num">{fmtCount(series[hoverIdx])}</b>
              <i className="tip-sep" />
              基线 <b className="num">{fmtBaseline(baseline)}</b>
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
