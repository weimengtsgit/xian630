package dataaccess

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	StatusDraft               = "draft"
	StatusPendingConfirmation = "pending_confirmation"
	StatusFinalized           = "finalized"
	StatusRejected            = "rejected"
	StatusStale               = "stale"

	MaxInternalJSONBytes     = 200 * 1024
	MaxRedactedJSONBytes     = 100 * 1024
	MaxInternalMarkdownBytes = 100 * 1024
)

type Result struct {
	SchemaVersion          int             `json:"schemaVersion"`
	Stage                  string          `json:"stage"`
	Version                string          `json:"version"`
	Status                 string          `json:"status"`
	CanFinalize            bool            `json:"canFinalize"`
	BlockingIssues         []string        `json:"blockingIssues,omitempty"`
	SourceInputs           SourceInputs    `json:"sourceInputs,omitempty"`
	DataAccessMode         string          `json:"dataAccessMode,omitempty"`
	DataNeeds              []DataNeed      `json:"dataNeeds,omitempty"`
	SourceCandidates       []Source        `json:"sourceCandidates,omitempty"`
	ProbeResults           []ProbeResult   `json:"probeResults,omitempty"`
	FieldMappings          []FieldMapping  `json:"fieldMappings,omitempty"`
	DegradationPolicy      map[string]any  `json:"degradationPolicy,omitempty"`
	RuntimeArchitecture    map[string]any  `json:"runtimeArchitecture,omitempty"`
	CredentialRefs         []CredentialRef `json:"credentialRefs,omitempty"`
	SecurityReviewRequired bool            `json:"securityReviewRequired,omitempty"`
	SecurityReviewReasons  []string        `json:"securityReviewReasons,omitempty"`
	CodegenConstraints     []string        `json:"codegenConstraints,omitempty"`
	Summary                Summary         `json:"summary,omitempty"`
	Confirmation           Confirmation    `json:"confirmation,omitempty"`
}

type SourceInputs struct {
	RequirementAnalysisVersion string   `json:"requirementAnalysisVersion,omitempty"`
	RequirementAnalysisPath    string   `json:"requirementAnalysisPath,omitempty"`
	InterfaceDesignVersion     *string  `json:"interfaceDesignVersion,omitempty"`
	InterfaceDesignPath        *string  `json:"interfaceDesignPath,omitempty"`
	UserSupplementTurnIDs      []string `json:"userSupplementTurnIds,omitempty"`
}

type DataNeed struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Basis              []string `json:"basis,omitempty"`
	InterfacePosition  string   `json:"interfacePosition,omitempty"`
	Required           bool     `json:"required"`
	Fields             []string `json:"fields,omitempty"`
	InteractionTrigger string   `json:"interactionTrigger,omitempty"`
	Status             string   `json:"status"`
}

type Source struct {
	ID               string   `json:"id"`
	Type             string   `json:"type"`
	Label            string   `json:"label"`
	Priority         int      `json:"priority"`
	Verified         bool     `json:"verified"`
	Status           string   `json:"status"`
	AuthRequired     bool     `json:"authRequired,omitempty"`
	CredentialRefIDs []string `json:"credentialRefIds,omitempty"`
	Coverage         string   `json:"coverage,omitempty"`
	Risks            []string `json:"risks,omitempty"`
}

type ProbeResult struct {
	ID                     string          `json:"id"`
	SourceID               string          `json:"sourceId"`
	Method                 string          `json:"method,omitempty"`
	URL                    string          `json:"url,omitempty"`
	RequestedAt            string          `json:"requestedAt,omitempty"`
	StatusCode             int             `json:"statusCode,omitempty"`
	Success                bool            `json:"success"`
	SampleResponseRedacted map[string]any  `json:"sampleResponseRedacted,omitempty"`
	FieldCoverage          []FieldCoverage `json:"fieldCoverage,omitempty"`
	Limits                 []string        `json:"limits,omitempty"`
	EvidenceURLs           []string        `json:"evidenceUrls,omitempty"`
	RetrievalMethod        string          `json:"retrievalMethod,omitempty"`
	Conclusion             string          `json:"conclusion,omitempty"`
}

type FieldCoverage struct {
	Field          string `json:"field"`
	Path           string `json:"path,omitempty"`
	Status         string `json:"status,omitempty"`
	CoverageStatus string `json:"coverageStatus,omitempty"`
	Evidence       string `json:"evidence,omitempty"`
}

type FieldMapping struct {
	DataNeedID      string            `json:"dataNeedId"`
	UIField         string            `json:"uiField,omitempty"`
	SourceID        string            `json:"sourceId"`
	SourcePath      string            `json:"sourcePath"`
	Transform       string            `json:"transform,omitempty"`
	SourceUnit      string            `json:"sourceUnit,omitempty"`
	TargetUnit      string            `json:"targetUnit,omitempty"`
	EnumMap         map[string]string `json:"enumMap,omitempty"`
	Format          string            `json:"format,omitempty"`
	MissingBehavior string            `json:"missingBehavior,omitempty"`
}

type CredentialRef struct {
	ID                string `json:"id"`
	Source            string `json:"source,omitempty"`
	AuthType          string `json:"authType,omitempty"`
	Storage           string `json:"storage,omitempty"`
	Value             string `json:"value,omitempty"`
	RedactionRequired bool   `json:"redactionRequired,omitempty"`
	Validity          string `json:"validity,omitempty"`
}

type Summary struct {
	Confirmed                []string `json:"confirmed,omitempty"`
	Partial                  []string `json:"partial,omitempty"`
	Risks                    []string `json:"risks,omitempty"`
	RequiresUserConfirmation []string `json:"requiresUserConfirmation,omitempty"`
}

type Confirmation struct {
	ConfirmedBy string `json:"confirmedBy,omitempty"`
	ConfirmedAt string `json:"confirmedAt,omitempty"`
	Decision    string `json:"decision,omitempty"`
}

func VersionsDir(root, jobID string) string {
	return filepath.Join(root, "jobs", jobID, "data-access", "versions")
}

func VersionDir(root, jobID, version string) string {
	return filepath.Join(VersionsDir(root, jobID), safeVersion(version))
}

func FinalDir(root, jobID string) string {
	return filepath.Join(root, "jobs", jobID, "data-access", "final")
}

func WriteVersion(root, jobID string, result Result, markdown string) (string, error) {
	if strings.TrimSpace(jobID) == "" {
		return "", errors.New("job id required")
	}
	if strings.TrimSpace(result.Version) == "" {
		return "", errors.New("data access version required")
	}
	if strings.TrimSpace(result.Stage) == "" {
		result.Stage = "data_access"
	}
	dir := VersionDir(root, jobID, result.Version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if len([]byte(markdown)) > MaxInternalMarkdownBytes {
		return "", fmt.Errorf("data access markdown exceeds %d bytes", MaxInternalMarkdownBytes)
	}
	if err := writeJSONCapped(filepath.Join(dir, "dataAccessResult.internal.json"), result, MaxInternalJSONBytes); err != nil {
		return "", err
	}
	if err := writeJSONCapped(filepath.Join(dir, "dataAccessResult.redacted.json"), RedactedResult(result), MaxRedactedJSONBytes); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "data-access.internal.md"), []byte(markdown), 0o644); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "data-access.redacted.md"), []byte(RedactText(markdown)), 0o644); err != nil {
		return "", err
	}
	return dir, nil
}

func FinalizeVersion(root, jobID, version, confirmedBy string) error {
	dir := VersionDir(root, jobID, version)
	var result Result
	if err := readJSON(filepath.Join(dir, "dataAccessResult.internal.json"), &result); err != nil {
		return err
	}
	if result.Version != version {
		return fmt.Errorf("data access version mismatch: have %s want %s", result.Version, version)
	}
	if result.Status != StatusPendingConfirmation {
		return fmt.Errorf("data access version %s is %s, want pending_confirmation", version, result.Status)
	}
	if !result.CanFinalize || len(result.BlockingIssues) > 0 {
		return fmt.Errorf("data access version %s cannot finalize", version)
	}
	result.Status = StatusFinalized
	result.Confirmation = Confirmation{
		ConfirmedBy: confirmedBy,
		ConfirmedAt: time.Now().Format(time.RFC3339),
		Decision:    "confirm",
	}
	finalDir := FinalDir(root, jobID)
	if err := os.MkdirAll(finalDir, 0o755); err != nil {
		return err
	}
	if err := writeJSONCapped(filepath.Join(finalDir, "dataAccessResult.internal.json"), result, MaxInternalJSONBytes); err != nil {
		return err
	}
	if err := writeJSONCapped(filepath.Join(finalDir, "dataAccessResult.redacted.json"), RedactedResult(result), MaxRedactedJSONBytes); err != nil {
		return err
	}
	for _, name := range []string{"data-access.internal.md", "data-access.redacted.md"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(finalDir, name), raw, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func ReadFinal(root, jobID string) (Result, string, error) {
	var result Result
	dir := FinalDir(root, jobID)
	if err := readJSON(filepath.Join(dir, "dataAccessResult.internal.json"), &result); err != nil {
		return Result{}, "", err
	}
	md, err := os.ReadFile(filepath.Join(dir, "data-access.internal.md"))
	if err != nil {
		return Result{}, "", err
	}
	return result, string(md), nil
}

func RedactedResult(result Result) Result {
	out := result
	out.CredentialRefs = append([]CredentialRef(nil), result.CredentialRefs...)
	for i := range out.CredentialRefs {
		if out.CredentialRefs[i].RedactionRequired && out.CredentialRefs[i].Value != "" {
			out.CredentialRefs[i].Value = "[REDACTED]"
		}
	}
	return out
}

var sensitiveTextRe = regexp.MustCompile(`(?i)(authorization\s*:\s*(?:bearer|basic|token)?\s*)[^\r\n]+|((?:api[_-]?key|token|secret|password|cookie)\s*[:=]\s*)[^\s,\r\n]+`)

func RedactText(text string) string {
	return sensitiveTextRe.ReplaceAllStringFunc(text, func(match string) string {
		lower := strings.ToLower(match)
		for _, sep := range []string{":", "="} {
			if idx := strings.Index(match, sep); idx >= 0 {
				key := match[:idx+1]
				if strings.Contains(lower, "authorization") {
					return key + " [REDACTED]"
				}
				return key + "[REDACTED]"
			}
		}
		return "[REDACTED]"
	})
}

func writeJSON(path string, v any) error {
	return writeJSONCapped(path, v, 0)
}

func writeJSONCapped(path string, v any, maxBytes int) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if maxBytes > 0 && len(raw) > maxBytes {
		return fmt.Errorf("%s exceeds %d bytes", filepath.Base(path), maxBytes)
	}
	return os.WriteFile(path, raw, 0o644)
}

func readJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

func safeVersion(version string) string {
	version = strings.TrimSpace(version)
	if version == "" {
		return "v0"
	}
	replacer := strings.NewReplacer("/", "_", "\\", "_", "..", "_")
	return replacer.Replace(version)
}
