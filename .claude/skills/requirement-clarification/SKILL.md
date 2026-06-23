---
name: requirement-clarification
description: Guide a user from an initial software factory request to a structured confirmed application requirement, one decision at a time, over an adaptive 6-round flow.
---

# Requirement Clarification

Use this skill when Factory asks you to run a clarification round for a software
factory user request. Clarification is now **application-only** and follows an
**adaptive, one-decision-at-a-time, 6-round** flow.

## Adaptive Method (6 rounds)

1. **Rounds 1–4 — one decision at a time.** Each round you may emit ZERO
   questions or EXACTLY ONE required question, with 2–3 options and a
   recommendation. Never emit more than one question in a round — Factory
   rejects a round with multiple questions.
2. **Round 5 — consolidation (only if still incomplete after round 4).** Emit a
   `consolidation` list: one entry per remaining missing field, each with a
   recommended typed value, a reason, and alternatives. This is a model round.
3. **Round 6 — no model turn.** Factory merges the consolidation with the user's
   single field adjustment via `ApplyConsolidationAdjustment` without calling
   you again, then marks `ready_to_confirm`.

When enough information is present, stop asking and return `ready_to_confirm`
with a complete `requirement` and a `normalizedScenarioName`.

## Output Contract

Output ONLY this JSON object (no prose, no ```json fences):

```json
{
  "status": "waiting_user | ready_to_confirm",
  "round": 1,
  "normalizedScenarioName": "航母编队月度航迹复盘",
  "workLog": [
    { "type": "analysis", "content": "识别到这是态势复盘类应用。" }
  ],
  "questions": [
    {
      "id": "app_type",
      "label": "应用类型",
      "question": "请选择应用类型",
      "required": true,
      "recommendation": "situation_replay",
      "options": [
        { "value": "situation_replay", "label": "态势复盘类", "reason": "适合地图、轨迹、事件和时间轴" },
        { "value": "command_dashboard", "label": "指挥仪表盘类", "reason": "适合关键指标监控" }
      ],
      "allowCustom": false
    }
  ],
  "consolidation": [
    {
      "field": "primaryView",
      "recommendedValue": "地图 + 时间轴",
      "reason": "匹配态势复盘场景",
      "alternatives": ["列表"]
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
  }
}
```

- `status` is `waiting_user` (more clarification needed, at most one question)
  or `ready_to_confirm` (complete, no questions).
- `normalizedScenarioName` — a concise scenario name the model supplies. Factory
  appends a trusted Base36 serial in a later step; do NOT include any serial or
  numeric suffix here.
- `questions` — at most ONE question per round (rounds 1–4); each with 2–3
  options. More than one question is a contract violation.
- `consolidation` — emitted at round 5 only. One entry per remaining missing
  field. `recommendedValue` is a typed JSON value (string for scalars, array for
  list fields like `targetUsers`, `mainEntities`, `acceptanceFocus`).
- `requirement.blueprintRefs` — server-side-only metadata. Blueprints are an
  internal Factory reference; populate `blueprintRefs` when the intent matches,
  but NEVER surface blueprints in any user-facing output and never describe a
  blueprint as a template, sample, or copy source.

## Rules

- Never output `confirmed`; Factory reserves that status for after the user
  clicks the final confirm action and a generation job is created.
- Ask at most ONE question per round (rounds 1–4). Each question has 2–3
  options and a recommendation. Do NOT exceed 6 rounds.
- Do not create a generation job. Do not generate code.
- Never expose hidden chain-of-thought or thinking. The `workLog` is the only
  user-facing analysis surface — it explains what you identified, why you
  recommend an option, and what remains unconfirmed. Never relay hidden
  reasoning.
- Never describe a blueprint as a template, sample, or copy source. Blueprints
  are an internal Factory reference only and must not appear in user-facing
  output.
- Never invent application or blueprint slugs. Only reference blueprints that
  exist in `.claude/skills/requirement-clarification/blueprints.json`.
- Treat “确认”, “可以”, “开始生成”, and “确认并生成” as confirmation intent when
  the required fields are complete.
- If the request is a new app while an active session exists, return an
  `intent_conflict` question with options to continue the current requirement or
  abandon and start a new one.

## Required Confirmed Requirement Fields

- `appType`
- `appName`
- `targetUsers`
- `coreScenario`
- `primaryView`
- `mainEntities`
- `blueprintRefs` (internal Factory reference only)
- `dataPolicy`
- `acceptanceFocus`
- `generationProfile`

## Supported App Types

- `situation_replay`
- `operations_management`
- `command_dashboard`

## 场景蓝本 Catalog (Scene Blueprint Catalog)

The repo ships preset 场景蓝本 (scene blueprints) under `scene/<slug>/`. The
catalog index is `.claude/skills/requirement-clarification/blueprints.json`.

- You MAY match a user intent to one or more blueprints whose `appType`,
  `primaryView`, `mainEntities`, `dataModelStyle`, or `matchKeywords` overlap.
- A blueprint is a STYLE / STRUCTURE / INTERACTION / DATA-MODEL REFERENCE ONLY.
  The generated app is original code under `generated-apps/<slug>/`; never copy
  `scene/` source files.
- Put matched blueprint slugs in `requirement.blueprintRefs` (server-side only).
  Do NOT emit any user-visible blueprint recommendation card or event —
  blueprints are never surfaced to the user.
- Only reference blueprints that exist in `blueprints.json`. Do not invent slugs.
- If no blueprint matches, emit `"blueprintRefs": []`.

## Generation Profile Mapping

- `situation_replay`: `software-factory-app`, `defense-operations-ui`, `map-timeline-replay`
- `operations_management`: `software-factory-app`, `defense-operations-ui`, `operations-management-console`
- `command_dashboard`: `software-factory-app`, `defense-operations-ui`, `command-dashboard`
