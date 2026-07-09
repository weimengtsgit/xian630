# xian630 — 智能软件工厂

本地优先的智能软件工厂闭环：用户在门户用自然语言描述需求，系统通过对话澄清收敛需求，再由 factory-server 调用 Claude Code、npm 和容器运行时完成代码生成、构建、镜像化和部署。

## 目录说明

> 线上发布分两类：**sf-portal-mvp / factory-server / cc-status** 三者**统一版本**一起发布（共享 `/opt/xian630/active/VERSION` 与 `releases/<version>/`）；**agent-square / interface-agent / agent-pipeline** 为**独立版本**服务，各自单独构建发布。统一部署规范见 [`deploy/ctyun/README.md`](./deploy/ctyun/README.md)，各服务另有 `DEPLOYMENT.md`。

### sf-portal-mvp/

- **说明**：智能软件工厂门户前端（React 18 + Vite 6）。用户在此对话、发起需求、查看任务执行进度和生成应用。左侧菜单：首页、智能体广场、智能体流水线。构建产物由 nginx 托管，并把 `/api` 反代到 factory-server。
- **本地启动**：`npm install && npm run dev`（Vite，http://localhost:3001）。需连本地 factory-server：默认走同源 `/api`，或用构建参数/环境变量 `VITE_FACTORY_API_BASE_URL` 指向后端地址。
- **线上部署**：镜像 `localhost/sf-portal-mvp:<ver>`，端口 **8000→80**，`sf_default` 网络；统一三服务之一。Dockerfile：`deploy/Dockerfile.portal`。

### factory-server/

- **说明**：系统核心编排服务（Go + SQLite）。创建对话、调用 Claude Code CLI、生成协作智能体计划、推进任务状态、构建和部署应用——**唯一的 Claude Code 调用者**。
- **本地启动**：`go run ./cmd/factory-server`（监听 127.0.0.1:8787）。关键 env：`FACTORY_ADDR`、`FACTORY_DBPATH`（默认 `/tmp/software-factory.db`）；需本机已安装 Claude Code CLI 与 podman。
- **线上部署**：镜像 `localhost/factory-server:<ver>`，端口 **8787（仅内部）**，`sf_default`；挂载 `sf_sf-data`/`sf_sf-apps`/`sf_sf-claude` 卷与宿主机 podman socket。统一三服务之一。

### cc-status/

- **说明**：观测旁路服务（Go + SQLite）。通过 Claude Code hooks 记录 session、subagent、skill、background task 生命周期，并以 SSE 对外提供。
- **本地启动**：`go run ./cmd/cc-status`（监听 127.0.0.1:8765）。env：`CC_STATUS_*` / `XIAN630_*`（日志路径、容量等）。
- **线上部署**：镜像 `localhost/cc-status:<ver>`，端口 **8765（仅内部）**，`sf_default`；数据卷 `/opt/xian630/apps/cc-status/{data,logs}`。统一三服务之一。

### agent-square/

- **说明**：智能体广场（React + Vite + TS，线上 18016）。智能软件目录，nginx njs 提供 `/api/apps` 运行时应用接口（含"光鱼"等动态注册智能体）。已从工厂生成产物提升为独立一等公民服务。
- **本地启动**：`npm install && npm run dev`（Vite，http://localhost:5173，**不含** `/api/apps`）；完整本地预览（含 `/api/apps` 模拟与运行时数据）：`npm run build && npm run preview:local`（http://localhost:18016）。
- **线上部署**：镜像 `localhost/agent-square:<ver>`，端口 **18016→80**，`sf_default`；njs 烘进镜像，`runtime-apps.json` 持久卷 `/opt/xian630/apps/agent-square/data`。独立版本服务。详见 `agent-square/DEPLOYMENT.md`。

### agent-pipeline/

- **说明**：智能体流水线页面（React + Vite + Express）。可视化展示从用户需求到应用交付的完整链路（用户输入 → 业务逻辑 → 界面解析 → 数据抓取 → 生产交付），每个智能体卡片可点击跳转对应服务；支持项目管理（新建/列表/删除，服务端持久化）。
- **本地启动**：`npm install && npm run dev`（Vite 前端，http://localhost:3001）；后端 API 单独 `npm start`（`node server/index.js`）。
- **线上部署**：镜像 `localhost/agent-pipeline:<ver>`，端口 **18002→3000**；独立版本服务。详见 `agent-pipeline/DEPLOYMENT.md`。

### interface-agent/

- **说明**：界面解析智能体（Node + Express + DeepSeek）。接收上游需求，通过 DeepSeek 生成符合 C2 军事指挥设计系统的前端原型界面，用户多轮调整后确认输出到 Blade OS 文件服务。
- **本地启动**：`npm install && npm start`（`node src/server.js`，端口 18020）或 `npm run dev`（watch 模式）；需配置 `.env`（DeepSeek / Blade OS key 等，模板见 `.env.example`）。
- **线上部署**：镜像 `localhost/interface-agent:<ver>`，端口 **18020**；独立版本服务。详见 `interface-agent/DEPLOYMENT.md`。

### deploy/

- **说明**：容器化部署配置。各服务 Dockerfile（`Dockerfile.portal`/`Dockerfile.factory`/`Dockerfile.cc-status`）、nginx 反代（`deploy/nginx/`）、`compose.yaml`、网关（`gateways/`）、以及 CTYun 生产部署规范（`ctyun/`）。
- **本地启动**：配置目录，无可启动服务。可在 `deploy/` 下 `podman compose up -d --build` 一键起 factory + portal 本地全栈。
- **线上部署**：生产部署规范（目录结构、版本号、构建、网络、蓝绿、回滚）见 `deploy/ctyun/README.md`。

### docs/

- **说明**：设计文档、ADR、实施计划、本地运维手册（软件工厂 MVP 设计、澄清 runner、interface-agent 文件契约、场景预设等）；含 Blade OS 文件 API 参考 + Python 客户端（[`docs/blade-os-file-api/`](./docs/blade-os-file-api/)）。
- **本地启动**：纯文档目录，无需启动。
- **线上部署**：不部署。系统实现原理见 `docs/software-factory-mvp-design.md`，本地运维见 `docs/software-factory-local-runbook.md`。

### generated-apps/

- **说明**：factory-server 生成应用的工作区（每个应用的源码 + podman build 上下文 + 历史版本）。`.gitignore` 忽略，**不入版本控制**。
- **本地启动**：由 factory-server 在生成任务中产出，非独立可启项目。
- **线上部署**：工厂构建后作为镜像构建上下文，最终发布为 18000–18020 各端口容器（如航母追踪、态势看板等 `sf-*` 应用）。

### scene/

- **说明**：预设场景应用（9 个：航母追踪、舰载机归属、甲板风、编成重放、母港潮汐窗口等），作为生成应用的参考蓝本与成品样板。
- **本地启动**：各场景独立（多为静态页 + nginx）；可在各子目录内单独构建运行。
- **线上部署**：部分场景已发布为线上应用（`sf-*` 容器，占用 18000–18015 等端口）。

## 流水线架构

```
用户在 sf-portal-mvp 对话输入需求
    ↓
factory-server 编排协作智能体流水线：
    用户输入 → 业务逻辑智能体 → 界面解析智能体 → 数据抓取智能体 → 生产交付智能体
                              (interface-agent)
    ↓
代码生成 → npm build → Podman/Docker 镜像 → 容器部署 → 健康验证
```

各智能体服务的跳转地址：
- 业务逻辑：https://115.190.228.77:18701/
- 界面解析：http://220.154.5.91:18020/ （interface-agent）
- 数据抓取：http://203.83.238.87:8099/
- 生产交付：http://115.190.152.1:8020/p/9/chat/2026-0611-1207-4k6u

## 技术栈

- **前端**：React 18 + Vite 6 + Lucide Icons
- **后端编排**：Go 1.26 + SQLite
- **LLM 执行**：本地 Claude Code CLI（子进程调用）
- **AI 原型生成**：DeepSeek API（C2 军事指挥设计系统）
- **观测**：cc-status（hooks → SSE）
- **构建部署**：npm + Podman/Docker + nginx
- **数据**：SQLite（factory-server + cc-status）、Blade OS 文件服务（智能体间共享文件）

## 系统原理

详细的系统实现原理（服务边界、数据流、Claude Code 调用机制、多协作智能体执行模型、流式事件分层、部署结构）见：[软件工厂系统实现原理说明](./docs/software-factory-mvp-design.md)
