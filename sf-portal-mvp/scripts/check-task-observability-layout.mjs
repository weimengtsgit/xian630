import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const jobCenterJsx = readFileSync(new URL('../src/components/JobCenter.jsx', import.meta.url), 'utf8')
const jobCenterCss = readFileSync(new URL('../src/components/JobCenter.css', import.meta.url), 'utf8')
const drawerJsx = readFileSync(new URL('../src/components/StepExecutionDrawer.jsx', import.meta.url), 'utf8')
const stepCardJsx = readFileSync(new URL('../src/components/StepCard.jsx', import.meta.url), 'utf8')
const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const clientJs = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const useJobsJs = readFileSync(new URL('../src/hooks/useJobs.js', import.meta.url), 'utf8')

// --- Phase 2: vertical 执行波次 layout (replaces the old 3-wide matrix) ---
// JobCenter now stacks collaboration-plan lanes (analysis/generation/delivery)
// as VERTICAL waves (.jc-waves > .jc-wave > .jc-wave-cards), one labeled group
// per lane, with agent cards in dependency order. Legacy fixed-step jobs render
// as a single vertical wave group too. The old 3-wide .jc-step-matrix grid CSS
// is removed (kept out of the stylesheet so a stale pin does not false-green).
assert.match(
  jobCenterJsx,
  /className="jc-waves"/,
  'JobCenter must render a .jc-waves vertical-wave container (replaces the horizontal matrix)',
)
assert.match(
  jobCenterJsx,
  /className="jc-wave"/,
  'JobCenter must render each execution wave as a .jc-wave group',
)
assert.match(
  jobCenterJsx,
  /className="jc-wave-title"/,
  'each wave must show a .jc-wave-title label (the lane name)',
)
assert.match(
  jobCenterJsx,
  /className="jc-wave-cards"/,
  'each wave must stack its agent cards in a .jc-wave-cards container',
)
assert.match(
  jobCenterCss,
  /\.jc-waves\s*\{[\s\S]*flex-direction:\s*column/,
  'the .jc-waves container must stack waves vertically (column flex)',
)
assert.match(
  jobCenterCss,
  /\.jc-wave-cards\s*\{[\s\S]*flex-direction:\s*column/,
  'cards inside a wave must stack vertically (column flex), not the old 3-wide grid',
)
assert.doesNotMatch(
  jobCenterCss,
  /\.jc-step-matrix\s*\{/,
  'the old 3-wide .jc-step-matrix grid CSS rule must be removed (vertical waves replace it)',
)

// --- JobCenter wires StepCard + the (embedded) detail ----------------------
assert.match(jobCenterJsx, /<StepCard/, 'JobCenter must render StepCard components')
assert.match(jobCenterJsx, /<StepExecutionDrawer/, 'JobCenter must render the StepExecutionDrawer')

// Six fixed stages still appear for legacy jobs (FIXED_STEPS source of truth).
// JobCenter renders a <StepCard .../> inside a .map() over the per-kind view
// derived from the six FIXED_STEPS (via buildStepCardView), now inside a wave.
const stepCardCount = (jobCenterJsx.match(/<StepCard/g) || []).length
assert.ok(stepCardCount >= 1, `JobCenter must render StepCard (found ${stepCardCount})`)
assert.match(
  jobCenterJsx,
  /\.map\([\s\S]*<StepCard/,
  'JobCenter must map a per-kind list into StepCard instances',
)
assert.match(
  jobCenterJsx,
  /requirement_analysis[\s\S]*solution_design[\s\S]*code_generation[\s\S]*test_verification[\s\S]*image_build[\s\S]*deployment/,
  'JobCenter must keep the six fixed stage kinds in order',
)

// Six fixed stage names in the source (so legacy jobs show the full pipeline).
for (const label of ['需求分析', '方案设计', '代码生成', '测试验证', '镜像构建', '部署']) {
  assert.ok(
    jobCenterJsx.includes(label) || stepCardJsx.includes(label),
    `fixed stage label missing: ${label}`,
  )
}

// --- Phase 2: embedded in-drawer detail (collapses the portal-overlay stack)
// The detail now opens INSIDE the 任务执行 drawer: JobCenter toggles its body
// between the wave list and an embedded StepExecutionDrawer (no createPortal
// overlay, no position:fixed). The back button returns to the list.
assert.match(
  jobCenterJsx,
  /drawerOpen && selectedStepId \?[\s\S]*<StepExecutionDrawer[\s\S]*embedded/,
  'JobCenter must render an embedded StepExecutionDrawer when a step is selected (in-drawer detail)',
)
assert.match(jobCenterJsx, /onBack=\{closeDrawer\}/, 'the embedded detail must expose a back action to return to the wave list')
assert.match(drawerJsx, /embedded = false/, 'StepExecutionDrawer must accept an embedded prop (default false)')
assert.match(drawerJsx, /sed-panel-embedded/, 'embedded mode must render a .sed-panel-embedded container (inline, no portal overlay)')
assert.match(drawerJsx, /ArrowLeft/, 'embedded mode must show a back affordance (ArrowLeft icon)')
assert.match(drawerJsx, /sed-back/, 'embedded mode must render a .sed-back back button')


// --- Drawer tabs + affordances --------------------------------------------
assert.match(drawerJsx, /概览/, 'drawer must have an 概览 (overview) tab')
assert.match(drawerJsx, /执行记录/, 'drawer must have an 执行记录 (records) tab')
assert.match(drawerJsx, /产物与审计/, 'drawer must have an 产物与审计 (artifacts) tab')
assert.match(drawerJsx, /自动跟随/, 'drawer record tab must expose an 自动跟随 (auto-follow) affordance')
assert.match(drawerJsx, /高级审计/, 'artifact tab must collapse advanced audit under 高级审计')

// Follow-on-scroll: a scroll container ref + a N 条新记录 button.
assert.match(drawerJsx, /条新记录/, 'drawer must surface an N 条新记录 unread button when not following')
assert.match(drawerJsx, /scrollHeight|scrollTop/, 'drawer must track scroll position to decide follow behavior')
assert.match(drawerJsx, /loadStepRecords|before_sequence|onLoadOlder|加载更早/, 'drawer must support loading older pages')

// Action constraints: cancel only for running step, retry only for latest failed attempt.
assert.match(drawerJsx, /cancel|onCancel/i, 'overview tab must expose a cancel action')
assert.match(drawerJsx, /retry|onRetry/i, 'overview tab must expose a retry action')
assert.match(drawerJsx, /running/, 'cancel visibility must gate on the running status')
assert.match(drawerJsx, /failed/, 'retry visibility must gate on the failed status')
assert.match(clientJs, /repairFromFailure/, 'client API must expose repairFromFailure')
assert.match(clientJs, /\/repair-from-failure/, 'client API must call the repair-from-failure endpoint')
assert.match(useJobsJs, /repairFromFailure/, 'useJobs must expose repairFromFailure')
// Phase 1 (workbench-drawer migration) REMOVED JobCenter from App.jsx's render
// tree: the task-execution surface moved behind the 任务执行 drawer entry and
// Phase 2 re-mounts JobCenter inside WorkbenchDrawer. So App.jsx no longer
// passes repairFromFailure / getRecords / getUnreadCount / selectStepAttempt
// into a JobCenter sibling. These App.jsx wiring assertions are deferred to
// Phase 2; the JobCenter/StepCard/StepExecutionDrawer INTERNAL contracts below
// (and the client + useJobs plumbing) still hold and must stay green so Phase 2
// can re-attach them without re-deriving the field shapes.
assert.match(jobCenterJsx, /onRepairFromFailure/, 'JobCenter must accept and pass the repair action')
assert.match(drawerJsx, /onRepairFromFailure/, 'StepExecutionDrawer must accept the repair action')
assert.match(jobCenterJsx, /发送错误给代码修复/, 'failed JobCenter must show the repair button label')
assert.match(drawerJsx, /发送错误给代码修复/, 'drawer must show the repair button label')
assert.match(
  drawerJsx,
  /test_verification[\s\S]*image_build/,
  'repair action must be gated to test_verification and image_build',
)

// Plaintext discipline: content rendered in <pre>, never dangerouslySetInnerHTML.
assert.match(drawerJsx, /<pre/, 'content/artifact text must render in <pre> plaintext nodes')
assert.doesNotMatch(
  drawerJsx,
  /dangerouslySetInnerHTML/,
  'drawer must NEVER use dangerouslySetInnerHTML (no HTML execution)',
)
assert.doesNotMatch(
  stepCardJsx,
  /dangerouslySetInnerHTML/,
  'StepCard must NEVER use dangerouslySetInnerHTML (no HTML execution)',
)

// App.jsx no longer threads records/selected-step/artifacts into JobCenter in
// Phase 1: JobCenter is unmounted from App.jsx's render tree (it moves behind
// the 任务执行 drawer in Phase 2). The useJobs hook still exposes these so
// Phase 2 can wire them inside WorkbenchDrawer; pin the hook surface instead.
assert.match(useJobsJs, /getRecords/, 'useJobs must keep getRecords so Phase 2 can wire it inside the 任务执行 drawer')
assert.match(useJobsJs, /getUnreadCount/, 'useJobs must keep getUnreadCount so Phase 2 can wire it inside the 任务执行 drawer')
assert.match(useJobsJs, /selectStepAttempt/, 'useJobs must keep selectStepAttempt so Phase 2 can wire it inside the 任务执行 drawer')

// --- Backend field-shape pin (Task 4 summary) -----------------------------
// The backend serializes each step summary as { step_id, latest_attempt:int,
// latest_record:{ ...content... } }. There is NO `attempts` array and NO
// `summary`/`latest_summary` string. Pin the corrected primary-read so a
// regression that drops latest_attempt / latest_record fails the harness.
// (The latest_record excerpt is rendered in the StepExecutionDrawer; the card
// itself shows only the attempt + duration to keep its height compact.)
assert.match(
  jobCenterJsx,
  /sm\.latest_attempt/,
  'JobCenter must read summary.latest_attempt (int) to build the attempt list',
)
assert.match(
  stepCardJsx,
  /summary\.latest_attempt/,
  'StepCard must read summary.latest_attempt for the inline attempt badge (the excerpt is rendered only in the drawer)',
)
assert.match(
  drawerJsx,
  /summary\.latest_record\.content/,
  'StepExecutionDrawer must read the latest summary from summary.latest_record.content',
)
// Record-renderer must read the backend field record.content (with fallbacks).
assert.match(
  drawerJsx,
  /r\.content\s*\|\|\s*r\.text/,
  'drawer record-renderer must read record.content as the primary text field',
)

console.log('check-task-observability-layout: OK')
