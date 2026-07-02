// sf-portal-mvp/scripts/check-iteration-order.mjs
//
// 第5点回归保护：application-generation 流程（带 child clarification）里，
// 初始 prompt 之后的迭代消息（后续 user 消息 + agent analysis）必须出现在
// 第一轮澄清内容之后，而不是插在初始 prompt 和第一轮澄清之间（旧行为把
// parentMessages 线性渲染、早于 child，导致迭代消息和第一轮耦合）。
//
// Task 2 补充：父消息流的「首轮」agent 内容（thinking / analysis_work_log /
// reply，位于初始 prompt 与第一条迭代 user 消息之间）必须按真实持久化顺序
// 渲染在初始 prompt 紧后、第一轮 child 澄清之前（旧行为把所有父 agent 内容
// 一股脑塞进 postConfirmationItems，追加到 child 之后，导致首轮 思考过程 /
// 思考摘要 被埋在澄清历史之下）。首轮 live（in-flight）流也必须随其轮次
// 出现——位于初始 prompt 与 child 之间，而不是只追加到末尾。
import assert from 'node:assert/strict'
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

const view = {
  session: { id: 'dlg1', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '生成兵器管理系统' },
    { id: 'u2', role: 'user', kind: 'message', content: '迭代：把界面改成深色' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '迭代分析：调整界面配色方案' },
  ],
  route: {},
  child: {
    messages: [
      { id: 'c1', role: 'agent', kind: 'analysis_work_log', content: '第一轮需求分析' },
      { id: 'cq1', role: 'agent', kind: 'question', metadata_json: '{"id":"q1","question":"应用类型","options":[{"value":"a","label":"A"}]}' },
    ],
  },
}

const items = buildDialogueTimeline(view)
const idx = id => items.findIndex(it => it.id === id)
const u1 = idx('u1')
const u2 = idx('u2')
const a1 = idx('a1')
// child 派生的 item（appendChildItems 用 `${sessionId}_...` 作为 id）
const childIdx = items.findIndex(it => typeof it.id === 'string' && it.id.startsWith('dlg1_'))

// 诊断输出
console.log('order:', items.map(it => `${it.type}#${it.id}`).join(' | '))

assert.ok(u1 >= 0, '初始 prompt 应渲染')
assert.ok(u2 >= 0, '迭代 user 消息应渲染')
assert.ok(a1 >= 0, '迭代 analysis 应渲染')
assert.ok(childIdx >= 0, '第一轮澄清内容应渲染（child 派生 item）')

// 核心：迭代消息在初始 prompt 之后
assert.ok(u2 > u1, `迭代 user 应在初始 prompt 之后 (u2=${u2}, u1=${u1})`)
// 核心：迭代消息在第一轮澄清内容之后（不插在第一轮中间）
assert.ok(u2 > childIdx, `迭代 user 应在第一轮澄清之后 (u2=${u2}, childIdx=${childIdx})`)
assert.ok(a1 > childIdx, `迭代 analysis 应在第一轮澄清之后 (a1=${a1}, childIdx=${childIdx})`)

// ---- Task 2: 父消息首轮 agent 内容必须在初始 prompt 紧后、child 之前 ----
const firstRoundView = {
  session: { id: 'dlg_fr', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '生成兵器管理系统' },
    { id: 't1', role: 'agent', kind: 'thinking', content: '正在理解需求...' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '首轮分析：识别为管理类应用' },
    { id: 'r1', role: 'agent', kind: 'reply', content: '我开始澄清需求。' },
  ],
  route: {},
  child: {
    messages: [
      { id: 'c1', role: 'agent', kind: 'analysis_work_log', content: '第一轮需求分析' },
      { id: 'cq1', role: 'agent', kind: 'question', metadata_json: '{"id":"q1","question":"应用类型","options":[{"value":"a","label":"A"}]}' },
    ],
  },
}
const frItems = buildDialogueTimeline(firstRoundView)
console.log('first-round order:', frItems.map(it => `${it.type}#${it.id}`).join(' | '))
const frIdx = id => frItems.findIndex(it => it.id === id)
const frU1 = frIdx('u1'), frT1 = frIdx('t1'), frA1 = frIdx('a1'), frR1 = frIdx('r1')
const frChild = frItems.findIndex(it => typeof it.id === 'string' && it.id.startsWith('dlg_fr_'))
assert.ok(frT1 >= 0 && frA1 >= 0 && frR1 >= 0, '父消息首轮 thinking/analysis/reply 必须渲染')
assert.ok(frChild >= 0, '第一轮 child 澄清内容必须渲染')
// 首轮父 agent 内容必须在初始 prompt 之后、child 之前（真实持久化顺序）
assert.ok(frT1 > frU1 && frT1 < frChild, `父 thinking 必须位于初始 prompt 与 child 之间 (u1=${frU1},t1=${frT1},child=${frChild})`)
assert.ok(frA1 > frU1 && frA1 < frChild, `父 analysis 必须位于初始 prompt 与 child 之间 (u1=${frU1},a1=${frA1},child=${frChild})`)
assert.ok(frR1 > frU1 && frR1 < frChild, `父 reply 必须位于初始 prompt 与 child 之间 (u1=${frU1},r1=${frR1},child=${frChild})`)
// 顺序内部一致：thinking → analysis → reply
assert.ok(frT1 < frA1 && frA1 < frR1, `首轮父 agent 内容顺序必须为 thinking→analysis→reply (t1=${frT1},a1=${frA1},r1=${frR1})`)

// ---- Task 2: 首轮 live（in-flight）流必须随其轮次，位于初始 prompt 与 child 之间 ----
const liveView = {
  session: { id: 'dlg_live', status: 'drafting_application', intent: 'application_generation', route_locked: true },
  messages: [{ id: 'u1', role: 'user', kind: 'prompt', content: '生成兵器管理系统' }],
  route: {},
  child: {
    messages: [
      { id: 'cq1', role: 'agent', kind: 'question', metadata_json: '{"id":"q1","question":"应用类型","options":[{"value":"a","label":"A"}]}' },
    ],
  },
}
const liveItems = buildDialogueTimeline(
  liveView,
  null,
  { key: 'turn:x', content: '正在分析需求...', kind: 'round' },
  { key: 'thinking:x', content: '正在思考...', kind: 'round' },
)
console.log('live-first-round order:', liveItems.map(it => `${it.type}#${it.id}`).join(' | '))
const liveThink = liveItems.findIndex(it => it.type === 'live_thinking')
const liveAnalysis = liveItems.findIndex(it => it.type === 'live_analysis')
const liveChild = liveItems.findIndex(it => it.id === 'dlg_live_questions')
assert.ok(liveThink >= 0 && liveAnalysis >= 0, '首轮 live thinking/analysis 必须渲染')
assert.ok(liveChild >= 0, '第一轮 child 问题组必须渲染')
assert.ok(liveThink < liveChild, `首轮 live thinking 必须位于 child 之前 (think=${liveThink},child=${liveChild})`)
assert.ok(liveAnalysis < liveChild, `首轮 live analysis 必须位于 child 之前 (analysis=${liveAnalysis},child=${liveChild})`)

// ---- 迭代轮的 live 流保持在末尾（不随首轮插入）----
const iterationLiveView = {
  session: { id: 'dlg_il', status: 'task_running', intent: 'application_generation', route_locked: true },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '生成兵器管理系统' },
    { id: 'u2', role: 'user', kind: 'message', content: '迭代：改界面' },
  ],
  route: {},
  child: {
    messages: [
      { id: 'cq1', role: 'agent', kind: 'question', metadata_json: '{"id":"q1","question":"应用类型","options":[{"value":"a","label":"A"}]}' },
    ],
  },
}
const iterLiveItems = buildDialogueTimeline(
  iterationLiveView,
  null,
  { key: 'turn:y', content: '迭代分析中...', kind: 'round' },
  null,
)
const ilChild = iterLiveItems.findIndex(it => it.id === 'dlg_il_questions')
const ilLive = iterLiveItems.findIndex(it => it.type === 'live_analysis')
assert.ok(ilLive > ilChild, `迭代轮的 live 流必须在 child 之后（末尾）(live=${ilLive},child=${ilChild})`)

// 逆向对照：routing 流程（无 child）保持原内联顺序 —— agent analysis 紧跟 user
const routingView = {
  session: { id: 'dlg2', status: 'analyzing', intent: 'routing' },
  messages: [
    { id: 'r1', role: 'user', kind: 'prompt', content: '帮我做个工具' },
    { id: 'r2', role: 'agent', kind: 'analysis_work_log', content: '路由分析' },
  ],
}
const routingItems = buildDialogueTimeline(routingView)
const r1 = routingItems.findIndex(it => it.id === 'r1')
const r2Analysis = routingItems.findIndex(it => it.type === 'analysis_stream')
assert.ok(r2Analysis > r1, '无 child 流程：agent analysis 应在 user 之后（内联顺序不破坏）')

console.log('check-iteration-order: ok')
