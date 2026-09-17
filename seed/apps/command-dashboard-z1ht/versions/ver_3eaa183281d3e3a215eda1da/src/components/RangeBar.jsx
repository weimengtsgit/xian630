import React from 'react';

// 甲板风范围条：0 → axisMax 节线性轴，区间 [|W−30|, W+30] 高亮、20 节阈值线、自然风 W 刻度
// 纯线性映射（无三角运算），数据缺失时不渲染数值（由调用方显示占位说明）。
export default function RangeBar({ minDeckWindKt, maxDeckWindKt, thresholdKt, naturalWindKt }) {
  if (minDeckWindKt == null || maxDeckWindKt == null || thresholdKt == null) {
    return <div className="rangebar unavailable">数据不可用 · 无法绘制范围条</div>;
  }
  const axisMax = Math.max(60, Math.ceil((maxDeckWindKt + 5) / 10) * 10);
  const pct = (v) => `${(Math.max(0, Math.min(v, axisMax)) / axisMax) * 100}%`;
  const ticks = [];
  for (let t = 0; t <= axisMax; t += 10) ticks.push(t);

  return (
    <div className="rangebar" role="img" aria-label={`甲板风范围 ${minDeckWindKt.toFixed(1)} 至 ${maxDeckWindKt.toFixed(1)} 节，阈值 ${thresholdKt} 节`}>
      <div className="rangebar-track">
        <div className="rangebar-band" style={{ left: pct(minDeckWindKt), width: `calc(${pct(maxDeckWindKt)} - ${pct(minDeckWindKt)})` }} />
        <div className="rangebar-threshold" style={{ left: pct(thresholdKt) }}>
          <span className="threshold-label">{thresholdKt} 节阈值</span>
        </div>
        {naturalWindKt != null && (
          <div className="rangebar-natural" style={{ left: pct(naturalWindKt) }} title={`自然风 W=${naturalWindKt.toFixed(1)} 节`}>
            <span className="natural-label">W {naturalWindKt.toFixed(1)}</span>
          </div>
        )}
      </div>
      <div className="rangebar-axis">
        {ticks.map((t) => (
          <span key={t} className="axis-tick" style={{ left: pct(t) }}>{t}</span>
        ))}
      </div>
      <p className="rangebar-caption">
        高亮区间为可实现甲板风范围 [{minDeckWindKt.toFixed(1)}, {maxDeckWindKt.toFixed(1)}] 节（航向/航速 0–30 节可调），虚线为 {thresholdKt} 节甲板风阈值。
      </p>
    </div>
  );
}
