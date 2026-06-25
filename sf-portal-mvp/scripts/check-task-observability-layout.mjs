import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const jobCenterJsx = readFileSync(new URL('../src/components/JobCenter.jsx', import.meta.url), 'utf8')
const jobCenterCss = readFileSync(new URL('../src/components/JobCenter.css', import.meta.url), 'utf8')
const drawerJsx = readFileSync(new URL('../src/components/StepExecutionDrawer.jsx', import.meta.url), 'utf8')
const stepCardJsx = readFileSync(new URL('../src/components/StepCard.jsx', import.meta.url), 'utf8')
const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const clientJs = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const useJobsJs = readFileSync(new URL('../src/hooks/useJobs.js', import.meta.url), 'utf8')

// --- 3x2 matrix CSS rule ---------------------------------------------------
assert.match(
  jobCenterCss,
  /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
  'step matrix must be a 3-wide CSS grid of six fixed stages',
)

// --- JobCenter wires StepCard + the drawer ---------------------------------
assert.match(jobCenterJsx, /<StepCard/, 'JobCenter must render StepCard components')
assert.match(jobCenterJsx, /<StepExecutionDrawer/, 'JobCenter must render the StepExecutionDrawer')

// Six fixed stages must appear (each StepCard instance maps to one stage).
// JobCenter renders a single <StepCard ... /> inside a .map() over a per-kind
// view derived from the six FIXED_STEPS (via buildStepCardView). The literal
// JSX count is 1; the real requirement is that all six stage labels appear AND
// the matrix maps the per-kind view into StepCard, while still defining the
// six FIXED_STEPS source-of-truth kinds in order.
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

// Six fixed stage names in the source (so the matrix shows the full pipeline).
for (const label of ['需求分析', '方案设计', '代码生成', '测试验证', '镜像构建', '部署']) {
  assert.ok(
    jobCenterJsx.includes(label) || stepCardJsx.includes(label),
    `fixed stage label missing: ${label}`,
  )
}

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
assert.match(appJsx, /onRepairFromFailure=\{jobs\.repairFromFailure\}/, 'App must pass repairFromFailure into JobCenter')
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

// App.jsx must thread the new state surface (records + selected step + artifacts) into JobCenter.
assert.match(appJsx, /getRecords/, 'App must pass getRecords through to JobCenter')
assert.match(appJsx, /getUnreadCount/, 'App must pass getUnreadCount through to JobCenter')
assert.match(appJsx, /selectStepAttempt/, 'App must pass selectStepAttempt through to JobCenter')

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
