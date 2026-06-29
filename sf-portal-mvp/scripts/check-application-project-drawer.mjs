import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const clientJs = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const drawerJsx = readFileSync(new URL('../src/components/WorkbenchDrawer.jsx', import.meta.url), 'utf8')
const panelJsx = readFileSync(new URL('../src/components/ApplicationProjectPanel.jsx', import.meta.url), 'utf8')
const panelCss = readFileSync(new URL('../src/components/ApplicationProjectPanel.css', import.meta.url), 'utf8')
const backendProjectHandlers = readFileSync(new URL('../../factory-server/internal/server/app_project_handlers.go', import.meta.url), 'utf8')

assert.match(appJsx, /applicationProjectId/, 'App must derive an applicationProjectId for the 应用项目 drawer')
assert.match(appJsx, /resolvedApplication[\s\S]*\.id/, 'applicationProjectId must prefer resolvedApplication.id')
assert.match(appJsx, /seededJob[\s\S]*application_id[\s\S]*created_app_id/, 'applicationProjectId must fall back to seededJob application ids')
assert.match(appJsx, /hasBoundApplication\s*=\s*!!applicationProjectId/, 'hasBoundApplication must require a concrete project application id, not only a seeded job')
assert.doesNotMatch(appJsx, /hasBoundApplication\s*=\s*!!\(view && \(view\.resolvedApplication \|\| view\.seededJob\)\)/, 'hasBoundApplication must not enable the drawer for seeded jobs without app ids')
assert.match(appJsx, /applicationProps=\{\{[\s\S]*applicationId: applicationProjectId/, 'App must pass applicationProps into WorkbenchDrawer')

assert.match(clientJs, /getApplicationProjectTree/, 'factoryApi must expose getApplicationProjectTree')
assert.match(clientJs, /getApplicationProjectFile/, 'factoryApi must expose getApplicationProjectFile')
assert.match(clientJs, /encodeURIComponent\(path\)/, 'project-file preview path must be query-encoded')

assert.match(drawerJsx, /ApplicationProjectPanel/, 'WorkbenchDrawer must import/render ApplicationProjectPanel')
assert.doesNotMatch(drawerJsx, /activeEntry === 'application' \? <ApplicationProjectPlaceholder/, 'application drawer must not render the old placeholder directly')

for (const token of ['loadingTree', 'treeError', 'app-project-empty', 'app-project-tree', 'app-project-preview']) {
  assert.match(panelJsx, new RegExp(token), `ApplicationProjectPanel must include ${token} state/markup`)
}
assert.match(panelJsx, /MarkdownPreview/, 'ApplicationProjectPanel must support Markdown preview')
assert.match(backendProjectHandlers, /project-docs\.json/, 'project tree backend must surface .factory/project-docs.json in factory metadata')
assert.match(panelJsx, /'源码'/, 'Markdown preview must expose source mode')
assert.match(panelJsx, /'格式化'/, 'JSON preview must expose formatted mode')
assert.match(panelJsx, /'原始'/, 'JSON preview must expose raw mode')
assert.doesNotMatch(panelJsx, /dangerouslySetInnerHTML/, 'Markdown preview must not use dangerouslySetInnerHTML')

for (const cls of ['application-project-panel', 'app-project-groups', 'app-project-tree-node', 'app-project-preview', 'app-project-preview-tabs', 'app-project-metadata']) {
  assert.match(panelCss, new RegExp(`\\.${cls}`), `ApplicationProjectPanel.css must style .${cls}`)
}

console.log('check-application-project-drawer: OK')
