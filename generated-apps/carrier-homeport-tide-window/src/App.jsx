import React, { useState, useEffect } from 'react';
import { RefreshCw, Activity, AlertCircle } from 'lucide-react';
import { generatePortData, getCurrentStatus } from './data/mock';
import PortCard from './components/PortCard';
import './App.css';

/**
 * Main application component
 * Implements demo tick: every 6 seconds, advance 20 minutes in simulation time
 */
function App() {
  const [portData, setPortData] = useState([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // Initialize port data on mount
  useEffect(() => {
    const baseTime = new Date();
    const data = generatePortData(baseTime);
    setPortData(data);
  }, []);

  // Demo tick: advance 20 minutes every 6 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(prev => {
        const next = new Date(prev.getTime() + 20 * 60 * 1000); // +20 minutes
        return next;
      });
      setLastRefresh(new Date()); // Update UI refresh timestamp
    }, 6000); // 6 seconds

    return () => clearInterval(interval);
  }, []);

  // Format timestamp
  const formatTime = (date) => {
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="header-left">
            <Activity className="header-icon" size={28} />
            <h1 className="header-title">航母母港潮汐窗口计算器</h1>
          </div>

          <div className="header-right">
            <div className="status-badge mock">
              <AlertCircle size={14} />
              <span>演示潮汐序列 / mock</span>
            </div>
            <div className="status-badge refresh">
              <RefreshCw size={14} />
              <span>每 10 分钟刷新一次</span>
            </div>
          </div>
        </div>

        <div className="header-meta">
          <div className="meta-item">
            <span className="meta-label">模拟时间：</span>
            <span className="meta-value">{formatTime(currentTime)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">最近刷新：</span>
            <span className="meta-value">{formatTime(lastRefresh)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">吃水阈值：</span>
            <span className="meta-value threshold">12.8 米</span>
          </div>
        </div>
      </header>

      {/* Port Cards Grid */}
      <main className="main">
        <div className="port-grid">
          {portData.map((data, idx) => {
            const status = getCurrentStatus(data.series, data.windows, currentTime, data.threshold);
            return (
              <PortCard
                key={data.port.id}
                portData={data}
                currentTime={currentTime}
                status={status}
              />
            );
          })}
        </div>
      </main>

      {/* Footer */}
      <footer className="footer">
        <p>
          抓取 <strong>诺福克、圣迭戈、布雷默顿、横须贺</strong> 四大航母母港未来 <strong>72 小时</strong> 潮汐数据，
          航母吃水阈值设为 <strong>12.8 米</strong>，自动标出各港口满足条件的 <strong>"可出港时间窗"</strong>，
          倒计时显示距离下一个窗口还有多久；窗口开放时显示绿色，关闭时显示红色倒计时。
          <strong>每 10 分钟刷新一次</strong>。
        </p>
      </footer>
    </div>
  );
}

export default App;
