# sf-portal 阶段状态接口与卡片跳转 设计

- 日期：2026-07-02
- 范围：`sf-portal/`（线上 `http://220.154.5.91:18002/`，podman 容器 `sf-portal-pipeline`，`0.0.0.0:18002->80/tcp`）
- 线上 18002 与本地的对应：线上产物 hash `index-DCxp8wlh.js` = 本地 `sf-portal/dist/assets/index-DCxp8wlh.js`，即线上就是本地 `sf-portal/` 的构建产物。

## 背景

`sf-portal` 是纯前端 React+Vite 单页（实验性流水线可视化），**不连任何后端**（无 API client、不连 factory-server 8787）。`AgentsPanel` 展示 4 阶段智能体（业务逻辑 / 界面解析 / 数据抓取 / 生产交付），现状用 `src/data/mockData.js` 的 `progress` 字段 + `src/hooks/pipeline.js`、`src/hooks/useAgents.js` 里的 `setInterval` 假递增，在 `AgentNode` 渲染 `progress-track / progress-fill / progress-percent` 假进度条。

## 目标 / 需求

1. **4 阶段卡片点击跳转**：`AgentsPanel` 的 4 个阶段卡片可点击，点击在新标签打开各自对应系统的 URL。
2. **接口驱动完成态**：新建后端接口返回 4 阶段状态；删掉假进度条；接口返回某阶段 `completed` 则标记该阶段完成。

### 非目标（YAGNI）

- 不做 `working` 中间态，阶段只有 `pending` / `completed` 两态。
- 不接 factory-server 真实 job/app 状态（本接口是独立 mock，由「其他模块」后续通过 POST 上报对接真实数据）。
- 不做接口鉴权（演示用）。
- 不动 `ApplicationsPanel`（应用卡片）——本次只改 `AgentsPanel`。

## 方案选型

用户在 A/B/C 三方案中选 **C：sf-portal 自带 node 后端（同源）**。

- A（独立小服务 :18021）：解耦最干净，但 +1 进程/端口。
- B（加进 interface-agent :18020）：零新进程，但把流水线状态耦合进原型工作台。
- **C（sf-portal 自带后端，同源 :18002/api/stages）**：前端零跨域、curl 与门户同址；代价是 `sf-portal` 部署链路要从「nginx 静态」重做为「node 服务」。

## 架构

`sf-portal` 从「纯静态」升级为「express 服务」：

- 新增 `server/index.js`：express，既 `express.static('dist')` serve 构建产物，又挂载 `/api/*` 路由。
- 线上容器 `sf-portal-pipeline`（现状 = 官方 `nginx:alpine` + bind mount `/root/sf-portal/{dist,nginx.conf}`）改为 `node:20-alpine` + bind mount 项目目录 + `node server/index.js`。**不建自建镜像**，沿用 bind mount 方式。
- 端口 18002 不变；`server/index.js` 里 `app.listen(process.env.PORT || 80)` 监听容器内 80，宿主映射 `18002->80` 不变。
- 前端 `fetch('/api/stages')` 同源，无跨域、无需 nginx 反代。

## 接口契约

- `GET /api/stages` → 返回 4 阶段状态。
- `POST /api/stages/:key`，body `{"status":"completed"}` → 其他模块上报某阶段完成，写入持久化文件 `server/stages.json`。非法 key / 非法 status → 400。
- 状态持久化在 `server/stages.json`（重启不丢；URL 也放这里，改 URL / 改状态不用改代码）。

### 返回示例

```json
{
  "stages": [
    {"key":"agent-business","name":"业务逻辑","status":"completed","url":"https://115.190.228.77:18701"},
    {"key":"agent-prototype","name":"界面解析","status":"pending","url":"http://220.154.5.91:18020"},
    {"key":"agent-data","name":"数据抓取","status":"pending","url":""},
    {"key":"agent-production","name":"生产交付","status":"pending","url":""}
  ]
}
```

### curl（交付给其他模块对接用）

```
curl http://220.154.5.91:18002/api/stages
curl -X POST http://220.154.5.91:18002/api/stages/agent-prototype \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed"}'
```

`key` 取值：`agent-business` / `agent-prototype` / `agent-data` / `agent-production`（与前端 agent id 一致，零映射；**注意界面解析 = `agent-prototype`**）。`status` 取值：`pending` / `completed`。

### 初始 mock 状态

`stages.json` 初始：`agent-business = completed`（业务逻辑链接已就绪），其余 `pending`。要演示某阶段完成，用上面 `POST` curl 上报，或直接改 `stages.json`。

## 数据模型（stages.json）

```json
{
  "stages": [
    {"key":"agent-business","name":"业务逻辑","status":"completed","url":"https://115.190.228.77:18701"},
    {"key":"agent-prototype","name":"界面解析","status":"pending","url":"http://220.154.5.91:18020"},
    {"key":"agent-data","name":"数据抓取","status":"pending","url":""},
    {"key":"agent-production","name":"生产交付","status":"pending","url":""}
  ]
}
```

`server/stages.js`：`createStageStore(filepath, initial)` → `{ read(), update(key, status) }`，内存 + 同步写盘；默认单例 `store` 用 `stages.json`。key 白名单 + status 白名单校验。

### 前后端字段归属

- **接口 / `stages.json` 提供**：`key` / `status` / `url`（+ `name` 冗余，方便 curl 阅读）。
- **前端 `AgentsPanel.jsx` 的 `AGENT_META` 提供（静态展示，按 agent id 关联）**：`name` / `type` / `icon` / `desc` / `detail`。
- `mockData.js` 的 `mockAgents` **整体删除**（不再用）；`mockApplications` 保留（`ApplicationsPanel` 在用）。

## 前端改动（都在 AgentsPanel）

### 删

- `AgentNode` 里进度条整块（`progress-track / progress-fill / progress-percent`）。
- `src/hooks/useAgents.js` 整文件、`src/hooks/pipeline.js` 整文件（假递增 + 依赖链启动）。
- `mockData.js` 的 `mockAgents`（保留 `mockApplications`）。

### 加

- `src/hooks/useStages.js`：`fetch('/api/stages')` → `{stages:[{key,name,status,url}]}`；进页面拉一次，之后每 `5s` 轮询；全部 `completed` 后 `clearInterval` 停轮询；返回 `{ stages, loading, error }`。
- `src/hooks/stagesLogic.js`：纯函数 `allCompleted(stages)`（用 `node:test` 覆盖）。
- `AgentNode({ id, status, url })`：两态 —— `completed`=绿色 ✓ + 边框高亮；`pending`=灰显。整卡可点击，用 `<a href={url} target="_blank" rel="noopener">`；`url` 为空 → 渲染 `<div>` 不可点 + 「未配置跳转」。
- `AGENT_META` 补 `name` / `type` 字段（原先只有 `icon` / `desc` / `detail`）。

## 卡片跳转 URL

URL 配置在 `server/stages.json`，前端不硬编码：

| key | 名称 | URL | 状态 |
|---|---|---|---|
| agent-business | 业务逻辑 | `https://115.190.228.77:18701` | 已提供 |
| agent-prototype | 界面解析 | `http://220.154.5.91:18020`（假设 = interface-agent，待用户确认） | 待确认 |
| agent-data | 数据抓取 | `""`（占位，用户未提供 → 卡片不可点） | 待提供 |
| agent-production | 生产交付 | `""`（占位，用户未提供 → 卡片不可点） | 待提供 |

未提供的 URL 在 `stages.json` 留空字符串，前端对该卡片禁用跳转。后续用户补 URL 只需改 `stages.json` 重启，无需改代码。

## 部署

- **线上现状（已查清）**：`sf-portal-pipeline` 跑官方 `docker.io/library/nginx:alpine`，bind mount `/root/sf-portal/dist → /usr/share/nginx/html` + `/root/sf-portal/nginx.conf → /etc/nginx/conf.d/default.conf`，`-p 18002:80`，无 compose、**无自建镜像**（本地 `deploy/Dockerfile.portal` 存在但线上未使用）。
- **改造**：本地 `npm run build` 出 `dist/`，打包 `server/` + `dist/` + `package*.json` + `node_modules` 上传到 `.91:/root/sf-portal-node/`；容器换成 `docker.io/library/node:20-alpine`，bind mount `/root/sf-portal-node:/app`，`node server/index.js`，`-p 18002:80` 不变。
- 验证通过后更新 memory [portal-frontend-is-sf-portal-mvp]。

## 验证

- **接口**：`curl http://220.154.5.91:18002/api/stages` 看到 4 阶段；`curl -X POST .../api/stages/agent-prototype -d '{"status":"completed"}'` 后再 GET 看到 `agent-prototype` 变 `completed`；`stages.json` 文件内容同步更新。
- **前端**：进 18002 页面，业务逻辑卡片显示 ✓ 且可点（跳 18701）；`agent-prototype` 待开始可点（跳 18020）；`agent-data` / `agent-production` 灰显不可点；POST 上报 `agent-prototype` 完成后，下一次轮询（≤5s）该卡片出现 ✓。
- **轮询停止**：4 阶段全 `completed` 后，浏览器 Network 面板不再有 `/api/stages` 请求。

## 文件改动清单

新增：
- `sf-portal/server/stages.json`、`sf-portal/server/stages.js`、`sf-portal/server/stages.test.js`
- `sf-portal/server/app.js`、`sf-portal/server/app.test.js`、`sf-portal/server/index.js`
- `sf-portal/src/hooks/stagesLogic.js`、`sf-portal/src/hooks/stagesLogic.test.js`、`sf-portal/src/hooks/useStages.js`

修改：
- `sf-portal/package.json`（`+express`，`scripts.start = "node server/index.js"`，`+test = "node --test"`，build 仍 `vite build`）
- `sf-portal/src/components/AgentsPanel.jsx`（`AgentNode` 两态 + 跳转；`AgentsPanel` 接 `useStages`；`AGENT_META` 补 name/type）
- `sf-portal/src/components/AgentsPanel.css`（完成态高亮 / no-url 灰显 / `a.agent-node` 重置；删进度条样式）

删除：
- `sf-portal/src/hooks/pipeline.js`
- `sf-portal/src/hooks/useAgents.js`
- `sf-portal/src/data/mockData.js` 中 `mockAgents`（保留 `mockApplications`）

## 待用户确认 / 后续提供

1. `agent-prototype` 卡片 URL 是否 = `http://220.154.5.91:18020`（interface-agent）。
2. `agent-data`、`agent-production` 卡片 URL（未提供则留空、卡片不可点）。

## 设计变更 v2（2026-07-02 实施中调整）

本地验证后用户调整了状态模型（取代上面 §接口契约 / §数据模型 / §前端改动 里的两态描述）：

- **三态流转**：`pending`（待处理）→ `working`（进行中）→ `completed`（已完成）。
- **状态只存后端内存，不写盘**：`stages.json` 只保留静态 `name` / `url`；运行状态默认 `pending`，服务重启或 reset 回全 pending。
- **新增 `POST /api/stages/reset`**：前端页面加载时调用（强刷清空 → 4 卡全回待处理）。
- **点击卡片**（`pending` 且有 url）：前端 `POST {status:"working"}` + `window.open(url)` 跳转；`working` 中不可点；`completed` 可点跳转产出。
- **上报完成**：其他模块 `POST /api/stages/:key {status:"completed"}`。
- 删掉了原「写盘持久化」设计；store 改纯内存 + `reset()`。
