import React, { useState, useEffect } from 'react';
import { Clock, AlertCircle, CheckCircle, TrendingUp, Anchor } from 'lucide-react';
import TideCurve from './TideCurve';
import './PortCard.css';

function PortCard({ port, currentTime }) {
  const [countdown, setCountdown] = useState('');
  const [currentTide, setCurrentTide] = useState(null);
  const [isInWindow, setIsInWindow] = useState(false);
  const [nextWindow, setNextWindow] = useState(null);

  useEffect(() => {
    updateStatus();
    const interval = setInterval(updateStatus, 1000);
    return () => clearInterval(interval);
  }, [port, currentTime]);

  const updateStatus = () => {
    const now = currentTime.getTime();

    // 找到当前时刻的潮高
    const current = port.series.find((p, i) => {
      const next = port.series[i + 1];
      return p.t <= now && (!next || next.t > now);
    });

    if (current) {
      const next = port.series[port.series.findIndex(p => p.t === current.t) + 1];
      if (next) {
        // 线性插值
        const ratio = (now - current.t) / (next.t - current.t);
        const height = current.height + (next.height - current.height) * ratio;
        setCurrentTide(height);
      } else {
        setCurrentTide(current.height);
      }
    }

    // 判断是否在窗口内
    const inWindow = port.windows.some(w => now >= w.start && now < w.end);
    setIsInWindow(inWindow);

    // 找到下一个窗口
    const upcoming = port.windows.find(w => w.start > now);
    setNextWindow(upcoming);

    // 计算倒计时
    if (inWindow) {
      const currentWindow = port.windows.find(w => now >= w.start && now < w.end);
      if (currentWindow) {
        const remaining = currentWindow.end - now;
        setCountdown(formatDuration(remaining));
      }
    } else if (upcoming) {
      const remaining = upcoming.start - now;
      setCountdown(formatDuration(remaining));
    } else {
      setCountdown('无后续窗口');
    }
  };

  const formatDuration = (ms) => {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((ms % (1000 * 60)) / 1000);
    return `${hours}小时 ${minutes}分 ${seconds}秒`;
  };

  const formatDateTime = (timestamp) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const meetsThreshold = currentTide >= port.threshold;

  return (
    <div className={`port-card ${isInWindow ? 'window-open' : 'window-closed'}`}>
      <div className="card-header">
        <div className="port-info">
          <h2 className="port-name">
            <Anchor size={20} />
            {port.name}
          </h2>
          <span className="port-name-en">{port.nameEn}</span>
          <span className="port-timezone">{port.timezone}</span>
        </div>
        <div className={`status-badge ${isInWindow ? 'status-open' : 'status-closed'}`}>
          {isInWindow ? (
            <>
              <CheckCircle size={16} />
              <span>窗口开放</span>
            </>
          ) : (
            <>
              <AlertCircle size={16} />
              <span>窗口关闭</span>
            </>
          )}
        </div>
      </div>

      <div className="card-body">
        <div className="metrics-row">
          <div className="metric">
            <span className="metric-label">当前潮高</span>
            <span className={`metric-value ${meetsThreshold ? 'value-safe' : 'value-danger'}`}>
              {currentTide ? currentTide.toFixed(2) : '--'} 米
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">吃水阈值</span>
            <span className="metric-value value-threshold">
              {port.threshold.toFixed(1)} 米
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">
              {isInWindow ? '窗口剩余' : '距离窗口'}
            </span>
            <span className={`metric-value ${isInWindow ? 'value-countdown-open' : 'value-countdown-closed'}`}>
              <Clock size={18} />
              {countdown}
            </span>
          </div>
        </div>

        {nextWindow && (
          <div className="window-info">
            <div className="window-header">
              <TrendingUp size={16} />
              <span>{isInWindow ? '当前窗口' : '下一窗口'}</span>
            </div>
            <div className="window-times">
              <span>起始：{formatDateTime(isInWindow ?
                port.windows.find(w => currentTime.getTime() >= w.start && currentTime.getTime() < w.end)?.start :
                nextWindow.start)}</span>
              <span>结束：{formatDateTime(isInWindow ?
                port.windows.find(w => currentTime.getTime() >= w.start && currentTime.getTime() < w.end)?.end :
                nextWindow.end)}</span>
            </div>
          </div>
        )}

        <div className="tide-curve-container">
          <div className="curve-label">未来 72 小时潮汐曲线</div>
          <TideCurve
            series={port.series}
            threshold={port.threshold}
            windows={port.windows}
            currentTime={currentTime.getTime()}
          />
        </div>
      </div>
    </div>
  );
}

export default PortCard;
