import { Bell, Database, Map, Settings, UserCircle, CloudSun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AgentStatus } from './AgentStatus'

function formatNow(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-')
}

export function TopBar() {
  const [now, setNow] = useState(() => formatNow(new Date()))

  useEffect(() => {
    const timer = window.setInterval(() => setNow(formatNow(new Date())), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <header className="top-bar" aria-label="系统状态栏">
      <nav className="top-menu" aria-label="主菜单">
        <button type="button">首页</button>
        <button type="button">任务</button>
        <button type="button">支持</button>
      </nav>

      <div className="title-ribbon">
        <span className="ribbon-cap left" />
        <h1>智能软件工厂</h1>
        <span className="ribbon-cap right" />
      </div>

      <div className="status-cluster">
        <AgentStatus />
        <span className="status-item">
          <Map size={15} />
          系统
        </span>
        <span className="status-item">
          <CloudSun size={15} />
          晴
        </span>
        <span className="status-time">{now}</span>
        <span className="status-item">XX市</span>
        <button type="button" title="消息">
          <Bell size={16} />
        </button>
        <button type="button" title="数据">
          <Database size={16} />
        </button>
        <button type="button" title="用户">
          <UserCircle size={17} />
        </button>
        <button type="button" title="设置">
          <Settings size={16} />
        </button>
      </div>
    </header>
  )
}
