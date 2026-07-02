# sf-portal 阶段状态接口与卡片跳转 设计

- 日期：2026-07-02
- 范围：`sf-portal/`（线上 `http://220.154.5.91:18002/`，podman 容器 `sf-portal-pipeline`，`0.0.0.0:18002->80/tcp`）
- 线上 18002 与本地的对应：线上产物 hash `index-DCxp8wlh.js` = 本地 `sf-portal/dist/assets/index-DCxp8wlh.js`，即线上就是本地 `sf-portal/` 的构建产物。

## 背景

`sf-portal` 是纯前端 React+Vite 单页（实验性流水线可视化），**不连任何后端**（无 API client、不连 factory-server 8787）。`AgentsPanel` 展示 4 阶段智能体（业务逻辑 / 界面解析 / 数据抓取 / 生产交付），现状用 `src/data/mockData.js` 的 `progress` 字段 + `src/hooks/pipeline.js`、`src/hooks/useAgents.js` 里的 `setInterval` 假递增，在 `AgentsPanel.jsx:90-94` 渲染 `progress-track / progress-fill / progress-percent` 假进度条。

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
- 容器 `sf-portal-pipeline` 从 nginx 静态改为 node：新 Dockerfile 基于 `node:alpine`，`CMD ["npm","start"]`。
- 端口 18002 不变；`server/index.js` 里 `app.listen(80)` 监听容器内 80，宿主端口映射 `18002->80` 与现 nginx 容器一致。
- 前端 `fetch('/api/stages')` 同源，无跨域、无需 nginx 反代。

## 接口契约

- `GET /api/stages` → 返回 4 阶段状态。
- `POST /api/stages/:key`，body `{"status":"completed"}` → 其他模块上报某阶段完成，写入持久化文件 `server/stages.json`。非法 key / 非法 status → 400。
- 状态持久化在 `server/stages.json`（重启不丢；URL 也放这里，改 URL / 改状态不用改代码）。

### 返回示例

```json
{
  "stages": [
    {"key":"business","name":"业务逻辑","status":"completed","url":"https://115.190.228.77:18701"},
    {"key":"ui","name":"界面解析","status":"pending","url":"http://220.154.5.91:18020"},
    {"key":"data","name":"数据抓取","status":"pending","url":""},
    {"key":"delivery","name":"生产交付","status":"pending","url":""}
  ]
}
```

### curl（交付给其他模块对接用）

```
curl http://220.154.5.91:18002/api/stages
curl -X POST http://220.154.5.91:18002/api/stages/ui \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed"}'
```

`key` 取值：`business` / `ui` / `data` / `delivery`。`status` 取值：`pending` / `completed`。

### 初始 mock 状态

`stages.json` 初始：`business = completed`（业务逻辑链接已就绪），其余 `pending`。要演示某阶段完成，用上面 `POST` curl 上报，或直接改 `stages.json`。

## 数据模型（stages.json）

```json
{
  "stages": [
    {"key":"business","name":"业务逻辑","status":"completed","url":"https://115.190.228.77:18701"},
    {"key":"ui","name":"界面解析","status":"pending","url":""},
    {"key":"data","name":"数据抓取","status":"pending","url":""},
    {"key":"delivery","name":"生产交付","status":"pending","url":""}
  ]
}
```

`server/stages.js`：启动时读 `stages.json` 到内存；`GET` 返回内存；`POST` 更新内存 + 写回文件（同步写，避免并发丢；演示量级够）。key 校验白名单。

### 前后端字段归属

- **接口 / `stages.json` 提供（动态）**：`key` / `name` / `status` / `url`。
- **前端 `mockData.js` 保留（静态展示，按 `key` 关联）**：`type` / `detail` 等渲染字段；仅删 `progress`。
- `useStages` 取接口数据后，在 `AgentsPanel` 按 `key` 与 `mockData` 静态字段合并渲染；`name` 两边都有时以接口返回为准。

## 前端改动（都在 AgentsPanel）

### 删

- `AgentsPanel.jsx:90-94` 的 `progress-track / progress-fill / progress-percent` 整块。
- `src/hooks/useAgents.js` 里的 `setInterval` 假递增（`advanceAgentProgress` / `advancePipeline` 调用）。
- `src/hooks/pipeline.js` 整文件（`advanceAgentProgress` / `advancePipeline` / `getAgentProgressIncrement` 仅被 `useAgents.js` 用，确认无其他引用后删）。
- `mockData.js` 里 4 智能体的 `progress` 字段（`status` 由接口来；`name/type/icon/detail` 等静态展示字段保留或并入接口返回）。

### 加

- 新 hook `src/hooks/useStages.js`：
  - `fetch('/api/stages')` → `{ stages: [{key,name,status,url}] }`
  - 进页面拉一次，之后每 `5s` 轮询；全部 `completed` 后 `clearInterval` 停轮询。
  - 返回 `{ stages, loading, error }`。
- `AgentsPanel` 用 `useStages` 取到的 `status` 驱动卡片状态，不再用 `useAgents` 的 `progress`。
- 完成态视觉（仅两态）：
  - `completed` → 卡片标题区绿色 ✓ 徽标 + 边框高亮。
  - `pending` → 灰显（降低不透明度 / 灰边框）。
- 跳转：整卡可点击，用 `<a href={url} target="_blank" rel="noopener">`；`url` 为空字符串时卡片不可点（`pointer-events:none` 或不渲染 `<a>`，仅灰显 + 「未配置」提示）。

## 卡片跳转 URL

URL 配置在 `server/stages.json`，前端不硬编码：

| key | 名称 | URL | 状态 |
|---|---|---|---|
| business | 业务逻辑 | `https://115.190.228.77:18701` | 已提供 |
| ui | 界面解析 | `http://220.154.5.91:18020`（假设 = interface-agent，待用户确认） | 待确认 |
| data | 数据抓取 | `""`（占位，用户未提供 → 卡片不可点） | 待提供 |
| delivery | 生产交付 | `""`（占位，用户未提供 → 卡片不可点） | 待提供 |

未提供的 URL 在 `stages.json` 留空字符串，前端对该卡片禁用跳转。后续用户补 URL 只需改 `stages.json` 重启，无需改代码。

## 部署

- 摸清 `sf-portal-pipeline` 镜像当前怎么 build 的（factory image_build 流程产物？还是独立 Dockerfile？）—— 实现阶段第一步查清。
- 重做镜像为 node 版：新 Dockerfile（`FROM node:<lts>-alpine`，`WORKDIR /app`，`COPY package*.json ./`，`npm ci --omit=dev`，`COPY . .`，`RUN npm run build`，`EXPOSE 80`，`CMD ["npm","start"]`）。该 Dockerfile **替换** `sf-portal-pipeline` 现有镜像构建方式（实现阶段先查清当前是 factory image_build 产物还是独立 Dockerfile，再据其替换）。
- 推到 `.91`，重建并重启 `sf-portal-pipeline` 容器，18002 端口映射不变。
- `server/index.js` 的 `express.static` 指向 `dist/`（构建产物），生产环境 serve 产物 + API。

## 验证

- **接口**：`curl http://220.154.5.91:18002/api/stages` 看到 4 阶段；`curl -X POST .../api/stages/ui -d '{"status":"completed"}'` 后再 GET 看到 `ui` 变 `completed`；`stages.json` 文件内容同步更新。
- **前端**：进 18002 页面，业务逻辑卡片显示 ✓ 且可点（跳 18701）；未配置 URL 的卡片灰显不可点；POST 上报 `ui` 完成后，下一次轮询（≤5s）`ui` 卡片出现 ✓ 且可点跳 18020。
- **轮询停止**：4 阶段全 `completed` 后，浏览器 Network 面板不再有 `/api/stages` 请求。

## 文件改动清单

新增：
- `sf-portal/server/index.js`（express 入口，serve dist + /api）
- `sf-portal/server/stages.js`（GET/POST 路由 + stages.json 读写）
- `sf-portal/server/stages.json`（持久化状态 + URL）
- `sf-portal/src/hooks/useStages.js`（fetch + 轮询 hook）
- `sf-portal/Dockerfile`（node 版，替换或新建）

修改：
- `sf-portal/package.json`（`+express`，`scripts.start = "node server/index.js"`，build 仍 `vite build`）
- `sf-portal/src/components/AgentsPanel.jsx`（删进度条；加 ✓ 徽标 / 灰显；卡片 `<a>` 跳转；改用 `useStages`）
- `sf-portal/src/components/AgentStatus.css`（完成态/灰显样式）
- `sf-portal/src/hooks/useAgents.js`（删 setInterval 假递增；或整体由 `useStages` 取代，保留静态字段读取）
- `sf-portal/src/data/mockData.js`（删 `progress` 字段）

删除：
- `sf-portal/src/hooks/pipeline.js`（确认仅 useAgents 引用后删）

## 待用户确认 / 后续提供

1. 界面解析卡片 URL 是否 = `http://220.154.5.91:18020`（interface-agent）。
2. 数据抓取、生产交付 卡片 URL（未提供则留空、卡片不可点）。
3. `sf-portal-pipeline` 镜像当前 build 方式（实现阶段查清后定 Dockerfile 改法）。
