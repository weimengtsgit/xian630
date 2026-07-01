---
name: prototype-design
description: Produce software-factory prototype design conclusions from confirmed requirements. Use when the factory runs the design_contract step as the user-facing 原型设计 stage, including style, target user, target platform, fidelity, static homepage, and prototype feedback decisions.
---

# Prototype Design

Use this skill when Factory asks you to run the `design_contract` collaboration producer as the user-facing 原型设计 stage.

## Inputs

Read `input.json` first. Use these fields as source of truth:

- `confirmedRequirement`: requirement-analysis output and confirmed user intent.
- `generationProfile`, `skills`, and `blueprintDocs`: reference style, structure, interaction, and data-model guidance.
- `collaborationSnapshot`: current multi-agent step context.
- `[user_input]`, if present in the prompt: user's latest prototype feedback.

Do not ask about the original raw prompt when the confirmed requirement already contains the answer.

## Defaults

- Default fidelity is `static`.
- Default target platform is `responsive`.
- Default visible/generated page is the homepage.
- Multi-page prototypes are allowed in the plan, but only add pages that are directly supported by the confirmed requirement.
- Generate high-fidelity interactive intent only when the user explicitly asks for high fidelity, interactive behavior, or clickable flows.

## Clarification Rules

Accept natural-language feedback first. Ask a structured question only when the decision is ambiguous, high-impact, or changes fidelity/scope.

Concrete choice dimensions:

- `style`: visual tone, density, information hierarchy.
- `targetAudience`: UED, developer, product, business reviewer, or mixed.
- `targetPlatform`: responsive, web, mobile.
- `fidelity`: static or high_fidelity_interactive.

Each question must include `id`, `question`, and `options`. Each option must include `value` and `label`; add `recommended: true` to the recommended option.

## Output Contract

Output only one raw JSON object. Do not output Markdown, code fences, hidden reasoning, or prose outside JSON.

Required top-level fields:

```json
{
  "status": "passed | needs_input",
  "summary": "原型设计阶段摘要",
  "needsUserInput": false,
  "questions": [],
  "workLog": [
    {"title": "输入识别", "summary": "从需求分析文档提取原型范围。"}
  ],
  "warnings": [],
  "prototype": {
    "style": "专业简洁",
    "targetAudience": "UED",
    "targetPlatform": "responsive",
    "fidelity": "static",
    "defaultPage": "home",
    "pages": [
      {
        "id": "home",
        "title": "首页",
        "purpose": "承载核心任务入口和关键状态总览",
        "sections": ["页面区块名称"],
        "states": ["默认态", "空态", "错误态"]
      }
    ],
    "constraints": ["后续方案和代码生成需要遵守的原型约束"],
    "confirmationPolicy": "confirmed_hard_constraint | unconfirmed_reference"
  }
}
```

When user input is still required, set `status` to `needs_input`, `needsUserInput` to `true`, and provide one or more concrete `questions`.

All human-readable text must be Simplified Chinese. Identifiers, enum values, paths, and code symbols may remain English.