# Dialogue Intent Routing and Adaptive Clarification Design

**Date:** 2026-06-23

## Goal

Evolve the portal from an application-only clarification flow into a persistent
dialogue experience that identifies the user's intended outcome before taking
action. Each active dialogue routes to one of two user-visible outcomes:

1. Reuse a configured existing application.
2. Create a new runnable application through the existing software-development
   pipeline.

Business-processing agent drafting remains a dormant future route. In the
current phase, requests to create an intelligent agent, Agent, assistant, or
workflow helper are treated as application-generation requests and produce a
runnable assistant application.

Application generation retains adaptive multi-turn clarification. It applies
the relevant `superpowers:brainstorming` principles through project-local
skills while preserving structured output, audit records, SSE, explicit user
confirmation, and the existing six-step generation pipeline.

## User-Facing Principles

- Users see outcomes, recommendations, and choices. They never see internal
  scene-blueprint availability, catalog gaps, or raw model reasoning.
- A configured existing application is recommended only when it is a strong
  fit; users can select an alternative or request a different outcome.
- An application-generation conversation never calls an internal scene
  blueprint a template or asks users to choose one.
- A business-processing agent recommendation, when the dormant compatibility
  route is ever surfaced, is positive: it explains the proposed business
  outcome and asks the user to confirm drafting the agent. In the current
  phase this recommendation is not exposed.
- No route creates a generation job or business-processing agent without
  explicit user confirmation.

## Scope

In scope:

- A single configurable catalog that assigns preset scenes to application-list
  or hidden-blueprint surfaces.
- A persistent dialogue-session parent resource with two active intent routes
  and a dormant business-agent route retained for data/API compatibility.
- Project-local intent-routing, application-clarification, and
  business-agent-drafting skills.
- The approved six-round adaptive convergence behavior for application and
  business-agent drafting.
- Existing-application recommendation cards and application start/open flow.
- Agent `category` and `prompt` persistence for business-processing agents.
- History replay, route audit records, migration of existing clarification
  history, and focused tests.

Out of scope:

- Running a business-processing agent in this phase.
- Exposing internal blueprint names, support boundaries, or raw
  chain-of-thought to users.
- Changing the fixed six-step application generation pipeline.
- Changing the right-side agent Tab layout owned by the collaborating branch.

## Scene Catalog

`.factory/scene-catalog.json` is the single source of truth for preset scenes.
Each configured scene has exactly one surface:

- `application`: a preset application shown in the application list. It has a
  required `order`.
- `blueprint`: a hidden internal reference available to application generation.
- `hidden`: unavailable to application display and intent classification.

Unlisted scenes default to `hidden`. Catalog validation rejects unknown slugs,
duplicate scene entries, missing application order, and invalid surfaces.
`preset-apps.json` no longer drives display or intent candidates.

The initial allocation is:

| Surface | Scene slugs |
| --- | --- |
| `application` | `carrier-formation-replay`, `aircraft-carrier-track`, `east-sea-situation` |
| `blueprint` | `carrier-homeport-tide-window`, `carrier-deck-wind-calculator`, `merchant-density-grid-alert`, `social-sighting-cluster-alert` |

Generated applications always appear in the application list and always join
the existing-application candidate set. The catalog only allocates preset
scenes.

`social-sighting-cluster-alert` is corrected to the display name
**开源社区异常监测** in both its manifest and blueprint catalog entry. It must
not share the merchant-density application's display name.

## Generated Application Names

The model returns a concise normalized scenario name during application
clarification. Factory, not the model, appends a four-character Base36 random
serial and retries on collision. The readable application name is therefore
`<规范化场景名称>-<随机序列>`, for example `航母编队航迹复盘-K7M2`.

Factory derives the safe slug from the same values. `demo1`-style names are
not permitted. The user's original wording remains in the dialogue and
requirement context; it is not discarded in favor of the normalized name.

## Dialogue Sessions

`dialogue_sessions` is a new persistent parent resource. It contains the
original request, conversation messages, current intent, route state, and
links to the route result. It is the resource displayed in history and the
conversation workbench.

Its lifecycle states are:

```text
routing
recommending
drafting_application
drafting_business_agent
resolved
failed
abandoned
```

Existing `clarification_sessions` remain the application-generation child
resource. A dialogue session in `drafting_application` links to one
clarification session, whose confirmed requirement creates the existing
generation job. Existing clarification records are backfilled into linked
`application_generation` dialogue sessions so historical sessions remain
available.

Before a user explicitly selects a route, each new user message can update the
inferred intent. Selecting a route locks it immediately, so later wording
cannot switch the dialogue automatically. Opening an existing application,
confirming a generation requirement, or creating a business-processing agent
then transitions the locked dialogue to `resolved`. A clearly expressed new
requirement creates a new dialogue session.

## Intent Routing

The Factory constructs a bounded routing input from:

- dialogue message history;
- configured preset applications and all generated applications;
- configured internal blueprint references.

It invokes the project-local `dialogue-intent-routing` skill. The skill has no
database or deployment capability and returns only structured routing output:

```json
{
  "intent": "existing_application | application_generation",
  "confidence": "high | ambiguous",
  "existingApplicationSlugs": ["..."],
  "internalBlueprintSlug": "...",
  "userFacingReason": "...",
  "needsRouteConfirmation": true
}
```

If a model or stale client still proposes `business_processing_agent`, Factory
normalizes it to `application_generation` and frames the result as a runnable
assistant application. This is a defensive compatibility path, not a visible
route.

Factory validates every returned slug against its input candidates. Internal
blueprint fields are retained server-side and omitted from user-facing events.
The router cannot invent applications, blueprints, or resource links.

High-confidence existing-application matches recommend reuse. Ambiguous
matches produce a user route choice rather than an automatic route.

## Existing-Application Reuse

The workbench renders one primary application recommendation and at most two
expandable similar alternatives. Each card contains the application name,
concise match rationale, status, and a direct action.

- A running application exposes **打开应用**.
- A stopped application exposes **启动并打开**. It starts through the existing
  application operation first; after successful startup the card presents the
  normal open action. This avoids an asynchronous popup being blocked and
  makes startup errors visible.

Opening an application records its ID as the dialogue result and transitions
the dialogue to `resolved`.

## Application Generation

The application-generation route creates a linked clarification session and
uses the project-local `requirement-clarification` skill. A selected blueprint
is a hidden Factory reference only.

Application generation does not require a matching scene blueprint. When no
configured blueprint fits, the clarification proceeds with `blueprintRefs: []`
and the generated application is guided by the confirmed requirement and
generation capability profile.

The skill applies adaptive brainstorming behavior:

1. Restate user intent in product terms and identify the single highest-value
   missing decision, and separately identify every open **高影响确认事项** — any
   unresolved decision that can change business meaning, data source, external
   interface, permission, deployment, or user-visible behavior.
2. In rounds 1 through 4, return either a complete requirement or exactly one
   blocking question with two or three recommended options.
3. High-impact confirmation items are never skipped. `ready_to_confirm` may be
   reached without a question only when no high-impact item remains open; a
   detailed first message does not by itself license skipping them. Do not ask
   a question merely to fill a quota — non-high-impact details may still be
   assumed adaptively. A requirement field filled from a blueprint assumption is
   not a confirmed high-impact decision (see ADR 0006).
4. If the requirement is incomplete after round 4, round 5 emits a structured
   recommendation-consolidation response listing every remaining field,
   recommended typed value, reason, and alternatives. The user can accept all
   recommendations or choose exactly one field to adjust.
5. If one field is selected, round 6 asks only about that field. Factory then
   applies the answer plus the persisted recommendations for all other fields,
   validates completeness, and enters `ready_to_confirm` without a seventh
   model turn.

`ready_to_confirm` remains separate from generation. The user may review the
summary, then **确认并生成** creates a job. The job uses the existing fixed
pipeline: requirement analysis, solution design, code generation, test
verification, image build, and deployment.

The runner output includes a dedicated `consolidation` object. It is persisted
as a `recommendation_consolidation` message with JSON metadata and emitted as
`clarification.consolidation.updated`. The portal can replay it for historical
application-generation dialogues.

## Dormant Business-Processing Agent Drafting

This route is retained for data/API compatibility and future branch integration,
but it is not exposed by current intent routing or the workbench route-choice UI.

After the user confirms the positive business-processing recommendation,
Factory invokes a new project-local `business-agent-drafting` skill. It uses
the same one-decision-at-a-time and recommendation-convergence behavior as
application clarification, but emits an `agentDraft` rather than an
application requirement.

The draft contains:

- human-facing name;
- concise description of the business outcome;
- complete prompt for the future business-processing agent.

The workbench presents the draft for explicit confirmation. Confirmation
creates an agent definition with:

```text
category = business_processing
role = business_processing
name, description, prompt = confirmed agentDraft values
```

Display names may repeat. Factory creates a unique, internal key from the
normalized name plus a random serial and never overwrites an existing agent.
The resulting agent ID is stored on the dialogue session, which becomes
`resolved`.

The agent definition is not executable in this phase. No prompt, tool,
permission, input, or execution contract is implied by its creation.

## Agent Data and Collaborating UI Work

The `agents` model and API gain:

- `category`: `software_development` or `business_processing`;
- `prompt`: the confirmed prompt for a business-processing agent.

Existing six pipeline agents are migrated to `software_development` and keep
their current role-specific responsibilities. Business-processing agents use
`role=business_processing`.

This work owns the data contract, creation flow, and events. It does not
modify the collaborating branch's right-side **软件开发 / 业务处理** Tab layout.
That branch can list each category with a simple filter once integrated.

## Events, Persistence, and Workbench

Dialogue messages persist structured routing and outcome records so history
replays the same result instead of re-running classification. New dialogue
events include:

```text
dialogue.created
dialogue.intent.updated
dialogue.application.recommended
dialogue.route.confirmed
dialogue.agent_draft.updated
dialogue.agent.created
dialogue.resolved
```

Application-generation child sessions retain their `clarification.*` events.
The workbench maps both event families to user-facing timeline items. It does
not render internal blueprint names or identifiers.

The conversation workbench is the primary live surface for the whole agent
experience. It streams the 分析工作日志 token-by-token as each intent-routing
round, clarification round, and pipeline step runs — the user's own message
appears optimistically on send, the analysis work log grows beneath it, and the
round's conclusion (route card, question, requirement summary, or step result)
follows; the streamed analysis then folds above the conclusion and remains
replayable from persisted events. The step matrix and execution drawer stay as
secondary detail/overview. Only the safe analysis work log is streamed; hidden
chain-of-thought and `thinking_delta` are never forwarded.

## Validation and Failure Behavior

- Scene catalog validation is fail-closed; unlisted or invalid scenes cannot
  be displayed or passed to the routing model.
- Factory validates routing output against the precise candidates it supplied.
- Factory owns application serials, agent keys, recommendation defaults, and
  resource links. The browser does not submit trusted values for them.
- Ordinary application and business-draft rounds allow at most one question.
  Round-5 consolidation and round-6 adjustment invariants are server-enforced.
- A requirement cannot enter `ready_to_confirm` (and the 确认并生成 action cannot
  appear) while any 高影响确认事项 remains open, regardless of how detailed the
  user's message is. This is server-enforced (see ADR 0006).
- Invalid model output records a failure with audit data and creates no job or
  business-processing agent.
- All model analysis shown to users is structured, user-facing explanation;
  hidden reasoning and internal directory details are never forwarded.

## Migration and Verification

Migrations are additive or backfilling:

- create dialogue-session tables and backfill existing clarification sessions
  into application-generation dialogues;
- add agent category and prompt fields, then backfill existing agents to
  `software_development` with an empty prompt;
- introduce `scene-catalog.json` and retire `preset-apps.json` as a source of
  application display or routing candidates.

Focused coverage includes:

- catalog surface exclusivity, order, hidden defaults, and corrected social
  scene naming;
- routing candidate validation, high-confidence reuse, ambiguity, explicit
  business recommendation, and route locking;
- application start/open behavior and generated application visibility;
- adaptive six-round application clarification and hidden blueprint handling;
- six-round business-agent drafting, confirmation, unique key generation, and
  non-execution behavior;
- dialogue history replay, legacy clarification backfill, SSE mapping, and
  Agent category/prompt compatibility;
- backend Go tests, portal logic checks, production portal build, and a real
  Claude CLI manual acceptance path.

## Documentation Follow-Up

The Factory MVP design and local runbook must describe dialogue intent routing
and the hidden scene-blueprint boundary. `CONTEXT.md` defines the canonical
language for dialogue sessions, route outcomes, scene catalog assignment,
normalized generated names, and business-processing agents.
