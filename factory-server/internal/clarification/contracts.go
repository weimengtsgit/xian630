package clarification

import (
	"encoding/json"
	"strings"
)

// StringList accepts either a JSON string or a JSON string array. Claude may
// emit a single recommended option as "x" and a multi-select recommendation as
// ["x","y"]; the product contract treats both as a list.
type StringList []string

func (s *StringList) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*s = nil
		return nil
	}
	var list []string
	if err := json.Unmarshal(data, &list); err == nil {
		*s = list
		return nil
	}
	var one string
	if err := json.Unmarshal(data, &one); err != nil {
		return err
	}
	if one == "" {
		*s = nil
		return nil
	}
	*s = []string{one}
	return nil
}

func (s StringList) Contains(value string) bool {
	for _, item := range s {
		if item == value {
			return true
		}
	}
	return false
}

// HighImpactRecommendation is stored as a single recommended value in the
// open-high-impact snapshot. Be tolerant when a model emits a JSON array for a
// multi-select question: keep the first value so the entire round still parses.
type HighImpactRecommendation string

func (r *HighImpactRecommendation) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*r = ""
		return nil
	}
	var one string
	if err := json.Unmarshal(data, &one); err == nil {
		*r = HighImpactRecommendation(one)
		return nil
	}
	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return err
	}
	if len(list) == 0 {
		*r = ""
		return nil
	}
	*r = HighImpactRecommendation(list[0])
	return nil
}

type Option struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Reason      string `json:"reason"`
	Recommended bool   `json:"recommended,omitempty"`
}

type Question struct {
	ID             string     `json:"id"`
	Label          string     `json:"label"`
	Question       string     `json:"question"`
	Required       bool       `json:"required"`
	Recommendation StringList `json:"recommendation,omitempty"`
	Options        []Option   `json:"options"`
	AllowCustom    bool       `json:"allowCustom"`
	MultiSelect    bool       `json:"multiSelect,omitempty"`
}

type WorkLog struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// BlueprintRef was the user-visible blueprint recommendation card. It has been
// REMOVED from the adaptive contract: blueprints are now an internal Factory
// reference only, surfaced nowhere in user-facing events. Requirement.BlueprintRefs
// is retained as server-side-only metadata. Do not reintroduce a user-visible
// blueprint recommendation type.

type Requirement struct {
	AppType           string              `json:"appType"`
	AppName           string              `json:"appName"`
	TargetUsers       []string            `json:"targetUsers"`
	CoreScenario      string              `json:"coreScenario"`
	PrimaryView       string              `json:"primaryView"`
	MainEntities      []string            `json:"mainEntities"`
	DataPolicy        string              `json:"dataPolicy"`
	AcceptanceFocus   []string            `json:"acceptanceFocus"`
	JudgementBoundary JudgementBoundary   `json:"judgementBoundary,omitempty"`
	GenerationProfile map[string][]string `json:"generationProfile"`
	BlueprintRefs     []string            `json:"blueprintRefs"`
}

// JudgementBoundary captures the business judgement frame for military/naval
// clarification flows: what real source families will be used and the concise
// "based on data, apply rules, judge result, refresh cadence, output form"
// summary shown back to the user before generation.
type JudgementBoundary struct {
	DataSources []string `json:"dataSources,omitempty"`
	Summary     string   `json:"summary,omitempty"`
}

// requirementView is the user-facing projection of Requirement. It intentionally
// OMITS BlueprintRefs: blueprint slugs are internal Factory metadata persisted
// server-side only and must never travel in a user-facing SSE event. Use
// requirementView (not Requirement itself) for any event payload. This struct
// cannot leak the field by omission, unlike a string-scrub.
type requirementView struct {
	AppType           string              `json:"appType"`
	AppName           string              `json:"appName"`
	TargetUsers       []string            `json:"targetUsers"`
	CoreScenario      string              `json:"coreScenario"`
	PrimaryView       string              `json:"primaryView"`
	MainEntities      []string            `json:"mainEntities"`
	DataPolicy        string              `json:"dataPolicy"`
	AcceptanceFocus   []string            `json:"acceptanceFocus"`
	JudgementBoundary JudgementBoundary   `json:"judgementBoundary,omitempty"`
	GenerationProfile map[string][]string `json:"generationProfile"`
}

type RoundInput struct {
	SessionID          string        `json:"sessionId"`
	Round              int           `json:"round"`
	MaxRounds          int           `json:"maxRounds"`
	InitialPrompt      string        `json:"initialPrompt"`
	Messages           []MessageView `json:"messages"`
	CurrentRequirement Requirement   `json:"currentRequirement"`
}

type MessageView struct {
	Role    string `json:"role"`
	Kind    string `json:"kind"`
	Content string `json:"content"`
}

// ConsolidationEntry is one field recommendation emitted at round 5 when the
// requirement is still incomplete after the one-decision rounds 1–4. Factory
// persists these as a recommendation_consolidation message and lets the user
// adjust a single field at round 6 (see ApplyConsolidationAdjustment). The
// RecommendedValue is a typed JSON value (string or array).
type ConsolidationEntry struct {
	Field            string          `json:"field"`
	RecommendedValue json.RawMessage `json:"recommendedValue"`
	Reason           string          `json:"reason"`
	Alternatives     []string        `json:"alternatives"`
}

// HighImpactItem is one CURRENTLY UNRESOLVED high-impact requirement decision
// the user must confirm before the session may reach ready_to_confirm (D3 / ADR
// 0006). It is USER-FACING ONLY: id and label are plain-language identifiers,
// never internal blueprint/catalog slugs or raw model reasoning. The runner
// validates structure (non-empty id/label, at most 3 options) and drops anything
// disallowed. A field filled from a blueprint assumption is NOT a confirmed
// high-impact decision — only an explicit user confirmation closes the item.
type HighImpactItem struct {
	ID             string                   `json:"id"`
	Label          string                   `json:"label"`
	Recommendation HighImpactRecommendation `json:"recommendation,omitempty"`
	Options        []Option                 `json:"options"`
}

type RoundOutput struct {
	Status                 string               `json:"status"`
	Round                  int                  `json:"round"`
	WorkLog                []WorkLog            `json:"workLog"`
	Questions              []Question           `json:"questions"`
	Requirement            Requirement          `json:"requirement"`
	NormalizedScenarioName string               `json:"normalizedScenarioName"`
	Consolidation          []ConsolidationEntry `json:"consolidation,omitempty"`
	// OpenHighImpact lists the currently-unresolved high-impact confirmation
	// items. While non-empty, the session may NOT reach ready_to_confirm,
	// regardless of how complete the requirement is. Each round surfaces exactly
	// one of these as questions[0] (reused through the existing question
	// pipeline); this list carries the full remaining set so the gate and
	// history can re-check without a model turn.
	OpenHighImpact []HighImpactItem `json:"openHighImpact,omitempty"`
	// CollaborationAdjustments carries natural-language requests to adjust the
	// collaboration plan (e.g. remove a high-impact agent such as code-reviewer)
	// that a clarification skill MAY emit. This field is a RECOGNITION POINT
	// ONLY: the server decodes and carries it so a future skill-driven flow can
	// read it. Application logic (removing agents, re-planning, re-confirming
	// high-impact removals) is intentionally DEFERRED — the field is not yet
	// consumed by the confirm path. When HighImpact is true the caller would keep
	// a high-impact confirmation open until the user explicitly confirms the
	// removal, but that gating is also deferred.
	CollaborationAdjustments []CollaborationAdjustment `json:"collaborationAdjustments,omitempty"`
}

// CollaborationAdjustment is one requested change to the collaboration plan that
// a clarification skill may emit. It is a light contract: the server recognizes
// and decodes it but does not yet apply it (see RoundOutput.CollaborationAdjustments).
type CollaborationAdjustment struct {
	Action     string `json:"action"`     // e.g. "remove_agent"
	AgentKey   string `json:"agentKey"`   // target agent key
	HighImpact bool   `json:"highImpact"` // affects a blocking quality gate
	Warning    string `json:"warning"`    // user-facing rationale
}

type StreamEvent struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	MessageID string `json:"message_id,omitempty"`
	Delta     string `json:"delta,omitempty"`
	Data      any    `json:"data,omitempty"`
}

// IsReadyToConfirmStatus recognizes model-output statuses that mean "the
// requirement is complete; wait for the user's explicit confirm click." The
// product session status remains ready_to_confirm here — never confirmed —
// because confirmed is reserved for the post-click state that creates a Job.
func IsReadyToConfirmStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "ready_to_confirm", "confirmed":
		return true
	default:
		return false
	}
}
