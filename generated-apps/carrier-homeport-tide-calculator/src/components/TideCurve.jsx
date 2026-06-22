import React, { useMemo } from 'react'

function TideCurve({ series, threshold, windows, currentTime }) {
  const { viewBox, pathData, thresholdY, currentX, windowRects } = useMemo(() => {
    if (!series || series.length === 0) {
      return { viewBox: '0 0 100 100', pathData: '', thresholdY: 50, currentX: 0, windowRects: [] }
    }

    const width = 800
    const height = 160
    const padding = { top: 20, right: 20, bottom: 20, left: 40 }
    const chartWidth = width - padding.left - padding.right
    const chartHeight = height - padding.top - padding.bottom

    // 时间和潮高的范围
    const timeMin = series[0].t
    const timeMax = series[series.length - 1].t
    const heightMin = Math.min(...series.map(p => p.height))
    const heightMax = Math.max(...series.map(p => p.height))

    // 坐标转换函数
    const xScale = (t) => padding.left + ((t - timeMin) / (timeMax - timeMin)) * chartWidth
    const yScale = (h) => padding.top + chartHeight - ((h - heightMin) / (heightMax - heightMin)) * chartHeight

    // 生成曲线路径
    const points = series.map(p => `${xScale(p.t)},${yScale(p.height)}`).join(' L ')
    const pathData = `M ${points}`

    // 阈值线Y坐标
    const thresholdY = yScale(threshold)

    // 当前时间X坐标
    const currentX = currentTime >= timeMin && currentTime <= timeMax ? xScale(currentTime) : null

    // 窗口矩形
    const windowRects = windows.map(w => ({
      x: xScale(w.start),
      y: padding.top,
      width: xScale(w.end) - xScale(w.start),
      height: chartHeight
    }))

    return {
      viewBox: `0 0 ${width} ${height}`,
      pathData,
      thresholdY,
      currentX,
      windowRects,
      xScale,
      yScale,
      timeMin,
      timeMax,
      heightMin,
      heightMax,
      padding,
      chartWidth,
      chartHeight
    }
  }, [series, threshold, windows, currentTime])

  return (
    <svg width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
      {/* 背景网格 */}
      <defs>
        <pattern id="grid" width="40" height="20" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5"/>
        </pattern>
      </defs>
      <rect x="0" y="0" width="100%" height="100%" fill="url(#grid)" />

      {/* 可出港窗口背景 */}
      {windowRects.map((rect, i) => (
        <rect
          key={i}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          fill="rgba(16, 185, 129, 0.15)"
          stroke="rgba(16, 185, 129, 0.3)"
          strokeWidth="1"
        />
      ))}

      {/* 阈值线 */}
      <line
        x1={40}
        y1={thresholdY}
        x2={820}
        y2={thresholdY}
        stroke="#f59e0b"
        strokeWidth="2"
        strokeDasharray="5,5"
      />
      <text x="10" y={thresholdY + 5} fill="#f59e0b" fontSize="11" fontWeight="600">
        {threshold}m
      </text>

      {/* 潮汐曲线 */}
      <path
        d={pathData}
        fill="none"
        stroke="#3b82f6"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* 当前时间指示线 */}
      {currentX && (
        <>
          <line
            x1={currentX}
            y1={20}
            x2={currentX}
            y2={140}
            stroke="#ef4444"
            strokeWidth="2"
          />
          <circle cx={currentX} cy="10" r="4" fill="#ef4444" />
        </>
      )}

      {/* Y轴刻度 */}
      {[0, 5, 10, 15, 20].map(h => {
        const y = 140 - (h / 20) * 120
        return (
          <g key={h}>
            <line x1="35" y1={y} x2="40" y2={y} stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <text x="5" y={y + 4} fill="#9ca3af" fontSize="10">{h}</text>
          </g>
        )
      })}

      {/* X轴时间标签 */}
      <text x="40" y="155" fill="#9ca3af" fontSize="10">0h</text>
      <text x="420" y="155" fill="#9ca3af" fontSize="10" textAnchor="middle">36h</text>
      <text x="780" y="155" fill="#9ca3af" fontSize="10" textAnchor="end">72h</text>
    </svg>
  )
}

export default TideCurve
