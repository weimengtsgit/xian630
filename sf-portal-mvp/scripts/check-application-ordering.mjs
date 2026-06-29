// Verifies the portal application ordering is driven by created_at descending
// so the newest created application appears first. Slug is a tie-breaker only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { orderApplicationsForDisplay } from '../src/hooks/applicationOrdering.js'

const appsPanel = readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const appsPanelCss = readFileSync(new URL('../src/components/ApplicationsPanel.css', import.meta.url), 'utf8')
assert.match(appsPanel, /创建时间/, 'application cards must render a 创建时间 label')
assert.match(appsPanel, /formatCreatedAt/, 'application cards must format created_at')
assert.match(appsPanel, /formatAppType/, 'application cards must format app type labels')
assert.match(appsPanel, /command_dashboard:\s*'指挥仪表盘'/, 'command_dashboard must display as 指挥仪表盘')
assert.match(appsPanel, /situation_replay:\s*'态势复盘'/, 'situation_replay must display as 态势复盘')
assert.match(appsPanel, /operations_management:\s*'运营管理'/, 'operations_management must display as 运营管理')
assert.match(appsPanel, /'command-dashboard':\s*'指挥仪表盘'/, 'command-dashboard must display as 指挥仪表盘')
assert.match(appsPanel, /'affiliation-inference-dashboard':\s*'归属推断仪表盘'/, 'affiliation-inference-dashboard must display as 归属推断仪表盘')
assert.doesNotMatch(appsPanel, /<span className="meta-label">来源<\/span>/, 'application cards must hide the 来源 field')
assert.match(appsPanelCss, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, 'application action buttons should render as a 2-column grid')
assert.match(appsPanel, /app-sub-tooltip/, 'application detail text must include a hover tooltip for full details')
assert.match(appsPanelCss, /\.app-sub:hover \.app-sub-tooltip/, 'application detail tooltip must appear on hover')
assert.match(appsPanelCss, /\.app-card\s*\{[^}]*overflow:\s*visible/s, 'card must not clip the hover detail tooltip')

const apps = [
  { slug: 'old-preset', name: '旧预置应用', source: 'preset', display_order: 1, created_at: '2026-06-01T00:00:00Z' },
  { slug: 'new-generated', name: '新生成应用', source: 'generated', updated_at: '2026-06-20T00:00:00Z', created_at: '2026-06-23T00:00:00Z' },
  { slug: 'newer-preset', name: '新预置应用', source: 'preset', display_order: 2, created_at: '2026-06-24T00:00:00Z' },
  { slug: 'old-generated', name: '旧生成应用', source: 'generated', updated_at: '2026-06-25T00:00:00Z', created_at: '2026-06-02T00:00:00Z' },
]

const ordered = orderApplicationsForDisplay(apps)

assert.deepEqual(
  ordered.map(app => app.slug),
  [
    'newer-preset',   // newest created_at
    'new-generated',  // next newest created_at, despite older updated_at
    'old-generated',  // newer updated_at must not outrank created_at
    'old-preset',
  ],
)

assert.notEqual(ordered, apps)

// Tie-breaker: equal created_at resolves by slug only.
const tied = orderApplicationsForDisplay([
  { slug: 'zebra', source: 'preset', created_at: '2026-06-01T00:00:00Z' },
  { slug: 'alpha', source: 'generated', created_at: '2026-06-01T00:00:00Z' },
])
assert.deepEqual(
  tied.map(app => app.slug),
  ['alpha', 'zebra'],
)

console.log('application ordering check passed')
