import React, { useState, useEffect } from 'react';
import { RefreshCw, Database } from 'lucide-react';
import PortCard from './components/PortCard';
import { generatePortData } from './data/mock';
import './App.css';

function App() {
  const [portsData, setPortsData] = useState([]);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [demoTime, setDemoTime] = useState(new Date());

  // 初始化数据
  useEffect(() => {
    refreshData();
  }, []);

  // 演示 tick：每 6 秒推进 20 分钟
  useEffect(() => {
    const interval = setInterval(() => {
      setDemoTime(prev => new Date(prev.getTime() + 20 * 60 * 1000));
    }, 6000);
    return () => clearInterval(interval);
  }, []);

  // 每 10 分钟刷新数据
  useEffect(() => {
    const interval = setInterval(() => {
      refreshData();
    }, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const refreshData = () => {
    const ports = [
      { id: 'norfolk', name: '诺福克', nameEn: 'Norfolk', timezone: 'UTC-5' },
      { id: 'san-diego', name: '圣迭戈', nameEn: 'San Diego', timezone: 'UTC-8' },
      { id: 'bremerton', name: '布雷默顿', nameEn: 'Bremerton', timezone: 'UTC-8' },
      { id: 'yokosuka', name: '横须贺', nameEn: 'Yokosuka', timezone: 'UTC+9' }
    ];

    const data = ports.map(port => generatePortData(port));
    setPortsData(data);
    setLastRefresh(new Date());
  };

  const formatTime = (date) => {
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">航母母港潮汐窗口计算器</h1>
          <div className="badge-group">
            <span className="badge badge-demo">
              <Database size={14} />
              演示潮汐序列 / mock
            </span>
            <span className="badge badge-info">
              12.8 米吃水阈值
            </span>
          </div>
        </div>
        <div className="header-right">
          <div className="refresh-info">
            <RefreshCw size={16} />
            <span>每 10 分钟刷新一次</span>
          </div>
          <div className="last-refresh">
            最近刷新：{formatTime(lastRefresh)}
          </div>
          <div className="demo-time">
            演示时间：{formatTime(demoTime)}
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="ports-grid">
          {portsData.map(port => (
            <PortCard
              key={port.id}
              port={port}
              currentTime={demoTime}
            />
          ))}
        </div>
      </main>

      <footer className="app-footer">
        <span>诺福克 / 圣迭戈 / 布雷默顿 / 横须贺 四大航母母港 · 未来 72 小时潮汐数据</span>
      </footer>
    </div>
  );
}

export default App;
