# sf-portal 阶段状态接口与卡片跳转 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 sf-portal 加一个同源后端接口(`/api/stages`)返回 4 阶段状态；删掉 AgentsPanel 的假进度条、卡片改为接口驱动的 pending/completed 两态 + 点击跳转。

**Architecture:** sf-portal 从纯静态升级为 express 服务（`server/` 下）：`server/index.js` 用 express 既 serve `dist/` 静态、又提供 `/api/stages` GET/POST。状态持久化在 `server/stages.json`。前端新增 `useStages` hook 轮询该接口；`AgentsPanel` 改用接口数据，删 `pipeline.js`/`useAgents.js`/`mockAgents`。线上 `sf-portal-pipeline` 容器从 `nginx:alpine + bind dist` 换成 `node:alpine + bind 项目目录 + npm start`。

**Tech Stack:** React 18 + Vite 6（前端，已有）+ Node.js express（后端，新增）+ `node:test`（测试，Node 内置，零新依赖）。

## Global Constraints

- **stage key 与前端 agent id 完全一致**：`agent-business` / `agent-prototype` / `agent-data` / `agent-production`（**注意界面解析 = `agent-prototype`**）。接口、`stages.json`、前端全部用这四个 key，不做任何映射。（这是对 spec §2 里 `business/ui/data/delivery` 逻辑名的实现细化 —— 实现采用真实 agent id 以消除映射层。）
- **阶段只有两态**：`pending` / `completed`。删掉 `working` / `idle`。
- **URL 与状态都放 `server/stages.json`**，改 URL/状态不用改代码。
- 初始 URL：`agent-business = https://115.190.228.77:18701`；`agent-prototype = http://220.154.5.91:18020`（假设 = interface-agent，待用户确认）；`agent-data = ""`；`agent-production = ""`。URL 为空 → 卡片不可点（灰显 + 「未配置跳转」）。
- 初始状态：`agent-business = completed`，其余 `pending`。
- 后端监听 `process.env.PORT || 80`；线上容器内监听 80，宿主映射 `18002->80` 不变。
- 测试用 Node 内置 `node:test` + `node:assert`，**不引入 vitest/jest**。前端只测可纯函数化的逻辑（不引入 React 测试栈），组件渲染用手测 checklist。
- `package.json` 新增依赖仅 `express`；新增 scripts：`start: "node server/index.js"`、`test: "node --test"`。
- 所有后端/前端 JS 文件用 ESM（`package.json` 已是 `"type": "module"`）。
- 测试中 `stages.json` 不可写真实仓库文件 —— 用 `createStageStore(tmpFile, initial)` 注入。

---

## File Structure

新增：
- `sf-portal/server/stages.json` — 持久化状态 + URL（仓库内是初始版，运行时被 POST 改写）
- `sf-portal/server/stages.js` — `STAGE_KEYS` / `createStageStore(filepath, initial)` / 默认单例 `store`
- `sf-portal/server/stages.test.js` — `node:test` 覆盖 store 读写
- `sf-portal/server/app.js` — `createApp(storeOverride?)` 返回 express app
- `sf-portal/server/app.test.js` — `node:test` + `node:http` 覆盖 GET/POST 端点
- `sf-portal/server/index.js` — 入口 `createApp().listen(PORT)`
- `sf-portal/src/hooks/stagesLogic.js` — 纯函数 `allCompleted`
- `sf-portal/src/hooks/stagesLogic.test.js` — `node:test`
- `sf-portal/src/hooks/useStages.js` — fetch + 5s 轮询 hook

修改：
- `sf-portal/package.json` — +express, +start, +test
- `sf-portal/src/components/AgentsPanel.jsx` — AgentNode 删进度条/加跳转/两态；AgentsPanel 接 `useStages`；AGENT_META 补 name/type
- `sf-portal/src/components/AgentsPanel.css` — 完成态高亮、no-url 灰显、`a.agent-node` 重置、删进度条样式

删除：
- `sf-portal/src/hooks/pipeline.js`
- `sf-portal/src/hooks/useAgents.js`
- `sf-portal/src/data/mockData.js` 中的 `mockAgents`（保留 `mockApplications`，ApplicationsPanel 在用）

---

## Task 1: stages 状态 store（TDD）

**Files:**
- Create: `sf-portal/server/stages.js`
- Create: `sf-portal/server/stages.json`
- Create: `sf-portal/server/stages.test.js`
- Modify: `sf-portal/package.json`（加 `test` script）

**Interfaces:**
- Produces: `STAGE_KEYS`（数组）、`createStageStore(filepath, initial)` → `{ read(), update(key, status) }`、默认单例 `store`

- [ ] **Step 1: 给 `package.json` 加 test script**

`scripts` 改为：
```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "start": "node server/index.js",
  "test": "node --test"
}
```
（`start` 此时引用的 `server/index.js` 还没建，先写上，Task 2/3 后可用。）

- [ ] **Step 2: 写失败测试 `server/stages.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createStageStore, STAGE_KEYS } from './stages.js'

function tmpStore(initial) {
  const file = path.join(os.tmpdir(), `stages-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  return { file, store: createStageStore(file, initial) }
}

const INITIAL = STAGE_KEYS.map(k => ({ key: k, name: k, status: 'pending', url: '' }))

test('read returns initial stages when file absent', () => {
  const { store } = tmpStore(INITIAL)
  assert.equal(store.read().length, 4)
  assert.deepEqual(store.read().map(s => s.key), STAGE_KEYS)
})

test('update flips status and persists to disk', () => {
  const { file, store } = tmpStore(INITIAL)
  const next = store.update('agent-business', 'completed')
  assert.equal(next.find(s => s.key === 'agent-business').status, 'completed')
  // 内存一致
  assert.equal(store.read().find(s => s.key === 'agent-business').status, 'completed')
  // 落盘一致
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).stages
  assert.equal(onDisk.find(s => s.key === 'agent-business').status, 'completed')
})

test('update throws on unknown key', () => {
  const { store } = tmpStore(INITIAL)
  assert.throws(() => store.update('agent-nope', 'completed'), /unknown stage key/)
})

test('update throws on invalid status', () => {
  const { store } = tmpStore(INITIAL)
  assert.throws(() => store.update('agent-business', 'working'), /invalid status/)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd sf-portal && npm test`
Expected: FAIL — `Cannot find module './stages.js'`

- [ ] **Step 4: 实现 `server/stages.js`**

```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_FILE = path.resolve(__dirname, 'stages.json')

export const STAGE_KEYS = ['agent-business', 'agent-prototype', 'agent-data', 'agent-production']
const VALID_STATUS = ['pending', 'completed']

export function DEFAULT_STAGES() {
  return [
    { key: 'agent-business', name: '业务逻辑', status: 'completed', url: 'https://115.190.228.77:18701' },
    { key: 'agent-prototype', name: '界面解析', status: 'pending', url: 'http://220.154.5.91:18020' },
    { key: 'agent-data', name: '数据抓取', status: 'pending', url: '' },
    { key: 'agent-production', name: '生产交付', status: 'pending', url: '' }
  ]
}

export function createStageStore(filepath, initial) {
  let cache
  try {
    cache = JSON.parse(fs.readFileSync(filepath, 'utf8')).stages
  } catch {
    cache = Array.from(initial)
    fs.writeFileSync(filepath, JSON.stringify({ stages: cache }, null, 2))
  }
  return {
    read() { return cache },
    update(key, status) {
      if (!STAGE_KEYS.includes(key)) throw new Error(`unknown stage key: ${key}`)
      if (!VALID_STATUS.includes(status)) throw new Error(`invalid status: ${status}`)
      cache = cache.map(s => (s.key === key ? { ...s, status } : s))
      fs.writeFileSync(filepath, JSON.stringify({ stages: cache }, null, 2))
      return cache
    }
  }
}

export const store = createStageStore(DEFAULT_FILE, DEFAULT_STAGES())
```

- [ ] **Step 5: 建 `server/stages.json`（初始状态，= DEFAULT_STAGES()）**

```json
{
  "stages": [
    { "key": "agent-business", "name": "业务逻辑", "status": "completed", "url": "https://115.190.228.77:18701" },
    { "key": "agent-prototype", "name": "界面解析", "status": "pending", "url": "http://220.154.5.91:18020" },
    { "key": "agent-data", "name": "数据抓取", "status": "pending", "url": "" },
    { "key": "agent-production", "name": "生产交付", "status": "pending", "url": "" }
  ]
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd sf-portal && npm test`
Expected: PASS（4 tests）

- [ ] **Step 7: Commit**

```bash
git add sf-portal/server/stages.js sf-portal/server/stages.json sf-portal/server/stages.test.js sf-portal/package.json
git commit -m "feat(sf-portal): stages 状态 store + node:test 覆盖"
```

---

## Task 2: express app + 端点（TDD）

**Files:**
- Create: `sf-portal/server/app.js`
- Create: `sf-portal/server/app.test.js`
- Create: `sf-portal/server/index.js`
- Modify: `sf-portal/package.json`（+express）

**Interfaces:**
- Consumes: `store` from `stages.js`（默认单例）
- Produces: `createApp(storeOverride?)` → express app；`GET /api/stages` → `{stages:[]}`；`POST /api/stages/:key` body `{status}` → `{stages:[]}` 或 400

- [ ] **Step 1: 安装 express**

Run: `cd sf-portal && npm install express@^4.21.2`
（会在 `package.json` dependencies 加一行 `express`。）

- [ ] **Step 2: 写失败测试 `server/app.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from './app.js'
import { createStageStore, STAGE_KEYS } from './stages.js'

const INITIAL = STAGE_KEYS.map(k => ({ key: k, name: k, status: 'pending', url: '' }))

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  try { return await fn(`http://127.0.0.1:${port}`) }
  finally { await new Promise(r => server.close(r)) }
}

async function req(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test('GET /api/stages returns stages', async () => {
  const store = createStageStore('/tmp/nonexistent-app-test.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status, json } = await req(base, 'GET', '/api/stages')
    assert.equal(status, 200)
    assert.equal(json.stages.length, 4)
  })
})

test('POST /api/stages/:key updates and returns stages', async () => {
  const store = createStageStore('/tmp/nonexistent-app-test2.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status, json } = await req(base, 'POST', '/api/stages/agent-data', { status: 'completed' })
    assert.equal(status, 200)
    assert.equal(json.stages.find(s => s.key === 'agent-data').status, 'completed')
  })
})

test('POST unknown key → 400', async () => {
  const store = createStageStore('/tmp/nonexistent-app-test3.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-nope', { status: 'completed' })
    assert.equal(status, 400)
  })
})

test('POST invalid status → 400', async () => {
  const store = createStageStore('/tmp/nonexistent-app-test4.json', INITIAL)
  await withServer(createApp(store), async base => {
    const { status } = await req(base, 'POST', '/api/stages/agent-business', { status: 'working' })
    assert.equal(status, 400)
  })
})
```

> 注：测试用 `/tmp/...` 不存在的文件，store 会用传入的 `INITIAL` 初始化并写盘（写进 /tmp，无害）。不同 test 用不同文件名避免串扰。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd sf-portal && npm test`
Expected: FAIL — `Cannot find module './app.js'`

- [ ] **Step 4: 实现 `server/app.js`**

```js
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store as defaultStore } from './stages.js'

export function createApp(storeOverride) {
  const store = storeOverride || defaultStore
  const app = express()
  app.use(express.json())

  app.get('/api/stages', (_req, res) => {
    res.json({ stages: store.read() })
  })

  app.post('/api/stages/:key', (req, res) => {
    try {
      const stages = store.update(req.params.key, req.body?.status)
      res.json({ stages })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const distDir = path.resolve(__dirname, '..', 'dist')
  app.use(express.static(distDir))
  return app
}
```

- [ ] **Step 5: 实现 `server/index.js`**

```js
import { createApp } from './app.js'
const port = process.env.PORT || 80
createApp().listen(port, () => console.log(`sf-portal server on :${port}`))
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd sf-portal && npm test`
Expected: PASS（stages.test.js 4 + app.test.js 4 = 8 tests）

- [ ] **Step 7: Commit**

```bash
git add sf-portal/server/app.js sf-portal/server/app.test.js sf-portal/server/index.js sf-portal/package.json sf-portal/package-lock.json
git commit -m "feat(sf-portal): express app + /api/stages 端点 + node:test 覆盖"
```

---

## Task 3: 前端 useStages 纯函数 + hook

**Files:**
- Create: `sf-portal/src/hooks/stagesLogic.js`
- Create: `sf-portal/src/hooks/stagesLogic.test.js`
- Create: `sf-portal/src/hooks/useStages.js`

**Interfaces:**
- Produces: `allCompleted(stages): boolean`；`useStages(intervalMs=5000)` → `{ stages, loading, error }`，其中 stages 元素 `{key,name,status,url}`

- [ ] **Step 1: 写失败测试 `src/hooks/stagesLogic.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allCompleted } from './stagesLogic.js'

const K = ['agent-business','agent-prototype','agent-data','agent-production']
const done = () => K.map(k => ({ key: k, status: 'completed' }))

test('allCompleted: 空数组 → false', () => {
  assert.equal(allCompleted([]), false)
})
test('allCompleted: 任一 pending → false', () => {
  const s = done(); s[2].status = 'pending'
  assert.equal(allCompleted(s), false)
})
test('allCompleted: 全 completed → true', () => {
  assert.equal(allCompleted(done()), true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd sf-portal && npm test`
Expected: FAIL — `Cannot find module './stagesLogic.js'`

- [ ] **Step 3: 实现 `src/hooks/stagesLogic.js`**

```js
export function allCompleted(stages) {
  return Array.isArray(stages) && stages.length > 0 && stages.every(s => s && s.status === 'completed')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd sf-portal && npm test`
Expected: PASS（新增 3 tests）

- [ ] **Step 5: 实现 `src/hooks/useStages.js`**

```js
import { useState, useEffect, useRef } from 'react'
import { allCompleted } from './stagesLogic.js'

export function useStages(intervalMs = 5000) {
  const [stages, setStages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch('/api/stages')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        const next = data.stages || []
        setStages(next)
        setError(null)
        if (allCompleted(next)) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    poll()
    timerRef.current = setInterval(poll, intervalMs)
    return () => {
      cancelled = true
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [intervalMs])

  return { stages, loading, error }
}
```

- [ ] **Step 6: Commit**

```bash
git add sf-portal/src/hooks/stagesLogic.js sf-portal/src/hooks/stagesLogic.test.js sf-portal/src/hooks/useStages.js
git commit -m "feat(sf-portal): useStages 轮询 hook + allCompleted 纯函数"
```

---

## Task 4: AgentsPanel 改造（删进度条 + 跳转 + 两态）

**Files:**
- Modify: `sf-portal/src/components/AgentsPanel.jsx`
- Modify: `sf-portal/src/components/AgentsPanel.css`

**Interfaces:**
- Consumes: `useStages()` from Task 3；AGENT_META（本文件内）
- 产物：`AgentNode({ id, status, url })`，`AgentsPanel({ userInput })`

- [ ] **Step 1: 改 `AgentsPanel.jsx` 顶部 import + AGENT_META（补 name/type，删 useAgents）**

把文件开头 1-13 行 + AGENT_META（16-33）替换为：

```jsx
import { useStages } from '../hooks/useStages'
import {
  CheckCircle,
  Clock,
  Bot,
  User,
  Briefcase,
  Figma,
  BarChart3,
  Code2
} from 'lucide-react'
import './AgentsPanel.css'

// 流水线节点元信息：图标 / 名称 / 类型 / 职责描述
const AGENT_META = {
  'agent-business': {
    icon: Briefcase,
    name: '业务逻辑智能体',
    type: '业务逻辑',
    desc: '业务流程建模 · 逻辑拆解',
    detail: '业务逻辑智能体重点是理解指挥员意图、分析业务逻辑，形成智能体生成方案。'
  },
  'agent-prototype': {
    icon: Figma,
    name: '界面解析智能体',
    type: '界面解析',
    desc: '界面结构 · 元素解析',
    detail: '界面解析智能体重点是回应指挥员关切，按要求调整配置界面。'
  },
  'agent-data': {
    icon: BarChart3,
    name: '数据抓取智能体',
    type: '数据抓取',
    desc: '数据采集 · 字段抽取',
    detail: '数据抓取智能体重点是深入动态数据对象进行数据抓取、接口对接，共同完成各类智能体的快速生成。'
  },
  'agent-production': {
    icon: Code2,
    name: '生产交付智能体',
    type: '生产交付',
    desc: '代码生成 · 工程交付'
  }
}
```

- [ ] **Step 2: 删掉旧的 `getStatusInfo` 函数（35-48 行），改写 `AgentNode`**

删掉 `getStatusInfo` 整个函数。把 `AgentNode`（50-108）替换为：

```jsx
function AgentNode({ id, status, url }) {
  const meta = AGENT_META[id] || { icon: Bot, name: id, type: '', desc: '' }
  const Icon = meta.icon
  const completed = status === 'completed'
  const clickable = !!url
  const Tag = clickable ? 'a' : 'div'
  const tagProps = clickable ? { href: url, target: '_blank', rel: 'noopener' } : {}
  const accent = completed ? '#7feb9b' : '#68ddff'

  return (
    <Tag
      className={`agent-node${completed ? ' is-completed' : ''}${clickable ? ' is-clickable' : ' no-url'}`}
      data-agent-id={id}
      data-status={completed ? 'completed' : 'pending'}
      tabIndex={meta.detail ? 0 : undefined}
      {...tagProps}
    >
      {meta.detail && (
        <div className="agent-node-tooltip" role="tooltip">{meta.detail}</div>
      )}
      <div className="agent-node-head">
        <div className="agent-node-icon" style={{ borderColor: `${accent}55` }}>
          <Icon size={30} style={{ color: accent }} />
        </div>
        <div className="agent-node-titles">
          <div className="agent-node-name">{meta.name}</div>
          <div className="agent-node-type">{meta.type}</div>
        </div>
      </div>

      <div className="agent-node-desc">{meta.desc}</div>

      <div className="agent-node-status">
        {completed ? <CheckCircle size={17} color={accent} /> : <Clock size={17} color={accent} />}
        <span style={{ color: accent }}>{completed ? '已完成' : '待开始'}</span>
      </div>

      {completed
        ? <div className="agent-node-done">产出就绪 ✓</div>
        : (clickable
            ? null
            : <div className="agent-node-wait">未配置跳转</div>)}
    </Tag>
  )
}
```

- [ ] **Step 3: 改 `AgentsPanel` 组件（183-236）用 `useStages`**

替换为：

```jsx
export function AgentsPanel({ userInput }) {
  const { stages, loading } = useStages()
  const find = (key) => stages.find(s => s.key === key)

  if (loading) {
    return (
      <div className="agents-panel">
        <div className="panel-header"><h2>智能体流水线</h2></div>
        <div className="panel-loading">加载中...</div>
      </div>
    )
  }

  const node = (key) => {
    const s = find(key)
    return <AgentNode id={key} status={s?.status} url={s?.url} />
  }

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <h2>智能体流水线</h2>
          <span className="panel-subtitle">用户输入 → 业务逻辑 → 并行(界面解析 / 数据抓取) → 生产交付</span>
        </div>
        <span className="panel-count">{stages.length} 个智能体</span>
      </div>

      <div className="panel-content">
        <div className="flow-canvas">
          <div className="flow-stage flow-stage--single">
            <UserInputNode userInput={userInput} />
          </div>
          <LinearConnector />
          <div className="flow-stage flow-stage--single">{node('agent-business')}</div>
          <SplitConnector />
          <div className="flow-stage flow-stage--parallel">
            {node('agent-prototype')}
            {node('agent-data')}
          </div>
          <MergeConnector />
          <div className="flow-stage flow-stage--single">{node('agent-production')}</div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 改 `AgentsPanel.css` —— 完成态 / 可点 / 灰显 / `<a>` 重置**

在 `.agent-node { ... }` 规则之后（约 221 行 `transition: all 0.3s ease; }` 之后）插入：

```css
a.agent-node {
  text-decoration: none;
  color: inherit;
}
.agent-node.is-clickable {
  cursor: pointer;
}
.agent-node.no-url {
  opacity: 0.6;
  cursor: default;
}
.agent-node.is-completed {
  border-color: rgba(127, 235, 155, 0.55);
  box-shadow: 0 0 0 1px rgba(127, 235, 155, 0.22), 0 8px 28px rgba(127, 235, 155, 0.14);
}
```

- [ ] **Step 5: 删 CSS 里的进度条样式（YAGNI）**

删除 `AgentsPanel.css` 中这四个规则块：`.agent-node-progress`、`.progress-track`、`.progress-fill`、`.progress-percent`、`@keyframes progressGlow`（约 444-477 行）。

- [ ] **Step 6: 构建 + 手测 checklist**

Run: `cd sf-portal && npm run build`
Expected: `dist/` 生成，无编译错误（`AgentNode`/`AgentsPanel` 用法正确，无未定义引用）。

手测（先不联调后端，只验构建过）：
- [ ] `npm run build` 成功，`dist/index.html` 存在。

- [ ] **Step 7: Commit**

```bash
git add sf-portal/src/components/AgentsPanel.jsx sf-portal/src/components/AgentsPanel.css
git commit -m "feat(sf-portal): AgentsPanel 改接口驱动两态 + 卡片跳转，删进度条"
```

---

## Task 5: 清理废弃代码

**Files:**
- Delete: `sf-portal/src/hooks/pipeline.js`
- Delete: `sf-portal/src/hooks/useAgents.js`
- Modify: `sf-portal/src/data/mockData.js`（删 `mockAgents`，保留 `mockApplications`）

- [ ] **Step 1: 确认无残留引用**

Run:
```bash
cd sf-portal && grep -rn "useAgents\|mockAgents\|pipeline\.js\|advanceAgentProgress\|advancePipeline" src
```
Expected: 无输出（AgentsPanel 已在 Task 4 改完，不再 import 这些）。若有输出 → 先清掉引用再继续。

- [ ] **Step 2: 删两个 hook 文件**

```bash
git rm sf-portal/src/hooks/pipeline.js sf-portal/src/hooks/useAgents.js
```

- [ ] **Step 3: 删 `mockData.js` 的 `mockAgents`，保留 `mockApplications`**

把 `src/data/mockData.js` 中从 `// 模拟智能体数据...` 注释起到文件末尾的整个 `mockAgents` 数组删掉，只保留顶部的 `mockApplications`。删除后文件结尾应是 `mockApplications` 数组的闭合 `]` 和 `export`。

具体：删除 `mockData.js` 第 40 行（空行+注释）到第 79 行（`]`）整段 `mockAgents` 导出。

- [ ] **Step 4: 构建确认无破坏**

Run: `cd sf-portal && npm run build && npm test`
Expected: build 成功；所有测试仍 PASS。

- [ ] **Step 5: Commit**

```bash
git add sf-portal/src/data/mockData.js
git commit -m "chore(sf-portal): 删废弃的 pipeline.js/useAgents.js/mockAgents"
```

---

## Task 6: 本地联调验证

**Files:** 无改动（验证-only）

- [ ] **Step 1: 本地起后端 + 前端产物**

```bash
cd sf-portal && npm run build && PORT=3000 npm start
```
（后台运行；server 在 :3000 serve dist + /api。）

- [ ] **Step 2: curl 验证接口**

```bash
curl -s http://127.0.0.1:3000/api/stages
# 期望：JSON，agent-business status=completed，其余 pending
curl -s -X POST http://127.0.0.1:3000/api/stages/agent-data -H 'Content-Type: application/json' -d '{"status":"completed"}'
# 期望：agent-data status=completed
curl -s http://127.0.0.1:3000/api/stages
# 期望：agent-data 现在 completed（且 server/stages.json 被改写）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/stages/agent-nope -H 'Content-Type: application/json' -d '{"status":"completed"}'
# 期望：400
```

> 注意：本地联调会把仓库里的 `server/stages.json` 改写。验证完用 `git checkout sf-portal/server/stages.json` 还原成初始版，避免把测试状态 commit。

- [ ] **Step 3: 浏览器验证**

打开 `http://127.0.0.1:3000`：
- [ ] 业务逻辑卡片显示「已完成 ✓」、绿色高亮、整卡可点 → 点击新标签打开 `https://115.190.228.77:18701`
- [ ] 界面解析卡片「待开始」、可点 → 点击打开 `http://220.154.5.91:18020`
- [ ] 数据抓取 / 生产交付 卡片灰显 + 「未配置跳转」、不可点
- [ ] 上一步 POST `agent-data` 完成后，≤5s 内数据抓取卡片变绿 ✓ 且可点（url 仍为空则只变 ✓ 不可点）

- [ ] **Step 4: 还原 stages.json + 停服**

```bash
git checkout sf-portal/server/stages.json
# 停掉 PORT=3000 的 node 进程
```

- [ ] **Step 5: Commit（仅在前序 task 有遗留改动时；通常本 task 无文件改动，跳过）**

如果一切干净，本 task 不产生 commit。

---

## Task 7: 部署到 .91（18002）

**Files:** 无仓库改动（线上操作 + 可能更新 memory）

**前置确认（用户）：** `agent-prototype` URL = `http://220.154.5.91:18020`（interface-agent）是否正确？`agent-data` / `agent-production` URL 是否提供？（若提供 → 先改 `server/stages.json` 再部署。）

- [ ] **Step 1: 本地准备部署包**

```bash
cd sf-portal
npm install        # 确保 express 装好
npm run build      # 产出 dist/
```

打包（含 server/、dist/、package.json、package-lock.json、node_modules）：
```bash
cd .. && tar -czf portal-node.tar.gz \
  -C sf-portal server dist package.json package-lock.json node_modules
```

- [ ] **Step 2: 备份线上现状 + 上传**

```bash
# 备份（在 .91 上）
ssh root@220.154.5.91 'cp -r /root/sf-portal /root/sf-portal.bak-$(date +%Y%m%d-%H%M%S)'
# 上传
scp portal-node.tar.gz root@220.154.5.91:/tmp/
```
（用 `sshpass`/paramiko 或交互密码 `dianziyun.1`。）

- [ ] **Step 3: 线上解包到 /root/sf-portal**

```bash
ssh root@220.154.5.91 'mkdir -p /root/sf-portal-node && tar -xzf /tmp/portal-node.tar.gz -C /root/sf-portal-node && ls /root/sf-portal-node'
```
期望看到 `server dist package.json package-lock.json node_modules`。

- [ ] **Step 4: 重建并启动容器（node 版）**

```bash
ssh root@220.154.5.91 <<'EOF'
podman stop sf-portal-pipeline 2>/dev/null || true
podman rm sf-portal-pipeline 2>/dev/null || true
podman run -d --name sf-portal-pipeline \
  -p 18002:80 \
  -v /root/sf-portal-node:/app:Z \
  -w /app \
  docker.io/library/node:20-alpine \
  node server/index.js
sleep 2
podman ps --format '{{.Names}} | {{.Status}} | {{.Ports}}' | grep sf-portal-pipeline
podman logs sf-portal-pipeline
EOF
```
期望日志出现 `sf-portal server on :80`。

> 说明：`:Z` 私有 SELinux 标签（podman rootless 常需要）；若 rootful 且无 SELinux 可去掉。镜像 `node:20-alpine` 若本地无缓存会自动 pull。

- [ ] **Step 5: 线上验证**

```bash
curl -s http://220.154.5.91:18002/api/stages
# 期望：4 阶段 JSON
curl -s http://220.154.5.91:18002/ | head -8
# 期望：<title>SF Portal</title> 的 index.html
curl -s -X POST http://220.154.5.91:18002/api/stages/agent-prototype -H 'Content-Type: application/json' -d '{"status":"completed"}'
# 期望：agent-prototype completed
```
浏览器打开 `http://220.154.5.91:18002/`，按 Task 6 Step 3 的 checklist 再过一遍。

- [ ] **Step 6: 更新 memory（[portal-frontend-is-sf-portal-mvp]）**

把 2026-07-02 那段里「nginx bake 进镜像」的描述订正为：「容器跑 `node:20-alpine`，bind mount `/root/sf-portal-node:/app`，`node server/index.js` 提供 `/api/stages` + serve `dist/`」。

- [ ] **Step 7: 收尾**

- 通知用户线上可访问 + 给出两条 curl（GET / POST）供其他模块对接。
- 本地 `rm portal-node.tar.gz` 清理。

---

## Self-Review（写完后自查结果）

1. **Spec 覆盖：** spec §1 架构 → Task 1-2；§2 接口契约 → Task 2（GET/POST + curl 在 Task 6/7 验证）；§3 前端 → Task 3-4；§4 URL → `stages.json`（Task 1 初始值）；§5 部署 → Task 7。全覆盖。
2. **占位符：** 无 TBD/TODO；每个 step 有具体命令/代码。
3. **类型/命名一致：** stage key 全程 `agent-business`/`agent-prototype`/`agent-data`/`agent-production`；`createStageStore`/`createApp`/`useStages`/`allCompleted` 跨 task 签名一致。
4. **spec 偏差：** plan 的 stage key 用真实 agent id（spec 用了逻辑别名 business/ui/data/delivery）—— 已在 Global Constraints 标注为实现细化；**需同步更新 spec §2/数据模型/URL 表的 key 命名**，保持 spec 与 plan 一致（见下）。

## 待同步：spec key 命名对齐

实现决定把 key 从 spec 的 `business`/`ui`/`data`/`delivery` 改为真实 agent id（`agent-business`/`agent-prototype`/`agent-data`/`agent-production`）以消除前端映射层。需用同样改动更新 `docs/superpowers/specs/2026-07-02-sf-portal-stage-status-design.md` 的：数据模型示例、curl 示例、URL 表。在本 plan 落盘后一并 commit。
