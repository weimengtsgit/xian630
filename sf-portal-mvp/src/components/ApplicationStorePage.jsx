import {useMemo, useState} from 'react'
import {
    AppWindow,
    ExternalLink,
    Filter,
    Gauge,
    Loader2,
    Play,
    RefreshCw,
    RotateCcw,
    Search,
    Sparkles,
    Square,
    Star,
    Timer,
    Trash2,
    X,
} from 'lucide-react'
import {isGeneratedApplication, orderApplicationsForStore,} from '../hooks/applicationOrdering'
import {formatAppType} from '../utils/formatLabels'
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

export function formatApplicationType(type) {
    const label = formatAppType(type)
    return !label || label === '-' || label === type ? '其他应用' : label
}

export function filterStoreApplications(apps) {
    const list = Array.isArray(apps) ? apps : []
    return list.filter(app => app && app.type !== 'managed_agent' && app.surface !== 'managed_agent')
}

export {orderApplicationsForStore}

function sourceLabel(app) {
    return isGeneratedApplication(app) ? '生成应用' : '预置应用'
}

function typeSlug(type) {
    return String(type || 'other').replace(/_/g, '-')
}

function appTitle(app) {
    return app.name || app.slug || app.id || '未命名应用'
}

export function normalizeApplicationUrl(rawUrl) {
    const value = String(rawUrl || '').trim()
    if (!value || /^https?:\/\//i.test(value) || value.startsWith('/')) return value
    const hostLike = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z\d-]+\.)+[a-z\d-]+)(?::\d+)?(?:[/?#].*)?$/i
    if (hostLike.test(value)) return `http://${value}`
    return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : value
}

function appUrl(app) {
    return normalizeApplicationUrl(app && (app.runtime_url || app.runtimeUrl || app.url || ''))
}

function formatCreatedAt(app) {
    const raw = app && (app.created_at || app.createdAt)
    if (!raw) return '未记录'
    const date = new Date(raw)
    if (Number.isNaN(date.getTime())) return String(raw)
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    })
}

function normalizeFeatureText(item) {
    if (!item) return ''
    if (typeof item === 'string') return item.trim()
    if (typeof item === 'object') {
        return String(item.label || item.name || item.title || item.summary || item.description || '').trim()
    }
    return String(item).trim()
}

function parseRequirement(app) {
    const raw = app && (app.confirmed_requirement_json || app.confirmedRequirementJSON || app.requirement_json || app.requirementJSON)
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

function splitDescriptionIntoFeatures(description) {
    if (!description) return []
    return String(description)
        .split(/[，,。；;、]/)
        .map(item => item.trim())
        .filter(item => item.length >= 4)
}

export function extractApplicationFeatures(app) {
    const requirement = parseRequirement(app) || {}
    const candidates = [
        app && app.features,
        app && app.featureList,
        app && app.feature_list,
        app && app.keyFeatures,
        app && app.key_features,
        requirement.keyFeatures,
        requirement.key_features,
        requirement.acceptanceFocus,
        requirement.acceptance_focus,
        requirement.mainEntities,
        requirement.main_entities,
        splitDescriptionIntoFeatures(app && app.description),
    ]

    const seen = new Set()
    const features = []
    candidates.flatMap(item => Array.isArray(item) ? item : (item ? [item] : []))
        .map(normalizeFeatureText)
        .filter(Boolean)
        .forEach(text => {
            const normalized = text.replace(/\s+/g, '')
            if (seen.has(normalized)) return
            seen.add(normalized)
            features.push(text)
        })

    if (features.length > 0) return features.slice(0, 5)

    return [
        `${formatApplicationType(app && app.type)}能力呈现`,
        '运行状态监测',
        '应用启动与维护',
        '详情信息汇总',
    ]
}

function formatVersion(app) {
    return app.version || app.current_version || app.currentVersion || app.version_id || app.versionId || '未记录'
}

function vendorLabel(app) {
    return isGeneratedApplication(app) ? '软件工厂' : '预置应用库'
}

export function formatGenerationDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '--'
    const totalSeconds = Math.round(ms / 1000)
    if (totalSeconds < 60) return `${totalSeconds}秒`
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes < 60) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分钟`
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return remainingMinutes > 0 ? `${hours}小时${remainingMinutes}分钟` : `${hours}小时`
}


export function calculateOverallGenerationAverage(stats) {
    const applicationAverage = stats && stats.application_average_generation_ms
    const iterationAverage = stats && stats.iteration_average_generation_ms
    if (!Number.isFinite(applicationAverage) || !Number.isFinite(iterationAverage)) return null
    return (applicationAverage + iterationAverage) / 2
}

export function ApplicationStorePage(props) {
    const {
        apps,
        loading,
        error,
        actionById,
        generationStats,
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
            .map(app => ({type: app.type || 'other', label: formatApplicationType(app.type)}))
            .filter(item => item.type !== 'managed_agent' && item.label !== '纳管智能体')
        const seen = new Set()
        return [{type: 'all', label: '全部应用'}, ...labels.filter(item => {
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
                    <span><AppWindow size={16}/> {orderedApps.length} 个应用</span>
                    <span><Sparkles size={16}/> {orderedApps.filter(isGeneratedApplication).length} 个生成应用</span>
                    <button type="button" onClick={refresh} disabled={loading}>
                        {loading ? <Loader2 size={16} className="spin"/> : <RefreshCw size={16}/>}
                        刷新状态
                    </button>
                </div>
            </header>

            {error ? <div className="store-error">加载失败：{error}</div> : null}

            <section className="store-generation-stats" aria-label="应用生成统计">
                <div className="store-generation-stat">
                    <span className="store-stat-icon"><Timer size={18}/></span>
                    <div>
                        <span>生成平均时间</span>
                        <strong>{formatGenerationDuration(generationStats && generationStats.application_average_generation_ms)}</strong>
                    </div>
                </div>
                <div className="store-generation-stat">
                    <span className="store-stat-icon"><RotateCcw size={18}/></span>
                    <div>
                        <span>迭代平均时间</span>
                        <strong>{formatGenerationDuration(generationStats && generationStats.iteration_average_generation_ms)}</strong>
                    </div>
                </div>
                <div className="store-generation-stat">
                    <span className="store-stat-icon"><Gauge size={18}/></span>
                    <div>
                        <span>综合平均时间</span>
                        <strong>{formatGenerationDuration(calculateOverallGenerationAverage(generationStats))}</strong>
                    </div>
                </div>
            </section>

            <section className="store-featured" aria-label="新品推荐">
                <div className="store-section-title"><Star size={16}/> 新品推荐</div>
                <div className="store-featured-list">
                    {featuredApps.map(app => (
                        <button key={app.id || app.slug} type="button" className="store-featured-card"
                                onClick={() => setSelectedAppId(app.id)}>
                            <span className="store-featured-badge">新品</span>
                            <strong>{appTitle(app)}</strong>
                            <span className="store-tag-row"><span
                                className={`store-tag store-type-${typeSlug(app.type)}`}>{formatApplicationType(app.type)}</span><span
                                className={`store-tag store-source-${isGeneratedApplication(app) ? 'generated' : 'preset'}`}>{sourceLabel(app)}</span></span>
                            <small>{app.description || app.slug || '点击查看详情'}</small>
                        </button>
                    ))}
                    {!loading && featuredApps.length === 0 ?
                        <p className="store-empty-inline">暂无可推荐应用</p> : null}
                </div>
            </section>

            <div className="store-toolbar">
                <div className="store-search-hint"><Search size={15}/> 按分类筛选应用</div>
                <div className="store-category-filter" role="tablist" aria-label="应用类型筛选">
                    {categories.map(category => (
                        <button
                            key={category.type === 'all' ? 'all' : category.label}
                            type="button"
                            className={activeType === (category.type === 'all' ? 'all' : category.label) ? 'active' : ''}
                            onClick={() => setActiveType(category.type === 'all' ? 'all' : category.label)}
                        >
                            <Filter size={13}/> {category.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="store-grid" aria-label="应用卡片网格">
                {loading && orderedApps.length === 0 ? <div className="store-empty">应用加载中...</div> : null}
                {!loading && visibleApps.length === 0 ? <div className="store-empty">暂无应用</div> : null}
                {visibleApps.map(app => (
                    <button key={app.id || app.slug} type="button"
                            className={`store-card status-${app.status || 'stopped'}`}
                            onClick={() => setSelectedAppId(app.id)}>
                        <div className="store-card-head">
                            <span className="store-card-icon"
                                  aria-hidden="true">{(appTitle(app).trim()[0] || '应').toUpperCase()}</span>
                            <span
                                className={`store-status ${app.status || 'stopped'}`}>{STATUS_TEXT[app.status] || app.status || '未知'}</span>
                        </div>
                        <strong>{appTitle(app)}</strong>
                        <p>{app.description || app.slug || '暂无描述'}</p>
                        <div className="store-card-meta">
                            <span
                                className={`store-tag store-type-${typeSlug(app.type)}`}>{formatApplicationType(app.type)}</span>
                            <span
                                className={`store-tag store-source-${isGeneratedApplication(app) ? 'generated' : 'preset'}`}>{sourceLabel(app)}</span>
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

function ApplicationDetailModal({app, action, onClose, onRefresh, onStart, onStop, onRebuild, onRegenerate, onDelete}) {
    const status = app.status || 'stopped'
    const url = appUrl(app)
    const busy = Boolean(action)
    const generated = isGeneratedApplication(app)
    const features = extractApplicationFeatures(app)
    return (
        <div className="store-detail-backdrop" role="presentation" onClick={onClose}>
            <article className="store-detail" role="dialog" aria-modal="true" aria-label={`${appTitle(app)}详情`}
                     onClick={event => event.stopPropagation()}>
                <header className="store-detail-header">
                    <div className="store-detail-identity">
            <span className="store-detail-avatar" aria-hidden="true">
              {(appTitle(app).trim()[0] || '应').toUpperCase()}
            </span>
                        <div>
                            <span className="store-kicker">应用详情</span>
                            <h3>{appTitle(app)}</h3>
                            <div className="store-detail-badges" aria-label="应用标签">
                                <span
                                    className={`store-tag store-type-${typeSlug(app.type)}`}>{formatApplicationType(app.type)}</span>
                                <span className={`store-status ${status}`}>{STATUS_TEXT[status] || status}</span>
                                <span className="store-tag store-tag-neutral">{formatVersion(app)}</span>
                            </div>
                        </div>
                    </div>
                    <button type="button" className="store-detail-close" onClick={onClose} aria-label="关闭详情"><X
                        size={18}/></button>
                </header>

                <div className="store-detail-body">
                    <div className="store-detail-main">
                        <section className="store-detail-section">
                            <h4>应用简介</h4>
                            <p className="store-detail-desc">{app.description || app.slug || '暂无描述'}</p>
                        </section>

                        <section className="store-detail-section">
                            <h4>功能特性</h4>
                            <ul className="store-feature-list">
                                {features.map(feature => <li key={feature}>{feature}</li>)}
                            </ul>
                        </section>

                        <section className="store-detail-section">
                            <h4>应用信息</h4>
                            <div className="store-detail-grid">
                                <span>上架日期</span><b>{formatCreatedAt(app)}</b>
                                <span>版本号</span><b>{formatVersion(app)}</b>
                                <span>软件厂商</span><b>{vendorLabel(app)}</b>
                                <span>状态</span><b>{STATUS_TEXT[status] || status}</b>
                                <span>类型</span><b>{formatApplicationType(app.type)}</b>
                                <span>来源</span><b>{sourceLabel(app)}</b>
                            </div>
                        </section>
                    </div>

                    <aside className="store-detail-preview-panel" aria-label="应用首页预览">
                        <section className="store-detail-section store-detail-preview-section">
                            <div className="store-detail-preview-title">
                                <h4>首页预览</h4>
                                {url ? <button type="button" onClick={() => window.open(url, '_blank', 'noopener')}>
                                    <ExternalLink size={14}/> 打开首页</button> : null}
                            </div>
                            {url ? (
                                <div className="store-detail-preview-frame">
                                    <iframe
                                        title={`${appTitle(app)}首页预览`}
                                        src={url}
                                        loading="lazy"
                                        sandbox="allow-scripts allow-forms allow-popups"
                                        referrerPolicy="no-referrer"
                                    />
                                </div>
                            ) : (
                                <div className="store-detail-preview-empty">暂无可预览首页</div>
                            )}
                        </section>
                    </aside>
                </div>
                <div className="store-detail-actions">
                    {url ? <button type="button" onClick={() => window.open(url, '_blank', 'noopener')} disabled={busy}>
                        <ExternalLink size={15}/> 打开</button> : null}
                    {status !== 'running' ? <button type="button" onClick={() => onStart && onStart(app.id)}
                                                    disabled={busy}>{action === 'start' ?
                        <Loader2 size={15} className="spin"/> :
                        <Play size={15}/>} {action === 'start' ? ACTION_TEXT[action] : '启动'}</button> : null}
                    {status === 'running' ? <button type="button" onClick={() => onStop && onStop(app.id)}
                                                    disabled={busy}>{action === 'stop' ?
                        <Loader2 size={15} className="spin"/> :
                        <Square size={15}/>} {action === 'stop' ? ACTION_TEXT[action] : '停止'}</button> : null}
                    <button type="button" onClick={() => onRebuild && onRebuild(app.id)}
                            disabled={busy}>{action === 'rebuild' ? <Loader2 size={15} className="spin"/> :
                        <RotateCcw size={15}/>} {action === 'rebuild' ? ACTION_TEXT[action] : '重建镜像'}</button>
                    <button type="button" onClick={onRefresh} disabled={busy}><RefreshCw size={15}/> 刷新状态</button>
                    {generated ? <button type="button" onClick={() => onRegenerate && onRegenerate(app)}
                                         disabled={busy}>{action === 'regenerate' ?
                        <Loader2 size={15} className="spin"/> : <Sparkles
                            size={15}/>} {action === 'regenerate' ? ACTION_TEXT[action] : '重新生成'}</button> : null}
                    {generated ? <button type="button" className="danger" onClick={() => {
                        if (window.confirm(`确认删除生成应用「${appTitle(app)}」？本地生成目录会被删除，生成审计记录会保留。`)) onDelete && onDelete(app.id)
                    }} disabled={busy}>{action === 'delete' ? <Loader2 size={15} className="spin"/> :
                        <Trash2 size={15}/>} {action === 'delete' ? ACTION_TEXT[action] : '删除'}</button> : null}
                </div>
            </article>
        </div>
    )
}
