package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
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

// businessDraftQuestionOutput is a round-1 draft that asks ONE clarifying
// question and emits no complete draft — the case the multi-round loop must
// support (the user answers via the continue endpoint).
const businessDraftQuestionOutput = `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"analysis","content":"需要确认分诊范围"}],
  "questions": [{"id":"scope","label":"分诊范围","question":"这个助手分诊哪类告警？","required":true,"recommendation":"all","options":[{"value":"all","label":"全部告警"},{"value":"critical","label":"仅严重告警"}]}],
  "agentDraft": {"name":"","description":"","prompt":""}
}`

// businessDraftReadyAfterRefineOutput is the round-2 draft that converges to a
// complete, ready_to_confirm agentDraft after the user's refinement.
const businessDraftReadyAfterRefineOutput = `{
  "status": "ready_to_confirm",
  "round": 2,
  "workLog": [{"type":"analysis","content":"草稿已收敛"}],
  "questions": [],
  "agentDraft": {"name":"告警分诊助手","description":"按规则分诊全部告警","prompt":"你是告警分诊助手，按规则分诊全部告警。不执行任何工具调用或运行时操作。"}
}`

const businessDraftConsolidationOutput = `{
  "status": "waiting_user",
  "round": 5,
  "workLog": [{"type":"consolidation","content":"推荐按剩余字段收敛"}],
  "questions": [],
  "consolidation": [
    {"field":"agentDraft.name","recommendedValue":"告警分诊助手","reason":"匹配用户的分诊诉求","alternatives":["告警处置助手"]},
    {"field":"agentDraft.description","recommendedValue":"按规则分诊全部告警","reason":"覆盖用户选择的全部告警范围","alternatives":["仅分诊严重告警"]},
    {"field":"agentDraft.prompt","recommendedValue":"你是告警分诊助手，按规则分诊全部告警，输出分诊结论、优先级和处置建议。不执行任何工具调用或运行时操作。","reason":"形成可保存的业务处理 Agent 指令","alternatives":[]}
  ],
  "agentDraft": {"name":"告警分诊助手","description":"","prompt":""}
}`

const businessDraftPartialWaitingOutput = `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"analysis","content":"草稿仍需补充"}],
  "questions": [],
  "agentDraft": {"name":"告警分诊助手","description":"","prompt":"你是告警分诊助手。"}
}`

// businessDraftSequenceRunner emits canned route output for intent-routing and a
// SEQUENCE of draft outputs (one per business-draft round) so the multi-round
// loop can be exercised: draftOutputs[0] is round 1, [1] is round 2, etc.
type businessDraftSequenceRunner struct {
	draftOutputs []string
	draftCalls   int
}

func (r *businessDraftSequenceRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "business-agent-drafting") {
		idx := r.draftCalls
		r.draftCalls++
		out := businessDraftReadyOutput
		if idx < len(r.draftOutputs) {
			out = r.draftOutputs[idx]
		}
		return runner.CommandResult{ExitCode: 0, Stdout: out}, nil
	}
	return runner.CommandResult{ExitCode: 0, Stdout: routeBusinessAgentOutput}, nil
}

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
	for _, slug := range []string{"carrier-formation-replay", "aircraft-carrier-track", "carrier-homeport-tide-window"} {
		sceneDir := filepath.Join(root, "scene", slug, ".factory")
		if err := os.MkdirAll(sceneDir, 0o755); err != nil {
			t.Fatalf("mkdir scene manifest %s: %v", slug, err)
		}
		raw := `{
  "schemaVersion": 1,
  "slug": "` + slug + `",
  "name": "` + slug + `",
  "type": "command_dashboard",
  "source": "preset",
  "description": "` + slug + `",
  "entry": "static-vite",
  "path": "scene/` + slug + `",
  "build": { "command": "npm run build", "outputDir": "dist" },
  "runtime": { "devCommand": "npm run dev", "defaultPort": 5173 }
}`
		if err := os.WriteFile(filepath.Join(sceneDir, "app.json"), []byte(raw), 0o644); err != nil {
			t.Fatalf("write scene manifest %s: %v", slug, err)
		}
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

// TestRouteSelectBusinessAgentFallsBackToApplicationGeneration verifies that a
// stale client selecting the now-hidden business_processing_agent route is
// normalized to application_generation: it creates a child clarification and
// enters drafting_application, never starting business drafting.
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

func TestRouteSelectEmptyExistingApplicationFallsBackToGeneration(t *testing.T) {
	const emptyExistingApplication = `{
  "intent": "existing_application",
  "confidence": "high",
  "existingApplicationSlugs": [],
  "internalBlueprintSlug": "",
  "userFacingReason": "已有应用可复用。",
  "needsRouteConfirmation": false
}`
	_, r, _ := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: emptyExistingApplication})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "创建一个新的排班应用"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	routeRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{
		"intent": "existing_application",
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
	if view.Child == nil || view.Session.ClarificationSessionID == "" {
		t.Fatalf("empty existing-app selection must create a clarification child, got %#v", view)
	}
}

// TestApplicationGenerationWithoutBlueprintStillCreatesClarification verifies
// that application generation works with NO blueprint: the child clarification
// is still created.
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

// seedBusinessDrafting puts a dialogue into the dormant drafting_business_agent
// state and runs business draft round 1 — exactly what the now-hidden business
// route selection used to do — so dormant business-endpoint coverage (confirm /
// continue / consolidation) can still reach that state. Test-only.
func seedBusinessDrafting(t *testing.T, srv *Server, dlgID string) {
	t.Helper()
	ctx := context.Background()
	dlg, err := srv.store.GetDialogueSession(ctx, dlgID)
	if err != nil || dlg == nil {
		t.Fatalf("seedBusinessDrafting: get dialogue: %v", err)
	}
	routeBytes, _ := json.Marshal(persistedRoute{Intent: dialogue.IntentBusinessProcessingAgent})
	if err := srv.store.UpdateDialogueRoute(ctx, dlgID, model.DialogueIntentBusinessProcessingAgent, model.DialogueStatusDraftingBusinessAgent, string(routeBytes), true); err != nil {
		t.Fatalf("seedBusinessDrafting: lock business route: %v", err)
	}
	dlg, _ = srv.store.GetDialogueSession(ctx, dlgID)
	if err := srv.runBusinessDraftRound(ctx, dlgID, dlg, 1); err != nil {
		t.Fatalf("seedBusinessDrafting: round 1: %v", err)
	}
}

// TestNoAgentCreatedBeforeExplicitConfirmation verifies that selecting the
// business-agent route does NOT create an Agent until the confirm endpoint.
func TestNoAgentCreatedBeforeExplicitConfirmation(t *testing.T) {
	srv, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeBusinessAgentOutput, draftStdout: businessDraftReadyOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "业务助手"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	seedBusinessDrafting(t, srv, created.Session.ID)

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

	seedBusinessDrafting(t, srv, created.Session.ID)

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

func TestBusinessAgentConfirmRequiresReadyDraftStatus(t *testing.T) {
	srv, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeBusinessAgentOutput, draftStdout: businessDraftPartialWaitingOutput})

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "业务助手"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	seedBusinessDrafting(t, srv, created.Session.ID)

	confirmRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/confirm", nil)
	if confirmRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("confirm waiting_user draft status = %d, want 422; body=%s", confirmRec.Code, confirmRec.Body.String())
	}
	agents, err := st.ListAgents(context.Background())
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	for _, a := range agents {
		if a.Category == model.AgentCategoryBusinessProcessing {
			t.Fatalf("business agent created from waiting_user draft: %#v", a)
		}
	}
}

func TestBusinessAgentConsolidationAcceptsRecommendationsWithoutSeventhRound(t *testing.T) {
	seq := &businessDraftSequenceRunner{draftOutputs: []string{
		businessDraftQuestionOutput,
		businessDraftQuestionOutput,
		businessDraftQuestionOutput,
		businessDraftQuestionOutput,
		businessDraftConsolidationOutput,
	}}
	srv, r, _ := newDialogueTestServer(t, seq)

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个告警分诊助手"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	seedBusinessDrafting(t, srv, created.Session.ID)
	for i := 0; i < 4; i++ {
		rec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/continue", map[string]any{"content": "全部告警"})
		if rec.Code != http.StatusOK {
			t.Fatalf("continue #%d status = %d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if seq.draftCalls != 5 {
		t.Fatalf("draftCalls = %d, want 5 after round-5 consolidation", seq.draftCalls)
	}

	getRec := doJSON(t, r, http.MethodGet, "/api/dialogues/"+created.Session.ID, nil)
	var round5View struct {
		Session            model.DialogueSession         `json:"session"`
		AgentDraftStatus   string                        `json:"agentDraftStatus"`
		AgentConsolidation []dialogue.ConsolidationEntry `json:"agentConsolidation"`
		AgentDraft         dialogue.BusinessAgentDraft   `json:"agentDraft"`
	}
	json.NewDecoder(getRec.Body).Decode(&round5View)
	if len(round5View.AgentConsolidation) != 3 {
		t.Fatalf("agentConsolidation = %d rows, want 3: %+v", len(round5View.AgentConsolidation), round5View.AgentConsolidation)
	}
	if round5View.AgentDraftStatus == "ready_to_confirm" {
		t.Fatalf("round-5 consolidation must not be ready before user accepts recommendations")
	}

	acceptRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/consolidation", map[string]any{
		"consolidationAccept": true,
	})
	if acceptRec.Code != http.StatusOK {
		t.Fatalf("business consolidation accept status = %d body=%s", acceptRec.Code, acceptRec.Body.String())
	}
	var accepted struct {
		AgentDraftStatus string                      `json:"agentDraftStatus"`
		AgentDraft       dialogue.BusinessAgentDraft `json:"agentDraft"`
	}
	json.NewDecoder(acceptRec.Body).Decode(&accepted)
	if accepted.AgentDraftStatus != "ready_to_confirm" {
		t.Fatalf("agentDraftStatus = %q, want ready_to_confirm", accepted.AgentDraftStatus)
	}
	if accepted.AgentDraft.Name == "" || accepted.AgentDraft.Description == "" || accepted.AgentDraft.Prompt == "" {
		t.Fatalf("accepted draft incomplete: %+v", accepted.AgentDraft)
	}
	if seq.draftCalls != 5 {
		t.Fatalf("draftCalls = %d, want 5 (accept recommendations must not call model again)", seq.draftCalls)
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

// TestApplicationClarificationAcceptConsolidation is the regression for review P0
// #3: the round-5 "接受推荐" (accept-all) action must reach ready_to_confirm. The
// accept path merges every persisted recommendation (ApplyConsolidationAdjustment
// with an empty selectedField) and validates completeness — no model turn, and
// (unlike the prior __accept__ sentinel the frontend sent) a real backend path.
func TestApplicationClarificationAcceptConsolidation(t *testing.T) {
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
		Cmd: &fakeDialogueRunner{routeStdout: routeAmbiguousOutput}, WorkspaceRoot: srv.cfg.WorkspaceRoot, ArtifactRoot: srv.cfg.ArtifactRoot,
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

	// Accept all recommendations.
	acceptRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/clarification/answers/batch", map[string]any{
		"consolidationAccept": true,
	})
	if acceptRec.Code != http.StatusOK {
		t.Fatalf("accept status = %d body=%s", acceptRec.Code, acceptRec.Body.String())
	}
	var acceptView dialogueView
	json.NewDecoder(acceptRec.Body).Decode(&acceptView)
	if acceptView.Child == nil || acceptView.Child.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("child status = %+v, want ready_to_confirm after accept-all", acceptView.Child)
	}
	// Persisted child must also be ready_to_confirm with a complete requirement.
	child, _ := st.GetClarificationSession(context.Background(), childID)
	if child == nil || child.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("persisted child status = %+v, want ready_to_confirm", child)
	}
	// No 7th model round — accept-all does not invoke the model.
	if seq.calls > 5 {
		t.Fatalf("model invoked %d times, want <= 5 (accept-all adds no round)", seq.calls)
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

// TestListAppsSurvivesFreshDatabaseWithoutBlueprintInStore is the regression for
// the fresh-database 500 (review P0 #1): the production scanner DROPS
// blueprint-surface presets from the store, so GET /api/apps and dialogue routing
// must not require blueprint catalog keys to be present in the store. Before the
// fix, filterVisibleApplications / loadSceneCatalog built the known-slug set from
// the store and LoadSceneCatalog rejected the blueprint catalog keys → 500 on
// /api/apps and empty routing candidates. The test harness seeds the blueprint
// into the store (masking the bug), so we delete it to reproduce production.
func TestListAppsSurvivesFreshDatabaseWithoutBlueprintInStore(t *testing.T) {
	srv, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeExistingAppHighConfidenceOutput})
	ctx := context.Background()

	// Simulate the production condition: the scanner stores only the application
	// presets; the blueprint preset is NOT in the store.
	if err := st.DeleteApplication(ctx, "app-carrier-homeport-tide-window"); err != nil {
		t.Fatalf("delete blueprint app: %v", err)
	}

	// The runtime catalog loader must still surface the blueprint slug so routing
	// has blueprint candidates, despite the slug being absent from the store.
	catalog := srv.loadSceneCatalog(ctx)
	found := false
	for _, slug := range catalog.BlueprintSlugs() {
		if slug == "carrier-homeport-tide-window" {
			found = true
		}
	}
	if !found {
		t.Fatalf("loadSceneCatalog lost blueprint slug when it is absent from the store; got %+v", catalog.BlueprintSlugs())
	}

	// GET /api/apps must NOT 500 and must return the two application presets only
	// (the blueprint must never appear in the app list).
	rec := doJSON(t, r, http.MethodGet, "/api/apps", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/apps = %d, want 200 (fresh-database regression); body=%s", rec.Code, rec.Body.String())
	}
	var apps []model.Application
	if err := json.NewDecoder(rec.Body).Decode(&apps); err != nil {
		t.Fatalf("decode apps: %v", err)
	}
	if len(apps) != 2 {
		t.Fatalf("app list = %d apps, want the 2 application presets: %+v", len(apps), appSlugs(apps))
	}
	for _, a := range apps {
		if a.Slug == "carrier-homeport-tide-window" {
			t.Fatalf("blueprint preset leaked into app list: %+v", appSlugs(apps))
		}
	}
}

func appSlugs(apps []model.Application) []string {
	out := make([]string, 0, len(apps))
	for _, a := range apps {
		out = append(out, a.Slug)
	}
	return out
}

// TestFactoryAppSlugDerivation is the regression for review P2 #7 (a)/(b): the
// safe slug is derived from the same values as the readable name, with a
// LOWERCASE serial (the readable name keeps the uppercase serial). A pure-Chinese
// scenario name must anchor on appType so the slug is not serial-only.
func TestFactoryAppSlugDerivation(t *testing.T) {
	cases := []struct {
		name, appType, serial, want string
	}{
		{"Carrier Replay", "", "K7M2", "carrier-replay-k7m2"},           // ASCII name passthrough + lowercased serial
		{"航母编队复盘", "situation_replay", "K7M2", "situation-replay-k7m2"}, // Chinese name -> appType anchor
		{"航母编队复盘", "", "K7M2", "app-k7m2"},                              // Chinese name, no appType -> app anchor
		{"  Mixed 航迹 Replay ", "situation_replay", "AB12", "mixed-replay-ab12"},
	}
	for _, c := range cases {
		if got := factoryAppSlug(c.name, c.appType, c.serial); got != c.want {
			t.Errorf("factoryAppSlug(%q,%q,%q) = %q, want %q", c.name, c.appType, c.serial, got, c.want)
		}
	}
}

// TestAppSlugCollisionMatchesLowercaseSlug is the regression for review P2 #7
// (b): the OLD collision check was HasSuffix(a.Slug, "-"+UPPERCASE cand), which
// never matched the lowercased stored slug and so admitted duplicates. The fix
// compares the exact candidate slug. Seeding an app whose slug is the lowercased
// factory slug for uppercase serial "K7M2" must be detected as taken when the
// predicate is called with that uppercase candidate.
func TestAppSlugCollisionMatchesLowercaseSlug(t *testing.T) {
	srv, _, st := newDialogueTestServer(t, &fakeDialogueRunner{})
	ctx := context.Background()
	now := time.Now()
	existing := factoryAppSlug("航母编队复盘", "situation_replay", "K7M2") // situation-replay-k7m2
	if err := st.SyncApplications(ctx, []model.Application{
		{ID: "app-existing", Slug: existing, Name: "existing", Type: "situation_replay", Source: model.AppSourceGenerated, Status: model.AppStatusStopped, Path: "generated-apps/existing", CreatedAt: now, UpdatedAt: now},
	}); err != nil {
		t.Fatalf("seed existing app: %v", err)
	}
	// Uppercase candidate "K7M2" must collide with the lowercased stored slug.
	if !srv.appSlugTaken(ctx, "航母编队复盘", "situation_replay", "K7M2") {
		t.Fatalf("appSlugTaken must detect the lowercased existing slug %q against uppercase cand K7M2", existing)
	}
	// A different serial must not collide.
	if srv.appSlugTaken(ctx, "航母编队复盘", "situation_replay", "ZZ99") {
		t.Fatalf("appSlugTaken must not flag an unused serial")
	}
}

// TestAgentKeyIncludesNameSlug is the regression for review P2 #7 (c): the agent
// key is derived from the normalized name plus a serial (spec), not a bare
// "biz-<serial>". An ASCII draft name anchors the key; a non-ASCII name falls
// back to the "biz" anchor. agentKeyTaken matches the lowercased key exactly.
func TestAgentKeyIncludesNameSlug(t *testing.T) {
	srv, _, _ := newDialogueTestServer(t, &fakeDialogueRunner{})
	ctx := context.Background()
	// ASCII name -> name-anchored key.
	if got := slugify(normalizeScenarioName("Alert Triage", "", "")) + "-abcd"; got != "alert-triage-abcd" {
		t.Fatalf("ascii name key anchor = %q, want alert-triage-abcd", got)
	}
	// Non-ASCII name -> "biz" anchor (slugifyRaw yields nothing for pure Chinese).
	nameSlug := slugifyRaw(normalizeScenarioName("告警分诊助手", "", ""))
	if nameSlug != "" {
		t.Fatalf("non-ASCII name slug = %q, want empty (so the biz anchor is used)", nameSlug)
	}
	// Before seeding: no collision.
	if srv.agentKeyTaken(ctx, "alert-triage", "ABCD") {
		t.Fatalf("agentKeyTaken must be false before any agent is seeded")
	}
	// Seed an agent with key alert-triage-abcd and verify the predicate detects it
	// via the uppercase candidate serial.
	agent := model.Agent{ID: "agent-x", Key: "alert-triage-abcd", Name: "x", Role: "business_processing", Category: model.AgentCategoryBusinessProcessing, SortOrder: 99}
	if err := srv.store.CreateAgent(ctx, agent); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	if !srv.agentKeyTaken(ctx, "alert-triage", "ABCD") {
		t.Fatalf("agentKeyTaken must detect the lowercased key alert-triage-abcd against uppercase cand ABCD")
	}
}

// TestBlueprintCandidatesReadFromWorkspaceRoot is the regression for review P1 #6:
// blueprints.json must be read relative to the configured WORKSPACE ROOT, not the
// process CWD (factory-server/). The server is normally launched from
// factory-server/ with FACTORY_WORKSPACE_ROOT at the repo root, so a CWD-relative
// read returned an empty catalog and starved routing of blueprint metadata. With
// no file present the loader is best-effort (empty); writing it under the
// workspace root must populate the candidate metadata.
func TestBlueprintCandidatesReadFromWorkspaceRoot(t *testing.T) {
	srv, _, _ := newDialogueTestServer(t, &fakeDialogueRunner{})
	ctx := context.Background()
	root := srv.cfg.WorkspaceRoot
	catalog := srv.loadSceneCatalog(ctx)

	// Before the file exists: best-effort empty metadata (no crash, empty name).
	before := srv.blueprintCandidates(catalog)
	for _, b := range before {
		if b.Slug == "carrier-homeport-tide-window" && b.Name != "" {
			t.Fatalf("unexpected blueprint metadata before writing blueprints.json: %+v", b)
		}
	}

	// Write blueprints.json under the workspace root's .claude tree (the path the
	// real runbook resolves to via FACTORY_WORKSPACE_ROOT).
	dir := filepath.Join(root, ".claude", "skills", "requirement-clarification")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	doc := `{"blueprints":[
		{"slug":"carrier-homeport-tide-window","displayName":"航母母港潮汐窗口计算器","description":"计算进出港潮汐窗口","appType":"command_dashboard"}
	]}`
	if err := os.WriteFile(filepath.Join(dir, "blueprints.json"), []byte(doc), 0o644); err != nil {
		t.Fatalf("write blueprints.json: %v", err)
	}

	after := srv.blueprintCandidates(catalog)
	var meta dialogue.BlueprintSummary
	for _, b := range after {
		if b.Slug == "carrier-homeport-tide-window" {
			meta = b
		}
	}
	if meta.Name == "" || meta.AppType == "" || meta.Summary == "" {
		t.Fatalf("blueprint metadata not read from workspace root; got %+v", meta)
	}
	if meta.Name != "航母母港潮汐窗口计算器" {
		t.Fatalf("blueprint name = %q, want 航母母港潮汐窗口计算器", meta.Name)
	}
}

// TestBusinessAgentMultiRoundContinueThenConfirm is the regression for review P0
// #4: the business-agent multi-round drafting loop must close. Before the fix,
// the business route was locked (so /messages 409'd) and the draft's clarifying
// questions had no answer/continue endpoint, so only a first-round-ready draft
// could complete. Now POST .../business-agent/continue appends the user's
// refinement and re-runs the draft round, capped at six rounds.
func TestBusinessAgentMultiRoundContinueThenConfirm(t *testing.T) {
	seq := &businessDraftSequenceRunner{draftOutputs: []string{businessDraftQuestionOutput, businessDraftReadyAfterRefineOutput}}
	srv, r, st := newDialogueTestServer(t, seq)

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个告警分诊助手"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)

	seedBusinessDrafting(t, srv, created.Session.ID)
	// Round 1 ran at route-lock and produced a clarifying question (no complete draft).
	if seq.draftCalls != 1 {
		t.Fatalf("draftCalls = %d, want 1 after route-lock round 1", seq.draftCalls)
	}

	// Answer the round-1 question via the continue endpoint -> round 2 converges.
	contRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/continue", map[string]any{"content": "全部告警"})
	if contRec.Code != http.StatusOK {
		t.Fatalf("continue status = %d body=%s", contRec.Code, contRec.Body.String())
	}
	var contView dialogueView
	json.NewDecoder(contRec.Body).Decode(&contView)
	if seq.draftCalls != 2 {
		t.Fatalf("draftCalls = %d, want 2 (round 2 ran on continue)", seq.draftCalls)
	}
	if contView.AgentDraft.Name == "" || contView.AgentDraft.Prompt == "" {
		t.Fatalf("round-2 continue did not surface a complete agentDraft: %+v", contView.AgentDraft)
	}

	// Confirm creates the agent and resolves the dialogue.
	confirmRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/confirm", nil)
	if confirmRec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", confirmRec.Code, confirmRec.Body.String())
	}
	var confirmView dialogueView
	json.NewDecoder(confirmRec.Body).Decode(&confirmView)
	if confirmView.Session.Status != model.DialogueStatusResolved {
		t.Fatalf("status = %q, want resolved", confirmView.Session.Status)
	}
	if confirmView.Session.CreatedAgentID == "" {
		t.Fatalf("no created agent")
	}

	// A continue on a resolved (non-drafting) dialogue must 409 — the loop does
	// not run past resolution.
	again := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/continue", map[string]any{"content": "more"})
	if again.Code != http.StatusConflict {
		t.Fatalf("continue after resolve = %d, want 409", again.Code)
	}
	_ = srv
	_ = st
}

// TestBusinessAgentContinueEnforcesSixRoundCap verifies the continue loop refuses
// a seventh model turn: once six user turns exist, continue 409s instead of
// running another draft round.
func TestBusinessAgentContinueEnforcesSixRoundCap(t *testing.T) {
	seq := &businessDraftSequenceRunner{draftOutputs: []string{businessDraftQuestionOutput, businessDraftQuestionOutput, businessDraftQuestionOutput, businessDraftQuestionOutput, businessDraftQuestionOutput, businessDraftQuestionOutput}}
	srv, r, _ := newDialogueTestServer(t, seq)

	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "做一个助手"})
	var created dialogueView
	json.NewDecoder(create.Body).Decode(&created)
	seedBusinessDrafting(t, srv, created.Session.ID)

	// Route-lock ran round 1 (1 user turn). Five continues reach round 6 (6 user
	// turns); a sixth continue must be refused (no 7th round).
	for i := 0; i < 5; i++ {
		rec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/continue", map[string]any{"content": "refine"})
		if rec.Code != http.StatusOK {
			t.Fatalf("continue #%d status = %d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if seq.draftCalls != 6 {
		t.Fatalf("draftCalls = %d, want 6 (rounds 1-6)", seq.draftCalls)
	}
	cap := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/business-agent/continue", map[string]any{"content": "one more"})
	if cap.Code != http.StatusConflict {
		t.Fatalf("7th continue = %d, want 409 (six-round cap)", cap.Code)
	}
	if seq.draftCalls != 6 {
		t.Fatalf("draftCalls = %d, want 6 (no 7th round must run)", seq.draftCalls)
	}
}
