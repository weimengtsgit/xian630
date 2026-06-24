---
name: dialogue-intent-routing
description: Route one user chat message to exactly one Software Factory intent, using only the candidate applications and blueprints supplied in the bounded input.
---

# Dialogue Intent Routing

Use this skill when Factory asks you to route one user message in a dialogue to a
Factory intent. You receive a bounded JSON artifact and must emit ONLY the route
output contract.

## Input

Read the route input file (absolute path given in the prompt) with the Read
tool. It contains:

- `dialogueId` — the dialogue session id.
- `userMessage` — the latest user message to route.
- `messages` — prior dialogue message history (role + content).
- `existingApplications` — the candidate preset and generated applications the
  user may be routed to. Each has `slug`, `name`, `appType`, `summary`,
  `isGenerated`.
- `blueprints` — INTERNAL scene blueprint candidates (server-side only). Each
  has `slug`, `name`, `appType`, `summary`.

These are the ONLY candidates you may reference. You cannot and must not invent
applications, blueprints, or any other resource.

## Output Contract

Output ONLY this JSON object (no prose, no markdown fences):

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

- `intent` — exactly one of the two active values above. `business_processing_agent`
  is a dormant future route and MUST NOT be emitted in the current phase.
- `confidence` — `high` when the route is clear; `ambiguous` only when you
  genuinely cannot decide between two routes.
- `existingApplicationSlugs` — slugs chosen ONLY from the supplied
  `existingApplications`. May be empty. For `application_generation` this is
  typically empty. Never include a slug that was not in the input.
- `internalBlueprintSlug` — a slug chosen ONLY from the supplied `blueprints`,
  used to pre-select a blueprint for an `application_generation` route. May be
  empty. This field is server-side only and will be redacted from any user-facing
  surface — but you must still populate it correctly for generation routes.
- `userFacingReason` — a concise, positive explanation for the user. For an
  `application_generation` route, explain that Factory will clarify the
  requirement and generate a runnable application.
- `needsRouteConfirmation` — true when the route should be confirmed with the
  user before proceeding.

## Rules

- Use ONLY the Read, Grep, and Glob tools. Never create, edit, or write files.
  Never run shell commands.
- Output ONLY the contract JSON. No surrounding prose, no ```json fences.
- If the user asks to create an intelligent agent, Agent, assistant, copilot,
  workflow helper, or similar custom helper, and no configured existing
  application is a strong fit, route to `application_generation`. Explain that
  Factory will clarify the requirement and generate a runnable assistant
  application. Do not mention business-processing agents.
- Never state that nothing is reusable. If the user's message maps to an
  existing application, route to `existing_application`.
- Never describe a blueprint as a template, sample, or copy source. A blueprint
  is a style/structure reference only.
- Never fabricate application slugs, blueprint slugs, links, or resource names.
  Every slug you emit MUST appear in the input candidates.
- Never expose hidden reasoning, internal chain-of-thought, or thinking. The
  `userFacingReason` is the only explanation; it is user-facing and positive.
