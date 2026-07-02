// sf-portal-mvp/scripts/check-requirement-confirm-card.mjs
//
// 纯函数测试：isRequirementConfirmPending(view) 判定对话工作台是否应展示
// 「需求确认」卡片（requirement_analysis 步骤的人工确认闸）。
//
// 背景：requirement_analysis step 成功后被 shouldAwaitManualStepConfirmation
// 拉成 waiting_user，job.pending_questions 塞入一个无选项的 manual_step_confirmation。
// 这张卡片绕开脆弱的 jobs.steps 链路，直接读 dialogue view 的 seededJob。
// 返回 null → 不渲染；返回 {jobId, stepId, requirement} → 渲染卡片。
//
// Task 3 addition: the card-level 确认 button (cw-stage-confirm) must remain
// IN-CARD (not a floating bottom-right confirm). 澄清交互卡片 _Avoid_:
// 右下角悬浮确认, 卡片外提交.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isRequirementConfirmPending } from '../src/hooks/dialogueTimeline.js'

// 1. 无 view / 无 seededJob → null
assert.equal(isRequirementConfirmPending(null), null)
assert.equal(isRequirementConfirmPending(undefined), null)
assert.equal(isRequirementConfirmPending({}), null)
assert.equal(isRequirementConfirmPending({ seededJob: null }), null)

// 2. status 不是 waiting_user → null（job 还在跑/已结束，不该弹确认）
assert.equal(
  isRequirementConfirmPending({
    seededJob: { id: 'j1', status: 'running', current_step_kind: 'requirement_analysis', pending_questions: [] },
  }),
  null,
)
assert.equal(
  isRequirementConfirmPending({
    seededJob: { id: 'j1', status: 'queued', current_step_kind: 'requirement_analysis', pending_questions: [] },
  }),
  null,
)

// 3. 不是 requirement_analysis 步骤 → null（其它步骤的 manual/澄清走既有卡片）
assert.equal(
  isRequirementConfirmPending({
    seededJob: { id: 'j1', status: 'waiting_user', current_step_kind: 'design_contract', pending_questions: [{ type: 'manual_step_confirmation', confirm: true, stepId: 's1' }] },
  }),
  null,
)

// 4. 没有 manual_step_confirmation（如普通任务内澄清）→ null
assert.equal(
  isRequirementConfirmPending({
    seededJob: { id: 'j1', status: 'waiting_user', current_step_kind: 'requirement_analysis', pending_questions: [{ id: 'q1', type: 'clarification' }] },
  }),
  null,
)
// 4b. manual_step_confirmation 但 confirm:false → null
assert.equal(
  isRequirementConfirmPending({
    seededJob: { id: 'j1', status: 'waiting_user', current_step_kind: 'requirement_analysis', pending_questions: [{ type: 'manual_step_confirmation', confirm: false, stepId: 's1' }] },
  }),
  null,
)
// 4c. pending_questions 缺失（dialogue view 的 seededJob 不带该字段）→ 仍判定为应渲染，
//     stepId 为 null，由调用方从 jobs.steps 补充
const noPq = isRequirementConfirmPending({
  seededJob: { id: 'j1', status: 'waiting_user', current_step_kind: 'requirement_analysis' },
})
assert.equal(noPq && noPq.jobId, 'j1')
assert.equal(noPq && noPq.stepId, null)

// 5. 完整有效（snake_case，后端原样字段）→ 返回确认所需的 jobId/stepId + 需求摘要
const ok = isRequirementConfirmPending({
  seededJob: {
    id: 'job_0faf',
    status: 'waiting_user',
    current_step_kind: 'requirement_analysis',
    pending_questions: [
      { confirm: true, id: 'manual_step_confirmation', type: 'manual_step_confirmation', stepId: 'step_65b2', prompt: '请人工确认后继续执行下一步。' },
    ],
  },
  child: { requirement: { appType: 'operations_management', appName: '兵器全生命周期管理系统', coreScenario: '后勤装备管理', targetUsers: ['后勤装备管理人员'], mainEntities: ['兵器/设备', '入库记录'] } },
})
assert.deepEqual(ok, {
  jobId: 'job_0faf',
  stepId: 'step_65b2',
  requirement: { appType: 'operations_management', appName: '兵器全生命周期管理系统', coreScenario: '后勤装备管理', targetUsers: ['后勤装备管理人员'], mainEntities: ['兵器/设备', '入库记录'] },
})

// 6. 字段名兼容 camelCase（前端部分链路 normalize 过）
const okCamel = isRequirementConfirmPending({
  seededJob: {
    id: 'job_0faf',
    status: 'waiting_user',
    currentStepKind: 'requirement_analysis',
    pendingQuestions: [{ confirm: true, type: 'manual_step_confirmation', stepId: 'step_65b2' }],
  },
})
assert.equal(okCamel && okCamel.jobId, 'job_0faf')
assert.equal(okCamel && okCamel.stepId, 'step_65b2')

// 7. requirement 容错：child 缺失时 requirement 为 null（卡片仍可显示，只是无摘要）
const noReq = isRequirementConfirmPending({
  seededJob: {
    id: 'job_0faf',
    status: 'waiting_user',
    current_step_kind: 'requirement_analysis',
    pending_questions: [{ confirm: true, type: 'manual_step_confirmation', stepId: 'step_65b2' }],
  },
})
assert.equal(noReq.jobId, 'job_0faf')
assert.equal(noReq.stepId, 'step_65b2')
assert.equal(noReq.requirement, null)

// ---------------------------------------------------------------------------
// 8. Layout: the card-level 确认 button is IN-CARD (Task 3). The
//    WorkbenchAgentBlock stage confirm (cw-stage-confirm) lives inside the
//    agent block body, and the RequirementConfirmCard renders its own confirm
//    button inline — neither is a floating bottom-right bar.
//    澄清交互卡片 _Avoid_: 右下角悬浮确认, 卡片外提交.
// ---------------------------------------------------------------------------
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const agentBlockJsx = readFileSync(new URL('../src/components/WorkbenchAgentBlock.jsx', import.meta.url), 'utf8')
assert.match(
  agentBlockJsx,
  /cw-stage-confirm/,
  'the stage confirm button must be in-card (cw-stage-confirm inside WorkbenchAgentBlock)',
)
assert.match(
  agentBlockJsx,
  /cw-requirement-confirm-btn/,
  'the stage confirm must use the in-card cw-requirement-confirm-btn affordance',
)
assert.match(
  workbenchJsx,
  /cw-requirement-confirm-btn/,
  'the RequirementConfirmCard must render its confirm button in-card',
)

console.log('check-requirement-confirm-card: ok')
