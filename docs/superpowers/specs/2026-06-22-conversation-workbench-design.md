# Conversation Workbench Design

Date: 2026-06-22

## Status

Approved for specification review.

## Context

The portal currently separates requirement clarification into a dedicated middle
panel (`ClarificationPanel`) and keeps the chat input/history in `ChatDialog`.
This makes clarification feel like a side area rather than the primary
multi-turn conversation. The user now wants:

- multi-turn conversation optimization;
- requirement clarification and conversation progress displayed inside the
  conversation model;
- streaming display of the model analysis process and final structured result;
- removal of the separate middle requirement clarification area;
- requirement clarification guided by the brainstorming method;
- generated applications deletable from the application list;
- preset applications configurable for list visibility while still available as
  blueprint references;
- new conversation and historical conversation browsing.

The existing domain language distinguishes `需求澄清会话`, `生成任务`, `应用`,
`预置应用`, `场景蓝本`, `分析工作日志`, and `确认需求摘要`. The design keeps those
boundaries and adds `会话工作台`, `历史会话`, `会话草稿`, `模型分析过程`, and
`应用删除` to `CONTEXT.md`.

## Decisions Confirmed

> Superseded note: decision 1 and the Non-Goal that forbids raw
> `thinking_delta` were revised by ADR 0007. The current conversation
> workbench displays Claude Code CLI thinking as a dedicated 思考过程 channel,
> separate from 模型分析过程.

1. `模型分析过程` means a user-facing structured analysis trail, not hidden
   chain-of-thought or raw model reasoning.
2. Application deletion is limited to generated applications.
3. Preset application list visibility and blueprint availability are separate.
4. A new conversation preserves unfinished sessions in history; it does not
   automatically abandon them.
5. The accepted layout is a central conversation workbench with history opened
   from the workbench header.
6. Multiple unfinished clarification sessions may exist, but only the selected
   session runs a clarification round after user submission.
7. Historical sessions list shows title, status, updated time, short requirement
   summary, and linked job/application result where available.
8. Deleting an application does not delete generation jobs, execution records,
   artifacts, or clarification history.
9. Brainstorming is absorbed into the project-local requirement clarification
   skill, not invoked as an external runtime plugin dependency.
10. Only the model analysis process streams incrementally; question cards,
    blueprint recommendations, and requirement summaries appear after the round
    output is parsed successfully.

## Goals

- Make clarification the main conversation experience.
- Allow users to start a new conversation and return to historical
  clarification sessions.
- Keep generation task monitoring visible without mixing it with clarification.
- Provide safe deletion for generated application runtime assets and local
  directories.
- Keep preset application visibility configurable without removing their use as
  blueprint references.
- Preserve auditability for generation and clarification history.

## Non-Goals

- Do not mix hidden chain-of-thought or raw `thinking_delta` into 模型分析过程;
  ADR 0007 now displays Claude Code CLI thinking separately as 思考过程.
- Do not delete generation jobs, step execution records, artifacts, or
  clarification messages when deleting an application.
- Do not add authentication, role-based permissions, or cross-user ownership.
- Do not implement full-text search, tags, or deletion for historical sessions
  in the first version.
- Do not depend on the Codex superpowers plugin at runtime.

## User Experience

### Central Workbench

Replace the current `ClarificationPanel + ChatDialog` split with a
`ConversationWorkbench` in the middle column.

The middle column becomes:

1. `JobCenter`
   - Keeps the current six-stage generation task monitoring.
   - Shows an empty state when no generation task is active.
2. `ConversationHeader`
   - Current conversation title.
   - Conversation status.
   - `新建会话` action.
   - `历史会话` action.
3. `ConversationTimeline`
   - User messages.
   - Model analysis process.
   - Structured clarification question groups.
   - Blueprint recommendations.
   - Requirement summary.
   - System status messages.
4. `ConversationComposer`
   - Sends the first request for a draft session.
   - Sends free-text follow-up for the selected session.
   - Submits staged clarification answers.
   - Shows confirm action when the session is ready.

The separate middle "需求澄清" region is removed. Clarification becomes a
timeline inside the conversation workbench.

### New Conversation

Clicking `新建会话` creates a frontend-only `会话草稿`. No backend row is created
until the user sends the first message. Existing unfinished sessions remain in
history.

### Historical Conversations

Clicking `历史会话` opens an overlay drawer instead of adding a permanent fourth
column or replacing the application list. The drawer lists sessions newest
first. Selecting a session loads that session into the workbench.

Each list item shows:

- title: `requirement.appName`, falling back to a truncated `initial_prompt`;
- status: active, waiting user, ready to confirm, confirmed, abandoned, or
  failed;
- updated time;
- short summary from `appType` and `coreScenario`;
- linked generation task or deleted application state where known.

## Timeline Model

The frontend maps backend clarification state into normalized timeline items:

- `user_message`: original request, free-text follow-up, or answer summary.
- `analysis_stream`: streaming model analysis process from `analysis_work_log`.
- `question_group`: one round of clarification question cards.
- `blueprint_recommendation`: recommended scene blueprint cards.
- `requirement_summary`: confirmed or evolving structured requirement summary.
- `system_status`: lifecycle events such as created, failed, abandoned, or
  confirmed.

The timeline renders Claude Code CLI thinking only through the dedicated
思考过程 channel introduced by ADR 0007; 模型分析过程 remains structured analysis.

## Streaming Behavior

The backend already consumes Claude Code `stream-json` and extracts
`workLog[].content`. Preserve this boundary:

- stream `analysis_work_log` into the current assistant analysis item;
- wait for a complete parseable round output before rendering questions,
  blueprints, and requirement summary;
- when a round completes, attach the structured cards below the same assistant
  turn or as immediately following structured timeline items;
- when the session reaches `ready_to_confirm`, render `确认并生成`.

If an SSE event belongs to a non-selected session, the frontend updates the
history list summary but does not insert that event into the selected timeline.

## Backend API

Reuse `clarification_sessions` and `clarification_messages` as the source of
truth. Do not revive the older `conversations` table for clarification history.

Add or adjust these endpoints:

- `GET /api/clarifications?limit=50`
  - Returns sessions newest first.
  - Includes parsed `requirement`.
  - Supports future pagination via cursor or `before_updated_at`.
- `GET /api/clarifications/active`
  - Can remain for backward compatibility but should no longer be the main
    frontend entry point.
- `GET /api/clarifications/:id`
  - Returns one session with parsed requirement.
- `GET /api/clarifications/:id/messages`
  - Returns messages oldest first for timeline hydration.
- `POST /api/clarifications`
  - Creates a new session from the first user message.
  - No longer rejects only because another active session exists.
  - Keeps optional `abandonActive` for backward compatibility if tests rely on
    it, but the new workbench should not use it for normal new conversation
    flow.
- `POST /api/clarifications/:id/messages`
  - Adds a free-text user turn and runs the next round for that session.
- `POST /api/clarifications/:id/answers/batch`
  - Persists staged answers and runs exactly one next round.
- `POST /api/clarifications/:id/confirm`
  - Confirms the selected session and creates the generation task.

### SSE

Continue publishing `clarification.*` events with `session_id`. The frontend
must filter and route by `session_id`.

For application deletion, publish `app.deleted` with the deleted app id and
slug. Existing application-list subscribers can treat it as a refresh trigger.

## Frontend Architecture

Replace or substantially refactor `useClarification` into a session-aware hook,
for example `useConversationSessions`.

State owned by the hook:

- `selectedSessionId`;
- `draftSession`;
- `sessions`;
- selected session view: `messages`, `questions`, `requirement`, `blueprints`;
- per-session running/submitting status;
- errors scoped to history list or selected session.

Recommended components:

- `ConversationWorkbench`
- `ConversationHeader`
- `ConversationHistoryDrawer`
- `ConversationTimeline`
- `TimelineItem`
- `QuestionGroup`
- `RequirementSummary`
- `ConversationComposer`

`JobCenter` remains separate. It consumes generation jobs, not clarification
sessions.

## Requirement Clarification Skill

Update `.claude/skills/requirement-clarification/SKILL.md` to absorb the
brainstorming method:

- understand project and user intent;
- ask at most a few high-value questions per round;
- provide recommended answers with reasons;
- propose alternatives when relevant;
- produce user-facing analysis logs;
- produce a structured requirement summary when complete;
- keep output as valid JSON matching the existing clarification contract;
- expose Claude Code CLI thinking only through the ADR 0007 思考过程 channel,
  never mixed into the structured requirement JSON or 模型分析过程.

This is a project-local skill behavior change, not a runtime dependency on the
Codex superpowers plugin.

## Application Deletion

Add `DELETE /api/apps/:id`.

Allowed:

- generated applications;
- generated applications already marked missing.

Rejected:

- preset applications;
- any application whose resolved path is outside the safe generated-app root.

Delete flow:

1. Load the app.
2. Validate `source=generated`.
3. Resolve the application directory from `FACTORY_WORKSPACE_ROOT` and app path.
4. Validate the resolved path is under
   `FACTORY_WORKSPACE_ROOT/generated-apps/<slug>`.
5. Best-effort stop and remove any running deployment container.
6. If the directory exists, move it to a tombstone path under the artifact root,
   for example `.factory-runs/deleted-apps/<app-id>-<slug>`.
7. In a database transaction, delete deployment rows for the app and delete the
   application row.
8. If the database transaction fails, move the tombstoned directory back and
   return an error.
9. If the transaction succeeds, remove the tombstone directory best-effort.
10. Publish `app.deleted`.

This makes directory deletion failure happen before database deletion, while a
database failure still has a rollback path for the moved directory. A missing
container or already-missing generated directory should not block deletion.

Do not delete:

- jobs;
- job steps;
- step execution records;
- artifacts;
- clarification sessions;
- clarification messages.

Historical tasks that point to a deleted application should render "应用已删除".

## Preset Application Visibility

Preset application visibility and blueprint availability are separate:

- application list visibility controls whether a preset app appears in the
  portal list;
- blueprint availability controls whether a scenario can be recommended during
  clarification.

Use a project-local config file for preset list visibility, for example:

```json
{
  "presetApps": {
    "carrier-formation-replay": {
      "showInAppList": true
    },
    "aircraft-carrier-track": {
      "showInAppList": false
    }
  }
}
```

The first version can leave blueprint availability in `blueprints.json`. A
hidden preset app may still appear as a scene blueprint if it remains listed in
the blueprint catalog.

## Error Handling

- Empty draft session submission stays client-side until the user sends text.
- If history loading fails, keep the current session visible and show an error
  in the drawer.
- If selected-session hydration fails, show a recoverable error and keep the
  previous selected session.
- If a selected session is running a round, disable duplicate submission.
- Switching sessions while one is active should show the selected session
  snapshot only; it must not start another background round.
- On SSE disconnect or sequence gaps, rehydrate the selected session and
  refresh the historical session list.
- Application delete path validation failure returns 400 or 403 and does not
  delete anything.
- Directory deletion failure returns an error and keeps the app row.
- Missing containers are ignored during generated app deletion.

## Testing

Backend tests:

- list clarification sessions newest first with parsed requirement;
- multiple unfinished clarification sessions can coexist;
- creating a new clarification no longer 409s solely because another active
  session exists;
- messages and answer submission are scoped to one selected session;
- `DELETE /api/apps/:id` rejects preset apps;
- `DELETE /api/apps/:id` rejects unsafe generated app paths;
- generated app deletion removes app/deployment rows and local directory;
- generated app deletion does not delete job, step, execution record, artifact,
  or clarification rows;
- preset visibility config affects app listing/import behavior without removing
  blueprint references.

Frontend logic tests:

- timeline reducer filters SSE by `session_id`;
- non-selected session SSE updates history summary only;
- new session draft does not POST until first user message;
- selecting a historical session hydrates messages and requirement state;
- `ready_to_confirm` sessions restore the confirm action;
- deleting a generated app sets action state and refreshes the app list;
- preset apps do not show delete controls.

Verification commands:

```bash
(cd factory-server && go test ./...)
(cd sf-portal-mvp && npm run test:logic)
(cd sf-portal-mvp && npm run build)
```

## Implementation Order

1. Backend session list and multi-active clarification behavior.
2. Frontend session-aware clarification hook and history drawer.
3. Conversation workbench timeline replacing `ClarificationPanel`.
4. Requirement clarification skill update for brainstorming-style output.
5. Generated app deletion backend and frontend action.
6. Preset app visibility config.
7. Final regression and build verification.

## Open Follow-Up

No unresolved product decisions remain from the design interview. The next step,
after review approval, is to write an implementation plan with small commits.
