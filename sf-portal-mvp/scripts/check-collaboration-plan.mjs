import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const jobCenter = readFileSync(new URL('../src/components/JobCenter.jsx', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('../src/components/StepExecutionDrawer.jsx', import.meta.url), 'utf8')
const state = readFileSync(new URL('../src/hooks/collaborationPlanState.js', import.meta.url), 'utf8')
const execState = readFileSync(new URL('../src/hooks/executionRecordState.js', import.meta.url), 'utf8')

assert.match(jobCenter, /collaborationLanes/, 'JobCenter should render collaboration lanes when a plan is available')
assert.match(jobCenter, /getJobCollaborationPlan|collaborationPlan/, 'JobCenter should consume collaboration plan data')
assert.match(state, /buildCollaborationCardView/, 'collaboration plan state helper should build card views')
assert.match(execState, /fixedSteps\s*=\s*\[\]/, 'execution record helper should accept dynamic step definitions')
assert.doesNotMatch(jobCenter, /3x2 matrix of the six fixed stages/, 'JobCenter should no longer describe only fixed six stages')
assert.match(workbench, /cw-collaboration-graph/, 'confirm preview should render a collaboration graph')
assert.match(workbench, /collaborationPlanPreview\.edges/, 'confirm preview graph should use plan edges')
assert.match(workbench, /collaborationPreviewUniqueEdges/, 'confirm preview graph should dedupe plan edges before rendering')
assert.doesNotMatch(workbench, /edge\.to\}-\$\{index\}/, 'confirm preview graph keys should not depend on array indexes')
assert.match(workbench, /cw-collaboration-adjustments/, 'confirm preview should show collaboration adjustment records')
assert.match(drawer, /sed-snapshot-skill-files/, 'step drawer should show snapshot skill files')
assert.match(drawer, /snapshotPreview/, 'step drawer should parse snapshot metadata for viewing')
