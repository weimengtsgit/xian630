import { useApplications } from '../hooks/useApplications'
import { Play, Square, RotateCcw, ExternalLink, Server } from 'lucide-react'
import './ApplicationsPanel.css'

function getStatusColor(status) {
  switch (status) {
    case 'running': return '#7feb9b'
    case 'stopped': return '#8fb0bf'
    case 'error': return '#ff665e'
    default: return '#a5bdca'
  }
}

function getStatusText(status) {
  switch (status) {
    case 'running': return '运行中'
    case 'stopped': return '已停止'
    case 'error': return '异常'
    default: return '未知'
  }
}

function formatTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(date))
}

export function ApplicationsPanel() {
  const { applications, loading, startApplication, stopApplication, restartApplication } = useApplications()

  if (loading) {
    return (
      <div className="applications-panel">
        <div className="panel-header">
          <h2>应用列表</h2>
        </div>
        <div className="panel-loading">加载中...</div>
      </div>
    )
  }

  return (
    <div className="applications-panel">
      <div className="panel-header">
        <h2>应用列表</h2>
        <span className="panel-count">{applications.length} 个应用</span>
      </div>
      <div className="panel-content">
        <div className="applications-grid">
          {applications.map(app => (
            <div key={app.id} className="app-card">
              <div className="app-card-header">
                <div className="app-icon">
                  <Server size={24} />
                </div>
                <div className={`app-status-badge ${app.status}`}>
                  <span className="status-dot"></span>
                  {getStatusText(app.status)}
                </div>
              </div>
              <div className="app-card-body">
                <h3 className="app-name">{app.name}</h3>
                <div className="app-meta-grid">
                  <div className="meta-item">
                    <span className="meta-label">类型</span>
                    <span className="meta-value">{app.type}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">端口</span>
                    <span className="meta-value">:{app.port}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">启动时间</span>
                    <span className="meta-value">{formatTime(app.startedAt)}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">地址</span>
                    <span className="meta-value url">{app.url}</span>
                  </div>
                </div>
              </div>
              <div className="app-card-footer">
                {app.status === 'running' && (
                  <>
                    <button
                      className="card-btn primary-btn"
                      onClick={() => window.open(app.url, '_blank')}
                    >
                      <ExternalLink size={16} />
                      打开
                    </button>
                    <button
                      className="card-btn danger-btn"
                      onClick={() => stopApplication(app.id)}
                    >
                      <Square size={14} />
                      停止
                    </button>
                  </>
                )}
                {app.status === 'stopped' && (
                  <button
                    className="card-btn success-btn"
                    onClick={() => startApplication(app.id)}
                  >
                    <Play size={14} />
                    启动
                  </button>
                )}
                {app.status === 'error' && (
                  <button
                    className="card-btn warning-btn"
                    onClick={() => restartApplication(app.id)}
                  >
                    <RotateCcw size={14} />
                    重启
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
