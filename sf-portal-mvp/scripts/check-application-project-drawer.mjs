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
assert.match(clientJs, /saveApplicationProjectDraft/, 'factoryApi must expose saveApplicationProjectDraft')
assert.match(clientJs, /discardApplicationProjectDraft/, 'factoryApi must expose discardApplicationProjectDraft')
assert.match(clientJs, /applyApplicationProjectDraft/, 'factoryApi must expose applyApplicationProjectDraft')
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
for (const copy of ['编辑草稿', '保存草稿', '应用为变更需求', '丢弃草稿']) {
  assert.match(panelJsx, new RegExp(copy), `ApplicationProjectPanel must include ${copy}`)
}
assert.match(panelJsx, /textarea/, 'ApplicationProjectPanel must use a textarea for Markdown draft editing')
assert.match(panelJsx, /preview\.draft\.status === 'draft'/, 'ApplicationProjectPanel must show apply only for draft status')
assert.match(panelJsx, /等待中心会话确认/, 'ApplicationProjectPanel must show proposed draft waiting-confirmation state')
assert.match(panelJsx, /源文档已更新，请丢弃草稿后重新编辑/, 'ApplicationProjectPanel must show stale draft guidance')
assert.match(panelJsx, /重新以当前源文档创建草稿/, 'ApplicationProjectPanel must offer stale draft restart from current source')
assert.match(panelJsx, /restartDraftFromCurrentSource/, 'ApplicationProjectPanel must implement restartDraftFromCurrentSource handler')
assert.match(panelJsx, /const startDraft = \(\) => \{\s+if \(!canEditDraft \|\| preview\.draft\?\.isStale\) return/, 'ApplicationProjectPanel must not continue editing a stale draft')
assert.match(panelJsx, /const saveDraft = async \(\) => \{\s+if \(!canEditDraft \|\| draftSaving \|\| preview\.draft\?\.isStale\) return/, 'ApplicationProjectPanel must not save a stale draft through the normal save path')
assert.doesNotMatch(panelJsx, /dangerouslySetInnerHTML/, 'Markdown preview must not use dangerouslySetInnerHTML')

// New assertions for stale diff rebase UI
assert.match(panelJsx, /app-project-diff/, 'ApplicationProjectPanel must include diff view for stale drafts')
assert.match(panelCss, /app-project-diff-line-added/, 'ApplicationProjectPanel must style added lines in diff')
assert.match(panelCss, /app-project-diff-line-removed/, 'ApplicationProjectPanel must style removed lines in diff')
assert.match(panelJsx, /以草稿内容继续/, 'ApplicationProjectPanel must offer continue with stale draft content action')
assert.match(panelJsx, /continueDraftFromStaleContent/, 'ApplicationProjectPanel must implement continueDraftFromStaleContent handler')
assert.match(panelJsx, /const staleDraftContent = preview\.draft\.content/, 'continueDraftFromStaleContent must capture stale draft content before discard')
assert.match(panelJsx, /factoryApi\.saveApplicationProjectDraft\(applicationId,\s*\{\s*dialogueId,\s*path:\s*preview\.path,\s*sourceChecksum:\s*preview\.checksum,\s*content:\s*preview\.content \|\| ''\s*\}\)/, 'restartDraftFromCurrentSource must save a new draft against the current checksum without first discarding')
assert.match(panelJsx, /factoryApi\.saveApplicationProjectDraft\(applicationId,\s*\{\s*dialogueId,\s*path:\s*preview\.path,\s*sourceChecksum:\s*preview\.checksum,\s*content:\s*staleDraftContent \|\| ''\s*\}\)/, 'continueDraftFromStaleContent must preserve stale content by saving it against the current checksum')
assert.doesNotMatch(panelJsx, /restartDraftFromCurrentSource[\s\S]*discardApplicationProjectDraft[\s\S]*continueDraftFromStaleContent/, 'stale rebase handlers must not discard before the replacement draft is saved')
assert.match(panelJsx, /preview\.draft && preview\.draft\.status === 'draft' && !preview\.draft\.isStale/, 'ApplicationProjectPanel must only show apply button for non-stale drafts')
assert.match(panelJsx, /MAX_DIFF_LINES/, 'stale diff must cap expensive LCS work for large documents')
assert.match(panelJsx, /app-project-diff-too-large/, 'stale diff must show a bounded fallback for large documents')

for (const cls of ['application-project-panel', 'app-project-groups', 'app-project-tree-node', 'app-project-preview', 'app-project-preview-tabs', 'app-project-metadata']) {
  assert.match(panelCss, new RegExp(`\\.${cls}`), `ApplicationProjectPanel.css must style .${cls}`)
}

console.log('check-application-project-drawer: OK')
