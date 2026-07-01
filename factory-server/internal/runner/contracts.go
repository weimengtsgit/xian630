package runner

import (
	"crypto/sha256"
	"encoding/hex"
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
	NeedsUserInput        bool       `json:"needsUserInput"`
	Questions             []Question `json:"questions"`
	FrozenRequirementJSON string     `json:"-"`
	// Warnings 承载被降级的非阻塞问题；例如非白名单阶段试图提问时，
	// executor 会把它作为 assumption trace 展示，但不会暂停任务。
	Warnings []string `json:"-"`
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
	ID            string `json:"id"`
	Question      string `json:"question"`
	DefaultAnswer string `json:"defaultAnswer"`
	// InputType marks a question whose answer must be supplied through a
	// controlled input rather than free text. The data_integration step sets it
	// to "credential" for credential-bearing questions so the conversation UI
	// renders a password input backed by the controlled credential boundary
	// (Task 12) — the plaintext value is NEVER routed through the normal answer
	// path, dialogue message content, or input.json. Empty/absent means a normal
	// choice or text question (no special handling).
	InputType string           `json:"inputType,omitempty"`
	Options   []QuestionOption `json:"options,omitempty"`
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
		InputType     string           `json:"inputType"`
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
	q.InputType = r.InputType
	q.Options = r.Options
	return nil
}

// QuestionOption is one structured choice on a clarification question.
type QuestionOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Recommended bool   `json:"recommended,omitempty"`
}

// UnmarshalJSON accepts {value,label} (contract), {id,label} (alternate), and a
// plain string ("mock_data" — some models emit options as a bare-value array
// instead of objects). Value falls back to id, then label; a plain string is
// used as BOTH value and label so the option is always pickable. This tolerance
// matches the codebase's other model-variance decoders (SkillPaths/Question/
// FallbackHistory): a shape drift in a non-critical field never hard-fails the
// step (it was previously surfaced as a misleading output_invalid_json).
func (o *QuestionOption) UnmarshalJSON(data []byte) error {
	// Shape C: a plain string — use as both value and label.
	var bare string
	if err := json.Unmarshal(data, &bare); err == nil {
		o.Value = bare
		o.Label = bare
		return nil
	}
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
// requirement_analysis step produces (design §5.1, Task 5). The step primarily
// audits the already-confirmed requirement: field completeness, capability
// boundaries (blueprint refs), and generationProfile. It is still in the user
// clarification allowlist, so high-impact gaps may return structured questions;
// ordinary incomplete/unsupported audit results remain schema failures.
type requirementAnalysisOutput struct {
	NeedsUserInput         bool       `json:"needsUserInput"`
	Questions              []Question `json:"questions"`
	ConfirmedRequirementID string     `json:"confirmedRequirementId"`
	Summary                string     `json:"summary"`
	AppType                string     `json:"appType"`
	AppName                string     `json:"appName"`
	TargetUsers            []string   `json:"targetUsers"`
	CoreScenario           string     `json:"coreScenario"`
	PrimaryView            string     `json:"primaryView"`
	MainEntities           []string   `json:"mainEntities"`
	DataPolicy             string     `json:"dataPolicy"`
	AcceptanceFocus        []string   `json:"acceptanceFocus"`
	// Description carries the optional detailed Chinese paragraph surfaced in
	// the 确认需求摘要. omitempty: existing requirement JSON still validates.
	Description       string              `json:"description,omitempty"`
	GenerationProfile map[string][]string `json:"generationProfile"`
	Constraints       json.RawMessage     `json:"constraints"`
	Risks             json.RawMessage     `json:"risks"`
	// WorkLog is the OPTIONAL public progress log the agent may author. It is
	// the ONLY agent-authored field the executor lifts into summary records.
	// thinking/reasoning and every other hidden provider field are NOT in this
	// struct, so the lenient decoder drops them (boundary locked by contract
	// tests that include both a workLog and a thinking field).
	WorkLog    []workLogEntry        `json:"workLog"`
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
// WAIT for a structured high-impact clarification, SUCCEED
// (validation.complete && validation.supported → the requirement is frozen), or
// FAIL with ErrSchemaValidationFailed for unsupported/incomplete audit results
// that were not expressed as an allowed clarification.
func ValidateRequirementAnalysis(path string) (StepOutput, error) {
	out, _, err := validateRequirementAnalysisDecoded(path)
	return out, err
}

// ValidateRequirementAnalysisWithConfirmedSummary is the requirement-analysis
// boundary gate used by the executor: it decodes+validates the step's output
// AND confirms the frozen requirement the agent produced matches the user-
// confirmed requirement summary that seeded the job (design: requirement-
// consistency contract). A mismatch means the agent drifted from what the user
// accepted in clarification, so the pipeline hard-fails with
// ErrSchemaValidationFailed rather than freezing a divergent requirement. The
// comparison is over the summary-critical fields only (pickRequirementFields);
// audit-only detail (workLog, validation internals, generationProfile) is
// ignored so a faithful freeze that adds audit color still passes.
func ValidateRequirementAnalysisWithConfirmedSummary(path, confirmedRequirementJSON string) (StepOutput, error) {
	out, raw, err := validateRequirementAnalysisDecoded(path)
	if err != nil {
		return StepOutput{}, err
	}
	if out.NeedsUserInput {
		return out, nil
	}
	wantFields := requirementFieldsFromConfirmed(confirmedRequirementJSON)
	want := requirementSummaryChecksum(wantFields)
	got := requirementSummaryChecksum(requirementFieldsFromOutputForConfirmed(raw, wantFields))
	if want != got {
		return StepOutput{}, fmt.Errorf("confirmed requirement consistency mismatch: %w", ErrSchemaValidationFailed)
	}
	return out, nil
}

// validateRequirementAnalysisDecoded is the shared decode+validate core. It
// returns BOTH the StepOutput (the executor-facing projection) AND the decoded
// requirementAnalysisOutput so the consistency check can re-derive its summary
// fields without re-reading the file. Both ValidateRequirementAnalysis (no
// consistency check) and ValidateRequirementAnalysisWithConfirmedSummary route
// through here so the structural rules cannot drift between the two entry
// points.
func validateRequirementAnalysisDecoded(path string) (StepOutput, requirementAnalysisOutput, error) {
	var raw requirementAnalysisOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, raw, err
	}
	if raw.NeedsUserInput || len(raw.Questions) > 0 {
		if len(raw.Questions) == 0 {
			return StepOutput{}, raw, fmt.Errorf("questions required when requirement_analysis needs input: %w", ErrSchemaValidationFailed)
		}
		return StepOutput{NeedsUserInput: true, Questions: raw.Questions}, raw, nil
	}
	normalizeRequirementAnalysisValidation(&raw.Validation)
	if !raw.Validation.Complete || !raw.Validation.Supported {
		return StepOutput{}, raw, fmt.Errorf("confirmed requirement rejected: %w%s",
			ErrSchemaValidationFailed, requirementRejectionDetail(raw.Validation))
	}
	if raw.AppType == "" || raw.AppName == "" || len(raw.GenerationProfile) == 0 {
		return StepOutput{}, raw, fmt.Errorf("missing required requirement fields: %w", ErrSchemaValidationFailed)
	}
	frozen, err := json.Marshal(raw)
	if err != nil {
		return StepOutput{}, raw, err
	}
	return StepOutput{FrozenRequirementJSON: string(frozen)}, raw, nil
}

// requirementFieldsFromConfirmed picks the summary-critical fields out of the
// user-confirmed requirement JSON (the job's ConfirmedRequirementJSON) so they
// can be checksummed against the agent's frozen output. A malformed/empty
// confirmed JSON yields an empty map, which checksums consistently — the gate
// is "did the agent reproduce the confirmed summary", and an empty confirmed
// summary is a real signal a job was created without clarification.
func requirementFieldsFromConfirmed(confirmedRequirementJSON string) map[string]any {
	var doc map[string]any
	_ = json.Unmarshal([]byte(confirmedRequirementJSON), &doc)
	return pickRequirementFields(doc)
}

// requirementFieldsFromOutput projects the decoded frozen-requirement output
// onto the same summary-critical keys the confirmed JSON is picked into, so the
// two go through the identical pickRequirementFields + checksum path. The
// []string slice fields marshal to the same JSON shape as a confirmed JSON
// array, so a matching value compares equal regardless of Go type.
func requirementFieldsFromOutput(raw requirementAnalysisOutput) map[string]any {
	return pickRequirementFields(map[string]any{
		"summary":         raw.Summary,
		"appType":         raw.AppType,
		"appName":         raw.AppName,
		"coreScenario":    raw.CoreScenario,
		"primaryView":     raw.PrimaryView,
		"mainEntities":    raw.MainEntities,
		"dataPolicy":      raw.DataPolicy,
		"acceptanceFocus": raw.AcceptanceFocus,
	})
}

func requirementFieldsFromOutputForConfirmed(raw requirementAnalysisOutput, confirmedFields map[string]any) map[string]any {
	out := requirementFieldsFromOutput(raw)
	// 只校验用户确认 JSON 里真实存在的关键字段。历史/当前澄清结果并不总是
	// 持久化 summary；此时 agent 生成的审计摘要不能反向构成漂移。
	for key := range out {
		if _, ok := confirmedFields[key]; !ok {
			delete(out, key)
		}
	}
	return out
}

// pickRequirementFields keeps only the summary-critical keys the consistency
// check compares: the identity/scenario/interface/data fields the 业务逻辑
// clarification settles. `summary` is EXCLUDED (only the analysis agent produces
// one; the confirmed requirement carries none), so a faithful freeze that adds a
// summary still matches.
func pickRequirementFields(doc map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"appType", "appName", "coreScenario", "primaryView", "mainEntities", "dataPolicy", "acceptanceFocus"} {
		if v, ok := doc[key]; ok {
			out[key] = v
		}
	}
	return out
}

// requirementSummaryChecksum is a stable sha256 of the picked requirement
// fields. json.Marshal on a map[string]any sorts keys, so field order in the
// source JSON does not affect the checksum — only the field values do.
func requirementSummaryChecksum(fields map[string]any) string {
	raw, _ := json.Marshal(fields)
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func normalizeRequirementAnalysisValidation(v *requirementValidation) {
	if v == nil {
		return
	}
	v.MissingFields = blockingRequirementAnalysisMissingFields(v.MissingFields)
	// primaryView/dataPolicy 属于后续界面解析/数据抓取阶段，不能让旧口径
	// 的需求分析 agent 仅因这些延后字段把已确认业务需求判为 incomplete。
	if !v.Complete && len(v.MissingFields) == 0 {
		v.Complete = true
	}
}

func blockingRequirementAnalysisMissingFields(fields []string) []string {
	blocking := make([]string, 0, len(fields))
	for _, field := range fields {
		if isDeferredRequirementAnalysisField(field) {
			continue
		}
		blocking = append(blocking, field)
	}
	return blocking
}

func isDeferredRequirementAnalysisField(field string) bool {
	switch field {
	case "primaryView", "dataPolicy":
		return true
	default:
		return false
	}
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
	return StepOutput{Warnings: disallowedUserInputWarnings("solution_design", raw.NeedsUserInput, raw.Questions)}, nil
}

// designContractOutput mirrors the design_contract step's output.json (Task 8).
// The step is the interface-parsing collaboration producer: it analyzes the
// confirmed requirement + scene references into a structured interface design
// contract (view identification, layout partitioning, component mapping,
// interaction states, responsive constraints, key copy and field presentation).
// On success the executor derives a task-owned interface-preview snapshot from
// DesignDocument + AssumedDataFields — the agent is explicitly forbidden from
// writing preview files itself, so the design contract is the single source the
// deterministic snapshot is built from.
//
// Schema: status (passed|needs_input), summary, needsUserInput/questions (the
// shared clarification contract), designDocument (the structured interface
// design — opaque to the runner, surfaced verbatim to the snapshot),
// assumedDataFields (field names the preview depends on but data capture has
// not yet confirmed), and the shared workLog/warnings.
type DesignContractOutput struct {
	Status            string                  `json:"status"`
	Summary           string                  `json:"summary"`
	NeedsUserInput    bool                    `json:"needsUserInput"`
	Questions         []Question              `json:"questions"`
	DesignDocument    any                     `json:"designDocument"`
	AssumedDataFields model.AssumedDataFields `json:"assumedDataFields"`
	Prototype         model.PrototypeSpec     `json:"prototype"`
	WorkLog           []workLogEntry          `json:"workLog"`
	Warnings          []string                `json:"warnings"`
}

// ValidateDesignContract decodes a design_contract attempt's output.json and
// returns BOTH the executor-facing StepOutput (needsUserInput/questions for the
// waiting-user signal) AND the decoded DesignContractOutput (so the executor
// can build the interface-preview snapshot from designDocument +
// assumedDataFields without re-reading the file). A needsUserInput result
// returns early (no snapshot is built while the step is paused for
// clarification); otherwise a non-empty Summary AND a non-nil DesignDocument
// are required — the snapshot is meaningless without a design, so their absence
// is a schema_validation_failed rather than a silent empty preview.
func ValidateDesignContract(path string) (StepOutput, DesignContractOutput, error) {
	var raw DesignContractOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, raw, err
	}
	if raw.NeedsUserInput {
		return StepOutput{NeedsUserInput: true, Questions: raw.Questions}, raw, nil
	}
	if strings.TrimSpace(raw.Summary) == "" || raw.DesignDocument == nil {
		return StepOutput{}, raw, fmt.Errorf("design summary and designDocument required: %w", ErrSchemaValidationFailed)
	}
	if err := validatePrototypeSpec(raw.Prototype); err != nil {
		return StepOutput{}, raw, err
	}
	return StepOutput{}, raw, nil
}

func validatePrototypeSpec(p model.PrototypeSpec) error {
	if strings.TrimSpace(p.Style) == "" ||
		strings.TrimSpace(p.TargetAudience) == "" ||
		strings.TrimSpace(p.TargetPlatform) == "" ||
		strings.TrimSpace(p.Fidelity) == "" ||
		strings.TrimSpace(p.DefaultPage) == "" ||
		strings.TrimSpace(p.ConfirmationPolicy) == "" {
		return fmt.Errorf("prototype style, targetAudience, targetPlatform, fidelity, defaultPage and confirmationPolicy required: %w", ErrSchemaValidationFailed)
	}
	if len(p.Pages) == 0 {
		return fmt.Errorf("prototype homepage required: %w", ErrSchemaValidationFailed)
	}
	home := p.Pages[0]
	if home.ID != p.DefaultPage || home.ID != "home" || !home.Generated || !home.VisibleByDefault {
		return fmt.Errorf("prototype first page must be generated visible home page: %w", ErrSchemaValidationFailed)
	}
	return nil
}

// FallbackHistory is the ordered fallback-boundary crossings the data_integration
// step records. Models are inconsistent about its shape: some emit an array of
// strings (["ontology→demo: …"]), others an array of objects
// ([{"from":"ontology","to":"demo","reason":"…","userConsented":true}]). This
// tolerant unmarshaler accepts both (and any object array), normalizing objects
// to a stable "from→to：reason" string so the data-contract artifact metadata
// and the workbench see one shape regardless of which model produced the output.
// An unknown element shape is stringified rather than dropped — a crossing is
// never silently lost. This is the data-side counterpart to SkillPaths/Question:
// the decoder absorbs model variance so a shape drift never hard-fails the step.
// fallbackHistoryEntry is the structured shape some models emit for a single
// fallback-boundary crossing ([{from,to,reason,userConsented}]).
type fallbackHistoryEntry struct {
	From          string `json:"from"`
	To            string `json:"to"`
	Reason        string `json:"reason"`
	UserConsented bool   `json:"userConsented"`
}

// normalizeFallbackEntry renders a structured crossing as a readable string.
// The from→to segment is included only when at least one side is present, so an
// empty {"from":"","to":""} collapses to the reason (or the "fallback" sentinel)
// rather than emitting a bare "→".
func normalizeFallbackEntry(e fallbackHistoryEntry) string {
	from := strings.TrimSpace(e.From)
	to := strings.TrimSpace(e.To)
	reason := strings.TrimSpace(e.Reason)
	var s string
	if from != "" || to != "" {
		s = from + "→" + to
	}
	if reason != "" {
		if s != "" {
			s += "："
		}
		s += reason
	}
	if e.UserConsented {
		s += "（用户已确认）"
	}
	if s == "" {
		s = "fallback"
	}
	return s
}

type FallbackHistory []string

func (f *FallbackHistory) UnmarshalJSON(data []byte) error {
	// Shape A: []string — accept verbatim.
	var strs []string
	if err := json.Unmarshal(data, &strs); err == nil {
		*f = strs
		return nil
	}
	// Shape B: []object{from,to,reason,userConsented} — normalize each to a string.
	var objs []fallbackHistoryEntry
	if err := json.Unmarshal(data, &objs); err == nil {
		out := make([]string, 0, len(objs))
		for _, o := range objs {
			out = append(out, normalizeFallbackEntry(o))
		}
		*f = out
		return nil
	}
	// Shape C: []<anything> (mixed/unknown elements) — keep each element's raw
	// JSON text so the array stays non-empty and a crossing is never dropped.
	var raws []json.RawMessage
	if err := json.Unmarshal(data, &raws); err == nil {
		out := make([]string, 0, len(raws))
		for _, r := range raws {
			out = append(out, strings.TrimSpace(string(r)))
		}
		*f = out
		return nil
	}
	// Non-array: a single object {from,to,…} → one entry.
	var single fallbackHistoryEntry
	if err := json.Unmarshal(data, &single); err == nil {
		*f = FallbackHistory{normalizeFallbackEntry(single)}
		return nil
	}
	// Last resort (bare string/number/bool): stringify, never fail the step.
	*f = FallbackHistory{strings.TrimSpace(string(data))}
	return nil
}

// DataIntegrationOutput mirrors the data_integration step's output.json (Task 9).
// The step is the data-capture producer: it validates data sources in a strict
// priority order (ontology first, then internet, then demo) and MUST ask the
// user before crossing a fallback boundary — silent degradation to demo is a
// data-honesty violation the validator rejects. On success the executor derives
// a task-owned data-contract artifact (the agent is forbidden from writing it)
// from DataContract + Verification, keyed by SourceBoundary so the workbench
// can surface which boundary the data came from.
//
// Schema: status (passed|needs_input), summary, sourceBoundary
// (ontology|internet|demo), verification (per-boundary status+reason),
// dataContract (fields + sampleCount), fallbackHistory (the ordered boundary
// crossings the agent recorded), compatibility (the interface-vs-data
// contract gate added in Task 13), needsUserInput/questions (the shared
// clarification contract), and the shared workLog/warnings.
type DataIntegrationOutput struct {
	Status          string            `json:"status"`
	Summary         string            `json:"summary"`
	SourceBoundary  string            `json:"sourceBoundary"`
	Verification    DataVerification  `json:"verification"`
	DataContract    DataContract      `json:"dataContract"`
	FallbackHistory FallbackHistory   `json:"fallbackHistory"`
	Compatibility   DataCompatibility `json:"compatibility"`
	NeedsUserInput  bool              `json:"needsUserInput"`
	Questions       []Question        `json:"questions"`
	WorkLog         []workLogEntry    `json:"workLog"`
}

// DataCompatibility is the interface-vs-data contract gate the data step
// records (Task 13). A confirmed data contract can still be INCOMPATIBLE with
// the interface preview produced earlier (e.g. the contract is missing fields
// the interface assumes). When Status is "failed" the step must surface that
// conflict as a clarification (needsUserInput + question) so the user can
// reconcile the interface; a compatibility failure with NO clarification is a
// silent incompatibility the pipeline hard-rejects — see ValidateDataIntegration.
// MissingFields names the fields the contract lacks; ConfirmedFallbacks lists
// the fallbacks the user has already accepted (so the workbench can show which
// boundary the incompatible contract came from).
type DataCompatibility struct {
	Status             string   `json:"status"`
	MissingFields      []string `json:"missingFields"`
	ConfirmedFallbacks []string `json:"confirmedFallbacks"`
}

// DataVerification is the per-boundary reachability verdict the data step
// records. Each node's status is one of passed|failed|pending; the validator
// does not enforce the enum (the executor surfaces the boundary, not the
// per-node status) but the ontology node's status is the load-bearing signal
// the workbench renders when the ontology boundary is unavailable.
type DataVerification struct {
	Ontology DataVerificationNode `json:"ontology"`
	Internet DataVerificationNode `json:"internet"`
	Demo     DataVerificationNode `json:"demo"`
}

// DataVerificationNode is one boundary's verification result.
type DataVerificationNode struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// DataContract is the field-level contract the data step produces on a passed
// result. Fields is an opaque array (each entry is a field descriptor the agent
// authors); the validator only enforces that a passed result carries at least
// one field — an empty contract on a success is a schema_validation_failed
// because the downstream interface depends on confirmed field names.
type DataContract struct {
	Fields      []map[string]any `json:"fields"`
	SampleCount int              `json:"sampleCount"`
}

// ValidateDataIntegration decodes a data_integration attempt's output.json and
// returns BOTH the executor-facing StepOutput (needsUserInput/questions for the
// waiting-user signal) AND the decoded DataIntegrationOutput (so the executor
// can build the data-contract artifact from sourceBoundary + dataContract
// without re-reading the file).
//
// Validation rules (decision #30/#31 — no silent degradation; Task 13 —
// interface/data compatibility gate):
//   - needsUserInput / status:"needs_input" MUST carry at least one question.
//     A fallback boundary crossing the agent cannot resolve on its own must be
//     surfaced as a clarification, not a silent default — an empty questions
//     array on a needs-input result is ErrSchemaValidationFailed.
//   - sourceBoundary:"demo" is a legitimate terminal boundary, including the
//     stepwise degradation path (ontology fails -> user confirms internet ->
//     internet fails -> user confirms demo), which produces a passed demo
//     result with a NON-empty fallbackHistory. That history IS the audit
//     trace of the user-confirmed degradation and must NOT be rejected.
//     "No silent degradation" (decision #30) is enforced procedurally — the
//     dataIntegrationPrompt requires needsUserInput before each boundary
//     crossing and the executor pauses on it — not by this stateless
//     validator, which cannot distinguish a confirmed degradation from a
//     silent one at the output layer. Rejecting demo+history here would
//     block the spec's intended success path AND incentivize dropping the
//     audit trail.
//   - A passed result MUST carry a non-empty dataContract.fields. An empty
//     contract on success is meaningless downstream, so it hard-fails rather
//     than producing an empty artifact.
//   - A compatibility.Status of "failed" (the confirmed data contract is
//     incompatible with the interface preview) MUST be accompanied by a
//     clarification (needsUserInput). A compatibility failure with no question
//     is a silent incompatibility — the pipeline cannot guess how to reconcile
//     the interface with the contract, so it hard-fails with
//     ErrSchemaValidationFailed rather than continuing to a broken preview.
func ValidateDataIntegration(path string) (StepOutput, DataIntegrationOutput, error) {
	var raw DataIntegrationOutput
	if err := ReadAndDecode(path, &raw); err != nil {
		return StepOutput{}, raw, err
	}
	if raw.NeedsUserInput || strings.EqualFold(raw.Status, "needs_input") {
		if len(raw.Questions) == 0 {
			return StepOutput{}, raw, fmt.Errorf("questions required for data fallback: %w", ErrSchemaValidationFailed)
		}
		return StepOutput{NeedsUserInput: true, Questions: raw.Questions}, raw, nil
	}
	if len(raw.DataContract.Fields) == 0 {
		return StepOutput{}, raw, fmt.Errorf("data contract fields required: %w", ErrSchemaValidationFailed)
	}
	if raw.Compatibility.Status == "failed" && !raw.NeedsUserInput {
		return StepOutput{}, raw, fmt.Errorf("interface data compatibility requires user confirmation: %w", ErrSchemaValidationFailed)
	}
	return StepOutput{}, raw, nil
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

// UnmarshalJSON tolerates the workLog entry shape variance across models:
// {content}, {detail}, {summary}, {message}, {title, summary},
// {step, status, detail}, or a bare string. It captures the most informative
// single text field into Content (the only field the runner models), preferring
// content > detail > summary > message > title. Anything else is stringified so
// a progress entry is never silently dropped — the conversation surface keeps a
// non-empty work log regardless of which model produced the output. This is the
// workLog counterpart to SkillPaths/Question/FallbackHistory.
func (w *workLogEntry) UnmarshalJSON(data []byte) error {
	var bare string
	if err := json.Unmarshal(data, &bare); err == nil {
		w.Content = bare
		return nil
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		// Not a string or object (number/bool/array): stringify the raw token so
		// the entry is captured, never dropped, and never fails the step.
		w.Content = strings.TrimSpace(string(data))
		return nil
	}
	text := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := obj[k].(string); ok {
				if s := strings.TrimSpace(v); s != "" {
					return s
				}
			}
		}
		return ""
	}
	if s := text("content", "detail", "summary", "message", "title", "text", "description"); s != "" {
		w.Content = s
		return nil
	}
	// Fallback: stringify the object so the entry is not silently lost.
	b, _ := json.Marshal(obj)
	w.Content = string(b)
	return nil
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
	out := StepOutput{Warnings: disallowedUserInputWarnings("code_generation", raw.NeedsUserInput, raw.Questions)}
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

func disallowedUserInputWarnings(stage string, needsUserInput bool, questions []Question) []string {
	if !needsUserInput && len(questions) == 0 {
		return nil
	}
	return []string{fmt.Sprintf("%s 阶段不允许向用户提问，已忽略 %d 个澄清问题；后续只能基于已确认需求推断，仍缺失的数据或字段必须在应用中降级展示。", stage, len(questions))}
}
