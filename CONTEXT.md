# Software Factory Context

This context defines the product language for the local intelligent software factory: how users move from a conversational request to a generated, deployed application.

## Language

**需求澄清会话**:
A software-development subflow within a dialogue session where the system refines an application requirement before any generation task is created.
_Avoid_: 生成任务, Job, 任务

**对话会话**:
A persistent, resumable conversation for one application lineage that first identifies the user's intent, then routes to an existing application recommendation or application-generation requirement clarification. It may contain multiple generation tasks over time, including later application modifications; a request for a distinct application starts a new dialogue session; business-processing agent drafting is not a user-visible route in the current phase.
_Avoid_: 单次路由结果, 生成任务, 仅需求澄清会话

**会话附件**:
A user-uploaded source file attached to a dialogue session and, when applicable, to the current orchestration clarification focus. It may support requirements, interface parsing, or data capture, but it is not itself a generated project document or machine execution contract.
_Avoid_: 项目文档, 机器执行契约, 明文密钥文件

**受控凭证输入**:
A sensitive authentication value or secret supplied for external data access, handled through a controlled credential path rather than as a normal session attachment. It may be used for runtime verification or configuration only under authorization and lifecycle rules; redaction applies before persistence, streaming, logging, audit display, or project-document output.
_Avoid_: 普通会话附件, 项目文档内容, 工作轨迹明文

**待发送附件**:
A session attachment staged in the conversation composer before the user sends the message. It appears as a thumbnail or file chip and can be removed from the pending message before submission.
_Avoid_: 已确认附件引用, 项目文档, 任务产物

**会话附件引用**:
The immutable message-level reference to an attachment after the user sends a conversation message. It remains visible on the message timeline and can be opened for preview, so later agent work can trace which attachment supported the turn.
_Avoid_: 可随意抹除的临时文件, 项目文档链接, 机器执行契约

**附件引用停用**:
A user action that prevents an already-sent attachment reference from being used as context in later agent work while preserving the historical message reference for replay and audit. It is not a hard deletion of the uploaded file or message history.
_Avoid_: 硬删除附件, 清空历史消息, 隐式移除已用输入

**附件投影**:
The controlled copy, extraction, or summary of a relevant session attachment into the generated application project after a generation task exists. It gives task steps stable project-local inputs without depending on browser upload temp files.
_Avoid_: 浏览器临时文件引用, 未归属复制, 直接覆盖项目文档

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

**会话导航栏**:
The left workbench navigation surface for creating a new dialogue session and switching among historical dialogue sessions.
_Avoid_: 应用列表, 业务智能体列表, 历史会话抽屉

**会话归档**:
The user-initiated removal of a continuing dialogue session from active work without removing its messages, visible work trace, application lineage, or audit records.
_Avoid_: 会话删除, 应用删除, 完成后自动关闭

**会话删除**:
An explicitly confirmed, irreversible removal of a dialogue session and its messages, visible work trace, and audit attachments.
_Avoid_: 会话归档, 应用删除, 自动清理

**会话工作台**:
The central portal experience for reviewing and continuing a dialogue session, including intent results, model analysis process, route-specific confirmation, and application requirement clarification where applicable.
_Avoid_: 需求澄清区域, 独立澄清面板, 任务区

**工作台抽屉**:
A collapsible auxiliary surface opened from the conversation workbench for task execution, collaboration-agent, or application-project views without occupying the central dialogue workspace.
_Avoid_: 固定右栏, 任务区, 悬浮恢复按钮

**执行波次**:
A visual grouping of collaboration-agent task cards whose dependency position allows them to be understood together in the task execution drawer. It describes dependency grouping, not necessarily concurrent execution.
_Avoid_: 并行任务, 固定六阶段泳道, 实际并发保证

**协作编排执行图**:
A conversation-flow visualization of collaboration-agent participation and dependency flow for one generation task, showing either collaboration agents or user-facing aggregate orchestration cards with their execution state and upstream/downstream relationship. It uses horizontal execution waves derived from the dependency graph, with a user-input origin card before the first agent or aggregate wave. Before confirmation it represents the planned orchestration; after confirmation it represents the accepted orchestration with real task execution state.
_Avoid_: 静态参与列表, 模拟执行动画, 真实并发保证, 自由漂浮网络图

**编排聚合卡片**:
A user-facing card in the conversation-workbench orchestration graph that presents one generation responsibility label or aggregates several downstream collaboration-agent responsibilities. The visible labels may be 业务逻辑, 界面解析, 数据抓取, and 生产交付, but this does not rename collaboration agents, change their bounded responsibilities, or merge their machine execution contracts.
_Avoid_: 协作智能体替换, 机器执行契约合并, 原始执行记录重命名

**编排澄清焦点**:
The single orchestration card whose clarification request is currently active in the conversation workbench. The execution graph may show sibling cards in the same wave, but the conversation input answers one clarification focus at a time before moving to the next focus.
_Avoid_: 并行澄清输入, 多智能体同框待答, 无归属用户回复

**编排产物确认**:
A user action that approves the current orchestration card's produced artifact package and allows Factory to advance the clarification focus or production flow. It confirms the artifact's acceptability; it is not a manual scheduler command.
_Avoid_: 手动调度下一步, 普通聊天回复, 无产物确认

**业务逻辑结果包**:
The business-logic card's user-visible result across two moments: before task creation the user confirms the confirmed requirement summary; after task creation the requirement-analysis step projects the associated requirement document. The task-owned document must validate against the confirmed summary, but it is not a second pre-task user confirmation gate.
_Avoid_: 任务创建前确认需求文档, 任务创建后的二次需求确认, 摘要文档不一致

**需求文档一致性校验**:
A machine validation that checks whether the task-owned requirement document projected from requirement analysis matches the user-confirmed requirement summary that created the task. A mismatch is repaired at the requirement-analysis step boundary rather than treated as a new pre-task confirmation.
_Avoid_: 人工二次确认需求, 跳过摘要校验, 下游静默采用冲突文档

**业务逻辑分析轨道**:
A lightweight expanded business-logic conversation-block visualization that shows the inputs, analysis steps, clarification needs, and outputs that lead to the business-logic result package. It communicates real analysis state without replacing the thinking process, requirement summary, or requirement document.
_Avoid_: 复杂流程编排图, 原始思维链替代品, 纯装饰进度

**上游变更回退**:
A user-confirmed return to an earlier orchestration card after its artifact package was already confirmed. It keeps superseded artifacts in history while marking downstream artifacts as needing regeneration or revalidation.
_Avoid_: 静默覆盖已确认产物, 删除历史产物, 无影响提示的返工

**折叠澄清摘要卡**:
The compact retained form of a completed orchestration clarification block in the conversation workbench. It keeps the agent label, completion state, thinking summary, confirmed artifact links, confirmation time, and an expand action after the detailed conversation folds.
_Avoid_: 删除历史澄清, 隐藏产物入口, 只显示完成图标

**编排卡片状态**:
The user-facing execution state shown on one card in the collaboration orchestration execution graph, derived from the planned/accepted orchestration and the real generation-task step state. The status language includes pending confirmation, waiting for upstream, ready to start, running, waiting for user input, completed, failed, and skipped; production-delivery aggregate cards may add automatic-repair and waiting-for-user-confirmation states. It is not a raw database status display.
_Avoid_: 原始 step.status, 假进度百分比, 仅颜色提示

**编排依赖线状态**:
The user-facing state of a dependency edge in the collaboration orchestration execution graph, derived from the upstream and downstream card states. A dependency line may be planned, inactive, flowing, completed, or blocked; animation communicates dependency readiness or execution flow, not fabricated progress.
_Avoid_: 假数据流, 纯装饰线条, 真实并发保证

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
A runnable software product shown in the portal application catalog, either imported from preset manifests, connected as an externally managed application, or produced by a completed generation task. Its user-facing surface label is **应用**; generated assistant-like products are applications, while 协作智能体 and 纳管智能体 remain agent concepts.
_Avoid_: 任务, 会话, 模板, 业务智能体, 生成智能体

**应用商店**:
The portal's global application catalog page for browsing, filtering, opening, and managing available applications outside any single dialogue session. It is an in-portal page switch that reuses portal application data and actions, including generated applications and scene-catalog entries assigned to the application surface; selecting an application opens an in-page detail view where operational actions live.
_Avoid_: 会话导航栏, 业务智能体列表, 工作台抽屉, 独立静态页, iframe, 卡片直接跳转

**应用商店入口**:
A global navigation affordance that switches the portal to the application store page. The primary entry lives in the portal's global toolbar, and the conversation workbench may expose a secondary button that performs the same page switch.
_Avoid_: 会话列表项, 工作台抽屉项, 应用项目入口

**应用类型标签**:
The user-facing Chinese category label derived from an application's internal type value and used for application-store filtering and display.
_Avoid_: 英文 type 原值, 前端硬编码新分类, 参考项目分类复制

**应用商店排序**:
The application-store display order that places generated applications first by newest creation time, then preset application-surface entries by their scene-catalog order, with stable name or slug ordering as a fallback.
_Avoid_: 随机排序, 纯创建时间排序, 忽略场景目录 order

**应用操作**:
The lifecycle actions exposed from an application detail view, including open, start, stop, rebuild image, refresh status, and generated-application-only regeneration or deletion.
_Avoid_: 预置应用删除, 生成智能体删除, 卡片外跳即操作

**纳管智能体**:
An externally managed agent entry that the portal can catalog and open, but that is not produced as a software-factory application and is not a collaboration agent in a generation task.
_Avoid_: 应用, 协作智能体, 业务智能体

**纳管智能体页面**:
A future global catalog page for browsing and opening managed agents, modeled after the application store but kept separate from the application catalog.
_Avoid_: 应用商店分类, 会话导航栏, 协作智能体抽屉

**应用项目**:
The project workspace for the application bound to the current dialogue session, containing generated requirements, plans, design documents, source code, configuration, tests, and related project files.
_Avoid_: 业务智能体列表, 纳管智能体列表, 应用列表

**机器执行契约**:
A structured, immutable step output such as `output.json` that the factory validates and uses to advance generation-task execution.
_Avoid_: 用户可编辑文档, Markdown 说明文档, 项目文档

**项目文档**:
A human-readable document in the application project, usually Markdown, projected from machine execution contracts and related context for user review.
_Avoid_: 机器执行契约, 审计附件, 任务执行日志

**项目文档预览**:
A read-only rich rendering of a project document inside the conversation workbench. User changes to the underlying content must be requested through the conversation so the owning task output, machine contract, document, and downstream inputs stay consistent.
_Avoid_: 直接编辑器, 绕过机器执行契约, 无归属文档修改

**项目文档索引**:
A factory-owned metadata file in an application project that links each project document to its source machine execution contract and generation attribution.
_Avoid_: 应用运行 manifest, 审计附件列表, 用户文档内容

**文档草稿**:
A user-edited project document state that is saved for review but has not been converted into a confirmed application modification or used by a generation task.
_Avoid_: 应用修改, 机器执行契约, 生效版本内容

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

**模型思考过程 (思考过程)**:
The model thinking stream shown live on the conversation surface as a 思考过程 block, distinct from 分析过程. It may be folded after completion and should not be labeled 原始思考过程 in the user interface.
_Avoid_: 原始思考过程, 分析工作日志, 系统状态日志

**任务思考过程**:
The `thinking_delta` emitted by a generation-task agent while a task card is executing, carried by a dedicated task-attributed thinking stream and shown in the dialogue conversation flow with credential redaction but without summarization or semantic rewriting. It is distinct from analysis work logs, visible work trace events, and step execution records.
_Avoid_: 分析工作日志, 可见工作轨迹, 步骤执行记录

**思考摘要**:
A concise user-facing summary shown after a 思考过程 block completes and folds. It helps the user review what the agent concluded without replacing the underlying task output, clarification request, requirement summary, or project document.
_Avoid_: 确认需求摘要, 项目文档, 分析工作日志

**任务执行块**:
A dialogue conversation-flow block representing one executing generation-task card or collaboration-agent step, containing its task thinking process, safe execution process, and step-level summary while remaining attributed to the parent generation task.
_Avoid_: 任务卡片, 右侧任务抽屉, 步骤执行记录

**任务内澄清请求**:
A dialogue conversation-flow card raised by an executing generation-task card when user input is required before that card can continue. It appears as an independent conversation item after the related task execution block; the user's chosen clarification is then recorded as a normal user dialogue message.
_Avoid_: 任务执行日志, 任务执行块内部内容, 普通需求澄清会话

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
The structured requirement record confirmed by the user after clarification and used as the input for creating a generation task. When dynamic collaboration agents are involved, it also confirms the collaboration agent participation plan before the task is created.
_Avoid_: 初始需求, 聊天记录, 分析工作日志, 任务创建后的二次确认

**研判边界**:
The business judgement frame captured during requirement clarification: the data sources, monitored objects and scope, judgement rules and thresholds, target judgement outcome, refresh or replay cadence, output view, and unavailable-data behavior for the generated application.
_Avoid_: 软件生成边界, 普通需求字段, 实现范围

**研判边界摘要**:
A concise user-facing summary of the judgement boundary captured in the confirmed requirement. In the current implementation it complements the selected data-source family without decomposing every rule, scope, cadence, or output view into separate schema fields.
_Avoid_: 完整实现规格, 原始需求复述, 隐式数据源承诺

**真实数据研判约束**:
A requirement-clarification constraint for customer-facing military or naval generated applications: judgement results must be based on real selected data-source boundaries rather than mock or demo values. Internal demos, preset applications, tests, and structural previews may still use demo data under their separate demo-data boundary.
_Avoid_: mock 结果选项, 演示数据研判结果, 静默降级为 mock

**数据来源边界**:
The real data-source family selected for a customer-facing judgement application, such as ontology data, public internet sources, specific social platforms, web crawling, or public search interfaces. It is a user-facing clarification decision distinct from the internal data policy used by the generation pipeline.
_Avoid_: dataPolicy 选项, mock/真实二选一, 数据接入实现细节

**本体数据源**:
A customer-provided ontology or DaaS data boundary with a documented access path, entity model, authentication handling, request shape, response shape, and coverage notes. It is the preferred source family when the requested judgement can be answered by known customer entities.
_Avoid_: 本体 MCP 泛称, 未验证客户库, 模型自造实体

**网络公开搜索**:
A high-level real-source family for public web search or public web result retrieval selected during clarification. In the current simplified clarification it is only a source-family choice; generated applications must still use runtime-accessible endpoints or an explicit proxy/connector and must not rely on generation-time agent tools as their live data source.
_Avoid_: 任意互联网数据, 未授权平台搜索, 默认可爬取

**可接入数据源**:
A data source that Factory may offer or confirm during clarification because it has a documented connector, authentication path where needed, request shape, coverage boundary, and failure behavior. A source mentioned only by a scenario or by the user is not accessible until this evidence exists.
_Avoid_: 凭空数据源, 场景文字里的来源, 未验证公网接口

**数据契约预览**:
A user-facing preview produced by the data-capture clarification flow that summarizes data sources, access paths, authentication assumptions, field mappings, refresh strategy, unavailable-data behavior, and sample records before production delivery consumes the data contract.
_Avoid_: 正式数据接入实现, 代码生成临时造数, 隐式数据承诺

**数据流验证轨道**:
An expanded data-capture conversation-block visualization that shows the current data source, verification or extraction steps, field-mapping progress, and downstream flow into the data contract, interface compatibility check, and production delivery. It communicates real validation state and fallback history, not fabricated progress.
_Avoid_: 顶部编排图细节, 假进度条, 纯装饰数据流

**数据链路摘要**:
The compact folded summary of the data-flow validation track, preserving the selected source path, failed fallback attempts, sample count, field count, and data-contract link after the data-capture block folds.
_Avoid_: 隐藏降级历史, 只显示完成图标, 无来源说明

**数据接入降级确认**:
A user-confirmed change from a preferred data-source boundary to a fallback boundary after the preferred source is unreachable, unauthorized, empty, or otherwise unusable. The fallback order for customer-facing generation is ontology data first, then public internet capture, then an explicit demonstration-data contract.
_Avoid_: 静默降级, mock 伪装真实数据, 自动放弃真实数据

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

**测试艇目标清单**:
A maritime monitoring input that lists suspected SEASATS test craft by identifier, name, latest known position, speed, and dimensions for screening and map placement.
_Avoid_: 完整轨迹数据集, 船舶资产台账, 生成假轨迹

**SEASATS 命名命中**:
A vessel-name match for suspected test craft where the name starts with SEASAT or SEASATS, case-insensitively, followed by TEST or a numeric suffix.
_Avoid_: 只接受单数 SEASAT, 任意包含 SEASAT, 忽略后缀

**测试艇尺寸命中**:
A vessel-dimension match where 4 by 2 is the strong customer feature and nearby 3 by 2 entries remain candidates marked for dimension review rather than being excluded.
_Avoid_: 直接丢弃 3x2, 任意尺寸通过, 只看尺寸不看行为

**单艇轨迹回放**:
A situation replay scope where one selected vessel has time-series AIS positions and other matched vessels may only have latest-position screening evidence until track data is supplied.
_Avoid_: 多艇完整轨迹, 伪造全量历史, 目标清单展示

**轨迹来源标记**:
The internal provenance label that distinguishes observed AIS track points, customer-provided latest positions, and generated extension tracks even when the customer-facing interface uses neutral wording.
_Avoid_: mock 伪装真实数据, 无来源轨迹, 对外误称真实 AIS

**重点监控区域**:
A configurable maritime area, expressed as a center-radius or polygon, used to judge port-adjacent stops, low-speed testing, repeated movement, and alert relevance.
_Avoid_: 仅 sea_name, 写死军港列表, 无边界区域描述

**低速活动**:
A vessel activity state where speed in knots is within the inclusive 0-3 kt threshold after applying the source-specific speed normalization.
_Avoid_: 原始未换算速度, 小于 3 不含边界, 任意短瞬时点

**持续低速告警**:
An alert raised when low-speed activity for the same vessel remains inside the same monitored area for at least the configured duration; the first-version default duration is 10 minutes.
_Avoid_: 单点低速告警, 全局慢速告警, 不可配置阈值

**疑似往返活动**:
A vessel movement pattern inside one monitored area where the traveled path is materially longer than the start-to-end displacement for a configured duration, indicating repeated or circling test movement.
_Avoid_: 单次掉头, 单纯航向变化, 跨区域长航线

**疑似 AIS 中断告警**:
An alert inferred from a time gap between consecutive AIS track points for the same MMSI, with severity raised when the gap is long or occurs near a monitored area.
_Avoid_: 已确认 AIS 关闭, 数据源缺失静默忽略, 任意缺口等同高危

**测试艇综合研判评分**:
A candidate scoring approach that combines name, dimensions, low-speed activity, monitored-area presence, repeated movement, and suspected AIS interruption to classify SEASATS test-craft evidence without requiring every signal to be present.
_Avoid_: 单条件硬筛选, 缺轨迹即排除, 所有规则必须同时满足

**生成能力包**:
A project-local set of Claude Code skill instructions that guides application generation for a supported structure, visual language, or application pattern.
_Avoid_: 全局个人技能, 普通模板文件

**生成能力画像**:
The selected set of generation skill keys derived from a confirmed requirement and passed into the generation task.
_Avoid_: 用户手选技能, 随机 agent 偏好

**协作智能体**:
A Factory-owned agent that contributes one bounded responsibility to application generation, either as a required pipeline capability or as a dynamically selected specialist in a user-confirmed collaboration plan.
_Avoid_: 业务处理智能体, 用户自定义智能体, 生成应用, Skill 附带 Agent Interface

**协作智能体参与计划**:
The user-confirmed set of collaboration agents and their relationships for one generation task. It may be adjusted before the task starts and then becomes the task's visible execution plan; its collaboration graph is an executable dependency plan rather than a decorative diagram and must be persisted with the task so it can be replayed after refresh, reconnect, retry, or history review.
_Avoid_: 全局固定流水线, 隐式 agent 选择, 生成能力画像, 仅展示流程图

**高影响协作智能体**:
A collaboration agent whose removal or disabling can change quality gates, data-source commitments, deployability, permissions, or user-visible generation outcomes. Removing one before generation requires an explicit high-impact confirmation and is recorded in the confirmed requirement summary.
_Avoid_: 普通显示开关, 静默删除, 低风险配置项

**协作编排智能体**:
A collaboration agent that proposes the default collaboration plan before task creation, explains agent selection and dependencies, interprets natural-language plan adjustments, and records user adjustments. It may appear as a visible orchestration hub in detailed or productized graph modes, but a simplified aggregate graph may hide it as an internal planning capability while still retaining its rationale and scheduling flow.
_Avoid_: 隐式调度器, 用户不可见默认值, 生成能力画像

**协作智能体配置快照**:
The per-generation persisted editable copy of a collaboration agent's name, description, selected skills, task-specific instructions, and copied skill content overrides. Editing this snapshot affects only the pending or running generation task; referenced skill files are viewable by default, and writing changes back to a global generation capability package requires separate explicit confirmation.
_Avoid_: 直接修改全局 Skill, 业务处理智能体 Prompt, 临时 UI 状态

**协作智能体库**:
The product surface that lists reusable collaboration-agent definitions for viewing, enabling, disabling, copying, and creating custom versions. Built-in definitions are system-owned defaults; custom definitions may be selected into a dialogue or task plan and are still frozen into a task-local snapshot before execution.
_Avoid_: 任务执行记录列表, 纳管智能体页面, 直接编辑内置流水线契约

**协作智能体定义**:
The reusable global definition of a collaboration agent, including its key, label, role, description, selected skills, default instructions, category, and enablement state. It is distinct from a task participation plan and from the task-local configuration snapshot used during execution.
_Avoid_: 任务步骤, 运行中子进程, 业务处理智能体 Prompt

**内置协作智能体**:
A system-owned collaboration-agent definition that ships with Factory and participates in default generation plans. It may be viewed, enabled, disabled, or copied, but direct mutation is avoided so default pipeline behavior and historical replay remain stable.
_Avoid_: 可直接覆盖的自定义智能体, 业务处理智能体, 临时任务配置

**自定义协作智能体**:
A user-created or copied collaboration-agent definition that may be selected into future collaboration plans. It does not rewrite existing task snapshots and must still be frozen into a task-local collaboration-agent configuration snapshot before execution.
_Avoid_: 修改历史任务, 全局替换内置智能体, 未冻结运行配置

**协作智能体任务卡片**:
A task-area card representing one collaboration agent that participates in the confirmed collaboration plan. Cards are grouped by execution lane but keep their own status, detail drawer, editable snapshot, execution records, artifacts, and retry or repair actions.
_Avoid_: 固定六阶段卡片, 纯展示卡片, 阶段汇总行

**有界自动修复回路**:
A generation-task recovery policy where review, verification, or repairable runtime failures may automatically route back to code generation with failure context, limited by an explicit maximum attempt count. The default limit is two automatic repair loops per task and one automatic repair for the same blocking reason; infrastructure failures and non-repairable deployment errors do not enter this loop.
_Avoid_: 无限重试, 手动重试当前阶段, 失败后直接重新生成整个应用

**代码审查门禁**:
A collaboration-agent checkpoint that reviews generated code before later verification or build stages and separates blocking findings from advisory findings. Only concrete, actionable issues that affect correctness, deployability, data honesty, security, or confirmed user-visible behavior block the task and may enter the bounded automatic repair loop.
_Avoid_: 纯建议审查, 主观风格阻断, 测试验证替代品

**安全审查智能体**:
A conditional collaboration agent that joins generation when the requirement involves public data access, authentication, uploads, external interfaces, sensitive data, permissions, or exposed deployment surfaces. It reviews security and permission risks separately from general code review.
_Avoid_: 普通代码审查, 所有任务强制安全门禁, 部署健康检查

**产品验收智能体**:
A default collaboration agent that checks the generated application against the confirmed requirement summary, design contract, data contract, and main user workflows after verification and before build/deploy. It focuses on product fit rather than code structure or command success.
_Avoid_: 代码审查门禁, 测试验证, 用户最终验收

**领域分析智能体**:
A collaboration agent that brings domain knowledge into requirement analysis and solution design by interpreting selected generation capability packages, scene blueprints, data-source boundaries, and customer judgement language. It remains a general role until a domain has its own execution contract, data boundary, and review standard.
_Avoid_: 固定海事智能体, 场景蓝本, 生成能力包

**数据接入智能体**:
A collaboration agent that defines data-source boundaries for a generation task, including real data integration plans, required capability packages, runtime-accessible connectors, unavailable-data behavior, and demo data contracts. It owns mock data shape as a replaceable contract, not as a substitute for real data promises.
_Avoid_: 代码生成临时造数, mock 伪装真实数据, 单个数据 Skill

**界面设计智能体**:
A collaboration agent that turns confirmed requirements, domain analysis, and data contracts into a structured design contract for generated application views, layout regions, components, interaction states, UI data mapping, responsive constraints, and visual style boundaries.
_Avoid_: 纯文本设计建议, 代码实现计划, 营销页包装

**原型设计**:
A user-confirmed generation-task step that consumes the requirement-analysis document and produces a previewable static application prototype before solution design and code generation continue. It may ask step-scoped questions about style, target user, target platform, and fidelity when natural-language feedback is ambiguous or high-impact.
_Avoid_: 需求澄清会话, 方案设计, 最终应用代码, 任意高保真交互

**原型设计偏好**:
The user-confirmed design choices that guide prototype generation, including prototype style, target audience such as UED or developers, target platform, fidelity, and whether high-fidelity interaction is explicitly required.
_Avoid_: 隐式默认风格, 代码实现细节, 未确认高保真范围

**静态原型页面**:
A previewable HTML/CSS/JS artifact generated by the prototype-design step for user review, defaulting to a static homepage while allowing additional pages to be listed or generated. Interactive behavior belongs here only when the user explicitly asks for a high-fidelity prototype.
_Avoid_: 生成应用, 部署版本, 方案文档, 默认可交互应用

**设计契约**:
The structured output of the interface-design agent that code generation consumes as a UI and interaction contract. It includes view inventory, layout structure, component responsibilities, loading/empty/error states, field-to-UI mapping, mobile constraints, and visual style constraints.
_Avoid_: 灵感稿, 最终代码, 非结构化设计说明

**界面预览产物**:
A task-owned preview artifact produced after interface-parsing clarification so the user can inspect the proposed interaction surface before production delivery. It may be static files or a preview build, but it is not an effective application version, application-store entry, or deployment outcome.
_Avoid_: 生效版本, 正式应用, 生产交付结果

**界面解析结果包**:
The confirmed output set of interface parsing, consisting of the structured design document and the interface preview artifact. The two must stay consistent; when a user-confirmed preview changes the intended interface, the design contract and design document must be updated to match it.
_Avoid_: 只有预览无契约, 只有文档无预览, 文档预览不一致

**界面构成轨道**:
A lightweight expanded interface-parsing conversation-block visualization that shows inputs, parsing steps, and outputs for the interface result package. It highlights real progress through view recognition, layout partitioning, component mapping, interaction states, and preview generation without competing with the preview itself.
_Avoid_: 复杂独立流程图, 纯装饰动效, 替代界面预览

**界面验收基准**:
The user-confirmed interface preview artifact that production delivery must preserve as the user-facing baseline for layout, core interaction paths, visual style, density, key copy, and field presentation. It remains subject to data-contract compatibility checks; significant production or data-driven deviations require an explicit interface-difference explanation and user confirmation.
_Avoid_: 仅供参考的灵感稿, 可静默重做的页面, 无兼容校验的生效版本

**界面验收快照**:
An immutable retained record of the confirmed interface preview, such as a static build artifact, screenshot set, preview manifest, content hash, or equivalent evidence. It may be retained while the baseline is still provisional and becomes the comparison evidence once data-contract compatibility promotes the preview to the interface acceptance baseline.
_Avoid_: 临时预览运行时, 可变预览链接, 无法回放的视觉记忆

**界面数据兼容校验**:
A check that compares the field and state assumptions used by a confirmed interface preview with the later confirmed data contract. At minimum, every field or state the preview depends on must be available in the data contract or have an explicitly confirmed fallback before production delivery can treat the preview as compatible.
_Avoid_: 静默字段替换, 数据契约冲突后继续交付, 只看视觉截图

**生产交付聚合卡片**:
The orchestration graph card that represents the downstream delivery sequence after business logic, interface parsing, and data capture are confirmed. It summarizes the currently executing internal collaboration-agent stage while preserving each underlying task step, document, artifact, and audit attribution.
_Avoid_: 单个真实智能体, 隐藏步骤执行记录, 跳过生产门禁

**临时预览部署**:
A temporary runtime used only when an interface preview needs dynamic interaction, routing, state, or mock runtime data to be inspected. It supports design confirmation and is discarded or superseded before production delivery.
_Avoid_: 生效版本部署, 应用商店运行实例, 生产交付

**业务处理智能体**:
A dormant future concept for a user-confirmed business-handling role definition. It is not the current user-facing product produced by the software factory; requests to create an intelligent business tool are treated as application generation.
_Avoid_: 协作智能体, 已运行任务, 生成应用, 业务智能体

**业务处理智能体建议**:
A dormant future route that would recommend creating a business-processing agent and ask for the user's confirmation. It is not exposed as a current user-visible dialogue outcome while intelligent-agent requests are routed to assistant-application generation.
_Avoid_: 不支持提示, 无蓝本提示, 自动降级
