package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
)

// Sentinel errors. Each is the literal model.ErrorCode so callers can detect a
// step's error_code via errors.Is AND map straight to model.ErrorCode. Wrapped
// errors preserve the chain via %w, so the underlying detail (file path, JSON
// offset) is available to diagnostics without losing the sentinel.
var (
	ErrOutputMissing          = errors.New(string(model.ErrorOutputMissing))
	ErrOutputInvalidJSON      = errors.New(string(model.ErrorOutputInvalidJSON))
	ErrSchemaValidationFailed = errors.New(string(model.ErrorSchemaValidationFailed))
	ErrFileConstraintViolated = errors.New(string(model.ErrorFileConstraintViolated))
	ErrRunnerExitNonzero      = errors.New(string(model.ErrorRunnerExitNonzero))
)

// StepOutput is the common, minimal projection of a Claude step's output.json
// (design §5). Steps that need more fields decode into their own richer struct
// first and then collapse into this for the executor's waiting-user signal.
type StepOutput struct {
	NeedsUserInput bool       `json:"needsUserInput"`
	Questions      []Question `json:"questions"`
}

// Question is a single clarification the agent wants the user to answer before
// the step can complete (design §5.1). Options carries the structured choices
// the agent offers (e.g. "use-mock-data" vs "provide-real-api"); surfaced via
// the clarification work trace so the conversation UI can render them as a
// pickable card rather than a bare text blob.
//
// Agents are inconsistent about field names: the prompt's contract uses
// question/value, but the model sometimes emits text/id. UnmarshalJSON
// normalizes both shapes so a clarification never silently loses its question
// text or option values.
type Question struct {
	ID            string           `json:"id"`
	Question      string           `json:"question"`
	DefaultAnswer string           `json:"defaultAnswer"`
	Options       []QuestionOption `json:"options,omitempty"`
}

// UnmarshalJSON accepts the contract shape ({question, options:[{value,label}]})
// and the model's alternate shape ({text, options:[{id,label}]}) — the agent
// emits both in practice, and a missing question text made the task card print
// raw JSON. After decode, Question always holds the question text and each
// option always has a Value (falling back to its id/label).
func (q *Question) UnmarshalJSON(data []byte) error {
	type raw struct {
		ID            string           `json:"id"`
		Question      string           `json:"question"`
		Text          string           `json:"text"`
		DefaultAnswer string           `json:"defaultAnswer"`
		Options       []QuestionOption `json:"options"`
	}
	var r raw
	if err := json.Unmarshal(data, &r); err != nil {
		return err
	}
	q.ID = r.ID
	q.Question = r.Question
	if q.Question == "" {
		q.Question = r.Text
	}
	q.DefaultAnswer = r.DefaultAnswer
	q.Options = r.Options
	return nil
}

// QuestionOption is one structured choice on a clarification question.
type QuestionOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Recommended bool   `json:"recommended,omitempty"`
}

// UnmarshalJSON accepts {value,label} (contract) and {id,label} (alternate).
// Value falls back to id, then label, so the option is always pickable.
func (o *QuestionOption) UnmarshalJSON(data []byte) error {
	type raw struct {
		Value       string `json:"value"`
		ID          string `json:"id"`
		Label       string `json:"label"`
		Recommended bool   `json:"recommended"`
	}
	var r raw
	if err := json.Unmarshal(data, &r); err != nil {
		return err
	}
	o.Value = r.Value
	if o.Value == "" {
		o.Value = r.ID
	}
	if o.Value == "" {
		o.Value = r.Label
	}
	o.Label = r.Label
	o.Recommended = r.Recommended
	return nil
}

// SkillPaths is a []string that unmarshals usedSkills from EITHER of the two
// shapes agents actually emit:
//
//   - the documented contract: an array of skill file paths
//     ["…/software-factory-app/SKILL.md", …], or
//   - an array of objects {path, purpose} that some agents produce when they
//     also document WHY each skill was followed.
//
// Both are accepted; objects are normalized to their `path` value so the rest
// of the pipeline still sees []string (len is the only thing the validators
// and executors depend on). Without this, the object shape fails json.Unmarshal
// with a type mismatch that ReadAndDecode then misreports as
// output_invalid_json (real failure: job_fb9b8586864a6fe52876d4c8, every retry).
// Exported because the executor's own code_generation decode struct reuses it.
type SkillPaths []string

func (s *SkillPaths) UnmarshalJSON(data []byte) error {
	// null / absent decodes to an empty slice (the validators treat empty as
	// "usedSkills required" → schema_validation_failed).
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	out := make([]string, 0, len(raw))
	for _, el := range raw {
		// Documented shape: a bare path string.
		var str string
		if err := json.Unmarshal(el, &str); err == nil {
			out = append(out, str)
			continue
		}
		// Richer shape: an object {path, purpose, …} — take its path.
		var obj struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(el, &obj); err == nil && obj.Path != "" {
			out = append(out, obj.Path)
			continue
		}
		// Unknown element shape: record the raw token so the non-empty check
		// still reflects that a skill was reported (we never silently drop one).
		out = append(out, string(el))
	}
	*s = out
	return nil
}

// codeGenManifestPath is the path, relative to a generated app projectDir, at
// which the manifest must exist after code_generation (design §5.3, §8).
const codeGenManifestRel = ".factory/app.json"

// ReadAndDecode reads output.json at path and decodes it into target. It maps
// the two transport-level failures (file gone, unparseable JSON) onto the
// sentinel errors before any schema/semantic checks run.
//
// The decode is INTENTIONALLY LENIENT: unknown fields are ignored, not
// rejected, and the JSON object is extracted from surrounding prose / Markdown
// fences before decoding. output.json is produced by an LLM, which routinely
// emits extra fields — e.g. requirement_analysis audit detail (top-level
// blueprintRefs, validation.blueprintRefsAudit, validation.skillsAudit) — or
// wraps its JSON in a ```json fence under explanatory prose, on otherwise-valid
// output. A strict DisallowUnknownFields / from-offset decode would turn that
// benign shape into output_invalid_json on well-formed JSON. The real gate is
// each step's explicit Validate* function, which checks the fields the executor
// depends on. A truly unparseable document still maps to ErrOutputInvalidJSON.
//
// Exported so the executor's code_generation finisher decodes output.json with
// the SAME lenient path as the validators (it needs projectDir/createdFiles for
// the file audit + manifest registration, which the validator does not return).
func ReadAndDecode(path string, target any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s: %w", path, ErrOutputMissing)
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	payload := extractJSONObject(string(raw))
	if err := json.Unmarshal([]byte(payload), target); err != nil {
		repaired := repairUnescapedStringQuotes(payload)
		if repaired == payload {
			return fmt.Errorf("%s: %w", path, ErrOutputInvalidJSON)
		}
		if err := json.Unmarshal([]byte(repaired), target); err != nil {
			return fmt.Errorf("%s: %w", path, ErrOutputInvalidJSON)
		}
	}
	return nil
}

// extractJSONObject returns the substring spanning the outermost balanced JSON
// object, tolerating Markdown fences and short surrounding prose. Claude is
// prompted to emit a bare object, but real CLI output can still include
// ```json fences; transport validation should accept that when the enclosed
// object is valid.
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		if nl := strings.IndexByte(s, '\n'); nl >= 0 {
			s = strings.TrimSpace(s[nl+1:])
		}
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
		s = strings.TrimSpace(s)
	}
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return s
	}
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return s[start:]
}

func repairUnescapedStringQuotes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inStr := false
	esc := false
	changed := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !inStr {
			b.WriteByte(c)
			if c == '"' {
				inStr = true
			}
			continue
		}
		if esc {
			b.WriteByte(c)
			esc = false
			continue
		}
		if c == '\\' {
			b.WriteByte(c)
			esc = true
			continue
		}
		if c == '"' {
			if quoteTerminatesString(s, i) {
				b.WriteByte(c)
				inStr = false
			} else {
				b.WriteString(`\"`)
				changed = true
			}
			continue
		}
		b.WriteByte(c)
	}
	if !changed {
		return s
	}
	return b.String()
}

func quoteTerminatesString(s string, quote int) bool {
	for i := quote + 1; i < len(s); i++ {
		switch s[i] {
		case ' ', '\t', '\r', '\n':
			continue
		case ':', ',', '}', ']':
			return true
		default:
			return false
		}
	}
	return true
}

// requirementAnalysisOutput mirrors the FROZEN requirement shape the
// requirement_analysis step now produces (design §5.1, Task 5). The step no
// longer clarifies — clarification happens pre-job in the clarification
// session. The step AUDITS the already-confirmed requirement: it validates field
// completeness, capability boundaries (blueprint refs), and the
// generationProfile, then emits validation.complete/supported. The Go-side
// validator only enforces the structural rules (the blueprint-catalog audit is
// Claude-side, see executor freeze prompt); incomplete or unsupported
// requirements hard-fail with ErrSchemaValidationFailed rather than pausing the
// job for clarification.
type requirementAnalysisOutput struct {
	ConfirmedRequirementID string              `json:"confirmedRequirementId"`
	Summary                string              `json:"summary"`
	AppType                string              `json:"appType"`
	AppName                string              `json:"appName"`
	TargetUsers            []string            `json:"targetUsers"`
	CoreScenario           string              `json:"coreScenario"`
	PrimaryView            string              `json:"primaryView"`
	MainEntities           []string            `json:"mainEntities"`
	DataPolicy             string              `json:"dataPolicy"`
	AcceptanceFocus        []string            `json:"acceptanceFocus"`
	GenerationProfile      map[string][]string `json:"generationProfile"`
	Constraints            json.RawMessage     `json:"constraints"`
	Risks                  json.RawMessage     `json:"risks"`
	// WorkLog is the OPTIONAL public progress log the agent may author. It is
	// the ONLY agent-authored field the executor lifts into summary records.
	// thinking/reasoning and every other hidden provider field are NOT in this
	// struct, so the lenient decoder drops them (boundary locked by contract
	// tests that include both a workLog and a thinking field).
	WorkLog    []workLogEntry      `json:"workLog"`
	Validation requirementValidation `json:"validation"`
}

// requirementValidation is the freeze/audit verdict the requirement_analysis
// step emits. A frozen requirement that is incomplete or unsupported hard-fails
// the pipeline (see ValidateRequirementAnalysis); the MissingFields and
// UnsupportedRequests are surfaced in the error so the user knows why.
type requirementValidation struct {
	Complete            bool     `json:"complete"`
	Supported           bool     `json:"supported"`
	MissingFields       []string `json:"missingFields"`
	UnsupportedRequests []string `json:"unsupportedRequests"`
}

// ValidateRequirementAnalysis decodes and validates the output.json the
// requirement_analysis (freeze/audit) step produced. The step must either
// SUCCEED (validation.complete && validation.supported → the requirement is
// frozen, the pipeline proceeds to solution_design) or FAIL (return
// ErrSchemaValidationFailed). It must NEVER return waiting_user — clarification
// is pre-job now, so a frozen requirement that the agent finds incomplete or
// unsupported is a hard failure, not a pause.
func ValidateRequirementAnalysis(path string) (StepOutput, error) {
	var raw requirementAnalysisOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, err
	}
	if !raw.Validation.Complete || !raw.Validation.Supported {
		return StepOutput{}, fmt.Errorf("confirmed requirement rejected: %w%s",
			ErrSchemaValidationFailed, requirementRejectionDetail(raw.Validation))
	}
	if raw.AppType == "" || raw.AppName == "" || len(raw.GenerationProfile) == 0 {
		return StepOutput{}, fmt.Errorf("missing required requirement fields: %w", ErrSchemaValidationFailed)
	}
	return StepOutput{}, nil
}

// requirementRejectionDetail formats the agent's missingFields and
// unsupportedRequests into a human-readable suffix for the rejection error, so
// the card surfaces WHY the requirement was rejected (not just the code). Each
// reason is capped; the whole suffix is bounded so it fits on a card.
func requirementRejectionDetail(v requirementValidation) string {
	var reasons []string
	if !v.Complete {
		for _, m := range v.MissingFields {
			reasons = append(reasons, "缺少字段: "+m)
		}
	}
	if !v.Supported {
		for _, u := range v.UnsupportedRequests {
			reasons = append(reasons, "不支持: "+truncateReason(u))
		}
	}
	if len(reasons) == 0 {
		if !v.Complete {
			return " (需求不完整)"
		}
		return " (超出支持能力)"
	}
	combined := strings.Join(reasons, "; ")
	if len([]rune(combined)) > 500 {
		combined = string([]rune(combined)[:497]) + "..."
	}
	return " — " + combined
}

// truncateReason caps a single rejection reason so one verbose entry cannot
// dominate the error message.
func truncateReason(s string) string {
	const max = 160
	if len([]rune(s)) <= max {
		return s
	}
	return string([]rune(s)[:max-3]) + "..."
}

// solutionDesignOutput mirrors design §5.2. The schema is large; the validator
// only enforces the shape the executor depends on (needsUserInput/questions)
// plus strict decode so an obviously malformed agent response is rejected.
//
// Task 6: the step must report which project-local skills it loaded+followed
// via UsedSkills; a solution produced without following any skill is rejected.
type solutionDesignOutput struct {
	NeedsUserInput bool       `json:"needsUserInput"`
	Questions      []Question `json:"questions"`
	App            any        `json:"app,omitempty"`
	ArtifactPlan   any        `json:"artifactPlan,omitempty"`
	UsedSkills     SkillPaths `json:"usedSkills"`
	Warnings       []string   `json:"warnings,omitempty"`
	// WorkLog: see requirementAnalysisOutput.WorkLog.
	WorkLog []workLogEntry `json:"workLog"`
}

// ValidateSolutionDesign decodes a solution_design attempt's output.json.
func ValidateSolutionDesign(path string) (StepOutput, error) {
	var raw solutionDesignOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, err
	}
	if len(raw.UsedSkills) == 0 {
		return StepOutput{}, fmt.Errorf("usedSkills required: %w", ErrSchemaValidationFailed)
	}
	return StepOutput{NeedsUserInput: raw.NeedsUserInput, Questions: raw.Questions}, nil
}

// codeGenerationOutput mirrors design §5.3.
//
// Task 6: the step must report which project-local skills it loaded+followed
// via UsedSkills; generated code produced without following any skill is
// rejected.
type codeGenerationOutput struct {
	ProjectDir     string     `json:"projectDir"`
	CreatedFiles   []string   `json:"createdFiles"`
	NeedsUserInput bool       `json:"needsUserInput"`
	Questions      []Question `json:"questions"`
	UsedSkills     SkillPaths `json:"usedSkills"`
	Warnings       []string   `json:"warnings,omitempty"`
	// WorkLog: see requirementAnalysisOutput.WorkLog.
	WorkLog []workLogEntry `json:"workLog"`
}

// workLogEntry is one public progress-log entry the agent authors. Only the
// Content is modeled; any other field on a workLog entry (timestamp, severity)
// is dropped by the lenient decoder. This is the NARROW, public surface — it is
// never fed thinking/reasoning/hidden-provider data.
type workLogEntry struct {
	Content string `json:"content"`
}

// ValidateCodeGeneration decodes a code_generation attempt's output.json and,
// after a non-needsUserInput result, confirms the app manifest exists at
// <projectDir>/.factory/app.json (design §5.3: "必须生成 .factory/app.json").
// A missing manifest is a schema_validation_failed, not output_missing,
// because the output.json itself was fine.
//
// Task 6: usedSkills is required regardless of needsUserInput — the step must
// always report which skills it followed, even when pausing for input.
func ValidateCodeGeneration(path string, projectDir string) (StepOutput, error) {
	var raw codeGenerationOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, err
	}
	if len(raw.UsedSkills) == 0 {
		return StepOutput{}, fmt.Errorf("usedSkills required: %w", ErrSchemaValidationFailed)
	}
	out := StepOutput{NeedsUserInput: raw.NeedsUserInput, Questions: raw.Questions}
	if out.NeedsUserInput {
		return out, nil
	}
	manifest := filepath.Join(projectDir, codeGenManifestRel)
	manifestRaw, err := os.ReadFile(manifest)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, fmt.Errorf("%s: %w", manifest, ErrSchemaValidationFailed)
		}
		return out, fmt.Errorf("read %s: %w", manifest, err)
	}
	manifestData, err := scanner.ParseManifest(manifestRaw)
	if err != nil {
		return out, fmt.Errorf("parse %s: %w", manifest, ErrSchemaValidationFailed)
	}
	manifestPath := filepath.ToSlash(filepath.Join(raw.ProjectDir, codeGenManifestRel))
	if err := scanner.ValidateManifest(manifestPath, manifestData); err != nil {
		return out, fmt.Errorf("%w: %v", ErrSchemaValidationFailed, err)
	}
	return out, nil
}
