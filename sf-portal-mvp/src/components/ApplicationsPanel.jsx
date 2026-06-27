import { useEffect, useState } from 'react'
import {
  Play,
  Square,
  RotateCcw,
  ExternalLink,
  Server,
  RefreshCw,
  Sparkles,
  ChevronLeft,
  Loader2,
  Trash2,
  Link,
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

const ACTION_TEXT = {
  start: '启动中',
  stop: '停止中',
  rebuild: '重建中',
  regenerate: '创建中',
  delete: '删除中',
}

function isGenerated(app) {
  return app.source === 'generated' || app.source === 'generated-apps'
}

function formatCreatedAt(app) {
  const raw = app && (app.created_at || app.createdAt)
  if (!raw) return '-'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return String(raw)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatAppType(type) {
  const map = {
    command_dashboard: '指挥仪表盘',
    situation_replay: '态势复盘',
    operations_management: '运营管理',
    managed_agent: '纳管智能体',
    'command-dashboard': '指挥仪表盘',
    'affiliation-inference-dashboard': '归属推断仪表盘',
    'timeline-replay': '态势复盘',
    'map-dashboard': '地图态势',
  }
  return map[type] || type || '-'
}

function orderManagedAgents(agents) {
  const list = Array.isArray(agents) ? agents : []
  return [...list].sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER
    const bo = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER
    if (ao !== bo) return ao - bo
    return (a.slug || '').localeCompare(b.slug || '')
  })
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
  onDelete,
  onRefresh,
  managedAgents,
  managedAgentsLoading,
  managedAgentsError,
  onRefreshManagedAgents,
  onHidePanel,
}) {
  const list = orderApplicationsForDisplay(apps)
  const managedList = orderManagedAgents(managedAgents)
  const showManagedTab = managedList.length > 0
  const [activeTab, setActiveTab] = useState('business')

  useEffect(() => {
    if (!showManagedTab && activeTab === 'managed') setActiveTab('business')
  }, [showManagedTab, activeTab])

  const isManaged = showManagedTab && activeTab === 'managed'
  const activeCount = isManaged ? managedList.length : list.length
  const activeLoading = isManaged ? managedAgentsLoading : loading
  const activeError = isManaged ? managedAgentsError : error
  const refreshActive = () => {
    if (isManaged) {
      onRefreshManagedAgents && onRefreshManagedAgents()
    } else {
      onRefresh && onRefresh()
    }
  }

  return (
    <div className="applications-panel">
      <div className="panel-header">
        <div className="panel-header-main">
          {showManagedTab ? (
            <div className="panel-tabs" role="tablist" aria-label="智能体分类">
              <button type="button" className={activeTab === 'business' ? 'active' : ''} onClick={() => setActiveTab('business')}>
                业务智能体
              </button>
              <button type="button" className={activeTab === 'managed' ? 'active' : ''} onClick={() => setActiveTab('managed')}>
                纳管智能体
              </button>
            </div>
          ) : (
            <h2>业务智能体</h2>
          )}
        </div>
        <div className="panel-actions">
          <span className="panel-count">{activeCount} 个智能体</span>
          <button type="button" className="panel-action-btn panel-refresh-btn" title="刷新" aria-label="刷新" onClick={refreshActive}>
            <RefreshCw size={14} />
          </button>
          {onHidePanel ? (
            <button type="button" className="panel-action-btn panel-hide-btn" title="隐藏左侧智能体" aria-label="隐藏左侧智能体" onClick={onHidePanel}>
              <ChevronLeft size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {activeError && <div className="panel-error">加载失败：{activeError}</div>}

      <div className="panel-content">
        {activeLoading && activeCount === 0 ? (
          <div className="panel-loading">加载中...</div>
        ) : isManaged ? (
          <ManagedAgentList agents={managedList} />
        ) : list.length === 0 ? (
          <div className="panel-loading">
            {error ? '无法连接到工厂服务' : '暂无智能体'}
          </div>
        ) : (
          <div className="applications-list">
            {list.map(app => (
              <ApplicationCard
                key={app.id}
                app={app}
                action={actionById && actionById[app.id]}
                onStart={onStart}
                onStop={onStop}
                onRebuild={onRebuild}
                onRegenerate={onRegenerate}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ApplicationCard({ app, action, onStart, onStop, onRebuild, onRegenerate, onDelete }) {
  const status = app.status || 'stopped'
  const url = app.runtime_url || app.url
  const busy = Boolean(action)
  return (
    <div className={`app-card app-status-${status}`}>
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
        {app.description || app.slug ? (
          <p className="app-sub" title={app.description || app.slug}>
            <span className="app-sub-text">{app.description || app.slug}</span>
            <span className="app-sub-tooltip">{app.description || app.slug}</span>
          </p>
        ) : null}
        <div className="app-meta">
          <span className="meta-item">
            <span className="meta-label">类型</span>
            <span className="meta-value">{formatAppType(app.type)}</span>
          </span>
          <span className="meta-item">
            <span className="meta-label">创建时间</span>
            <span className="meta-value">{formatCreatedAt(app)}</span>
          </span>
        </div>
      </div>
      <div className="app-card-footer">
        {status === 'running' && url && (
          <button type="button" className="card-btn primary-btn" onClick={() => window.open(url, '_blank', 'noopener')} title={url} disabled={busy}>
            <ExternalLink size={14} /> 打开
          </button>
        )}
        {status === 'stopped' && (
          <button type="button" className="card-btn success-btn" onClick={() => onStart && onStart(app.id)} disabled={busy}>
            {action === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {action === 'start' ? ACTION_TEXT[action] : '启动'}
          </button>
        )}
        {status === 'running' && (
          <button type="button" className="card-btn danger-btn" onClick={() => onStop && onStop(app.id)} disabled={busy}>
            {action === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />}
            {action === 'stop' ? ACTION_TEXT[action] : '停止'}
          </button>
        )}
        {(status === 'error' || status === 'building' || status === 'missing' || status === 'stopped') && (
          <button type="button" className="card-btn warning-btn" onClick={() => onRebuild && onRebuild(app.id)} disabled={busy}>
            {action === 'rebuild' ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
            {action === 'rebuild' ? ACTION_TEXT[action] : '重建镜像'}
          </button>
        )}
        {isGenerated(app) && (
          <button type="button" className="card-btn ghost-btn" onClick={() => onRegenerate && onRegenerate(app)} title="基于该智能体重新生成" disabled={busy}>
            {action === 'regenerate' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {action === 'regenerate' ? ACTION_TEXT[action] : '重新生成'}
          </button>
        )}
        {isGenerated(app) && (
          <button
            type="button"
            className="card-btn danger-btn"
            onClick={() => {
              if (window.confirm(`确认删除生成智能体「${app.name || app.slug}」？本地生成目录会被删除，生成审计记录会保留。`)) {
                onDelete && onDelete(app.id)
              }
            }}
            title="删除生成智能体"
            disabled={busy}
          >
            {action === 'delete' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
            {action === 'delete' ? ACTION_TEXT[action] : '删除'}
          </button>
        )}
      </div>
    </div>
  )
}

function ManagedAgentList({ agents }) {
  if (!Array.isArray(agents) || agents.length === 0) return null
  return (
    <div className="applications-list">
      {agents.map(agent => (
        <div key={agent.slug} className="app-card managed-agent-card">
          <div className="app-card-header">
            <div className="app-icon">
              <Link size={18} />
            </div>
            <div className="managed-agent-badge">纳管中</div>
          </div>
          <div className="app-card-body">
            <h3 className="app-name" title={agent.name || agent.slug}>
              {agent.name || agent.slug}
            </h3>
            {agent.description ? (
              <p className="app-sub" title={agent.description}>
                <span className="app-sub-text">{agent.description}</span>
                <span className="app-sub-tooltip">{agent.description}</span>
              </p>
            ) : null}
            {Array.isArray(agent.keywords) && agent.keywords.length > 0 ? (
              <div className="managed-agent-tags">
                {agent.keywords.slice(0, 4).map(keyword => <span key={keyword}>{keyword}</span>)}
              </div>
            ) : null}
          </div>
          {agent.url ? (
            <div className="app-card-footer">
              <button type="button" className="card-btn primary-btn" onClick={() => window.open(agent.url, '_blank', 'noopener')} title={agent.url}>
                <ExternalLink size={14} /> 打开
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
