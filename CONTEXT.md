# Software Factory Context

This context defines the product language for the local intelligent software factory: how users move from a conversational request to a generated, deployed application.

## Language

**需求澄清会话**:
A conversational session where the system helps the user refine an initial application request before any generation task is created.
_Avoid_: 生成任务, Job, 任务

**生成任务**:
A confirmed unit of work that runs the software factory pipeline to create, verify, build, and deploy an application.
_Avoid_: 澄清会话, 对话, 应用

**应用**:
A runnable software product shown in the portal application list, either imported from preset manifests or produced by a completed generation task.
_Avoid_: 任务, 会话, 模板

**预置应用**:
A bundled runnable application that demonstrates a supported scenario before any user generation task is run. It can serve as a reference for future generated applications, but it is not itself a template.
_Avoid_: 模板, 生成应用, 生成任务

**系统状态日志**:
A factory-generated message that reports workflow state changes during a clarification session or generation task.
_Avoid_: 分析工作日志, 原始思考过程

**分析工作日志**:
A user-facing, model-generated, structured explanation of what the requirement analysis agent identified, why it recommends a choice, and what still needs confirmation.
_Avoid_: 原始思考过程, 思维链, 系统状态日志

**步骤执行记录**:
The auditable record for one generation-task pipeline step, combining system status logs, user-facing analysis work logs where applicable, execution output, and linked artifacts without treating raw model reasoning as product content.
_Avoid_: 智能体思维链, 原始推理, 单纯运行日志

**确认需求摘要**:
The structured requirement record confirmed by the user after clarification and used as the input for creating a generation task.
_Avoid_: 初始需求, 聊天记录, 分析工作日志

**模板约束下的自由生成**:
A generation mode where the factory can create a new application for a confirmed requirement while keeping the result within the product's supported structure, style, and deployability boundaries.
_Avoid_: 只能复制模板, 完全自由生成

**场景蓝本**:
A reusable description of a customer scenario and product intent that guides requirement clarification and generation profile selection. It is not a runnable application or a copyable code template.
_Avoid_: 应用, 预置应用, 代码模板

**客户场景名称**:
The original scenario name supplied by the customer and preserved as the application display name, even when internal identifiers or blueprint names need to disambiguate similar scenarios.
_Avoid_: 内部名称, slug, 场景蓝本名

**客户判断口径**:
The original thresholds, labels, and scenario interpretations supplied by the customer and preserved in preset application content and demo logic. It is the customer's stated framing, not a new interpretation invented by the factory.
_Avoid_: 系统改写口径, 降级文案, 自行推断

**演示数据契约**:
A mock-data boundary that represents external feeds with realistic, replaceable payload shapes while keeping preset applications runnable without live integrations.
_Avoid_: 真实数据接入, 临时假数据, 后端采集服务

**态势复盘类应用**:
An application type focused on reviewing time-based operational activity through maps, tracks, events, and timelines.
_Avoid_: 普通地图页面, 静态展示页

**业务管理类应用**:
An application type focused on managing domain objects such as equipment, logistics, personnel, plans, or support resources through work-focused operational views.
_Avoid_: 通用 CRUD 页面, 后台模板

**指挥看板类应用**:
An application type focused on summarizing operational state, alerts, progress, and resource posture for command or duty workflows.
_Avoid_: 普通数据大屏, 装饰性仪表盘

**海事告警指挥看板**:
A command dashboard subtype focused on maritime monitoring, thresholds, refresh cadence, sea-area or port objects, map/grid overlays, and alert state.
_Avoid_: 普通指挥看板, 态势复盘类应用, 业务管理类应用

**生成能力包**:
A project-local set of Claude Code skill instructions that guides application generation for a supported structure, visual language, or application pattern.
_Avoid_: 全局个人技能, 普通模板文件

**生成能力画像**:
The selected set of generation skill keys derived from a confirmed requirement and passed into the generation task.
_Avoid_: 用户手选技能, 随机 agent 偏好
