import React from 'react';
import { Anchor, Clock, TrendingUp, Calendar } from 'lucide-react';
import TideCurve from './TideCurve';
import './PortCard.css';

/**
 * Port Card Component - displays tide status and launch window for one homeport
 */
function PortCard({ portData, currentTime, status }) {
  const { port, series, threshold, windows } = portData;
  const { currentHeight, isOpen, currentWindow, nextWindow, countdown, countdownTarget } = status;

  // Format time for display
  const formatTime = (date) => {
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  // Format countdown
  const formatCountdown = (seconds) => {
    if (seconds === null) return '--';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Format duration in minutes to readable format
  const formatDuration = (minutes) => {
    if (!minutes) return '--';
    const hours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    return `${hours}小时${mins}分钟`;
  };

  return (
    <div className={`port-card ${isOpen ? 'window-open' : 'window-closed'}`}>
      {/* Card Header */}
      <div className="card-header">
        <div className="card-title">
          <Anchor className="port-icon" size={20} />
          <h2>{port.name}</h2>
          <span className="port-name-en">{port.nameEn}</span>
        </div>
        <div className={`status-indicator ${isOpen ? 'open' : 'closed'}`}>
          <span className="status-dot"></span>
          <span className="status-text">{isOpen ? '窗口开放' : '窗口关闭'}</span>
        </div>
      </div>

      {/* Current Status Panel */}
      <div className="status-panel">
        <div className="status-row">
          <div className="status-metric">
            <TrendingUp className="metric-icon" size={16} />
            <div className="metric-content">
              <span className="metric-label">当前潮高</span>
              <span className={`metric-value ${currentHeight >= threshold ? 'safe' : 'warning'}`}>
                {currentHeight.toFixed(2)} m
              </span>
            </div>
          </div>

          <div className="status-metric">
            <Calendar className="metric-icon" size={16} />
            <div className="metric-content">
              <span className="metric-label">阈值</span>
              <span className="metric-value threshold">{threshold} m</span>
            </div>
          </div>
        </div>

        {/* Countdown Display */}
        <div className="countdown-panel">
          <Clock className="countdown-icon" size={18} />
          <div className="countdown-content">
            {isOpen && currentWindow ? (
              <>
                <span className="countdown-label">当前窗口剩余时间</span>
                <span className="countdown-value open">{formatCountdown(countdown)}</span>
                <span className="countdown-hint">窗口将于 {formatTime(currentWindow.end)} 关闭</span>
              </>
            ) : nextWindow ? (
              <>
                <span className="countdown-label">距离下一窗口</span>
                <span className="countdown-value closed">{formatCountdown(countdown)}</span>
                <span className="countdown-hint">窗口将于 {formatTime(nextWindow.start)} 开放</span>
              </>
            ) : (
              <>
                <span className="countdown-label">未来 72 小时</span>
                <span className="countdown-value none">无可用窗口</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Next Window Info */}
      <div className="window-info">
        <div className="window-label">下一个可出港窗口</div>
        {nextWindow ? (
          <div className="window-details">
            <div className="window-time">
              <span className="time-point">{formatTime(nextWindow.start)}</span>
              <span className="time-separator">→</span>
              <span className="time-point">{formatTime(nextWindow.end)}</span>
            </div>
            <div className="window-duration">持续时长：{formatDuration(nextWindow.duration)}</div>
          </div>
        ) : isOpen && currentWindow ? (
          <div className="window-details">
            <div className="window-time">
              <span className="time-point">{formatTime(currentWindow.start)}</span>
              <span className="time-separator">→</span>
              <span className="time-point">{formatTime(currentWindow.end)}</span>
            </div>
            <div className="window-duration">持续时长：{formatDuration(currentWindow.duration)}</div>
          </div>
        ) : (
          <div className="window-none">未来 72 小时内无可用窗口</div>
        )}
      </div>

      {/* Tide Curve */}
      <div className="tide-curve-container">
        <TideCurve
          series={series}
          threshold={threshold}
          windows={windows}
          currentTime={currentTime}
        />
      </div>

      {/* Window Summary */}
      <div className="window-summary">
        <span className="summary-label">72小时窗口统计：</span>
        <span className="summary-value">{windows.length} 个窗口</span>
        <span className="summary-separator">|</span>
        <span className="summary-value">
          总计 {formatDuration(windows.reduce((sum, w) => sum + w.duration, 0))}
        </span>
      </div>
    </div>
  );
}

export default PortCard;
