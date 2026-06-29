import { useMemo, useState } from 'react'
import {
  AppWindow,
  ExternalLink,
  Filter,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import {
  isGeneratedApplication,
  orderApplicationsForStore,
} from '../hooks/applicationOrdering'
import './ApplicationStorePage.css'

export const STATUS_TEXT = {
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

const TYPE_LABELS = {
  command_dashboard: '指挥看板',
  'command-dashboard': '指挥看板',
  situation_replay: '态势复盘',
  'timeline-replay': '态势复盘',
  operations_management: '业务管理',
  'map-dashboard': '地图态势',
  'affiliation-inference-dashboard': '归属研判',
}

export function formatApplicationType(type) {
  return TYPE_LABELS[type] || '其他应用'
}

export function filterStoreApplications(apps) {
  const list = Array.isArray(apps) ? apps : []
  return list.filter(app => app && app.type !== 'managed_agent' && app.surface !== 'managed_agent')
}

export { orderApplicationsForStore }

function sourceLabel(app) {
  return isGeneratedApplication(app) ? '生成应用' : '预置应用'
}

function appTitle(app) {
  return app.name || app.slug || app.id || '未命名应用'
}

function appUrl(app) {
  return app.runtime_url || app.runtimeUrl || app.url || ''
}

function formatCreatedAt(app) {
  const raw = app && (app.created_at || app.createdAt)
  if (!raw) return '未记录'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return String(raw)
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function ApplicationStorePage(props) {
  const {
    apps,
    loading,
    error,
    actionById,
    refresh,
    startApplication,
    stopApplication,
    restartApplication,
    deleteApplication,
    onRegenerate,
  } = props
  const [activeType, setActiveType] = useState('all')
  const [selectedAppId, setSelectedAppId] = useState(null)

  const orderedApps = useMemo(() => orderApplicationsForStore(filterStoreApplications(apps)), [apps])
  const categories = useMemo(() => {
    const labels = orderedApps
      .map(app => ({ type: app.type || 'other', label: formatApplicationType(app.type) }))
      .filter(item => item.type !== 'managed_agent' && item.label !== '纳管智能体')
    const seen = new Set()
    return [{ type: 'all', label: '全部应用' }, ...labels.filter(item => {
      if (seen.has(item.label)) return false
      seen.add(item.label)
      return true
    })]
  }, [orderedApps])
  const visibleApps = activeType === 'all'
    ? orderedApps
    : orderedApps.filter(app => formatApplicationType(app.type) === activeType)
  const featuredApps = orderedApps.slice(0, 3)
  const selectedApp = selectedAppId ? orderedApps.find(app => app.id === selectedAppId) : null

  return (
    <section className="application-store-page" aria-label="应用商店">
      <header className="store-hero">
        <div>
          <span className="store-kicker">APPLICATION STORE</span>
          <h2>应用商店</h2>
          <p>浏览生成应用与预置应用，在详情中打开、启动、停止或维护应用。</p>
        </div>
        <div className="store-status-bar" aria-label="应用商店状态">
          <span><AppWindow size={16} /> {orderedApps.length} 个应用</span>
          <span><Sparkles size={16} /> {orderedApps.filter(isGeneratedApplication).length} 个生成应用</span>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            刷新状态
          </button>
        </div>
      </header>

      {error ? <div className="store-error">加载失败：{error}</div> : null}

      <section className="store-featured" aria-label="新品推荐">
        <div className="store-section-title"><Star size={16} /> 新品推荐</div>
        <div className="store-featured-list">
          {featuredApps.map(app => (
            <button key={app.id || app.slug} type="button" className="store-featured-card" onClick={() => setSelectedAppId(app.id)}>
              <strong>{appTitle(app)}</strong>
              <span>{formatApplicationType(app.type)} · {sourceLabel(app)}</span>
              <small>{app.description || app.slug || '点击查看详情'}</small>
            </button>
          ))}
          {!loading && featuredApps.length === 0 ? <p className="store-empty-inline">暂无可推荐应用</p> : null}
        </div>
      </section>

      <div className="store-toolbar">
        <div className="store-search-hint"><Search size={15} /> 按分类筛选应用</div>
        <div className="store-category-filter" role="tablist" aria-label="应用类型筛选">
          {categories.map(category => (
            <button
              key={category.type === 'all' ? 'all' : category.label}
              type="button"
              className={activeType === (category.type === 'all' ? 'all' : category.label) ? 'active' : ''}
              onClick={() => setActiveType(category.type === 'all' ? 'all' : category.label)}
            >
              <Filter size={13} /> {category.label}
            </button>
          ))}
        </div>
      </div>

      <div className="store-grid" aria-label="应用卡片网格">
        {loading && orderedApps.length === 0 ? <div className="store-empty">应用加载中...</div> : null}
        {!loading && visibleApps.length === 0 ? <div className="store-empty">暂无应用</div> : null}
        {visibleApps.map(app => (
          <button key={app.id || app.slug} type="button" className={`store-card status-${app.status || 'stopped'}`} onClick={() => setSelectedAppId(app.id)}>
            <div className="store-card-head">
              <span className="store-card-icon"><AppWindow size={22} /></span>
              <span className={`store-status ${app.status || 'stopped'}`}>{STATUS_TEXT[app.status] || app.status || '未知'}</span>
            </div>
            <strong>{appTitle(app)}</strong>
            <p>{app.description || app.slug || '暂无描述'}</p>
            <div className="store-card-meta">
              <span>{formatApplicationType(app.type)}</span>
              <span>{sourceLabel(app)}</span>
            </div>
          </button>
        ))}
      </div>

      {selectedApp ? (
        <ApplicationDetailModal
          app={selectedApp}
          action={actionById && actionById[selectedApp.id]}
          onClose={() => setSelectedAppId(null)}
          onRefresh={refresh}
          onStart={startApplication}
          onStop={stopApplication}
          onRebuild={restartApplication}
          onRegenerate={appToRegenerate => {
            if (onRegenerate) onRegenerate(appToRegenerate)
            setSelectedAppId(null)
          }}
          onDelete={deleteApplication}
        />
      ) : null}
    </section>
  )
}

function ApplicationDetailModal({ app, action, onClose, onRefresh, onStart, onStop, onRebuild, onRegenerate, onDelete }) {
  const status = app.status || 'stopped'
  const url = appUrl(app)
  const busy = Boolean(action)
  const generated = isGeneratedApplication(app)
  const regenerate = () => {
    onRegenerate?.(app)
    onClose()
  }
  return (
    <div className="store-detail-backdrop" role="presentation" onClick={onClose}>
      <article className="store-detail" role="dialog" aria-modal="true" aria-label={`${appTitle(app)}详情`} onClick={event => event.stopPropagation()}>
        <header className="store-detail-header">
          <div>
            <span className="store-kicker">应用详情</span>
            <h3>{appTitle(app)}</h3>
          </div>
          <button type="button" className="store-detail-close" onClick={onClose} aria-label="关闭详情"><X size={18} /></button>
        </header>
        <p className="store-detail-desc">{app.description || app.slug || '暂无描述'}</p>
        <div className="store-detail-grid">
          <span>类型</span><b>{formatApplicationType(app.type)}</b>
          <span>来源</span><b>{sourceLabel(app)}</b>
          <span>状态</span><b>{STATUS_TEXT[status] || status}</b>
          <span>创建时间</span><b>{formatCreatedAt(app)}</b>
        </div>
        <div className="store-detail-actions">
          {url ? <button type="button" onClick={() => window.open(url, '_blank', 'noopener')} disabled={busy}><ExternalLink size={15} /> 打开</button> : null}
          {status !== 'running' ? <button type="button" onClick={() => onStart && onStart(app.id)} disabled={busy}>{action === 'start' ? <Loader2 size={15} className="spin" /> : <Play size={15} />} {action === 'start' ? ACTION_TEXT[action] : '启动'}</button> : null}
          {status === 'running' ? <button type="button" onClick={() => onStop && onStop(app.id)} disabled={busy}>{action === 'stop' ? <Loader2 size={15} className="spin" /> : <Square size={15} />} {action === 'stop' ? ACTION_TEXT[action] : '停止'}</button> : null}
          <button type="button" onClick={() => onRebuild && onRebuild(app.id)} disabled={busy}>{action === 'rebuild' ? <Loader2 size={15} className="spin" /> : <RotateCcw size={15} />} {action === 'rebuild' ? ACTION_TEXT[action] : '重建镜像'}</button>
          <button type="button" onClick={onRefresh} disabled={busy}><RefreshCw size={15} /> 刷新状态</button>
          {generated ? <button type="button" onClick={() => onRegenerate && onRegenerate(app)} disabled={busy}>{action === 'regenerate' ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {action === 'regenerate' ? ACTION_TEXT[action] : '重新生成'}</button> : null}
          {generated ? <button type="button" className="danger" onClick={() => { if (window.confirm(`确认删除生成应用「${appTitle(app)}」？本地生成目录会被删除，生成审计记录会保留。`)) onDelete && onDelete(app.id) }} disabled={busy}>{action === 'delete' ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} {action === 'delete' ? ACTION_TEXT[action] : '删除'}</button> : null}
        </div>
      </article>
    </div>
  )
}
