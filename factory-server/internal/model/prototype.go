package model

import "encoding/json"

// PrototypePage describes one page in a static prototype manifest.
type PrototypePage struct {
	ID               string             `json:"id"`
	Title            string             `json:"title"`
	Purpose          string             `json:"purpose,omitempty"`
	File             string             `json:"file,omitempty"`
	Generated        bool               `json:"generated"`
	VisibleByDefault bool               `json:"visibleByDefault"`
	Sections         []PrototypeSection `json:"sections,omitempty"`
	States           []string           `json:"states,omitempty"`
}

// PrototypeSection describes one visible section of a prototype page.
type PrototypeSection struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content"`
}

// PrototypeSpec is the prototype design contract emitted by the design_contract
// step. It captures the style, audience, platform, fidelity, page inventory,
// and downstream constraint policy the agent has committed to.
type PrototypeSpec struct {
	Style              string             `json:"style"`
	TargetAudience     string             `json:"targetAudience"`
	TargetPlatform     string             `json:"targetPlatform"`
	Fidelity           string             `json:"fidelity"`
	Density            string             `json:"density,omitempty"`
	NavigationModel    string             `json:"navigationModel,omitempty"`
	DataHonesty        string             `json:"dataHonesty,omitempty"`
	DefaultPage        string             `json:"defaultPage"`
	DesignDecisions    map[string]string  `json:"designDecisions,omitempty"`
	Pages              []PrototypePage    `json:"pages"`
	Interactions       []string           `json:"interactions,omitempty"`
	ResponsiveRules    []string           `json:"responsiveRules,omitempty"`
	Constraints        []string           `json:"constraints,omitempty"`
	ConfirmationPolicy string             `json:"confirmationPolicy"`
	Status             string             `json:"status,omitempty"`
	PreviewManifest    *PrototypeManifest `json:"previewManifest,omitempty"`
}

// PrototypeManifest is the file-level manifest the agent writes under
// <attempt>/prototype/preview-manifest.json.
type PrototypeManifest struct {
	Mode        string          `json:"mode"`
	DefaultPage string          `json:"defaultPage"`
	Fidelity    string          `json:"fidelity"`
	Pages       []PrototypePage `json:"pages"`
}

// PrototypeContract is the file-level contract the agent writes under
// <attempt>/prototype/prototype-contract.json.
type PrototypeContract struct {
	PrototypeStatus           string            `json:"prototypeStatus"`
	DownstreamConstraintLevel string            `json:"downstreamConstraintLevel"`
	Immutable                 bool              `json:"immutable"`
	Prototype                 PrototypeSpec     `json:"prototype"`
	DesignDocument            any               `json:"designDocument,omitempty"`
	AssumedDataFields         AssumedDataFields `json:"assumedDataFields,omitempty"`
}

// AssumedDataFields normalizes the shapes emitted by prototype/design agents:
// ["field"], [{"field":"name"}], and [{"entity":"X","fields":["a",{"name":"b"}]}].
type AssumedDataFields []string

func (f *AssumedDataFields) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*f = nil
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(data, &items); err != nil {
		return err
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		var s string
		if err := json.Unmarshal(item, &s); err == nil {
			if s != "" {
				out = append(out, s)
			}
			continue
		}
		var obj struct {
			Name   string            `json:"name"`
			Field  string            `json:"field"`
			Fields []json.RawMessage `json:"fields"`
		}
		if err := json.Unmarshal(item, &obj); err != nil {
			return err
		}
		if obj.Field != "" {
			out = append(out, obj.Field)
		}
		if obj.Name != "" {
			out = append(out, obj.Name)
		}
		for _, field := range obj.Fields {
			var fs string
			if err := json.Unmarshal(field, &fs); err == nil {
				if fs != "" {
					out = append(out, fs)
				}
				continue
			}
			var fo struct {
				Name  string `json:"name"`
				Field string `json:"field"`
			}
			if err := json.Unmarshal(field, &fo); err != nil {
				return err
			}
			if fo.Field != "" {
				out = append(out, fo.Field)
			} else if fo.Name != "" {
				out = append(out, fo.Name)
			}
		}
	}
	*f = out
	return nil
}
