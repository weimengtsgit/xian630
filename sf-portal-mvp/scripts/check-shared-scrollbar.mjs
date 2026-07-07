// Task 5 (shared scrollbar style) layout check.
//
// Before Task 5 the portal had TWO divergent scrollbar families and NO styling
// on the primary conversation scroll area (.cw-body):
//   - a 6px cyan ::-webkit-scrollbar family duplicated per-file in
//     ChatDialog / SessionNav / ApplicationsPanel / AgentsPanel /
//     ApplicationStorePage / JobCenter (each with its own slight token drift).
//   - a Firefox-only scrollbar-width:thin / scrollbar-color shorthand family
//     inlined into cw-task-thinking-scroll, cw-collaboration-rail, ceg-canvas.
//
// Task 5 consolidates them into ONE reusable .sf-scroll utility (defined once
// in the global App.css) that covers BOTH engines:
//   - ::-webkit-scrollbar (+ -track / -thumb / -thumb:hover) for Chromium/WebKit
//   - scrollbar-width + scrollbar-color for Firefox
// using the existing cyan token values (~6px, rgba(111,218,255,0.26) thumb,
// 0.42 hover, subtle dark rgba(6,18,29,0.28) track). No new visual style.
//
// This script pins the NEW consolidated layout MEANINGFULLY:
//   1. App.css defines .sf-scroll once, with BOTH engine families present and
//      the canonical token values.
//   2. .cw-body (the primary target that previously had NO scrollbar styling)
//      now carries the sf-scroll class in ConversationWorkbench.jsx.
//   3. The other main scroll regions carry sf-scroll too (drawer panel-content
//      in AgentsPanel/ApplicationsPanel, workspace preview, chat, session nav,
//      job center, store page/detail, task-thinking, ceg canvas).
//   4. The duplicated per-file ::-webkit-scrollbar rules are removed (one shared
//      definition, not many).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

const appCss = read('../src/App.css')
const cwJsx = read('../src/components/ConversationWorkbench.jsx')
const agentsJsx = read('../src/components/AgentsPanel.jsx')
const applicationsJsx = read('../src/components/ApplicationsPanel.jsx')
const projectJsx = read('../src/components/ApplicationProjectPanel.jsx')
const chatJsx = read('../src/components/ChatDialog.jsx')
const sessionJsx = read('../src/components/SessionNav.jsx')
const jobJsx = read('../src/components/JobCenter.jsx')
const storeJsx = read('../src/components/ApplicationStorePage.jsx')
const aogJsx = read('../src/components/AggregateOrchestrationGraph.jsx')
const cegJsx = read('../src/components/CollaborationExecutionGraph.jsx')

// 1. The shared .sf-scroll utility is defined ONCE in the global App.css and
//    covers BOTH browser engines (Chromium/WebKit ::-webkit-scrollbar family
//    AND the Firefox scrollbar-width/scrollbar-color shorthand).
assert.match(appCss, /\.sf-scroll\s*\{[\s\S]*?scrollbar-width:\s*thin/, '.sf-scroll must define the Firefox scrollbar-width shorthand')
assert.match(appCss, /\.sf-scroll\s*\{[\s\S]*?scrollbar-color:\s*rgba\(111,\s*218,\s*255,\s*0\.42\)\s+rgba\(6,\s*18,\s*29,\s*0\.28\)/, '.sf-scroll Firefox scrollbar-color must use the canonical cyan thumb + dark track tokens')
assert.match(appCss, /\.sf-scroll::-webkit-scrollbar\s*\{[\s\S]*?width:\s*6px/, '.sf-scroll must define the ::-webkit-scrollbar width (~6px)')
assert.match(appCss, /\.sf-scroll::-webkit-scrollbar-track\s*\{/, '.sf-scroll must define a ::-webkit-scrollbar-track (subtle dark track)')
assert.match(appCss, /\.sf-scroll::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*rgba\(111,\s*218,\s*255,\s*0\.26\)/, '.sf-scroll thumb must use the canonical cyan token (~0.26 alpha)')
assert.match(appCss, /\.sf-scroll::-webkit-scrollbar-thumb:hover\s*\{[\s\S]*?background:\s*rgba\(111,\s*218,\s*255,\s*0\.42\)/, '.sf-scroll thumb:hover must use the canonical cyan hover token (~0.42 alpha)')

// 2. Primary target: .cw-body (previously had NO scrollbar styling) now carries
//    the shared class. Assert on the JSX source so it survives minification.
assert.match(cwJsx, /className="cw-body sf-scroll"/, '.cw-body must carry the sf-scroll class (ConversationWorkbench.jsx)')

// 3. The other scroll regions across the app carry sf-scroll too.
assert.match(agentsJsx, /className="panel-content sf-scroll"/, 'AgentsPanel .panel-content must carry sf-scroll')
assert.match(applicationsJsx, /className="panel-content sf-scroll"/, 'ApplicationsPanel .panel-content must carry sf-scroll')
assert.match(projectJsx, /className="app-project-preview sf-scroll"/, 'ApplicationProjectPanel .app-project-preview must carry sf-scroll')
assert.match(chatJsx, /chat-dock-messages sf-scroll/, 'ChatDialog .chat-dock-messages must carry sf-scroll')
assert.match(sessionJsx, /className="session-nav-list sf-scroll"/, 'SessionNav .session-nav-list must carry sf-scroll')
assert.match(jobJsx, /job-center sf-scroll/, 'JobCenter .job-center must carry sf-scroll')
assert.match(storeJsx, /application-store-page sf-scroll/, 'ApplicationStorePage .application-store-page must carry sf-scroll')
assert.match(storeJsx, /store-detail sf-scroll/, 'ApplicationStorePage .store-detail must carry sf-scroll')
assert.match(cwJsx, /cw-task-thinking-scroll sf-scroll/, 'ConversationWorkbench .cw-task-thinking-scroll must carry sf-scroll')
assert.match(aogJsx, /ceg-canvas aog-canvas aog-canvas-expandable sf-scroll/, 'AggregateOrchestrationGraph .ceg-canvas must carry sf-scroll')
assert.match(cegJsx, /className="ceg-canvas sf-scroll"/, 'CollaborationExecutionGraph .ceg-canvas must carry sf-scroll')

// 4. The previously-duplicated per-file ::-webkit-scrollbar rules are gone —
//    one shared definition, not many.
const agentsCss = read('../src/components/AgentsPanel.css')
const applicationsCss = read('../src/components/ApplicationsPanel.css')
const chatCss = read('../src/components/ChatDialog.css')
const sessionCss = read('../src/components/SessionNav.css')
const jobCss = read('../src/components/JobCenter.css')
const storeCss = read('../src/components/ApplicationStorePage.css')

assert.doesNotMatch(agentsCss, /\.panel-content::-webkit-scrollbar/, 'AgentsPanel must no longer define its own ::-webkit-scrollbar (use .sf-scroll)')
assert.doesNotMatch(applicationsCss, /\.panel-content::-webkit-scrollbar/, 'ApplicationsPanel must no longer define its own ::-webkit-scrollbar (use .sf-scroll)')
assert.doesNotMatch(chatCss, /\.chat-dock-messages::-webkit-scrollbar/, 'ChatDialog must no longer define its own ::-webkit-scrollbar (use .sf-scroll)')
assert.doesNotMatch(sessionCss, /\.session-nav-list::-webkit-scrollbar/, 'SessionNav must no longer define its own ::-webkit-scrollbar (use .sf-scroll)')
assert.doesNotMatch(jobCss, /\.job-center::-webkit-scrollbar/, 'JobCenter must no longer define its own ::-webkit-scrollbar (use .sf-scroll)')
assert.doesNotMatch(storeCss, /\.application-store-page::-webkit-scrollbar/, 'ApplicationStorePage must no longer define its own ::-webkit-scrollbar (use .sf-scroll)')
assert.doesNotMatch(storeCss, /\.store-detail::-webkit-scrollbar/, 'ApplicationStorePage .store-detail must no longer define its own ::-webkit-scrollbar (use .sf-scroll)')

console.log('check-shared-scrollbar: .sf-scroll utility defined once in App.css and applied to .cw-body + all shared scroll regions; per-file duplicates removed.')
