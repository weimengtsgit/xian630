import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const source = readFileSync(new URL('../src/components/ApplicationStorePage.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/ApplicationStorePage.css', import.meta.url), 'utf8')
const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const toolbarJsx = readFileSync(new URL('../src/components/LeftToolbar.jsx', import.meta.url), 'utf8')
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')

const server = await createServer({
  configFile: new URL('../vite.config.js', import.meta.url).pathname,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})

const {
  filterStoreApplications,
  formatApplicationType,
  orderApplicationsForStore,
} = await server.ssrLoadModule('/src/components/ApplicationStorePage.jsx')

try {

assert.equal(formatApplicationType('command_dashboard'), '指挥看板')
assert.equal(formatApplicationType('command-dashboard'), '指挥看板')
assert.equal(formatApplicationType('situation_replay'), '态势复盘')
assert.equal(formatApplicationType('timeline-replay'), '态势复盘')
assert.equal(formatApplicationType('operations_management'), '业务管理')
assert.equal(formatApplicationType('map-dashboard'), '地图态势')
assert.equal(formatApplicationType('affiliation-inference-dashboard'), '归属研判')

const mixed = [
  { id: 'preset-2', slug: 'preset-2', name: 'B 预置', source: 'preset', type: 'map-dashboard', display_order: 2 },
  { id: 'managed', slug: 'managed', name: '纳管', source: 'preset', type: 'managed_agent', display_order: 1 },
  { id: 'generated-old', slug: 'generated-old', name: '旧生成', source: 'generated', type: 'command_dashboard', created_at: '2026-06-01T00:00:00Z' },
  { id: 'preset-1', slug: 'preset-1', name: 'A 预置', source: 'preset', type: 'timeline-replay', display_order: 1 },
  { id: 'generated-new', slug: 'generated-new', name: '新生成', source: 'generated-apps', type: 'operations_management', created_at: '2026-06-03T00:00:00Z' },
]

assert.deepEqual(filterStoreApplications(mixed).map(app => app.id), ['preset-2', 'generated-old', 'preset-1', 'generated-new'])
assert.deepEqual(orderApplicationsForStore(mixed).map(app => app.id), ['generated-new', 'generated-old', 'preset-1', 'preset-2'])

assert.match(source, /应用商店/, 'page must render 应用商店 copy')
assert.match(source, /新品推荐/, 'page must render recommendation strip')
assert.match(source, /category-filter|store-category/, 'page must render category filters')
assert.match(source, /confirm\(`确认删除生成应用/, 'delete confirmation must use generated-application wording')
assert.doesNotMatch(source, /window\.open\([^)]*agent-market\.html/, 'must not open a static agent-market page')
assert.doesNotMatch(source, /iframe/i, 'must not use iframe')
assert.match(css, /application-store-page/, 'page CSS must scope styles under application-store-page')
assert.match(css, /\.application-store-page\s*\{[\s\S]*position:\s*absolute/, 'application store page must be positioned below the global chrome')
assert.match(css, /\.application-store-page\s*\{[\s\S]*left:\s*56px/, 'application store page must clear the left toolbar')
assert.match(css, /\.application-store-page\s*\{[\s\S]*top:\s*36px/, 'application store page must clear the top bar')
assert.match(css, /store-grid/, 'page CSS must include app card grid styling')
assert.match(css, /store-detail/, 'page CSS must include detail modal styling')
assert.match(source, /onRegenerate\?\.\(app\)[\s\S]*setSelectedAppId\(null\)|setSelectedAppId\(null\)[\s\S]*onRegenerate\?\.\(app\)/, 'regenerate from store must close the detail modal')

  // Task 2 assertions
  assert.match(appJsx, /currentPage/, 'App must keep currentPage state')
  assert.match(appJsx, /'workbench'/, 'App must support workbench page key')
  assert.match(appJsx, /'appStore'/, 'App must support appStore page key')
  assert.match(appJsx, /<ApplicationStorePage/, 'App must render ApplicationStorePage')
  assert.match(appJsx, /setCurrentPage\('workbench'\)[\s\S]*regenerateApplication\(app\)|regenerateApplication\(app\)[\s\S]*setCurrentPage\('workbench'\)/, 'regenerating from the app store must navigate back to the workbench')
  assert.match(appJsx, /currentPage === 'workbench'/, 'App must conditionally render workbench')
  assert.match(appJsx, /currentPage === 'appStore'/, 'App must conditionally render app store')
  assert.match(appJsx, /<LeftToolbar[\s\S]*activePage=\{currentPage\}/, 'LeftToolbar must receive activePage')
  assert.match(appJsx, /onNavigate=\{setCurrentPage\}/, 'LeftToolbar must navigate via setCurrentPage')
  assert.match(toolbarJsx, /activePage/, 'LeftToolbar must accept activePage')
  assert.match(toolbarJsx, /onNavigate/, 'LeftToolbar must accept onNavigate')
  assert.match(toolbarJsx, /应用商店/, 'LeftToolbar must render 应用商店')
  assert.match(toolbarJsx, /is-active/, 'LeftToolbar must style active page')
  assert.match(workbenchJsx, /onOpenApplicationStore/, 'ConversationWorkbench must accept app store navigation callback')
  assert.match(workbenchJsx, /应用商店/, 'ConversationWorkbench must render secondary 应用商店 button')
  assert.doesNotMatch(workbenchJsx, /onToggleDrawerEntry\('appStore'\)/, '应用商店 button must not be a drawer entry')

  console.log('check-application-store-page: OK')
} finally {
  await server.close()
}
