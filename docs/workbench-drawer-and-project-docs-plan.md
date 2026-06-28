# Workbench Drawer and Project Documents Plan

This plan captures the confirmed product and implementation direction for the next conversation workbench iteration.

## Goals

- Move task execution, collaboration-agent management, and application-project browsing out of the central conversation workspace.
- Keep the conversation workspace focused on the dialogue flow, user input, model thinking, task execution blocks, clarifications, and confirmations.
- Replace the current fixed left application panel and fixed right collaboration-agent panel with a Codex-like layout:
  - left session navigation
  - center conversation workbench
  - right workbench drawer

## Layout

### Left: Session Navigation

The left side becomes the **会话导航栏**.

- Show historical dialogue sessions.
- Put **新建会话** at the top of the left rail.
- Support collapsing the left rail.
- When collapsed, keep a narrow rail for new session and session navigation affordances.
- Remove the current top-header **历史会话** button and the history drawer once the left session navigation owns that workflow.

The current **业务智能体 / 纳管智能体** application list will move to a separate page later. That page is out of scope for this plan and will be designed after its separate logic is provided.

### Center: Conversation Workbench

The center remains the **会话工作台**.

- Show the current dialogue title and status.
- Show the conversation timeline.
- Show task execution blocks appended to the dialogue flow.
- Show task-internal clarification cards in the dialogue flow.
- Show change confirmations in the dialogue flow.
- Keep the composer at the bottom.
- Remove the current inline top task area from the center workspace.

The center header should include right-drawer entry buttons:

- **任务执行**
- **协作智能体**
- **应用项目**

### Right: Workbench Drawer

The **工作台抽屉** is a single right-side drawer host opened from the conversation workbench.

- The three right-header buttons are mutually exclusive drawer entries.
- Clicking the active button closes the drawer.
- The active button is highlighted.
- The **任务执行** button keeps status/badge indicators even when another drawer is open.
- The **应用项目** button is disabled until the current dialogue has a bound application project.
- Remove the old right-side floating restore button. The top-right **协作智能体** entry replaces it.

## Task Execution

### Task Execution Button And Compact Agent Strip

When the current dialogue has queued, running, waiting-user, or failed generation tasks, show a compact execution strip near the top-right workbench controls.

- Show current running agent chips.
- Show queued agent chips in a subdued style.
- Show waiting-user chips with a warning style.
- Show failed chips with an error style.
- Clicking a chip opens the **任务执行** drawer and focuses the related task card.
- Hide the strip when the current dialogue has no active or attention-needed task.

### Task Execution Drawer

The **任务执行** drawer shows the selected dialogue's generation tasks.

- Show all generation tasks for the current dialogue session.
- Default to the **焦点任务**.
- Use a vertical **执行波次** layout instead of the current horizontal lane layout.
- Each execution wave groups task cards by dependency position.
- Execution waves describe dependency grouping, not guaranteed real concurrency.
- A large expanded graph view can later show the full horizontal dependency graph.

Focus-task ordering:

- Prefer attention-needed tasks over terminal history.
- Priority is `waiting_user`, then `running`, then `queued`, then repairable `failed`, then newest terminal task.
- Within the same priority, order by `started_at` when present, otherwise `created_at`; use `updated_at` only as a tie-breaker.
- Do not select a task from another dialogue.

### Task Card Detail

Clicking a task card drills into detail inside the same drawer, rather than opening another right-side drawer.

The detail view should include:

- task card identity and status
- task thinking process
- safe execution process
- execution records
- artifacts and audit
- per-task configuration snapshot

The detail view should have a back action that returns to the task execution list while preserving scroll and selection state.

Per-task snapshot editing:

- A step snapshot is editable only while its step has not started.
- Running, waiting-user, completed, failed, canceled, and historical attempts are read-only.
- Server-side validation must reject edits to already-started steps even if the UI is stale.
- A saved snapshot affects only the upcoming attempt of that step, never prior attempts and never global collaboration-agent definitions.

## Conversation Task Blocks

### Task Execution Block

A **任务执行块** is appended to the conversation tail for each executing generation-task card or collaboration-agent step.

Each block contains:

- agent or task card name
- status
- **任务思考过程**
- safe execution process
- step-level summary

Display policy:

- Current running block is expanded.
- Completed blocks are folded by default into a summary row.
- Failed blocks remain expanded.
- Waiting-user blocks remain expanded.

Timeline integration:

- `task_execution_block` should be a first-class timeline item type derived from task, step, task-thinking, work-trace, and execution-summary state.
- Blocks are attributed by `dialogueId`, `taskId`, `stepId`, `attempt`, and `agentKey`.
- Replay reconstructs blocks from persisted task state, task-thinking events, work-trace events, and step execution summaries.
- The current running or waiting block is appended near the tail after the latest persisted user/agent conversation item.
- Completed historical blocks remain in the timeline but default to folded display.
- The visible work trace remains a source for safe execution process text; it is not a source for raw task thinking.
- When multiple task blocks update at nearly the same time, order by latest task-thinking or work-trace dialogue replay sequence, then dependency depth, then step sequence, then stable step id.

### Task Thinking Process

The product requires showing raw task-agent `thinking_delta` as **任务思考过程**.

Implementation boundary:

- Persist task thinking for history replay.
- Do not store task thinking in visible work-trace events.
- Do not store task thinking in step execution records.
- Persist it as a task-attributed conversation-surface event stream with task, step, attempt, and agent attribution.
- Apply credential redaction and byte caps before persistence and SSE publication.
- Do not summarize, translate, or semantically rewrite the provider `thinking_delta`.

This boundary is recorded in ADR 0009.

Task-thinking persistence contract:

- Add a dedicated `task_thinking_events` store.
- Required fields: `id`, `dialogue_id`, `task_id`, `step_id`, `attempt`, `agent_key`, `dialogue_sequence`, `step_sequence`, `content`, `redacted`, `created_at`.
- `dialogue_sequence` is the replay cursor for per-dialogue hydration and SSE gap recovery.
- `step_sequence` preserves token order within one step attempt.
- The stream is hydrated by a task-attributed dialogue endpoint and published by a task-thinking SSE event, not by `dialogue.work_trace`.
- Dialogue archive keeps task thinking replayable.
- Dialogue deletion removes task thinking together with dialogue messages and work traces.
- Task thinking is excluded from audit/export surfaces unless a future export explicitly includes it.

### Task-Internal Clarification

When a running task card needs user input, show a **任务内澄清请求** as an independent conversation card immediately after the related task execution block.

The clarification card should:

- show the question
- show options and recommendations
- show task and agent attribution
- let the user pick an option into the composer

After the user sends the clarification:

- the selected clarification becomes a normal user dialogue message
- the original clarification card becomes read-only
- the answered clarification card is folded by default as "已澄清：..."
- expanding it shows the original question, options, recommendation, and final answer
- the task execution block continues from waiting-user back to running

Clarification routing:

- Each clarification card carries the same `taskId`, `stepId`, `attempt`, and `agentKey` as the waiting step.
- Answering a clarification unblocks only that step attempt.
- Multiple waiting clarifications in one dialogue are shown as separate cards and route answers by `stepId`.
- A task execution block stays expanded while its step is waiting for user input.
- While a step waits for clarification, the composer is scoped to answering that step. Unrelated dialogue input should wait until the clarification is answered, the turn is canceled, or a future explicit "send unrelated message" affordance is introduced.

## Collaboration Agents

The **协作智能体** drawer shows the global collaboration-agent library.

- It is not the current task's collaboration plan.
- It can show global agent details and allow supported create/delete/edit actions.
- Current task use can be indicated as secondary metadata.

The current task's collaboration plan belongs in the **任务执行** drawer, because it is task-specific and includes snapshots, dependencies, status, waiting state, and failure state.

Collaboration-plan preview boundary:

- The confirmation-time preview and the created job plan must be produced by the same plan builder.
- The preview should carry a deterministic plan hash in the composed dialogue view.
- On confirm, the backend persists the executable plan into `jobs.collaboration_plan_json` and step edges.
- If the confirmed executable plan hash differs from the preview hash, the confirmation response must surface the refreshed plan rather than silently running a different graph.
- `jobs.collaboration_plan_json` is the semantic source of truth. Step-edge rows are the materialized execution index derived from that plan.
- If the user rejects a refreshed plan after a hash mismatch, no job is created; the dialogue returns to the collaboration-plan confirmation state so the plan can be adjusted or regenerated.

## Application Project

### Meaning

**应用项目** means the project workspace for the application bound to the current dialogue session.

It does not mean:

- business-agent list
- managed-agent list
- general application list

### Drawer Content

The **应用项目** drawer shows the current application project's files grouped for user comprehension.

Default groups:

- **文档**: `docs/*.md`, default expanded
- **代码**: `src/`, `tests/`, `package.json`, `vite.config.*`, `index.html`
- **配置**: `Dockerfile`, `nginx.conf`, `.factory/app.json`
- **工厂元数据**: `.factory/project-docs.json`, default collapsed

Hidden by default:

- `dist/`
- `node_modules/`
- `.factory-runs/`
- audit copies
- raw `output.json` machine contracts

Raw contracts remain available only through source/audit affordances.

### Preview Support

First phase supports text preview only.

- Markdown: rendered preview plus source view.
- Code/config: readonly text preview.
- JSON: formatted view plus raw source view.
- Images/binary files: metadata only.
- Large files: summary only, not full eager loading.

File-access security:

- Project file APIs are rooted at the selected generated application's project directory, `generated-apps/<slug>/`.
- Requests must reject absolute paths, empty paths, `..` traversal, and paths that escape the real project root after symlink resolution.
- Hidden run/audit/dependency/build directories are denied: `.factory-runs/`, `node_modules/`, `dist/`, audit copy folders, and any path outside the selected project root.
- Preview reads are capped, with an initial 1 MiB text limit.
- Text preview is allowlisted by extension and MIME sniffing; unknown binary content returns metadata only.
- Raw `output.json` machine contracts are not reachable through the default project tree and require an explicit source/audit action.

### Editing

First phase is readonly preview.

Later editing should use the **文档草稿** model:

- Saving a Markdown edit creates or updates a document draft.
- Saving does not affect the running application.
- Saving does not overwrite the historical machine contract.
- The UI marks unapplied document edits.
- The user can choose **应用为变更需求**.
- That action sends the draft through a model conversion step to produce a structured application modification summary.
- The structured summary is confirmed in the center conversation flow.
- Only after confirmation does a new generation task use the structured change.
- Drafts are keyed by application id, document path, source document checksum, and dialogue id.
- The dialogue key is the owning application-lineage dialogue, not an arbitrary newly opened dialogue. A future cross-dialogue continuation must explicitly transfer or fork drafts.
- If the source document checksum changes, the draft is stale and must be rebased or discarded before conversion.
- Conversion failures keep the draft intact and surface an error or clarification in the conversation flow.

## Project Document Model

### Machine Contracts And Project Documents

`output.json` and similar structured outputs are **机器执行契约**.

- They are immutable.
- They are validated by the factory.
- They drive task execution.
- They are not directly user-editable.

Markdown project documents are **项目文档**.

- They are human-readable projections from machine contracts and task context.
- They are shown by default in the application project drawer.
- User edits to project documents do not directly replace machine contracts.

This boundary is recorded in ADR 0010.

### Generation Timing

Each step that produces a structured conclusion should generate its Markdown project document immediately after the step completes.

After the whole generation task completes, generate or update a summary document.

Generation component:

- The factory generates project documents after the step's `output.json` has passed validation.
- Projection is deterministic and idempotent by source contract checksum.
- Projection failure does not make a valid step fail; it records a warning and leaves the machine execution contract authoritative.
- Retrying a step writes a new document projection only for the successful latest attempt and records its source in `.factory/project-docs.json`.
- The summary document is regenerated after task completion from the latest successful document projections.
- Projection warnings surface in the task execution block summary, the task drawer detail, and a safe warning work-trace event. They never replace the successful machine contract.

### Directory Layout

Generated application projects use this stable shape:

```text
generated-apps/<slug>/
  README.md
  docs/
    00-summary.md
    01-requirements.md
    02-solution.md
    03-design.md
    04-implementation.md
    05-acceptance.md
    domain-analysis.md
    data-integration.md
    security-review.md
    code-review.md
  src/
  tests/
  .factory/
    app.json
    project-docs.json
```

The fixed core documents provide stable user entry points.

Dynamic extension documents are generated according to the actual collaboration plan.

### Project Document Index

`.factory/project-docs.json` is the **项目文档索引**.

It links each Markdown document to its source machine execution contract and attribution.

Each document entry should carry:

- document path
- document type
- display order
- source job id
- source step id
- attempt
- agent key
- source `output.json` artifact id
- source checksum
- generated time
- draft/applied state when editing is introduced

This layout is recorded in ADR 0011.

## Data Model Impact

Expected data model additions or changes:

- Persist task thinking outside `work_trace_events` and `step_execution_records`.
- Add task, step, attempt, and agent attribution to task thinking messages/streams.
- Add a per-dialogue replay cursor for task thinking hydration and SSE gap recovery.
- Add APIs for application project tree and text file preview.
- Add file-root containment and text-size enforcement to project file APIs.
- Add project-document generation after step completion.
- Add `.factory/project-docs.json` write/update logic.
- Later: add document draft tracking and conversion to structured application modifications.

## Migration And Removal

Remove or migrate these existing surfaces:

- inline current task panel at top of conversation workbench
- fixed right collaboration-agent panel
- right-side floating restore button
- top history button and history drawer after left session navigation exists
- left business-agent / managed-agent application panel from the main workbench

Keep existing task observability internals where useful:

- execution records
- artifacts
- step summaries
- collaboration plan metadata
- per-task configuration snapshots

The main change is ownership and presentation: these move into the workbench drawer and conversation timeline rather than consuming the center workspace.

Suggested implementation phases:

1. Add the drawer host, top-right buttons, left session navigation, and remove center task-panel ownership behind one layout change.
2. Move existing task observability into the task-execution drawer using existing records, summaries, artifacts, and collaboration-plan data.
3. Add task execution blocks and task-internal clarification timeline behavior.
4. Add task-thinking persistence and streaming after the dedicated schema and security gate are in place.
5. Add read-only application project tree and text preview with file-access security.
6. Add Markdown project document generation and `.factory/project-docs.json`.
7. Add document drafts and conversion to structured application modifications.

Rollback strategy:

- Keep existing task observability APIs unchanged while moving presentation.
- Do not remove old task-panel code paths until the drawer renders equivalent task status, step details, artifacts, and actions.
- Ship document editing only after read-only project browsing is stable.

## Out Of Scope For This Plan

- The separate business-agent / managed-agent application-list page.
- Full binary, image, PDF, or rich document preview.
- Direct editing of code files.
- Direct Markdown-to-execution without structured confirmation.
- True intra-task parallel execution. Execution waves are dependency groupings until the executor supports real parallelism inside a task.
