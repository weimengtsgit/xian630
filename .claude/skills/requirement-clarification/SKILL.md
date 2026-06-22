---
name: requirement-clarification
description: Guide a user from an initial software factory request to a structured confirmed requirement before any generation job is created.
---

# Requirement Clarification

Use this skill when Factory asks you to run a clarification round for a software factory user request.

## Output Contract

You must write `output.json` with this shape:

```json
{
  "status": "waiting_user",
  "round": 1,
  "workLog": [
    {
      "type": "analysis",
      "content": "识别到这是态势复盘类应用。"
    }
  ],
  "questions": [
    {
      "id": "app_type",
      "label": "应用类型",
      "question": "请选择应用类型",
      "required": true,
      "recommendation": "situation_replay",
      "multiSelect": false,
      "options": [
        {
          "value": "situation_replay",
          "label": "态势复盘类",
          "reason": "适合地图、轨迹、事件和时间轴"
        }
      ],
      "allowCustom": false
    }
  ],
  "requirement": {
    "appType": "situation_replay",
    "appName": "",
    "targetUsers": [],
    "coreScenario": "",
    "primaryView": "",
    "mainEntities": [],
    "blueprintRefs": ["carrier-formation-replay"],
    "dataPolicy": "mock_data",
    "acceptanceFocus": [],
    "generationProfile": {
      "base": ["software-factory-app"],
      "domain": ["defense-operations-ui"],
      "pattern": ["map-timeline-replay"]
    }
  },
  "recommendedBlueprints": [
    {
      "slug": "carrier-formation-replay",
      "name": "航母编队月度航迹复盘",
      "appType": "situation_replay",
      "reason": "近一月编队航迹+事件+时间轴复盘，与需求高度匹配，可作页面结构与数据模型风格参考",
      "referenceKind": "structure|interaction|data-model|style"
    }
  ]
}
```

## Rules

- `status` must be either `waiting_user` or `ready_to_confirm`.
- Use `waiting_user` when more clarification is needed and `questions` is non-empty.
- Use `ready_to_confirm` when all required fields are complete and `questions` is empty.
- Never output `confirmed`; the Factory server reserves that status for after
  the user clicks the final “确认并生成” action and a generation job is created.
- Ask at most 3 questions per round.
- For a single-choice question, `recommendation` is a string option value and
  `multiSelect` is false or omitted.
- For a multi-select question, set `multiSelect: true` and make
  `recommendation` an array of recommended option values, e.g.
  `["window_calculation", "status_display"]`.
- Do not exceed 3 rounds.
- Do not create a generation job.
- Do not generate code.
- Do not expose hidden chain-of-thought.
- Generate user-facing `workLog` entries that explain what you identified, why you recommend an option, and what remains unconfirmed.
- Treat “确认”, “可以”, “开始生成”, and “确认并生成” as confirmation intent when the required fields are complete.
- If the request is a new app while an active session exists, return an `intent_conflict` question with options to continue current requirement or abandon and start a new one.

## Required Confirmed Requirement Fields

- `appType`
- `appName`
- `targetUsers`
- `coreScenario`
- `primaryView`
- `mainEntities`
- `blueprintRefs`
- `dataPolicy`
- `acceptanceFocus`
- `generationProfile`

## Supported App Types

- `situation_replay`
- `operations_management`
- `command_dashboard`

## 场景蓝本 Catalog (Scene Blueprint Catalog)

The repo ships preset 场景蓝本 (scene blueprints) under `scene/<slug>/`. They are reference
scenarios, NOT copyable code templates. The catalog index is
`.claude/skills/requirement-clarification/blueprints.json`.

When clarifying a user request:
- You MAY recommend one or more similar blueprints whose `appType`, `primaryView`,
  `mainEntities`, `dataModelStyle`, or `matchKeywords` overlap the user's intent.
- A blueprint is a STYLE / STRUCTURE / INTERACTION / DATA-MODEL REFERENCE ONLY. The generated
  app must be original code under `generated-apps/<slug>/`; never copy `scene/` source files.
- Put recommended blueprint slugs in the output `requirement.blueprintRefs` (array of slug
  strings) and full recommendation cards in `recommendedBlueprints`.
- Only recommend blueprints that actually exist in `blueprints.json`. Do not invent slugs.
- If no blueprint is a good match, emit `"blueprintRefs": []` and `"recommendedBlueprints": []`.

## Generation Profile Mapping

- `situation_replay`: `software-factory-app`, `defense-operations-ui`, `map-timeline-replay`
- `operations_management`: `software-factory-app`, `defense-operations-ui`, `operations-management-console`
- `command_dashboard`: `software-factory-app`, `defense-operations-ui`, `command-dashboard`
