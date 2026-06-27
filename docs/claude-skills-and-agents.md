# Claude Skills and Agents

本文梳理仓库内 `.claude/` 目录下的 skills 与 agent interface，并说明它们和软件工厂运行时流水线 agents 的边界。

## 术语边界

本仓库里有三类容易混淆的对象：

1. **Skill**：位于 `.claude/skills/<skill-name>/SKILL.md`，描述某类生成、澄清、路由、UI 或数据接入能力。
2. **Skill 附带 Agent Interface**：位于 `.claude/skills/*/agents/openai.yaml`，是部分数据能力包暴露给外部/编排层的轻量 interface 元数据。
3. **运行时流水线 Agent**：位于 `factory-server/internal/agents/registry.go`，是软件工厂实际生成、测试、构建、部署流水线中的固定 agent 注册表；它不在 `.claude/` 下。

因此，本文中的 “`.claude/ 下的 agent`” 特指 **Skill 附带 Agent Interface**。如果讨论软件工厂执行流程中的 agent，应称为 **运行时流水线 Agent**。

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

## 推荐维护约定

1. 新增 skill 时，优先放在 `.claude/skills/<skill-name>/SKILL.md`，并在 frontmatter 中提供稳定的 `name` 和明确的 `description`。
2. 只有当某个 skill 需要对外暴露为可选择的数据/能力 interface 时，才新增 `.claude/skills/<skill-name>/agents/openai.yaml`。
3. 避免把 `agents/openai.yaml` 称为完整 agent；推荐统一称为 **Skill 附带 Agent Interface**。
4. 软件工厂执行流水线 agent 的增删改应在 `factory-server/internal/agents/registry.go` 中完成，并保持 sort order、key、role 的兼容性。
5. 数据 skill 必须保留诚实数据边界：真实来源优先，失败时显式降级，不用 mock 值伪装真实数据。
