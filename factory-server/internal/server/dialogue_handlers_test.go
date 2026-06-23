package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/dialogue"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// --- dialogue fakes -------------------------------------------------------

// fakeDialogueRunner is a runner.CommandRunner that emits a canned dialogue
// RouteOutput or BusinessDraftOutput as JSON stdout. The server injects it into
// srv.dialogueRouter so the real claude CLI is never invoked.
type fakeDialogueRunner struct {
	routeStdout string // JSON RouteOutput
	draftStdout string // JSON BusinessDraftOutput
	routeCalls  int
	draftCalls  int
	routeErr    bool
	draftErr    bool
}

func (f *fakeDialogueRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	// Distinguish route vs draft by the artifact dir path in args (route uses
	// .../route, draft uses .../draft-round-N). We sniff the prompt instead which
	// carries "dialogue-intent-routing" vs "business-agent-drafting".
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "business-agent-drafting") {
		f.draftCalls++
		if f.draftErr {
			return runner.CommandResult{ExitCode: 2, Stderr: "draft boom"}, nil
		}
		out := f.draftStdout
		if out == "" {
			out = businessDraftReadyOutput
		}
		return runner.CommandResult{ExitCode: 0, Stdout: out}, nil
	}
	f.routeCalls++
	if f.routeErr {
		return runner.CommandResult{ExitCode: 2, Stderr: "route boom"}, nil
	}
	out := f.routeStdout
	if out == "" {
		out = routeExistingAppHighConfidenceOutput
	}
	return runner.CommandResult{ExitCode: 0, Stdout: out}, nil
}

// canned route outputs ---------------------------------------------------

const routeExistingAppHighConfidenceOutput = `{
  "intent": "existing_application",
  "confidence": "high",
  "existingApplicationSlugs": ["carrier-formation-replay"],
  "internalBlueprintSlug": "",
  "userFacingReason": "已有航母编队复盘应用可直接使用。",
  "needsRouteConfirmation": false
}`

const routeAmbiguousOutput = `{
  "intent": "application_generation",
  "confidence": "ambiguous",
  "existingApplicationSlugs": [],
  "internalBlueprintSlug": "carrier-homeport-tide-window",
  "userFacingReason": "需要一个新的态势复盘应用。",
  "needsRouteConfirmation": true
}`

const routeBusinessAgentOutput = `{
  "intent": "business_processing_agent",
  "confidence": "high",
  "existingApplicationSlugs": [],
  "internalBlueprintSlug": "",
  "userFacingReason": "将配置一个业务处理智能体。",
  "needsRouteConfirmation": false
}`

// canned draft output (business agent ready_to_confirm) -----------------

const businessDraftReadyOutput = `{
  "status": "ready_to_confirm",
  "round": 1,
  "workLog": [{"type":"analysis","content":"草稿已收敛"}],
  "questions": [],
  "agentDraft": {
    "name": "海域态势提醒助手",
    "description": "监测异常并推送提醒",
    "prompt": "你是一个海域态势提醒助手。持续监测目标异常并向指挥员推送分级提醒。不执行任何工具调用或运行时操作。"
  }
}`

// --- test harness --------------------------------------------------------

// newDialogueTestServer builds an in-memory test Server and overrides both the
// clarification runner and the dialogue router with fakes. It seeds the catalog
// preset apps so the router has candidates, and the scene catalog so the
// blueprint slugs resolve.
func newDialogueTestServer(t *testing.T, dlgRunner runner.CommandRunner) (*Server, *Router, *store.Store) {
	t.Helper()
	root := t.TempDir()
	// Seed scene-catalog.json with the application/blueprint surfaces used by
	// these tests. carrier-formation-replay + aircraft-carrier-track are
	// application surfaces; carrier-homeport-tide-window is a blueprint.
	mustWriteCatalog(t, root)
	// Seed the store with preset application rows so the router has candidates.
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now()
	for _, app := range []model.Application{
		{ID: "app-carrier-formation-replay", Slug: "carrier-formation-replay", Name: "航母编队月度航迹复盘", Type: "situation_replay", Source: model.AppSourcePreset, Status: model.AppStatusStopped, Path: "scene/carrier-formation-replay", DisplayOrder: 1, CreatedAt: now, UpdatedAt: now},
		{ID: "app-aircraft-carrier-track", Slug: "aircraft-carrier-track", Name: "航母轨迹分析", Type: "situation_replay", Source: model.AppSourcePreset, Status: model.AppStatusStopped, Path: "scene/aircraft-carrier-track", DisplayOrder: 2, CreatedAt: now, UpdatedAt: now},
		// Blueprint-surface presets are discovered by the scanner (they exist on
		// disk) but filtered OUT of the app list. The catalog validator requires
		// every catalog key to be a discovered preset slug, so seed it here too.
		{ID: "app-carrier-homeport-tide-window", Slug: "carrier-homeport-tide-window", Name: "航母母港潮汐窗口计算器", Type: "command_dashboard", Source: model.AppSourcePreset, Status: model.AppStatusStopped, Path: "scene/carrier-homeport-tide-window", CreatedAt: now, UpdatedAt: now},
	} {
		if err := st.SyncApplications(context.Background(), []model.Application{app}); err != nil {
			t.Fatalf("seed app %s: %v", app.Slug, err)
		}
	}
	srv := New(config.Config{ArtifactRoot: t.TempDir(), WorkspaceRoot: root}, st, scanner.Scanner{})
	// Override clarification + dialogue runners with fakes. Both use the same
	// underlying runner.CommandRunner type; clarification is driven by the
	// clar-specific fake stdout constants.
	srv.clarifier = clarification.Runner{
		Cmd:           dlgRunner,
		WorkspaceRoot: root,
		ArtifactRoot:  t.TempDir(),
	}
	srv.dialogueRouter = dialogue.Runner{
		Cmd:           dlgRunner,
		WorkspaceRoot: root,
		ArtifactRoot:  t.TempDir(),
	}
	return srv, srv.routes(), st
}

// mustWriteCatalog writes a scene-catalog.json under root/.factory so the
// blueprint slugs the router emits are valid candidates.
func mustWriteCatalog(t *testing.T, root string) {
	t.Helper()
	cat := `{"version":1,"scenes":{
  "carrier-formation-replay": {"surface":"application","order":1},
  "aircraft-carrier-track": {"surface":"application","order":2},
  "carrier-homeport-tide-window": {"surface":"blueprint"}
}}`
	dir := root + "/.factory"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir .factory: %v", err)
	}
	if err := os.WriteFile(dir+"/scene-catalog.json", []byte(cat), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
}

// --- create + pre-lock routing ---

// TestCreateDialoguePersistsMessageAndRoutes verifies POST /api/dialogues
// persists the first user message, emits dialogue.created + dialogue.intent.updated,
// and returns a view whose route payload is redacted (no internalBlueprintSlug).
func TestCreateDialoguePersistsMessageAndRoutes(t *testing.T) {
	srv, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeAmbiguousOutput})

	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	rec := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "我想做一个航母编队复盘"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	var view dialogueView
	if err := json.NewDecoder(rec.Body).Decode(&view); err != nil {
		t.Fatalf("decode view: %v", err)
	}
	if view.Session.ID == "" {
		t.Fatalf("view has no session id")
	}
	if view.Session.Status != model.DialogueStatusRouting {
		t.Fatalf("status = %q, want routing", view.Session.Status)
	}
	if view.Session.RouteLocked {
		t.Fatalf("route should not be locked on create")
	}
	if view.Session.Intent != model.DialogueIntentRouting {
		t.Fatalf("intent = %q, want routing", view.Session.Intent)
	}
	// Message persisted.
	msgs, err := st.LatestDialogueMessages(context.Background(), view.Session.ID, 10)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	found := false
	for _, m := range msgs {
		if m.Role == "user" && m.Kind == "prompt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no user prompt message persisted; got %#v", msgs)
	}
	// Route payload must be present and redacted.
	if view.Route.Intent != dialogue.IntentApplicationGeneration {
		t.Fatalf("route intent = %q, want application_generation", view.Route.Intent)
	}
	raw, _ := json.Marshal(view.Route)
	if strings.Contains(string(raw), "internalBlueprintSlug") {
		t.Fatalf("route payload leaked internalBlueprintSlug: %s", raw)
	}

	// SSE events.
	events := drainClarificationHub(ch)
	sawCreated, sawIntent := false, false
	for _, ev := range events {
		raw, _ := json.Marshal(ev.Data)
		if ev.Type == "dialogue.created" {
			sawCreated = true
		}
		if ev.Type == "dialogue.intent.updated" {
			sawIntent = true
			if strings.Contains(string(raw), "internalBlueprintSlug") {
				t.Fatalf("intent.updated event leaked internalBlueprintSlug: %s", raw)
			}
		}
	}
	if !sawCreated {
		t.Fatalf("did not see dialogue.created event; got %#v", eventTypes(events))
	}
	if !sawIntent {
		t.Fatalf("did not see dialogue.intent.updated event; got %#v", eventTypes(events))
	}
}

func eventTypes(events []Event) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}

// TestCreateDialogueRejectsInventedSlug verifies the server validates the
// router's returned slug against the candidate sets and rejects an invented slug.
// On rejection the dialogue is marked failed, NO route record is persisted
// (Route.Intent stays empty), and the invented slug never reaches the response.
func TestCreateDialogueRejectsInventedSlug(t *testing.T) {
	const invented = `{
  "intent": "existing_application",
  "confidence": "high",
  "existingApplicationSlugs": ["this-app-does-not-exist"],
  "userFacingReason": "x",
  "needsRouteConfirmation": false
}`
	srv, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: invented})

	rec := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "hi"})

	// A routing failure returns 201 Created with the failed-session view (the
	// handler marks the dialogue failed rather than rejecting the whole request).
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (failed-session view); body=%s", rec.Code, rec.Body.String())
	}
	var view dialogueView
	if err := json.NewDecoder(rec.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The dialogue MUST be in a diagnosable failed state.
	if view.Session.Status != model.DialogueStatusFailed {
		t.Fatalf("status = %q, want failed (invented slug must fail routing)", view.Session.Status)
	}
	// NO route record may be persisted: the redacted Route payload has no intent.
	if view.Route.Intent != "" {
		t.Fatalf("route intent = %q, want empty (no route record after routing failure)", view.Route.Intent)
	}
	// The invented slug must not leak anywhere in the rendered response.
	if strings.Contains(rec.Body.String(), "this-app-does-not-exist") {
		t.Fatalf("invented slug leaked into response body: %s", rec.Body.String())
	}

	// Re-read from the store to confirm no route was persisted server-side.
	persisted, err := srv.store.GetDialogueSession(context.Background(), view.Session.ID)
	if err != nil || persisted == nil {
		t.Fatalf("re-read dialogue: %v", err)
	}
	if persisted.Status != model.DialogueStatusFailed {
		t.Fatalf("persisted status = %q, want failed", persisted.Status)
	}
	if persisted.Intent != "" && persisted.Intent != model.DialogueIntentRouting {
		t.Fatalf("persisted intent = %q, want empty/routing (route must not be stamped)", persisted.Intent)
	}
	if strings.Contains(persisted.DraftJSON, "this-app-does-not-exist") {
		t.Fatalf("invented slug persisted in DraftJSON: %s", persisted.DraftJSON)
	}
}

// --- route selection + lock ---

// TestRouteSelectExistingAppLocksAndRecommends verifies POST .../route with an
// existing-application selection enters recommending, exposes candidate cards,
// and locks the route so subsequent reclassification is rejected.
func TestRouteSelectExistingAppLocksAndRecommends(t *testing.T) {
	srv, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeExistingAppHighConfidenceOutput})

	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "航母编队复盘"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", create.Code, create.Body.String())
	}
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)
	_ = drainClarificationHub(ch)

	// Select the existing-app route explicitly.
	routeRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{
		"intent": "existing_application",
	})
	if routeRec.Code != http.StatusOK {
		t.Fatalf("route status = %d body=%s", routeRec.Code, routeRec.Body.String())
	}
	var view dialogueView
	if err := json.NewDecoder(routeRec.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.Session.Status != model.DialogueStatusRecommending {
		t.Fatalf("status = %q, want recommending", view.Session.Status)
	}
	if !view.Session.RouteLocked {
		t.Fatalf("route should be locked after selection")
	}
	if view.Session.Intent != model.DialogueIntentExistingApplication {
		t.Fatalf("intent = %q, want existing_application", view.Session.Intent)
	}
	// Candidate cards exposed.
	if len(view.Recommendations) == 0 {
		t.Fatalf("expected recommendation cards, got none; view=%#v", view)
	}
	primary := view.Recommendations[0]
	if primary.ApplicationID == "" {
		t.Fatalf("primary recommendation has no application_id")
	}
	if primary.Name == "" {
		t.Fatalf("primary recommendation has no name")
	}

	// dialogue.application.recommended emitted.
	events := drainClarificationHub(ch)
	sawRecommended := false
	for _, ev := range events {
		if ev.Type == "dialogue.application.recommended" {
			sawRecommended = true
		}
	}
	if !sawRecommended {
		t.Fatalf("did not see dialogue.application.recommended; got %#v", eventTypes(events))
	}

	// Subsequent re-routing via messages must be rejected (route locked).
	msgRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/messages", map[string]string{"content": "actually I want something else"})
	if msgRec.Code != http.StatusConflict {
		t.Fatalf("locked re-route status = %d, want 409; body=%s", msgRec.Code, msgRec.Body.String())
	}
}

// TestRouteSelectApplicationGenerationCreatesChildClarification verifies that
// selecting application_generation creates exactly one child clarification with
// max_rounds=6 and enters drafting_application.
func TestRouteSelectApplicationGenerationCreatesChildClarification(t *testing.T) {
	_, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeAmbiguousOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", create.Code, create.Body.String())
	}
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
	if view.Session.Status != model.DialogueStatusDraftingApplication {
		t.Fatalf("status = %q, want drafting_application", view.Session.Status)
	}
	if view.Session.Intent != model.DialogueIntentApplicationGeneration {
		t.Fatalf("intent = %q", view.Session.Intent)
	}
	if view.Session.ClarificationSessionID == "" {
		t.Fatalf("no child clarification session linked")
	}
	// Exactly one child.
	child, err := st.GetClarificationSession(context.Background(), view.Session.ClarificationSessionID)
	if err != nil || child == nil {
		t.Fatalf("child clarification not found: %v", err)
	}
	if child.MaxRounds != 6 {
		t.Fatalf("child max_rounds = %d, want 6", child.MaxRounds)
	}
	if child.Round < 1 {
		t.Fatalf("child round = %d, want >=1", child.Round)
	}
}

// TestRouteSelectBusinessAgentStartsDrafting verifies business_processing_agent
// selection enters drafting_business_agent and starts the draft round.
func TestRouteSelectBusinessAgentStartsDrafting(t *testing.T) {
	_, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeBusinessAgentOutput, draftStdout: businessDraftReadyOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "配置一个业务助手"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", create.Code, create.Body.String())
	}
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
	if view.Session.Status != model.DialogueStatusDraftingBusinessAgent {
		t.Fatalf("status = %q, want drafting_business_agent", view.Session.Status)
	}
	if view.Session.Intent != model.DialogueIntentBusinessProcessingAgent {
		t.Fatalf("intent = %q", view.Session.Intent)
	}
	if view.AgentDraft.Name == "" {
		t.Fatalf("agent draft not populated after draft round 1")
	}
}

// --- existing-app open ---

// TestExistingAppOpenStartsStoppedApp verifies .../open on a stopped app uses
// the shared start operation and returns the app only once it has a runtime URL.
func TestExistingAppOpenStartsStoppedApp(t *testing.T) {
	// Use a server whose runner/healthCheck are faked so the start succeeds.
	srv, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeExistingAppHighConfidenceOutput})
	// Fake deploy runner + health check so startAppInternal succeeds.
	srv.runner = &fakeDeployRunner{}
	srv.healthCheck = func(ctx context.Context, url string, timeout time.Duration) error { return nil }

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "航母编队复盘"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	routeRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{"intent": "existing_application"})
	if routeRec.Code != http.StatusOK {
		t.Fatalf("route: %d %s", routeRec.Code, routeRec.Body.String())
	}
	var routed dialogueView
	json.NewDecoder(routeRec.Body).Decode(&routed)

	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	openRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/applications/app-carrier-formation-replay/open", nil)
	if openRec.Code != http.StatusOK {
		t.Fatalf("open status = %d body=%s", openRec.Code, openRec.Body.String())
	}
	var view dialogueView
	if err := json.NewDecoder(openRec.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.ResolvedApplication == nil || view.ResolvedApplication.RuntimeURL == "" {
		t.Fatalf("open did not return an app with a runtime URL; view=%#v", view)
	}
	if view.Session.Status != model.DialogueStatusResolved {
		t.Fatalf("status = %q, want resolved", view.Session.Status)
	}
	if view.Session.ResolvedApplicationID != "app-carrier-formation-replay" {
		t.Fatalf("resolved_application_id = %q", view.Session.ResolvedApplicationID)
	}

	// dialogue.resolved emitted.
	events := drainClarificationHub(ch)
	sawResolved := false
	for _, ev := range events {
		if ev.Type == "dialogue.resolved" {
			sawResolved = true
		}
	}
	if !sawResolved {
		t.Fatalf("did not see dialogue.resolved; got %#v", eventTypes(events))
	}
}

// TestExistingAppOpenRejectsCandidateNotInRecommendation verifies .../open
// rejects an app id that was not in the persisted recommendation.
func TestExistingAppOpenRejectsCandidateNotInRecommendation(t *testing.T) {
	_, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeExistingAppHighConfidenceOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "航母编队复盘"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	_ = doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{"intent": "existing_application"})

	// aircraft-carrier-track is a valid app but was NOT in the recommendation
	// (which only had carrier-formation-replay).
	openRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/applications/app-aircraft-carrier-track/open", nil)
	if openRec.Code != http.StatusConflict && openRec.Code != http.StatusBadRequest {
		t.Fatalf("open non-recommended status = %d, want 4xx; body=%s", openRec.Code, openRec.Body.String())
	}
}

// fakeDeployRunner satisfies deploy.NewPodman's BuildImage/RunContainer needs.
type fakeDeployRunner struct{}

func (f *fakeDeployRunner) Run(ctx context.Context, dir, name string, args ...string) (deploy.CommandResult, error) {
	return deploy.CommandResult{ExitCode: 0, Stdout: ""}, nil
}
func (f *fakeDeployRunner) RunWithInput(ctx context.Context, dir, input, name string, args ...string) (deploy.CommandResult, error) {
	return deploy.CommandResult{ExitCode: 0, Stdout: ""}, nil
}
func (f *fakeDeployRunner) RunStream(ctx context.Context, dir, name string, onStdoutLine func(string), args ...string) (deploy.CommandResult, error) {
	return deploy.CommandResult{ExitCode: 0, Stdout: ""}, nil
}
func (f *fakeDeployRunner) RunStreamWithInput(ctx context.Context, dir, input string, onStdout, onStderr func(string), name string, args ...string) (deploy.CommandResult, error) {
	return deploy.CommandResult{ExitCode: 0, Stdout: ""}, nil
}

// --- business agent confirm ---

// TestNoAgentCreatedBeforeExplicitConfirmation verifies that selecting the
// business-agent route does NOT create an Agent until the confirm endpoint.
func TestNoAgentCreatedBeforeExplicitConfirmation(t *testing.T) {
	_, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeBusinessAgentOutput, draftStdout: businessDraftReadyOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "业务助手"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	_ = doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{"intent": "business_processing_agent"})

	agents, err := st.ListAgents(context.Background())
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	for _, a := range agents {
		if a.Category == model.AgentCategoryBusinessProcessing {
			t.Fatalf("business_processing agent created before confirm: %#v", a)
		}
	}
}

// TestBusinessAgentConfirmCreatesAgentWithUniqueKey verifies the confirm
// endpoint creates an enabled business_processing agent and resolves the dialogue.
func TestBusinessAgentConfirmCreatesAgentWithUniqueKey(t *testing.T) {
	srv, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeBusinessAgentOutput, draftStdout: businessDraftReadyOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "业务助手"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	_ = doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{"intent": "business_processing_agent"})

	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	confirmRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/confirm", nil)
	if confirmRec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", confirmRec.Code, confirmRec.Body.String())
	}
	var view dialogueView
	json.NewDecoder(confirmRec.Body).Decode(&view)
	if view.Session.Status != model.DialogueStatusResolved {
		t.Fatalf("status = %q, want resolved", view.Session.Status)
	}
	if view.Session.CreatedAgentID == "" {
		t.Fatalf("created_agent_id empty")
	}

	agent, err := st.GetAgent(context.Background(), view.Session.CreatedAgentID)
	if err != nil || agent == nil {
		t.Fatalf("agent not found: %v", err)
	}
	if agent.Category != model.AgentCategoryBusinessProcessing {
		t.Fatalf("agent category = %q", agent.Category)
	}
	if !agent.Enabled {
		t.Fatalf("agent not enabled")
	}
	if agent.Prompt == "" {
		t.Fatalf("agent prompt empty")
	}
	if agent.Key == "" {
		t.Fatalf("agent key empty")
	}

	// dialogue.agent.created + dialogue.resolved emitted.
	events := drainClarificationHub(ch)
	sawAgent, sawResolved := false, false
	for _, ev := range events {
		if ev.Type == "dialogue.agent.created" {
			sawAgent = true
		}
		if ev.Type == "dialogue.resolved" {
			sawResolved = true
		}
	}
	if !sawAgent {
		t.Fatalf("did not see dialogue.agent.created; got %#v", eventTypes(events))
	}
	if !sawResolved {
		t.Fatalf("did not see dialogue.resolved; got %#v", eventTypes(events))
	}
}

// --- application clarification: all six rounds via the child ---

// TestApplicationClarificationFullSixRounds drives a child clarification through
// 6 rounds: rounds 1-4 emit one question each, round 5 emits a consolidation
// list, and round 6 is the single-field adjust (ApplyConsolidationAdjustment,
// no model turn) that reaches ready_to_confirm. There must be NO 7th round.
func TestApplicationClarificationFullSixRounds(t *testing.T) {
	// The clarifier fake is a sequence runner that returns a different
	// RoundOutput per round.
	seq := &clarSequenceRunner{
		outputs: []string{
			roundOutputOneQuestion(1, "appType"),
			roundOutputOneQuestion(2, "primaryView"),
			roundOutputOneQuestion(3, "dataPolicy"),
			roundOutputOneQuestion(4, "targetUsers"),
			roundOutputConsolidation(5),
		},
	}
	srv, r, st := newDialogueTestServer(t, seq)
	// Override the dialogue router with a fixed route fake so the clarifier
	// (seq) is the ONLY runner whose call count reflects clarification rounds.
	// The intent-routing call (create) goes through dialogueRouter, not seq.
	srv.dialogueRouter = dialogue.Runner{
		Cmd:           &fakeDialogueRunner{routeStdout: routeAmbiguousOutput},
		WorkspaceRoot: srv.cfg.WorkspaceRoot,
		ArtifactRoot:  srv.cfg.ArtifactRoot,
	}

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个复盘应用"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	_ = doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{"intent": "application_generation"})
	var routed dialogueView
	_ = json.NewDecoder(doJSON(t, r, http.MethodGet, "/api/dialogues/"+created.Session.ID, nil).Body).Decode(&routed)
	childID := routed.Session.ClarificationSessionID
	if childID == "" {
		t.Fatalf("no child clarification linked")
	}

	// Rounds 1-4: answer each question to advance. Each round's question id is
	// the field; answering it + advancing runs the next round.
	answerRound := func(questionID, value string) {
		rec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/clarification/answers", map[string]string{
			"questionId": questionID, "value": value,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("answer %s status = %d body=%s", questionID, rec.Code, rec.Body.String())
		}
	}
	answerRound("appType", "situation_replay")
	answerRound("primaryView", "地图 + 时间轴")
	answerRound("dataPolicy", "mock_data")
	answerRound("targetUsers", "作战参谋")

	// After round 4 answered, round 5 should have run (consolidation) and the
	// child should be waiting for the round-6 adjust.
	child, _ := st.GetClarificationSession(context.Background(), childID)
	if child == nil {
		t.Fatalf("child gone after round 5")
	}

	// Round 6: submit the single-field consolidation adjustment. This is the
	// answers/batch with the consolidation selected field, OR a dedicated body.
	// We model round-6 adjust via the answers batch carrying a consolidation
	// payload so the child applies ApplyConsolidationAdjustment (no model turn).
	adjustRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/clarification/answers/batch", map[string]any{
		"consolidationField": "coreScenario",
		"consolidationValue": "复盘近 1 个月航迹",
	})
	if adjustRec.Code != http.StatusOK {
		t.Fatalf("round-6 adjust status = %d body=%s", adjustRec.Code, adjustRec.Body.String())
	}
	var adjustView dialogueView
	json.NewDecoder(adjustRec.Body).Decode(&adjustView)
	if adjustView.Child == nil {
		t.Fatalf("no child view in round-6 response")
	}
	if adjustView.Child.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("child status = %q, want ready_to_confirm after round 6", adjustView.Child.Status)
	}

	// No 7th round: the model was invoked exactly 5 times (rounds 1-5).
	if seq.calls > 5 {
		t.Fatalf("model invoked %d times, want <= 5 (no 7th round)", seq.calls)
	}

	// Confirm creates a job with a Base36-suffixed app name.
	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)
	confirmRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/clarification/confirm", nil)
	if confirmRec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", confirmRec.Code, confirmRec.Body.String())
	}
	var confirmView dialogueView
	json.NewDecoder(confirmRec.Body).Decode(&confirmView)
	if confirmView.Session.Status != model.DialogueStatusResolved {
		t.Fatalf("status = %q, want resolved", confirmView.Session.Status)
	}
	if confirmView.SeededJob == nil {
		t.Fatalf("no seeded job in confirm response")
	}
	// App name must carry a Base36 suffix, not the client value.
	if confirmView.SeededJob.AppName == "" {
		t.Fatalf("seeded job has no app name")
	}
}

// TestDialogueConfirmRollsBackOnMidSeedFailure asserts that when the job-seeding
// transaction fails part-way through (a step insert errors), the confirm handler
// leaves NO orphaned job row and moves the child clarification to a diagnosable
// failed state — never ready_to_confirm with no linked job.
func TestDialogueConfirmRollsBackOnMidSeedFailure(t *testing.T) {
	seq := &clarSequenceRunner{
		outputs: []string{
			roundOutputOneQuestion(1, "appType"),
			roundOutputOneQuestion(2, "primaryView"),
			roundOutputOneQuestion(3, "dataPolicy"),
			roundOutputOneQuestion(4, "targetUsers"),
			roundOutputConsolidation(5),
		},
	}
	srv, r, st := newDialogueTestServer(t, seq)
	srv.dialogueRouter = dialogue.Runner{
		Cmd:           &fakeDialogueRunner{routeStdout: routeAmbiguousOutput},
		WorkspaceRoot: srv.cfg.WorkspaceRoot,
		ArtifactRoot:  srv.cfg.ArtifactRoot,
	}

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个复盘应用"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	_ = doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{"intent": "application_generation"})
	var routed dialogueView
	_ = json.NewDecoder(doJSON(t, r, http.MethodGet, "/api/dialogues/"+created.Session.ID, nil).Body).Decode(&routed)
	childID := routed.Session.ClarificationSessionID
	if childID == "" {
		t.Fatalf("no child clarification linked")
	}

	answerRound := func(questionID, value string) {
		rec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/clarification/answers", map[string]string{
			"questionId": questionID, "value": value,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("answer %s status = %d body=%s", questionID, rec.Code, rec.Body.String())
		}
	}
	answerRound("appType", "situation_replay")
	answerRound("primaryView", "地图 + 时间轴")
	answerRound("dataPolicy", "mock_data")
	answerRound("targetUsers", "作战参谋")
	_ = doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/clarification/answers/batch", map[string]any{
		"consolidationField": "coreScenario",
		"consolidationValue": "复盘近 1 个月航迹",
	})

	// Snapshot the job count before confirm so we can prove no job was added.
	jobsBefore, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("list jobs before: %v", err)
	}

	// Inject a mid-seed failure: error on the 3rd step insert (after the job row
	// and 2 steps would otherwise persist). The transaction must roll back.
	srv.store.SetJobStepSeedHook(func(step model.JobStep) error {
		if step.Seq == 3 {
			return errors.New("injected mid-seed failure")
		}
		return nil
	})

	confirmRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/clarification/confirm", nil)
	if confirmRec.Code != http.StatusInternalServerError {
		t.Fatalf("confirm status = %d, want 500; body=%s", confirmRec.Code, confirmRec.Body.String())
	}

	// NO orphaned job: the job count is unchanged.
	jobsAfter, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("list jobs after: %v", err)
	}
	if len(jobsAfter) != len(jobsBefore) {
		t.Fatalf("job count changed: before=%d after=%d (rollback must leave NO orphaned job)", len(jobsBefore), len(jobsAfter))
	}

	// The child clarification is in a diagnosable failed state.
	child, err := st.GetClarificationSession(context.Background(), childID)
	if err != nil || child == nil {
		t.Fatalf("re-read child: %v", err)
	}
	if child.Status != model.ClarificationStatusFailed {
		t.Fatalf("child status = %q, want failed after seed failure", child.Status)
	}
	if child.ErrorCode != "job_seed_failed" {
		t.Fatalf("child error_code = %q, want job_seed_failed", child.ErrorCode)
	}
}

// roundOutputOneQuestion builds a waiting_user RoundOutput carrying one question
// (rounds 1-4). The requirement is incomplete so the session stays in flight.
func roundOutputOneQuestion(round int, field string) string {
	q := clarification.Question{
		ID: field, Label: field, Question: field + "?", Required: true,
		Options: []clarification.Option{{Value: "v", Label: "v"}},
	}
	out := clarification.RoundOutput{
		Status: "waiting_user", Round: round,
		WorkLog:   []clarification.WorkLog{{Type: "analysis", Content: "round " + field}},
		Questions: []clarification.Question{q},
		Requirement: clarification.Requirement{
			AppType: "situation_replay", AppName: "航母编队复盘应用",
			GenerationProfile: map[string][]string{"base": {"software-factory-app"}},
		},
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// roundOutputConsolidation builds a round-5 RoundOutput carrying a consolidation
// list for the still-missing fields (no questions). The requirement is left
// incomplete so round 6 is required.
func roundOutputConsolidation(round int) string {
	out := clarification.RoundOutput{
		Status: "waiting_user", Round: round,
		WorkLog: []clarification.WorkLog{{Type: "consolidation", Content: "收敛推荐"}},
		Requirement: clarification.Requirement{
			AppType: "situation_replay", AppName: "航母编队复盘应用",
			TargetUsers: []string{"作战参谋"}, PrimaryView: "地图 + 时间轴", DataPolicy: "mock_data",
			GenerationProfile: map[string][]string{"base": {"software-factory-app"}, "domain": {"defense-operations-ui"}, "pattern": {"map-timeline-replay"}},
		},
		Consolidation: []clarification.ConsolidationEntry{
			{Field: "coreScenario", RecommendedValue: json.RawMessage(`"复盘近 1 个月航迹"`), Reason: "推荐", Alternatives: []string{}},
			{Field: "mainEntities", RecommendedValue: json.RawMessage(`["编队","事件"]`), Reason: "推荐"},
			{Field: "acceptanceFocus", RecommendedValue: json.RawMessage(`["轨迹联动"]`), Reason: "推荐"},
		},
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// clarSequenceRunner serves canned RoundOutputs in sequence for the 6-round test.
type clarSequenceRunner struct {
	outputs []string
	calls   int
}

func (f *clarSequenceRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	f.calls++
	idx := f.calls - 1
	if idx >= len(f.outputs) {
		idx = len(f.outputs) - 1
	}
	return runner.CommandResult{ExitCode: 0, Stdout: f.outputs[idx]}, nil
}

// --- legacy history replay ---

// TestLegacyClarificationReplayViaDialogue verifies a backfilled legacy
// clarification session is reachable via the dialogue view (GET /api/dialogues/:id).
func TestLegacyClarificationReplayViaDialogue(t *testing.T) {
	_, r, st := newDialogueTestServer(t, &fakeDialogueRunner{})

	now := time.Now()
	// Insert a legacy confirmed clarification session with a linked job.
	legacy := model.ClarificationSession{
		ID: "clar_legacy1", Status: model.ClarificationStatusConfirmed,
		InitialPrompt: "历史需求", Round: 2, MaxRounds: 6,
		RequirementJSON: "{}", CreatedJobID: "", CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateClarificationSession(context.Background(), legacy); err != nil {
		t.Fatalf("create legacy: %v", err)
	}
	if err := st.BackfillClarificationDialogues(context.Background()); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	list := doJSON(t, r, http.MethodGet, "/api/dialogues", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list: %d %s", list.Code, list.Body.String())
	}
	var views []dialogueView
	json.NewDecoder(list.Body).Decode(&views)
	var found string
	for _, v := range views {
		if v.Session.ClarificationSessionID == "clar_legacy1" {
			found = v.Session.ID
		}
	}
	if found == "" {
		t.Fatalf("legacy clarification not backfilled into dialogues")
	}

	// GET the individual dialogue.
	rec := doJSON(t, r, http.MethodGet, "/api/dialogues/"+found, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	var view dialogueView
	if err := json.NewDecoder(rec.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.Session.Intent != model.DialogueIntentApplicationGeneration {
		t.Fatalf("intent = %q, want application_generation", view.Session.Intent)
	}
}

// --- redaction: no internal fields anywhere ---

// TestDialogueResponsesRedactInternalFields marshals every dialogue JSON response
// in this suite's flows and asserts no internalBlueprintSlug / raw stdout / stderr
// / thinking appears.
func TestDialogueResponsesRedactInternalFields(t *testing.T) {
	_, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeAmbiguousOutput, draftStdout: businessDraftReadyOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", create.Code, create.Body.String())
	}
	assertNoRedactedFields(t, "create", create.Body.String())

	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	list := doJSON(t, r, http.MethodGet, "/api/dialogues", nil)
	assertNoRedactedFields(t, "list", list.Body.String())

	get := doJSON(t, r, http.MethodGet, "/api/dialogues/"+created.Session.ID, nil)
	assertNoRedactedFields(t, "get", get.Body.String())

	route := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{"intent": "application_generation"})
	assertNoRedactedFields(t, "route", route.Body.String())
}

func assertNoRedactedFields(t *testing.T, label, body string) {
	t.Helper()
	forbidden := []string{"internalBlueprintSlug", "stdout", "stderr", "thinking_delta"}
	for _, f := range forbidden {
		if strings.Contains(body, f) {
			t.Fatalf("[%s] response body contains redacted field %q: %s", label, f, body)
		}
	}
}

// --- list + delete ---

func TestListAndDeleteDialogue(t *testing.T) {
	_, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "a"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	list := doJSON(t, r, http.MethodGet, "/api/dialogues", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list: %d", list.Code)
	}
	var views []dialogueView
	json.NewDecoder(list.Body).Decode(&views)
	if len(views) == 0 {
		t.Fatalf("list empty")
	}

	del := doJSON(t, r, http.MethodDelete, "/api/dialogues/"+created.Session.ID, nil)
	if del.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", del.Code, del.Body.String())
	}
}

// TestMessagesWhileUnlockedRepeatsRouting verifies that while unlocked, POST
// .../messages repeats the routing procedure.
func TestMessagesWhileUnlockedRepeatsRouting(t *testing.T) {
	srv, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeExistingAppHighConfidenceOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "航母编队"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)
	_ = drainClarificationHub(ch)

	msgRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/messages", map[string]string{"content": "帮我看看已有的"})
	if msgRec.Code != http.StatusOK {
		t.Fatalf("messages status = %d body=%s", msgRec.Code, msgRec.Body.String())
	}
	var view dialogueView
	json.NewDecoder(msgRec.Body).Decode(&view)
	if view.Route.Intent == "" {
		t.Fatalf("re-route did not produce a route payload")
	}
	// routing re-ran → another intent.updated event.
	events := drainClarificationHub(ch)
	sawIntent := false
	for _, ev := range events {
		if ev.Type == "dialogue.intent.updated" {
			sawIntent = true
		}
	}
	if !sawIntent {
		t.Fatalf("re-route did not emit dialogue.intent.updated; got %#v", eventTypes(events))
	}
}
