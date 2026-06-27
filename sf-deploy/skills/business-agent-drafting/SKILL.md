---
name: business-agent-drafting
description: Draft a business-processing agent from a user dialogue, one decision at a time, producing a complete future agent instruction that never implies tool access or runtime execution.
---

# Business Agent Drafting

Use this skill when Factory asks you to run one business-agent drafting round.
You receive a bounded JSON artifact and emit ONLY the business draft contract.

## Adaptive Method (6 rounds)

The drafting follows a one-decision-at-a-time, adaptive, 6-round shape:

1. **Rounds 1–4 — one decision at a time.** Each round you may emit ZERO
   questions or EXACTLY ONE required question, with 2–3 options and a
   recommendation. Never emit more than one question in a round.
2. **Round 5 — consolidation (only if still incomplete after round 4).** Emit a
   `consolidation` list: one entry per remaining missing field, each with a
   recommended value, a reason, and alternatives.
3. **Round 6 — no model turn.** Factory merges the consolidation with the user's
   single field adjustment without calling you again.

When enough information is present, stop asking and return `ready_to_confirm`
with a complete `agentDraft`.

## Input

Read the draft input file (absolute path in the prompt) with the Read tool. It
contains `dialogueId`, `round`, `maxRounds` (6 for an app-gen child), `userMessage`,
`messages`, `currentDraft`, and `currentQuestions`.

## Output Contract

Output ONLY this JSON object (no prose, no fences):

```json
{
  "status": "waiting_user | ready_to_confirm",
  "round": 1,
  "workLog": [
    { "type": "analysis", "content": "已识别业务处理需求。" }
  ],
  "questions": [
    {
      "id": "agent_scope",
      "label": "Agent 职责范围",
      "question": "该业务处理 agent 应聚焦哪个职责?",
      "required": true,
      "recommendation": "approval_assist",
      "options": [
        { "value": "approval_assist", "label": "审批辅助", "reason": "聚焦申请审批建议" },
        { "value": "summary_assist", "label": "汇总辅助", "reason": "聚焦信息汇总" }
      ],
      "allowCustom": false
    }
  ],
  "consolidation": [
    {
      "field": "agentDraft.description",
      "recommendedValue": "辅助物资申请审批",
      "reason": "匹配用户描述",
      "alternatives": ["辅助汇总"]
    }
  ],
  "agentDraft": {
    "name": "物资申请审批 agent",
    "description": "辅助审批物资申请",
    "prompt": "你是物资申请审批助手。阅读申请内容，依据规则给出建议。"
  }
}
```

- At most ONE question per round (rounds 1–4); each question has 2–3 options.
- `consolidation` is emitted at round 5 (only when incomplete). Each
  `recommendedValue` is a typed JSON value (string or array).
- `agentDraft` is the complete draft; it must be present and complete when
  `status` is `ready_to_confirm`.

## agentDraft.prompt rules

The `prompt` is a COMPLETE future agent instruction — what the agent will DO and
how it should reason. But it MUST NOT imply:

- tool access (no references to reading files, calling APIs, databases,
  executing commands),
- permissions,
- inputs or data sources,
- runtime execution or scheduling.

Describe the agent's role, decision logic, and output expectations only. Factory
controls all tooling, permissions, and execution; the prompt never assumes them.

## General Rules

- Use ONLY Read, Grep, Glob. Never create/edit/write files or run shell commands.
- Output ONLY the contract JSON. No prose, no ```json fences.
- Never expose hidden reasoning or chain-of-thought. The `workLog` is the only
  user-facing analysis surface — explain what you identified and why you
  recommend an option; never relay thinking output.
- Never invent resource names, slugs, or links.
- Never describe a blueprint as a template.
- `status` is `waiting_user` or `ready_to_confirm` only — never `confirmed`.
- Max rounds for an app-generation child dialogue is 6.
