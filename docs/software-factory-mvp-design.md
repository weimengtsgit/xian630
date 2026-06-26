# 智能软件工厂 MVP 设计

## 1. 目标

智能软件工厂提供一个统一入口，让用户通过对话描述想要的应用，系统按阶段调用本地 Claude Code CLI 的 subagent 和 skills，生成项目目录、代码和运行配置，再通过 Podman 构建部署，最终在门户中以应用卡片形式打开运行态应用。

MVP 的目标是打通一条本地单用户闭环：

1. 用户在门户对话框输入应用需求。
2. Factory 创建对话会话，推断对话意图并路由到已有应用复用、应用生成或业务处理智能体建议。
3. 应用生成路由下进入需求澄清会话，用户确认需求后 Factory 创建生成任务，并按固定阶段串行执行。
4. Claude Agent 负责需求分析、方案设计和代码生成。
5. Factory 负责测试、镜像构建、Podman 部署和状态持久化。
6. 生成应用写入 `generated-apps/<app-slug>/`。
7. 预置应用按场景目录的 `application` 表面从 `scene/*/.factory/app.json` 导入。
8. 门户展示应用、对话会话、任务、Agent 和运行详情。

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

## 4. 对话会话到生成任务

用户第一次输入需求描述后，Factory 不直接创建生成任务。系统先创建一个**对话会话（dialogue session）**：一个可持久化、可恢复的对话资源，先由模型识别用户**对话意图**，再路由到三种结果之一：

1. **已有应用复用**：判定某个已配置的预置应用即可满足需求，推荐并直接打开/启动，而不是重复生成。
2. **应用生成**：创建一个从属的**需求澄清会话**，由需求分析 agent 引导用户补齐关键需求，用户确认后才创建生成任务。
3. **业务处理智能体建议**：根据用户描述起草一个**业务处理智能体**定义（名称、描述、prompt），供用户确认后登记展示。

用户在一次对话会话中确认某一路由（`route.confirmed`）后，该路由即被锁定；提出一个新的应用或智能体需求需要新建一个对话会话。

```ts
type DialogueIntent =
  | "existing_application_reuse"
  | "application_generation"
  | "business_processing_agent";

type DialogueStatus =
  | "draft"
  | "intent_inferred"
  | "route_confirmed"
  | "clarifying"
  | "resolved"
  | "abandoned"
```

### 4.1 对话会话与三路由

对话会话是入口态资源，不占用生成任务队列，也不会在应用列表中创建运行中应用卡片。它可被路由确认、解析完成（`resolved`）或放弃（`abandoned`）。

- 首条用户消息创建对话会话，模型推断 `DialogueIntent`。
- 意图在用户确认路由前可随用户补充而更新（`intent.updated`）；一旦 `route.confirmed`，路由锁定。
- **已有应用复用**：Factory 产出结构化推荐（`application.recommended`），用户确认后直接打开或启动对应应用，对话会话进入 `resolved`。
- **业务处理智能体建议**：Factory 起草智能体定义（`agent_draft.updated`），用户确认后登记为业务处理智能体（`agent.created`，`category=business_processing`），对话会话进入 `resolved`。本阶段业务处理智能体只登记展示，不直接执行。
- **应用生成**：Factory 在该对话会话下创建从属的需求澄清会话（见 4.2），澄清确认后才创建生成任务。
- 用户确认前不得创建生成任务，不得启动代码生成、构建或部署。
- 如果真实 Claude Code runner 失败，对话会话/澄清会话进入失败态，不得创建生成任务，也不得创建应用卡片。UI 提供“重试本轮”“手动编辑摘要”“放弃”等操作。

### 4.2 需求澄清会话（应用生成路由的子流）

应用生成路由确定后，Factory 在对话会话下创建一个需求澄清会话。需求澄清会话是协作智能体子流，不占用生成任务队列，用于在创建任何生成任务之前精炼应用需求。

```ts
type ClarificationStatus =
  | "active"
  | "waiting_user"
  | "ready_to_confirm"
  | "confirmed"
  | "failed"
  | "abandoned"
```

自适应澄清规则（最多 6 轮，无第七轮）：

- **第 1–4 轮**：每轮**最多 1 个**结构化推荐选项问题，每个问题给出 2–3 个选项。模型逐轮识别当前最需要补齐的字段。
- **第 5 轮（推荐收敛）**：不再发散追问，而是把剩余决策项汇总为一份推荐取值集合（`推荐收敛确认`），列出每项的推荐值和理由，供用户整体接受或定点调整。
- **第 6 轮（单字段调整）**：仅允许用户对推荐收敛结果做**单个字段**的调整，随后会话进入 `ready_to_confirm`。
- 不存在第七轮。第 6 轮后必须可确认；若用户仍未显式确认，按推荐收敛结果处理。
- 用户可随时输入“确认”“可以”“开始生成”等确认意图。
- 用户确认前不得创建生成任务，不得启动代码生成、构建或部署。
- 用户点击“确认并生成”后，Factory 立即确认澄清会话、创建生成任务、置为 `queued` 并唤醒 executor。
- 如果真实 Claude Code clarification runner 失败，澄清会话进入 `failed`，不得创建生成任务。UI 提供“重试本轮”“手动编辑摘要”“放弃”操作。

需求澄清会话输出三类面向用户的信息：

- 系统状态日志：Factory 固定生成，例如“需求分析 agent 已启动”“等待用户确认”。
- 分析工作日志：需求分析 agent 结构化生成，用于解释识别到的业务域、缺失字段、推荐理由。它不是原始内部思考过程，也不是从原始思考链抽取的内容。
- 确认需求摘要：结构化字段汇总，用户确认后作为生成任务输入。

推荐选项必须是结构化字段选择，不只是普通聊天文本。用户点击选项、输入自定义答案或确认默认推荐时，Factory 更新会话的 `requirement_json`。

```json
{
  "id": "time_range",
  "label": "时间范围",
  "question": "要复盘多长时间的航迹？",
  "required": true,
  "recommendation": "last_30_days",
  "options": [
    {
      "value": "last_7_days",
      "label": "近 7 天",
      "reason": "适合短期态势回顾，地图更清爽"
    },
    {
      "value": "last_30_days",
      "label": "近 1 个月",
      "reason": "适合观察阶段性活动规律",
      "recommended": true
    },
    {
      "value": "last_90_days",
      "label": "近 3 个月",
      "reason": "适合趋势复盘，但事件密度会更高"
    }
  ],
  "allowCustom": true
}
```

确认需求摘要至少包含：

```json
{
  "appType": "situation_replay",
  "appName": "航母编队月度航迹复盘",
  "targetUsers": ["态势分析人员", "指挥值班人员"],
  "coreScenario": "复盘近 1 个月东海方向航母编队航行轨迹与关键事件",
  "primaryView": "地图 + 时间轴 + 事件详情",
  "mainEntities": ["编队", "航迹点", "事件", "阶段摘要"],
  "dataPolicy": "mock_data",
  "acceptanceFocus": ["地图轨迹与时间点事件联动"],
  "generationProfile": {
    "base": ["software-factory-app"],
    "domain": ["defense-operations-ui"],
    "pattern": ["map-timeline-replay"]
  }
}
```

只有确认需求摘要具备这些字段并通过 Factory schema 校验后，才能创建生成任务。

用户手动编辑确认需求摘要时，只能编辑业务字段：`appType`、`appName`、`targetUsers`、`coreScenario`、`primaryView`、`mainEntities`、`dataPolicy`、`acceptanceFocus`。`generationProfile`、`constraints`、`risks` 和 `slug` 由 Factory 根据业务字段派生，不在普通用户界面直接编辑。

对话会话与需求澄清会话采用消息级流式输出，不做 token 级流式，不展示内部工具调用级事件。门户消费的安全 SSE 事件族包括 `app.*`、`job.*`、`step.*`、`deployment.*`、`clarification.*`（历史/回填）以及新增的 `dialogue.*` 族。`dialogue.*` 包含：

```text
dialogue.created
dialogue.intent.updated
dialogue.application.recommended
dialogue.route.confirmed
dialogue.agent_draft.updated
dialogue.agent.created
dialogue.clarification.updated
dialogue.resolved
dialogue.abandoned
dialogue.deleted
```

`clarification.*` 族作为历史/回填事件保留：

```text
clarification.created
clarification.message.started
clarification.message.delta
clarification.message.completed
clarification.question.created
clarification.summary.updated
clarification.ready_to_confirm
clarification.confirmed
job.created
```

内部场景蓝本 slug、原始 stdout/stderr、思维链 `thinking_delta` 等内容**不**推送给浏览器。

需求澄清会话第一版直接接真实 Claude Code clarification runner，不先做产品路径上的 fake runner。测试可以使用后端 fake 或 fixture runner 验证 API、状态机和 UI，但本地演示路径应默认调用真实 Claude Code CLI，并加载项目级 `requirement-clarification` skill。

前端不得直接展示 Claude Code stdout。真实 Claude Code clarification runner 的输出必须先由 Factory 解析并归一化为结构化 SSE 事件，再推送给门户。原始 stdout/stderr 只作为调试日志保留。

如果当前 Claude Code CLI 只能一次性返回完整结果，Factory 可以按消息片段模拟消息级流式输出，但 SSE 事件协议保持不变。未来 CLI 支持更细粒度流式时，只替换 runner 内部实现，不改变 UI/API。

需求澄清会话使用独立审计目录，不复用 Job artifact 目录：

```text
.factory-runs/
  clarifications/
    <session-id>/
      round-1/
        input.json
        prompt.md
        stream.jsonl
        output.json
        stdout.log
        stderr.log
      round-2/
        ...
  jobs/
    <job-id>/
      requirement_analysis/
        attempt-1/
          input.json
          output.json
```

`stream.jsonl` 保存 Factory 归一化后的消息级事件流，一行一个事件。`output.json` 保存该轮 Claude 的结构化输出。Job 创建后，Factory 将 `confirmed_requirement_json` 写入 `jobs` 表，并在 `requirement_analysis/input.json` 中引用澄清会话 ID。

澄清失败时必须保存该轮 `stdout.log`、`stderr.log` 和可读错误摘要。失败原因使用机器可读错误码，例如 `claude_not_found`、`runner_timeout`、`output_invalid_json`、`schema_validation_failed`、`skill_missing`、`canceled`、`unknown`。

### 4.2 生成任务状态机

生成任务只在用户确认需求后创建。MVP 采用“默认自动继续，可暂停确认”的策略。

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
| `requirement_analysis` | `requirement-analyst` | Claude Runner | 校验、冻结和审计已确认需求，不再负责多轮澄清 |
| `solution_design` | `solution-designer` | Claude Runner | 产出页面、组件、数据模型和文件计划 |
| `code_generation` | `code-generator` | Claude Runner | 写入 `generated-apps/<slug>/` 代码和 manifest |
| `test_verification` | `tester` | Factory 命令为主，Claude 可选分析失败日志 | Factory 执行依赖安装、构建和契约检查 |
| `image_build` | `image-builder` | Factory 命令 | Factory 执行固定 Podman build 命令 |
| `deployment` | `deployer` | Factory 命令 | Factory 分配端口、启动容器、做健康检查 |

这六个 `agent_key` 对应六个**协作智能体智能体**：需求分析、方案设计、代码生成、测试、镜像构建、部署。历史上镜像构建与部署曾合并为单个“构建部署” agent，现拆分为独立的 `image-builder`（镜像构建，`image_build`）与 `deployer`（部署，`deployment`）。`agent_key` 用于 UI 展示和审计归属，不代表每个 Step 都会启动 Claude CLI。`test_verification`、`image_build`、`deployment` 的关键命令由 Factory 固定执行，不能由 Claude 自由拼接命令。

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

目标：读取用户已确认的确认需求摘要，校验字段完整性、能力边界、生成能力画像和风险说明，并冻结为本 Job 的标准需求产物。

`requirement_analysis` 不再负责多轮澄清。多轮澄清发生在需求澄清会话中；如果本阶段发现确认需求摘要缺字段或超出支持范围，Job 必须失败或回到澄清会话补充，而不是继续生成代码。

输出示例：

```json
{
  "confirmedRequirementId": "clar_req_123",
  "summary": "复盘近 1 个月东海方向航母编队航行轨迹与关键事件",
  "appType": "situation_replay",
  "appName": "航母编队月度航迹复盘",
  "targetUsers": ["态势分析人员", "指挥值班人员"],
  "coreScenario": "复盘近 1 个月东海方向航母编队航行轨迹与关键事件",
  "primaryView": "地图 + 时间轴 + 事件详情",
  "mainEntities": ["编队", "航迹点", "事件", "阶段摘要"],
  "dataPolicy": "mock_data",
  "acceptanceFocus": ["地图轨迹与时间点事件联动"],
  "generationProfile": {
    "base": ["software-factory-app"],
    "domain": ["defense-operations-ui"],
    "pattern": ["map-timeline-replay"]
  },
  "constraints": ["前端可视化应用", "React + Vite", "Podman 静态部署"],
  "risks": ["真实数据源未接入"],
  "validation": {
    "complete": true,
    "supported": true,
    "missingFields": [],
    "unsupportedRequests": []
  }
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

- 对容器发布端口发起 HTTP GET。探测地址按以下优先级选择：`FACTORY_HEALTH_HOST` 环境变量 > Podman Machine 网关（macOS/Linux）> WSL VM IP（Windows+WSL2）> `127.0.0.1`。
- 默认 30 秒内返回 `200-399` 才能把 deployment 和 application 标记为 `running`（可通过环境变量 `FACTORY_HEALTH_TIMEOUT` 覆盖，例如 `10s`、`1m`）。
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
key                 requirement-analyst | solution-designer | code-generator | tester | image-builder | deployer
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

一次已确认的生成任务。它由需求澄清会话确认后创建，不等同于用户第一次输入的自然语言需求。

```text
id
user_prompt
normalized_prompt
clarification_session_id nullable
confirmed_requirement_json
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

### 7.4 clarification_sessions

需求澄清会话。用户第一次输入需求后创建，确认前不进入生成任务队列。

```text
id
status              active | waiting_user | ready_to_confirm | confirmed | failed | abandoned
initial_prompt
round
max_rounds
requirement_json
created_job_id nullable
error_code nullable
error_message nullable
created_at
updated_at
confirmed_at nullable
abandoned_at nullable
```

### 7.5 clarification_messages

需求澄清会话中的消息、结构化问题、分析工作日志和摘要更新。

```text
id
session_id
role                user | assistant | system | agent
kind                user_input | system_status_log | analysis_work_log | question | option_set | requirement_summary | confirmation
content
metadata_json
created_at
```

### 7.6 job_steps

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

### 7.7 artifacts

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

### 7.8 deployments

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

### 7.9 conversations

生成任务中的补充消息历史，用于任务运行后的回答、重试说明和审计补充。需求澄清主历史由 `clarification_messages` 保存。

```text
id
job_id
role                user | assistant | system | agent
content
metadata_json
created_at
```

## 8. 应用注册机制

### 8.1 场景目录

预置场景的展示表面由单一的**场景目录** `.factory/scene-catalog.json` 决定，它是应用列表展示与对话意图分类候选的共享来源。每个场景被分配到且仅到一个表面：

- `application`：作为预置应用出现在门户应用列表。当前为 `carrier-formation-replay`、`aircraft-carrier-track`、`east-sea-situation`。
- `blueprint`：作为**隐藏的内部场景蓝本**，仅作为生成应用需求时的内部参考，**绝不**向用户展示为产品约束、能力边界或可直接打开的应用。当前为 `carrier-homeport-tide-window`、`carrier-deck-wind-calculator`、`merchant-density-grid-alert`、`social-sighting-cluster-alert`（展示名：开源社区异常监测）。

`preset-apps.json` 不再驱动运行时展示或路由。历史 `showInAppList` / `recommendedBlueprints` 等开关已被场景目录取代。

### 8.2 应用扫描与命名

Factory 启动时扫描：

```text
scene/*/.factory/app.json        （仅 surface=application 进入应用列表）
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

#### 生成应用命名（Factory 拥有）

生成应用的名称由 Factory 而非模型直接决定，流程为：

1. 模型根据确认需求摘要产出**规范化场景名称**（简洁、面向人类、非 demo 名称、非 slug、非原始输入全文）。
2. Factory 追加一个 4 位 Base36 随机序列，并派生一个安全 slug。
3. 最终生成应用名为 `<规范化场景名称>-<序列>`（例如 `航母编队航迹复盘-K7M2`）。

不再使用 `demoN` 类名称。客户原始场景措辞作为对话与需求上下文保留（**客户场景名称**），即使生成应用获得规范化名称。

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

### 9.1 项目级生成能力包

生成应用不是只能复制 `scene/` 预置应用，也不是完全自由生成。MVP 采用“模板约束下的自由生成”：Claude Code 可以根据确认需求摘要生成新的 `generated-apps/<slug>/` 应用，但必须受项目级生成能力包和 Factory 硬校验约束。

生成能力包放在当前项目目录下：

```text
.claude/
  skills/
    requirement-clarification/
      SKILL.md
    software-factory-app/
      SKILL.md
    defense-operations-ui/
      SKILL.md
    map-timeline-replay/
      SKILL.md
    operations-management-console/
      SKILL.md
    command-dashboard/
      SKILL.md
    maritime-alert-dashboard/
      SKILL.md
```

不使用用户全局 skills 作为生成质量的必要依赖。项目级 skills 随仓库版本管理，保证不同机器、不同操作者运行 Factory 时有一致的生成约束。

`requirement-clarification` 是需求澄清阶段的基础能力包，不属于应用生成 `generationProfile`。它约束需求分析 agent 如何生成分析工作日志、结构化推荐问题、确认需求摘要和收敛建议；它不得生成代码，也不得创建生成任务。

第一阶段支持三类应用和对应生成能力画像：

| 应用类型 | generationProfile |
|---|---|
| 态势复盘类应用 | `software-factory-app` + `defense-operations-ui` + `map-timeline-replay` |
| 业务管理类应用 | `software-factory-app` + `defense-operations-ui` + `operations-management-console` |
| 指挥看板类应用 | `software-factory-app` + `defense-operations-ui` + `command-dashboard` |
| 海事告警指挥看板 | `software-factory-app` + `defense-operations-ui` + `command-dashboard` + `maritime-alert-dashboard` |

生成能力包职责：

- `requirement-clarification`：需求澄清会话行为、自适应最多 6 轮（第 1–4 轮每轮最多 1 问/2–3 选项、第 5 轮推荐收敛、第 6 轮单字段调整，无第七轮）、确认需求摘要必填字段、应用类型识别、`generationProfile` 生成。
- `software-factory-app`：统一 React/Vite 工程结构、manifest、Dockerfile、nginx、构建与部署约束。
- `defense-operations-ui`：统一军工/海军业务视觉语言、信息密度、深色态势风格和交互规范。
- `map-timeline-replay`：地图范围、轨迹、事件点、时间轴、对象详情和复盘交互。
- `operations-management-console`：台账、筛选、详情、状态流转、统计面板和批量操作。
- `command-dashboard`：指标、告警、任务态势、资源概览和指挥值班视图。
- `maritime-alert-dashboard`：海域、港口、网格、坐标对象、演示数据契约、刷新节奏、阈值告警、倒计时窗口、地图网格、散点聚合和海事监控类客户判断口径。

触发机制：

1. 需求澄清会话产出确认需求摘要。
2. 需求分析 agent 或 Factory 根据 `appType` 生成 `generationProfile`。
3. Factory 校验 `generationProfile` 中的 skill key 必须存在于项目级 skill catalog。
4. Factory 在每个 Claude Runner 的 `input.json` 中写入 `confirmedRequirement` 和 `generationProfile`。
5. Factory 在 `prompt.md` 中明确列出本阶段必须使用的 skill key 和本地路径。
6. Claude Code runner 从工作区根目录执行，使项目级 `.claude/skills/` 可被加载；如果具体 Claude Code 版本的 skill 自动加载行为不可用，Factory 必须把选中的 `SKILL.md` 内容显式拼入 `prompt.md` 作为兜底。
7. Claude 输出的 `output.json` 必须声明实际使用的 skill key；Factory 将其写入 artifact，供 UI 和审计查看。

技能缺失策略：

- 缺少 `software-factory-app` 是硬失败，因为它承载工程、manifest 和部署约束。
- 缺少 `defense-operations-ui` 或 pattern skill 时，Factory 记录 warning，并降级到基础生成能力，但 UI 必须提示“缺少领域/模式能力包，生成质量可能下降”。
- Claude 不能自行选择不在 `generationProfile` 中的关键能力包；如需追加能力包，必须在 `solution_design` 输出中声明理由，并由 Factory 校验后接受或拒绝。

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

生成任务只能由已确认的需求澄清会话创建；门户不应再用第一次用户输入直接调用 `POST /api/jobs`。

```text
POST /api/jobs
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/cancel
POST /api/jobs/:id/retry-current-step
POST /api/jobs/:id/answer
```

### 10.3 Clarifications

```text
POST /api/clarifications
GET  /api/clarifications/:id
GET  /api/clarifications/:id/messages
POST /api/clarifications/:id/messages
POST /api/clarifications/:id/answers
PATCH /api/clarifications/:id/requirement
POST /api/clarifications/:id/retry-current-round
POST /api/clarifications/:id/confirm
POST /api/clarifications/:id/abandon
```

`POST /api/clarifications/:id/confirm` 成功后创建生成任务，并返回确认需求摘要和 `job_id`。

### 10.4 Steps And Artifacts

```text
GET /api/jobs/:id/steps
GET /api/jobs/:id/artifacts
GET /api/artifacts/:id/content
```

### 10.5 Agents

```text
GET   /api/agents
PATCH /api/agents/:id
GET   /api/agents/:id/runs
```

### 10.6 Events

```text
GET /api/events
```

`/api/events` 使用 SSE 推送：

- app 状态变化
- job 状态变化
- step 状态变化
- artifact 新增
- deployment 状态变化
- clarification 消息、问题、摘要和确认状态变化
- cc-status 关联摘要变化

## 11. UI 信息架构

门户采用单页工作台，而不是多页面后台。

布局：

- 左侧：应用列表。
- 中间上方：当前生成任务、阶段时间线、产物摘要。
- 中间下方：需求澄清对话、分析工作日志、推荐选项、确认需求摘要。
- 右侧：Agent 工作台和运行详情。
- 底部：固定对话输入框。

应用区展示：

- 应用名、类型、来源。
- 状态：未运行、构建中、运行中、错误。
- 操作：打开、启动、停止、重新构建。
- 生成应用额外展示：查看生成记录、重新生成。

生成任务区展示：

- 已确认需求摘要。
- 当前阶段。
- 阶段进度。
- 失败原因和重试按钮。
- 阶段产物：需求摘要、方案、构建日志、部署地址。

需求澄清区展示：

- 用户输入的初始需求。
- 系统状态日志。
- 需求分析 agent 的分析工作日志。
- 结构化推荐选项。
- 已选择字段和可修改入口。
- 确认需求摘要。
- `确认并生成`、`继续补充`、`放弃` 操作。

多轮澄清展示规则：

- 对话区固定高度并内部滚动，不挤压任务区。
- 已完成轮次折叠为“第 1 轮澄清 / 第 2 轮澄清”摘要。
- 当前正在流式输出的消息保持可见。
- 推荐选项以紧凑卡片展示，避免长按钮撑破布局。
- 确认需求摘要固定在对话输入框上方，随结构化字段更新。

Agent 区展示：

- Factory Agent 定义卡片：需求分析、方案设计、代码生成、测试、镜像构建、部署。
- 当前是否参与任务。
- 最近执行时间。
- 点击后查看关联 Claude session、subagent、skill。

对话框始终固定在中间底部。用户第一次输入创建对话会话，由模型推断对话意图并路由到已有应用复用、应用生成或业务处理智能体建议；应用生成路由确定后才进入需求澄清会话，不直接创建生成任务。任务运行时，用户仍可补充需求、回答澄清、发送停止、重试、继续等指令。新建需求进入新的对话会话或队列，不打断当前任务。

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
