---
name: prototype-design
description: Produce software-factory prototype design conclusions and static prototype specs from confirmed requirements. Use when the factory runs the design_contract step as the user-facing 原型设计 stage, including visual direction, target audience, target platform, fidelity, homepage-first static prototypes, feedback choices, and downstream prototype constraints.
---

# Prototype Design

Use this skill when Factory asks you to run `design_contract` as the user-facing 原型设计 stage. Treat the skill as a design protocol: resolve ambiguity into explicit design dimensions, produce a homepage-first static prototype specification, and preserve a clear confirmation policy for downstream agents.

## Source Of Truth

Read `input.json` before making any design decision.

Use these inputs in priority order:

1. `confirmedRequirement`: confirmed requirement-analysis output. This overrides the raw user prompt.
2. `[user_input]` in the prompt, if present: latest prototype feedback for this step.
3. `generationProfile`, `skills`, and `blueprintDocs`: reference style, structure, interaction, and data-model guidance.
4. `collaborationSnapshot`: current multi-agent context and prior step status.

Do not reinterpret the original raw prompt when the confirmed requirement already answers the question. If confirmed requirement and user feedback conflict, ask a structured question instead of silently choosing one.

## Workflow

1. Extract the prototype brief from `confirmedRequirement`: app type, target users, core scenario, primary view, main entities, data policy, acceptance focus, and known constraints.
2. Resolve the design dimensions below. Use defaults only when the requirement and latest feedback are silent.
3. Decide whether a user decision is required. Ask only for choices that would materially change the prototype or downstream implementation.
4. Produce a static homepage-first prototype specification. Include additional pages only as planned pages unless the requirement explicitly needs generated multi-page detail.
5. Record downstream constraints separately from visual taste. Constraints must be implementable by `solution_design` and `code_generation`.
6. Self-review the JSON for schema completeness, Chinese user-facing text, and no unsupported claims before returning.

## Design Dimensions

Resolve every dimension explicitly in `prototype.designDecisions`.

| Dimension | Allowed values | Default rule |
| --- | --- | --- |
| `style` | `enterprise_dense`, `ued_review`, `developer_handoff`, `business_demo`, `command_dashboard`, `mobile_workbench`, `minimal_data_console` | Use `enterprise_dense` for internal tools; use `command_dashboard` only when primary view is command/monitoring; use `ued_review` when target audience includes UED. |
| `targetAudience` | `ued`, `developer`, `product`, `business_reviewer`, `end_user`, `mixed` | Use confirmed target users; if multiple roles matter, use `mixed`. |
| `targetPlatform` | `responsive`, `web`, `mobile`, `tablet` | Use `responsive` unless the requirement explicitly names a platform. |
| `fidelity` | `static`, `medium_static`, `high_fidelity_interactive` | Use `static`; upgrade only on explicit user request for high fidelity, clickable flows, or interaction simulation. |
| `density` | `compact`, `balanced`, `spacious` | Use `compact` for dashboards and operational tools; `balanced` otherwise. |
| `navigationModel` | `single_home`, `tabbed_sections`, `master_detail`, `wizard`, `map_timeline`, `dashboard_grid` | Derive from `primaryView` and main workflow. |
| `dataHonesty` | `mock_labeled`, `real_boundary_visible`, `unknown_pending` | Mirror confirmed `dataPolicy`; never make prototype data look real unless real-data boundary is confirmed. |

Natural-language mapping examples:

- “专业、干净、中后台” -> `style=enterprise_dense`, `density=compact` or `balanced`.
- “给 UED 看” -> `targetAudience=ued`, include component/state annotations.
- “给开发交付” -> `targetAudience=developer`, include data fields, states, and responsive constraints.
- “移动端” -> `targetPlatform=mobile`, use bottom navigation or task-first stacked layout.
- “高保真/可点击/能演示跳转” -> ask for `fidelity` confirmation unless already explicit.

If the user provides a value outside the allowed vocabulary, map only when intent is obvious. Otherwise ask a structured question with 2-4 concrete options.

## Static Prototype Rules

Default to a static prototype, not a runnable final app.

- Default visible page is `home`.
- `pages[0]` must be the homepage and `generated=true`.
- Additional pages may be listed with `generated=false` and a clear `purpose`.
- Include realistic UI regions: navigation, primary task area, supporting data area, state/feedback area, and action controls.
- Include empty, loading, error, and permission/disabled states when relevant to the workflow.
- Label mock/sample data honestly when data policy is mock or undecided.
- Do not invent production API behavior, hidden business rules, or unconfirmed data availability.
- Do not generate marketing-only hero layouts for operational tools. Prefer scannable, task-focused structure.

High-fidelity interactive intent is allowed only when the user explicitly asks for it. When high fidelity is selected, describe interaction scope in `prototype.interactions` but still avoid writing final application code in this step.

## Clarification Rules

Accept natural-language feedback first. Ask a structured question only when the decision is ambiguous, high-impact, or changes fidelity/scope.

Ask a question for:

- visual direction conflict, such as “简洁” plus “大屏炫酷”;
- target audience conflict, such as UED review versus developer handoff;
- platform conflict, such as responsive web versus mobile-only;
- high-fidelity or interaction-scope requests;
- feedback that changes requirement meaning rather than prototype presentation.

Each question must include:

```json
{
  "id": "prototype_style",
  "question": "请选择原型风格",
  "options": [
    {"value": "ued_review", "label": "UED 评审稿", "recommended": true},
    {"value": "developer_handoff", "label": "开发交付稿"}
  ]
}
```

Do not put `(A)/(B)/(C)` choices inside the question text. Options must be machine-readable objects.

## Output Contract

Return exactly one raw JSON object to stdout. Do not output Markdown, code fences, hidden reasoning, or prose outside JSON.

When `status="passed"`, also write these files under the current attempt directory before returning JSON:

```text
prototype/
  index.html
  styles.css
  preview-manifest.json
  prototype-contract.json
```

`prototype/index.html` is required. It is the prototype-design overview page, not the final application. It must be a static HTML page that lets UED, product, developers, or business reviewers inspect the design quickly. The page must include:

- requirement/business-design summary;
- resolved design dimensions: style, targetAudience, targetPlatform, fidelity, density, navigationModel, dataHonesty;
- homepage layout overview with visible regions, components, fields, states, and action controls;
- planned page inventory and which page is visible by default;
- responsive constraints and downstream implementation constraints;
- mock/unknown data labels when data availability is unconfirmed.

`prototype/styles.css` must contain the page styling used by `index.html`. Keep it static and local; do not depend on remote assets, build tools, framework bundles, or production APIs.

`prototype/preview-manifest.json` must summarize the preview entry point for Factory:

```json
{
  "mode": "static_prototype",
  "defaultPage": "home",
  "fidelity": "static",
  "pages": [
    {
      "id": "home",
      "title": "首页",
      "purpose": "承载核心任务入口、关键指标和主要操作流",
      "file": "prototype/index.html",
      "generated": true,
      "visibleByDefault": true,
      "sections": [
        {"id": "overview", "title": "总览区", "content": "核心指标、状态摘要、风险提示"}
      ],
      "states": ["default", "empty", "loading", "error"]
    }
  ]
}
```

`prototype/prototype-contract.json` must preserve the downstream contract used by later steps:

```json
{
  "prototypeStatus": "unconfirmed_reference",
  "downstreamConstraintLevel": "reference",
  "immutable": false,
  "prototype": {"style": "enterprise_dense", "defaultPage": "home", "pages": []},
  "designDocument": {},
  "assumedDataFields": []
}
```

Required top-level stdout JSON fields:

```json
{
  "status": "passed",
  "summary": "已形成首页静态原型方案，面向 UED 评审和开发交付。",
  "needsUserInput": false,
  "questions": [],
  "workLog": [
    {"title": "输入识别", "summary": "从需求分析文档提取核心场景、目标用户和主视图。"},
    {"title": "原型决策", "summary": "默认采用响应式首页静态原型，并记录后续约束。"}
  ],
  "warnings": [],
  "designDocument": {
    "views": ["home"],
    "layout": "首页概览、主任务区、辅助信息区、状态反馈区",
    "components": ["顶部导航", "核心指标", "任务列表", "操作按钮", "状态提示"]
  },
  "assumedDataFields": ["name", "status", "updatedAt"],
  "prototype": {
    "style": "enterprise_dense",
    "targetAudience": "mixed",
    "targetPlatform": "responsive",
    "fidelity": "static",
    "density": "compact",
    "navigationModel": "dashboard_grid",
    "dataHonesty": "mock_labeled",
    "defaultPage": "home",
    "designDecisions": {
      "style": "enterprise_dense",
      "targetAudience": "mixed",
      "targetPlatform": "responsive",
      "fidelity": "static",
      "density": "compact",
      "navigationModel": "dashboard_grid",
      "dataHonesty": "mock_labeled"
    },
    "pages": [
      {
        "id": "home",
        "title": "首页",
        "purpose": "承载核心任务入口、关键指标和主要操作流",
        "generated": true,
        "visibleByDefault": true,
        "sections": [
          {"id": "overview", "title": "总览区", "content": "核心指标、状态摘要、风险提示"},
          {"id": "primary_workflow", "title": "主任务区", "content": "用户最常执行的查询、筛选、处置或配置任务"},
          {"id": "supporting_detail", "title": "辅助信息区", "content": "列表、详情、时间线、地图或图表"}
        ],
        "states": ["default", "empty", "loading", "error"]
      }
    ],
    "interactions": [],
    "responsiveRules": ["移动端单列堆叠", "桌面端保留主次区域层级", "关键操作在首屏可见"],
    "constraints": ["后续方案设计需保留首页主任务结构", "代码生成不得把未确认数据伪装为真实数据"],
    "confirmationPolicy": "unconfirmed_reference"
  }
}
```

When input is still required:

- set `status` to `needs_input`;
- set `needsUserInput` to `true`;
- include one or more concrete `questions`;
- still include `workLog`, `warnings`, and a partial `prototype` showing current assumptions;
- do not write final prototype files until the answer is sufficient to return `status="passed"`.

## Self-review Checklist

Before returning, verify:

- Every required top-level field exists, including `designDocument`, `assumedDataFields`, and `prototype`.
- Every human-readable value is Simplified Chinese.
- `prototype.designDecisions` resolves all dimensions from the table.
- Static homepage is present as `pages[0]` with `id=home`, `generated=true`, `visibleByDefault=true`, and `file="prototype/index.html"` in `preview-manifest.json`.
- `fidelity=high_fidelity_interactive` appears only after explicit user intent.
- Mock or unknown data is visibly labeled through `dataHonesty` and constraints.
- Questions use structured `options`; no choices are embedded only in text.
- `prototype/index.html`, `prototype/styles.css`, `prototype/preview-manifest.json`, and `prototype/prototype-contract.json` exist before returning `status="passed"`.
- The stdout output contains no Markdown wrapper and no explanatory prose outside JSON.
