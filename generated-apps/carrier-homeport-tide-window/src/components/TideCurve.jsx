import React from 'react';
import './TideCurve.css';

/**
 * Tide Curve Component - inline SVG visualization of 72-hour tide series
 */
function TideCurve({ series, threshold, windows, currentTime }) {
  const width = 800;
  const height = 200;
  const padding = { top: 20, right: 30, bottom: 30, left: 50 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (!series || series.length === 0) {
    return <div className="tide-curve-empty">暂无潮汐数据</div>;
  }

  // Find data range
  const minHeight = Math.min(...series.map(d => d.height));
  const maxHeight = Math.max(...series.map(d => d.height));
  const minTime = series[0].t.getTime();
  const maxTime = series[series.length - 1].t.getTime();

  // Scale functions
  const scaleX = (t) => {
    const timestamp = t instanceof Date ? t.getTime() : t;
    return padding.left + ((timestamp - minTime) / (maxTime - minTime)) * plotWidth;
  };

  const scaleY = (h) => {
    return padding.top + plotHeight - ((h - minHeight) / (maxHeight - minHeight)) * plotHeight;
  };

  // Generate path for tide curve
  const tidePath = series.map((point, i) => {
    const x = scaleX(point.t);
    const y = scaleY(point.height);
    return i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
  }).join(' ');

  // Generate threshold line
  const thresholdY = scaleY(threshold);

  // Current time indicator position
  const currentX = scaleX(currentTime);

  // Time axis labels (every 12 hours)
  const timeLabels = [];
  for (let i = 0; i <= 6; i++) {
    const t = new Date(minTime + (i * 12 * 60 * 60 * 1000));
    const x = scaleX(t);
    const label = t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
    timeLabels.push({ x, label });
  }

  // Height axis labels
  const heightLabels = [];
  const heightStep = (maxHeight - minHeight) / 4;
  for (let i = 0; i <= 4; i++) {
    const h = minHeight + i * heightStep;
    const y = scaleY(h);
    heightLabels.push({ y, label: h.toFixed(1) });
  }

  return (
    <div className="tide-curve">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {/* Window highlight areas */}
        {windows.map((window, idx) => {
          const x1 = scaleX(window.start);
          const x2 = scaleX(window.end);
          return (
            <rect
              key={`window-${idx}`}
              x={x1}
              y={padding.top}
              width={x2 - x1}
              height={plotHeight}
              fill="rgba(34, 197, 94, 0.15)"
              stroke="none"
            />
          );
        })}

        {/* Grid lines */}
        {heightLabels.map((label, idx) => (
          <line
            key={`grid-h-${idx}`}
            x1={padding.left}
            y1={label.y}
            x2={width - padding.right}
            y2={label.y}
            stroke="#2a3142"
            strokeWidth="1"
            strokeDasharray="2,2"
          />
        ))}

        {/* Threshold line */}
        <line
          x1={padding.left}
          y1={thresholdY}
          x2={width - padding.right}
          y2={thresholdY}
          stroke="#fbbf24"
          strokeWidth="2"
          strokeDasharray="4,4"
        />
        <text
          x={width - padding.right + 5}
          y={thresholdY + 4}
          fill="#fbbf24"
          fontSize="11"
          fontWeight="600"
        >
          {threshold}m
        </text>

        {/* Tide curve */}
        <path
          d={tidePath}
          fill="none"
          stroke="#60a5fa"
          strokeWidth="2"
        />

        {/* Current time indicator */}
        {currentX >= padding.left && currentX <= width - padding.right && (
          <>
            <line
              x1={currentX}
              y1={padding.top}
              x2={currentX}
              y2={height - padding.bottom}
              stroke="#ef4444"
              strokeWidth="2"
            />
            <circle
              cx={currentX}
              cy={scaleY(series.find(p => p.t >= currentTime)?.height || series[0].height)}
              r="4"
              fill="#ef4444"
            />
          </>
        )}

        {/* Axes */}
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="#6b7280"
          strokeWidth="1"
        />
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={height - padding.bottom}
          stroke="#6b7280"
          strokeWidth="1"
        />

        {/* Height labels */}
        {heightLabels.map((label, idx) => (
          <text
            key={`label-h-${idx}`}
            x={padding.left - 8}
            y={label.y + 4}
            fill="#9ca3af"
            fontSize="10"
            textAnchor="end"
          >
            {label.label}
          </text>
        ))}

        {/* Time labels */}
        {timeLabels.map((label, idx) => (
          <text
            key={`label-t-${idx}`}
            x={label.x}
            y={height - padding.bottom + 18}
            fill="#9ca3af"
            fontSize="10"
            textAnchor="middle"
          >
            {label.label}
          </text>
        ))}

        {/* Axis labels */}
        <text
          x={padding.left - 35}
          y={padding.top + plotHeight / 2}
          fill="#e0e6ed"
          fontSize="11"
          fontWeight="600"
          textAnchor="middle"
          transform={`rotate(-90 ${padding.left - 35} ${padding.top + plotHeight / 2})`}
        >
          潮高 (米)
        </text>
        <text
          x={padding.left + plotWidth / 2}
          y={height - 5}
          fill="#e0e6ed"
          fontSize="11"
          fontWeight="600"
          textAnchor="middle"
        >
          时间 (未来 72 小时)
        </text>
      </svg>

      <div className="curve-legend">
        <div className="legend-item">
          <div className="legend-color tide"></div>
          <span>潮汐曲线</span>
        </div>
        <div className="legend-item">
          <div className="legend-color threshold"></div>
          <span>吃水阈值 (12.8m)</span>
        </div>
        <div className="legend-item">
          <div className="legend-color window"></div>
          <span>可出港窗口</span>
        </div>
        <div className="legend-item">
          <div className="legend-color current"></div>
          <span>当前时间</span>
        </div>
      </div>
    </div>
  );
}

export default TideCurve;
