import React, { useMemo } from 'react'
import { Clock, Activity, Calendar, TrendingUp } from 'lucide-react'
import TideCurve from './TideCurve'
import './PortCard.css'

function PortCard({ portData, currentTime }) {
  const { port, series, threshold, windows } = portData

  // 根据当前时间计算当前潮高
  const currentTide = useMemo(() => {
    const current = series.find(point => point.t >= currentTime)
    return current ? current.height : series[series.length - 1].height
  }, [series, currentTime])

  // 判断当前是否在可出港窗口内
  const currentWindow = useMemo(() => {
    return windows.find(w => currentTime >= w.start && currentTime <= w.end)
  }, [windows, currentTime])

  // 查找下一个窗口
  const nextWindow = useMemo(() => {
    return windows.find(w => w.start > currentTime)
  }, [windows, currentTime])

  // 计算倒计时
  const countdown = useMemo(() => {
    if (currentWindow) {
      // 当前在窗口内，计算距离窗口关闭的时间
      return currentWindow.end - currentTime
    } else if (nextWindow) {
      // 当前窗口关闭，计算距离下一个窗口开启的时间
      return nextWindow.start - currentTime
    }
    return null
  }, [currentWindow, nextWindow, currentTime])

  const formatDuration = (ms) => {
    if (!ms || ms < 0) return '-- : --'
    const hours = Math.floor(ms / (1000 * 60 * 60))
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
  }

  const formatDateTime = (timestamp) => {
    const date = new Date(timestamp)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const isWindowOpen = !!currentWindow
  const statusClass = isWindowOpen ? 'status-open' : 'status-closed'

  return (
    <div className={`port-card ${statusClass}`}>
      {/* 卡片头部 */}
      <div className="card-header">
        <div className="port-info">
          <h2 className="port-name">{port.name}</h2>
          <span className="port-name-en">{port.nameEn}</span>
          <span className="timezone">{port.timezone}</span>
        </div>
        <div className={`status-badge ${statusClass}`}>
          <Activity size={16} />
          <span>{isWindowOpen ? '可出港' : '禁止出港'}</span>
        </div>
      </div>

      {/* 当前潮高 */}
      <div className="current-tide">
        <div className="tide-display">
          <TrendingUp className="icon" size={24} />
          <div className="tide-value">
            <span className="value">{currentTide.toFixed(1)}</span>
            <span className="unit">m</span>
          </div>
          <div className="tide-label">当前潮高</div>
        </div>
        <div className="threshold-display">
          <div className="threshold-line">
            <span className="threshold-label">阈值</span>
            <span className="threshold-value">{threshold} m</span>
          </div>
          <div className={`threshold-status ${currentTide >= threshold ? 'met' : 'not-met'}`}>
            {currentTide >= threshold ? '✓ 满足条件' : '✗ 不满足'}
          </div>
        </div>
      </div>

      {/* 72小时潮汐曲线 */}
      <div className="tide-curve-container">
        <TideCurve
          series={series}
          threshold={threshold}
          windows={windows}
          currentTime={currentTime}
        />
      </div>

      {/* 窗口信息 */}
      <div className="window-info">
        {isWindowOpen ? (
          <>
            <div className="window-status open">
              <Clock size={18} />
              <span>窗口开放中</span>
            </div>
            <div className="window-detail">
              <div className="detail-row">
                <span className="label">关闭时间</span>
                <span className="value">{formatDateTime(currentWindow.end)}</span>
              </div>
              <div className="countdown-row">
                <span className="label">剩余时间</span>
                <span className="countdown green">{formatDuration(countdown)}</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="window-status closed">
              <Clock size={18} />
              <span>窗口关闭</span>
            </div>
            {nextWindow ? (
              <div className="window-detail">
                <div className="detail-row">
                  <span className="label">下次开放</span>
                  <span className="value">{formatDateTime(nextWindow.start)}</span>
                </div>
                <div className="detail-row">
                  <span className="label">持续时间</span>
                  <span className="value">{formatDuration(nextWindow.end - nextWindow.start)}</span>
                </div>
                <div className="countdown-row">
                  <span className="label">倒计时</span>
                  <span className="countdown red">{formatDuration(countdown)}</span>
                </div>
              </div>
            ) : (
              <div className="no-window">
                <Calendar size={16} />
                <span>72小时内无可用窗口</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default PortCard
