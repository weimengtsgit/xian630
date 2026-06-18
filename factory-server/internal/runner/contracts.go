package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
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
// the step can complete (design §5.1).
type Question struct {
	ID            string `json:"id"`
	Question      string `json:"question"`
	DefaultAnswer string `json:"defaultAnswer"`
}

// codeGenManifestPath is the path, relative to a generated app projectDir, at
// which the manifest must exist after code_generation (design §5.3, §8).
const codeGenManifestRel = ".factory/app.json"

// readAndDecode reads output.json at path and strict-decodes it into target.
// It maps the two transport-level failures (file gone, bad JSON) onto the
// sentinel errors before any schema/semantic checks run.
func readAndDecode(path string, target any) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s: %w", path, ErrOutputMissing)
		}
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return fmt.Errorf("%s: %w", path, ErrOutputInvalidJSON)
	}
	return nil
}

// requirementAnalysisOutput mirrors the JSON shape in design §5.1. Only the
// fields the contract cares about are listed; unknown fields are rejected by
// DisallowUnknownFields so drift is caught early.
type requirementAnalysisOutput struct {
	Summary        string     `json:"summary"`
	AppType        string     `json:"appType"`
	NeedsUserInput bool       `json:"needsUserInput"`
	Questions      []Question `json:"questions"`
}

// ValidateRequirementAnalysis decodes and sanity-checks the output.json that a
// requirement_analysis attempt produced. A needsUserInput=true result is NOT an
// error: it is returned as StepOutput{NeedsUserInput:true} so the executor can
// move the job into waiting_user.
func ValidateRequirementAnalysis(path string) (StepOutput, error) {
	var raw requirementAnalysisOutput
	if err := readAndDecode(path, &raw); err != nil {
		return StepOutput{}, err
	}
	return StepOutput{NeedsUserInput: raw.NeedsUserInput, Questions: raw.Questions}, nil
}

// solutionDesignOutput mirrors design §5.2. The schema is large; the validator
// only enforces the shape the executor depends on (needsUserInput/questions)
// plus strict decode so an obviously malformed agent response is rejected.
type solutionDesignOutput struct {
	NeedsUserInput bool       `json:"needsUserInput"`
	Questions      []Question `json:"questions"`
}

// ValidateSolutionDesign decodes a solution_design attempt's output.json.
func ValidateSolutionDesign(path string) (StepOutput, error) {
	var raw solutionDesignOutput
	if err := readAndDecode(path, &raw); err != nil {
		return StepOutput{}, err
	}
	return StepOutput{NeedsUserInput: raw.NeedsUserInput, Questions: raw.Questions}, nil
}

// codeGenerationOutput mirrors design §5.3.
type codeGenerationOutput struct {
	ProjectDir     string     `json:"projectDir"`
	NeedsUserInput bool       `json:"needsUserInput"`
	Questions      []Question `json:"questions"`
}

// ValidateCodeGeneration decodes a code_generation attempt's output.json and,
// after a non-needsUserInput result, confirms the app manifest exists at
// <projectDir>/.factory/app.json (design §5.3: "必须生成 .factory/app.json").
// A missing manifest is a schema_validation_failed, not output_missing,
// because the output.json itself was fine.
func ValidateCodeGeneration(path string, projectDir string) (StepOutput, error) {
	var raw codeGenerationOutput
	if err := readAndDecode(path, &raw); err != nil {
		return StepOutput{}, err
	}
	out := StepOutput{NeedsUserInput: raw.NeedsUserInput, Questions: raw.Questions}
	if out.NeedsUserInput {
		return out, nil
	}
	manifest := filepath.Join(projectDir, codeGenManifestRel)
	if _, err := os.Stat(manifest); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, fmt.Errorf("%s: %w", manifest, ErrSchemaValidationFailed)
		}
		return out, fmt.Errorf("stat %s: %w", manifest, err)
	}
	return out, nil
}
