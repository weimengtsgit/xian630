---
name: requirement-clarification
description: Guide a user from an initial software factory request to a structured confirmed application requirement, one decision at a time, over an adaptive 6-round flow.
---

# Requirement Clarification

Use this skill when Factory asks you to run a clarification round for a software
factory user request. Clarification is now **application-only** and follows an
**adaptive, one-decision-at-a-time, 6-round** flow.

## Adaptive Method (6 rounds)

1. **Rounds 1–4 — high-impact decisions first.** Each round may emit ZERO
   questions, one ordinary required question, or ALL currently open high-impact
   questions in one batch. Each question has 2–3 options and a recommendation.
2. **Round 5 — consolidation (only if still incomplete after round 4).** Emit a
   `consolidation` list: one entry per remaining missing field, each with a
   recommended typed value, a reason, and alternatives. This is a model round.
3. **Round 6 — no model turn.** Factory merges the consolidation with the user's
   single field adjustment via `ApplyConsolidationAdjustment` without calling
   you again, then marks `ready_to_confirm`.

When enough information is present, stop asking and return `ready_to_confirm`
with a complete `requirement` and a `normalizedScenarioName`.

## High-Impact Confirmation Gate (高影响确认事项)

Some requirement decisions are HIGH-IMPACT: they fundamentally shape the
generated application and must be explicitly confirmed by the user, not assumed.
A field you fill from a blueprint assumption is **NOT** a confirmed high-impact
decision — the user must actually answer.

Each round, identify the open 高影响确认事项 (e.g. data source boundary, scope of
coverage, primary user role). While ANY remain open:

1. **Surface ALL of them at once** as the round's `questions[]` (each with 2–3
   options and a recommendation) so the user can confirm every high-impact item
   in a single batch — do NOT dribble them out one per round.
2. **List the full set** in `openHighImpact` (the same items you surfaced as
   `questions[]`).
3. When the user answers, the NEXT round re-evaluates: DROP every resolved item
   from `openHighImpact`, surface any STILL-open ones again as `questions[]`,
   or — when none remain — return `ready_to_confirm`.

`ready_to_confirm` requires `openHighImpact` to be EMPTY, **regardless of how
detailed the first message is or how complete the requirement looks**. A
detailed first message does NOT let you skip the high-impact gate.

Each `openHighImpact` entry is **user-facing only**:

- `id` and `label` are plain-language identifiers (e.g. `data_policy`,
  "数据来源策略"). NEVER use internal blueprint/catalog slugs.
- `recommendation` is the option value you recommend (optional).
- `options` is 2–3 plain-language options, each a `value` + `label`.

Factory validates structure: an entry with an empty id/label, more than 3
options, or a value that looks like an internal slug (`software-factory-app`,
`carrier-formation-replay`) is dropped.

## Naval / Maritime Judgement Boundary（海军研判边界）

When the user asks for a military/naval/maritime judgement app, first show that
you recognized the domain intent, then include the data-source boundary as the
highest-impact question needed for generation.

Trigger this rule for requests involving 航母、舰载机、军舰、舰船、海域、港口潮汐、
甲板风、AIS、ADS-B、OSINT、公开搜索、目击聚合、商船密度、异常告警、归属推断、
态势复盘、事件关联、海上起降, or similar naval operational analysis.

For these requests:

1. In `workLog`, explicitly state the app subtype and extracted facts, e.g.
   "识别到这是航母母港潮汐窗口计算器，关键约束包括 72 小时、12.8 米阈值、10 分钟刷新、四格仪表盘。"
2. Set `requirement.dataPolicy` to `live_api`. Do NOT ask the user to choose
   real vs mock/demo data for naval judgement requests.
3. Set `requirement.judgementBoundary.summary` using this concise shape:
   `基于「...」数据，按照「...」规则，判断「...」。每「...」更新一次，以「...」形式输出。`
   If a part is not specified, write the known part and leave the missing part
   as a short neutral phrase such as `待确认的时间范围`.
4. Ask a required multi-select question with id
   `judgementBoundary.dataSources` unless the user already explicitly selected
   these source families:
   - `ontology` — `本体数据源`
   - `public_web_search` — `网络公开搜索`
   The question MUST set `"multiSelect": true`. Recommended default:
   `["ontology"]`; if the user mentions social posts, webpage crawling, public
   search, Twitter/X, Instagram, 微博, or OSINT sightings, recommend
   `["ontology","public_web_search"]`.
   Contract detail: `questions[].recommendation` may be an array for this
   multi-select question, but `openHighImpact[].recommendation` MUST remain the
   string `"ontology"` because the high-impact snapshot uses a string field.
5. Keep this version simple. Do NOT add follow-up gates for ontology entity
   names, endpoint URLs, crawler scope, Baidu, Twitter/X, Instagram, 微博,
   credentials, search keywords, or source-specific connector availability.
   Additional source access will be provided later by data-source skills.
6. Selecting `public_web_search` means a runtime-accessible public-search
   source family, not Claude Code tools. Do not claim the generated app can call
   Claude Code's search tools at runtime.
7. Do NOT invent or name concrete external data providers, APIs, products, or
   websites unless the user already named them. In option reasons, say
   "客户已接入的真实本体数据" or "公开网页/公开搜索线索" rather than examples such
   as a specific tide, weather, AIS, ADS-B, or social-media API.

`judgementBoundary` is conditional: include it for military/naval/maritime
judgement apps, but it is not required for ordinary CRUD/management apps.

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
  "openHighImpact": [
    {
      "id": "judgementBoundary.dataSources",
      "label": "数据来源边界",
      "recommendation": "ontology",
      "options": [
        { "value": "ontology", "label": "本体数据源", "reason": "优先使用客户已接入的真实本体数据" },
        { "value": "public_web_search", "label": "网络公开搜索", "reason": "用于补充公开网页、公开搜索或公开社媒线索" }
      ],
      "multiSelect": true
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
    "dataPolicy": "live_api",
    "acceptanceFocus": [],
    "judgementBoundary": {
      "dataSources": [],
      "summary": "基于「航母轨迹与事件」数据，按照「时间空间关联」规则，判断「活动历史与事件关系」。每「按需」更新一次，以「地图 + 时间轴 + 关系图」形式输出。"
    },
    "generationProfile": {
      "base": ["software-factory-app"],
      "domain": ["defense-operations-ui"],
      "pattern": ["map-timeline-replay"],
      "data": []
    }
  }
}
```

- `status` is `waiting_user` (more clarification needed, at most one question)
  or `ready_to_confirm` (complete, no questions).
- `normalizedScenarioName` — a concise scenario name the model supplies. Factory
  appends a trusted Base36 serial in a later step; do NOT include any serial or
  numeric suffix here.
- `questions` — ALL open high-impact questions in one round (each with 2–3
  options), so the user answers them in a single batch. Zero questions only when
  returning `ready_to_confirm`.
- `consolidation` — emitted at round 5 only. One entry per remaining missing
  field. `recommendedValue` is a typed JSON value (string for scalars, array for
  list fields like `targetUsers`, `mainEntities`, `acceptanceFocus`).
- `openHighImpact` — the currently-open 高影响确认事项 (see the High-Impact
  Confirmation Gate section). While non-empty, `status` must be `waiting_user`
  and EVERY item in this list is also surfaced as a `questions[]` entry. Only
  when this list is empty may you return `ready_to_confirm`. User-facing only:
  no internal slugs.
- `requirement.blueprintRefs` — server-side-only metadata. Blueprints are an
  internal Factory reference; populate `blueprintRefs` when the intent matches;
  otherwise use an empty array. NEVER surface blueprints in any user-facing
  output and never describe a blueprint as a template, sample, or copy source.
- `requirement.judgementBoundary` — conditional user-facing naval judgement
  boundary. Use it for military/naval/maritime judgement, alerting, OSINT,
  affiliation inference, and situation replay requests. It is safe to show in
  confirmation summaries.

## Rules

- Never output `confirmed`; Factory reserves that status for after the user
  clicks the final confirm action and a generation job is created.
- Surface ALL open high-impact questions in one round (each with 2–3 options
  and a recommendation) so the user confirms them in a single batch. Do NOT
  exceed 6 rounds.
- **High-impact items are non-skippable (D3).** While `openHighImpact` is
  non-empty you MUST return `waiting_user` and surface EVERY one of them as a
  `questions[]` entry. A complete requirement filled from blueprint assumptions
  does NOT clear the gate — the user must explicitly confirm each high-impact
  item. Never emit internal blueprint/catalog slugs in `openHighImpact`
  ids/labels.
- Do not create a generation job. Do not generate code.
- The `workLog` is the user-facing analysis surface (分析过程) — it explains what
  you identified, why you recommend an option, and what remains unconfirmed.
  Your raw thinking is ALSO surfaced live on the conversation surface (思考过程),
  streamed token-by-token — think naturally; do not put secrets, credentials, or
  internal blueprint/catalog slugs in it.
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
- `dataPolicy`
- `acceptanceFocus`
- `generationProfile`

`blueprintRefs` is optional and may be an empty array when no internal Factory
reference matches the user's app.

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

## Default dataPolicy — 真实数据优先 (real data first)

- **Default to `live_api`.** Unless the user *explicitly* asks for `mock`,
  `demo`, `sample`, `演示`, `离线假数据`, or otherwise clearly wants fake/offline
  data, set `dataPolicy` to `live_api` (or `mock_then_api` when the user wants
  "real first"). Never default to `mock_data`.
- `mock_data` is allowed **only** when the user explicitly requests mock/demo/
  sample/演示/离线假数据. When that happens, the UI of the generated app must
  clearly label its data as mock/演示.
- **No silent downgrade to mock.** If a requirement hits a real-data domain (see
  Data Skill Mapping) but no real-data capability/source is available for it, do
  NOT change `dataPolicy` to `mock_data`. Keep `dataPolicy` as the real-data
  policy and record the capability gap explicitly in `workLog` (and in
  问题/风险): state which domain has no usable real source so the user decides,
  rather than the app silently shipping fabricated data.

## mock_then_api 语义

`mock_then_api` means **real-data first, fail honestly** — it is NOT "fall back to
mock on failure". Treat it identically to `live_api` for the honest-data contract:
the app must attempt the real fetch, and on failure render the **Degraded State**
(see `software-factory-app`: banner + structural preview, **no fabricated values**),
logged in `output.json` `warnings`. It must never fabricate data or
silently substitute mock.

## Data Skill Mapping

When `dataPolicy` is `live_api` or `mock_then_api` (the app fetches real data)
**and** the requirement matches one of the data domains below, you MUST put the
corresponding skill into `requirement.generationProfile.data` — this is mandatory,
not optional. When `dataPolicy` is `mock_data`, do not add any data skill.

- Tide / tidal height / departure window / draft threshold / port tide level: `tide-data-skill`
- 10 m wind / deck wind / wind speed & direction / launch or recovery conditions: `deck-wind-data-skill`
- AIS / merchant density / shipping density / 50-nautical-mile grid / historical vessel traffic: `ais-density-data-skill` (**historical mode**: uses free downloadable AIS archives only, no real-time API; coverage limited to free-source regions — U.S. waters via MarineCadastre, Danish waters via DMA, global-but-fishing via GFW)
- Carrier-air-wing affiliation / 航母舰载机归属 / ADS-B tracks / ICAO / carrier known positions / 航母已知位置 / land-sea mask / 海陆掩膜 / ontology DaaS carrier entities / AviationCarrier / CarrierAviationPlatform / RawADSData / AircraftCarrierTrackLog: `carrier-affiliation-data-skill`

These rules apply to **any** app whose intent matches a domain, including novel
apps that are not preset scenarios and regardless of `appType`. If no domain
matches, emit an empty `data` array. Remember the default above: `dataPolicy`
defaults to `live_api` (real data first); only choose `mock_data` when the user
explicitly requests mock/demo/sample/演示 data.
