// Phase 1 (workbench-drawer migration) layout check.
//
// The OLD layout this script pinned (3-col grid + ApplicationsPanel left +
// AgentsPanel right + side-rail-toggle restore buttons + leftPanelHidden /
// rightPanelHidden state) is GONE. Phase 1 replaces it with a 2-col grid
// (会话导航 rail + 中间工作台) where the left nav owns its OWN collapse, and a
// unified right-side WorkbenchDrawer overlay opened by the 3 workbench header
// buttons (replacing the old right AgentsPanel column + the floating restore
// button).
//
// This rewrite asserts the NEW layout MEANINGFULLY — it does not just delete the
// old assertions to force green. It pins:
//   - the 2-col grid + the left-nav-owned collapse (session-nav-collapsed class)
//   - the SessionNav rail is mounted on the left and ApplicationsPanel is NOT
//   - the WorkbenchDrawer overlay host is mounted and the fixed right AgentsPanel
//     column + BOTH rail-toggle restore buttons are removed
//   - AgentsPanel content is reused INSIDE the drawer (hide button omitted)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const sessionNavJsx = readFileSync(new URL('../src/components/SessionNav.jsx', import.meta.url), 'utf8')
const sessionNavCss = readFileSync(new URL('../src/components/SessionNav.css', import.meta.url), 'utf8')
const workbenchDrawerJsx = readFileSync(new URL('../src/components/WorkbenchDrawer.jsx', import.meta.url), 'utf8')
const agentsPanelJsx = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

// ---- LEFT: SessionNav owns the left column + its own collapse ----------------

// SessionNav is mounted in the left column and ApplicationsPanel is NOT mounted
// anywhere in App.jsx (its list moves to a separate page later; the file stays
// on disk but is unmounted from the main workbench in Phase 1).
assert.match(appJsx, /<SessionNav/, 'App must mount SessionNav in the left column')
assert.doesNotMatch(appJsx, /<ApplicationsPanel/, 'App must NOT mount ApplicationsPanel in the main workbench (left nav is SessionNav now)')

// The left nav owns its OWN collapse state. The old leftPanelHidden/rightPanelHidden
// rail-toggle state is gone.
assert.match(appJsx, /sessionNavCollapsed/, 'App must keep a dedicated sessionNavCollapsed state for the left nav collapse')
assert.doesNotMatch(appJsx, /leftPanelHidden/, 'App must NOT keep the old leftPanelHidden rail-toggle state')
assert.doesNotMatch(appJsx, /rightPanelHidden/, 'App must NOT keep the old rightPanelHidden rail-toggle state')

// The collapse class flips the grid first column to a narrow (~56px) rail.
assert.match(appJsx, /session-nav-collapsed/, 'App must apply a session-nav-collapsed layout class when the left nav is collapsed')
assert.match(appCss, /\.workbench\.session-nav-collapsed\s*\{[\s\S]*grid-template-columns:\s*56px/, 'collapsed left nav must shrink the first grid column to a ~56px rail')
assert.match(appCss, /\.workbench\s*\{[\s\S]*grid-template-columns:\s*var\(--session-nav-w,\s*300px\)\s+minmax\(0,\s*1fr\)/, 'workbench must be a 2-col grid (left nav + center), not the old 3-col layout')

// SessionNav renders the new-session action and an expand affordance in BOTH
// expanded and collapsed variants (the collapsed rail must still offer 新建会话).
assert.match(sessionNavJsx, /session-nav-new/, 'SessionNav must render a new-session action')
assert.match(sessionNavJsx, /session-nav-new-mini/, 'SessionNav collapsed rail must keep a new-session affordance')
assert.match(sessionNavJsx, /session-nav-expand/, 'SessionNav collapsed rail must offer an expand affordance')
assert.match(sessionNavJsx, /session-nav-collapse/, 'SessionNav expanded rail must offer a collapse affordance')
assert.match(sessionNavCss, /\.session-nav-collapsed\s*\{[\s\S]*align-items:\s*center/, 'collapsed SessionNav must render as a narrow centered rail')

// ---- RIGHT: WorkbenchDrawer overlay host replaces the fixed AgentsPanel column

// The unified WorkbenchDrawer host is mounted (the 3 header buttons open it).
assert.match(appJsx, /<WorkbenchDrawer/, 'App must mount the WorkbenchDrawer overlay host')
// The fixed right AgentsPanel column + BOTH rail-toggle restore buttons are gone.
assert.doesNotMatch(appJsx, /wb-right/, 'App must NOT render the fixed right .wb-right AgentsPanel column')
assert.doesNotMatch(appJsx, /side-rail-toggle side-rail-toggle-left/, 'App must NOT render the left rail-toggle restore button (left nav owns its collapse now)')
assert.doesNotMatch(appJsx, /side-rail-toggle side-rail-toggle-right/, 'App must NOT render the right rail-toggle restore button (replaced by the 协作智能体 drawer entry)')
assert.doesNotMatch(appJsx, /left-hidden|right-hidden/, 'App must NOT use the old left-hidden/right-hidden layout classes')

// The drawer is an OVERLAY (not a 3rd grid column) so opening/closing it never
// changes the center width.
assert.match(workbenchDrawerJsx, /workbench-drawer-open/, 'WorkbenchDrawer must render an open variant class')

// AgentsPanel CONTENT is reused inside the drawer: the drawer renders AgentsPanel
// WITHOUT its hide button (onHidePanel omitted), so the agents list / create /
// delete / detail surface stays usable inside the overlay.
assert.match(workbenchDrawerJsx, /<AgentsPanel/, 'WorkbenchDrawer must reuse AgentsPanel content for the 协作智能体 entry')
assert.match(agentsPanelJsx, /onHidePanel\s*\?/, 'AgentsPanel must render its hide button ONLY when onHidePanel is passed (so the drawer can omit it)')
assert.doesNotMatch(workbenchDrawerJsx, /onHidePanel=\{/, 'WorkbenchDrawer must NOT pass onHidePanel as a prop to AgentsPanel (no hide button inside the drawer)')

console.log('side panel toggle check passed')
