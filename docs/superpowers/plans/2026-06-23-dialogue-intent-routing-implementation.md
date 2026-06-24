# Dialogue Intent Routing Implementation Plan

> **For implementation agents:** Execute this plan with
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Keep the existing worktree changes intact;
> inspect them before editing a shared file and do not reset unrelated work.

**Goal:** Replace the application-only entry flow with persistent dialogue
sessions that route a user to an existing application, a confirmed application
generation job, or a confirmed business-processing agent definition. Scene
catalog configuration controls which preset scenes appear as applications and
which remain internal generation references.

**Architecture:** Add `dialogue_sessions` as the parent conversation resource;
`clarification_sessions` remains the child only for the application-generation
route. A server-side router receives a bounded catalog-derived candidate set and
selects one of three intents. The Factory owns all resource links, generated
names, agent keys, defaults, validation, and audit artifacts. The portal renders
only user-facing route outcomes, never an internal blueprint or raw reasoning.

**Tech stack:** Go, SQLite, `net/http`, Server-Sent Events, local Claude Code
CLI, React 18, Vite, project-local Claude skills.

## Accepted Product Decisions

- Dialogue intents are `existing_application`, `application_generation`, and
  `business_processing_agent`.
- A route is re-evaluated only while it is not locked. Selecting a route locks
  it; opening an app, confirming generation, or creating an agent resolves it.
- `.factory/scene-catalog.json` is the only preset-scene surface configuration.
  `application` entries have display order; `blueprint` and `hidden` are never
  application-list entries. Unlisted preset scenes are hidden. Generated apps
  are always visible and are always routing candidates.
- Initial catalog allocation:
  - `application`: `carrier-formation-replay`, `aircraft-carrier-track`,
    `east-sea-situation`
  - `blueprint`: `carrier-homeport-tide-window`,
    `carrier-deck-wind-calculator`, `merchant-density-grid-alert`,
    `social-sighting-cluster-alert`
- The `social-sighting-cluster-alert` manifest and blueprint metadata display
  name is `开源社区异常监测`.
- Application clarification permits rounds 1–4 with zero or one blocking
  question, a required round-5 consolidation when incomplete, and a one-field
  round-6 adjustment. There is no seventh model round.
- The model supplies a normalized scenario name. Factory appends a collision-safe
  four-character Base36 serial and derives the slug; it must not make `demoN`
  names.
- Business processing only creates an Agent definition in this release. It does
  not add an execution runtime or modify the collaborating branch's right-side
  agent-tab layout.

## Source References

- Product design: `docs/superpowers/specs/2026-06-23-adaptive-requirement-clarification-design.md`
- Canonical language: `CONTEXT.md`
- Existing clarification API: `factory-server/internal/server/clarification_handlers.go`
- Existing Claude wrapper: `factory-server/internal/clarification/runner.go`
- Existing scanner and visibility filter: `factory-server/internal/scanner/`
- Existing workbench: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`

## Target File Map

Create:

```text
.factory/scene-catalog.json
.claude/skills/dialogue-intent-routing/SKILL.md
.claude/skills/business-agent-drafting/SKILL.md
factory-server/internal/dialogue/contracts.go
factory-server/internal/dialogue/runner.go
factory-server/internal/dialogue/runner_test.go
factory-server/internal/scanner/scene_catalog.go
factory-server/internal/scanner/scene_catalog_test.go
factory-server/internal/store/dialogues.go
factory-server/internal/store/dialogues_test.go
factory-server/internal/server/dialogue_handlers.go
factory-server/internal/server/dialogue_handlers_test.go
sf-portal-mvp/src/hooks/useDialogueSessions.js
sf-portal-mvp/src/hooks/dialogueTimeline.js
sf-portal-mvp/scripts/check-dialogue-workbench.mjs
```

Modify:

```text
.claude/skills/requirement-clarification/SKILL.md
.claude/skills/requirement-clarification/blueprints.json
scene/social-sighting-cluster-alert/.factory/app.json
factory-server/internal/agents/registry.go
factory-server/internal/agents/registry_test.go
factory-server/internal/clarification/contracts.go
factory-server/internal/clarification/runner.go
factory-server/internal/clarification/runner_test.go
factory-server/internal/id/id.go
factory-server/internal/model/model.go
factory-server/internal/scanner/scanner.go
factory-server/internal/scanner/preset_visibility.go
factory-server/internal/server/agent_handlers.go
factory-server/internal/server/app_handlers.go
factory-server/internal/server/clarification_handlers.go
factory-server/internal/server/clarification_handlers_test.go
factory-server/internal/server/job_handlers.go
factory-server/internal/server/server.go
factory-server/internal/store/agents.go
factory-server/internal/store/applications.go
factory-server/internal/store/schema.sql
factory-server/internal/store/store.go
sf-portal-mvp/package.json
sf-portal-mvp/src/App.jsx
sf-portal-mvp/src/api/client.js
sf-portal-mvp/src/api/events.js
sf-portal-mvp/src/components/ConversationWorkbench.jsx
sf-portal-mvp/src/components/ConversationWorkbench.css
sf-portal-mvp/src/hooks/applicationOrdering.js
sf-portal-mvp/scripts/check-application-ordering.mjs
sf-portal-mvp/scripts/check-conversation-workbench.mjs
docs/software-factory-mvp-design.md
docs/software-factory-local-runbook.md
```

`preset_visibility.go` is retired after callers move to the catalog. Delete it
only when no production or test references remain. Do not overwrite concurrent
corrections in the social scene files; verify their current contents and make
the smallest missing change.

## Task 1: Make Scene Surfaces a Validated Catalog

**Files:**
- Create: `.factory/scene-catalog.json`
- Create: `factory-server/internal/scanner/scene_catalog.go`
- Create: `factory-server/internal/scanner/scene_catalog_test.go`
- Modify: `factory-server/internal/scanner/scanner.go`
- Modify: `factory-server/internal/scanner/preset_visibility.go` (remove after migration)
- Modify: `factory-server/internal/server/app_handlers.go`
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`, `store.go`, `applications.go`
- Modify: `sf-portal-mvp/src/hooks/applicationOrdering.js`
- Modify: `sf-portal-mvp/scripts/check-application-ordering.mjs`
- Modify: `.claude/skills/requirement-clarification/blueprints.json`
- Modify: `scene/social-sighting-cluster-alert/.factory/app.json`

- [ ] **Step 1: Write failing catalog tests.**

  Cover JSON loading and strict validation for invalid surface values, unknown
  scene slugs, missing/duplicate `application.order`, and an unlisted scene.
  Add integration coverage that a generated app is visible even though it is not
  in the catalog, while a preset blueprint/hidden app is not returned from
  `GET /api/apps`. Assert the exact initial catalog split and the corrected
  social-scene display name.

- [ ] **Step 2: Add `.factory/scene-catalog.json`.**

  Use an explicit schema version and one object per known preset slug:

  ```json
  {
    "version": 1,
    "scenes": {
      "carrier-formation-replay": { "surface": "application", "order": 1 },
      "aircraft-carrier-track": { "surface": "application", "order": 2 },
      "east-sea-situation": { "surface": "application", "order": 3 },
      "carrier-homeport-tide-window": { "surface": "blueprint" },
      "carrier-deck-wind-calculator": { "surface": "blueprint" },
      "merchant-density-grid-alert": { "surface": "blueprint" },
      "social-sighting-cluster-alert": { "surface": "blueprint" }
    }
  }
  ```

  The loader must reject malformed catalog data rather than silently exposing
  all presets. It must provide typed helpers for visible presets, internal
  blueprints, display order, and candidate validation. Parse manifests first,
  then validate every catalog key against the discovered preset-slug set.

- [ ] **Step 3: Carry catalog order through the application resource.**

  Add `display_order` to `applications` with an additive `ensureColumn`
  migration and an `DisplayOrder` JSON field in `model.Application`. Scanner
  assigns it only to `application` presets; generated applications retain zero.
  Update upsert/list/get scans and test fixtures. Server filtering must load the
  validated catalog and return only catalog application presets plus generated
  applications; it must not retain the old permissive behavior when config is
  absent or invalid.

- [ ] **Step 4: Replace hard-coded portal ordering.**

  `orderApplicationsForDisplay` sorts visible preset apps by API
  `display_order`, then generated apps by newest update, with slug only as a
  deterministic tie-breaker. Remove `DISPLAY_APP_SLUG_ORDER` and rewrite the
  logic script around configuration-driven order.

- [ ] **Step 5: Correct catalog metadata and remove the old visibility source.**

  Ensure `social-sighting-cluster-alert` has the one approved display name in
  both manifest and blueprint metadata. Once scanner/server callers use
  `SceneCatalog`, delete `preset_visibility.go` and stop reading
  `.factory/preset-apps.json`; leave the old file untouched only if other
  explicitly supported tooling still needs it, but never use it for runtime
  display or routing.

- [ ] **Step 6: Run focused validation.**

  Run `go test ./internal/scanner ./internal/store ./internal/server` from
  `factory-server` and `node scripts/check-application-ordering.mjs` from
  `sf-portal-mvp`.

## Task 2: Add Durable Dialogue and Agent Data Models

**Files:**
- Create: `factory-server/internal/store/dialogues.go`
- Create: `factory-server/internal/store/dialogues_test.go`
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`, `store.go`, `agents.go`
- Modify: `factory-server/internal/agents/registry.go`, `registry_test.go`
- Modify: `factory-server/internal/server/agent_handlers.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Modify: `factory-server/internal/id/id.go`

- [ ] **Step 1: Add failing store and registry tests.**

  Test dialogue creation/message replay/update/deletion, idempotent legacy
  clarification backfill, terminal result links, agent category/prompt
  round-trip, and an agent display-name collision producing different internal
  keys. Update the registry assertion from five merged agents to six pipeline
  agents with the expected per-step keys.

- [ ] **Step 2: Define explicit model state.**

  Add these model types and JSON fields:

  ```go
  type DialogueIntent string // existing_application | application_generation | business_processing_agent
  type DialogueStatus string // routing | recommending | drafting_application | drafting_business_agent | resolved | failed | abandoned

  type DialogueSession struct {
      ID, InitialPrompt, DraftJSON, ErrorCode, ErrorMessage string
      Status DialogueStatus
      Intent DialogueIntent
      RouteLocked bool
      ClarificationSessionID, ResolvedApplicationID, CreatedAgentID string
      CreatedAt, UpdatedAt time.Time
      ResolvedAt, AbandonedAt *time.Time
  }

  type DialogueMessage struct {
      ID, DialogueID, Role, Kind, Content, MetadataJSON string
      CreatedAt time.Time
  }
  ```

  Add `AgentCategory` (`software_development`, `business_processing`) and
  `Prompt` to `model.Agent`. `Application.DisplayOrder` is introduced by Task 1.

- [ ] **Step 3: Add additive schema migrations and store operations.**

  Create `dialogue_sessions` and `dialogue_messages` with indexes on dialogue
  update time and message creation. Add `agents.category` and `agents.prompt`
  via `ensureColumn`; backfill existing rows to `software_development` and an
  empty prompt. Store API must support create/get/list/latest messages, append
  messages, route/status/draft updates, terminal links, transactional delete,
  and a unique `FindDialogueByClarificationID` lookup.

  Add an idempotent startup migration that creates one
  `application_generation` dialogue for every legacy clarification session,
  links it, copies its initial prompt, and assigns a terminal/in-flight parent
  status based on the child status. Re-running startup must not duplicate
  records.

- [ ] **Step 4: Restore the six software-development agents.**

  Split the current combined `deployer` registry row into `image-builder` and
  `deployer`, with six ordered registry entries:

  ```text
  requirement-analyst, solution-designer, code-generator, tester,
  image-builder, deployer
  ```

  All have `category=software_development`; update `stepPlan` so
  `image_build` uses `image-builder` and `deployment` uses `deployer`. Preserve
  enabled flags for existing stable rows. The migration can leave an obsolete
  legacy combined row disabled or update it in place only if no step references
  it; do not break historical `job_steps.agent_key` replay.

- [ ] **Step 5: Extend Agent API compatibility.**

  Include category/prompt in list/get/create payloads. Keep manual creation
  validation restrictive: a caller cannot create a business agent without a
  non-empty prompt, and cannot assign the software-development category to an
  arbitrary role. The dialogue confirmation path, not the browser, is the
  normal creator of business agents.

- [ ] **Step 6: Add Factory-owned identity helpers.**

  Add a cryptographically random upper-case Base36 four-character helper with
  bounded collision retry. Reuse it for generated app suffixes and
  business-agent internal keys. Keep display names separate from safe slugs and
  keys; never let an LLM/browser supply the suffix/key as trusted data.

- [ ] **Step 7: Run focused tests.**

  Run `go test ./internal/model ./internal/id ./internal/store ./internal/agents ./internal/server`.

## Task 3: Define and Validate the Three Model-Driven Contracts

**Files:**
- Create: `.claude/skills/dialogue-intent-routing/SKILL.md`
- Create: `.claude/skills/business-agent-drafting/SKILL.md`
- Create: `factory-server/internal/dialogue/contracts.go`
- Create: `factory-server/internal/dialogue/runner.go`
- Create: `factory-server/internal/dialogue/runner_test.go`
- Modify: `.claude/skills/requirement-clarification/SKILL.md`
- Modify: `factory-server/internal/clarification/contracts.go`
- Modify: `factory-server/internal/clarification/runner.go`, `runner_test.go`

- [ ] **Step 1: Write failing runner-contract tests before prompts.**

  Use fake command runners to assert each prompt includes only its allowed
  input file and permitted read tools. Test rejection of invented app/blueprint
  candidates, ambiguous intent, malformed JSON, internal-field redaction from
  emitted events, and filtering of `thinking_delta`/non-user-facing CLI data.
  Test every six-round invariant, including a complete round-one result and
  round five followed by a single-field round six.

- [ ] **Step 2: Create `dialogue-intent-routing` skill.**

  Its input is a bounded JSON artifact containing dialogue history, visible app
  candidate summaries, and internal blueprint summaries. Its only output is:

  ```json
  {
    "intent": "existing_application | application_generation | business_processing_agent",
    "confidence": "high | ambiguous",
    "existingApplicationSlugs": ["..."],
    "internalBlueprintSlug": "...",
    "userFacingReason": "...",
    "needsRouteConfirmation": true
  }
  ```

  The skill must never state that nothing is reusable, describe a blueprint as
  a template, fabricate resource names, create files, call tools outside
  `Read,Grep,Glob`, or expose hidden reasoning. For a business route it returns
  a positive user-facing explanation of the business outcome.

- [ ] **Step 3: Implement `internal/dialogue.Runner`.**

  Mirror the clarified runner's artifact discipline under
  `.factory-runs/dialogues/<dialogue-id>/<operation>/`. Persist `input.json`,
  `prompt.md`, CLI stream, normalized output, stdout, and stderr. Use the
  existing `runner.CommandRunner`/stream adapter, plan mode, and safe
  message-level streaming. Expose separate methods for intent routing and
  business-agent draft rounds; both validate their output before returning it.

- [ ] **Step 4: Turn requirement clarification into adaptive application-only behavior.**

  Update its skill and Go contract as follows:

  - Add `normalizedScenarioName` and a `consolidation` object to round output.
  - Remove `recommendedBlueprints` and all user-visible blueprint references
    from the contract and normalized events. Keep one Factory-selected
    `blueprintRefs` value only in persisted server-side requirement metadata.
  - In rounds 1–4, accept no question or exactly one required question with
    two or three options. Reject a model result with more questions.
  - Define consolidation entries as field id, recommended typed value, reason,
    and alternatives. Persist them as a `recommendation_consolidation` message
    and emit `clarification.consolidation.updated`.
  - At round 6, permit only the selected field, merge persisted recommended
    values for every other missing field, validate completeness, and mark
    `ready_to_confirm` without invoking the model again.

  Keep user-facing structured analysis work logs, but do not call them model
  chain-of-thought and never relay hidden thinking output.

- [ ] **Step 5: Create `business-agent-drafting` skill and contract.**

  It follows the same one-decision/consolidation/six-round rules, with an
  `agentDraft` containing `name`, `description`, and `prompt`. Its prompt must
  be a complete future agent instruction, but creation must not imply tool
  access, permissions, inputs, or runtime execution.

- [ ] **Step 6: Run focused tests.**

  Run `go test ./internal/dialogue ./internal/clarification`.

## Task 4: Add Dialogue Routes, State Transitions, and SSE

**Files:**
- Create: `factory-server/internal/server/dialogue_handlers.go`
- Create: `factory-server/internal/server/dialogue_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/server/clarification_handlers.go`, `clarification_handlers_test.go`
- Modify: `factory-server/internal/server/app_operations.go`
- Modify: `factory-server/internal/server/events.go` (only if shared event helpers need extension)

- [ ] **Step 1: Build handler tests around state transitions.**

  Use injected fake dialogue/clarification runners and an in-memory store. Add
  coverage for high-confidence existing-app recommendation, ambiguous route
  selection, route lock against subsequent reclassification, unknown candidate
  rejection, stopped app start then open, business-positive recommendation,
  no agent/job before explicit confirmation, agent confirmation with unique
  key, all six application clarification rounds, legacy history replay, and
  no internal blueprint field in JSON/SSE responses.

- [ ] **Step 2: Register a composed dialogue API.**

  Add these routes, returning a composed `DialogueView` with parent session,
  parent messages, current route payload, child clarification view when present,
  and linked result summaries:

  ```text
  POST   /api/dialogues
  GET    /api/dialogues
  GET    /api/dialogues/:id
  DELETE /api/dialogues/:id
  POST   /api/dialogues/:id/messages
  POST   /api/dialogues/:id/route
  POST   /api/dialogues/:id/applications/:applicationID/open
  POST   /api/dialogues/:id/clarification/answers
  POST   /api/dialogues/:id/clarification/answers/batch
  PATCH  /api/dialogues/:id/clarification/requirement
  POST   /api/dialogues/:id/clarification/retry-current-round
  POST   /api/dialogues/:id/clarification/confirm
  POST   /api/dialogues/:id/clarification/abandon
  POST   /api/dialogues/:id/business-agent/confirm
  ```

  The dialogue routes are a facade over child clarification helpers; do not
  make HTTP requests from one handler to another. Refactor the existing
  clarification operations into context-aware service helpers used by both the
  legacy routes and the dialogue facade. Keep legacy endpoints readable and
  usable for backfilled history during this release.

- [ ] **Step 3: Implement pre-lock routing and route selection.**

  `POST /api/dialogues` persists the first user message, emits
  `dialogue.created`, invokes intent routing, validates it against the current
  catalog/application candidates, persists a structured route record, and
  returns the view. While unlocked, `POST .../messages` repeats that procedure.
  `POST .../route` persists the user's explicit selection and locks the intent:

  - existing app: enters `recommending` and exposes validated candidate cards;
  - application generation: creates exactly one child clarification with
    `max_rounds=6`, stores the hidden blueprint reference server-side, and
    starts round one;
  - business agent: starts business drafting round one.

  A route may not be changed once `route_locked=true`; the client must create a
  new dialogue for a new request.

- [ ] **Step 4: Implement existing-app open without popup races.**

  The recommendation output contains at most three apps: one primary and two
  alternatives, each with name, user-facing match reason, status, and safe
  runtime URL. `.../open` verifies the candidate belongs to the persisted
  recommendation, locks the route, and uses a shared internal start operation
  if stopped. It returns the refreshed application only after it has a usable
  URL; the browser opens that URL after the request succeeds. Persist the app
  ID and emit `dialogue.resolved` only when the user executes the open action.

- [ ] **Step 5: Complete application generation from the dialogue facade.**

  Create/answer/patch/retry through the child with the adaptive constraints.
  At confirmation, require a complete Factory-validated requirement, allocate
  `<normalized-name>-<Base36>`, derive the slug, persist the frozen requirement,
  seed the fixed six-step job, link both child and parent, and resolve the
  dialogue. Do not trust a client-supplied `appName`, `slug`, blueprint, or
  serial. A confirmation failure must create no job and leave a diagnosable
  session state.

- [ ] **Step 6: Complete business-agent confirmation.**

  Validate the current `agentDraft`, derive a unique internal key, create an
  enabled `business_processing` Agent with its prompt, link it to the dialogue,
  and resolve. Emit an audit-safe `dialogue.agent.created` event. No executor
  step, deployment, or invocation is added.

- [ ] **Step 7: Publish and replay only safe events.**

  Add `dialogue.created`, `dialogue.intent.updated`,
  `dialogue.application.recommended`, `dialogue.route.confirmed`,
  `dialogue.agent_draft.updated`, `dialogue.agent.created`, and
  `dialogue.resolved`. Wrap child clarification updates with the parent
  dialogue ID so the portal updates one state source. Persist event-equivalent
  messages before publishing events. Never put `internalBlueprintSlug`, raw
  CLI stdout/stderr, or thinking deltas in a response or SSE payload.

- [ ] **Step 8: Run focused tests.**

  Run `go test ./internal/server ./internal/store ./internal/dialogue ./internal/clarification`.

## Task 5: Replace Portal Clarification State with Dialogue State

**Files:**
- Create: `sf-portal-mvp/src/hooks/useDialogueSessions.js`
- Create: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Create: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`
- Modify: `sf-portal-mvp/src/api/client.js`, `api/events.js`
- Modify: `sf-portal-mvp/src/App.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`, `ConversationWorkbench.css`
- Modify: `sf-portal-mvp/package.json`
- Modify: `sf-portal-mvp/scripts/check-conversation-workbench.mjs`

- [ ] **Step 1: Add failing pure timeline and static UI checks.**

  Cover route event ordering, one primary/two alternatives, no blueprint text
  in rendered items, locked-route composer behavior, adaptive consolidation,
  business draft confirmation, resolved application/agent history records, and
  event hydration after reload. Static checks must ensure the workbench uses
  dialogue APIs and does not import the old `useConversationSessions` path.

- [ ] **Step 2: Add dialogue client methods and event routing.**

  Add exact methods for every Task 4 route. Map `dialogue.*` events and wrapped
  clarification events to a targeted refresh/update by `dialogue_id`; avoid the
  current N+1 full history refresh on each streaming delta. Retain old
  clarification API methods only for compatibility until no component uses
  them.

- [ ] **Step 3: Implement `useDialogueSessions`.**

  Hydrate `GET /api/dialogues` on load, load a selected composed view, create
  new dialogues, send routed text, select routes, submit application answers,
  accept/adjust consolidation, confirm app generation, open a recommendation,
  confirm a business draft, abandon/delete, and reconcile SSE updates. It owns
  busy/error state per action and never derives trusted catalog or route data in
  the browser.

- [ ] **Step 4: Build a generic dialogue timeline.**

  Map persisted parent/child messages to semantic UI items, rather than storing
  JSX-ready server data. Support user messages, safe analysis work logs, route
  choice, existing-app cards, one-question option sets with recommendation
  badges, round-five consolidation, requirement summary, agent draft summary,
  failures, and resolved outcomes. The mapper deliberately drops unknown or
  internal metadata keys.

- [ ] **Step 5: Update `ConversationWorkbench` interactions and layout.**

  Replace clarification-specific status text with dialogue status text. Render:

  - app recommendation cards with an icon action for running `打开应用`, and
    `启动并打开` only until startup succeeds;
  - a positive business-processing recommendation with explicit draft/create
    action and a re-describe action;
  - route cards when intent is ambiguous;
  - a round-five recommendation table with `接受推荐` and one-field adjustment
    controls; and
  - a non-editable resolved state that still has a clear `新建会话` icon action.

  Keep previous fixes for recommendation clickability, history scrolling,
  history delete confirmation, close/delete controls, and responsive input
  sizing. Use Lucide icons and tooltips for icon-only controls. Do not surface
  the words `蓝本`, `模板`, catalog availability, or hidden IDs. Do not modify
  `AgentsPanel` or its layout; it is owned by the collaborating branch.

- [ ] **Step 6: Wire `App.jsx` to the new hook.**

  Route new input and regeneration requests through `useDialogueSessions`.
  Pass application actions only as needed for refreshing panel state after a
  dialogue opens an app. Remove `useConversationSessions` from the main
  composition after all replacement behavior is tested; leave the old hook only
  if it is still used by a compatibility-only surface.

- [ ] **Step 7: Run portal checks.**

  Run `npm run test:logic` and `npm run build` from `sf-portal-mvp`.

## Task 6: Update Product Documentation and Local Acceptance Guidance

**Files:**
- Modify: `docs/software-factory-mvp-design.md`
- Modify: `docs/software-factory-local-runbook.md`
- Modify: `CONTEXT.md` only for terminology that changed during implementation

- [ ] **Step 1: Replace outdated clarification assumptions.**

  Update the MVP design from a single three-round clarification session to
  dialogue-session routing, three outcomes, child application clarification,
  six rounds/consolidation, and six distinct software-development agents.
  Document catalog surfaces and generated naming as Factory-owned behavior.

- [ ] **Step 2: Refresh the runbook.**

  Replace the old user-visible blueprint section with three manual flows:
  existing-app recommendation/start/open, application generation through
  confirmation, and business-agent definition creation. Include a migration
  smoke check for historical clarification sessions and an explicit statement
  that blueprints are internal. Preserve the real Claude CLI verification path
  and add expected safe SSE event families.

- [ ] **Step 3: Check terminology consistency.**

  Verify documentation uses `对话会话`, `需求澄清会话`, `场景目录`,
  `规范化场景名称`, and `业务处理智能体` with the meanings in `CONTEXT.md`.

## Task 7: Full Verification and Focused Review

- [ ] **Step 1: Format and run all deterministic gates.**

  ```bash
  cd factory-server && gofmt -w ./internal && go test ./...
  cd sf-portal-mvp && npm run test:logic && npm run build
  git diff --check
  ```

  Do not use `gofmt -w ./internal` if it would format unrelated concurrent
  changes without first scoping the changed Go files. Format only touched files
  in that case.

- [ ] **Step 2: Run a fake-backed end-to-end API smoke test.**

  With fake dialogue/clarification runners, verify all three routes through
  HTTP plus SSE: reuse an existing running/stopped app, generate a uniquely
  named application after the six-round convergence, and create a
  business-processing agent without any job/deployment. Check the browser API
  payloads never contain internal blueprint identifiers or hidden reasoning.

- [ ] **Step 3: Run real-CLI manual acceptance.**

  Start `factory-server` with `FACTORY_FAKE_CLAUDE` unset, then the portal.
  Drive one real application-generation conversation and one business-agent
  drafting conversation. Confirm the CLI only reads the intended local skills,
  artifacts are written under `.factory-runs/dialogues` or
  `.factory-runs/clarifications`, and no raw chain-of-thought is shown.

- [ ] **Step 4: Review the final diff.**

  Inspect `git status`, `git diff --check`, and the staged/unstaged diff. Verify
  no files in the collaborator-owned agent-tab UI were changed, no unrelated
  scene changes were reverted, old catalog visibility is not a runtime source,
  and every route creates its external resource only after explicit user action.

## Completion Criteria

- Application-list membership and hidden internal references are configured by
  `scene-catalog.json`, with no overlap.
- A dialogue can safely route, resume, lock a path, and replay history across
  server restarts.
- Users can reuse a configured app, generate a new app with six-round adaptive
  clarification, or create a business-processing agent definition.
- Model outputs are bounded and validated; user-facing state contains no raw
  reasoning or internal blueprint/candidate details.
- Existing clarification history survives migration, generated names are not
  `demoN`, and all backend/portal gates pass.
