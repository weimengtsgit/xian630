import {
  Play,
  Square,
  RotateCcw,
  ExternalLink,
  Server,
  RefreshCw,
  Sparkles,
  Loader2,
} from 'lucide-react'
import { orderApplicationsForDisplay } from '../hooks/applicationOrdering'
import './ApplicationsPanel.css'

const STATUS_TEXT = {
  running: '运行中',
  stopped: '已停止',
  error: '异常',
  building: '构建中',
  missing: '缺失',
}

function isGenerated(app) {
  return app.source === 'generated' || app.source === 'generated-apps'
}

const ACTION_TEXT = {
  start: '启动中',
  stop: '停止中',
  rebuild: '重建中',
  regenerate: '创建中',
}

export function ApplicationsPanel({
  apps,
  loading,
  error,
  actionById,
  onStart,
  onStop,
  onRebuild,
  onRegenerate,
  onRefresh,
}) {
  const list = orderApplicationsForDisplay(apps)

  return (
    <div className="applications-panel">
      <div className="panel-header">
        <h2>应用列表</h2>
        <div className="panel-header-right">
          <span className="panel-count">{list.length} 个应用</span>
          <button
            type="button"
            className="panel-refresh-btn"
            title="刷新"
            onClick={() => onRefresh && onRefresh()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {error && <div className="panel-error">加载失败：{error}</div>}

      <div className="panel-content">
        {loading && list.length === 0 ? (
          <div className="panel-loading">加载中...</div>
        ) : list.length === 0 ? (
          <div className="panel-loading">
            {error ? '无法连接到工厂服务' : '暂无应用'}
          </div>
        ) : (
          <div className="applications-list">
            {list.map(app => {
              const status = app.status || 'stopped'
              const url = app.runtime_url || app.url
              const action = actionById && actionById[app.id]
              const busy = Boolean(action)
              return (
                <div key={app.id} className={`app-card app-status-${status}`}>
                  <div className="app-card-header">
                    <div className="app-icon">
                      <Server size={18} />
                    </div>
                    <div className={`app-status-badge ${status}`}>
                      <span className="status-dot"></span>
                      {STATUS_TEXT[status] || status}
                    </div>
                  </div>
                  <div className="app-card-body">
                    <h3 className="app-name" title={app.name || app.slug}>
                      {app.name || app.slug || app.id}
                    </h3>
                    {(() => {
                      const sub = app.description || app.slug || ''
                      return sub ? <p className="app-sub" title={sub}>{sub}</p> : null
                    })()}
                    <div className="app-meta">
                      <span className="meta-item">
                        <span className="meta-label">类型</span>
                        <span className="meta-value">{app.type || '-'}</span>
                      </span>
                      <span className="meta-item">
                        <span className="meta-label">来源</span>
                        <span className="meta-value">{app.source || '-'}</span>
                      </span>
                    </div>
                  </div>
                  <div className="app-card-footer">
                    {status === 'running' && url && (
                      <button
                        type="button"
                        className="card-btn primary-btn"
                        onClick={() => window.open(url, '_blank', 'noopener')}
                        title={url}
                        disabled={busy}
                      >
                        <ExternalLink size={14} /> 打开
                      </button>
                    )}
                    {status === 'stopped' && (
                      <button
                        type="button"
                        className="card-btn success-btn"
                        onClick={() => onStart && onStart(app.id)}
                        disabled={busy}
                      >
                        {action === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                        {action === 'start' ? ACTION_TEXT[action] : '启动'}
                      </button>
                    )}
                    {status === 'running' && (
                      <button
                        type="button"
                        className="card-btn danger-btn"
                        onClick={() => onStop && onStop(app.id)}
                        disabled={busy}
                      >
                        {action === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />}
                        {action === 'stop' ? ACTION_TEXT[action] : '停止'}
                      </button>
                    )}
                    {(status === 'error' || status === 'building' || status === 'missing' || status === 'stopped') && (
                      <button
                        type="button"
                        className="card-btn warning-btn"
                        onClick={() => onRebuild && onRebuild(app.id)}
                        disabled={busy}
                      >
                        {action === 'rebuild' ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
                        {action === 'rebuild' ? ACTION_TEXT[action] : '重建镜像'}
                      </button>
                    )}
                    {isGenerated(app) && (
                      <button
                        type="button"
                        className="card-btn ghost-btn"
                        onClick={() => onRegenerate && onRegenerate(app)}
                        title="基于该应用重新生成"
                        disabled={busy}
                      >
                        {action === 'regenerate' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                        {action === 'regenerate' ? ACTION_TEXT[action] : '重新生成'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
