# Claude Skills and Agents

本文梳理仓库内 `.claude/` 目录下的 skills 与 agent interface，并说明它们和软件工厂运行时流水线 agents 的边界。

## 术语边界

本仓库里有三类容易混淆的对象：

1. **Skill**：位于 `.claude/skills/<skill-name>/SKILL.md`，描述某类生成、澄清、路由、UI 或数据接入能力。
2. **Skill 附带 Agent Interface**：位于 `.claude/skills/*/agents/openai.yaml`，是部分数据能力包暴露给外部/编排层的轻量 interface 元数据。
3. **运行时流水线 Agent**：位于 `factory-server/internal/agents/registry.go`，是软件工厂实际生成、测试、构建、部署流水线中的固定 agent 注册表；它不在 `.claude/` 下。

因此，本文中的 “`.claude/ 下的 agent`” 特指 **Skill 附带 Agent Interface**。如果讨论软件工厂执行流程中的 agent，应称为 **运行时流水线 Agent**。

此外，目标设计中会引入 **协作智能体**：它是 Factory 拥有的生成协作角色，用于组成一次生成任务的用户确认参与计划。协作智能体不同于 `.claude/skills/*/agents/openai.yaml`，也不等同于当前已经实现的固定六阶段运行时流水线 Agent。本文后文的“协作智能体目标模型”描述的是目标设计，不代表当前代码已经完整实现。

## Skills 总览

当前 `.claude/skills/` 下共有 14 个 skill，可按用途分为四组。

### 生成基础能力 / UI 模式

| Skill | 文件 | 用途 |
|---|---|---|
| `software-factory-app` | `.claude/skills/software-factory-app/SKILL.md` | 生成可部署 React/Vite 静态应用。约束生成目录、manifest、Dockerfile、nginx、诚实数据规则等。 |
| `defense-operations-ui` | `.claude/skills/defense-operations-ui/SKILL.md` | 生成防务/作战风格 UI：深色、高密度、可扫描、中文作战标签，避免营销页式装饰。 |
| `command-dashboard` | `.claude/skills/command-dashboard/SKILL.md` | 生成指挥级仪表盘模式：指标、告警、就绪状态、趋势、任务列表、钻取详情。 |
| `operations-management-console` | `.claude/skills/operations-management-console/SKILL.md` | 生成操作管理控制台：表格/列表、过滤、状态标签、详情面板、本地 mock 交互。 |
| `map-timeline-replay` | `.claude/skills/map-timeline-replay/SKILL.md` | 生成地图、轨迹、事件点与时间线回放能力；指定 MapLibre GL + Esri 卫星瓦片、单地图实例和 update-not-rebuild 架构。 |

### 领域看板 / 研判应用模式

| Skill | 文件 | 用途 |
|---|---|---|
| `maritime-alert-dashboard` | `.claude/skills/maritime-alert-dashboard/SKILL.md` | 海事监控/告警看板模式，覆盖港口、海域、航母活动区、船舶密度、天气/潮汐阈值、社媒目击、地图叠加和倒计时窗口等。 |
| `affiliation-inference-dashboard` | `.claude/skills/affiliation-inference-dashboard/SKILL.md` | 归属推断看板，根据观测事件、时空关联、阈值、关系树、时间线、热力图和失效活动告警推断飞机/舰船/单位/资产归属。 |

这两个领域模式通常与 `software-factory-app`、`defense-operations-ui`、`command-dashboard` 组合使用。

### 数据接入能力包

| Skill | 文件 | 用途 | 关键边界 |
|---|---|---|---|
| `carrier-affiliation-data-skill` | `.claude/skills/carrier-affiliation-data-skill/SKILL.md` | 航母-舰载机归属、ADS-B、航母位置、航母飞机主数据、海陆分类、本体/DaaS 航母实体，以及军事舰船 AIS。 | 军事舰船 AIS 归这里，包括航母、军舰、驱逐舰、巡洋舰、护卫舰等。 |
| `ais-density-data-skill` | `.claude/skills/ais-density-data-skill/SKILL.md` | 商船 AIS 历史密度网格，聚合为 50 海里网格。 | 只服务商船/商业航运密度，不服务军舰；无免费实时 AIS，主打历史/年度数据。 |
| `deck-wind-data-skill` | `.claude/skills/deck-wind-data-skill/SKILL.md` | 获取并标准化航母作业区域/海域 10m 风速风向，用于甲板风评估。 | 默认真实数据；全部来源失败时降级，不编造风值。 |
| `tide-data-skill` | `.claude/skills/tide-data-skill/SKILL.md` | 获取并标准化港口潮汐预报。 | 默认真实数据；NOAA CO-OPS 优先，横须贺可走 JCG；失败降级，不编造潮汐曲线。 |

AIS 相关请求的硬边界是按目标舰队类型划分，而不是按 “AIS” 这个词划分：

- 商船/商业航运密度 AIS → `ais-density-data-skill`
- 军事舰船 AIS / 航母相关轨迹 → `carrier-affiliation-data-skill`

### 对话、澄清、路由能力

| Skill | 文件 | 用途 |
|---|---|---|
| `requirement-clarification` | `.claude/skills/requirement-clarification/SKILL.md` | 软件工厂需求澄清流程。6 轮自适应，一次一个高影响决策；高影响事项必须用户显式确认。 |
| `dialogue-intent-routing` | `.claude/skills/dialogue-intent-routing/SKILL.md` | 将单条用户消息路由到一个软件工厂意图，只能使用输入里给定的 existing applications 和 blueprints，不能编造候选项。 |
| `business-agent-drafting` | `.claude/skills/business-agent-drafting/SKILL.md` | 从用户对话中起草业务处理 agent 指令。6 轮流程，每轮最多一个问题，最终输出 JSON contract。 |

注意：项目当前语言中，用户请求“创建智能体”会被路由到 **助手应用** 生成，而不是业务处理 agent 草稿。`business-agent-drafting` 更像未来/内部能力，不是当前用户可见主路径。

## Skill 附带 Agent Interface

当前 `.claude/` 下没有顶层 `.claude/agents/` 目录。发现的 agent interface 均位于部分数据 skill 的 `agents/openai.yaml` 中。

这些文件不是完整的 Claude Code subagent 定义，而是轻量 interface 元数据，主要包含：

- `interface.display_name`
- `interface.short_description`
- `interface.default_prompt`

| 文件 | Display name | 用途 |
|---|---|---|
| `.claude/skills/ais-density-data-skill/agents/openai.yaml` | Historical AIS Density Data | 使用 `ais-density-data-skill` 下载/处理历史 AIS 档案并计算商船密度网格。 |
| `.claude/skills/carrier-affiliation-data-skill/agents/openai.yaml` | Carrier Affiliation Data | 使用 `carrier-affiliation-data-skill` 获取并标准化航母-舰载机归属推断数据。 |
| `.claude/skills/deck-wind-data-skill/agents/openai.yaml` | Real Deck Wind Data | 使用 `deck-wind-data-skill` 获取并标准化真实 10m 风数据。 |
| `.claude/skills/tide-data-skill/agents/openai.yaml` | Real Tide Data | 使用 `tide-data-skill` 获取并标准化真实潮汐预报数据。 |

## 运行时流水线 Agents

软件工厂实际执行生成、测试、镜像构建和部署的固定 agent 注册表位于 `factory-server/internal/agents/registry.go`，不属于 `.claude/` 目录，但经常会和 `.claude/skills/*/agents/openai.yaml` 被混称。

| 顺序 | Key | 名称 | Role | 描述 |
|---:|---|---|---|---|
| 1 | `requirement-analyst` | 需求分析 | `requirement_analysis` | 把用户自然语言需求整理为生成应用的明确需求。 |
| 2 | `solution-designer` | 方案设计 | `solution_design` | 把需求变成可执行的前端项目设计和文件计划。 |
| 3 | `code-generator` | 代码生成 | `code_generation` | 写入生成应用项目代码并生成 manifest。 |
| 4 | `tester` | 测试验证 | `test_verification` | 分析构建日志并生成诊断摘要。 |
| 5 | `image-builder` | 镜像构建 | `image_build` | 构建应用容器镜像。 |
| 6 | `deployer` | 部署 | `deployment` | 容器部署与运行时管理。 |

这些运行时流水线 agents 属于软件工厂内部执行机制；skills 则是生成、澄清、路由、数据能力和 UI 模式的规则/能力包。

## 协作智能体目标模型

本节记录目标设计，见 ADR：[0008-dynamic-collaboration-agent-plan](./adr/0008-dynamic-collaboration-agent-plan.md)。可执行拆分见实施计划：[2026-06-27-dynamic-collaboration-agent-plan](./superpowers/plans/2026-06-27-dynamic-collaboration-agent-plan.md)。当前实现仍是上文的固定六阶段流水线和 3 x 2 任务卡片；目标模型会把用户可见任务区从固定阶段卡片推进为一次生成任务的 **协作智能体参与计划**。

### 核心原则

1. **生成前确认协作计划**：在确认需求摘要中同时展示需求摘要和协作智能体参与计划，包括参与智能体、依赖关系、协作图和高影响移除项。用户确认后才创建生成任务。
2. **自然语言可调整**：用户可以在确认前说“不需要哪个”“增加哪个”“修改某个智能体的说明”。协作编排智能体解释这些自然语言调整并重新产出计划，最终仍由用户确认。
3. **协作图是真实执行依赖**：协作图不是装饰性流程图，而是任务执行依赖。MVP 应限制为有向无环图，避免循环依赖。
4. **任务区一张卡片对应一个参与智能体**：确认生成后，任务区展示参与本次任务的协作智能体卡片，并按执行泳道分组，而不是继续固定展示六张阶段卡片。
5. **计划和快照必须持久化**：协作智能体参与计划、依赖图、每个智能体的配置快照和用户调整记录都必须随任务持久化，刷新、重连、重试和历史回看时可恢复。
6. **默认编辑本次快照**：卡片详情中可编辑名称、描述、本次任务说明、启用 skills 和复制后的 skill 内容覆盖；引用的全局 skill 文件默认只读。写回 `.claude/skills/*` 必须单独确认并产生审计记录。
7. **高影响移除必须确认**：删除或停用会影响质量门禁、数据承诺、部署、权限或用户可见行为的协作智能体时，需要高影响确认，并写入确认需求摘要。

### 默认协作智能体

| 智能体 | 默认参与 | 职责 |
|---|---|---|
| 协作编排智能体 | 是 | 在任务创建前生成默认协作计划、解释选择依据、处理自然语言调整；确认后作为已完成卡片进入任务区。 |
| 需求分析智能体 | 是 | 整理用户需求并形成可执行的确认需求摘要。 |
| 领域分析智能体 | 是 | 通过生成能力包、场景蓝本、数据来源边界和客户判断口径注入领域知识；先保持通用角色，不按领域硬拆。 |
| 设计智能体 | 是 | 产出结构化设计契约，包括视图、布局、组件、交互状态、数据字段到 UI 的映射、移动端约束和视觉边界。 |
| 数据接入智能体 | 是 | 产出真实数据接入计划和演示数据契约；mock 数据由它定义为可替换契约，不能伪装成真实数据。 |
| 方案设计智能体 | 是 | 汇总需求、领域、设计和数据契约，形成技术方案、文件计划和实现边界。 |
| 代码生成智能体 | 是 | 根据确认需求、设计契约、数据契约和方案写入应用代码。 |
| 代码审查智能体 | 是 | 阻断式质量门禁；只阻断明确可执行且影响正确性、可部署性、数据诚实、安全或确认用户行为的问题。 |
| 安全审查智能体 | 条件默认 | 当需求涉及公网数据、认证、上传、外部接口、敏感数据、权限或暴露部署面时加入。 |
| 测试验证智能体 | 是 | 运行或分析构建与测试结果，输出诊断摘要。 |
| 产品验收智能体 | 是 | 在测试后、构建部署前检查生成结果是否满足确认需求摘要、设计契约、数据契约和主要用户流程。 |
| 镜像构建智能体 | 是 | 构建应用容器镜像。 |
| 部署智能体 | 是 | 部署容器并完成运行时健康验证。 |

### 任务区泳道

目标任务区按泳道展示协作智能体卡片：

1. **需求 / 领域 / 设计 / 数据**：协作编排、需求分析、领域分析、设计、数据接入。
2. **生成 / 审查 / 修复**：方案设计、代码生成、代码审查、安全审查。
3. **验证 / 构建 / 部署**：测试验证、产品验收、镜像构建、部署。

每张协作智能体任务卡片保留独立状态、详情抽屉、配置快照、执行记录、产物、重试或修复动作。协作编排智能体虽然主要在任务创建前运行，但确认生成后应作为已完成卡片进入任务区，用来回看为什么选择这些智能体以及用户调整了什么。

### 有界自动修复回路

代码审查、产品验收、测试验证、镜像构建和可修复部署健康检查可以进入有界自动修复回路：把阻断原因和失败上下文交回代码生成智能体进行定向修复，再重新经过后续门禁。默认限制是每个任务最多 2 次自动修复，同一阻断原因最多 1 次；端口占用、容器运行基础设施错误等不可通过代码生成修复的问题不得自动回路。

当前代码已有手动“发送错误给代码修复”能力：`RepairFromFailure` 可把 `test_verification`、`image_build` 和 `health_check_failed` 的 `deployment` 回退到 `code_generation`，但它目前由接口和按钮触发，不是自动触发。目标模型应把这类修复变成受限自动策略，并保留用户可见审计记录。

### 实现差距

要落地目标模型，至少需要补齐以下能力：

1. 持久化协作智能体参与计划、配置快照、依赖图和用户调整记录。
2. 将确认需求摘要扩展为“需求摘要 + 协作智能体参与计划”。
3. 增加协作编排智能体，用于生成默认计划和处理自然语言调整。
4. 将任务区从固定六卡片改为按参与智能体渲染的动态卡片和泳道。
5. 增加协作智能体详情中的 skill 查看、本次快照编辑、全局写回确认和审计。
6. 将代码审查、产品验收、安全审查和有界自动修复回路接入执行器。
7. 保持现有 `.claude/skills/*/agents/openai.yaml` 作为 Skill 附带 Agent Interface，不把它们误当成完整协作智能体定义。

### 持久化建议

目标模型应复用现有 `job_steps` 作为协作智能体任务卡片和执行记录归属的主表，而不是另建一套平行运行状态。现有 `step_execution_records`、`artifacts`、任务抽屉和 SSE 都已经围绕 `step_id` 工作；复用 `job_steps` 可以避免卡片状态、执行记录和产物归属双写。

建议落地路径：

1. `job_steps` 继续承载每个协作智能体节点的状态、尝试次数、执行记录归属和产物归属。
2. 在任务级新增 `collaboration_plan_json` 或等价计划表，保存协作图、泳道、配置快照、高影响确认记录和编排说明。
3. 新增 `job_step_edges` 或等价结构，表达协作智能体 DAG 依赖。
4. MVP 先按 DAG 拓扑序串行执行同一任务内的协作智能体；UI 展示协作图和泳道，但暂不并行执行同一任务内的多个节点。
5. 后续把 `jobs.current_step_kind` 从固定线性阶段指针演进为 DAG 调度状态，并在取消、重试、失败传播和自动修复回路成熟后再支持单任务内部并行。

## 推荐维护约定

1. 新增 skill 时，优先放在 `.claude/skills/<skill-name>/SKILL.md`，并在 frontmatter 中提供稳定的 `name` 和明确的 `description`。
2. 只有当某个 skill 需要对外暴露为可选择的数据/能力 interface 时，才新增 `.claude/skills/<skill-name>/agents/openai.yaml`。
3. 避免把 `agents/openai.yaml` 称为完整 agent；推荐统一称为 **Skill 附带 Agent Interface**。
4. 软件工厂执行流水线 agent 的增删改应在 `factory-server/internal/agents/registry.go` 中完成，并保持 sort order、key、role 的兼容性。
5. 数据 skill 必须保留诚实数据边界：真实来源优先，失败时显式降级，不用 mock 值伪装真实数据。
