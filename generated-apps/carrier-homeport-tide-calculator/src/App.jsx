import React, { useState, useEffect } from 'react'
import { Clock, Waves, AlertCircle } from 'lucide-react'
import { generatePortData } from './data/mockTideData'
import PortCard from './components/PortCard'
import './App.css'

function App() {
  const [portsData, setPortsData] = useState([])
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [lastRefresh, setLastRefresh] = useState(Date.now())

  // 初始化四大港口数据
  useEffect(() => {
    const ports = [
      { id: 'norfolk', name: '诺福克', nameEn: 'Norfolk', timezone: 'EST' },
      { id: 'sandiego', name: '圣迭戈', nameEn: 'San Diego', timezone: 'PST' },
      { id: 'bremerton', name: '布雷默顿', nameEn: 'Bremerton', timezone: 'PST' },
      { id: 'yokosuka', name: '横须贺', nameEn: 'Yokosuka', timezone: 'JST' }
    ]

    const data = ports.map(port => generatePortData(port))
    setPortsData(data)
  }, [])

  // 演示加速器：每6秒推进20分钟，用于演示窗口状态变化
  useEffect(() => {
    const demoTick = setInterval(() => {
      setCurrentTime(prev => prev + 20 * 60 * 1000) // 推进20分钟
    }, 6000) // 每6秒

    return () => clearInterval(demoTick)
  }, [])

  // 模拟10分钟刷新
  useEffect(() => {
    const refreshInterval = setInterval(() => {
      setLastRefresh(Date.now())
    }, 10 * 60 * 1000)

    return () => clearInterval(refreshInterval)
  }, [])

  const formatTime = (timestamp) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  return (
    <div className="app">
      {/* 顶部状态栏 */}
      <header className="top-bar">
        <div className="top-bar-left">
          <Waves className="icon" size={20} />
          <h1 className="title">航母母港潮汐窗口计算器</h1>
          <span className="badge badge-info">演示潮汐序列 / mock</span>
        </div>
        <div className="top-bar-right">
          <div className="status-item">
            <AlertCircle size={16} />
            <span>吃水阈值: 12.8 m</span>
          </div>
          <div className="status-item">
            <Clock size={16} />
            <span>每 10 分钟刷新一次</span>
          </div>
          <div className="status-item">
            <span className="time">{formatTime(lastRefresh)}</span>
          </div>
        </div>
      </header>

      {/* 2×2 港口卡片矩阵 */}
      <main className="dashboard">
        <div className="ports-grid">
          {portsData.map(port => (
            <PortCard
              key={port.id}
              portData={port}
              currentTime={currentTime}
            />
          ))}
        </div>
      </main>

      {/* 底部说明 */}
      <footer className="footer">
        <div className="demo-notice">
          <AlertCircle size={14} />
          <span>演示模式：时间推进加速（每6秒 = 20分钟），便于观察窗口状态变化</span>
        </div>
      </footer>
    </div>
  )
}

export default App
