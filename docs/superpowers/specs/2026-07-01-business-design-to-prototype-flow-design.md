# 业务设计方案交接原型设计流程

## 背景

当前 Factory 已有用户可见的 `业务逻辑` 与 `界面解析` 聚合步骤，内部 `design_contract` step 也已经开始承担界面解析职责，并有项目本地 skill：

```text
.claude/skills/prototype-design/SKILL.md
```

本设计采用兼容升级路线：不新增新的 step kind，继续保留内部 `design_contract`，但把该步骤作为“界面解析/原型设计”执行。业务智能体完成后输出完整设计方案，`design_contract` 必须读取这份完整方案和 `prototype-design` skill，先通过步骤内对话确认原型偏好，再生成静态原型页面。

## 目标

- 保留内部 `design_contract`，避免数据库迁移和历史任务断裂。
- 让业务智能体完成后的完整设计方案成为界面解析/原型设计的主要输入。
- `design_contract` 必须读取 `.claude/skills/prototype-design/SKILL.md`，并按 skill 输出静态原型方案。
- 界面解析步骤复用业务智能体式对话体验，可向用户询问原型风格、目标用户、目标平台等偏好。
- 默认输出静态原型页面，作为后续方案设计和代码生成的界面基线。

## 非目标

- 不新增独立 `prototype_design` step kind。
- 不改变现有 `job_steps.kind=design_contract` 的存储兼容性。
- 不把原型页面直接写入最终应用目录。
- 不默认生成高保真交互应用。

## 流程

```text
用户输入
  -> 业务逻辑
      -> 多轮业务智能体对话
      -> 输出完整业务设计方案
  -> 界面解析 / 原型设计 (internal: design_contract)
      -> 读取完整业务设计方案
      -> 读取 .claude/skills/prototype-design/SKILL.md
      -> 询问原型风格、目标用户、目标平台
      -> 生成静态原型页面
      -> 等待确认、修改反馈或继续
  -> 数据抓取
  -> 生产交付
```

`界面解析` 可以继续作为 UI 上的聚合卡片名称；卡片展开区和运行文案应体现它正在进行“原型设计”。

## 输入契约

`design_contract` 的 `input.json` 至少包含：

- `confirmedRequirement`：冻结需求摘要。
- `businessDesign`：业务智能体完成后的完整设计方案。
- `businessDesignArtifact`：业务设计方案的产物路径或摘要，便于审计和调试。
- `generationProfile`、`skills`、`blueprintDocs`：现有生成上下文。
- `collaborationSnapshot`：当前协作步骤上下文。
- `repairContext` 或 `[user_input]`：用户对原型偏好的回答、修改反馈或确认指令。

`businessDesign` 是原型设计的主输入。`confirmedRequirement` 只作为边界与一致性校验，不能替代完整设计方案。

## 对话行为

`design_contract` 复用现有 job step 的 `waiting_user` 机制，与业务智能体步骤体验保持一致。

典型状态：

```text
running
  -> waiting_user   // 询问原型偏好
  -> running        // 根据偏好生成静态原型
  -> waiting_user   // 展示预览，等待确认或反馈
  -> succeeded      // 确认原型，或继续但不确认
```

默认结构化问题覆盖：

- 原型风格：UED 评审稿、开发交付稿、业务演示稿、专业中后台、指挥大屏、简洁数据看板。
- 目标用户：UED、开发、产品经理、最终业务用户、评审领导。
- 目标平台：响应式页面、Web 端、移动端、平板端。
- 保真度：低保真结构稿、中保真静态稿、高保真交互稿。

如果业务设计方案已经明确包含这些偏好，步骤可以直接生成原型；如果缺失、冲突或影响验收口径，必须向用户提问。

## 原型输出

默认生成静态页面产物：

```text
.factory-runs/jobs/<job-id>/design_contract/attempt-<n>/prototype/
  index.html
  styles.css
  preview-manifest.json
  prototype-contract.json
```

`preview-manifest.json` 用于前端预览；`prototype-contract.json` 用于后续步骤读取页面结构、组件职责、状态、字段映射、响应式约束、视觉风格与确认状态。

输出 JSON 仍由 `design_contract` attempt 的 `output.json` 承载状态：

- `status`
- `summary`
- `needsUserInput`
- `questions`
- `workLog`
- `warnings`
- `prototype`
- `designDocument`
- `assumedDataFields`

为兼容现有校验和界面预览，`designDocument` 与 `prototype` 必须描述同一套页面设计；若冲突，以用户确认的原型预览为准。

## 下游约束

- 后续方案设计、代码生成和验收步骤必须读取 `prototype-contract.json`。
- 已确认原型作为硬约束，后续不得自由改变页面结构、核心组件和主要交互。
- 未确认但继续的原型只能作为参考，后续不能声明“用户已确认原型”。
- 数据抓取完成后必须检查数据字段是否覆盖原型中的展示字段、状态和 fallback 文案。

## 测试重点

- `design_contract` prompt 包含 `.claude/skills/prototype-design/SKILL.md`，且要求读取业务智能体完整设计方案。
- `design_contract` 的 input 包含业务设计方案内容或可审计 artifact 引用。
- 缺少原型风格、目标用户或目标平台时，step 进入 `waiting_user` 并返回结构化问题。
- 用户回答后，step 能继续生成静态原型页面。
- 原型产物只写入 attempt 目录，不写入最终应用目录。
- 前端界面解析卡片能展示原型偏好问题、预览入口、确认和继续动作。
- 下游步骤能读取原型契约，并区分 confirmed 与 continued_without_confirmation。
