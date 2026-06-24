package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
	"github.com/weimengtsgit/xian630/factory-server/internal/dialogue"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
)

// This file implements the /api/dialogues facade (Task 4). It is the dialogue
// parent resource over the three Factory outcomes: existing-app reuse,
// application generation (via a child clarification session), and business-agent
// drafting. It composes a DialogueView from the parent session, its messages,
// the current route payload, the child clarification view when present, and
// linked result summaries (resolved app / created agent / seeded job).
//
// Security boundaries:
//   - internalBlueprintSlug is server-side only: the router returns it but it is
//     NEVER surfaced in a response body or SSE payload (routeEventView omits it).
//   - Client-supplied appName/slug/blueprint/serial at confirm time are NEVER
//     trusted: the Factory-owned name is <normalizedScenarioName>-<Base36> and
//     the slug is derived from it.
//   - Every returned route slug is validated against the candidate sets the
//     Factory supplied BEFORE it is persisted or returned.
//   - raw CLI stdout/stderr and thinking deltas are never surfaced; only
//     normalized dialogue.* / clarification.* events travel over SSE.

// ---- request/response bodies ---------------------------------------------

type createDialogueBody struct {
	Prompt string `json:"prompt"`
}

type addDialogueMessageBody struct {
	Content string `json:"content"`
}

type selectDialogueRouteBody struct {
	Intent string `json:"intent"`
}

type dialogueAnswerBody struct {
	QuestionID string `json:"questionId"`
	Value      string `json:"value"`
}

type dialogueBatchAnswersBody struct {
	Answers             []dialogueAnswerBody `json:"answers"`
	ConsolidationField  string               `json:"consolidationField"`
	ConsolidationValue  string               `json:"consolidationValue"`
	ConsolidationAccept bool                 `json:"consolidationAccept"`
}

type businessConsolidationBody struct {
	ConsolidationField  string `json:"consolidationField"`
	ConsolidationValue  string `json:"consolidationValue"`
	ConsolidationAccept bool   `json:"consolidationAccept"`
}

type dialoguePatchRequirementBody struct {
	Requirement json.RawMessage `json:"requirement"`
}

// recommendationCard is one validated existing-app candidate card: name,
// user-facing match reason, status, and safe runtime URL. It never carries the
// internal blueprint slug.
type recommendationCard struct {
	ApplicationID string `json:"applicationId"`
	Slug          string `json:"slug"`
	Name          string `json:"name"`
	AppType       string `json:"appType"`
	MatchReason   string `json:"matchReason"`
	Status        string `json:"status"`
	RuntimeURL    string `json:"runtimeUrl,omitempty"`
	Primary       bool   `json:"primary"`
}

// routePayload is the user-facing projection of the persisted route record. It
// OMITS internalBlueprintSlug entirely — that field survives only in the
// persisted DraftJSON (server-side) and is never returned.
type routePayload struct {
	Intent                   dialogue.Intent     `json:"intent"`
	Confidence               dialogue.Confidence `json:"confidence"`
	ExistingApplicationSlugs []string            `json:"existingApplicationSlugs"`
	UserFacingReason         string              `json:"userFacingReason"`
	NeedsRouteConfirmation   bool                `json:"needsRouteConfirmation"`
}

// persistedRoute is the full route shape stored in DraftJSON, INCLUDING the
// hidden internal blueprint slug. It is decoded from DraftJSON internally and
// projected to routePayload before any response/SSE.
type persistedRoute struct {
	Intent                   dialogue.Intent     `json:"intent"`
	Confidence               dialogue.Confidence `json:"confidence"`
	ExistingApplicationSlugs []string            `json:"existingApplicationSlugs"`
	InternalBlueprintSlug    string              `json:"internalBlueprintSlug"`
	UserFacingReason         string              `json:"userFacingReason"`
	NeedsRouteConfirmation   bool                `json:"needsRouteConfirmation"`
}

func (p persistedRoute) public() routePayload {
	return routePayload{
		Intent:                   p.Intent,
		Confidence:               p.Confidence,
		ExistingApplicationSlugs: p.ExistingApplicationSlugs,
		UserFacingReason:         p.UserFacingReason,
		NeedsRouteConfirmation:   p.NeedsRouteConfirmation,
	}
}

type businessDraftRecord struct {
	Status     string                      `json:"status,omitempty"`
	Round      int                         `json:"round,omitempty"`
	AgentDraft dialogue.BusinessAgentDraft `json:"agentDraft,omitempty"`
}

// dialogueView is the composed response shape returned by every dialogue route.
type dialogueView struct {
	Session             model.DialogueSession         `json:"session"`
	Messages            []model.DialogueMessage       `json:"messages"`
	Route               routePayload                  `json:"route"`
	Recommendations     []recommendationCard          `json:"recommendations,omitempty"`
	AgentDraft          dialogue.BusinessAgentDraft   `json:"agentDraft,omitempty"`
	AgentDraftStatus    string                        `json:"agentDraftStatus,omitempty"`
	AgentConsolidation  []dialogue.ConsolidationEntry `json:"agentConsolidation,omitempty"`
	Child               *clarificationView            `json:"child,omitempty"`
	ResolvedApplication *model.Application            `json:"resolvedApplication,omitempty"`
	CreatedAgent        *model.Agent                  `json:"createdAgent,omitempty"`
	SeededJob           *model.Job                    `json:"seededJob,omitempty"`
}

// ---- helpers --------------------------------------------------------------

// publishDialogueEvent forwards a normalized dialogue.StreamEvent onto the SSE
// hub. The event type is the dialogue.* kind the runner emits; the data is the
// redacted StreamEvent the runner already produced (internalBlueprintSlug never
// appears in it).
func (s *Server) publishDialogueEvent(ev dialogue.StreamEvent) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(Event{Type: ev.Type, Data: ev})
}

// publishDialogueSimple publishes a dialogue.* event carrying an arbitrary
// redacted payload and the parent dialogue id so the portal updates one state
// source. Used for lifecycle events the handlers themselves emit.
func (s *Server) publishDialogueSimple(eventType, dialogueID string, data any) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(Event{Type: eventType, Data: map[string]any{
		"dialogue_id": dialogueID,
		"data":        data,
	}})
}

// loadSceneCatalog loads the structurally-validated scene catalog for routing.
// It uses the surface-only loader (LoadSceneCatalogForSurface): blueprint-surface
// presets are never stored, so deriving the known-slug set from the store would
// starve routing of blueprint candidates and empty the app candidate list on a
// fresh database. Best-effort: on failure it returns an empty catalog so a
// misconfigured workspace degrades to "no candidates" rather than crashing.
func (s *Server) loadSceneCatalog(ctx context.Context) scanner.SceneCatalog {
	_ = ctx
	catalog, err := scanner.LoadSceneCatalogForSurface(s.cfg.WorkspaceRoot)
	if err != nil {
		return scanner.SceneCatalog{}
	}
	return catalog
}

// routingAppCandidates builds the app summaries the router may route to: the
// catalog application-surface presets plus every generated application. Each
// carries the slug Factory validates against.
func (s *Server) routingAppCandidates(ctx context.Context, catalog scanner.SceneCatalog) ([]dialogue.AppSummary, map[string]*model.Application) {
	apps, err := s.store.ListApplications(ctx)
	if err != nil {
		return nil, nil
	}
	out := make([]dialogue.AppSummary, 0, len(apps))
	bySlug := make(map[string]*model.Application, len(apps))
	for i := range apps {
		app := apps[i]
		if app.Source == model.AppSourcePreset && !catalog.IsVisibleApplication(app.Slug) {
			continue
		}
		bySlug[app.Slug] = &apps[i]
		out = append(out, dialogue.AppSummary{
			Slug:        app.Slug,
			Name:        app.Name,
			AppType:     app.Type,
			Summary:     app.Description,
			IsGenerated: app.Source == model.AppSourceGenerated,
		})
	}
	return out, bySlug
}

// blueprintCandidates builds the internal blueprint summaries from the catalog
// blueprint slugs + their blueprints.json metadata. These are server-side-only;
// their slugs are never surfaced in a response (only used to validate the
// router's internalBlueprintSlug).
func (s *Server) blueprintCandidates(catalog scanner.SceneCatalog) []dialogue.BlueprintSummary {
	slugs := catalog.BlueprintSlugs()
	metas := s.loadBlueprintCatalog()
	out := make([]dialogue.BlueprintSummary, 0, len(slugs))
	for _, slug := range slugs {
		name, desc, appType := findBlueprintMeta(metas, slug)
		out = append(out, dialogue.BlueprintSummary{
			Slug:    slug,
			Name:    name,
			AppType: appType,
			Summary: desc,
		})
	}
	return out
}

// blueprintMeta is one row of .claude/skills/requirement-clarification/blueprints.json.
type blueprintMeta struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	AppType     string `json:"appType"`
}

// loadBlueprintCatalog reads .claude/skills/requirement-clarification/blueprints.json
// relative to the configured WORKSPACE ROOT, not the process CWD. The server is
// normally launched from factory-server/ with FACTORY_WORKSPACE_ROOT pointing at
// the repo root, so a CWD-relative read would miss the file and starve routing
// of blueprint name/description/appType candidates. It is read fresh each routing
// turn (a small file, rarely called) rather than cached in package state, so
// test servers with different roots never share a stale catalog.
func (s *Server) loadBlueprintCatalog() []blueprintMeta {
	path := filepath.Join(s.cfg.WorkspaceRoot, ".claude", "skills", "requirement-clarification", "blueprints.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var doc struct {
		Blueprints []blueprintMeta `json:"blueprints"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	return doc.Blueprints
}

// findBlueprintMeta returns the (name, description, appType) for a blueprint slug
// among the loaded metadata. Unknown slugs get empty strings.
func findBlueprintMeta(metas []blueprintMeta, slug string) (name, desc, appType string) {
	for _, b := range metas {
		if b.Slug == slug {
			return b.DisplayName, b.Description, b.AppType
		}
	}
	return "", "", ""
}

// messageViews converts persisted dialogue messages into the DialogueMessageView
// slice the router consumes.
func messageViews(msgs []model.DialogueMessage) []dialogue.DialogueMessageView {
	out := make([]dialogue.DialogueMessageView, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, dialogue.DialogueMessageView{Role: m.Role, Kind: m.Kind, Content: m.Content})
	}
	return out
}

// runRouting performs one intent-routing turn for an unlocked dialogue: builds
// the candidates, invokes the router, validates every returned slug, and returns
// the validated route + the resolved recommendation cards. It does NOT persist
// (the caller persists after). On a validation/routing failure it returns an
// error; the caller marks the dialogue failed.
func (s *Server) runRouting(ctx context.Context, dlg *model.DialogueSession, userMessage string, msgs []model.DialogueMessage) (persistedRoute, []recommendationCard, error) {
	catalog := s.loadSceneCatalog(ctx)
	appCandidates, appsBySlug := s.routingAppCandidates(ctx, catalog)
	bpCandidates := s.blueprintCandidates(catalog)
	input := dialogue.RouteInput{
		DialogueID:           dlg.ID,
		UserMessage:          userMessage,
		Messages:             messageViews(msgs),
		ExistingApplications: appCandidates,
		Blueprints:           bpCandidates,
	}
	out, err := s.dialogueRouter.RouteIntent(ctx, input, s.publishDialogueEvent)
	if err != nil {
		return persistedRoute{}, nil, err
	}
	route := persistedRoute{
		Intent:                   out.Intent,
		Confidence:               out.Confidence,
		ExistingApplicationSlugs: out.ExistingApplicationSlugs,
		InternalBlueprintSlug:    out.InternalBlueprintSlug,
		UserFacingReason:         out.UserFacingReason,
		NeedsRouteConfirmation:   out.NeedsRouteConfirmation,
	}
	// Validate every returned slug against the candidate sets BEFORE persisting.
	// An invented slug (one the router hallucinated rather than chose from the
	// supplied candidates) is a routing failure: the dialogue is marked failed
	// and NO route record is persisted, so the slug can never leak into a
	// response. This is the contract runRouting's doc comment promises.
	for _, slug := range route.ExistingApplicationSlugs {
		if _, ok := appsBySlug[slug]; !ok {
			return persistedRoute{}, nil, fmt.Errorf("router returned unknown existing application slug %q", slug)
		}
	}
	if route.InternalBlueprintSlug != "" {
		knownBP := false
		for _, bp := range bpCandidates {
			if bp.Slug == route.InternalBlueprintSlug {
				knownBP = true
				break
			}
		}
		if !knownBP {
			return persistedRoute{}, nil, fmt.Errorf("router returned unknown blueprint slug %q", route.InternalBlueprintSlug)
		}
	}
	// Build the user-facing recommendation cards from the validated slugs (max 3:
	// 1 primary + ≤2 alternatives). The router returns them ordered by relevance.
	cards := make([]recommendationCard, 0, len(out.ExistingApplicationSlugs))
	for i, slug := range out.ExistingApplicationSlugs {
		app := appsBySlug[slug]
		if app == nil {
			continue
		}
		cards = append(cards, recommendationCard{
			ApplicationID: app.ID,
			Slug:          app.Slug,
			Name:          app.Name,
			AppType:       app.Type,
			MatchReason:   out.UserFacingReason,
			Status:        string(app.Status),
			RuntimeURL:    app.RuntimeURL,
			Primary:       i == 0,
		})
	}
	return route, cards, nil
}

// persistRouteRecord stores the route record (with the hidden blueprint slug) in
// DraftJSON, sets the intent, and (when lock) marks the route chosen. It emits
// dialogue.intent.updated with the REDACTED route payload.
func (s *Server) persistRouteRecord(ctx context.Context, id string, route persistedRoute, status model.DialogueStatus, lock bool) error {
	routeBytes, _ := json.Marshal(route)
	if err := s.store.UpdateDialogueRoute(ctx, id, model.DialogueIntent(route.Intent), status, string(routeBytes), lock); err != nil {
		return err
	}
	return nil
}

// persistRouteRecordUnlocked stores the route record into DraftJSON but keeps
// the session intent at "routing" — the intent column is only stamped when the
// user explicitly locks a route via POST .../route. This is the pre-lock state:
// the route recommendation is visible (in the view's Route field) but the
// dialogue is still re-routable.
func (s *Server) persistRouteRecordUnlocked(ctx context.Context, id string, route persistedRoute) error {
	routeBytes, _ := json.Marshal(route)
	return s.store.UpdateDialogueRoute(ctx, id, model.DialogueIntentRouting, model.DialogueStatusRouting, string(routeBytes), false)
}

// composeDialogueView builds the full DialogueView for a session id. It reads
// the parent, messages, parses DraftJSON, and enriches with the child
// clarification + linked results as applicable. Every field is redacted
// (internalBlueprintSlug never appears in Route).
func (s *Server) composeDialogueView(ctx context.Context, id string) (*dialogueView, error) {
	dlg, err := s.store.GetDialogueSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if dlg == nil {
		return nil, errDialogueNotFound
	}
	msgs, err := s.store.LatestDialogueMessages(ctx, id, 100)
	if err != nil {
		return nil, err
	}
	view := &dialogueView{Session: *dlg, Messages: msgs}
	// The embedded Session.DraftJSON carries the raw route record INCLUDING the
	// hidden internalBlueprintSlug. It is parsed below to build the redacted
	// Route payload, then BLANKED so it can never leak into a JSON response.
	rawDraft := dlg.DraftJSON
	view.Session.DraftJSON = ""
	if rawDraft != "" {
		var route persistedRoute
		if json.Unmarshal([]byte(rawDraft), &route) == nil {
			view.Route = route.public()
			// Rebuild recommendation cards for an existing-application route that
			// is recommending.
			if route.Intent == dialogue.IntentExistingApplication {
				view.Recommendations = s.cardsFromRoute(ctx, route)
			}
		}
	}
	// Child clarification view when linked.
	if dlg.ClarificationSessionID != "" {
		child, err := s.store.GetClarificationSession(ctx, dlg.ClarificationSessionID)
		if err == nil && child != nil {
			cv := s.viewFromSession(child)
			view.Child = &cv
		}
	}
	// Linked results.
	if dlg.ResolvedApplicationID != "" {
		app, err := s.store.GetApplication(ctx, dlg.ResolvedApplicationID)
		if err == nil && app != nil {
			view.ResolvedApplication = app
		}
	}
	if dlg.CreatedAgentID != "" {
		agent, err := s.store.GetAgent(ctx, dlg.CreatedAgentID)
		if err == nil && agent != nil {
			view.CreatedAgent = agent
		}
	}
	// Business-agent draft: surface the in-progress agentDraft from the latest
	// business_draft message so the portal can render the confirm card.
	if dlg.Status == model.DialogueStatusDraftingBusinessAgent {
		record := s.latestAgentDraftRecord(ctx, id)
		view.AgentDraft = record.AgentDraft
		view.AgentDraftStatus = record.Status
		view.AgentConsolidation = s.latestBusinessConsolidation(ctx, id)
	}
	// Seeded job for an application-generation dialogue, including its continuing
	// task_running/active phases.
	if dlg.Intent == model.DialogueIntentApplicationGeneration {
		view.SeededJob = s.findJobForDialogue(ctx, dlg)
	}
	return view, nil
}

// cardsFromRoute rebuilds the recommendation cards from the persisted route +
// the current app store state (so runtime URLs/status are fresh).
func (s *Server) cardsFromRoute(ctx context.Context, route persistedRoute) []recommendationCard {
	cards := make([]recommendationCard, 0, len(route.ExistingApplicationSlugs))
	for i, slug := range route.ExistingApplicationSlugs {
		apps, err := s.store.ListApplications(ctx)
		if err != nil {
			break
		}
		for j := range apps {
			if apps[j].Slug != slug {
				continue
			}
			app := apps[j]
			cards = append(cards, recommendationCard{
				ApplicationID: app.ID,
				Slug:          app.Slug,
				Name:          app.Name,
				AppType:       app.Type,
				MatchReason:   route.UserFacingReason,
				Status:        string(app.Status),
				RuntimeURL:    app.RuntimeURL,
				Primary:       i == 0,
			})
			break
		}
	}
	return cards
}

// latestAgentDraft decodes the most recent business_draft message's agentDraft.
func (s *Server) latestAgentDraft(ctx context.Context, dialogueID string) dialogue.BusinessAgentDraft {
	return s.latestAgentDraftRecord(ctx, dialogueID).AgentDraft
}

func (s *Server) latestAgentDraftRecord(ctx context.Context, dialogueID string) businessDraftRecord {
	msgs, err := s.store.LatestDialogueMessages(ctx, dialogueID, 100)
	if err != nil {
		return businessDraftRecord{}
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m.Kind == "business_draft" && m.MetadataJSON != "" {
			var record businessDraftRecord
			if json.Unmarshal([]byte(m.MetadataJSON), &record) == nil && (record.Status != "" || businessDraftHasContent(record.AgentDraft)) {
				return record
			}
			var draft dialogue.BusinessAgentDraft
			if json.Unmarshal([]byte(m.MetadataJSON), &draft) == nil {
				return businessDraftRecord{AgentDraft: draft}
			}
		}
	}
	return businessDraftRecord{}
}

func businessDraftHasContent(draft dialogue.BusinessAgentDraft) bool {
	return strings.TrimSpace(draft.Name) != "" ||
		strings.TrimSpace(draft.Description) != "" ||
		strings.TrimSpace(draft.Prompt) != ""
}

func businessDraftComplete(draft dialogue.BusinessAgentDraft) bool {
	return strings.TrimSpace(draft.Name) != "" &&
		strings.TrimSpace(draft.Description) != "" &&
		strings.TrimSpace(draft.Prompt) != ""
}

func (s *Server) latestBusinessConsolidation(ctx context.Context, dialogueID string) []dialogue.ConsolidationEntry {
	msgs, err := s.store.LatestDialogueMessages(ctx, dialogueID, 100)
	if err != nil {
		return nil
	}
	start := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			start = i + 1
			break
		}
	}
	for i := len(msgs) - 1; i >= start; i-- {
		m := msgs[i]
		if m.Kind == "recommendation_consolidation" && m.MetadataJSON != "" {
			var entries []dialogue.ConsolidationEntry
			if json.Unmarshal([]byte(m.MetadataJSON), &entries) == nil {
				return entries
			}
		}
	}
	return nil
}

func applyBusinessConsolidationAdjustment(current dialogue.BusinessAgentDraft, entries []dialogue.ConsolidationEntry, selectedField, selectedValue string) (dialogue.BusinessAgentDraft, error) {
	if len(entries) == 0 {
		return dialogue.BusinessAgentDraft{}, errors.New("empty consolidation")
	}
	selected := normalizeBusinessDraftField(selectedField)
	if strings.TrimSpace(selectedField) != "" && selected == "" {
		return dialogue.BusinessAgentDraft{}, fmt.Errorf("unsupported field %q", selectedField)
	}
	out := current
	seenSelected := selected == ""
	for _, entry := range entries {
		field := normalizeBusinessDraftField(entry.Field)
		if field == "" {
			return dialogue.BusinessAgentDraft{}, fmt.Errorf("unsupported field %q", entry.Field)
		}
		value := rawConsolidationString(entry.RecommendedValue)
		if selected != "" && field == selected {
			value = strings.TrimSpace(selectedValue)
			seenSelected = true
		}
		if value == "" {
			continue
		}
		switch field {
		case "name":
			out.Name = value
		case "description":
			out.Description = value
		case "prompt":
			out.Prompt = value
		}
	}
	if !seenSelected {
		return dialogue.BusinessAgentDraft{}, fmt.Errorf("selected field %q is not in consolidation", selectedField)
	}
	if !businessDraftComplete(out) {
		return dialogue.BusinessAgentDraft{}, errors.New("business draft remains incomplete after consolidation")
	}
	return out, nil
}

func normalizeBusinessDraftField(field string) string {
	f := strings.TrimSpace(field)
	f = strings.TrimPrefix(f, "agentDraft.")
	f = strings.TrimPrefix(f, "agent_draft.")
	switch f {
	case "name", "description", "prompt":
		return f
	default:
		return ""
	}
}

func rawConsolidationString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strings.TrimSpace(s)
	}
	return strings.TrimSpace(string(raw))
}

// findJobForDialogue locates the job seeded from this dialogue's child
// clarification (linked via ClarificationSessionID). Returns nil if not found.
func (s *Server) findJobForDialogue(ctx context.Context, dlg *model.DialogueSession) *model.Job {
	if dlg.ClarificationSessionID == "" {
		return nil
	}
	child, err := s.store.GetClarificationSession(ctx, dlg.ClarificationSessionID)
	if err != nil || child == nil || child.CreatedJobID == "" {
		return nil
	}
	job, err := s.store.GetJob(ctx, child.CreatedJobID)
	if err != nil {
		return nil
	}
	return job
}

var errDialogueNotFound = errors.New("dialogue not found")

// ---- handlers -------------------------------------------------------------

// createDialogue handles POST /api/dialogues. It persists the first user
// message, emits dialogue.created, builds routing candidates, invokes intent
// routing, validates every returned slug, persists a structured route record,
// emits dialogue.intent.updated (redacted), and returns the view.
func (s *Server) createDialogue(w http.ResponseWriter, r *http.Request) {
	var body createDialogueBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		writeError(w, http.StatusBadRequest, "missing prompt")
		return
	}
	ctx := r.Context()
	now := time.Now()
	id := "dlg_" + idpkg.New()
	dlg := model.DialogueSession{
		ID:            id,
		InitialPrompt: body.Prompt,
		Status:        model.DialogueStatusRouting,
		Intent:        model.DialogueIntentRouting,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.store.CreateDialogueSession(ctx, dlg); err != nil {
		writeError(w, http.StatusInternalServerError, "create dialogue")
		return
	}
	promptMsg := model.DialogueMessage{
		ID: "dmsg_" + idpkg.New(), DialogueID: id, Role: "user", Kind: "prompt",
		Content: body.Prompt, CreatedAt: now,
	}
	if err := s.store.AppendDialogueMessage(ctx, promptMsg); err != nil {
		writeError(w, http.StatusInternalServerError, "persist prompt")
		return
	}
	s.publishDialogueSimple("dialogue.created", id, dlg)

	// Run pre-lock routing.
	msgs := []model.DialogueMessage{promptMsg}
	route, _, rerr := s.runRouting(ctx, &dlg, body.Prompt, msgs)
	if rerr != nil {
		// Routing failed: mark the dialogue failed (no route persisted). A
		// diagnosable session state remains.
		_ = s.store.UpdateDialogueStatus(ctx, id, model.DialogueStatusFailed, "route_failed", rerr.Error())
		view, _ := s.composeDialogueView(ctx, id)
		if view == nil {
			view = &dialogueView{Session: dlg, Messages: msgs}
		}
		writeJSON(w, http.StatusCreated, view)
		return
	}
	if err := s.persistRouteRecordUnlocked(ctx, id, route); err != nil {
		writeError(w, http.StatusInternalServerError, "persist route")
		return
	}
	// Re-read so the view reflects the persisted route.
	updated, _ := s.store.GetDialogueSession(ctx, id)
	if updated != nil {
		dlg = *updated
	}
	// Emit redacted intent.updated (project the route before publishing).
	s.publishDialogueSimple("dialogue.intent.updated", id, route.public())

	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

// listDialogues handles GET /api/dialogues.
func (s *Server) listDialogues(w http.ResponseWriter, r *http.Request) {
	limit := 50
	sessions, err := s.store.ListDialogueSessions(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list dialogues")
		return
	}
	out := make([]dialogueView, 0, len(sessions))
	for i := range sessions {
		view, err := s.composeDialogueView(r.Context(), sessions[i].ID)
		if err != nil || view == nil {
			continue
		}
		out = append(out, *view)
	}
	writeJSON(w, http.StatusOK, out)
}

// getDialogue handles GET /api/dialogues/:id.
func (s *Server) getDialogue(w http.ResponseWriter, r *http.Request) {
	view, err := s.composeDialogueView(r.Context(), Param(r, "id"))
	if err != nil {
		if errors.Is(err, errDialogueNotFound) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// deleteDialogue handles DELETE /api/dialogues/:id. It refuses to delete a
// dialogue that is still actively drafting (the runner may still be appending).
func (s *Server) deleteDialogue(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// A drafting dialogue may still have a runner appending messages (round in
	// flight), so it cannot be safely deleted. routing/recommending/resolved/
	// failed/abandoned are all safe: the synchronous rounds have completed.
	if dlg.Status == model.DialogueStatusDraftingApplication || dlg.Status == model.DialogueStatusDraftingBusinessAgent {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "in-flight dialogue cannot be deleted", "status": dlg.Status})
		return
	}
	if err := s.store.DeleteDialogueSession(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "delete dialogue")
		return
	}
	s.publishDialogueSimple("dialogue.deleted", id, map[string]string{"id": id})
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": id})
}

// archiveDialogue handles POST /api/dialogues/:id/archive. It transitions a
// continuing dialogue into the archived phase so the workbench can shelve a
// finished conversation without deleting its audit trail (trace events,
// versions, deployments, and job records persist). It emits dialogue.archived.
// The call is idempotent: archiving an already-archived dialogue is a 200 no-op.
// Task 8 added the archived status in Task 2 but no route; this is that route.
func (s *Server) archiveDialogue(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// Idempotent: an already-archived dialogue stays archived and we still ack.
	if dlg.Status != model.DialogueStatusArchived {
		if err := s.store.UpdateDialogueStatus(r.Context(), id, model.DialogueStatusArchived, dlg.ErrorCode, dlg.ErrorMessage); err != nil {
			writeError(w, http.StatusInternalServerError, "archive dialogue")
			return
		}
		s.publishDialogueSimple("dialogue.archived", id, map[string]string{"id": id})
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "archived", "id": id})
}

// addDialogueMessage handles POST /api/dialogues/:id/messages.
//
// Pre-route (status=routing, route not locked): the message is the user refining
// their initial request before choosing a route, so the handler appends the
// message and re-runs the (synchronous) intent-routing procedure, returning the
// composed view — the legacy 200 contract preserved for the routing phase.
//
// Continuing session (status is one of the active/analyzing/... phases, i.e. the
// session route is already established and the dialogue stays open): the handler
// persists the user message + a pending dialogue_turn, signals the per-dialogue
// turn worker, and returns 202 Accepted {dialogueId, turnId, acceptedAt}. No
// model content travels in the response body — it flows via dialogue.* events.
// At most one turn runs per session; a later message while a turn is in-flight
// stays pending and is processed in order once the current turn ends.
func (s *Server) addDialogueMessage(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// A locked route that is still in a route/clarification/drafting phase (not
	// yet a continuing session) is mid-resolution and does not accept free
	// messages: the user must complete that flow (clarification answer /
	// business-agent continue) instead. This preserves the legacy 409 the 27
	// existing tests rely on for a locked-but-unresolved route.
	if dlg.RouteLocked && !model.IsContinuingDialogueStatus(dlg.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "route is locked; complete the active flow or create a new dialogue"})
		return
	}
	var body addDialogueMessageBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(body.Content) == "" {
		writeError(w, http.StatusBadRequest, "missing content")
		return
	}
	ctx := r.Context()
	now := time.Now()
	msg := model.DialogueMessage{
		ID: "dmsg_" + idpkg.New(), DialogueID: id, Role: "user", Kind: "message",
		Content: body.Content, CreatedAt: now,
	}
	if err := s.store.AppendDialogueMessage(ctx, msg); err != nil {
		writeError(w, http.StatusInternalServerError, "add message")
		return
	}

	// Continuing session: async turn contract (202). Route is already
	// established, so this message is a follow-up turn, not a re-route.
	if model.IsContinuingDialogueStatus(dlg.Status) {
		turnID := "dturn_" + idpkg.New()
		turn := model.DialogueTurn{
			ID: turnID, DialogueID: id, MessageID: msg.ID,
			Intent: "", Status: model.TurnStatusPending, CreatedAt: now,
		}
		if err := s.store.CreateDialogueTurn(ctx, turn); err != nil {
			writeError(w, http.StatusInternalServerError, "create turn")
			return
		}
		s.publishDialogueSimple("dialogue.message.accepted", id, map[string]any{
			"turn_id":    turnID,
			"message_id": msg.ID,
		})
		if s.turnWorker != nil {
			s.turnWorker.Signal()
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"dialogueId": id,
			"turnId":     turnID,
			"acceptedAt": now.UTC().Format(time.RFC3339),
		})
		return
	}

	// Pre-route phase: synchronous re-routing (legacy 200 contract).
	allMsgs, _ := s.store.LatestDialogueMessages(ctx, id, 100)
	route, _, rerr := s.runRouting(ctx, dlg, body.Content, allMsgs)
	if rerr != nil {
		_ = s.store.UpdateDialogueStatus(ctx, id, model.DialogueStatusFailed, "route_failed", rerr.Error())
		view, _ := s.composeDialogueView(ctx, id)
		writeJSON(w, http.StatusOK, view)
		return
	}
	_ = s.persistRouteRecordUnlocked(ctx, id, route)
	s.publishDialogueSimple("dialogue.intent.updated", id, route.public())
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// cancelDialogueTurn handles POST /api/dialogues/:id/turns/:turnId/cancel. It
// verifies the turn belongs to the dialogue and is currently running, flips it
// to canceled via the store, emits dialogue.turn.canceled, and — critically —
// invokes the in-flight round's cancel func (via the turn worker) so the
// running model round actually aborts. This is the end-to-end cancel: the turn
// becomes terminal before the next pending turn begins, rather than relying on
// the row-flip alone. Returns 202 Accepted (the cancel is accepted; the worker
// finalizes the terminal transition asynchronously). Mirrors the executor's
// cancelJob handler style.
func (s *Server) cancelDialogueTurn(w http.ResponseWriter, r *http.Request) {
	dialogueID := Param(r, "id")
	turnID := Param(r, "turnId")
	ctx := r.Context()
	turn, err := s.store.GetDialogueTurn(ctx, turnID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get turn")
		return
	}
	if turn == nil || turn.DialogueID != dialogueID {
		writeError(w, http.StatusNotFound, "turn not found")
		return
	}
	if turn.Status != model.TurnStatusRunning {
		// Already terminal (or still pending): nothing to cancel. Idempotent
		// re-cancel of a terminal turn is a no-op success so a client retry does
		// not get a spurious error.
		writeJSON(w, http.StatusOK, map[string]any{"turnId": turnID, "status": string(turn.Status)})
		return
	}
	canceledID, err := s.store.CancelRunningDialogueTurn(ctx, dialogueID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cancel turn")
		return
	}
	// Kill the in-flight model round so it aborts (only the turn that is
	// actively running in the worker is interrupted). If the worker had already
	// moved on (race) canceledID is "" — the turn was terminalized by the row
	// flip alone and no cancel func applies.
	if s.turnWorker != nil {
		s.turnWorker.CancelRunningTurn(turnID)
	}
	s.publishDialogueSimple("dialogue.turn.canceled", dialogueID, map[string]any{
		"turn_id": turnID,
	})
	// Re-signal the worker so it drains the next pending turn for this dialogue
	// now that the running turn is terminal.
	if s.turnWorker != nil {
		s.turnWorker.Signal()
	}
	_ = canceledID
	writeJSON(w, http.StatusAccepted, map[string]any{"turnId": turnID, "status": string(model.TurnStatusCanceled)})
}

// confirmDialogueChange creates a revision job from the latest completed
// application-modification turn. The browser supplies no application id,
// version id, requirement, or prompt: all four are derived from durable server
// records so a confirmation cannot revise a different application lineage.
func (s *Server) confirmDialogueChange(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	dialogueID := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(ctx, dialogueID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil || dlg.Status != model.DialogueStatusChangeConfirmation {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "no change awaiting confirmation"})
		return
	}
	if dlg.ResolvedApplicationID == "" {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "initial application is not ready"})
		return
	}
	turn, err := s.store.GetLatestCompletedDialogueTurnByIntent(ctx, dialogueID, model.TurnIntentApplicationModification)
	if err != nil || turn == nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "change proposal not found"})
		return
	}
	app, err := s.store.GetApplication(ctx, dlg.ResolvedApplicationID)
	if err != nil || app == nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "linked application not found"})
		return
	}
	base, err := s.store.GetEffectiveApplicationVersion(ctx, app.ID)
	if err != nil || base == nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "no effective application version"})
		return
	}
	source, err := s.store.GetLatestJobForApplication(ctx, app.ID)
	if err != nil || source == nil || source.ConfirmedRequirementJSON == "" {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "confirmed requirement unavailable"})
		return
	}
	var summary dialogue.TurnSummary
	_ = json.Unmarshal([]byte(turn.SummaryJSON), &summary)
	prompt := strings.TrimSpace(summary.ChangeDescription)
	if prompt == "" {
		prompt = "修改应用"
	}
	now := time.Now()
	jobID := "job_" + idpkg.New()
	versionID := "ver_" + idpkg.New()
	job := model.Job{
		ID: jobID, UserPrompt: prompt, AppName: app.Name, AppSlug: app.Slug,
		Status: model.JobStatusQueued, CurrentStepKind: model.StepRequirementAnalysis,
		ConfirmedRequirementJSON: source.ConfirmedRequirementJSON, DialogueID: dialogueID,
		ApplicationID: app.ID, BaseVersionID: base.ID, Kind: "revise", CreatedAt: now, UpdatedAt: now,
	}
	steps := make([]model.JobStep, 0, len(stepPlan))
	for i, sp := range stepPlan {
		steps = append(steps, model.JobStep{ID: "step_" + idpkg.New(), JobID: jobID, Kind: sp.kind, Seq: i + 1, AgentKey: sp.agentKey, Status: model.StepStatusPending})
	}
	version := model.ApplicationVersion{
		ID: versionID, ApplicationID: app.ID, ParentVersionID: base.ID, JobID: jobID,
		Status: model.ApplicationVersionQueued, CreatedAt: now,
	}
	if err := s.store.SeedJobWithApplicationVersion(ctx, job, steps, version); err != nil {
		writeError(w, http.StatusInternalServerError, "seed revision job")
		return
	}
	_ = s.store.UpdateDialogueStatus(ctx, dialogueID, model.DialogueStatusTaskRunning, "", "")
	s.publishDialogueSimple("dialogue.change.confirmed", dialogueID, map[string]any{"turn_id": turn.ID, "job_id": jobID, "base_version_id": base.ID})
	s.hub.Publish(Event{Type: "job.created", Data: job})
	s.exec.Signal()
	writeJSON(w, http.StatusAccepted, map[string]any{"jobId": jobID})
}

// forkDialogue creates a new dialogue draft seeded by a fork target prompt,
// originating from sourceDialogueID. It is the new_application turn side
// effect: the new dialogue starts in routing so it gets its own first-message
// route, and carries no messages of its own yet. Returns the new dialogue id.
func (s *Server) forkDialogue(ctx context.Context, sourceDialogueID, seedPrompt string) string {
	now := time.Now()
	newID := "dlg_" + idpkg.New()
	dlg := model.DialogueSession{
		ID:            newID,
		InitialPrompt: seedPrompt,
		Status:        model.DialogueStatusRouting,
		Intent:        model.DialogueIntentRouting,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.store.CreateDialogueSession(ctx, dlg); err != nil {
		return ""
	}
	return newID
}

// selectDialogueRoute handles POST /api/dialogues/:id/route. It persists the
// user's explicit selection and LOCKS the route (route_locked=true, never
// re-routable). The selection drives the next state:
//   - existing app → recommending + ≤3 candidate cards
//   - application generation → one child clarification (max_rounds=6) + round 1
//   - business agent → business drafting round 1
func (s *Server) selectDialogueRoute(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if dlg.RouteLocked {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "route is already locked"})
		return
	}
	var body selectDialogueRouteBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	intent := activeDialogueIntent(dialogue.Intent(body.Intent))
	if !dialogueValidIntent(string(intent)) {
		writeError(w, http.StatusBadRequest, "invalid intent")
		return
	}
	ctx := r.Context()

	// Parse the persisted route record so the lock carries the full record.
	var route persistedRoute
	if dlg.DraftJSON != "" {
		_ = json.Unmarshal([]byte(dlg.DraftJSON), &route)
	}
	route.Intent = intent
	if intent == dialogue.IntentExistingApplication && len(route.ExistingApplicationSlugs) == 0 {
		// A legacy or stale client can still choose reuse after the router found no
		// candidate. Do not lock the user into an empty recommendation view.
		intent = dialogue.IntentApplicationGeneration
		route.Intent = intent
		route.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的新应用。"
	}

	switch intent {
	case dialogue.IntentExistingApplication:
		// Enter recommending with the candidate cards derived from the route.
		if err := s.persistRouteRecord(ctx, id, route, model.DialogueStatusRecommending, true); err != nil {
			writeError(w, http.StatusInternalServerError, "persist route")
			return
		}
		cards := s.cardsFromRoute(ctx, route)
		if len(cards) > 3 {
			cards = cards[:3]
		}
		s.publishDialogueSimple("dialogue.application.recommended", id, cards)
		s.publishDialogueSimple("dialogue.route.confirmed", id, route.public())

	case dialogue.IntentApplicationGeneration:
		// Create exactly ONE child clarification (max_rounds=6). The hidden
		// blueprint ref is stored in the persisted route record server-side.
		childID := "clar_" + idpkg.New()
		childSess := model.ClarificationSession{
			ID: childID, Status: model.ClarificationStatusActive,
			InitialPrompt: dlg.InitialPrompt, Round: 0, MaxRounds: 6,
			RequirementJSON: "{}", CreatedAt: time.Now(), UpdatedAt: time.Now(),
		}
		if err := s.store.CreateClarificationSession(ctx, childSess); err != nil {
			writeError(w, http.StatusInternalServerError, "create child clarification")
			return
		}
		// Link child to parent + run round 1.
		if err := s.linkDialogueChild(ctx, id, childID); err != nil {
			writeError(w, http.StatusInternalServerError, "link child")
			return
		}
		route.Intent = intent
		routeBytes, _ := json.Marshal(route)
		if err := s.store.UpdateDialogueRoute(ctx, id, model.DialogueIntentApplicationGeneration, model.DialogueStatusDraftingApplication, string(routeBytes), true); err != nil {
			writeError(w, http.StatusInternalServerError, "lock route")
			return
		}
		s.runRoundAndPersist(ctx, childID, 1)
		s.publishDialogueSimple("dialogue.route.confirmed", id, route.public())

	case dialogue.IntentBusinessProcessingAgent:
		routeBytes, _ := json.Marshal(route)
		if err := s.store.UpdateDialogueRoute(ctx, id, model.DialogueIntentBusinessProcessingAgent, model.DialogueStatusDraftingBusinessAgent, string(routeBytes), true); err != nil {
			writeError(w, http.StatusInternalServerError, "lock route")
			return
		}
		// Start business drafting round 1.
		if rerr := s.runBusinessDraftRound(ctx, id, dlg, 1); rerr != nil {
			writeError(w, http.StatusInternalServerError, "draft round")
			return
		}
		s.publishDialogueSimple("dialogue.route.confirmed", id, route.public())
	}

	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// linkDialogueChild records the child clarification id on the parent session.
// It uses a direct UPDATE so the child is linked before round 1 runs (the
// generic UpdateDialogueRoute would clobber the draft).
func (s *Server) linkDialogueChild(ctx context.Context, dialogueID, childID string) error {
	// Reuse UpdateDialogueStatus-like behavior by reading + rewriting via a
	// targeted route update that preserves intent/status while stamping the link.
	// The store has no dedicated link setter, so we update the clarification id
	// column directly.
	return s.store.SetDialogueClarificationID(ctx, dialogueID, childID)
}

// runBusinessDraftRound runs one business-agent drafting round for a dialogue,
// persists the agentDraft as a business_draft message, and emits
// dialogue.agent_draft.updated.
func (s *Server) runBusinessDraftRound(ctx context.Context, dialogueID string, dlg *model.DialogueSession, round int) error {
	msgs, _ := s.store.LatestDialogueMessages(ctx, dialogueID, 100)
	currentDraft := s.latestAgentDraft(ctx, dialogueID)
	// UserMessage focuses the model on the LATEST user turn (the refinement being
	// answered), falling back to the initial prompt. The full history still
	// travels in Messages.
	userMessage := dlg.InitialPrompt
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" && strings.TrimSpace(msgs[i].Content) != "" {
			userMessage = msgs[i].Content
			break
		}
	}
	input := dialogue.BusinessDraftInput{
		DialogueID:       dialogueID,
		Round:            round,
		MaxRounds:        6,
		UserMessage:      userMessage,
		Messages:         messageViews(msgs),
		CurrentDraft:     currentDraft,
		CurrentQuestions: nil,
	}
	out, err := s.dialogueRouter.RunBusinessDraftRound(ctx, input, s.publishDialogueEvent)
	if err != nil {
		return err
	}
	// Persist work-log + questions + consolidation + agentDraft as messages.
	now := time.Now()
	for _, wl := range out.WorkLog {
		_ = s.store.AppendDialogueMessage(ctx, model.DialogueMessage{
			ID: "dmsg_" + idpkg.New(), DialogueID: dialogueID, Role: "agent", Kind: "analysis_work_log",
			Content: wl.Content, CreatedAt: now,
		})
	}
	for _, q := range out.Questions {
		qBytes, _ := json.Marshal(q)
		_ = s.store.AppendDialogueMessage(ctx, model.DialogueMessage{
			ID: "dmsg_" + idpkg.New(), DialogueID: dialogueID, Role: "agent", Kind: "question",
			MetadataJSON: string(qBytes), CreatedAt: now,
		})
		s.publishDialogueSimple("dialogue.draft.question.created", dialogueID, q)
	}
	if len(out.Consolidation) > 0 {
		cBytes, _ := json.Marshal(out.Consolidation)
		_ = s.store.AppendDialogueMessage(ctx, model.DialogueMessage{
			ID: "dmsg_" + idpkg.New(), DialogueID: dialogueID, Role: "agent", Kind: "recommendation_consolidation",
			MetadataJSON: string(cBytes), CreatedAt: now,
		})
		s.publishDialogueSimple("dialogue.draft.consolidation.updated", dialogueID, out.Consolidation)
	}
	if businessDraftHasContent(out.AgentDraft) || out.Status != "" {
		draftBytes, _ := json.Marshal(businessDraftRecord{
			Status:     out.Status,
			Round:      out.Round,
			AgentDraft: out.AgentDraft,
		})
		_ = s.store.AppendDialogueMessage(ctx, model.DialogueMessage{
			ID: "dmsg_" + idpkg.New(), DialogueID: dialogueID, Role: "agent", Kind: "business_draft",
			MetadataJSON: string(draftBytes), CreatedAt: now,
		})
		if businessDraftHasContent(out.AgentDraft) {
			s.publishDialogueSimple("dialogue.agent_draft.updated", dialogueID, out.AgentDraft)
		}
	}
	return nil
}

// openDialogueApp handles POST /api/dialogues/:id/applications/:applicationID/open.
// It verifies the candidate belongs to the persisted recommendation, locks the
// route, and if the app is stopped uses startAppInternal. It returns the
// refreshed application ONLY after it has a usable runtime URL, then persists
// the app id + emits dialogue.resolved.
func (s *Server) openDialogueApp(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	appID := Param(r, "applicationID")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// Verify the candidate belongs to the persisted recommendation.
	var route persistedRoute
	if dlg.DraftJSON != "" {
		_ = json.Unmarshal([]byte(dlg.DraftJSON), &route)
	}
	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil || app == nil {
		writeError(w, http.StatusNotFound, "application not found")
		return
	}
	if !slugInRecommendation(route, app.Slug) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "application is not in the persisted recommendation"})
		return
	}
	// Lock the route now (open is an execute action).
	if !dlg.RouteLocked {
		route.Intent = dialogue.IntentExistingApplication
		routeBytes, _ := json.Marshal(route)
		_ = s.store.UpdateDialogueRoute(r.Context(), id, model.DialogueIntentExistingApplication, model.DialogueStatusRecommending, string(routeBytes), true)
	}

	// Per-app mutual exclusion.
	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	ctx := r.Context()
	// If the app is stopped (no usable URL), start it via the shared operation.
	if app.RuntimeURL == "" {
		if _, refreshed, serr := s.startAppInternal(ctx, appID); serr != nil {
			if er, ok := serr.(errResponse); ok {
				er.write(w)
				return
			}
			writeError(w, http.StatusInternalServerError, "start app")
			return
		} else if refreshed != nil {
			app = refreshed
		}
	}
	// Re-read to get the usable runtime URL.
	app, err = s.store.GetApplication(ctx, appID)
	if err != nil || app == nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app.RuntimeURL == "" {
		writeError(w, http.StatusServiceUnavailable, "app has no usable runtime url")
		return
	}
	// Persist the app id + resolve the dialogue.
	if err := s.store.SetDialogueResolved(ctx, id, appID, ""); err != nil {
		writeError(w, http.StatusInternalServerError, "resolve dialogue")
		return
	}
	s.publishDialogueSimple("dialogue.resolved", id, map[string]any{
		"resolved_application_id": appID,
		"runtime_url":             app.RuntimeURL,
	})
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func slugInRecommendation(route persistedRoute, slug string) bool {
	for _, s := range route.ExistingApplicationSlugs {
		if s == slug {
			return true
		}
	}
	return false
}

// ---- clarification facade handlers ----------------------------------------

// resolveChildView loads the parent + child and returns the parent's composed
// view for the clarification facade handlers. It fails if no child is linked.
func (s *Server) requireDialogueChild(ctx context.Context, id string) (*model.DialogueSession, string, *clarificationView, bool, *dialogueView) {
	dlg, err := s.store.GetDialogueSession(ctx, id)
	if err != nil || dlg == nil {
		return nil, "", nil, false, nil
	}
	if dlg.ClarificationSessionID == "" {
		return dlg, "", nil, false, nil
	}
	child, _ := s.store.GetClarificationSession(ctx, dlg.ClarificationSessionID)
	if child == nil {
		return dlg, "", nil, false, nil
	}
	cv := s.viewFromSession(child)
	view, _ := s.composeDialogueView(ctx, id)
	return dlg, dlg.ClarificationSessionID, &cv, true, view
}

// answerDialogueClarification handles POST /api/dialogues/:id/clarification/answers.
// It delegates to the child clarification via the existing service helpers.
func (s *Server) answerDialogueClarification(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	_, childID, _, ok, _ := s.requireDialogueChild(r.Context(), id)
	if !ok {
		writeError(w, http.StatusConflict, "dialogue has no active clarification child")
		return
	}
	var body dialogueAnswerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.QuestionID == "" {
		writeError(w, http.StatusBadRequest, "missing questionId")
		return
	}
	ctx := r.Context()
	sess, _ := s.store.GetClarificationSession(ctx, childID)
	if sess == nil {
		writeError(w, http.StatusNotFound, "child not found")
		return
	}
	if clarificationStatusRejectsAnswers(sess.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session does not accept answers", "status": sess.Status})
		return
	}
	req := s.parseRequirement(sess.RequirementJSON)
	if err := s.persistClarificationAnswer(ctx, childID, clarificationAnswerBody{QuestionID: body.QuestionID, Value: body.Value}, &req); err != nil {
		writeError(w, http.StatusInternalServerError, "add answer message")
		return
	}
	reqBytes, _ := json.Marshal(req)
	_ = s.store.UpdateClarificationRequirement(ctx, childID, string(reqBytes))
	updated, _ := s.store.GetClarificationSession(ctx, childID)
	s.publishDialogueChild(ctx, id, childID, req)
	advanced, _ := s.advanceAfterUserTurn(ctx, childID, updated)
	_ = advanced
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// answerDialogueClarificationBatch handles POST /api/dialogues/:id/clarification/answers/batch.
// It also implements the round-6 consolidation adjust: when consolidationField
// is present, ApplyConsolidationAdjustment merges the persisted consolidation
// with the user's single-field override (NO model turn) and marks ready_to_confirm.
func (s *Server) answerDialogueClarificationBatch(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, childID, cv, ok, _ := s.requireDialogueChild(r.Context(), id)
	if !ok {
		writeError(w, http.StatusConflict, "dialogue has no active clarification child")
		return
	}
	var body dialogueBatchAnswersBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	ctx := r.Context()
	sess, _ := s.store.GetClarificationSession(ctx, childID)
	if sess == nil {
		writeError(w, http.StatusNotFound, "child not found")
		return
	}

	// Round-5/6 consolidation path (no model turn). consolidationAccept selects
	// accept-all (ApplyConsolidationAdjustment with an empty selectedField merges
	// every persisted recommendation); a non-empty consolidationField selects the
	// single-field round-6 override. Either way the result is validated complete
	// and marked ready_to_confirm.
	if body.ConsolidationAccept || body.ConsolidationField != "" {
		consolidation := s.loadChildConsolidation(ctx, childID)
		if len(consolidation) == 0 {
			writeError(w, http.StatusConflict, "no consolidation list for round 6")
			return
		}
		current := s.parseRequirement(sess.RequirementJSON)
		adjusted, aerr := clarification.ApplyConsolidationAdjustment(current, consolidation, body.ConsolidationField, body.ConsolidationValue)
		if aerr != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "consolidation adjust failed", "detail": aerr.Error()})
			return
		}
		adjustedBytes, _ := json.Marshal(adjusted)
		_ = s.store.UpdateClarificationRequirement(ctx, childID, string(adjustedBytes))
		_ = s.store.SetClarificationStatus(ctx, childID, model.ClarificationStatusReadyToConfirm, "", "")
		s.publishDialogueChild(ctx, id, childID, adjusted)
		_ = dlg
		_ = cv
		view, err := s.composeDialogueView(ctx, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "compose view")
			return
		}
		writeJSON(w, http.StatusOK, view)
		return
	}

	// Normal batch-answer path.
	if clarificationStatusRejectsAnswers(sess.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session does not accept answers", "status": sess.Status})
		return
	}
	if len(body.Answers) == 0 {
		writeError(w, http.StatusBadRequest, "missing answers")
		return
	}
	for _, answer := range body.Answers {
		if answer.QuestionID == "" {
			writeError(w, http.StatusBadRequest, "missing questionId")
			return
		}
	}
	req := s.parseRequirement(sess.RequirementJSON)
	for _, answer := range body.Answers {
		if err := s.persistClarificationAnswer(ctx, childID, clarificationAnswerBody{QuestionID: answer.QuestionID, Value: answer.Value}, &req); err != nil {
			writeError(w, http.StatusInternalServerError, "add answer message")
			return
		}
	}
	reqBytes, _ := json.Marshal(req)
	_ = s.store.UpdateClarificationRequirement(ctx, childID, string(reqBytes))
	updated, _ := s.store.GetClarificationSession(ctx, childID)
	s.publishDialogueChild(ctx, id, childID, req)
	advanced, _ := s.advanceAfterUserTurn(ctx, childID, updated)
	_ = advanced
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// loadChildConsolidation reads the most recent recommendation_consolidation
// message from the child clarification thread and decodes its consolidation list.
func (s *Server) loadChildConsolidation(ctx context.Context, childID string) []clarification.ConsolidationEntry {
	msgs, err := s.store.ListClarificationMessages(ctx, childID)
	if err != nil {
		return nil
	}
	start := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			start = i + 1
			break
		}
	}
	for i := len(msgs) - 1; i >= start; i-- {
		m := msgs[i]
		if m.Kind == "recommendation_consolidation" && m.MetadataJSON != "" {
			var entries []clarification.ConsolidationEntry
			if json.Unmarshal([]byte(m.MetadataJSON), &entries) == nil {
				return entries
			}
		}
	}
	return nil
}

// publishDialogueChild wraps a child clarification update with the parent
// dialogue id so the portal updates one state source.
func (s *Server) publishDialogueChild(ctx context.Context, dialogueID, childID string, req clarification.Requirement) {
	s.publishClarificationEvent(clarification.StreamEvent{
		Type: "clarification.summary.updated", SessionID: childID, Data: clarification.PublicRequirement(req),
	})
	s.publishDialogueSimple("dialogue.clarification.updated", dialogueID, map[string]any{
		"child_id": childID,
	})
}

// patchDialogueRequirement handles PATCH /api/dialogues/:id/clarification/requirement.
// It delegates to the child clarification requirement patch service helper.
func (s *Server) patchDialogueRequirement(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	_, childID, _, ok, _ := s.requireDialogueChild(r.Context(), id)
	if !ok {
		writeError(w, http.StatusConflict, "dialogue has no active clarification child")
		return
	}
	var body dialoguePatchRequirementBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(body.Requirement) == 0 {
		writeError(w, http.StatusBadRequest, "missing requirement")
		return
	}
	ctx := r.Context()
	sess, _ := s.store.GetClarificationSession(ctx, childID)
	if sess == nil {
		writeError(w, http.StatusNotFound, "child not found")
		return
	}
	if isTerminalClarificationStatus(sess.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session is terminal", "status": sess.Status})
		return
	}
	var incoming clarification.Requirement
	if err := json.Unmarshal(body.Requirement, &incoming); err != nil {
		writeError(w, http.StatusBadRequest, "invalid requirement json")
		return
	}
	if len(incoming.GenerationProfile) > 0 {
		writeError(w, http.StatusBadRequest, "generationProfile is server-derived and cannot be set by the client")
		return
	}
	if !blueprintRefsAllSafe(incoming.BlueprintRefs) {
		writeError(w, http.StatusBadRequest, "invalid blueprintRef slug")
		return
	}
	current := s.parseRequirement(sess.RequirementJSON)
	current.AppType = incoming.AppType
	current.AppName = incoming.AppName
	current.TargetUsers = incoming.TargetUsers
	current.CoreScenario = incoming.CoreScenario
	current.PrimaryView = incoming.PrimaryView
	current.MainEntities = incoming.MainEntities
	current.DataPolicy = incoming.DataPolicy
	current.AcceptanceFocus = incoming.AcceptanceFocus
	current.BlueprintRefs = s.sanitizeBlueprintRefs(incoming.BlueprintRefs)
	current.GenerationProfile = recomputeGenerationProfile(current)
	reqBytes, _ := json.Marshal(current)
	_ = s.store.UpdateClarificationRequirement(ctx, childID, string(reqBytes))
	s.publishDialogueChild(ctx, id, childID, current)
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// retryDialogueClarificationRound handles POST /api/dialogues/:id/clarification/retry-current-round.
func (s *Server) retryDialogueClarificationRound(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	_, childID, _, ok, _ := s.requireDialogueChild(r.Context(), id)
	if !ok {
		writeError(w, http.StatusConflict, "dialogue has no active clarification child")
		return
	}
	ctx := r.Context()
	sess, _ := s.store.GetClarificationSession(ctx, childID)
	if sess == nil {
		writeError(w, http.StatusNotFound, "child not found")
		return
	}
	if sess.Status != model.ClarificationStatusFailed {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session is not failed; retry-current-round only applies to failed sessions", "status": sess.Status})
		return
	}
	_ = s.store.SetClarificationStatus(ctx, childID, model.ClarificationStatusActive, "", "")
	retryRound := sess.Round
	if retryRound < 1 {
		retryRound = 1
	}
	s.runRoundAndPersist(ctx, childID, retryRound)
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// confirmDialogueClarification handles POST /api/dialogues/:id/clarification/confirm.
// It requires a complete Factory-validated requirement, allocates
// <normalizedScenarioName>-<Base36> (NEVER trusting client appName/slug/blueprint/serial),
// persists the frozen requirement, seeds the fixed 6-step job, links child +
// parent, and resolves the dialogue. A confirmation failure creates NO job and
// leaves a diagnosable session state.
func (s *Server) confirmDialogueClarification(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	_, childID, _, ok, _ := s.requireDialogueChild(r.Context(), id)
	if !ok {
		writeError(w, http.StatusConflict, "dialogue has no active clarification child")
		return
	}
	ctx := r.Context()
	sess, _ := s.store.GetClarificationSession(ctx, childID)
	if sess == nil {
		writeError(w, http.StatusNotFound, "child not found")
		return
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session not ready to confirm", "status": sess.Status})
		return
	}
	req := s.parseRequirement(sess.RequirementJSON)
	if !blueprintRefsAllSafe(req.BlueprintRefs) {
		writeError(w, http.StatusBadRequest, "invalid blueprintRef slug")
		return
	}
	req.BlueprintRefs = s.sanitizeBlueprintRefs(req.BlueprintRefs)
	req.GenerationProfile = recomputeGenerationProfile(req)
	if missing := missingRequiredFields(req); len(missing) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "confirmed requirement missing required fields", "missing": missing})
		return
	}
	// Persist the finalized requirement.
	reqBytes, _ := json.Marshal(req)
	_ = s.store.UpdateClarificationRequirement(ctx, childID, string(reqBytes))

	// Allocate the Factory-owned app name: <normalizedScenarioName>-<Base36>.
	// Never trust client appName/slug/blueprint/serial. The readable name keeps
	// the UPPERCASE serial (spec example: 航母编队航迹复盘-K7M2); the slug is the
	// lowercase, filesystem-safe derivation. Collision detection compares the
	// EXACT candidate slug (case-consistent), not an uppercase-suffix heuristic
	// that could never match the lowercased slug and so admit duplicates.
	normalizedName := normalizeScenarioName(req.AppName, req.CoreScenario, sess.InitialPrompt)
	suffix := idpkg.Base36Serial(func(cand string) bool {
		return s.appSlugTaken(ctx, normalizedName, req.AppType, cand)
	})
	factoryName := normalizedName + "-" + suffix
	factorySlug := factoryAppSlug(normalizedName, req.AppType, suffix)

	// Seed the fixed 6-step job, mirroring confirmClarification. The job carries
	// the CONFIRMED requirement + child session id. The job + steps + child link
	// are committed in a SINGLE transaction: on failure there is NO orphaned job
	// and the child is moved to a diagnosable failed state.
	now := time.Now()
	jobID := "job_" + idpkg.New()
	job := model.Job{
		ID:                       jobID,
		UserPrompt:               sess.InitialPrompt,
		AppName:                  factoryName,
		AppSlug:                  factorySlug,
		Status:                   model.JobStatusQueued,
		CurrentStepKind:          model.StepRequirementAnalysis,
		ClarificationSessionID:   childID,
		ConfirmedRequirementJSON: string(reqBytes),
		// DialogueID links the job to the dialogue its safe agent activity is
		// surfaced under (Task 4). It is the work_trace_events sequence-
		// partition key: the executor stamps it onto every trace the runner
		// produces, so the dialogue-scoped SSE stream can filter them.
		DialogueID: id,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	steps := make([]model.JobStep, 0, len(stepPlan))
	for i, sp := range stepPlan {
		steps = append(steps, model.JobStep{
			ID: "step_" + idpkg.New(), JobID: jobID, Kind: sp.kind, Seq: i + 1,
			AgentKey: sp.agentKey, Status: model.StepStatusPending, Attempt: 0,
		})
	}
	if err := s.store.SeedClarificationJob(ctx, job, steps, childID); err != nil {
		// Atomic rollback already discarded any half-seeded job/steps. Move the
		// child to a diagnosable failed state so the session is never left in
		// ready_to_confirm with no linked job.
		_ = s.store.SetClarificationStatus(ctx, childID, model.ClarificationStatusFailed, "job_seed_failed", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "seed job", "code": "job_seed_failed"})
		return
	}
	_ = s.store.SetClarificationStatus(ctx, childID, model.ClarificationStatusConfirmed, "", "")
	// Keep the parent interactive while its initial task runs. The application id
	// is filled atomically by SetJobCreatedApp once code generation registers it.
	// Marking this as task_running (rather than terminal resolved) makes follow-up
	// messages use the continuing-turn path immediately.
	if err := s.store.SetDialogueResolved(ctx, id, "", ""); err != nil {
		writeError(w, http.StatusInternalServerError, "resolve dialogue")
		return
	}
	if err := s.store.UpdateDialogueStatus(ctx, id, model.DialogueStatusTaskRunning, "", ""); err != nil {
		writeError(w, http.StatusInternalServerError, "set dialogue task running")
		return
	}
	s.hub.Publish(Event{Type: "job.created", Data: job})
	s.logEvent("job_queued", map[string]any{
		"job_id":                   job.ID,
		"app_name":                 job.AppName,
		"clarification_session_id": job.ClarificationSessionID,
		"source":                   "dialogue_confirm",
	})
	s.publishDialogueSimple("dialogue.task.running", id, map[string]any{
		"seeded_job_id": jobID,
		"app_name":      factoryName,
	})
	s.exec.Signal()

	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// abandonDialogue handles POST /api/dialogues/:id/clarification/abandon. It
// abandons the child clarification and the parent dialogue.
func (s *Server) abandonDialogue(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	_, childID, _, ok, _ := s.requireDialogueChild(r.Context(), id)
	ctx := r.Context()
	if ok {
		_ = s.store.SetClarificationStatus(ctx, childID, model.ClarificationStatusAbandoned, "", "")
	}
	_ = s.store.UpdateDialogueStatus(ctx, id, model.DialogueStatusAbandoned, "", "")
	s.publishDialogueSimple("dialogue.abandoned", id, map[string]string{"id": id})
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// confirmDialogueBusinessAgent handles POST /api/dialogues/:id/business-agent/confirm.
// It validates the current agentDraft, derives a unique internal key
// (id.Base36Serial), creates an enabled business_processing Agent with its
// prompt, links it to the dialogue, resolves, and emits audit-safe
// dialogue.agent.created. NO executor step / deployment / invocation is added.
func (s *Server) confirmDialogueBusinessAgent(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if dlg.Status != model.DialogueStatusDraftingBusinessAgent {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "dialogue is not in business-agent drafting", "status": dlg.Status})
		return
	}
	record := s.latestAgentDraftRecord(r.Context(), id)
	if !dialogue.IsReadyToConfirmStatus(record.Status) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "agent draft is not ready to confirm", "status": record.Status})
		return
	}
	draft := record.AgentDraft
	if !businessDraftComplete(draft) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "agent draft is incomplete; name, description, and prompt are required"})
		return
	}
	ctx := r.Context()
	// Derive a unique internal key from the normalized draft name plus a random
	// serial (spec). Never trust client/LLM keys. The name's ASCII contribution
	// anchors the key so two differently-named agents read distinctly; a pure
	// non-ASCII name falls back to the "biz" anchor. Collision detection matches
	// the exact candidate key.
	nameSlug := slugifyRaw(normalizeScenarioName(draft.Name, draft.Description, dlg.InitialPrompt))
	if nameSlug == "" {
		nameSlug = "biz"
	}
	serial := idpkg.Base36Serial(func(cand string) bool {
		return s.agentKeyTaken(ctx, nameSlug, cand)
	})
	agentKey := nameSlug + "-" + strings.ToLower(serial)
	agentID := agentIDFromKey(agentKey)
	existing, _ := s.store.ListAgents(ctx)
	sortOrder := 1
	for _, a := range existing {
		if a.SortOrder >= sortOrder {
			sortOrder = a.SortOrder + 1
		}
	}
	agent := model.Agent{
		ID: agentID, Key: agentKey, Name: draft.Name, Role: "business_processing",
		Description: draft.Description, ClaudeAgentName: agentKey,
		SkillsJSON: "[]", Category: model.AgentCategoryBusinessProcessing,
		Prompt: strings.TrimSpace(draft.Prompt), Enabled: true, SortOrder: sortOrder,
	}
	if err := s.store.CreateAgent(ctx, agent); err != nil {
		writeError(w, http.StatusInternalServerError, "create agent")
		return
	}
	if err := s.store.SetDialogueResolved(ctx, id, "", agentID); err != nil {
		writeError(w, http.StatusInternalServerError, "resolve dialogue")
		return
	}
	s.publishDialogueSimple("dialogue.agent.created", id, map[string]any{
		"agent_id": agentID, "agent_key": agentKey, "name": draft.Name,
	})
	s.publishDialogueSimple("dialogue.resolved", id, map[string]any{"created_agent_id": agentID})
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

type continueDialogueBusinessBody struct {
	Content string `json:"content"`
}

// continueDialogueBusinessAgent handles POST
// /api/dialogues/:id/business-agent/continue. It is the multi-round drafting
// loop closer (review P0 #4): a business route is locked, so /messages 409s and
// the draft's clarifying questions had no answer path. This endpoint appends the
// user's refinement/answer as a parent user message and re-runs the draft round,
// so rounds 1–4 questions are answerable and the draft converges. The six-round
// cap is enforced (no seventh model turn), mirroring the clarification MaxRounds
// invariant.
func (s *Server) continueDialogueBusinessAgent(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if dlg.Status != model.DialogueStatusDraftingBusinessAgent {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "dialogue is not in business-agent drafting", "status": dlg.Status})
		return
	}
	var body continueDialogueBusinessBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(body.Content) == "" {
		writeError(w, http.StatusBadRequest, "missing content")
		return
	}
	ctx := r.Context()
	// Six-round cap: the initial prompt is turn 1 (round 1 ran at route-lock).
	// Each continue is a new turn; refuse once six turns exist so there is no
	// seventh model round.
	msgs, _ := s.store.LatestDialogueMessages(ctx, id, 100)
	userTurns := 0
	for _, m := range msgs {
		if m.Role == "user" {
			userTurns++
		}
	}
	if userTurns >= 6 {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "business drafting reached the six-round cap", "rounds": userTurns})
		return
	}
	now := time.Now()
	if err := s.store.AppendDialogueMessage(ctx, model.DialogueMessage{
		ID: "dmsg_" + idpkg.New(), DialogueID: id, Role: "user", Kind: "message",
		Content: body.Content, CreatedAt: now,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "append message")
		return
	}
	// Re-read so runBusinessDraftRound sees the freshest session row.
	refreshed, _ := s.store.GetDialogueSession(ctx, id)
	if refreshed != nil {
		dlg = refreshed
	}
	if rerr := s.runBusinessDraftRound(ctx, id, dlg, userTurns+1); rerr != nil {
		// A failed round leaves a diagnosable state; the view still composes.
		_ = s.store.UpdateDialogueStatus(ctx, id, model.DialogueStatusFailed, "draft_round_failed", rerr.Error())
	}
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// applyDialogueBusinessConsolidation handles POST
// /api/dialogues/:id/business-agent/consolidation. It applies the round-5
// recommendation list without invoking the model again: accept-all uses every
// recommended value; a selected field overrides exactly that field and uses the
// remaining recommendations for the other fields.
func (s *Server) applyDialogueBusinessConsolidation(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	dlg, err := s.store.GetDialogueSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get dialogue")
		return
	}
	if dlg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if dlg.Status != model.DialogueStatusDraftingBusinessAgent {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "dialogue is not in business-agent drafting", "status": dlg.Status})
		return
	}
	var body businessConsolidationBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if !body.ConsolidationAccept && strings.TrimSpace(body.ConsolidationField) == "" {
		writeError(w, http.StatusBadRequest, "missing consolidation selection")
		return
	}
	ctx := r.Context()
	consolidation := s.latestBusinessConsolidation(ctx, id)
	if len(consolidation) == 0 {
		writeError(w, http.StatusConflict, "no business consolidation list")
		return
	}
	current := s.latestAgentDraft(ctx, id)
	adjusted, aerr := applyBusinessConsolidationAdjustment(current, consolidation, body.ConsolidationField, body.ConsolidationValue)
	if aerr != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "business consolidation adjust failed", "detail": aerr.Error()})
		return
	}
	now := time.Now()
	draftBytes, _ := json.Marshal(businessDraftRecord{
		Status:     "ready_to_confirm",
		Round:      6,
		AgentDraft: adjusted,
	})
	if err := s.store.AppendDialogueMessage(ctx, model.DialogueMessage{
		ID: "dmsg_" + idpkg.New(), DialogueID: id, Role: "agent", Kind: "business_draft",
		MetadataJSON: string(draftBytes), CreatedAt: now,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "append business draft")
		return
	}
	s.publishDialogueSimple("dialogue.agent_draft.updated", id, adjusted)
	view, err := s.composeDialogueView(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "compose view")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// ---- shared small helpers -------------------------------------------------

// activeDialogueIntent normalizes a route-selection intent before it drives the
// route switch. The business_processing_agent route is now hidden at the server
// layer: a stale client POST {intent:"business_processing_agent"} is mapped to
// application_generation so it falls into the application-generation case
// (child clarification + drafting_application) instead of starting business
// drafting. The dormant business-agent endpoints/consts stay intact for
// compatibility coverage.
func activeDialogueIntent(intent dialogue.Intent) dialogue.Intent {
	if intent == dialogue.IntentBusinessProcessingAgent {
		return dialogue.IntentApplicationGeneration
	}
	return intent
}

func dialogueValidIntent(s string) bool {
	switch dialogue.Intent(s) {
	case dialogue.IntentExistingApplication, dialogue.IntentApplicationGeneration, dialogue.IntentBusinessProcessingAgent:
		return true
	}
	return false
}

// normalizeScenarioName derives a clean scenario name from the confirmed
// requirement, preferring appName then coreScenario then the initial prompt. It
// strips common Chinese request prefixes and trims to a reasonable length.
func normalizeScenarioName(appName, coreScenario, initialPrompt string) string {
	for _, candidate := range []string{appName, coreScenario, initialPrompt} {
		name := strings.TrimSpace(candidate)
		if name == "" {
			continue
		}
		for _, prefix := range []string{"请帮我", "帮我", "生成一个", "生成", "做一个", "创建一个", "创建", "我想要", "想要"} {
			name = strings.TrimSpace(strings.TrimPrefix(name, prefix))
		}
		if name == "" {
			continue
		}
		runes := []rune(name)
		if len(runes) > 24 {
			name = string(runes[:24])
		}
		return name
	}
	return "未命名"
}

// slugifyRaw is the core slug transform: lowercase, keep [a-z0-9], map '-'/'_'
// and every other rune (whitespace, punctuation, non-ASCII such as Chinese) to
// '-', then trim/collapse hyphens. Unlike slugify it does NOT substitute "app"
// for an empty result — it returns "" when the input has no ASCII alphanumerics.
// That lets callers detect a non-ASCII name and choose their own anchor
// (factoryAppSlug anchors on appType; the agent key falls back to "biz").
func slugifyRaw(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteByte('-')
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	return out
}

// slugify produces a URL-safe slug from a name, falling back to "app" when the
// name has no ASCII alphanumerics so the result is never empty.
func slugify(name string) string {
	if out := slugifyRaw(name); out != "" {
		return out
	}
	return "app"
}

// factoryAppSlug derives the lowercase, filesystem-safe slug from the same values
// as the readable factory name (<normalizedName>-<UPPERCASE serial>): the ASCII
// portion of the name plus the lowercased serial. When the name contributes no
// ASCII (e.g. a pure-Chinese scenario name), it anchors the slug on the appType
// so the result is readable and stable rather than serial-only (e.g.
// situation-replay-k7m2 instead of k7m2). "app" is the final fallback. The slug
// is deterministic in (name, appType, suffix) so the collision predicate can test
// the exact candidate slug.
func factoryAppSlug(name, appType, suffix string) string {
	serial := strings.ToLower(suffix)
	if namePart := slugifyRaw(name); namePart != "" {
		return namePart + "-" + serial
	}
	anchor := slugifyRaw(appType)
	if anchor == "" {
		anchor = "app"
	}
	return anchor + "-" + serial
}

// appSlugTaken reports whether the factory slug derived from (name, appType,
// candSerial) is already used by an existing application. candSerial is the
// UPPERCASE Base36 candidate; factoryAppSlug lowercases it, so this matches the
// lowercased stored slugs exactly (the prior HasSuffix(slug,"-"+UPPERCASE) check
// never matched and admitted duplicates). Extracted so collision behavior is
// unit-testable without driving the random serial generator.
func (s *Server) appSlugTaken(ctx context.Context, name, appType, candSerial string) bool {
	candidate := factoryAppSlug(name, appType, candSerial)
	apps, err := s.store.ListApplications(ctx)
	if err != nil {
		return false
	}
	for _, a := range apps {
		if a.Slug == candidate {
			return true
		}
	}
	return false
}

// agentKeyTaken reports whether the agent key derived from (nameSlug, candSerial)
// is already used by an existing agent. Mirrors appSlugTaken's exact-match,
// case-consistent comparison.
func (s *Server) agentKeyTaken(ctx context.Context, nameSlug, candSerial string) bool {
	candidate := nameSlug + "-" + strings.ToLower(candSerial)
	agents, err := s.store.ListAgents(ctx)
	if err != nil {
		return false
	}
	for _, a := range agents {
		if a.Key == candidate {
			return true
		}
	}
	return false
}
