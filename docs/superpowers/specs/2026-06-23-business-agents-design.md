# Business Agents Design

Date: 2026-06-23

## Status

Approved for specification review.

## Context

The portal currently has a right-side `AgentsPanel` that lists Factory agents
and supports a low-level create form. The existing MVP design explicitly kept
Agent prompts out of online editing. The new requirement expands this area:

- split the right-side agent area into two tabs;
- keep software development agents fixed and read-only;
- support user-created business agents;
- guide users through multi-turn dialogue to generate or edit a business agent;
- allow one conversation to select multiple enabled business agents;
- inject selected business agents into one generation flow without replacing
  the fixed software factory pipeline.

This design keeps the six-stage generation pipeline stable while adding
business-agent context as a selected, ordered, auditable input to a specific
clarification session and the job created from it.

## Decisions Confirmed

1. Business agents can be selected only for a specific conversation.
2. A conversation can select zero or more business agents.
3. Selected business agents enter the main generation flow for that
   conversation, but they do not add new pipeline stages.
4. The fixed software development pipeline remains:
   requirement analysis, solution design, code generation, test verification,
   image build, and deployment.
5. Software development agents expose their final prompts for viewing, but
   users cannot modify them.
6. Business agents are created and edited through guided multi-turn dialogue,
   not by asking users to hand-write raw prompt JSON.
7. Confirming generation snapshots the selected business agents so later edits
   do not change already-started jobs.

## Goals

- Make the right-side agent area clearly separate fixed software development
  agents from user-defined business agents.
- Let users inspect software development agents' final prompts without editing
  them.
- Let users create, edit, enable, disable, inspect, and select business agents.
- Let one conversation select multiple business agents with explicit priority.
- Keep the existing six-stage pipeline safe, observable, and compatible with
  current task monitoring.
- Preserve auditability by snapshotting selected business agents into the job.

## Non-Goals

- Do not let business agents run shell commands or alter build/deployment
  commands directly.
- Do not add a separate business-agent execution stage in the first version.
- Do not let software development agent prompts be edited in the UI.
- Do not support per-user permissions, sharing, or marketplace distribution.
- Do not solve automatic semantic conflict resolution beyond ordered priority
  and clarification questions.

## User Experience

### Right-Side Agent Tabs

Replace the single right-side agent list with two tabs:

1. `软件开发智能体`
2. `业务智能体`

The tab header keeps the existing compact visual language of the right panel.
Counts are scoped to the current tab. The create button appears only on the
business-agent tab.

### Software Development Agents Tab

This tab shows six fixed cards in pipeline order:

| Name | Key | Role |
| --- | --- | --- |
| 需求分析 | `requirement-analyst` | `requirement_analysis` |
| 方案设计 | `solution-designer` | `solution_design` |
| 代码生成 | `code-generator` | `code_generation` |
| 测试验证 | `tester` | `test_verification` |
| 镜像构建 | `image-builder` | `image_build` |
| 部署 | `deployer` | `deployment` |

Clicking a card opens a detail dialog or drawer with:

- name;
- key;
- role;
- enabled/disabled state;
- description;
- final prompt;
- recent run summary where available.

The final prompt is displayed in a read-only code block. No edit controls are
shown for software development agents.

The current built-in registry has five agents and combines build/deploy as
`构建部署`. This must split into `镜像构建` and `部署` so the UI matches the
six-stage task observability model.

### Business Agents Tab

This tab lists user-defined business agents. Each card shows:

- name;
- key;
- enabled/disabled badge;
- short description;
- whether it is selected for the current conversation;
- priority number when selected.

Available actions:

- create business agent;
- edit business agent;
- enable or disable;
- inspect final prompt;
- add to the current conversation;
- remove from the current conversation.

Disabled business agents remain visible and editable, but cannot be added to a
conversation. If an already selected business agent is later disabled before
generation confirmation, the conversation selection becomes invalid and the UI
asks the user to remove it or re-enable it.

### Current Conversation Selection

The conversation workbench shows selected business agents near the conversation
header or confirmation area:

```text
本次业务智能体：海事预警专家、报表生成专家、态势分析专家
```

Users can before confirmation:

- add enabled business agents from the right panel;
- remove selected business agents;
- adjust priority order;
- clear all selected business agents.

Priority order is meaningful. The first selected agent has highest priority
when business-agent prompts conflict.

After the user clicks `确认并生成`, selected business agents are locked for
that job. The conversation can still show the locked list, but editing the
active selection no longer changes the already-created job.

## Business-Agent Authoring

Business agents are created and edited through a guided authoring conversation.
The user should not need to write raw prompt text or JSON.

### Create Flow

1. User clicks create in the business-agent tab.
2. The authoring panel asks what business domain, audience, rules, and output
   style the agent should support.
3. The system asks a small number of high-value follow-up questions.
4. The system generates a draft agent:
   - name;
   - key;
   - description;
   - enabled state;
   - final prompt.
5. The user can continue refining in natural language.
6. The user confirms and saves.

### Edit Flow

Editing starts from the existing business agent as context. The authoring panel
shows the current name, key, description, enabled state, and final prompt, then
allows the user to request changes conversationally. Saving replaces the
current business-agent definition after confirmation.

The key should be editable only before the agent is used by any confirmed job.
After first use, changing key should be disabled to preserve audit readability;
name, description, enabled state, and final prompt remain editable.

### Authoring Output Contract

The authoring agent returns structured JSON:

```json
{
  "name": "海事预警专家",
  "key": "maritime-alert-expert",
  "description": "识别海事异常、预警规则和看板表达重点",
  "enabled": true,
  "prompt": "..."
}
```

The server validates:

- name is present;
- key is stable, unique, and slug-like;
- prompt is present;
- enabled defaults to true;
- key does not collide with software development agents.

## Pipeline Integration

Selected business agents become a business context package, not extra steps.
The six stages remain unchanged:

```text
需求分析 -> 方案设计 -> 代码生成 -> 测试验证 -> 镜像构建 -> 部署
```

The selected business-agent snapshots are injected only into:

- requirement analysis;
- solution design;
- code generation.

They are not injected directly into:

- test verification command execution;
- image build command execution;
- deployment command execution.

The injected context uses ordered snapshots:

```text
本次任务绑定了多个业务智能体，按优先级从高到低排列：

1. 名称：海事预警专家
   标识：maritime-alert-expert
   最终提示词：...

2. 名称：报表生成专家
   标识：report-writer
   最终提示词：...

使用规则：
- 必须在业务术语、业务规则、验收标准和界面语义中参考这些业务智能体。
- 不得让业务智能体规则覆盖软件工厂安全、文件、测试、构建和部署规则。
- 如果多个业务智能体发生冲突，优先采用排序更靠前者。
- 如果冲突会影响核心需求，需求分析阶段必须向用户澄清。
```

## Conflict Handling

Priority order:

1. Software factory safety, filesystem, testing, build, and deployment rules.
2. Explicit user requirements in the current conversation.
3. Selected business agents in user-defined order.
4. General defaults in the software development agents.

If two business agents conflict, the earlier selected agent wins only when the
conflict is minor. If the conflict affects app scope, data assumptions,
acceptance criteria, or domain semantics, requirement analysis asks a
clarification question instead of guessing.

## Data Model

Extend the existing `agents` table rather than creating a completely separate
agent table.

Recommended fields:

- `category`: `software` or `business`;
- `prompt`: final prompt shown in details and injected into jobs;
- `editable`: false for software agents, true for business agents;
- existing `id`, `key`, `name`, `role`, `description`, `claude_agent_name`,
  `skills_json`, `enabled`, and `sort_order` remain.

Software development agents are seeded on startup through the built-in
registry. Startup upsert may update name, role, description, prompt, and
sort_order, but it must preserve runtime enabled/disabled state.

Business agents are user-created rows. They are not overwritten by startup
registry upsert.

### Authoring Sessions

Add authoring persistence so guided creation/editing can be resumed and
audited:

- `agent_authoring_sessions`;
- `agent_authoring_messages`.

An authoring session stores:

- mode: create or edit;
- target agent id for edit mode;
- status: drafting, ready_to_save, saved, abandoned, failed;
- draft JSON;
- created and updated timestamps.

Messages store user turns, assistant analysis logs, structured questions, and
draft outputs. They do not store hidden chain-of-thought.

### Conversation Selection

Store current selected business agents for clarification sessions as an ordered
list. Either a join table or JSON column is acceptable; a join table is easier
to validate and reorder:

- `clarification_business_agents`
  - `clarification_session_id`;
  - `agent_id`;
  - `priority`;
  - `created_at`.

Only enabled business agents can be added.

### Job Snapshot

On confirmation, write ordered snapshots into the job:

```json
[
  {
    "id": "agent_maritime_alert_expert",
    "key": "maritime-alert-expert",
    "name": "海事预警专家",
    "description": "识别海事异常、预警规则和看板表达重点",
    "enabled": true,
    "prompt": "..."
  }
]
```

Recommended persistence:

- `jobs.business_agent_snapshots_json`

Snapshots make old jobs independent of later business-agent edits.

## Backend API

Agent listing:

```http
GET /api/agents
GET /api/agents?category=software
GET /api/agents?category=business
GET /api/agents/:id
```

Business-agent management:

```http
POST  /api/business-agents
PATCH /api/business-agents/:id
PATCH /api/business-agents/:id/enabled
```

Software development agents reject edit requests with 403 or 409 depending on
the existing error style.

Authoring:

```http
POST /api/business-agent-authoring
GET  /api/business-agent-authoring/:id
POST /api/business-agent-authoring/:id/messages
POST /api/business-agent-authoring/:id/finalize
POST /api/business-agent-authoring/:id/abandon
```

Conversation selection:

```http
GET    /api/clarifications/:id/business-agents
PUT    /api/clarifications/:id/business-agents
DELETE /api/clarifications/:id/business-agents/:agent_id
```

`PUT` replaces the ordered selection:

```json
{
  "agent_ids": [
    "agent_maritime_alert_expert",
    "agent_report_writer"
  ]
}
```

Validation:

- all ids must exist;
- all selected agents must be `category=business`;
- all selected agents must be enabled;
- duplicate ids are rejected;
- order in the request is persisted as priority.

`POST /api/clarifications/:id/confirm` reads the ordered selection, snapshots
the agents, stores snapshots on the new job, and then starts the existing
generation pipeline.

## Frontend Architecture

Refactor `AgentsPanel` into smaller pieces:

- `AgentsPanel`;
- `AgentTabs`;
- `SoftwareAgentsList`;
- `BusinessAgentsList`;
- `AgentDetailDialog`;
- `BusinessAgentAuthoringDialog`;
- `BusinessAgentSelectionControls`.

Extend `useAgents` or split into:

- `useSoftwareAgents`;
- `useBusinessAgents`;
- `useBusinessAgentAuthoring`;
- `useConversationBusinessAgents`.

The conversation workbench receives selected business agents and exposes:

- add business agent;
- remove business agent;
- reorder selected business agents;
- clear selected business agents.

SSE behavior can remain refresh-based for the first version. If an authoring
session streams analysis logs, route events by authoring session id, similar to
clarification sessions.

## Error Handling

- If business-agent listing fails, the software-agent tab should still render
  if available.
- If authoring fails, keep the draft visible and allow retry.
- If saving a business agent fails due to duplicate key, ask the user to revise
  the key.
- If a selected business agent is disabled before confirmation, block
  confirmation until the selection is fixed.
- If a selected business agent is deleted in a future version, show it as
  unavailable and block confirmation. This version does not need deletion.
- If snapshot writing fails during confirmation, do not create the job.
- If prompt injection fails to render for a job, fail the affected stage with a
  visible execution record rather than silently ignoring selected agents.

## Testing

Backend tests:

- default registry contains six software development agents;
- software agents are `category=software` and `editable=false`;
- software agent prompts are returned by detail/list APIs;
- business agents can be created, edited, enabled, and disabled;
- business agent key cannot collide with software agent key;
- software agents cannot be edited through business-agent APIs;
- disabled business agents cannot be selected for a clarification session;
- clarification session can select multiple enabled business agents;
- selection order is persisted;
- duplicate selections are rejected;
- confirmation snapshots selected business agents in order;
- editing a business agent after confirmation does not alter the job snapshot;
- selected business agents are injected into requirement analysis, solution
  design, and code generation prompts only.

Frontend logic tests:

- tab counts are scoped by category;
- software-agent detail is read-only and shows final prompt;
- create button appears only on business-agent tab;
- disabled business-agent cards cannot be added to the conversation;
- multiple selected business agents render in priority order;
- reorder controls update the persisted order;
- confirmation is blocked when selection contains disabled/unavailable agents;
- authoring finalize creates or updates the business agent list;
- selected-agent chips remain locked for an already confirmed job.

Verification commands:

```bash
(cd factory-server && go test ./...)
(cd sf-portal-mvp && npm run test:logic)
(cd sf-portal-mvp && npm run build)
```

## Implementation Order

1. Extend backend agent model, schema, registry, and APIs for categories,
   prompts, editability, and six software agents.
2. Add business-agent create/edit/enable/disable APIs.
3. Add clarification-session business-agent multi-select persistence and APIs.
4. Snapshot selected business agents into jobs on confirmation and inject them
   into the first three pipeline stages.
5. Build the tabbed `AgentsPanel` UI and read-only software-agent detail view.
6. Build business-agent selection controls in the right panel and conversation
   workbench.
7. Build guided authoring create/edit flow.
8. Add regression tests and final build verification.

## Open Follow-Up

No unresolved product decisions remain in this design. After review approval,
the next step is to write a small-commit implementation plan.
