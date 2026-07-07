// Task 7 (workspace file maximize → unified preview modal) layout check.
//
// Before Task 7:
//   - The workspace file Preview (ApplicationProjectPanel) had NO maximize
//     affordance — files could only be inspected inside the drawer.
//   - Three divergent preview modals existed with different z-index/sizing:
//       AttachmentPreviewModal     .cw-preview-modal-layer (fixed, z1200, 720px)
//       ProjectDocumentPreviewModal .cw-doc-modal-layer   (absolute, z32, 760px)
//       InterfacePreviewModal       .cw-doc-modal-layer   (absolute, z32, 760px)
//     (glossary _Avoid_ 每类产物独立弹窗样式).
//   - No markdown/syntax-highlight dep existed; markdown was a hand-rolled
//     line-by-line stub (glossary _Avoid_ 纯文本预览).
//
// Task 7 introduces ONE shared modal shell (WorkbenchPreviewModal), routes the
// three existing modals + the new workspace maximize modal through it, and adds
// react-markdown + rehype-highlight so markdown renders rich and code is
// language-aware highlighted. This script pins that layout MEANINGFULLY:
//   1. A shared shell component exists and is the single source of the layer/
//      panel/header/close/body markup.
//   2. The maximize icon is present on the workspace Preview header.
//   3. All THREE existing modals + the new workspace maximize modal render via
//      the shared shell (no 4th divergent style).
//   4. The dead per-modal shell classes (.cw-preview-modal-layer / .cw-doc-modal)
//      are gone — only content classes remain.
//   5. The markdown + highlight deps are present AND actually used (imported in
//      the shared shell / wired into the rich renderer).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

const pkg = JSON.parse(read('../package.json'))
const shellJsx = read('../src/components/WorkbenchPreviewModal.jsx')
const shellCss = read('../src/components/WorkbenchPreviewModal.css')
const projectJsx = read('../src/components/ApplicationProjectPanel.jsx')
const projectCss = read('../src/components/ApplicationProjectPanel.css')
const attachJsx = read('../src/components/AttachmentPreviewModal.jsx')
const docJsx = read('../src/components/ProjectDocumentPreviewModal.jsx')
const ifaceJsx = read('../src/components/InterfacePreviewModal.jsx')
const cwCss = read('../src/components/ConversationWorkbench.css')

// 1. Shared shell component exists with the consolidated layer/panel/header/
//    close/body markup under ONE class namespace (.wpm-*).
assert.match(shellJsx, /export function WorkbenchPreviewModal/, 'WorkbenchPreviewModal shell must be exported')
assert.match(shellJsx, /className="wpm-layer"/, 'shell must render the .wpm-layer overlay')
assert.match(shellJsx, /className={`wpm-panel\$\{panelClassName/, 'shell must render the .wpm-panel (with optional panelClassName merge)')
assert.match(shellJsx, /className="wpm-head"/, 'shell must render the .wpm-head header row')
assert.match(shellJsx, /className="wpm-close"/, 'shell must render the .wpm-close button (title + X)')
assert.match(shellJsx, /className={`wpm-body\$\{bodyClassName/, 'shell must render the .wpm-body scrollable body (with optional bodyClassName merge)')

// 2. Consolidated sizing/z-index in ONE css file (no per-modal drift):
//    ~min(760px,92vw), max-height:86vh, centered, z-index above workbench.
assert.match(shellCss, /\.wpm-layer\s*\{[\s\S]*?position:\s*fixed/, '.wpm-layer must be a fixed overlay (centered in the page, above workbench content)')
assert.match(shellCss, /\.wpm-layer\s*\{[\s\S]*?z-index:\s*1200/, '.wpm-layer z-index must sit above workbench content (1200, the prior topmost modal value)')
assert.match(shellCss, /\.wpm-panel\s*\{[\s\S]*?width:\s*min\(760px,\s*92vw\)/, '.wpm-panel width must be the agreed ~min(760px,92vw)')
assert.match(shellCss, /\.wpm-panel\s*\{[\s\S]*?max-height:\s*86vh/, '.wpm-panel max-height must be 86vh (agreed value)')

// 3. Maximize icon is present on the workspace Preview header.
assert.match(projectJsx, /Maximize2/, 'ApplicationProjectPanel must import the Maximize2 icon')
assert.match(projectJsx, /className="app-project-preview-maximize"/, 'Preview header must render the .app-project-preview-maximize button')
assert.match(projectJsx, /onMaximize/, 'Preview must accept an onMaximize prop')
assert.match(projectJsx, /WorkspacePreviewMaximize/, 'ApplicationProjectPanel must define/render the WorkspacePreviewMaximize modal')
assert.match(projectCss, /\.app-project-preview-maximize\s*\{/, '.app-project-preview-maximize button must be styled')
// Read-only: the maximize modal must NOT render any textarea/edit affordance.
// Scope the scan to the WorkspacePreviewMaximize function body (up to the next
// top-level `function ` declaration) so the in-drawer draft textarea in a
// sibling function is not mistaken for an edit surface here.
const maximizeFn = projectJsx.match(/function WorkspacePreviewMaximize[\s\S]*?\nfunction /)
assert.ok(maximizeFn, 'WorkspacePreviewMaximize function must exist')
assert.doesNotMatch(maximizeFn[0], /textarea/, 'WorkspacePreviewMaximize must be read-only (no textarea / edit surface)')
assert.doesNotMatch(maximizeFn[0], /onClick=\{startDraft\}|onClick=\{saveDraft\}|app-project-draft-actions/, 'WorkspacePreviewMaximize must not host the draft/edit actions')

// 4. All THREE existing modals + the new workspace modal render via the shared
//    shell (no 4th divergent style). Each must import + use WorkbenchPreviewModal.
assert.match(attachJsx, /import \{ WorkbenchPreviewModal/, 'AttachmentPreviewModal must import the shared shell')
assert.match(attachJsx, /<WorkbenchPreviewModal/, 'AttachmentPreviewModal must render via <WorkbenchPreviewModal>')
assert.match(docJsx, /import \{ WorkbenchPreviewModal/, 'ProjectDocumentPreviewModal must import the shared shell')
assert.match(docJsx, /<WorkbenchPreviewModal/, 'ProjectDocumentPreviewModal must render via <WorkbenchPreviewModal>')
assert.match(ifaceJsx, /import \{ WorkbenchPreviewModal/, 'InterfacePreviewModal must import the shared shell')
assert.match(ifaceJsx, /<WorkbenchPreviewModal/, 'InterfacePreviewModal must render via <WorkbenchPreviewModal>')
assert.match(projectJsx, /import \{ WorkbenchPreviewModal/, 'ApplicationProjectPanel must import the shared shell (for the maximize modal)')
assert.match(projectJsx, /<WorkbenchPreviewModal/, 'ApplicationProjectPanel maximize modal must render via <WorkbenchPreviewModal>')

// 5. The dead per-modal SHELL classes are removed from ConversationWorkbench.css
//    (the divergent layer/panel/header markup is gone; only CONTENT classes
//    like .cw-preview-image / .cw-preview-text / .cw-preview-meta remain).
assert.doesNotMatch(cwCss, /\.cw-preview-modal-layer/, '.cw-preview-modal-layer shell class must be removed (replaced by .wpm-layer)')
assert.doesNotMatch(cwCss, /\.cw-preview-modal\s*\{/, '.cw-preview-modal shell class must be removed (replaced by .wpm-panel)')
assert.doesNotMatch(cwCss, /\.cw-doc-modal-layer/, '.cw-doc-modal-layer shell class must be removed (replaced by .wpm-layer)')
assert.doesNotMatch(cwCss, /\.cw-doc-modal\s*\{/, '.cw-doc-modal shell class must be removed (replaced by .wpm-panel)')
assert.doesNotMatch(cwCss, /\.cw-doc-modal header/, '.cw-doc-modal header shell rule must be removed (replaced by .wpm-head)')

// 6. Markdown + highlight deps are present AND used.
assert.ok(pkg.dependencies && pkg.dependencies['react-markdown'], 'react-markdown must be a dependency')
assert.ok(pkg.dependencies && pkg.dependencies['rehype-highlight'], 'rehype-highlight must be a dependency')
assert.match(shellJsx, /import ReactMarkdown from 'react-markdown'/, 'shared shell must import react-markdown')
assert.match(shellJsx, /import rehypeHighlight from 'rehype-highlight'/, 'shared shell must import rehype-highlight')
assert.match(shellJsx, /rehypePlugins=\{\[rehypeHighlight\]\}/, 'shared shell must wire rehype-highlight into react-markdown')
// highlight.js token colors painted with the existing dark-theme palette (no
// imported hljs theme file, no new clashing palette).
assert.match(shellCss, /\.hljs-keyword[\s\S]*?#68ddff|\.hljs[\s\S]*?color:\s*#68ddff/, 'highlight.js tokens must be painted (cyan accent present)')
assert.match(shellCss, /\.hljs-comment/, 'highlight.js comment token must be styled')
assert.match(shellCss, /\.hljs-string/, 'highlight.js string token must be styled')

console.log('check-workspace-preview-modal: maximize icon present; shared WorkbenchPreviewModal shell used by all 3 existing modals + workspace maximize; dead shell classes removed; react-markdown + rehype-highlight present and wired; read-only.')
