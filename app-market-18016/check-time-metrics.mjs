import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const scriptPath = new URL('./app-store-time-metrics.js', import.meta.url)
const scriptSource = readFileSync(scriptPath, 'utf8')
const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const previewHtml = readFileSync(new URL('./preview/index.html', import.meta.url), 'utf8')
const overrideCss = readFileSync(new URL('./app-store-overrides.css', import.meta.url), 'utf8')

for (const html of [indexHtml, previewHtml]) {
  if (!html.includes('/assets/app-store-time-metrics.js?v=')) {
    throw new Error('index.html must load app-store-time-metrics.js from /assets')
  }
}

if (!existsSync(scriptPath)) {
  throw new Error('app-store-time-metrics.js is missing')
}

if (!scriptSource.includes('node.textContent !== label')) {
  throw new Error('time metric renderer must not rewrite identical text and retrigger MutationObserver')
}
if (!scriptSource.includes('app-time-card') || !scriptSource.includes('renderSummaryCard')) {
  throw new Error('time averages must render in a standalone app-time-card')
}
if (scriptSource.includes('app-time-summary')) {
  throw new Error('time averages must not render in the top status bar')
}
if (!scriptSource.includes('header.appendChild(card)')) {
  throw new Error('time averages card must be placed inside the app header on the title right side')
}
if (!overrideCss.includes('.status-bar__center') || !overrideCss.includes('display: none')) {
  throw new Error('top status metrics must be hidden')
}
if (!overrideCss.includes('grid-template-columns: minmax(320px, auto) minmax(560px, 1fr)')) {
  throw new Error('app header must reserve a right-side column for the time card')
}
for (const requiredCss of [
  '.app-card',
  'min-height: 212px',
  'overflow: hidden',
  '.app-card__name',
  '-webkit-line-clamp: 2',
  'word-break: break-word',
  '.app-card__footer',
  'min-height: 62px',
  '.app-card__meta',
  'text-overflow: ellipsis',
  '.app-card__time',
]) {
  if (!overrideCss.includes(requiredCss)) {
    throw new Error(`card overflow layout css missing: ${requiredCss}`)
  }
}
if (scriptSource.includes('航母、舰载机时空伴随关系分析智能体')) {
  throw new Error('old app name with comma must be removed from time metrics')
}
if (!scriptSource.includes('航母及舰载机时空伴随关系分析智能体')) {
  throw new Error('new app name must be present in time metrics')
}

const {
  APP_TIME_METRICS,
  classifyVersion,
  formatDuration,
  getAverageMetrics,
} = require(fileURLToPath(scriptPath))

const metricEntries = Object.entries(APP_TIME_METRICS || {})
if (metricEntries.length !== 10) {
  throw new Error(`expected 10 app time metric entries, got ${metricEntries.length}`)
}

if (classifyVersion('v1.0.0') !== 'generation') {
  throw new Error('v1.0.0 must be classified as generation time')
}
if (classifyVersion('v1.0.3') !== 'iteration' || classifyVersion('v1.8.0') !== 'iteration') {
  throw new Error('versions above v1.0.0 must be classified as iteration time')
}

const lingshu = APP_TIME_METRICS['app-010']
if (!lingshu || lingshu.vendor !== '领铄' || lingshu.durationSeconds !== 2736) {
  throw new Error('领铄 app must be fixed at 45分36秒')
}

const iterationVersions = new Map([
  ['app-001', 'v1.9.0'],
  ['app-002', 'v1.8.0'],
  ['app-003', 'v1.2.0'],
  ['app-005', 'v1.1.0'],
  ['app-006', 'v1.0.3'],
])
const generationDurations = {
  'app-004': 2004,
  'app-007': 2110,
  'app-008': 2548,
  'app-009': 2945,
  'app-010': 2736,
}

for (const [id, metric] of metricEntries) {
  const expectedVersion = iterationVersions.get(id) || 'v1.0.0'
  if (metric.version !== expectedVersion) {
    throw new Error(`${id} metric version must be ${expectedVersion}, got ${metric.version}`)
  }
  if (iterationVersions.has(id)) {
    if (metric.timeKind !== 'iteration') {
      throw new Error(`${id} must keep iteration time kind`)
    }
    if (metric.durationSeconds < 1140 || metric.durationSeconds > 1620) {
      throw new Error(`${id} iteration duration must be between 19 and 27 minutes`)
    }
  } else if (generationDurations[id] !== metric.durationSeconds) {
    if (metric.timeKind === 'iteration') {
      throw new Error(`${id} must not be marked as iteration`)
    }
    throw new Error(`${id} generation duration must remain ${generationDurations[id]} seconds`)
  }
  const formatted = formatDuration(metric.durationSeconds)
  if (!/^\d+分\d{2}秒$/.test(formatted)) {
    throw new Error(`${id} formatted duration must be minute-second precise, got ${formatted}`)
  }
}

const averages = getAverageMetrics(metricEntries.map(([id, metric]) => ({ id, ...metric })))
if (averages.generationLabel !== '41分09秒') {
  throw new Error(`generation average should be 41分09秒, got ${averages.generationLabel}`)
}
if (averages.iterationLabel !== '23分54秒') {
  throw new Error(`iteration average should be 23分54秒, got ${averages.iterationLabel}`)
}
if (averages.overallLabel !== '32分31秒') {
  throw new Error(`overall average should be 32分31秒, got ${averages.overallLabel}`)
}

console.log('time metrics checks passed')
