// Package dialogue implements the two model-driven contracts that sit on the
// dialogue (multi-turn chat) side of the Software Factory: intent routing and
// business-agent drafting. It mirrors the artifact discipline and stream
// filtering of package clarification but is application/routing-oriented, not
// requirement-clarification-oriented.
//
// All model output is VALIDATED before it is returned or emitted: invented
// slugs (not in the candidate sets the runner supplied) are rejected, malformed
// JSON is rejected, and the server-side-only internalBlueprintSlug is redacted
// from every emitted StreamEvent (it survives only in the returned RouteOutput
// for Factory use). thinking_delta / non-user-facing CLI stream data is never
// surfaced — only text_delta text.
package dialogue

import (
	"encoding/json"
	"strings"
)

// Intent is the routed user intent. It is one of the three Factory intents.
type Intent string

const (
	IntentExistingApplication      Intent = "existing_application"
	IntentApplicationGeneration    Intent = "application_generation"
	IntentBusinessProcessingAgent  Intent = "business_processing_agent"
)

func validIntent(s string) bool {
	switch Intent(s) {
	case IntentExistingApplication, IntentApplicationGeneration, IntentBusinessProcessingAgent:
		return true
	}
	return false
}

// Confidence is high when the router is sure, ambiguous when it cannot decide.
type Confidence string

const (
	ConfidenceHigh      Confidence = "high"
	ConfidenceAmbiguous Confidence = "ambiguous"
)

// AppSummary is a user-visible summary of a candidate application the router
// may route to. The slug is the candidate key Factory validates against.
type AppSummary struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	AppType     string `json:"appType"`
	Summary     string `json:"summary"`
	IsGenerated bool   `json:"isGenerated"`
}

// BlueprintSummary is a SERVER-SIDE-ONLY candidate. Its slug must NEVER be
// surfaced in any emitted event; it is carried only inside the returned
// RouteOutput so Factory can pre-select a blueprint for an application
// generation route. The router cannot invent these — Factory validates every
// returned slug against the candidates it supplied.
type BlueprintSummary struct {
	Slug    string `json:"slug"`
	Name    string `json:"name"`
	AppType string `json:"appType"`
	Summary string `json:"summary"`
}

// DialogueMessageView is one message in the dialogue history, as seen by the
// router (role + content). Kind is the Factory message kind
// (text/recommendation_consolidation/...).
type DialogueMessageView struct {
	Role    string `json:"role"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
}

// RouteInput is the bounded input the router consumes. It contains the
// dialogue history, the visible preset/generated app summaries, and the
// internal blueprint summaries. The router must use ONLY these candidates.
type RouteInput struct {
	DialogueID           string               `json:"dialogueId"`
	UserMessage          string               `json:"userMessage"`
	Messages             []DialogueMessageView `json:"messages"`
	ExistingApplications []AppSummary         `json:"existingApplications"`
	Blueprints           []BlueprintSummary   `json:"blueprints"`
}

// RouteOutput is the EXACT contract the router must emit. Factory validates
// every slug in ExistingApplicationSlugs against RouteInput.ExistingApplications
// and InternalBlueprintSlug against RouteInput.Blueprints. InternalBlueprintSlug
// is server-side only and is redacted from any emitted event.
type RouteOutput struct {
	Intent                  Intent     `json:"intent"`
	Confidence              Confidence `json:"confidence"`
	ExistingApplicationSlugs []string   `json:"existingApplicationSlugs"`
	InternalBlueprintSlug   string     `json:"internalBlueprintSlug"`
	UserFacingReason        string     `json:"userFacingReason"`
	NeedsRouteConfirmation  bool       `json:"needsRouteConfirmation"`
}

// routeEventView is the user-facing projection of RouteOutput with the
// internalBlueprintSlug field OMITTED entirely. It is the only route shape that
// may appear in an emitted StreamEvent or a persisted artifact; the internal
// slug survives only in the returned RouteOutput for server-side use.
type routeEventView struct {
	Intent                  Intent     `json:"intent"`
	Confidence              Confidence `json:"confidence"`
	ExistingApplicationSlugs []string   `json:"existingApplicationSlugs"`
	UserFacingReason        string     `json:"userFacingReason"`
	NeedsRouteConfirmation  bool       `json:"needsRouteConfirmation"`
}

// WorkLog is the user-facing analysis work log. It is the ONLY model-authored
// progress surface; it must never carry hidden chain-of-thought or
// thinking_delta text.
type WorkLog struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// Option is one selectable option on a drafting question.
type Option struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Reason      string `json:"reason"`
	Recommended bool   `json:"recommended,omitempty"`
}

// Question is a single required decision in a business-agent drafting round.
// Per the one-decision-at-a-time rule, a round emits at most ONE question with
// 2–3 options.
type Question struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	Question       string   `json:"question"`
	Required       bool     `json:"required"`
	Recommendation string   `json:"recommendation,omitempty"`
	Options        []Option `json:"options"`
	AllowCustom    bool     `json:"allowCustom"`
}

// ConsolidationEntry is one field recommendation emitted at round 5 when the
// draft is still incomplete after the one-decision rounds. Factory persists
// these as a recommendation_consolidation message and lets the user adjust a
// single field at round 6.
type ConsolidationEntry struct {
	Field            string          `json:"field"`
	RecommendedValue json.RawMessage `json:"recommendedValue"`
	Reason           string          `json:"reason"`
	Alternatives     []string        `json:"alternatives"`
}

// BusinessAgentDraft is the complete future-agent instruction emitted when the
// draft is ready. The Prompt must be a COMPLETE future agent instruction but
// MUST NOT imply tool access, permissions, inputs, or runtime execution.
type BusinessAgentDraft struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
}

// BusinessDraftInput is the bounded input for one business-agent drafting round.
type BusinessDraftInput struct {
	DialogueID          string               `json:"dialogueId"`
	Round               int                  `json:"round"`
	MaxRounds           int                  `json:"maxRounds"`
	UserMessage         string               `json:"userMessage"`
	Messages            []DialogueMessageView `json:"messages"`
	CurrentDraft        BusinessAgentDraft   `json:"currentDraft"`
	CurrentQuestions    []Question           `json:"currentQuestions"`
}

// BusinessDraftOutput mirrors the adaptive shape: status/round/work-log,
// at most one question, an optional consolidation list, and the agentDraft.
type BusinessDraftOutput struct {
	Status        string               `json:"status"`
	Round         int                  `json:"round"`
	WorkLog       []WorkLog            `json:"workLog"`
	Questions     []Question           `json:"questions"`
	Consolidation []ConsolidationEntry `json:"consolidation,omitempty"`
	AgentDraft    BusinessAgentDraft   `json:"agentDraft"`
}

// StreamEvent is the normalized event the runner emits. It must NEVER carry
// the internal blueprint slug or hidden reasoning.
type StreamEvent struct {
	Type      string `json:"type"`
	DialogueID string `json:"dialogue_id"`
	MessageID string `json:"message_id,omitempty"`
	Delta     string `json:"delta,omitempty"`
	Data      any    `json:"data,omitempty"`
}

// Status recognizes the adaptive drafting statuses. ready_to_confirm means the
// draft is complete and waits for explicit confirm.
func IsReadyToConfirmStatus(status string) bool {
	switch normalizeStatus(status) {
	case "ready_to_confirm", "confirmed":
		return true
	default:
		return false
	}
}

func normalizeStatus(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
