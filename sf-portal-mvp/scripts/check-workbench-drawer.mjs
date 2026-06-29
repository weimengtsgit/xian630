// Phase 1 (workbench-drawer migration) regression check for the new right-side
// 工作台抽屉 layout. The brief requires a dedicated check script that pins:
//   - the 3 mutually-exclusive header buttons (任务执行 / 协作智能体 / 应用项目)
//   - the WorkbenchDrawer overlay host rendering the active entry's content
//   - the toggle mutual-exclusivity (clicking the active entry closes the
//     drawer; clicking a different one switches to it)
//   - 应用项目 disabled until the dialogue has a bound application
//   - 任务执行 keeps a presence badge while a focus task exists
//
// Runs under node with NO React import. It exercises the toggle reducer as a
// pure function (mirrored from App.jsx) and asserts static source invariants.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const workbenchCss = readFileSync(new URL('../src/components/ConversationWorkbench.css', import.meta.url), 'utf8')
const drawerJsx = readFileSync(new URL('../src/components/WorkbenchDrawer.jsx', import.meta.url), 'utf8')
const drawerCss = readFileSync(new URL('../src/components/WorkbenchDrawer.css', import.meta.url), 'utf8')

// ---- the 3 header buttons exist + are mutually exclusive --------------------

// App owns the active-entry state and a toggle that closes on re-click.
assert.match(appJsx, /drawerEntry/, 'App must keep a drawerEntry state for the active drawer entry')
assert.match(appJsx, /DRAWER_ENTRIES/, 'App must define the drawer entry keys')
assert.match(appJsx, /setDrawerEntry\(prev => \(prev === entry \? null : entry\)\)/, 'the toggle must close the drawer when the active entry is clicked (mutual exclusivity)')

// ConversationWorkbench renders the 3 buttons, each bound to its entry key.
assert.match(workbenchJsx, /drawerEntry === 'task' \? ' is-active' : ''/, 'the 任务执行 button must highlight when it is the active entry')
assert.match(workbenchJsx, /drawerEntry === 'agents' \? ' is-active' : ''/, 'the 协作智能体 button must highlight when it is the active entry')
assert.match(workbenchJsx, /drawerEntry === 'application' \? ' is-active' : ''/, 'the 应用项目 button must highlight when it is the active entry')
assert.match(workbenchJsx, /onToggleDrawerEntry\('task'\)/, 'the 任务执行 button must toggle the task entry')
assert.match(workbenchJsx, /onToggleDrawerEntry\('agents'\)/, 'the 协作智能体 button must toggle the agents entry')
assert.match(workbenchJsx, /onToggleDrawerEntry\('application'\)/, 'the 应用项目 button must toggle the application entry')
// Active buttons are reachable as a styled group + share a class.
assert.match(workbenchJsx, /cw-drawer-btn/, 'each header button must use the cw-drawer-btn class')
assert.match(workbenchCss, /\.cw-drawer-btn\.is-active|\.is-active[\s\S]*cw-drawer-btn|cw-drawer-btn\.is-active/, 'the active drawer button must have a highlighted style')

// ---- 应用项目 disabled gate -------------------------------------------------

// The button is disabled when the composed view has no bound application.
assert.match(workbenchJsx, /disabled=\{!hasBoundApplication\}/, 'the 应用项目 button must be disabled when no application is bound')
assert.match(appJsx, /hasBoundApplication/, 'App must derive a hasBoundApplication flag')
assert.match(appJsx, /hasBoundApplication\s*=\s*!!applicationProjectId/, 'hasBoundApplication must require a concrete application project id')

// ---- 任务执行 presence badge ------------------------------------------------

// 任务执行 keeps a presence indicator while a focus task exists, even when
// another entry is open (full agent-chip strip is Phase 2).
assert.match(workbenchJsx, /focusTask \? <span className="cw-drawer-badge"/, 'the 任务执行 button must render a presence-dot badge while a focus task exists')
assert.match(workbenchCss, /\.cw-drawer-badge/, 'the presence-dot badge must have a dedicated style')

// ---- WorkbenchDrawer host renders the active entry --------------------------

// The drawer returns null when no entry is active (closed).
assert.match(drawerJsx, /if \(!activeEntry\) return null/, 'WorkbenchDrawer must render nothing when no entry is active')
// Each entry renders its own content block.
assert.match(drawerJsx, /activeEntry === 'task'/, 'the drawer must branch on the task entry')
assert.match(drawerJsx, /activeEntry === 'agents'/, 'the drawer must branch on the agents entry')
assert.match(drawerJsx, /activeEntry === 'application'/, 'the drawer must branch on the application entry')
// Phase 2: the 任务执行 entry now MOUNTS JobCenter (the placeholder is gone).
// JobCenter renders the focus task's vertical 执行波次 + agent cards and the
// step detail opens IN THE SAME drawer (embedded, no portal overlay stack).
assert.match(drawerJsx, /import \{ JobCenter \} from '\.\/JobCenter'/, 'Phase 2: WorkbenchDrawer must import JobCenter')
assert.match(drawerJsx, /activeEntry === 'task' \?[\s\S]*<JobCenter/, 'Phase 2: the 任务执行 entry must render <JobCenter/>')
assert.match(drawerJsx, /taskProps/, 'Phase 2: WorkbenchDrawer must thread task observability props (taskProps) into JobCenter')
assert.doesNotMatch(drawerJsx, /任务执行详情将在下一阶段迁入抽屉/, 'Phase 2: the Phase-1 placeholder must be removed')
// App threads the dialogue's generation tasks + useJobs accessors into the
// drawer's task entry. The drawer shows ALL dialogue tasks (ranked, focus first),
// defaulting to the focus task — NOT focus-task-only (P1-a).
assert.match(appJsx, /taskProps=\{/, 'Phase 2: App must pass a taskProps bundle into WorkbenchDrawer')
assert.doesNotMatch(appJsx, /activeJob: dialogue\.focusTask/, 'Phase 2: App must NOT hardwire activeJob to dialogue.focusTask only (drawer shows ALL dialogue tasks)')
assert.match(appJsx, /jobs: dialogueJobs/, 'Phase 2: App must thread the ranked dialogue task list (dialogueJobs) into the task drawer')
assert.match(appJsx, /onSelectTask/, 'Phase 2: App must wire onSelectTask so a non-focus task can be selected in the drawer')
assert.match(appJsx, /collaborationPlan: jobs\.collaborationPlan/, 'Phase 2: App must thread the collaboration plan into the task drawer')
assert.match(appJsx, /onRepairFromFailure: jobs\.repairFromFailure/, 'Phase 2: App must thread repair-from-failure into the task drawer')
// The drawer is an OVERLAY (not a grid column) so the center width never jitters.
assert.match(drawerCss, /\.workbench-drawer\s*\{[\s\S]*position:\s*absolute/, 'the drawer must be an absolute overlay (not a grid column) to avoid center-width jitter')
assert.match(drawerCss, /\.workbench-drawer\s*\{[\s\S]*right:\s*16px/, 'the overlay must anchor to the right of the workbench')
// The close button toggles the entry back to null.
assert.match(drawerJsx, /workbench-drawer-close/, 'the drawer must have a dedicated close control')

// ---- toggle reducer (pure, mirrored from App.jsx) --------------------------

// Exercise the exact mutual-exclusivity reducer App.jsx uses, so a regression
// that breaks open/close/switch behavior fails here too.
const DRAWER_ENTRIES = ['task', 'agents', 'application']
function toggle(prev, entry) {
  if (!DRAWER_ENTRIES.includes(entry)) return prev
  return prev === entry ? null : entry
}
assert.equal(toggle(null, 'task'), 'task', 'opening from closed sets the entry active')
assert.equal(toggle('task', 'task'), null, 'clicking the active entry closes the drawer')
assert.equal(toggle('task', 'agents'), 'agents', 'clicking a different entry switches to it (mutual exclusivity)')
assert.equal(toggle('agents', 'application'), 'application', 'switching between any two entries works')
assert.equal(toggle('application', 'application'), null, 're-clicking application closes the drawer')
assert.equal(toggle(null, 'unknown'), null, 'an unknown entry key is a no-op')

// ---- navigation assertions (Task 4) ------------------------------------------------
const graphJsx = readFileSync(new URL('../src/components/CollaborationExecutionGraph.jsx', import.meta.url), 'utf8')
assert.match(workbenchJsx, /onOpenTaskDrawer/, 'ConversationWorkbench should pass task-drawer navigation into timeline items')
assert.match(workbenchJsx, /onToggleDrawerEntry && onToggleDrawerEntry\('task'\)/, 'graph card click should open the task execution drawer')
assert.match(graphJsx, /relatedCardKeys/, 'graph component should compute related upstream and downstream cards for hover focus')
assert.match(graphJsx, /onOpenTask\(card\)/, 'graph component should call onOpenTask with the clicked card')
assert.match(graphJsx, /disabled=\{!canOpenTask && card\.kind !== 'origin'\}/, 'pre-confirmation non-origin cards should not pretend to open task details')

console.log('check-workbench-drawer: OK')
