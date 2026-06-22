import React from 'react'

/**
 * 潮汐曲线图组件（内联 SVG）
 * 显示 72 小时潮汐变化，标注阈值线和可出港窗口
 */
export default function TideChart({ series, threshold, windows, currentTime }) {
  const width = 280
  const height = 100
  const padding = { top: 10, right: 10, bottom: 20, left: 35 }

  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  // 计算数据范围
  const heights = series.map(d => d.height)
  const minHeight = Math.min(...heights)
  const maxHeight = Math.max(...heights)
  const heightRange = maxHeight - minHeight

  const timeExtent = [series[0].t.getTime(), series[series.length - 1].t.getTime()]
  const timeRange = timeExtent[1] - timeExtent[0]

  // 坐标转换
  const xScale = (t) => padding.left + ((t.getTime() - timeExtent[0]) / timeRange) * chartWidth
  const yScale = (h) => padding.top + chartHeight - ((h - minHeight) / heightRange) * chartHeight

  // 生成路径
  const pathData = series.map((d, i) => {
    const x = xScale(d.t)
    const y = yScale(d.height)
    return `${i === 0 ? 'M' : 'L'}${x},${y}`
  }).join(' ')

  // 阈值线 Y 坐标
  const thresholdY = yScale(threshold)

  // 当前时间线 X 坐标
  const currentX = currentTime ? xScale(currentTime) : null

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* 背景 */}
      <rect x={padding.left} y={padding.top} width={chartWidth} height={chartHeight} fill="#0f1419" />

      {/* 可出港窗口背景（绿色半透明区域） */}
      {windows.map((w, i) => {
        const x1 = xScale(w.start)
        const x2 = xScale(w.end)
        const windowWidth = x2 - x1
        return (
          <rect
            key={i}
            x={x1}
            y={padding.top}
            width={windowWidth}
            height={chartHeight}
            fill="#10b98133"
          />
        )
      })}

      {/* 阈值线 */}
      <line
        x1={padding.left}
        y1={thresholdY}
        x2={padding.left + chartWidth}
        y2={thresholdY}
        stroke="#ef4444"
        strokeWidth="1"
        strokeDasharray="4 2"
      />

      {/* 潮汐曲线 */}
      <path
        d={pathData}
        fill="none"
        stroke="#3b82f6"
        strokeWidth="2"
      />

      {/* 当前时间线 */}
      {currentX && (
        <line
          x1={currentX}
          y1={padding.top}
          x2={currentX}
          y2={padding.top + chartHeight}
          stroke="#fbbf24"
          strokeWidth="1.5"
          opacity="0.8"
        />
      )}

      {/* Y 轴刻度标签 */}
      <text x={padding.left - 5} y={yScale(threshold)} textAnchor="end" fontSize="10" fill="#ef4444" dy="3">
        {threshold.toFixed(1)}m
      </text>
      <text x={padding.left - 5} y={yScale(maxHeight)} textAnchor="end" fontSize="10" fill="#6b7280" dy="3">
        {maxHeight.toFixed(1)}
      </text>
      <text x={padding.left - 5} y={yScale(minHeight)} textAnchor="end" fontSize="10" fill="#6b7280" dy="3">
        {minHeight.toFixed(1)}
      </text>

      {/* X 轴标签 */}
      <text x={padding.left} y={height - 5} fontSize="10" fill="#6b7280">
        0h
      </text>
      <text x={padding.left + chartWidth / 2} y={height - 5} textAnchor="middle" fontSize="10" fill="#6b7280">
        36h
      </text>
      <text x={padding.left + chartWidth} y={height - 5} textAnchor="end" fontSize="10" fill="#6b7280">
        72h
      </text>
    </svg>
  )
}
