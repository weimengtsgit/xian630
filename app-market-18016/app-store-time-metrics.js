(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.AppStoreTimeMetrics = factory()
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const APP_TIME_METRICS = {
    'app-seasats': { name: '“光渔”无人艇跟监告警智能体', vendor: '电子云', version: 'v1.8.15', timeKind: 'iteration', durationSeconds: 1775 },
    'app-001': { name: '美航母AIS异常监测', vendor: '电子云', version: 'v1.9.0', timeKind: 'iteration', durationSeconds: 1366 },
    'app-002': { name: '舰载机归属判断', vendor: '中电科十五所', version: 'v1.8.0', timeKind: 'iteration', durationSeconds: 1542 },
    'app-003': { name: '华盛顿号航母打击群西太地区活动规律分析智能体', vendor: '电信十所', version: 'v1.2.0', timeKind: 'iteration', durationSeconds: 1598 },
    'app-004': { name: '航母甲板风条件评估看板', vendor: '电子云', version: 'v1.0.0', durationSeconds: 2004 },
    'app-005': { name: '航母态势指挥仪表盘', vendor: '电子云', version: 'v1.1.0', timeKind: 'iteration', durationSeconds: 1196 },
    'app-006': { name: '航母打击群活动规律分析', vendor: '电子云', version: 'v1.0.3', timeKind: 'iteration', durationSeconds: 1467 },
    'app-007': { name: '航母母港潮汐出港窗口计算器', vendor: '电子云', version: 'v1.0.0', durationSeconds: 2110 },
    'app-008': { name: '海域网格商船密度异常告警器', vendor: '电子云', version: 'v1.0.0', durationSeconds: 2548 },
    'app-009': { name: '航母及舰载机时空伴随关系分析智能体', vendor: '电信十所', version: 'v1.0.0', durationSeconds: 2945 },
    'app-010': { name: '航母舰载机挖掘分析', vendor: '领铄', version: 'v1.0.0', durationSeconds: 2736 },
  }

  function parseVersion(version) {
    const match = String(version || '').match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i)
    if (!match) return [0, 0, 0]
    return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)]
  }

  function classifyVersion(version) {
    const parts = parseVersion(version)
    const baseline = [1, 0, 0]
    for (let index = 0; index < baseline.length; index += 1) {
      if (parts[index] > baseline[index]) return 'iteration'
      if (parts[index] < baseline[index]) return 'generation'
    }
    return 'generation'
  }

  function formatDuration(seconds) {
    const rounded = Math.max(0, Math.round(Number(seconds) || 0))
    const minutes = Math.floor(rounded / 60)
    const rest = String(rounded % 60).padStart(2, '0')
    return `${minutes}分${rest}秒`
  }

  function classifyMetric(metric) {
    return metric?.timeKind || classifyVersion(metric?.version)
  }

  function timeLabel(metric) {
    return classifyMetric(metric) === 'iteration' ? '迭代时间' : '生成时间'
  }

  function average(items) {
    if (!items.length) return 0
    return Math.round(items.reduce((sum, item) => sum + item.durationSeconds, 0) / items.length)
  }

  function getAverageMetrics(items) {
    const list = Array.isArray(items) ? items : Object.entries(APP_TIME_METRICS).map(([id, metric]) => ({ id, ...metric }))
    const generation = list.filter(item => classifyMetric(item) === 'generation')
    const iteration = list.filter(item => classifyMetric(item) === 'iteration')
    return {
      generationSeconds: average(generation),
      iterationSeconds: average(iteration),
      overallSeconds: average(list),
      generationLabel: formatDuration(average(generation)),
      iterationLabel: formatDuration(average(iteration)),
      overallLabel: formatDuration(average(list)),
    }
  }

  function findMetricByName(name) {
    return Object.entries(APP_TIME_METRICS).find(([, metric]) => metric.name === name)?.[1] || null
  }

  function ensureTextMetric(container, className, metric) {
    if (!container || !metric) return
    let node = container.querySelector(`.${className}`)
    if (!node) {
      node = document.createElement('span')
      node.className = className
      container.appendChild(node)
    }
    const label = `${timeLabel(metric)} ${formatDuration(metric.durationSeconds)}`
    if (node.textContent !== label) {
      node.textContent = label
    }
  }

  function renderSummaryCard() {
    document.querySelectorAll('[data-time-summary]').forEach(node => node.remove())
    const header = document.querySelector('.app-header')
    if (!header || document.querySelector('[data-time-card]')) return
    const averages = getAverageMetrics()
    const summaries = [
      ['生成平均时间', averages.generationLabel],
      ['迭代平均时间', averages.iterationLabel],
      ['综合平均时间', averages.overallLabel],
    ]
    const card = document.createElement('section')
    card.className = 'app-time-card'
    card.dataset.timeCard = 'true'
    card.innerHTML = `
      <div class="app-time-card__title">平均时间统计</div>
      <div class="app-time-card__grid">
        ${summaries.map(([label, value]) => `
          <div class="app-time-card__item">
            <span class="app-time-card__label">${label}</span>
            <strong class="app-time-card__value">${value}</strong>
          </div>
        `).join('')}
      </div>
    `
    header.appendChild(card)
  }

  function renderCards() {
    document.querySelectorAll('.app-card').forEach(card => {
      const name = card.querySelector('.app-card__name')?.textContent?.trim()
      const metric = findMetricByName(name)
      ensureTextMetric(card.querySelector('.app-card__meta'), 'app-card__time', metric)
    })
    document.querySelectorAll('.new-rec-card').forEach(card => {
      const name = card.querySelector('.new-rec-card__name')?.textContent?.trim()
      const metric = findMetricByName(name)
      ensureTextMetric(card.querySelector('.new-rec-card__meta'), 'new-rec-card__time', metric)
    })
  }

  function renderDetail() {
    const detail = document.querySelector('.app-detail')
    if (!detail) return
    const name = detail.querySelector('.app-detail__name')?.textContent?.trim()
    const metric = findMetricByName(name)
    const grid = detail.querySelector('.app-detail__info-grid')
    if (!grid || !metric || grid.querySelector('[data-time-metric-detail]')) return
    const item = document.createElement('div')
    item.className = 'app-detail__info-item'
    item.dataset.timeMetricDetail = 'true'
    item.innerHTML = `<span class="app-detail__info-label">${timeLabel(metric)}</span><span class="app-detail__info-value app-detail__time">${formatDuration(metric.durationSeconds)}</span>`
    grid.appendChild(item)
  }

  function renderAll() {
    renderSummaryCard()
    renderCards()
    renderDetail()
  }

  function boot() {
    renderAll()
    const observer = new MutationObserver(renderAll)
    observer.observe(document.body, { childList: true, subtree: true })
    window.setInterval(renderAll, 1000)
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true })
    } else {
      boot()
    }
  }

  return {
    APP_TIME_METRICS,
    classifyVersion,
    formatDuration,
    getAverageMetrics,
  }
})
