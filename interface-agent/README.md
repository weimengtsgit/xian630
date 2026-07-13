# Interface Agent - 界面解析智能体

智能体流水线中的**界面解析智能体**，负责接收上游（业务逻辑智能体）传入的需求，通过 DeepSeek 大模型生成符合 C2 军事指挥设计系统的前端原型界面，用户可多轮调整后确认输出。

## 在流水线中的位置

```
用户输入 → 业务逻辑智能体 → 【界面解析智能体】 → 数据抓取智能体 → 生产交付智能体
                                  ↑ 本项目
```

- **上游**：业务逻辑智能体确认需求后，将需求写入共享文件（Blade OS），界面解析智能体轮询读取
- **下游**：用户确认原型后，界面解析智能体将 HTML 写入共享文件 + 回写流水线完成状态，供生产交付智能体使用

## 核心功能

| 功能 | 说明 |
|---|---|
| **AI 原型生成** | 调用 DeepSeek API，根据用户需求描述生成完整 HTML 原型（单文件自包含） |
| **C2 军事指挥设计系统** | 所有生成界面自动套用 C2 深色战术风格（深蓝底色 #0a0e14、科技青蓝强调 #38b6e6、密级横幅、态势卡等），由 `skills/c2-ui-system/style.md` 定义 |
| **多轮调整** | 用户可以在生成结果基础上继续提修改意见（如"改成浅色风""增加统计卡片"），模型基于当前 HTML 增量调整 |
| **文件服务集成** | 通过 Blade OS 文件服务读取上游待定需求、写入确认后的原型 HTML |
| **流水线状态回写** | 用户确认原型后，POST 回写流水线的界面解析阶段完成状态 |
| **预览分享** | 生成的原型可保存为预览链接，供团队查看 |

## 项目结构

```
interface-agent/
├── src/                        # 后端源码（Node.js + Express）
│   ├── server.js               # 入口：加载配置 + 启动服务
│   ├── app.js                  # Express 应用（路由 + 中间件 + 预览管理 + 流水线回写）
│   ├── config.js               # 配置加载（环境变量 + DeepSeek/BladeOS/流水线参数）
│   └── lib/
│       ├── deepseek.js         # DeepSeek 客户端（C2 样式 prompt 构造 + HTML 生成）
│       ├── bladeFiles.js       # Blade OS 文件服务客户端（读写共享文件）
│       ├── validation.js       # 请求校验（消息/历史/当前HTML）
│       ├── rateLimit.js        # 限流（滑动窗口）
│       └── html.js            # HTML 工具（提取/清洗）
├── public/                     # 前端源码（原型工作台 UI）
│   ├── index.html             # 页面结构（C2 密级横幅 + 预览区 + 会话区）
│   ├── app.js                 # 工作台逻辑（轮询待定输入 + 生成/调整 + 确认 + 分享）
│   └── styles.css             # C2 风格样式
├── skills/
│   └── c2-ui-system/          # C2 UI System 设计系统 skill
│       ├── SKILL.md           # skill 说明
│       ├── style.md           # 注入 DeepSeek prompt 的样式规范（设计令牌 + 组件目录 + 原则）
│       └── c2-ui-system.html  # 完整设计系统参考（740 行，活的组件展示墙）
├── test/                       # 测试
│   ├── app.test.js            # 基础路由测试
│   ├── public-ui.test.js      # C2 样式 UI 测试
│   ├── backend-extended.test.js  # 后端扩展测试（374 行）
│   └── frontend-extended.test.js # 前端扩展测试（130 行）
├── .env.example                # 环境变量模板
└── package.json
```

## API 接口

界面稿版本机制以"界面设计会话 + 不可变版本"为核心。所有写操作校验会话归属（HttpOnly Cookie 鉴权），`projectname` 只定位项目、不授权。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/pending-input` | 轮询读取上游写入的待定需求文件（旧轮询入口，保留兼容） |
| `GET` | `/api/auth/session` | 基于 Cookie 恢复当前会话（刷新页面用） |
| `POST` | `/api/auth/exchange` | 一次性启动码换签名的 HttpOnly 会话 Cookie |
| `POST` | `/api/auth/restore` | 用定向恢复码恢复独立会话并设置 Cookie（只校验一个会话，限流） |
| `POST` | `/api/interface-sessions/resolve` | 服务间：按 `projectKey` + 编辑凭证恢复或创建活跃会话（需 `X-Internal-Token` 创建） |
| `POST` | `/api/interface-sessions/independent` | 独立浏览器入口：直接创建会话并设置编辑 Cookie（限流，无需内部令牌） |
| `POST` | `/api/interface-sessions/:id/restart` | 归档当前会话并创建新活跃会话 |
| `GET` | `/api/interface-sessions/:id` | 读取会话摘要（确认版本、交付状态、版本数） |
| `GET`/`PATCH` | `/api/interface-sessions/:id/versions[/:versionId]` | 版本树元数据 / 版本详情 / 改标题 / 归档 |
| `GET` | `/api/interface-sessions/:id/versions/:versionId/preview`（兼容 `/html`） | 读取不可变版本 HTML（`Content-Security-Policy: sandbox allow-scripts`） |
| `POST` | `/api/interface-sessions/:id/generations` | 提交异步生成（202 返回 requestId；同幂等键返回已有请求） |
| `GET` | `/api/interface-sessions/:id/generations/:requestId` | 恢复生成进度与结果 |
| `POST` | `/api/interface-sessions/:id/confirmations` | 确认采用（乐观并发，过期返回 409；触发后台交付） |
| `POST`/`DELETE` | `/api/interface-sessions/:id/shares` / `/api/shares/:token` | 创建 / 撤销只读分享（固定到版本，可过期） |
| `GET` | `/api/shares/:token/preview` | 公共只读版本 HTML 预览（`sandbox allow-scripts`） |
| `POST` | `/api/interface-sessions/:id/deliveries/:deliveryId/retry` | 幂等重试交付 |
| `GET` | `/api/interface-sessions/:id/events` | 读取完整操作记录（已脱敏） |

> 说明：旧的 `POST /api/generate`、`POST /api/previews`、`GET /preview/:id` 已删除，分别由异步生成、分享 + 后台交付、版本 HTML 预览取代。

### 异步处理语义

- 生成和交付 worker 均采用可恢复的 at-least-once 执行；同一生成请求最多创建一个版本。
- 模型输出返回后立即写入 `staged_html`，已暂存的请求重启时不会再次调用模型。模型返回与本地写入之间仍有不可原子化的极窄窗口，严格模型调用 exactly-once 需要模型提供方支持幂等请求或可恢复流。
- 交付使用稳定的 `X-Idempotency-Key` 并记录 `notified_at`。HTTP 是否已被下游接受无法与本地 SQLite 原子提交，严格通知 exactly-once 要求下游按该键持久去重。

## 技术栈

- **后端**：Node.js + Express + Helmet（安全头）+ node-fetch
- **前端**：原生 JS + CSS（无框架），sandbox iframe 渲染原型
- **AI**：DeepSeek API（通过 Anthropic 兼容接口调用）
- **文件服务**：Blade OS（读写共享文件，与上游/下游通信）
- **样式**：C2 UI System（军事指挥态势感知深色设计系统，令牌驱动）

## 本地运行

### 前置
- Node.js 20+、npm
- DeepSeek API Key（生成原型必需）；Blade OS 地址 + PAT（读写共享文件必需，不配则文件读写相关功能不可用）

### 快速启动
```bash
npm install
npm run dev        # 文件变更自动重启；DB 默认落到 ./data/（自动创建，已 gitignore）
```
服务端口取自 `.env` 的 `PORT`（默认 3000；仓库 `.env` 常为 18020）。访问 `http://localhost:<PORT>/`。

SQLite 数据库默认路径为 `./data/interface-agent.db`（本地开发无需 root，开箱即用）。容器内由 Dockerfile `ENV INTERFACE_AGENT_DB_PATH` 固定为 `/var/lib/interface-agent/interface-agent.db`（持久卷），本地默认值不影响容器。如需自定义本地路径，设 `INTERFACE_AGENT_DB_PATH`。

> 直接 `npm run dev` 即可启动。启动时若 `INTERFACE_AGENT_INTERNAL_TOKEN` / `INTERFACE_AGENT_SESSION_SECRET` 未配，会打印告警（非致命），见下文。

### 配置 `.env`
```bash
cp .env.example .env   # 首次；已有 .env 可跳过
```
至少填 `DEEPSEEK_API_KEY`、`BLADE_OS_BASE_URL`、`BLADE_OS_PAT`、`CONFIRMED_OUTPUT_PATH`（如 `共享/prototype.html`）。

### 联调项目会话流程（可选）
若要在本地走通「从 agent-pipeline 打开 → 创建项目会话 → 编辑」的完整链路，还需在 `.env` 或命令行配：
```bash
INTERFACE_AGENT_SESSION_SECRET=dev-secret          # Cookie 签名密钥（不配则重启后 Cookie 失效）
INTERFACE_AGENT_INTERNAL_TOKEN=dev-internal         # resolve 创建项目会话的服务间密钥（须与 agent-pipeline 一致）
# 例：INTERFACE_AGENT_SESSION_SECRET=dev-secret INTERFACE_AGENT_INTERNAL_TOKEN=dev-internal npm run dev
```
未配时的告警含义：
- `INTERFACE_AGENT_INTERNAL_TOKEN` 未配 → resolve 创建项目会话 fail-closed（仅影响"经 agent-pipeline 创建项目会话"；独立会话入口不受影响）。
- `INTERFACE_AGENT_SESSION_SECRET` 未配 → 启动生成临时密钥，重启后会话 Cookie 失效（开发期可忽略）。

### 两种入口
- **项目会话**：经 agent-pipeline 用 `?start=<一次性启动码>` 打开（需 `INTERFACE_AGENT_INTERNAL_TOKEN` 与 agent-pipeline 一致才能联调）。
- **独立会话**：直接访问 `http://localhost:<PORT>/`，点"创建独立会话"（无需 INTERNAL_TOKEN；返回一次性恢复码，可换设备恢复）。

### 生产式启动（不自动重启）
```bash
npm start
```

## 部署

```bash
npm install --omit=dev
cp .env.example .env
# 编辑 .env
npm start
```

使用 pm2 守护：
```bash
pm2 start src/server.js --name interface-agent
pm2 save
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DEEPSEEK_API_KEY` | 空 | **必填**，DeepSeek API Key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名称 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流窗口（毫秒） |
| `RATE_LIMIT_MAX` | `20` | 单 IP 每窗口最大请求数 |
| `BLADE_OS_BASE_URL` | 空 | Blade OS 文件服务地址 |
| `BLADE_OS_PAT` | 空 | Blade OS Bearer PAT |
| `PENDING_INPUT_PATH` | 空 | 上游待定需求文件路径（如 `共享/pending.md`） |
| `CONFIRMED_OUTPUT_PATH` | 空 | 确认后写入的 HTML 文件路径（如 `共享/prototype.html`） |
| `PIPELINE_STAGE_COMPLETE_URL` | 空 | 确认原型后回写流水线完成状态的 URL |
| `PUBLIC_BASE_URL` | 空 | 预览分享链接的外部访问地址 |
| `INTERFACE_AGENT_DB_PATH` | 本地 `./data/interface-agent.db`；容器由 Dockerfile 固定为 `/var/lib/interface-agent/interface-agent.db` | SQLite 持久化路径（会话、版本树、生成请求、分享、交付）。容器生产必须挂载持久卷 `-v /var/lib/interface-agent:/var/lib/interface-agent`。 |
| `INTERFACE_AGENT_SESSION_SECRET` | 空（启动生成临时密钥并告警） | 会话 Cookie 的 HMAC-SHA256 签名密钥。**生产必配**固定强随机值（如 `openssl rand -base64 32`）；未配置则重启后所有会话 Cookie 失效。 |
| `INTERFACE_AGENT_INTERNAL_TOKEN` | 空（fail-closed） | resolve CREATE 的服务间共享密钥（`X-Internal-Token`）。**必须与 agent-pipeline 配置相同值**；未配置则拒绝所有会话创建。 |
| `INTERFACE_AGENT_COOKIE_SECURE` | `0` | 设为 `1` 时（HTTPS）给 Cookie 打 Secure 标志。 |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `20` | 独立会话入口 + 恢复码端点的单 IP 限流。 |
| `ARTIFACT_CLEANUP_ENABLED` | `1` | 孤立版本产物回收开关；设 `0` 关闭。 |
| `ARTIFACT_CLEANUP_INTERVAL_MS` | `21600000` | 周期回收间隔；设 `0` 关闭周期回收（启动一次性回收仍执行）。 |
| `ARTIFACT_CLEANUP_MAX_AGE_MS` | `3600000` | 回收的最小文件年龄（保护在途事务文件，**勿调小**）。 |

## 安全

- DeepSeek API Key 和 Blade OS PAT 只在服务端环境变量 / `.env` 中，不暴露给浏览器
- 生成内容在 sandbox iframe 中运行
- Helmet 安全头保护

## 测试

```bash
npm test
```
