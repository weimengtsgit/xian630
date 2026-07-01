package model

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
	PrototypeStatus           string        `json:"prototypeStatus"`
	DownstreamConstraintLevel string        `json:"downstreamConstraintLevel"`
	Immutable                 bool          `json:"immutable"`
	Prototype                 PrototypeSpec `json:"prototype"`
	DesignDocument            any           `json:"designDocument,omitempty"`
	AssumedDataFields         []string      `json:"assumedDataFields,omitempty"`
}
