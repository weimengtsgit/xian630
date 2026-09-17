// 方格内嵌 sparkline：近 24h 商船数量曲线（蓝色实线）+ 30 天基线（灰色虚线）+ 端点圆点 + 悬停十字线/气泡
// 图表规范：实线 2px 圆角连接；端点 ≥8px 带 2px 表面色环；单系列不加图例框（由方格区块说明）。
import { useMemo, useState } from 'react';
import { useElementWidth } from '../hooks/useElementWidth.js';
import { fmtCount, fmtBaseline, fmtTimeShort } from '../utils/format.js';

const H = 48; // 绘制高度（满足 sparkline 最小 40px 可读高度）
const PAD_T = 6;
const PAD_B = 4;

export default function Sparkline({ series, baseline, t0Ms, stepMs, ariaName = '网格' }) {
  const [ref, width] = useElementWidth();
  const [hoverIdx, setHoverIdx] = useState(null);

  const model = useMemo(() => {
    const n = series ? series.length : 0;
    if (!n) return null;
    const maxV = Math.max(Math.max(...series), Math.ceil(baseline || 0), 1) * 1.12;
    const innerH = H - PAD_T - PAD_B;
    const x = (i) => 1 + (i / (n - 1)) * (width - 2);
    const y = (v) => PAD_T + innerH - (v / maxV) * innerH;
    const pts = series.map((v, i) => [x(i), y(v)]);
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    return { n, pts, line, baseY: baseline > 0 ? y(baseline) : null, end: pts[n - 1] };
  }, [series, baseline, width]);

  const onMove = (e) => {
    if (!model) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
    const idx = Math.min(model.n - 1, Math.max(0, Math.round(ratio * (model.n - 1))));
    setHoverIdx(idx);
  };

  if (!model) {
    return <div className="skel skel-spark" aria-hidden="true" />;
  }

  const hover = hoverIdx !== null ? model.pts[hoverIdx] : null;
  const hoverMs = t0Ms + hoverIdx * stepMs;
  // 气泡像素级定位并夹在两端，避免溢出裁切
  const tipLeft = hover ? Math.min(Math.max(hover[0], 58), Math.max(58, width - 58)) : 0;

  return (
    <div
      className="spark-wrap"
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={() => setHoverIdx(null)}
      role="img"
      aria-label={`${ariaName}近 24 小时商船数量走势曲线，与 30 天基线虚线对比`}
    >
      <svg width={width} height={H} className="spark-svg">
        {model.baseY !== null && (
          <line x1={0} x2={width} y1={model.baseY} y2={model.baseY} className="spark-baseline" />
        )}
        <path d={model.line} className="spark-line" />
        <circle cx={model.end[0]} cy={model.end[1]} r={5.5} className="spark-end-ring" />
        <circle cx={model.end[0]} cy={model.end[1]} r={4} className="spark-end" />
        {hover && (
          <g>
            <line x1={hover[0]} x2={hover[0]} y1={0} y2={H} className="spark-cross" />
            <circle cx={hover[0]} cy={hover[1]} r={3.5} className="spark-hover-dot" />
          </g>
        )}
      </svg>
      {hover && (
        <span className="spark-tip" style={{ left: `${tipLeft}px` }}>
          <span className="tip-time">{fmtTimeShort(hoverMs)}</span>
          <span className="tip-row">
            数量 <b className="num">{fmtCount(series[hoverIdx])}</b>
            <i className="tip-sep" />
            基线 <b className="num">{fmtBaseline(baseline)}</b>
          </span>
        </span>
      )}
    </div>
  );
}
