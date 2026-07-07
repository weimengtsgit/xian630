# 原型设计步骤替换升级设计

## 背景

当前 `/api/dialogues` 已经支持从对话创建需求澄清、确认需求后创建生成任务，并将协作计划物化为 `job_steps` 与 `job_step_edges`。现有协作计划中存在 `designer/design_contract` 步骤，但它更像结构化设计契约输出；本设计将该步骤替换升级为用户可见的“原型设计”步骤。

升级后的原型设计步骤消费需求分析产出的需求文档和确认需求摘要，支持步骤内对话，生成可预览的静态原型页面，并允许用户通过自然语言反馈修改原型。用户可以确认原型，也可以不确认而直接进入方案设计。原型设计代理的核心提示词不再内嵌在 Go 代码里，而是沉淀为项目本地 skill：`.claude/skills/prototype-design/SKILL.md`，由 `collaborationProducerPrompt` 在 `design_contract` 步骤中显式要求 Claude 读取并遵循。

## 设计目标

- 替换升级现有 `designer/design_contract`，不新增并行原型步骤。
- 保留内部兼容：短期仍可使用 `design_contract` 作为 step kind/role，用户界面展示为“原型设计”。
- 原型设计输入来自需求分析产物，而不是重新解释用户原始 prompt。
- 默认生成多页面静态原型，但只展示首页；其他页面可列入清单或按需生成。
- 只有用户明确要求高保真/可交互时，才生成高保真交互原型。
- 用户自然语言反馈优先；反馈模糊、范围大、影响需求含义或涉及高保真时，进入结构化选择。
- 允许在新窗口或新标签页完整预览原型。
- 已确认原型不可再改；但原型确认不是强制门禁。

## 非目标

- 不把原型直接写入最终生成应用目录。
- 不让原型预览调用生产应用接口。
- 不默认生成完整高保真交互应用。
- 不把步骤内原型反馈混同为需求澄清会话。
- 不在确认后回退修改已确认原型。

## 流程

```text
需求分析
  -> 原型设计
      -> 读取需求分析文档
      -> 询问/确认原型偏好
      -> 生成静态原型页面
      -> 展示原型预览卡片
      -> 接收自然语言反馈或结构化选择
      -> 用户确认原型，或直接进入方案设计
  -> 方案设计
  -> 代码生成
```

## 原型设计输入

原型设计步骤读取稳定的需求分析产物：

- `confirmed_requirement_json`
- `requirement_analysis/output.json`
- 需求分析生成的人类可读需求文档，例如 `requirements.md`
- 高影响确认结果、数据边界、应用类型、核心场景

原型设计不得绕过需求分析重新解释原始 prompt；它可以根据需求分析文档推断原型偏好，但高影响或模糊偏好需要用户确认。

## 原型设计 Skill

原型设计步骤使用项目本地 skill 管理代理规则：

```text
.claude/skills/prototype-design/SKILL.md
```

该 skill 负责描述原型设计代理的稳定工作契约：

- 输入来源：`input.json` 中的 `confirmedRequirement`、`generationProfile`、`skills`、`blueprintDocs`、`collaborationSnapshot`，以及 prompt 末尾可选的 `[user_input]`。
- 默认策略：`fidelity=static`、`targetPlatform=responsive`、默认首页为唯一可见/生成页面。
- 反馈规则：自然语言反馈优先；只有模糊、高影响、改变范围或升级高保真时才返回结构化问题。
- 输出契约：只输出 JSON，包含 `status`、`summary`、`needsUserInput`、`questions`、`workLog`、`warnings`、`prototype`。
- 原型结构：`prototype` 至少包含 `style`、`targetAudience`、`targetPlatform`、`fidelity`、`defaultPage`、`pages`、`constraints`、`confirmationPolicy`。

`collaborationProducerPrompt` 对 `model.StepDesignContract` 使用专门分支，提示 Claude 先 Read 并严格遵循 `.claude/skills/prototype-design/SKILL.md`。其他协作 producer（领域分析、数据接入、协作编排）继续使用通用结构化结论 prompt，不加载原型设计 skill。
## 步骤内对话

原型设计复用 Job step 的 `waiting_user` 机制，而不是创建新的 dialogue 或 clarification session。

典型状态流：

```text
running
  -> waiting_user   // 询问风格、目标用户、平台、保真度
  -> running        // 收到选择后生成原型
  -> waiting_user   // 展示原型，等待确认、修改或跳过确认
  -> succeeded      // 用户确认或选择直接进入方案设计
```

结构化问题保存在 step 的 `pending_questions` 中。问题类型优先覆盖：

- 原型风格：专业中后台、指挥大屏、移动工作台、简洁数据看板、UED 评审稿、开发交付稿。
- 目标用户：UED、产品经理、开发、最终业务用户、评审领导。
- 目标平台：响应式页面、Web 端、移动端、平板端。
- 保真度：低保真结构稿、中保真静态稿、高保真交互稿。
- 高保真交互范围：页面跳转、筛选、弹窗、表单状态、图表动态演示。

## 自然语言反馈规则

用户看原型后可以自然语言反馈。原型设计步骤先分析反馈：

- 反馈明确：直接生成新 attempt。
- 反馈模糊：进入 `waiting_user`，让用户选择具体项。
- 反馈涉及高保真：必须确认交互范围。
- 反馈改变需求含义：转入变更确认，而不是直接修改原型。

示例结构化确认：

```json
[
  {
    "id": "prototype_style",
    "type": "single_choice",
    "title": "选择原型风格",
    "options": [
      { "value": "ued_review", "label": "UED 评审稿" },
      { "value": "developer_handoff", "label": "开发交付稿" },
      { "value": "business_demo", "label": "业务演示稿" }
    ],
    "recommended": "ued_review"
  }
]
```

## 原型产物

原型作为 Job artifact 保存，不写入最终应用目录：

```text
.factory-runs/jobs/<job-id>/design_contract/attempt-1/prototype/
  index.html
  styles.css
  mock-data.js
  preview-manifest.json
  prototype-contract.json
```

`preview-manifest.json` 示例：

```json
{
  "mode": "static",
  "defaultPage": "home",
  "fidelity": "medium_static",
  "requiresExplicitHighFidelity": true,
  "pages": [
    {
      "id": "home",
      "title": "首页",
      "file": "prototype/index.html",
      "generated": true,
      "visibleByDefault": true
    },
    {
      "id": "detail",
      "title": "详情页",
      "file": "prototype/detail.html",
      "generated": false,
      "visibleByDefault": false
    }
  ]
}
```

`prototype-contract.json` 记录后续步骤可消费的结构化契约：页面清单、布局结构、组件职责、状态、字段映射、响应式约束、视觉风格和确认状态。

## 预览交付

对话流展示“原型预览卡片”：

```text
原型设计已生成
- 默认预览：首页
- 页面清单：首页 / 详情页 / 配置页
- 模式：静态原型
- 操作：打开预览、提出修改、确认原型、直接进入方案设计
```

预览支持新窗口或新标签页完整查看。建议接口：

```text
GET  /api/jobs/:jobID/steps/:stepID/prototype
GET  /api/jobs/:jobID/steps/:stepID/prototype/preview
GET  /api/jobs/:jobID/steps/:stepID/prototype/preview?page=home
POST /api/jobs/:jobID/steps/:stepID/prototype/feedback
POST /api/jobs/:jobID/steps/:stepID/prototype/confirm
POST /api/jobs/:jobID/steps/:stepID/prototype/continue-without-confirmation
```

预览服务要求：

- 只允许访问当前 step artifact 目录下的文件。
- 禁止路径穿越。
- 使用 `Cache-Control: no-store`。
- 预览只读，不调用生产应用接口。
- 高保真模式默认只访问原型内 mock 数据，除非用户明确确认真实接口边界。

## 确认与跳过确认

原型确认不是强制门禁。原型生成完成后，用户可选择：

```text
[确认原型并继续] [直接进入方案设计] [提出修改]
```

确认原型：

```json
{
  "prototypeStatus": "confirmed",
  "downstreamConstraintLevel": "hard_constraint",
  "immutable": true
}
```

直接进入方案设计：

```json
{
  "prototypeStatus": "continued_without_confirmation",
  "downstreamConstraintLevel": "reference",
  "immutable": false
}
```

确认后的原型不可再改。任何后续 UI 或页面调整都不回到原型设计步骤，而是走应用修改或变更确认。

## 下游约束

- `solution_design` 必须读取 `prototype-contract.json` 和 `preview-manifest.json`。
- 当 `downstreamConstraintLevel=hard_constraint` 时，下游必须严格遵循确认原型。
- 当 `downstreamConstraintLevel=reference` 时，下游可以参考原型，但不能声称用户已确认原型。
- `code_generation` 不应自由重构已确认原型的页面结构，除非后续变更确认明确允许。

## 测试重点

- 原型设计 step 能从需求分析产物启动，而不是依赖原始 prompt。
- `design_contract` 的 `collaborationProducerPrompt` 会指向 `.claude/skills/prototype-design/SKILL.md`，且领域分析等通用协作步骤不会误加载该 skill。
- 缺少原型偏好时进入 `waiting_user` 并持久化结构化问题。
- 明确自然语言反馈直接产生新 attempt。
- 模糊或高保真反馈进入结构化选择。
- 默认只展示首页，多页面清单可用。
- 预览接口拒绝路径穿越并设置 no-store。
- 确认原型后不可再反馈修改。
- 直接进入方案设计时，下游约束级别为 `reference`。
