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
	GenerationProfile map[string][]string `json:"generationProfile"`
	BlueprintRefs     []string            `json:"blueprintRefs"`
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

type RoundOutput struct {
	Status                string             `json:"status"`
	Round                 int                `json:"round"`
	WorkLog               []WorkLog          `json:"workLog"`
	Questions             []Question         `json:"questions"`
	Requirement           Requirement        `json:"requirement"`
	NormalizedScenarioName string            `json:"normalizedScenarioName"`
	Consolidation         []ConsolidationEntry `json:"consolidation,omitempty"`
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
