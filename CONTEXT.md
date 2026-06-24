# Software Factory Context

This context defines the product language for the local intelligent software factory: how users move from a conversational request to a generated, deployed application.

## Language

**需求澄清会话**:
A software-development subflow within a dialogue session where the system refines an application requirement before any generation task is created.
_Avoid_: 生成任务, Job, 任务

**对话会话**:
A persistent, resumable conversation for one application lineage that first identifies the user's intent, then routes to an existing application recommendation or application-generation requirement clarification. It may contain multiple generation tasks over time, including later application modifications; a request for a distinct application starts a new dialogue session; business-processing agent drafting is not a user-visible route in the current phase.
_Avoid_: 单次路由结果, 生成任务, 仅需求澄清会话

**会话阶段**:
The current interaction stage within a continuing dialogue session, such as clarification, change confirmation, task execution, deployment outcome, or waiting for user input. A phase does not end the dialogue session.
_Avoid_: 会话终态, 任务状态, 生成完成即关闭

**会话分析轮次**:
One model-driven analysis of a user message within a dialogue session. A session runs at most one analysis round at a time; later messages wait in order or replace the current round when the user cancels it.
_Avoid_: 并行澄清轮次, 无序模型调用, 生成任务

**会话路由**:
The initial route inferred for a dialogue session: existing-application reuse or application generation. It establishes the first conversation context; business-processing agent drafting is a dormant future route, and any model suggestion of that route is treated as application generation in the current phase.
_Avoid_: 生成任务状态, 智能体角色, 轮次意图

**轮次意图**:
The user need inferred from one new message in a continuing dialogue session: application modification, new application, application inquiry, task control, or general dialogue. It determines the next interaction without reclassifying the session's initial route.
_Avoid_: 会话路由, 生成任务状态, 固定标签

**已有应用复用**:
An intent outcome in which a configured existing application is judged to satisfy the user's need and is recommended for direct use rather than generating a duplicate application.
_Avoid_: 场景蓝本生成, 应用复制, 自动新建应用

**应用生成**:
An intent outcome in which Factory clarifies and creates a new runnable application after the user confirms the requirement. A configured available scene blueprint may guide the generated application, but application generation is still allowed when no scene blueprint matches.
_Avoid_: 已有应用复用, 业务处理智能体草稿, 复制场景源代码

**助手应用**:
A generated application that presents an assistant-like or agent-like workflow as a runnable software product. In the current phase, user requests to create an intelligent agent are routed to assistant-application generation rather than business-processing agent drafting.
_Avoid_: 业务处理智能体定义, 不可运行 prompt, 右侧业务处理 Tab 项

**会话草稿**:
A not-yet-persisted dialogue placeholder that becomes a dialogue session only after the user sends the first request.
_Avoid_: 生成任务草稿, 空任务

**历史会话**:
A previously created dialogue session that remains available for review or continuation according to its lifecycle state.
_Avoid_: 任务历史, 应用历史

**会话归档**:
The user-initiated removal of a continuing dialogue session from active work without removing its messages, visible work trace, application lineage, or audit records.
_Avoid_: 会话删除, 应用删除, 完成后自动关闭

**会话删除**:
An explicitly confirmed, irreversible removal of a dialogue session and its messages, visible work trace, and audit attachments.
_Avoid_: 会话归档, 应用删除, 自动清理

**会话工作台**:
The central portal experience for reviewing and continuing a dialogue session, including intent results, model analysis process, route-specific confirmation, and application requirement clarification where applicable.
_Avoid_: 需求澄清区域, 独立澄清面板, 任务区

**生成任务**:
A confirmed, independently executable unit of work within a dialogue session that creates or modifies one application version through the software factory pipeline.
_Avoid_: 澄清会话, 对话, 应用

**焦点任务**:
The task shown by default for the selected dialogue session: its newest non-terminal task, or its most recently completed task when none remain active. Its execution start time is distinct from its queueing time.
_Avoid_: 全局当前任务, 最近创建任务, 排队开始时间

**应用版本**:
A deployable revision of an application produced by one generation task. Versions preserve the application's linear evolution within its continuing dialogue session and identify the preceding version as their baseline.
_Avoid_: 独立应用, 覆盖式修改, 会话版本

**应用谱系**:
One application and its ordered versions, generation tasks, deployments, and continuing dialogue session. A distinct application has a distinct application lineage and dialogue session.
_Avoid_: 多应用混合会话, 无关联任务集合

**生效版本**:
The one application version currently serving users. A new version becomes effective only after deployment and health verification succeed; a failed deployment leaves the prior effective version available.
_Avoid_: 正在构建版本, 未验证部署, 已失效版本

**应用修改**:
A user-requested change to an application already linked to the dialogue session. It retains that application's identity and creates a new application version after confirmation and deployment.
_Avoid_: 新建重复应用, 覆盖历史版本, 独立会话

**应用**:
A runnable software product shown in the portal application list, either imported from preset manifests or produced by a completed generation task. Its user-facing surface label is **智能体** (the produced agent-product is what the user builds, opens, and manages); the internal entity name **应用** is retained in code and this glossary. The pipeline agents (软件开发智能体) appear only on non-workbench surfaces such as the 软件开发 tab, so they do not collide with the user-facing 智能体 label.
_Avoid_: 任务, 会话, 模板

**应用删除**:
The removal of a generated application's portal record, runtime deployment state, and local generated application directory while retaining the clarification and generation audit trail.
_Avoid_: 删除生成任务, 删除历史会话, 清空审计记录

**预置应用**:
A bundled runnable application selected by the product catalog to be shown in the portal application list before any user generation task is run. A preset scenario belongs either to the application list or to the available scene-blueprint catalog, not both.
_Avoid_: 模板, 生成应用, 生成任务

**系统状态日志**:
A factory-generated message that reports workflow state changes during a clarification session or generation task.
_Avoid_: 分析工作日志, 原始思考过程

**分析工作日志**:
A user-facing record of an agent's recognized user goal, identified facts, proposed approach, assumptions, clarification needs, recommendations, tool activity summaries, data-source decisions, and validation results. It is a part of the visible work trace and never contains hidden model reasoning.
_Avoid_: 原始思考过程, 思维链, 系统状态日志

**模型分析过程**:
The analysis portion of the visible work trace shown inside a clarification conversation, composed from structured analysis work logs and model output summaries.
**模型思考过程 (思考过程)**: The model's raw reasoning (`thinking_delta`), streamed live on the conversation surface as a 思考过程 block (distinct from 分析过程). Shown to the user token-by-token; the conversation flow surfaces it (the executor/trace pipeline is a separate surface).

**可见工作轨迹**:
An ordered, persistent, user-facing record of analysis, tool activity, data-source decisions, validation, output, and state changes for a dialogue or generation task. It is pushed in real time and can be replayed after a reconnect; every event is attributed to its dialogue and, where applicable, its task; hidden model reasoning is excluded.
_Avoid_: 原始思维链, 仅最终回复, 无归属的原始输出

**工作轨迹事件**:
One ordered fact in a visible work trace, carrying its identity, dialogue-level sequence, occurrence time, dialogue attribution, and any applicable task, application, version, step, or attempt attribution. Task and step local sequences additionally verify the completeness of their own execution stream.
_Avoid_: 无序日志行, 仅实时消息, 原始模型输出

**审计附件**:
A size-limited, redacted retained artifact supporting a visible work trace event, such as a command-output excerpt or interface-response excerpt. It is distinct from the long-lived semantic audit record.
_Avoid_: 未受限原始日志, 聊天流正文, 临时浏览器数据

**步骤执行记录**:
The auditable record for one generation-task pipeline step, combining system status logs, user-facing analysis work logs where applicable, execution output, and linked artifacts without treating raw model reasoning as product content.
_Avoid_: 智能体思维链, 原始推理, 单纯运行日志

**确认需求摘要**:
The structured requirement record confirmed by the user after clarification and used as the input for creating a generation task.
_Avoid_: 初始需求, 聊天记录, 分析工作日志

**推荐收敛确认**:
A late-stage clarification interaction that presents the remaining decisions with their recommended values, so the user can accept the recommended set or make a targeted adjustment before confirming the requirement summary.
_Avoid_: 最终生成确认, 普通澄清问题, 强制默认值

**高影响确认事项**:
An unresolved decision that can change business meaning, data source, external interface, permission, deployment, or user-visible behavior. It must be confirmed before the agent continues the affected work.
_Avoid_: 默认假设, 低风险细节, 静默推断

**模板约束下的自由生成**:
A generation mode where the factory can create a new application for a confirmed requirement while keeping the result within the product's supported structure, style, and deployability boundaries.
_Avoid_: 只能复制模板, 完全自由生成

**场景蓝本**:
A reusable description of a customer scenario and product intent that guides requirement clarification and generation profile selection. It is not a runnable application or a copyable code template.
_Avoid_: 应用, 预置应用, 模板应用, 代码模板

**可用场景蓝本**:
A scene blueprint selected by the product catalog as a hidden internal reference for generated application requirements. It can improve requirement clarification and generation fit, but it is not a prerequisite for application generation and is never presented to the user as a product constraint, an unavailable capability, or an existing application to open directly.
_Avoid_: 预置应用, 可复制模板, 应用列表项, 面向用户的支持范围

**场景目录**:
The single product catalog that assigns each preset scene to exactly one surface: a listed preset application, a hidden available scene blueprint, or neither. It is the shared source for application display and intent-classification candidates.
_Avoid_: 多份可见性配置, 独立蓝本开关, 隐式场景暴露

**客户场景名称**:
The original scenario wording supplied by the user and retained as conversation and requirement context, even when the generated application receives a normalized scenario name.
_Avoid_: 内部名称, slug, 场景蓝本名

**客户提供场景**:
A scenario explicitly supplied by the customer as source material for requirements, demo prompts, preset content, or scene blueprints. Its customer-facing numbering follows the customer's submission order and is independent from any internally added demo scenarios.
_Avoid_: 内部演示场景, 应用排序编号, Factory 自建样例

**内部演示场景**:
A Factory-added scenario used to enrich local demos or preset coverage, but not counted as part of the customer's supplied scenario sequence.
_Avoid_: 客户提供场景, 客户场景序号

**规范化场景名称**:
A concise human-facing scenario title inferred by the model from the confirmed requirement and used as the readable prefix of a generated application name.
_Avoid_: demo 名称, slug, 原始输入全文

**生成应用名称**:
The human-facing name of a generated application, composed from its normalized scenario name and a Factory-owned random serial value to prevent name collisions.
_Avoid_: demo1, 场景蓝本 slug, 纯随机名称

**客户判断口径**:
The original thresholds, labels, and scenario interpretations supplied by the customer and preserved in preset application content and demo logic. It is the customer's stated framing, not a new interpretation invented by the factory.
_Avoid_: 系统改写口径, 降级文案, 自行推断

**研判参数**:
A threshold, time window, distance, cadence, or confidence cutoff used by a judgement rule. Customer-provided values are the demo defaults, but future applications may let users adjust them or read them from an external interface without changing the scenario's judgement framing.
_Avoid_: 不可变硬编码, 系统自创阈值, 与客户口径无关的配置项

**演示数据契约**:
A mock-data boundary that represents external feeds with realistic, replaceable payload shapes while keeping preset applications runnable without live integrations.
_Avoid_: 真实数据接入, 临时假数据, 后端采集服务

**数据接入能力包**:
A project-local skill or adapter contract that defines how a future generated application should connect to a real external data source, including authentication assumptions, request/response shape, and replacement points for the demo data provider.
_Avoid_: 场景蓝本, 预置应用代码, 当前必须实现的实时采集服务

**工具授权**:
The permission level governing an agent's use of a tool or interface. Trusted read-only operations may run automatically with visible trace events; unconfigured, sensitive, costly, writing, deployment, rollback, and destructive operations require the applicable user confirmation.
_Avoid_: 无限制自动调用, 每一步重复确认, 隐式写入

**态势复盘类应用**:
An application type focused on reviewing time-based operational activity through maps, tracks, events, and timelines.
_Avoid_: 普通地图页面, 静态展示页

**业务管理类应用**:
An application type focused on managing domain objects such as equipment, logistics, personnel, plans, or support resources through work-focused operational views.
_Avoid_: 通用 CRUD 页面, 后台模板

**指挥看板类应用**:
An application type focused on summarizing operational state, alerts, progress, and resource posture for command or duty workflows.
_Avoid_: 普通数据大屏, 装饰性仪表盘

**归属研判类应用**:
A command-dashboard subtype focused on inferring relationships between observed activity events and candidate parent entities, using association counts, confidence thresholds, timelines, relationship views, and alert conditions.
_Avoid_: 态势复盘类应用, 普通告警看板, 单纯轨迹展示

**归属置信度**:
The share of one aircraft's carrier-bound takeoff/landing associations that point to a given carrier. Unbound suspected carrier-flight events are reported separately and do not dilute this confidence denominator.
_Avoid_: 全部疑似起降占比, 未绑定事件惩罚项, 模型自评分

**疑似交叉部署飞机**:
An aircraft associated with two or more carriers where no single carrier exceeds the configured high-confidence affiliation threshold. It displays per-carrier association probabilities rather than a single assigned carrier.
_Avoid_: 高置信度属舰飞机, 数据不足飞机, 已离舰飞机

**数据不足飞机**:
An aircraft with too few carrier-bound associations to make a stable affiliation judgement. The default demo minimum sample parameter is three bound associations; this may later be supplied by user interaction or an interface.
_Avoid_: 疑似交叉部署飞机, 无活动飞机, 未识别飞机

**时空关联绑定**:
The step that binds a suspected carrier-aircraft takeoff or landing event to the carrier whose known position is closest in time and within the configured distance threshold. The default customer threshold is 200 nautical miles; demo data reports the carrier-position time delta rather than interpolating carrier tracks.
_Avoid_: 轨迹插值绑定, 任意距离最近绑定, 忽略时间差的空间匹配

**海上起降事件**:
A suspected carrier-aircraft takeoff or landing event extracted from an ADS-B trajectory when altitude transitions between near-ground and positive flight states and the event coordinate is at sea. The customer judgement is zero-to-positive takeoff and positive-to-zero landing; demo processing may apply a near-ground noise threshold without changing that framing.
_Avoid_: 机场起降, 普通低空轨迹点, 未经海面筛选的高度变化

**海陆掩膜判断**:
The classification of a takeoff or landing coordinate as sea, land, or unknown before deciding whether it is a suspected carrier-aircraft event. In demo data this is carried as an explicit field; future real integrations may replace it with a geographic land/sea mask adapter.
_Avoid_: 手写海岸线算法, 默认所有低空点为海上点, 当前必须接入 GIS 数据源

**已离舰**:
An alert label applied only to a high-confidence carrier-assigned aircraft when it has no takeoff or landing event near its assigned carrier for 30 consecutive days.
_Avoid_: 交叉部署飞机离舰, 任意航母附近未活动, 普通不活跃

**海事告警指挥看板**:
A command dashboard subtype focused on maritime monitoring, thresholds, refresh cadence, sea-area or port objects, map/grid overlays, and alert state.
_Avoid_: 普通指挥看板, 态势复盘类应用, 业务管理类应用

**生成能力包**:
A project-local set of Claude Code skill instructions that guides application generation for a supported structure, visual language, or application pattern.
_Avoid_: 全局个人技能, 普通模板文件

**生成能力画像**:
The selected set of generation skill keys derived from a confirmed requirement and passed into the generation task.
_Avoid_: 用户手选技能, 随机 agent 偏好

**软件开发智能体**:
A Factory-owned agent that performs one fixed responsibility in the application-generation pipeline, such as requirement analysis, solution design, code generation, testing, image build, or deployment.
_Avoid_: 业务处理智能体, 用户自定义智能体, 场景蓝本

**业务处理智能体**:
A user-confirmed definition of a business-handling role, containing a name, description, and prompt. In this phase it is cataloged and displayed but not directly executed.
_Avoid_: 软件开发智能体, 已运行任务, 生成应用

**业务处理智能体建议**:
A dormant future route that would recommend creating a business-processing agent and ask for the user's confirmation. It is not exposed as a current user-visible dialogue outcome while intelligent-agent requests are routed to assistant-application generation.
_Avoid_: 不支持提示, 无蓝本提示, 自动降级
