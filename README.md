# xian630 — 智能软件工厂

本地优先的智能软件工厂闭环：用户在门户用自然语言描述需求，系统通过对话澄清收敛需求，再由 factory-server 调用 Claude Code、npm 和容器运行时完成代码生成、构建、镜像化和部署。

## 核心服务

| 服务 | 目录 | 技术栈 | 说明 |
|---|---|---|---|
| **sf-portal-mvp** | `sf-portal-mvp/` | React 18 + Vite 6 | 智能软件工厂门户前端。用户在此对话、发起需求、查看任务执行进度和生成应用。左侧菜单含首页、智能体广场、智能体流水线。 |
| **factory-server** | `factory-server/` | Go + SQLite | 系统核心编排服务。创建对话、调用 Claude Code CLI、生成协作智能体计划、推进任务状态、构建和部署应用。是唯一的 Claude Code 调用者。 |
| **cc-status** | `cc-status/` | Go + SQLite | 观测旁路服务。通过 Claude Code hooks 记录 session、subagent、skill 和 background task 生命周期。 |
| **agent-pipeline** | `agent-pipeline/` | React + Vite + Express | 智能体流水线页面。可视化展示从用户需求到应用交付的完整链路（用户输入 → 业务逻辑 → 界面解析 → 数据抓取 → 生产交付），每个智能体卡片可点击跳转到对应服务。支持项目管理（新建/列表/删除，服务端持久化）。 |
| **interface-agent** | `interface-agent/` | Node.js + Express + DeepSeek | 界面解析智能体。接收上游需求，通过 DeepSeek 大模型生成符合 C2 军事指挥设计系统的前端原型界面，用户多轮调整后确认输出到 Blade OS。 |
| **deploy** | `deploy/` | Dockerfile + nginx + compose | 容器化部署配置。各服务的 Dockerfile、nginx 反向代理配置和部署脚本。 |

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

## 部署

所有核心服务通过 Podman 镜像 + 容器蓝绿部署：

| 服务 | 镜像 | 端口 |
|---|---|---|
| sf-portal-mvp | `localhost/sf-portal-mvp` | 8000 → 80 |
| factory-server | `localhost/factory-server` | 8787 |
| cc-status | `localhost/cc-status` | 8765 |
| agent-square | `localhost/agent-square` | 18016 → 80 |
| interface-agent | `localhost/interface-agent` | 18020 |
| agent-pipeline | `localhost/agent-pipeline` | 18002 |

> sf-portal-mvp / factory-server / cc-status 三者**统一版本**一起发布（共享 `/opt/xian630/active/VERSION` 与 `releases/<version>/`）；agent-square / interface-agent / agent-pipeline 为**独立版本**服务，各自单独构建发布。

每个服务目录下有各自的 `DEPLOYMENT.md` 说明部署步骤；统一部署规范见 [`deploy/ctyun/README.md`](./deploy/ctyun/README.md)。

## 其他目录

| 目录 | 说明 |
|---|---|
| `scene/` | 预设场景应用（航母追踪、东海态势、社情告警等），作为生成应用的参考蓝本 |
| `docs/` | 设计文档、实施计划、本地运维手册 |
| `generated-apps/` | factory-server 生成的应用代码（gitignore，不入版本控制） |
| `agent-square/` | 智能体广场（Agent Square）源码。线上 18016 的智能软件目录，由工厂产物提升为独立一等公民服务，镜像蓝绿部署，nginx njs 提供 `/api/apps` 运行时接口。 |
| `software-factory-course/` | 软件工厂课程材料 |

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
