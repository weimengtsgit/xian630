import React from 'react';

function TideCurve({ series, threshold, windows, currentTime }) {
  const width = 800;
  const height = 160;
  const padding = { top: 10, right: 20, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  if (!series || series.length === 0) {
    return <div style={{ color: '#6b7280', textAlign: 'center', padding: '2rem' }}>暂无数据</div>;
  }

  // 计算范围
  const minTime = series[0].t;
  const maxTime = series[series.length - 1].t;
  const minHeight = Math.min(...series.map(p => p.height));
  const maxHeight = Math.max(...series.map(p => p.height));

  // 添加垂直方向的边距
  const heightMargin = (maxHeight - minHeight) * 0.1;
  const yMin = minHeight - heightMargin;
  const yMax = maxHeight + heightMargin;

  // 坐标转换
  const xScale = (t) => padding.left + ((t - minTime) / (maxTime - minTime)) * chartWidth;
  const yScale = (h) => padding.top + chartHeight - ((h - yMin) / (yMax - yMin)) * chartHeight;

  // 生成路径
  const pathData = series.map((p, i) => {
    const x = xScale(p.t);
    const y = yScale(p.height);
    return i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
  }).join(' ');

  // 阈值线
  const thresholdY = yScale(threshold);

  // 时间刻度（每12小时）
  const timeLabels = [];
  const step = 12 * 60 * 60 * 1000; // 12 hours
  for (let t = minTime; t <= maxTime; t += step) {
    const date = new Date(t);
    const label = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:00`;
    timeLabels.push({ t, label });
  }

  // 高度刻度
  const heightLabels = [];
  const heightStep = Math.ceil((yMax - yMin) / 4);
  for (let h = Math.ceil(yMin); h <= yMax; h += heightStep) {
    heightLabels.push(h);
  }

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${width} ${height}`}
      style={{ background: 'rgba(30, 36, 51, 0.3)', borderRadius: '8px' }}
    >
      {/* 网格线 */}
      {heightLabels.map(h => (
        <line
          key={h}
          x1={padding.left}
          y1={yScale(h)}
          x2={width - padding.right}
          y2={yScale(h)}
          stroke="#2a3143"
          strokeWidth="1"
          strokeDasharray="2,2"
        />
      ))}

      {/* 窗口背景（绿色区域） */}
      {windows.map((w, i) => {
        const x1 = Math.max(padding.left, xScale(w.start));
        const x2 = Math.min(width - padding.right, xScale(w.end));
        return (
          <rect
            key={i}
            x={x1}
            y={padding.top}
            width={x2 - x1}
            height={chartHeight}
            fill="rgba(34, 197, 94, 0.08)"
            stroke="rgba(34, 197, 94, 0.2)"
            strokeWidth="1"
          />
        );
      })}

      {/* 阈值线 */}
      <line
        x1={padding.left}
        y1={thresholdY}
        x2={width - padding.right}
        y2={thresholdY}
        stroke="#60a5fa"
        strokeWidth="2"
        strokeDasharray="4,4"
      />
      <text
        x={width - padding.right + 5}
        y={thresholdY + 4}
        fill="#60a5fa"
        fontSize="11"
        fontWeight="600"
      >
        {threshold.toFixed(1)}m
      </text>

      {/* 潮汐曲线 */}
      <path
        d={pathData}
        fill="none"
        stroke="#10b981"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* 当前时间标记 */}
      {currentTime >= minTime && currentTime <= maxTime && (
        <>
          <line
            x1={xScale(currentTime)}
            y1={padding.top}
            x2={xScale(currentTime)}
            y2={height - padding.bottom}
            stroke="#f59e0b"
            strokeWidth="2"
          />
          <circle
            cx={xScale(currentTime)}
            cy={yScale(series.find((p, i) => {
              const next = series[i + 1];
              return p.t <= currentTime && (!next || next.t > currentTime);
            })?.height || series[0].height)}
            r="4"
            fill="#f59e0b"
          />
        </>
      )}

      {/* Y轴标签 */}
      {heightLabels.map(h => (
        <text
          key={h}
          x={padding.left - 8}
          y={yScale(h) + 4}
          fill="#6b7280"
          fontSize="10"
          textAnchor="end"
        >
          {h.toFixed(0)}
        </text>
      ))}

      {/* X轴标签 */}
      {timeLabels.map(({ t, label }, i) => (
        <text
          key={i}
          x={xScale(t)}
          y={height - padding.bottom + 20}
          fill="#6b7280"
          fontSize="9"
          textAnchor="middle"
        >
          {label}
        </text>
      ))}

      {/* 坐标轴 */}
      <line
        x1={padding.left}
        y1={padding.top}
        x2={padding.left}
        y2={height - padding.bottom}
        stroke="#4b5563"
        strokeWidth="1.5"
      />
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke="#4b5563"
        strokeWidth="1.5"
      />

      {/* 轴标签 */}
      <text
        x={padding.left - 35}
        y={padding.top + chartHeight / 2}
        fill="#9ca3af"
        fontSize="11"
        textAnchor="middle"
        transform={`rotate(-90, ${padding.left - 35}, ${padding.top + chartHeight / 2})`}
      >
        潮高 (米)
      </text>
    </svg>
  );
}

export default TideCurve;
