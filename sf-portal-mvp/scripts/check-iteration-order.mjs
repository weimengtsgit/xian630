// sf-portal-mvp/scripts/check-iteration-order.mjs
//
// 第5点回归保护：application-generation 流程（带 child clarification）里，
// 初始 prompt 之后的迭代消息（后续 user 消息 + agent analysis）必须出现在
// 第一轮澄清内容之后，而不是插在初始 prompt 和第一轮澄清之间（旧行为把
// parentMessages 线性渲染、早于 child，导致迭代消息和第一轮耦合）。
import assert from 'node:assert/strict'
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

const view = {
  session: { id: 'dlg1', status: 'task_running', intent: 'application_generation' },
  messages: [
    { id: 'u1', role: 'user', kind: 'prompt', content: '生成兵器管理系统' },
    { id: 'u2', role: 'user', kind: 'message', content: '迭代：把界面改成深色' },
    { id: 'a1', role: 'agent', kind: 'analysis_work_log', content: '迭代分析：调整界面配色方案' },
  ],
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
