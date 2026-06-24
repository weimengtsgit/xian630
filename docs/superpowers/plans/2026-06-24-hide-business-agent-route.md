# Hide Business-Agent Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the user-visible business-processing-agent route while routing all non-existing-app creation requests, including "agent/assistant" requests, through application generation.

**Architecture:** Keep the dormant business-agent backend/API/data model intact for future branch integration, but remove it from the active routing contract and visible route choices. The router and server defensively normalize any `business_processing_agent` output or stale client route selection to `application_generation`; application generation no longer requires a matching scene blueprint.

**Tech Stack:** Go backend (`factory-server`), project-local Claude skills under `.claude/skills`, React/Vite portal (`sf-portal-mvp`), Node logic checks, Markdown product docs.

---

## File Map

- `.claude/skills/dialogue-intent-routing/SKILL.md`
  Active route prompt contract. Change from three visible outcomes to two active outcomes and instruct "agent/assistant" creation requests to route to `application_generation`.

- `factory-server/internal/dialogue/contracts.go`
  Keep `IntentBusinessProcessingAgent` as a dormant constant, but document that the active router should not emit it.

- `factory-server/internal/dialogue/runner.go`
  Normalize legacy/model `business_processing_agent` route output to `application_generation` before validation and before user-facing events are written.

- `factory-server/internal/dialogue/runner_test.go`
  Regression tests for dormant business intent normalization and two-intent prompt contract.

- `factory-server/internal/server/dialogue_handlers.go`
  Normalize stale client route selections of `business_processing_agent` to `application_generation` before route locking.

- `factory-server/internal/server/dialogue_handlers_test.go`
  Regression tests proving route selection no longer starts business-agent drafting and application generation works without a blueprint.

- `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
  Remove the "配置业务 Agent" route-choice button. Keep dormant business draft rendering code for historical/dormant views.

- `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`
  Update static assertions to forbid visible business route choice while preserving dormant business view compatibility.

- `docs/superpowers/specs/2026-06-23-adaptive-requirement-clarification-design.md`
  Update the spec from three active outcomes to two active outcomes plus dormant future route.

- `docs/software-factory-local-runbook.md`
  Update manual acceptance path: no business-processing route; "agent/assistant" requests should generate assistant applications.

---

### Task 1: Route Skill Contract Becomes Two Active Outcomes

**Files:**
- Modify: `.claude/skills/dialogue-intent-routing/SKILL.md`
- Test: `factory-server/internal/dialogue/runner_test.go`

- [ ] **Step 1: Write the failing prompt-contract test**

Add this test to `factory-server/internal/dialogue/runner_test.go` near `TestRouteIntentPromptUsesSkillAndPermitsOnlyReadGrepGlob`:

```go
func TestRouteIntentPromptHidesBusinessProcessingAgentRoute(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentApplicationGeneration, Confidence: ConfidenceHigh,
		UserFacingReason: "将先澄清需求并生成一个可运行的助手应用。",
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_hide_biz", UserMessage: "帮我创建一个告警分诊 Agent",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	prompt := strings.Join(fr.args, " ")
	if strings.Contains(prompt, `"existing_application | application_generation | business_processing_agent"`) {
		t.Fatalf("prompt still exposes business_processing_agent as an active output: %s", prompt)
	}
	if strings.Contains(prompt, "For a `business_processing_agent` route") {
		t.Fatalf("prompt still instructs the model to produce a business route: %s", prompt)
	}
	if !strings.Contains(prompt, "assistant application") && !strings.Contains(prompt, "助手应用") {
		t.Fatalf("prompt must tell agent/assistant requests to become application_generation: %s", prompt)
	}
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd factory-server && go test ./internal/dialogue -run TestRouteIntentPromptHidesBusinessProcessingAgentRoute -count=1
```

Expected: FAIL because the prompt still contains `business_processing_agent` as an active route and still has business-route instructions.

- [ ] **Step 3: Update the skill prompt contract**

Edit `.claude/skills/dialogue-intent-routing/SKILL.md`:

````md
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
````

Replace the old business-route rule with:

```md
- If the user asks to create an intelligent agent, Agent, assistant, copilot,
  workflow helper, or similar custom helper, and no configured existing
  application is a strong fit, route to `application_generation`. Explain that
  Factory will clarify the requirement and generate a runnable assistant
  application. Do not mention business-processing agents.
```

Keep these rules:

```md
- Never state that nothing is reusable.
- Never describe a blueprint as a template, sample, or copy source.
- Never fabricate application slugs, blueprint slugs, links, or resource names.
```

- [ ] **Step 4: Update runner prompt text**

Modify `factory-server/internal/dialogue/runner.go` in `routePrompt` so the prompt reinforces the dormant route:

```go
func (r Runner) routePrompt(inputPath string) string {
	return "Use .claude/skills/dialogue-intent-routing/SKILL.md. " +
		fmt.Sprintf("The route input is at the absolute path %s — read it with the Read tool. ", inputPath) +
		"Output ONLY valid JSON matching the route output contract. " +
		"Use only the candidate applications and blueprints supplied in the input; never invent slugs or resource names, never state nothing is reusable, never describe a blueprint as a template, never expose hidden reasoning. " +
		"Do not emit business_processing_agent in the current phase. If the user asks to create an agent or assistant and no existing app is a strong fit, route to application_generation as a runnable assistant application."
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
cd factory-server && go test ./internal/dialogue -run TestRouteIntentPromptHidesBusinessProcessingAgentRoute -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add .claude/skills/dialogue-intent-routing/SKILL.md factory-server/internal/dialogue/runner.go factory-server/internal/dialogue/runner_test.go
git commit -m "fix: hide business-agent intent from routing prompt"
```

---

### Task 2: Defensive Route Normalization in the Dialogue Runner

**Files:**
- Modify: `factory-server/internal/dialogue/contracts.go`
- Modify: `factory-server/internal/dialogue/runner.go`
- Test: `factory-server/internal/dialogue/runner_test.go`

- [ ] **Step 1: Write the failing normalization test**

Add this test to `factory-server/internal/dialogue/runner_test.go` near the route validation tests:

```go
func TestRouteIntentNormalizesDormantBusinessIntentToApplicationGeneration(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentBusinessProcessingAgent,
		Confidence: ConfidenceHigh,
		UserFacingReason: "将配置一个业务处理智能体。",
		NeedsRouteConfirmation: false,
	})}
	var events []StreamEvent
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_norm_biz",
		UserMessage: "创建一个审批 Agent",
		ExistingApplications: sampleApps(),
		Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	if out.Intent != IntentApplicationGeneration {
		t.Fatalf("intent = %q, want application_generation", out.Intent)
	}
	if strings.Contains(out.UserFacingReason, "业务处理") || strings.Contains(out.UserFacingReason, "Agent") {
		t.Fatalf("reason should be assistant-application framing, got %q", out.UserFacingReason)
	}
	for _, ev := range events {
		b, _ := json.Marshal(ev)
		if strings.Contains(string(b), "business_processing_agent") {
			t.Fatalf("business intent leaked in event: %s", string(b))
		}
	}
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd factory-server && go test ./internal/dialogue -run TestRouteIntentNormalizesDormantBusinessIntentToApplicationGeneration -count=1
```

Expected: FAIL because `RouteIntent` currently returns `business_processing_agent`.

- [ ] **Step 3: Document dormant intent in contracts**

Update the comment in `factory-server/internal/dialogue/contracts.go`:

```go
// Intent is the routed user intent. Only existing_application and
// application_generation are active user-visible routes in the current phase.
// business_processing_agent remains as a dormant future route and for legacy
// records; fresh router output is normalized away from it.
type Intent string
```

- [ ] **Step 4: Add route-output normalization**

In `factory-server/internal/dialogue/runner.go`, add:

```go
func normalizeRouteOutput(out RouteOutput) RouteOutput {
	if out.Intent == IntentBusinessProcessingAgent {
		out.Intent = IntentApplicationGeneration
		out.ExistingApplicationSlugs = nil
		out.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的助手应用。"
	}
	return out
}
```

Then in `RouteIntent`, immediately after `json.Unmarshal` succeeds and before `validateRouteOutput`:

```go
routeOut = normalizeRouteOutput(routeOut)
```

- [ ] **Step 5: Run focused dialogue tests**

Run:

```bash
cd factory-server && go test ./internal/dialogue -run 'TestRouteIntent(NormalizesDormantBusinessIntentToApplicationGeneration|RejectsInventedAppSlug|RejectsInventedBlueprintSlug)' -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add factory-server/internal/dialogue/contracts.go factory-server/internal/dialogue/runner.go factory-server/internal/dialogue/runner_test.go
git commit -m "fix: normalize dormant business intent to app generation"
```

---

### Task 3: Server Route Selection Fallback and Blueprint-Optional App Generation

**Files:**
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Test: `factory-server/internal/server/dialogue_handlers_test.go`

- [ ] **Step 1: Write failing stale-client route test**

Add this test near `TestRouteSelectBusinessAgentStartsDrafting`:

```go
func TestRouteSelectBusinessAgentFallsBackToApplicationGeneration(t *testing.T) {
	seq := &fakeDialogueRunner{routeStdout: routeBusinessAgentOutput, draftStdout: businessDraftReadyOutput}
	_, r, _ := newDialogueTestServer(t, seq)

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "创建一个告警分诊 Agent"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	routeRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{
		"intent": "business_processing_agent",
	})
	if routeRec.Code != http.StatusOK {
		t.Fatalf("route status = %d body=%s", routeRec.Code, routeRec.Body.String())
	}
	var view dialogueView
	json.NewDecoder(routeRec.Body).Decode(&view)
	if view.Session.Intent != model.DialogueIntentApplicationGeneration {
		t.Fatalf("intent = %q, want application_generation", view.Session.Intent)
	}
	if view.Session.Status != model.DialogueStatusDraftingApplication {
		t.Fatalf("status = %q, want drafting_application", view.Session.Status)
	}
	if view.Session.ClarificationSessionID == "" || view.Child == nil {
		t.Fatalf("expected application clarification child, got view=%#v", view)
	}
	if seq.draftCalls != 0 {
		t.Fatalf("business draft calls = %d, want 0", seq.draftCalls)
	}
}
```

- [ ] **Step 2: Write no-blueprint app-generation test**

Add this test near other route selection tests:

```go
func TestApplicationGenerationWithoutBlueprintStillCreatesClarification(t *testing.T) {
	routeNoBlueprint := `{
	  "intent": "application_generation",
	  "confidence": "high",
	  "existingApplicationSlugs": [],
	  "internalBlueprintSlug": "",
	  "userFacingReason": "将先澄清需求并生成一个可运行的新应用。",
	  "needsRouteConfirmation": false
	}`
	_, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeNoBlueprint})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个新的排班助手应用"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	routeRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{
		"intent": "application_generation",
	})
	if routeRec.Code != http.StatusOK {
		t.Fatalf("route status = %d body=%s", routeRec.Code, routeRec.Body.String())
	}
	var view dialogueView
	json.NewDecoder(routeRec.Body).Decode(&view)
	if view.Session.Intent != model.DialogueIntentApplicationGeneration {
		t.Fatalf("intent = %q, want application_generation", view.Session.Intent)
	}
	if view.Session.ClarificationSessionID == "" || view.Child == nil {
		t.Fatalf("expected clarification child without blueprint, got view=%#v", view)
	}
}
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
cd factory-server && go test ./internal/server -run 'Test(RouteSelectBusinessAgentFallsBackToApplicationGeneration|ApplicationGenerationWithoutBlueprintStillCreatesClarification)' -count=1
```

Expected: first test FAILS because stale business route starts business drafting. The second may already pass; keep it as coverage.

- [ ] **Step 4: Add server-side visible intent normalization**

In `factory-server/internal/server/dialogue_handlers.go`, add near `dialogueValidIntent`:

```go
func activeDialogueIntent(intent dialogue.Intent) dialogue.Intent {
	if intent == dialogue.IntentBusinessProcessingAgent {
		return dialogue.IntentApplicationGeneration
	}
	return intent
}
```

In `selectDialogueRoute`, immediately after parsing the body and validating the intent, normalize it:

```go
intent := activeDialogueIntent(dialogue.Intent(body.Intent))
```

Use this normalized `intent` for the `switch`.

- [ ] **Step 5: Keep dormant APIs intact**

Do not delete:

```go
confirmDialogueBusinessAgent
continueDialogueBusinessAgent
applyDialogueBusinessConsolidation
```

Do not delete `model.DialogueIntentBusinessProcessingAgent`, `model.DialogueStatusDraftingBusinessAgent`, or business-agent tests. They remain dormant compatibility coverage.

- [ ] **Step 6: Run server dialogue tests**

Run:

```bash
cd factory-server && go test ./internal/server -run 'Test(RouteSelectBusinessAgentFallsBackToApplicationGeneration|ApplicationGenerationWithoutBlueprintStillCreatesClarification|BusinessAgent)' -count=1
```

Expected: PASS. Existing business-agent API tests should still pass because direct dormant endpoint coverage remains.

- [ ] **Step 7: Commit Task 3**

```bash
git add factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/dialogue_handlers_test.go
git commit -m "fix: fall back business route selection to app generation"
```

---

### Task 4: Hide Business Route Choice in the Portal

**Files:**
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`

- [ ] **Step 1: Write failing static assertions**

In `sf-portal-mvp/scripts/check-dialogue-workbench.mjs`, add near the existing route-card static checks:

```js
assert.doesNotMatch(workbenchJsx, /onSelectRoute\('business_processing_agent'\)/, 'route choices must not expose business_processing_agent')
assert.doesNotMatch(workbenchJsx, /配置业务 Agent/, 'route choices must not show 配置业务 Agent')
assert.doesNotMatch(workbenchJsx, /创建一个业务处理 Agent/, 'route choices must not show 创建一个业务处理 Agent')
assert.match(workbenchJsx, /复用已有应用/, 'route choices must still offer existing-app reuse')
assert.match(workbenchJsx, /生成新应用/, 'route choices must still offer app generation')
```

- [ ] **Step 2: Run the check and verify RED**

Run:

```bash
cd sf-portal-mvp && node scripts/check-dialogue-workbench.mjs
```

Expected: FAIL because `RouteChoiceCard` still renders the business route button.

- [ ] **Step 3: Remove the visible business route button**

In `sf-portal-mvp/src/components/ConversationWorkbench.jsx`, replace `RouteChoiceCard` with:

```jsx
function RouteChoiceCard({ reason, onSelectRoute, submitting }) {
  return (
    <div className="cw-route-choice">
      {reason ? <p className="cw-route-reason">{reason}</p> : null}
      <div className="cw-route-options">
        <button type="button" disabled={submitting} onClick={() => onSelectRoute('existing_application')}>
          <b>复用已有应用</b>
          <small>打开匹配的现有应用</small>
        </button>
        <button type="button" disabled={submitting} onClick={() => onSelectRoute('application_generation')}>
          <b>生成新应用</b>
          <small>通过需求澄清生成助手应用或业务应用</small>
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Keep dormant business rendering tests**

Do not remove the tests that render `business_recommendation`, `agentDraftStatus`, or resolved business-agent history in `check-dialogue-workbench.mjs`. Those prove old/dormant views still do not crash.

- [ ] **Step 5: Run portal logic check**

Run:

```bash
cd sf-portal-mvp && node scripts/check-dialogue-workbench.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/scripts/check-dialogue-workbench.mjs
git commit -m "fix: hide business route choice in workbench"
```

---

### Task 5: Documentation and Runbook Alignment

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-adaptive-requirement-clarification-design.md`
- Modify: `docs/software-factory-local-runbook.md`
- Verify: `CONTEXT.md`

- [ ] **Step 1: Update the design spec goal**

In `docs/superpowers/specs/2026-06-23-adaptive-requirement-clarification-design.md`, replace the "three outcomes" goal with:

```md
Each active dialogue routes to one of two user-visible outcomes:

1. Reuse a configured existing application.
2. Create a new runnable application through the existing software-development
   pipeline.

Business-processing agent drafting remains a dormant future route. In the
current phase, requests to create an intelligent agent, Agent, assistant, or
workflow helper are treated as application-generation requests and produce a
runnable assistant application.
```

- [ ] **Step 2: Update the intent routing contract in the spec**

Replace the JSON contract excerpt with:

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

Add this paragraph below the contract:

```md
If a model or stale client still proposes `business_processing_agent`, Factory
normalizes it to `application_generation` and frames the result as a runnable
assistant application. This is a defensive compatibility path, not a visible
route.
```

- [ ] **Step 3: Update application generation language**

In the "Application Generation" section, add:

```md
Application generation does not require a matching scene blueprint. When no
configured blueprint fits, the clarification proceeds with `blueprintRefs: []`
and the generated application is guided by the confirmed requirement and
generation capability profile.
```

- [ ] **Step 4: Mark business-agent drafting as dormant**

Rename `## Business-Processing Agent Drafting` to:

```md
## Dormant Business-Processing Agent Drafting
```

Add at the start of that section:

```md
This route is retained for data/API compatibility and future branch integration,
but it is not exposed by current intent routing or the workbench route-choice UI.
```

- [ ] **Step 5: Update the local runbook acceptance scenarios**

In `docs/software-factory-local-runbook.md`, replace the business route acceptance path with:

````md
### Assistant application request

Use a prompt such as:

```text
帮我创建一个告警分诊助手，能够收集告警、判断优先级并给出处置建议。
```

Expected:

1. The dialogue does not show a "配置业务 Agent" route.
2. If no existing application is a strong fit, the route enters
   `application_generation`.
3. The workbench starts requirement clarification for a runnable assistant
   application.
4. The final generated app appears in the application list as an application,
   not as a business-processing Agent entry.
````

- [ ] **Step 6: Verify glossary consistency**

Run:

```bash
rg -n "three outcomes|three Factory intents|business_processing_agent intent|配置业务 Agent|创建一个业务处理 Agent" CONTEXT.md docs/superpowers/specs/2026-06-23-adaptive-requirement-clarification-design.md docs/software-factory-local-runbook.md .claude/skills/dialogue-intent-routing/SKILL.md
```

Expected: no active-route wording remains. Occurrences are allowed only when explicitly describing the dormant compatibility route.

- [ ] **Step 7: Commit Task 5**

```bash
git add docs/superpowers/specs/2026-06-23-adaptive-requirement-clarification-design.md docs/software-factory-local-runbook.md CONTEXT.md
git commit -m "docs: align routing with hidden business-agent branch"
```

---

### Task 6: Full Verification

**Files:**
- No production edits unless a verification failure reveals a bug.

- [ ] **Step 1: Run backend tests**

Run:

```bash
cd factory-server && go test ./...
```

Expected: all packages pass.

- [ ] **Step 2: Run portal logic checks**

Run:

```bash
cd sf-portal-mvp && npm run test:logic
```

Expected: all logic checks pass, including `check-dialogue-workbench: OK`.

- [ ] **Step 3: Run portal build**

Run:

```bash
cd sf-portal-mvp && npm run build
```

Expected: Vite build exits 0.

- [ ] **Step 4: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Inspect final changed files**

Run:

```bash
git status --short --branch
git diff --stat
```

Expected: only planned files plus pre-existing unrelated dirty files are present. Do not stage unrelated dirty files such as scene content or executor fakes unless they were already part of the current task.

- [ ] **Step 6: Commit verification fixes if any**

If verification required code/test fixes, stage only exact touched files:

```bash
git add <exact-files-fixed>
git commit -m "fix: complete hidden business route verification"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

**Spec coverage:**
- Active route contract becomes two outcomes: Task 1, Task 2, Task 5.
- Business route hidden from UI: Task 4.
- Stale/model business output falls back to application generation: Task 2, Task 3.
- Agent/assistant requests become assistant applications: Task 1, Task 5.
- Blueprint is optional for generation: Task 3, Task 5.
- Business-agent API/data remains dormant, not deleted: Task 3, Task 4.

**Placeholder scan:** No unresolved placeholder text or cross-task shorthand references.

**Type consistency:** Uses existing `dialogue.Intent`, `model.DialogueIntentApplicationGeneration`, `DialogueStatusDraftingApplication`, `RouteOutput`, and `RouteChoiceCard` names from the codebase.
