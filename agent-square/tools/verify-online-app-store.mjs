const baseUrl = 'http://220.154.5.91:18016/'

const expectedTail = [
  '航母母港潮汐出港窗口计算器',
  '海域网格商船密度异常告警器',
  '航母及舰载机时空伴随关系分析智能体',
  '航母舰载机挖掘分析',
]

const response = await fetch(baseUrl)
if (!response.ok) throw new Error(`GET ${baseUrl} failed: ${response.status}`)
const html = await response.text()
const asset = html.match(/src="([^"]*index-DmVUBMo0\.js(?:\?[^"]*)?)"/)?.[1]
if (!asset) throw new Error('online index.html does not reference index-DmVUBMo0.js')
const overrideCss = html.match(/href="([^"]*app-store-overrides\.css(?:\?[^"]*)?)"/)?.[1]
if (!overrideCss) throw new Error('online index.html does not reference app-store-overrides.css')
const timeMetrics = html.match(/src="([^"]*app-store-time-metrics\.js(?:\?[^"]*)?)"/)?.[1]
if (!timeMetrics) throw new Error('online index.html does not reference app-store-time-metrics.js')
if (!html.includes('app-store-overrides.css?v=20260628-1301')) {
  throw new Error('online index.html does not reference latest app-store-overrides.css version')
}
if (!html.includes('index-DmVUBMo0.js?v=20260628-1452')) {
  throw new Error('online index.html does not reference latest index bundle version')
}
if (!html.includes('app-store-time-metrics.js?v=20260628-1452')) {
  throw new Error('online index.html does not reference latest app-store-time-metrics.js version')
}

const assetUrl = new URL(asset, baseUrl).href
const assetResponse = await fetch(assetUrl)
if (!assetResponse.ok) throw new Error(`GET ${assetUrl} failed: ${assetResponse.status}`)
const source = await assetResponse.text()
const cssUrl = new URL(overrideCss, baseUrl).href
const cssResponse = await fetch(cssUrl)
if (!cssResponse.ok) throw new Error(`GET ${cssUrl} failed: ${cssResponse.status}`)
const css = await cssResponse.text()
const timeMetricsUrl = new URL(timeMetrics, baseUrl).href
const timeMetricsResponse = await fetch(timeMetricsUrl)
if (!timeMetricsResponse.ok) throw new Error(`GET ${timeMetricsUrl} failed: ${timeMetricsResponse.status}`)
const timeMetricsSource = await timeMetricsResponse.text()

const apps = [...source.matchAll(/\{id:"app-\d{3}",name:"([^"]+)"[\s\S]*?(?=\},\{id:"app-\d{3}"|\}\],Wf=)/g)].map(match => match[0])
const names = apps.map(app => app.match(/name:"([^"]+)"/)?.[1])
const appIds = apps.map(app => app.match(/\{id:"(app-\d{3})"/)?.[1])
const onlineIterationVersions = new Map([
  ['app-001', 'v1.9.0'],
  ['app-002', 'v1.8.0'],
  ['app-003', 'v1.2.0'],
  ['app-005', 'v1.1.0'],
  ['app-006', 'v1.0.3'],
])

if (apps.length !== 10) throw new Error(`online bundle should contain 10 built-in apps, found ${apps.length}`)
if (appIds.indexOf('app-002') === -1 || appIds.indexOf('app-003') === -1) {
  throw new Error('online bundle missing app-002/app-003 for all-app ordering')
}
if (appIds.indexOf('app-002') > appIds.indexOf('app-003')) {
  throw new Error('online all-app ordering should place 舰载机归属判断 before 华盛顿号航母打击群西太地区活动规律分析智能体')
}
if (!source.includes('newRecPriority')) {
  throw new Error('online bundle missing dedicated new recommendation ordering')
}
const newRecSnippet = source.slice(source.indexOf('newRecPriority'), source.indexOf('newRecPriority') + 220)
if (!/"[^"]+":0,"[^"]+":1,"[^"]+":2/.test(newRecSnippet)) {
  throw new Error('online new recommendation priority should contain three ordered priority entries')
}
if (newRecSnippet.indexOf(':0') > newRecSnippet.indexOf(':1') || newRecSnippet.indexOf(':1') > newRecSnippet.indexOf(':2')) {
  throw new Error('online new recommendation priority order is invalid')
}
if (JSON.stringify(names.slice(-4)) !== JSON.stringify(expectedTail)) {
  throw new Error(`online last four apps mismatch: ${names.slice(-4).join(' / ')}`)
}
for (const app of apps) {
  const name = app.match(/name:"([^"]+)"/)?.[1] || 'unknown app'
  const version = app.match(/version:"([^"]+)"/)?.[1]
  const id = app.match(/\{id:"(app-\d{3})"/)?.[1]
  const expectedVersion = onlineIterationVersions.get(id) || 'v1.0.0'
  if (version !== expectedVersion) {
    throw new Error(`online ${name} version must be ${expectedVersion}, got ${version || 'missing'}`)
  }
  const publishDate = app.match(/publishDate:"([^"]+)"/)?.[1]
  if (!publishDate || publishDate <= '2026-05-20') {
    throw new Error(`online ${name} publishDate must be after 2026-05-20, got ${publishDate || 'missing'}`)
  }
}
if (source.includes('中电十所')) throw new Error('online bundle still contains 中电十所')
if (source.includes('中电十五所')) throw new Error('online bundle still contains 中电十五所')
if (!source.includes('vendor:"电信十所"')) throw new Error('online bundle missing 电信十所')
if (!source.includes('vendor:"中电科十五所"')) throw new Error('online bundle missing 中电科十五所')
if (!source.includes('name:"舰载机归属判断"') || !source.includes('link:"http://220.154.5.91:18001/"')) {
  throw new Error('online 舰载机归属判断 link is not 18001')
}
if (source.includes('link:"http://220.154.5.91:18008/"')) {
  throw new Error('online bundle still contains old 18008 app link')
}
if (source.includes('航母级舰载机时空伴随关系分析智能体') || source.includes('航母、舰载机时空伴随关系分析智能体')) {
  throw new Error('online bundle still contains old app name')
}
const mining = apps.find(app => app.includes('name:"航母舰载机挖掘分析"'))
if (!mining?.includes('link:"http://220.154.5.91:18010/"')) {
  throw new Error('online 航母舰载机挖掘分析 link is not 18010')
}
if (!mining.includes('status:"新品"')) {
  throw new Error('online 航母舰载机挖掘分析 should be 新品')
}
if (!mining.includes('vendor:"领铄"')) {
  throw new Error('online 航母舰载机挖掘分析 vendor should be 领铄')
}

for (const requiredCss of [
  'min-height: 212px',
  'overflow: hidden',
  'display: none',
  '-webkit-line-clamp: 2',
]) {
  if (!css.includes(requiredCss)) {
    throw new Error(`online css missing ${requiredCss}`)
  }
}

for (const requiredTimeMetric of [
  'header.appendChild(card)',
  '平均时间统计',
  '航母及舰载机时空伴随关系分析智能体',
  'node.textContent !== label',
  'durationSeconds: 1366',
  'durationSeconds: 1542',
  'durationSeconds: 1598',
  'durationSeconds: 1196',
  'durationSeconds: 1467',
]) {
  if (!timeMetricsSource.includes(requiredTimeMetric)) {
    throw new Error(`online time metrics missing ${requiredTimeMetric}`)
  }
}
if (timeMetricsSource.includes('航母、舰载机时空伴随关系分析智能体')) {
  throw new Error('online time metrics still contains old app name')
}
for (const badVersion of source.match(/v(?:[3-9]|2\.(?!0\.0)[0-9]+\.[0-9]+|[0-9]{2,})[0-9.]*|v2\.(?!0\.0)[0-9]+\.[0-9]+/g) || []) {
  throw new Error(`online bundle contains version above v2.0.0: ${badVersion}`)
}
for (const badVersion of timeMetricsSource.match(/v(?:[3-9]|2\.(?!0\.0)[0-9]+\.[0-9]+|[0-9]{2,})[0-9.]*|v2\.(?!0\.0)[0-9]+\.[0-9]+/g) || []) {
  throw new Error(`online time metrics contains version above v2.0.0: ${badVersion}`)
}

for (const forbiddenCss of [
  '--app-page-scale',
  'zoom: var(--app-page-scale)',
  'width: calc(100% / var(--app-page-scale))',
]) {
  if (css.includes(forbiddenCss)) {
    throw new Error(`online css should not contain ${forbiddenCss}`)
  }
}

console.log('online app store checks passed')
