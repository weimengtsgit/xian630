# 智能软件工厂 MVP 设计

## 1. 目标

智能软件工厂提供一个统一入口，让用户通过对话描述想要的应用，系统按阶段调用本地 Claude Code CLI 的 subagent 和 skills，生成项目目录、代码和运行配置，再通过 Podman 构建部署，最终在门户中以应用卡片形式打开运行态应用。

MVP 的目标是打通一条本地单用户闭环：

1. 用户在门户对话框输入应用需求。
2. Factory 创建生成任务，并按固定阶段串行执行。
3. Claude Agent 负责需求分析、方案设计和代码生成。
4. Factory 负责测试、构建、Podman 部署和状态持久化。
5. 生成应用写入 `generated-apps/<app-slug>/`。
6. 预置应用从 `scene/*/.factory/app.json` 导入。
7. 门户展示应用、任务、Agent 和运行详情。

## 2. MVP 边界

MVP 只支持本地单机、单用户、前端可视化应用模板。后端服务采用 Go + SQLite，门户采用 React/Vite。

MVP 做：

- 对话驱动创建应用生成任务。
- 单任务串行执行。
- 阶段级状态机和阶段级重试。
- 预置应用和生成应用统一注册。
- 静态前端应用的 npm 构建校验。
- Dockerfile + Nginx 静态服务镜像构建。
- Podman 本地启动/停止容器。
- 通过 `cc-status` 展示 Claude session、subagent、skill 运行详情。

MVP 不做：

- 多用户、权限、登录。
- 云端部署。
- 多任务并行执行。
- 在线编辑 Agent prompt。
- 自动修复循环。
- 复杂工作流编排引擎。
- 真实军事数据源接入。

## 3. 总体架构

```text
sf-portal
  |
  | HTTP + SSE
  v
factory-server
  |
  | HTTP
  v
cc-status

factory-server also owns:
- SQLite: Factory 业务状态
- scene/: 预置应用
- generated-apps/: 生成应用
- .factory-runs/: 任务审计产物
- Claude Runner
- Podman Runner
```

服务边界：

- `cc-status` 是观察系统，只负责采集和查询 Claude Code 的 session、subagent、skill、background task 运行状态。
- `factory-server` 是编排系统，负责创建任务、推进状态、写文件、执行构建、部署容器。
- `sf-portal` 是用户入口，展示应用、对话、任务、Agent 和运行日志。

`cc-status` 是可选观测依赖。Factory 查询 `cc-status` 失败时：

- Job 和 Step 不因此失败。
- UI 展示“运行详情暂不可用”。
- Step 记录 `error_code=cc_status_unavailable` 或 warning artifact。
- 后续 SSE/轮询恢复后再补充展示运行详情。

默认端口：

- `cc-status`: `127.0.0.1:8765`
- `factory-server`: `127.0.0.1:8787`
- `sf-portal`: Vite dev server 端口

默认数据库：

```text
~/.software-factory/state.db
```

## 4. 用户生成任务状态机

MVP 采用“默认自动继续，可暂停确认”的策略。

- 如果当前阶段产物置信度足够，自动进入下一阶段。
- 如果阶段产物声明 `needsUserInput=true`，任务进入等待用户状态。
- 用户补充后从当前阶段继续。
- 失败不自动回滚，不自动整单重跑。
- 用户可以重试当前失败阶段。

Job 状态：

```ts
type JobStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting_user"
  | "failed"
  | "completed"
  | "canceled"
```

Step 状态：

```ts
type StepStatus =
  | "pending"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled"
```

固定 Step 顺序：

```ts
[
  "requirement_analysis",
  "solution_design",
  "code_generation",
  "test_verification",
  "image_build",
  "deployment"
]
```

Step 与执行方映射：

| Step | agent_key | 执行方 | 说明 |
|------|-----------|--------|------|
| `requirement_analysis` | `requirement-analyst` | Claude Runner | 产出需求摘要、假设、澄清问题 |
| `solution_design` | `solution-designer` | Claude Runner | 产出页面、组件、数据模型和文件计划 |
| `code_generation` | `code-generator` | Claude Runner | 写入 `generated-apps/<slug>/` 代码和 manifest |
| `test_verification` | `tester` | Factory 命令为主，Claude 可选分析失败日志 | Factory 执行依赖安装、构建和契约检查 |
| `image_build` | `deployer` | Factory 命令 | Factory 执行固定 Podman build 命令 |
| `deployment` | `deployer` | Factory 命令 | Factory 分配端口、启动容器、做健康检查 |

`agent_key` 用于 UI 展示和审计归属，不代表每个 Step 都会启动 Claude CLI。`test_verification`、`image_build`、`deployment` 的关键命令由 Factory 固定执行，不能由 Claude 自由拼接命令。

状态转移规则：

```text
Job created -> queued
executor lock acquired -> running
current step pending -> running
current step succeeded -> next step running
current step waiting_user -> job waiting_user
user answered -> current step running
current step failed -> job failed
retry current step -> same step running, attempt + 1
deployment succeeded -> job completed
user canceled -> job canceled
waiting_user canceled -> job canceled, current step canceled
```

MVP 只允许一个 active job。当前 Job 运行时，新需求可以保存为草稿或进入等待队列，但不会打断正在执行的任务。

用户可以在 `queued`、`running`、`waiting_user`、`failed` 状态取消 Job。取消时：

- Job 进入 `canceled`。
- 当前 Step 进入 `canceled`。
- 如果 Claude Runner 进程仍在运行，Factory 终止该进程。
- 已完成的 artifact 保留，未完成 attempt 写入取消日志。

## 5. 阶段契约

每个阶段必须输出结构化 JSON。Factory 不通过自然语言判断阶段是否成功。

阶段成功的基本条件：

- Runner 进程 exit code 为 0。
- `output.json` 存在。
- JSON schema 校验通过。
- 阶段要求的文件、目录或命令结果存在。
- `needsUserInput` 决定是否暂停等待用户。

阶段失败统一落到 Step `failed`，并记录机器可读 `error_code`：

```text
runner_exit_nonzero        Claude Runner 非 0 退出
runner_timeout             Claude Runner 超时
output_missing             缺少 output.json
output_invalid_json        output.json 不是合法 JSON
schema_validation_failed   output.json 不满足阶段 schema
file_constraint_violated   读写路径或产物路径违反约束
dependency_install_failed  npm install/npm ci 失败
build_failed               npm run build 失败
image_build_failed         podman build 失败
podman_run_failed          podman run 失败
port_unavailable           端口分配失败
health_check_failed        部署后 HTTP 健康检查失败
cc_status_unavailable      cc-status 查询失败，Job 不因此失败
canceled                   用户取消
unknown                    未分类错误
```

### 5.1 requirement_analysis

目标：把用户自然语言需求整理为生成应用的明确需求。

输出示例：

```json
{
  "summary": "展示航母编队近一个月航行轨迹和事件的地图复盘应用",
  "appType": "timeline-replay",
  "targetUsers": ["态势分析人员", "指挥值班人员"],
  "pages": [
    {
      "name": "主态势页",
      "purpose": "展示近一个月航母编队航迹、事件点和时间轴"
    }
  ],
  "dataAssumptions": ["使用模拟数据", "地图范围为东海"],
  "constraints": ["前端可视化应用", "React + Vite + MapLibre"],
  "risks": ["真实数据源未接入"],
  "needsUserInput": false,
  "questions": []
}
```

需要澄清时：

```json
{
  "needsUserInput": true,
  "questions": [
    {
      "id": "time_range",
      "question": "航迹时间范围要展示多久？",
      "defaultAnswer": "近 1 个月"
    }
  ]
}
```

### 5.2 solution_design

目标：把需求变成可执行的前端项目设计和文件计划，不直接写代码。

输出示例：

```json
{
  "app": {
    "slug": "carrier-formation-monthly-replay",
    "name": "航母编队月度航迹复盘",
    "type": "timeline-replay",
    "description": "展示航母编队近一个月航迹、事件点和复盘时间轴"
  },
  "techStack": {
    "framework": "React",
    "bundler": "Vite",
    "language": "TypeScript",
    "mapEngine": "MapLibre",
    "styling": "plain CSS"
  },
  "routes": [
    {
      "path": "/",
      "name": "主页面",
      "purpose": "展示地图、航迹、事件、时间轴和详情面板"
    }
  ],
  "layout": {
    "shell": "dark-tactical-dashboard",
    "regions": [
      "top_bar",
      "left_app_panel",
      "map_canvas",
      "right_detail_panel",
      "bottom_timeline"
    ]
  },
  "components": [
    {
      "name": "FleetMapCanvas",
      "purpose": "渲染地图底图、航线、舰队点位和事件标记"
    },
    {
      "name": "MonthTimeline",
      "purpose": "展示一个月时间轴并支持切换日期"
    }
  ],
  "dataModel": {
    "entities": ["FleetPoint", "FleetEvent", "FormationShip"],
    "mockDataFiles": ["src/features/fleet/data/mockFleet.ts"]
  },
  "artifactPlan": {
    "projectDir": "generated-apps/carrier-formation-monthly-replay",
    "manifestPath": ".factory/app.json",
    "expectedFiles": [
      "package.json",
      "src/main.tsx",
      "src/app/App.tsx",
      "src/styles/global.css",
      "Dockerfile",
      "nginx.conf"
    ]
  },
  "acceptanceCriteria": [
    "页面首屏直接展示地图和航迹",
    "用户可以选择时间点查看事件",
    "npm run build 成功",
    ".factory/app.json 存在且 source=generated"
  ],
  "needsUserInput": false,
  "questions": []
}
```

### 5.3 code_generation

目标：写入 `generated-apps/<slug>/` 项目代码，并生成应用 manifest。

输出示例：

```json
{
  "projectDir": "generated-apps/carrier-formation-monthly-replay",
  "manifestPath": "generated-apps/carrier-formation-monthly-replay/.factory/app.json",
  "createdFiles": [
    "package.json",
    "src/main.tsx",
    "src/app/App.tsx",
    "Dockerfile",
    "nginx.conf"
  ],
  "modifiedFiles": [],
  "commandsSuggested": ["npm install", "npm run build"],
  "notes": ["使用模拟舰队和事件数据", "地图范围默认东海"],
  "needsUserInput": false,
  "questions": []
}
```

约束：

- 可以写 `generated-apps/<slug>/**`。
- 不允许改 `scene/**`。
- 必须生成 `.factory/app.json`。
- 不负责执行 Podman 部署。

### 5.4 test_verification

目标：证明生成项目至少能构建，并满足应用契约。

Factory 在该阶段固定执行：

1. 校验 `.factory/app.json` 存在且字段合法。
2. 安装依赖：如果存在 `package-lock.json`，执行 `npm ci`；否则执行 `npm install`。
3. 执行 `npm run build`。
4. 校验 `build.outputDir` 存在，且静态入口文件存在。

依赖安装和构建命令的 stdout/stderr 都写入当前 attempt artifact。Claude tester Agent 不负责执行命令，只在失败后可选分析日志并生成诊断摘要。

输出示例：

```json
{
  "projectDir": "generated-apps/carrier-formation-monthly-replay",
  "checks": [
    {
      "name": "manifest_exists",
      "status": "passed",
      "message": ".factory/app.json exists"
    },
    {
      "name": "manifest_schema",
      "status": "passed",
      "message": "source=generated, entry=static-vite"
    },
    {
      "name": "dependency_install",
      "status": "passed",
      "command": "npm ci",
      "durationMs": 9100
    },
    {
      "name": "npm_build",
      "status": "passed",
      "command": "npm run build",
      "durationMs": 1840
    },
    {
      "name": "dist_exists",
      "status": "passed",
      "message": "dist/index.html exists"
    }
  ],
  "passed": true,
  "summary": "构建和应用契约检查通过",
  "needsUserInput": false,
  "questions": []
}
```

失败时：

```json
{
  "passed": false,
  "checks": [
    {
      "name": "npm_build",
      "status": "failed",
      "command": "npm run build",
      "message": "TypeScript error in src/app/App.tsx"
    }
  ],
  "suggestedRetryStep": "code_generation",
  "needsUserInput": false,
  "questions": []
}
```

测试失败时，Job 默认停在 `test_verification`。UI 可以建议用户回退重试 `code_generation`，但 MVP 不自动修复。

### 5.5 image_build

目标：由 Factory 执行固定 Podman 构建命令。

输出示例：

```json
{
  "projectDir": "generated-apps/carrier-formation-monthly-replay",
  "image": {
    "name": "software-factory/carrier-formation-monthly-replay",
    "tag": "job-20260618-001",
    "fullName": "localhost/software-factory/carrier-formation-monthly-replay:job-20260618-001"
  },
  "command": "podman build -t localhost/software-factory/carrier-formation-monthly-replay:job-20260618-001 .",
  "status": "succeeded",
  "durationMs": 12600
}
```

失败时记录 stdout/stderr，并停在 `image_build`。

### 5.6 deployment

目标：由 Factory 分配端口、启动容器、写入部署记录。

端口分配策略：

- 默认端口池为 `18000-18999`。
- Factory 在 SQLite 事务中选择未被 `deployments` 占用的端口。
- 选择后用本机监听探测确认端口未被其他进程占用。
- 如果冲突，最多重试 20 个候选端口。
- 仍无法分配时，Step 失败并记录 `error_code=port_unavailable`。
- Factory 启动时对 `running` deployment 做重建索引：容器不存在或端口不可访问时标记为 `failed` 或 `stopped`，释放端口占用。

启动容器后必须做健康检查：

- 对 `http://127.0.0.1:{hostPort}` 发起 HTTP GET。
- 10 秒内返回 `200-399` 才能把 deployment 和 application 标记为 `running`。
- 健康检查失败时，Step 失败并记录 `error_code=health_check_failed`。
- 健康检查失败后，Factory 默认停止并移除本次新建容器，避免留下半运行实例。

输出示例：

```json
{
  "deployment": {
    "id": "dep_01",
    "appSlug": "carrier-formation-monthly-replay",
    "image": "localhost/software-factory/carrier-formation-monthly-replay:job-20260618-001",
    "containerName": "sf-carrier-formation-monthly-replay-001",
    "hostPort": 18321,
    "containerPort": 80,
    "url": "http://127.0.0.1:18321",
    "status": "running"
  }
}
```

部署成功后：

- Job 进入 `completed`。
- App 进入 `running`。
- 应用卡片展示“打开应用”。

## 6. 重试与产物保留

重试当前阶段时，允许覆盖该阶段负责的工作区文件，但必须保留每次 attempt 的审计产物和日志。

可覆盖工作区产物：

```text
generated-apps/<slug>/src/**
generated-apps/<slug>/package.json
generated-apps/<slug>/.factory/app.json
generated-apps/<slug>/Dockerfile
generated-apps/<slug>/nginx.conf
```

不可覆盖审计产物：

```text
.factory-runs/
  jobs/
    <job-id>/
      requirement_analysis/
        attempt-1/
          input.json
          output.json
          output.md
          stdout.log
          stderr.log
        attempt-2/
          ...
```

MVP 默认保留最近 30 天的 `.factory-runs` 审计产物。超过保留期的 completed/canceled/failed Job artifact 可以由手动清理命令删除；第一阶段不做自动后台清理，但数据模型和路径设计不得依赖 artifact 永久存在。

## 7. 数据模型

MVP 使用 SQLite。核心表如下。

### 7.1 applications

统一保存预置应用和生成应用。

```text
id
slug
name
type
source              preset | generated
description
path
manifest_path
status              stopped | running | error | building | missing
runtime_url
created_at
updated_at
```

### 7.2 agents

Factory 可用 Agent 定义。它不是 `cc-status` 里的运行实例。

```text
id
key                 requirement-analyst | solution-designer | code-generator | tester | deployer
name
role
description
claude_agent_name
skills_json
enabled
sort_order
```

Agent 定义落库，启动时由内置 registry upsert。MVP 支持启用/禁用 Agent，不做在线编辑 Agent prompt。

### 7.3 jobs

一次用户生成请求。

```text
id
user_prompt
normalized_prompt
app_slug
app_name
status
current_step_kind
created_app_id
lock_owner
created_at
started_at
ended_at
updated_at
```

### 7.4 job_steps

一个 Job 的阶段实例。

```text
id
job_id
kind
seq
agent_key
status
attempt
started_at
ended_at
needs_user_input
user_prompt
error_code
error_message
claude_session_id
cc_status_session_id
```

`error_code` 必须使用阶段契约中定义的枚举值。`cc_status_unavailable` 只表示运行详情不可用，不应导致 Job 失败。

### 7.5 artifacts

每个阶段、每次 attempt 的输入、输出、日志和报告。

```text
id
job_id
step_id
attempt
kind                input_json | output_json | output_md | log | screenshot | build_log
path
summary
created_at
```

### 7.6 deployments

Podman 部署记录。

```text
id
app_id
job_id
image_name
image_tag
container_name
host_port
container_port
url
status              running | stopped | failed
created_at
started_at
stopped_at
```

### 7.7 conversations

对话消息历史，用于恢复上下文和 UI 展示。

```text
id
job_id nullable
role                user | assistant | system | agent
content
metadata_json
created_at
```

## 8. 应用注册机制

Factory 启动时扫描：

```text
scene/*/.factory/app.json
generated-apps/*/.factory/app.json
```

manifest 统一字段：

```json
{
  "schemaVersion": 1,
  "slug": "carrier-formation-replay",
  "name": "航母编队月度航迹复盘",
  "type": "timeline-replay",
  "source": "preset",
  "description": "展示航母编队近一个月航迹、事件点和复盘时间轴",
  "entry": "static-vite",
  "path": "scene/carrier-formation-replay",
  "tags": ["map", "carrier"],
  "build": {
    "command": "npm run build",
    "outputDir": "dist"
  },
  "runtime": {
    "devCommand": "npm run dev",
    "defaultPort": 5175
  },
  "docker": {
    "enabled": true,
    "dockerfile": "Dockerfile",
    "context": ".",
    "runtimePort": 80
  }
}
```

导入规则：

- `source=preset` 只能来自 `scene/`。
- `source=generated` 只能来自 `generated-apps/`。
- `slug` 全局唯一。
- 同 slug 冲突时，`generated` 不覆盖 `preset`，直接报冲突。
- 启动时 upsert `applications` 表。
- manifest 删除后，DB 中应用不物理删除，标记为 `missing`。
- 运行态字段如 `runtime_url` 和容器名只保存在 DB，不写回 manifest。

预置应用可以在门户里启动、停止、重新构建和部署。预置源码只读，不能直接编辑。如果用户要基于预置应用改造，必须复制到 `generated-apps/` 形成新应用。

预置应用操作与单任务锁的关系：

- “单 active job”只约束应用生成 Job。
- `start` 和 `stop` 是短同步应用操作，使用 per-app lock，不进入生成 Job 队列，可以在生成 Job 运行时执行。
- `rebuild` 会执行 npm/Podman 重型命令，MVP 中必须获取全局执行器锁；如果当前有生成 Job 运行，则返回 `409 Conflict` 并提示稍后重试。
- 同一个 app 同时只能有一个启动、停止、重建或部署操作。
- 预置应用操作失败只影响该 application/deployment 状态，不改变当前生成 Job 状态。

## 9. Claude Runner 边界

每个 Step 使用一次独立 `claude --print` 调用。输入和输出全部走文件。

目录结构：

```text
.factory-runs/jobs/<job-id>/<step-kind>/attempt-1/
  input.json
  prompt.md
  output.json
  output.md
  stdout.log
  stderr.log
```

Runner 调用形态：

```bash
claude --print \
  --agent <claude_agent_name> \
  --append-system-prompt <prompt.md>
```

Claude Agent 可以：

- 读写 `generated-apps/<slug>/**`。
- 读取 `.factory-runs/jobs/<job-id>/**`。
- 生成 `output.json`、`output.md`、README 和代码。
- 分析 Factory 提供的构建日志。

Runner 工具权限按阶段收紧：

| Step | Claude 工具权限 |
|------|-----------------|
| `requirement_analysis` | 只读：`Read`、`Grep`、`Glob` |
| `solution_design` | 只读：`Read`、`Grep`、`Glob` |
| `code_generation` | 读写：`Read`、`Grep`、`Glob`、`Edit`、`Write`，禁止 `Bash` |
| `test_verification` 失败分析 | 只读：`Read`、`Grep`、`Glob` |

MVP 不依赖 Claude 自己执行 shell 命令。所有 npm 和 Podman 命令都必须由 Factory 执行。

MVP 的安全防线是“最小权限 + 事后审计”，不是强沙箱：

- Factory 以最小环境变量启动 Claude Runner，不传递云端密钥、SSH key、Podman token 等敏感变量。
- Runner prompt 明确声明允许读写范围。
- Runner 启动前记录受保护路径和允许路径的快照。
- Runner 结束后检查产物路径、`git status --porcelain` 和必要文件摘要。
- 如果发现 `scene/**`、`factory-server/**`、`cc-status/**`、`.git/**` 等受保护路径被修改，Step 失败并记录 `error_code=file_constraint_violated`。
- 如果发现输出声明的文件不在 `generated-apps/<slug>/**` 或 `.factory-runs/jobs/<job-id>/**`，Step 失败。
- MVP 承认该机制不能完全阻止越界读取；本地单用户版本只运行用户自己信任的需求和 Agent。
- v2 再引入硬沙箱，例如 Podman 容器、只读挂载、临时 worktree 或更严格的文件系统隔离。

Factory only：

- `npm install`
- `npm run build`
- `podman build`
- `podman run`
- `podman stop`
- `podman rm`
- 端口分配
- SQLite 状态转移
- 应用注册扫描

边界原则：Claude 负责生成和解释，Factory 负责执行可控命令。

## 10. Factory API

### 10.1 Applications

```text
GET  /api/apps
GET  /api/apps/:id
POST /api/apps/:id/start
POST /api/apps/:id/stop
POST /api/apps/:id/rebuild
```

### 10.2 Jobs

```text
POST /api/jobs
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/cancel
POST /api/jobs/:id/retry-current-step
POST /api/jobs/:id/answer
```

### 10.3 Steps And Artifacts

```text
GET /api/jobs/:id/steps
GET /api/jobs/:id/artifacts
GET /api/artifacts/:id/content
```

### 10.4 Agents

```text
GET   /api/agents
PATCH /api/agents/:id
GET   /api/agents/:id/runs
```

### 10.5 Events

```text
GET /api/events
```

`/api/events` 使用 SSE 推送：

- app 状态变化
- job 状态变化
- step 状态变化
- artifact 新增
- deployment 状态变化
- cc-status 关联摘要变化

## 11. UI 信息架构

门户采用单页工作台，而不是多页面后台。

布局：

- 左侧：应用列表。
- 中间：对话、当前 Job、阶段时间线、产物摘要。
- 右侧：Agent 工作台和运行详情。
- 底部：固定对话输入框。

应用区展示：

- 应用名、类型、来源。
- 状态：未运行、构建中、运行中、错误。
- 操作：打开、启动、停止、重新构建。
- 生成应用额外展示：查看生成记录、重新生成。

生成任务区展示：

- 用户需求。
- 当前阶段。
- 阶段进度。
- 等待用户澄清的问题。
- 失败原因和重试按钮。
- 阶段产物：需求摘要、方案、构建日志、部署地址。

Agent 区展示：

- Factory Agent 定义卡片：需求分析、方案设计、代码生成、测试、构建部署。
- 当前是否参与任务。
- 最近执行时间。
- 点击后查看关联 Claude session、subagent、skill。

对话框始终固定在中间底部。任务运行时，用户仍可补充需求、回答澄清、发送停止、重试、继续等指令。新建需求进入队列，不打断当前任务。

## 12. 视觉风格

UI 样式参考现有 `sf-portal` 和 `scene/` 下态势页面。

风格原则：

- 深色战术/指挥中心风格。
- 深蓝黑底、青色描边、低饱和面板。
- 少量红色表示失败，黄色表示等待用户。
- 应用卡片像“场景单元”或“作战单元”。
- Agent 卡片参考态势面板的目标详情样式。
- 信息密度适中，优先可扫描、可比较、可操作。
- 不做营销式 hero，不做普通 SaaS 大白后台。

## 13. 第一阶段实现计划

第一阶段先实现最小闭环，不追求所有细节一次到位。

建议顺序：

1. 新增 `factory-server/` Go 服务骨架。
2. 建立 SQLite schema 和 store。
3. 实现应用扫描：导入 `scene/` 和 `generated-apps/` manifest。
4. 实现 Applications API。
5. 实现 Agents 内置 registry 和 Agents API。
6. 实现 Jobs、Steps、Artifacts 状态表和 API。
7. 实现单任务执行器和状态锁。
8. 实现 Claude Runner 文件契约。
9. 实现 npm build 契约检查。
10. 实现 Podman build/run/stop。
11. 将 `sf-portal` 从 mock 数据切换到 Factory API。
12. 接入 SSE。
13. 接入 `cc-status` 查询，展示 Step 关联运行详情。

第一阶段验收标准：

- 启动 Factory 后能扫描三个 `scene/` 预置应用。
- 门户能展示预置应用卡片。
- 用户能启动/停止一个预置应用，且应用只有在 HTTP 健康检查通过后才显示为 `running`。
- 用户能提交一个生成请求。
- Job 能按固定阶段推进到部署完成。
- 生成应用能写入 `generated-apps/<slug>/`。
- 应用卡片能打开运行态 URL，并返回可渲染的静态页面。
- Job 失败时能停在失败阶段，并支持重试当前阶段。
- Claude Runner 非 0 退出、缺少 `output.json`、manifest 不合法、端口冲突、健康检查失败都能落到明确错误码。
