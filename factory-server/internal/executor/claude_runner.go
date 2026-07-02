package executor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/dataaccess"
	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/projectdocs"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// CredentialHandleResolver reports whether an opaque credential handle
// identifies a live (present + unexpired) runtime secret. The executor consults
// it before injecting a credential ref into input.json's
// controlledCredentialRefs so a handle whose value has expired or been evicted
// is dropped rather than surfaced to the agent. The resolver NEVER returns the
// plaintext value — only a boolean availability verdict. Defined in the executor
// package (not imported from server) so unit tests can construct a
// ClaudeStepRunner without pulling in the server; the production wiring sets
// CredentialResolver to the *server.Server (which satisfies this interface).
type CredentialHandleResolver interface {
	CredentialHandleAvailable(handle string) bool
}

type ClaudeStepRunner struct {
	Store              *store.Store
	Workspace          string
	ArtifactRoot       string
	Claude             *runner.ClaudeRunner
	AuditRunner        runner.CommandRunner
	CredentialResolver CredentialHandleResolver
}

// codeGenerationStepOutput is the executor-side decoding of the
// code_generation output.json. It mirrors the runner.codeGenerationOutput
// contract but keeps only the fields the executor needs after validation:
// ProjectDir/CreatedFiles for app registration + file audit. UsedSkills /
// Warnings are validated by runner.ValidateCodeGeneration; they are decoded
// here too so finishCodeGeneration can read ProjectDir/CreatedFiles (the
// validator returns only NeedsUserInput/Questions). Decoded via the shared
// lenient runner.ReadAndDecode, so extra audit fields and prose/```json-wrapped
// output are tolerated — same path the validators use.
type codeGenerationStepOutput struct {
	ProjectDir     string            `json:"projectDir"`
	CreatedFiles   []string          `json:"createdFiles"`
	NeedsUserInput bool              `json:"needsUserInput"`
	Questions      []runner.Question `json:"questions"`
	UsedSkills     runner.SkillPaths `json:"usedSkills"`
	Warnings       []string          `json:"warnings,omitempty"`
}

type collaborationStepSnapshot struct {
	AgentKey       string                  `json:"agentKey"`
	Name           string                  `json:"name"`
	Description    string                  `json:"description"`
	Lane           string                  `json:"lane"`
	Instructions   string                  `json:"instructions"`
	SelectedSkills []string                `json:"selectedSkills"`
	SkillOverrides []collaborationSkillDoc `json:"skillOverrides"`
}

type collaborationSkillDoc struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Scope   string `json:"scope"`
}

type businessDesignHandoff struct {
	Content      json.RawMessage `json:"content,omitempty"`
	Summary      string          `json:"summary,omitempty"`
	ArtifactPath string          `json:"artifactPath,omitempty"`
}

func (c *ClaudeStepRunner) businessDesignHandoff(job model.Job, step model.JobStep) (businessDesignHandoff, error) {
	if step.Kind != model.StepDesignContract {
		return businessDesignHandoff{}, nil
	}
	attempt, err := c.latestRequirementAnalysisAttempt(job.ID)
	if err != nil {
		return businessDesignHandoff{}, err
	}
	path := filepath.ToSlash(filepath.Join("jobs", job.ID, string(model.StepRequirementAnalysis), fmt.Sprintf("attempt-%d", attempt), "output.json"))
	full := filepath.Join(c.artifactRoot(), filepath.FromSlash(path))
	raw, err := os.ReadFile(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return businessDesignHandoff{Summary: "未找到需求分析产物，使用 confirmedRequirement 作为兼容输入。", ArtifactPath: path}, nil
		}
		return businessDesignHandoff{}, err
	}
	return businessDesignHandoff{Content: json.RawMessage(raw), ArtifactPath: path}, nil
}

func (c *ClaudeStepRunner) latestRequirementAnalysisAttempt(jobID string) (int, error) {
	if c.Store != nil {
		step, err := c.Store.GetStepByKind(context.Background(), jobID, model.StepRequirementAnalysis)
		if err != nil {
			return 0, err
		}
		if step != nil && step.Attempt > 0 {
			return step.Attempt, nil
		}
	}
	latest := 1
	dir := filepath.Join(c.artifactRoot(), "jobs", jobID, string(model.StepRequirementAnalysis))
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return latest, nil
		}
		return 0, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "attempt-") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimPrefix(entry.Name(), "attempt-"))
		if err != nil || n <= latest {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, entry.Name(), "output.json")); err == nil {
			latest = n
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	return latest, nil
}

type finalDataAccessInput struct {
	Status               string             `json:"status"`
	Version              string             `json:"version"`
	ResultPath           string             `json:"resultPath"`
	MarkdownPath         string             `json:"markdownPath"`
	RedactedResultPath   string             `json:"redactedResultPath"`
	RedactedMarkdownPath string             `json:"redactedMarkdownPath"`
	Summary              dataaccess.Summary `json:"summary"`
}

func (c *ClaudeStepRunner) Run(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	if emit == nil {
		emit = runner.NopEmitter{}
	}
	// Discover the safe-trace seam from the emitter. The executor's real
	// stepEmitter implements runner.TraceEmitter; NopEmitter and test emitters
	// yield a nop trace path. Every safe trace (assistant observation, tool
	// action, clarification) flows through this seam → server
	// recordAndPublishWorkTrace → the persist-before-publish gate. The runner's
	// stream parser (streamClaudeEvents) reaches the SAME seam via
	// runner.TraceEmitterFrom, so stream-derived tool/observation traces and the
	// clarification trace below share one gated path.
	trace := runner.TraceEmitterFrom(emit)
	switch step.Kind {
	case model.StepRequirementAnalysis, model.StepSolutionDesign, model.StepCodeGeneration,
		model.StepCollaborationOrchestration, model.StepDomainAnalysis, model.StepDesignContract,
		model.StepDataIntegration, model.StepCodeReview, model.StepSecurityReview, model.StepProductAcceptance:
	default:
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "claude runner cannot handle " + string(step.Kind)}, nil
	}
	if c.Claude == nil || c.Claude.Runner == nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "claude runner not configured"}, nil
	}

	ws := runner.AttemptWorkspace{Root: c.artifactRoot(), JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	// confirmedRequirement is fed to the requirement_analysis freeze step. An
	// empty ConfirmedRequirementJSON (legacy/direct-created jobs) would marshal
	// as an empty json.RawMessage and produce invalid JSON, so guard it: use "{}"
	// when the field is blank. Downstream steps ignore this key.
	confirmedReq := json.RawMessage(job.ConfirmedRequirementJSON)
	if len(confirmedReq) == 0 {
		confirmedReq = json.RawMessage("{}")
	}

	// Task 6: surface the project-local skills (+ scene blueprint refs) selected
	// by the confirmed requirement's generationProfile so the generative steps
	// (solution_design, code_generation) load+follow them and report which ones
	// they used. The requirement_analysis freeze step does its own blueprint
	// audit and does not consume these resolved paths, but including them in
	// input.json is harmless (it ignores unknown keys). Resolution is best-effort
	// against the configured workspace root.
	profile, blueprintRefs := parseGenerationProfile(confirmedReq)
	dataPolicy := parseDataPolicy(confirmedReq)
	skillPaths := selectedSkillPaths(c.workspace(), profile)
	blueprintPaths := blueprintRefPaths(c.workspace(), blueprintRefs)
	collaborationSnapshot := parseCollaborationStepSnapshot(step.SnapshotJSON)
	dataAccessInput := c.finalDataAccessInput(job.ID)
	if dataAccessInput == nil && c.stepRequiresFinalDataAccess(ctx, job.ID, step.Kind) {
		return c.failureFromError(fmt.Errorf("finalized data access required before %s: %w", step.Kind, runner.ErrSchemaValidationFailed)), nil
	}

	// Task 12: collect LIVE, REDACTED credential refs for the data_integration
	// step. Each ref exposes ONLY opaque metadata — id/label/scope/handle/expiry
	// — NEVER the plaintext value (that lives in the server's in-memory registry,
	// resolved solely by a future verifier accepting the handle). A ref whose
	// handle is no longer available (expired/evicted, or no resolver wired in
	// unit tests) is dropped. Nil-safe on c.CredentialResolver: the production
	// wiring sets it to *server.Server; executor unit tests construct
	// ClaudeStepRunner without it, in which case this loop is skipped and an
	// empty controlledCredentialRefs array is injected.
	credentialRefs := []map[string]any{}
	if step.Kind == model.StepDataIntegration && job.DialogueID != "" && c.Store != nil {
		refs, _ := c.Store.ListEphemeralCredentialRefs(ctx, job.DialogueID, "data_capture", time.Now())
		for _, ref := range refs {
			if c.CredentialResolver != nil && !c.CredentialResolver.CredentialHandleAvailable(ref.Handle) {
				continue
			}
			credentialRefs = append(credentialRefs, map[string]any{
				"id":        ref.ID,
				"label":     ref.Label,
				"scope":     ref.Scope,
				"handle":    ref.Handle,
				"expiresAt": ref.ExpiresAt,
			})
		}
	}

	businessDesign, err := c.businessDesignHandoff(job, step)
	if err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	input, err := json.MarshalIndent(map[string]any{
		"job":                      job,
		"step":                     step,
		"confirmedRequirement":     confirmedReq,
		"generationProfile":        profile,
		"blueprintRefs":            blueprintRefs,
		"skills":                   skillPaths,
		"blueprintDocs":            blueprintPaths,
		"repairContext":            step.UserPrompt,
		"collaborationSnapshot":    collaborationSnapshot,
		"controlledCredentialRefs": credentialRefs,
		"dataAccess":               dataAccessInput,
		"businessDesign":           businessDesign.Content,
		"businessDesignSummary":    businessDesign.Summary,
		"businessDesignArtifact":   businessDesign.ArtifactPath,
	}, "", "  ")
	if err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	// Snapshot the working tree BEFORE the agent runs so the post-run file
	// audit only flags protected-path changes the agent made THIS run, not the
	// developer's pre-existing dirty files (e.g. in-progress factory-server/,
	// cc-status/ edits) which git status --porcelain would otherwise blame on
	// every code_generation run. Captured for all steps but consumed only by
	// code_generation's audit.
	baseline := c.Claude.BaselineStatus(ctx, c.AuditRunner)
	prompt := c.prompt(job, step, ws, skillPaths, blueprintPaths, dataPolicy)
	if block := finalDataAccessPromptBlock(dataAccessInput, step.Kind); block != "" {
		prompt += block
	}
	if block := collaborationSnapshotPromptBlock(collaborationSnapshot); block != "" {
		prompt += block
	}
	if block := c.prototypeContextPromptBlock(ctx, job.ID, step.Kind); block != "" {
		prompt += block
	}
	if block := c.dataIntegrationUpstreamPromptBlock(ctx, job, step.Kind); block != "" {
		prompt += block
	}
	// step.UserPrompt carries the user's answer when a step is re-run after
	// pausing for clarification (waiting_user → answerJob → SetStepUserPrompt),
	// OR a repair-from-failure instruction. For generative steps we surface it
	// so the agent incorporates the answer instead of re-asking the same
	// question. Without this the re-run is blind (identical input).
	if strings.TrimSpace(step.UserPrompt) != "" &&
		(step.Kind == model.StepSolutionDesign || step.Kind == model.StepCodeGeneration || isCollaborationProducerKind(step.Kind)) {
		prompt += "\n\n[user_input]\n" + step.UserPrompt + "\n"
	}
	mode := runner.ClaudeRunReadOnly
	if step.Kind == model.StepCodeGeneration {
		mode = runner.ClaudeRunWorkspaceWrite
	}
	if step.Kind == model.StepDesignContract {
		mode = runner.ClaudeRunAttemptWrite
	}
	if err := c.Claude.RunWithMode(ctx, ws, prompt, input, mode, emit); err != nil {
		// Even on failure, capture sanitized audit copies of whatever operational
		// files exist (input/prompt are always written by ClaudeRunner.Run before
		// the agent runs; output may or may not exist). Best-effort: a capture
		// error never masks the original run error.
		c.captureAuditArtifacts(ctx, job.ID, step, ws)
		return c.failureFromError(err), nil
	}
	c.captureAuditArtifacts(ctx, job.ID, step, ws)

	switch step.Kind {
	case model.StepRequirementAnalysis:
		out, err := runner.ValidateRequirementAnalysisWithConfirmedSummary(ws.OutputPath(), string(confirmedReq))
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		res := c.resultFromValidatedOutput(ctx, trace, out, ws.OutputPath(), err)
		res = c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res)
		// Surface the projected 需求文档 (docs/01-requirements.md) as a
		// project_document workbench artifact on the business_logic card so the
		// user can open it right after the requirement step. projectDocsAfterStep
		// writes the file under generated-apps/<AppSlug>/docs/, so this is gated
		// on AppSlug (the dialogue confirmation flow reserves it up front).
		if res.Status == model.StepStatusSucceeded && job.AppSlug != "" {
			c.upsertWorkbenchArtifact(ctx, requirementDocumentRef(job, step))
		}
		return res, nil
	case model.StepSolutionDesign:
		out, err := runner.ValidateSolutionDesign(ws.OutputPath())
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		res := c.resultFromValidatedOutput(ctx, trace, out, ws.OutputPath(), err)
		return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
	case model.StepCodeGeneration:
		res := c.finishCodeGeneration(ctx, trace, job, step, ws.OutputPath(), baseline)
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
	case model.StepCodeReview, model.StepSecurityReview, model.StepProductAcceptance:
		// Blocking review gate: decode the gate's JSON status. status:"blocked"
		// → failed with ErrorBlockingReview (the bounded-repair policy treats this
		// as a repairable gate); status:"passed" (or absent) → succeeded. The
		// gate output is produced by the prompt switch's review cases; decoding is
		// lenient (prose/```json-wrapped output tolerated) the same way the
		// generative steps are.
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		res := finishReviewGate(ctx, trace, step, ws.OutputPath())
		return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
	case model.StepDesignContract:
		// Task 8: the design_contract step is the prototype-design producer.
		// Skip output.json validation — only require the prototype/html
		// artifacts the agent wrote inside the attempt directory. The
		// preview-manifest.json and prototype-contract.json become the
		// task-owned workbench artifact ref for the interface_parsing card.
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		{
			bundle, perr := readPrototypeBundle(ws)
			if perr != nil {
				return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed, ErrorMessage: perr.Error()}, nil
			}
			var design runner.DesignContractOutput
			ref, perr := c.createPrototypePreviewArtifact(ctx, job, step, ws, design, bundle)
			if perr != nil {
				return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed, ErrorMessage: perr.Error()}, nil
			}
			c.upsertWorkbenchArtifact(ctx, ref)
			questions := []runner.Question{{
				ID:       "prototype_confirmation",
				Question: "原型设计已生成，请确认原型并继续，或预览后提出修改意见。",
				Options:  []runner.QuestionOption{{Value: "confirm", Label: "确定原型并继续", Recommended: true}, {Value: "revise", Label: "提出修改意见"}},
			}}
			emitClarificationTrace(ctx, trace, questions, nil)
			return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true, Questions: questions}, nil
		}
	case model.StepDataIntegration:
		if dataIntegrationUsesFinalDataAccessContract(ws.OutputPath()) {
			res := c.finishDataIntegration(ctx, trace, job, step, ws.OutputPath())
			c.emitWorkLog(ctx, emit, ws.OutputPath())
			return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
		}
		// Task 9: the data_integration step is the data-capture producer. It
		// enforces the ontology → internet → demo fallback order with explicit
		// user confirmation at each boundary (no silent degradation). On success
		// the executor upserts a task-owned data-contract artifact keyed by the
		// source boundary the data actually came from, so the workbench can
		// render whether the app is wired to ontology, internet, or demo data.
		out, dataDetail, err := runner.ValidateDataIntegration(ws.OutputPath())
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		res := c.resultFromValidatedOutput(ctx, trace, out, ws.OutputPath(), err)
		// F6 + review-round-2: project the data-verification summary onto the
		// data_contract artifact on BOTH success AND needs_input (waiting_user).
		// During the degradation-confirmation wait the workbench data-flow track
		// must render the real per-boundary state (ontology red breakpoint +
		// internet waiting), which requires the verification metadata to exist
		// while the step is paused, not only after it succeeds (spec #32).
		if proj, mErr := dataContractProjection(dataDetail, res.Status); mErr != nil {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed, ErrorMessage: mErr.Error()}, nil
		} else if proj.Project {
			c.upsertWorkbenchArtifact(ctx, model.WorkbenchArtifactRef{
				ID:         "warf_" + id.New(),
				DialogueID: job.DialogueID,
				JobID:      job.ID,
				StepID:     step.ID,
				CardKey:    "data_capture",
				Kind:       model.WorkbenchArtifactDataContract,
				Label:      proj.Label,
				Path:       proj.Path,
				Status:     proj.Status,
				Metadata:   proj.Metadata,
				CreatedAt:  time.Now(),
				UpdatedAt:  time.Now(),
			})
		}
		return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
	default:
		// The remaining admitted gate kinds (collaboration_orchestration,
		// domain_analysis) are analysis/
		// contract producers. Only a small allowlist may pause for user input;
		// other producers must degrade uncertainty into warnings and continue.
		out, err := validateCollaborationProducer(step.Kind, ws.OutputPath())
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		res := c.resultFromValidatedOutput(ctx, trace, out, ws.OutputPath(), err)
		return c.projectDocsAfterStep(ctx, trace, job, step, ws.OutputPath(), res), nil
	}
}

func validateCollaborationProducer(kind model.StepKind, outputPath string) (runner.StepOutput, error) {
	var raw struct {
		Status         string            `json:"status"`
		NeedsUserInput bool              `json:"needsUserInput"`
		Questions      []runner.Question `json:"questions"`
	}
	if err := runner.ReadAndDecode(outputPath, &raw); err != nil {
		return runner.StepOutput{}, err
	}
	needsUserInput := raw.NeedsUserInput || strings.EqualFold(strings.TrimSpace(raw.Status), "needs_input")
	if (needsUserInput || len(raw.Questions) > 0) && !canAskUserInStep(kind) {
		return runner.StepOutput{Warnings: disallowedStepQuestionWarnings(kind, len(raw.Questions))}, nil
	}
	if needsUserInput && len(raw.Questions) == 0 {
		return runner.StepOutput{}, fmt.Errorf("questions required when collaboration step needs input: %w", runner.ErrSchemaValidationFailed)
	}
	return runner.StepOutput{NeedsUserInput: needsUserInput, Questions: raw.Questions}, nil
}

type dataIntegrationStepOutput struct {
	Status             string            `json:"status"`
	NeedsUserInput     bool              `json:"needsUserInput"`
	Questions          []runner.Question `json:"questions"`
	SourceBoundary     string            `json:"sourceBoundary"`
	DataAccessResult   json.RawMessage   `json:"dataAccessResult"`
	DataAccessMarkdown string            `json:"dataAccessMarkdown"`
}

func (o dataIntegrationStepOutput) hasDataAccessResult() bool {
	raw := strings.TrimSpace(string(o.DataAccessResult))
	return raw != "" && raw != "null"
}

func dataIntegrationUsesFinalDataAccessContract(outputPath string) bool {
	var raw dataIntegrationStepOutput
	if err := runner.ReadAndDecode(outputPath, &raw); err != nil {
		return true
	}
	return raw.hasDataAccessResult() || strings.TrimSpace(raw.SourceBoundary) == ""
}

func (c *ClaudeStepRunner) finishDataIntegration(ctx context.Context, trace runner.TraceEmitter, job model.Job, step model.JobStep, outputPath string) StepResult {
	var raw dataIntegrationStepOutput
	if err := runner.ReadAndDecode(outputPath, &raw); err != nil {
		return c.failureFromError(err)
	}
	if !raw.hasDataAccessResult() {
		out, err := validateCollaborationProducer(step.Kind, outputPath)
		return c.resultFromValidatedOutput(ctx, trace, out, outputPath, err)
	}
	if raw.NeedsUserInput || strings.EqualFold(strings.TrimSpace(raw.Status), "needs_input") {
		if len(raw.Questions) == 0 {
			return c.failureFromError(fmt.Errorf("questions required when data integration needs input: %w", runner.ErrSchemaValidationFailed))
		}
		emitClarificationTrace(ctx, trace, raw.Questions, nil)
		return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true, Questions: raw.Questions}
	}
	result, err := normalizeDataAccessResult(raw.DataAccessResult)
	if err != nil {
		return c.failureFromError(err)
	}
	if strings.TrimSpace(result.Stage) == "" {
		result.Stage = "data_access"
	}
	if result.Status == dataaccess.StatusPendingConfirmation {
		if !result.CanFinalize || len(result.BlockingIssues) > 0 {
			return c.failureFromError(fmt.Errorf("data access pending confirmation cannot finalize: %w", runner.ErrSchemaValidationFailed))
		}
		if result.SchemaVersion <= 0 || strings.TrimSpace(result.Version) == "" {
			return c.failureFromError(fmt.Errorf("data access result missing schemaVersion or version: %w", runner.ErrSchemaValidationFailed))
		}
		if !SafeName(result.Version) {
			return c.failureFromError(fmt.Errorf("data access result version must be one safe path segment: %w", runner.ErrSchemaValidationFailed))
		}
		if strings.TrimSpace(raw.DataAccessMarkdown) == "" {
			return c.failureFromError(fmt.Errorf("dataAccessMarkdown required for pending confirmation: %w", runner.ErrSchemaValidationFailed))
		}
		if _, err := dataaccess.WriteVersion(c.artifactRoot(), job.ID, result, raw.DataAccessMarkdown); err != nil {
			return c.failureFromError(fmt.Errorf("write data access version: %w", runner.ErrSchemaValidationFailed))
		}
		c.upsertWorkbenchArtifact(ctx, dataAccessPlanRef(job, step, result))
		questions := []runner.Question{dataAccessSummaryConfirmationQuestion(result)}
		emitClarificationTrace(ctx, trace, questions, nil)
		return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true, Questions: questions}
	}
	return c.failureFromError(fmt.Errorf("dataAccessResult.status must be pending_confirmation when no user input is needed: %w", runner.ErrSchemaValidationFailed))
}

func normalizeDataAccessResult(raw json.RawMessage) (dataaccess.Result, error) {
	var result dataaccess.Result
	if err := json.Unmarshal(raw, &result); err == nil {
		return result, nil
	}
	// dataAccessResult 里有些字段只用于说明和审计，模型可能输出数组、对象或字符串。
	// 这里仅把代码生成依赖的核心字段规范化为强类型，避免说明性字段形状差异阻断流程。
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return dataaccess.Result{}, fmt.Errorf("dataAccessResult is not a JSON object: %w", runner.ErrOutputInvalidJSON)
	}
	result.SchemaVersion = intFromAny(doc["schemaVersion"])
	result.Stage = stringFromAny(doc["stage"])
	result.Version = stringFromAny(doc["version"])
	result.Status = stringFromAny(doc["status"])
	result.CanFinalize = boolFromAny(doc["canFinalize"])
	result.BlockingIssues = stringSliceFromAny(doc["blockingIssues"])
	result.DataAccessMode = stringFromAny(doc["dataAccessMode"])
	result.DataNeeds = normalizeDataNeeds(doc["dataNeeds"])
	result.SourceCandidates = normalizeDataSources(doc["sourceCandidates"])
	result.ProbeResults = normalizeProbeResults(doc["probeResults"])
	result.FieldMappings = normalizeFieldMappings(doc["fieldMappings"])
	result.DegradationPolicy = mapFromAny(doc["degradationPolicy"])
	result.RuntimeArchitecture = mapFromAny(doc["runtimeArchitecture"])
	result.CredentialRefs = normalizeCredentialRefs(doc["credentialRefs"])
	result.SecurityReviewRequired = boolFromAny(doc["securityReviewRequired"])
	result.SecurityReviewReasons = stringSliceFromAny(doc["securityReviewReasons"])
	if cgraw, err := json.Marshal(doc["codegenConstraints"]); err == nil {
		result.CodegenConstraints = cgraw
	}
	result.Summary = normalizeDataAccessSummary(doc["summary"])
	return result, nil
}

func normalizeDataNeeds(v any) []dataaccess.DataNeed {
	items, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]dataaccess.DataNeed, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := firstString(m, "id", "entity", "name", "label")
		name := firstString(m, "name", "label", "entity", "id")
		fields := stringSliceFromAny(m["fields"])
		fields = appendUniqueStrings(fields, fieldsFromDescriptors(m["requiredFields"])...)
		fields = appendUniqueStrings(fields, fieldsFromDescriptors(m["optionalFields"])...)
		out = append(out, dataaccess.DataNeed{
			ID:       id,
			Name:     name,
			Required: boolFromAny(m["required"]),
			Fields:   fields,
			Status:   firstNonEmptyString(stringFromAny(m["status"]), "available"),
		})
	}
	return out
}

func normalizeDataSources(v any) []dataaccess.Source {
	items, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]dataaccess.Source, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, dataaccess.Source{
			ID:           firstString(m, "id", "sourceId"),
			Type:         firstString(m, "type", "sourceType"),
			Label:        stringFromAny(m["label"]),
			Priority:     intFromAny(m["priority"]),
			Verified:     boolFromAny(m["verified"]) || stringFromAny(m["dataPolicy"]) == "mock_data",
			Status:       firstNonEmptyString(stringFromAny(m["status"]), "available"),
			AuthRequired: boolFromAny(m["authRequired"]),
			Coverage:     firstString(m, "coverage", "freshness"),
			Risks:        stringSliceFromAny(m["risks"]),
		})
	}
	return out
}

func normalizeProbeResults(v any) []dataaccess.ProbeResult {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out []dataaccess.ProbeResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

func normalizeFieldMappings(v any) []dataaccess.FieldMapping {
	items, ok := v.([]any)
	if !ok {
		return nil
	}
	out := []dataaccess.FieldMapping{}
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		dataNeedID := firstString(m, "dataNeedId", "entity")
		sourceID := firstString(m, "sourceId", "source")
		if nested, ok := m["mappings"].([]any); ok {
			for _, n := range nested {
				nm, ok := n.(map[string]any)
				if !ok {
					continue
				}
				out = append(out, dataaccess.FieldMapping{
					DataNeedID: dataNeedID,
					UIField:    firstString(nm, "uiField", "targetField", "field"),
					SourceID:   sourceID,
					SourcePath: firstString(nm, "sourcePath", "sourceExpression", "path"),
					Transform:  stringFromAny(nm["transform"]),
				})
			}
			continue
		}
		out = append(out, dataaccess.FieldMapping{
			DataNeedID: dataNeedID,
			UIField:    firstString(m, "uiField", "targetField", "field"),
			SourceID:   sourceID,
			SourcePath: firstString(m, "sourcePath", "sourceExpression", "path"),
			Transform:  stringFromAny(m["transform"]),
		})
	}
	return out
}

func normalizeCredentialRefs(v any) []dataaccess.CredentialRef {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out []dataaccess.CredentialRef
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

func normalizeDataAccessSummary(v any) dataaccess.Summary {
	if s := stringFromAny(v); s != "" {
		return dataaccess.Summary{Confirmed: []string{s}}
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return dataaccess.Summary{}
	}
	var out dataaccess.Summary
	_ = json.Unmarshal(raw, &out)
	return out
}

func fieldsFromDescriptors(v any) []string {
	items, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			if field := firstString(m, "field", "name", "id"); field != "" {
				out = append(out, field)
			}
		}
	}
	return out
}

func stringFromAny(v any) string {
	switch n := v.(type) {
	case string:
		return strings.TrimSpace(n)
	case int:
		return strconv.Itoa(n)
	case int64:
		return strconv.FormatInt(n, 10)
	case float64:
		if n == float64(int64(n)) {
			return strconv.FormatInt(int64(n), 10)
		}
		return strconv.FormatFloat(n, 'f', -1, 64)
	case json.Number:
		return n.String()
	default:
		return ""
	}
}

func boolFromAny(v any) bool {
	b, _ := v.(bool)
	return b
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case json.Number:
		i, _ := strconv.Atoi(n.String())
		return i
	case string:
		s := strings.TrimSpace(n)
		if s == "" {
			return 0
		}
		if i, err := strconv.Atoi(s); err == nil {
			return i
		}
		// 模型偶尔把 schemaVersion 输出成 "1.0.0"；只取首段主版本，避免说明性格式漂移阻断流程。
		if dot := strings.IndexByte(s, '.'); dot > 0 {
			if i, err := strconv.Atoi(s[:dot]); err == nil {
				return i
			}
		}
		return 0
	default:
		return 0
	}
}

func mapFromAny(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func stringSliceFromAny(v any) []string {
	items, ok := v.([]any)
	if !ok {
		if s := stringFromAny(v); s != "" {
			return []string{s}
		}
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s := stringFromAny(item); s != "" {
			out = append(out, s)
			continue
		}
		if m, ok := item.(map[string]any); ok {
			if s := firstString(m, "description", "message", "label", "id"); s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if s := stringFromAny(m[key]); s != "" {
			return s
		}
	}
	return ""
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func appendUniqueStrings(base []string, values ...string) []string {
	seen := make(map[string]bool, len(base)+len(values))
	for _, value := range base {
		seen[value] = true
	}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		base = append(base, value)
		seen[value] = true
	}
	return base
}

func dataAccessSummaryConfirmationQuestion(result dataaccess.Result) runner.Question {
	return runner.Question{
		ID:            "data_access_summary_confirmation",
		Question:      "请确认是否采用本版数据获取方案继续后续生成。",
		DefaultAnswer: result.Version,
		Options: []runner.QuestionOption{
			{Value: "confirm", Label: "确认采用", Recommended: true},
			{Value: "revise", Label: "补充修改"},
		},
	}
}

func canAskUserInStep(kind model.StepKind) bool {
	switch kind {
	case model.StepRequirementAnalysis, model.StepDesignContract, model.StepDataIntegration:
		return true
	default:
		return false
	}
}

func disallowedStepQuestionWarnings(kind model.StepKind, questionCount int) []string {
	return []string{fmt.Sprintf("%s 阶段不允许向用户提问，已忽略 %d 个澄清问题；本阶段只能基于已确认需求、历史对话和上游契约推断，仍缺失的信息必须降级处理。", kind, questionCount)}
}

func parseCollaborationStepSnapshot(raw string) collaborationStepSnapshot {
	var snapshot collaborationStepSnapshot
	if strings.TrimSpace(raw) == "" {
		return snapshot
	}
	_ = json.Unmarshal([]byte(raw), &snapshot)
	return snapshot
}

func (c *ClaudeStepRunner) finalDataAccessInput(jobID string) *finalDataAccessInput {
	if strings.TrimSpace(jobID) == "" {
		return nil
	}
	result, _, err := dataaccess.ReadFinal(c.artifactRoot(), jobID)
	if err != nil || result.Status != dataaccess.StatusFinalized {
		return nil
	}
	base := filepath.Join(c.artifactRoot(), "jobs", jobID, "data-access", "final")
	return &finalDataAccessInput{
		Status:               result.Status,
		Version:              result.Version,
		ResultPath:           filepath.ToSlash(filepath.Join(base, "dataAccessResult.internal.json")),
		MarkdownPath:         filepath.ToSlash(filepath.Join(base, "data-access.internal.md")),
		RedactedResultPath:   filepath.ToSlash(filepath.Join(base, "dataAccessResult.redacted.json")),
		RedactedMarkdownPath: filepath.ToSlash(filepath.Join(base, "data-access.redacted.md")),
		Summary:              result.Summary,
	}
}

func (c *ClaudeStepRunner) stepRequiresFinalDataAccess(ctx context.Context, jobID string, kind model.StepKind) bool {
	if kind != model.StepSolutionDesign && kind != model.StepCodeGeneration {
		return false
	}
	if c.Store == nil {
		return false
	}
	steps, err := c.Store.ListJobSteps(ctx, jobID)
	if err != nil {
		return false
	}
	for _, step := range steps {
		if step.Kind == model.StepDataIntegration {
			return true
		}
	}
	return false
}

func collaborationSnapshotPromptBlock(snapshot collaborationStepSnapshot) string {
	if strings.TrimSpace(snapshot.Instructions) == "" && len(snapshot.SelectedSkills) == 0 && len(snapshot.SkillOverrides) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n[collaboration_agent_snapshot]\n")
	b.WriteString("这是本次生成任务的协作智能体配置快照，只影响当前任务，不写回全局 .claude/skills。执行本阶段时必须优先遵循本快照。\n")
	if strings.TrimSpace(snapshot.Name) != "" {
		b.WriteString("name: ")
		b.WriteString(snapshot.Name)
		b.WriteString("\n")
	}
	if strings.TrimSpace(snapshot.Description) != "" {
		b.WriteString("description: ")
		b.WriteString(snapshot.Description)
		b.WriteString("\n")
	}
	if strings.TrimSpace(snapshot.Instructions) != "" {
		b.WriteString("instructions:\n")
		b.WriteString(snapshot.Instructions)
		b.WriteString("\n")
	}
	if len(snapshot.SelectedSkills) > 0 {
		b.WriteString("selectedSkills:\n")
		for _, skill := range snapshot.SelectedSkills {
			if strings.TrimSpace(skill) == "" {
				continue
			}
			b.WriteString("- ")
			b.WriteString(skill)
			b.WriteString("\n")
		}
	}
	if len(snapshot.SkillOverrides) > 0 {
		b.WriteString("skillOverrides:\n")
		for _, override := range snapshot.SkillOverrides {
			path := strings.TrimSpace(override.Path)
			content := strings.TrimSpace(override.Content)
			if path == "" && content == "" {
				continue
			}
			b.WriteString("--- skill: ")
			b.WriteString(path)
			if strings.TrimSpace(override.Scope) != "" {
				b.WriteString(" scope: ")
				b.WriteString(override.Scope)
			}
			b.WriteString(" ---\n")
			b.WriteString(limitRepairContext(content, 12000))
			b.WriteString("\n")
		}
	}
	return b.String()
}

// emitWorkLog decodes the PUBLIC workLog array from the step's output.json and
// forwards each entry BOTH as a job-scoped summary record (for the task panel /
// drawer) AND as a dialogue-attributed trace (so the structured analysis summary
// reaches the conversation workbench, Task 4). workLog is the ONLY agent-authored
// field that becomes a record or trace — thinking/reasoning and every other
// hidden provider field are deliberately NOT decoded into records or traces (the
// decoder's struct only models workLog, so unknown fields are dropped by
// json.Unmarshal). Best effort: a missing/empty workLog is a no-op, never a
// failure.
//
// The trace is ADDITIVE to the record: the job-scoped ExecutionRecordSummary
// emission is unchanged (it stays for the task panel). Each entry's content is
// also emitted through the SAME trace seam the assistant-text path uses
// (TraceEmitterFrom(emit) → model.WorkTraceAssistant), so it is redacted/capped
// identically by the server's recordAndPublishWorkTrace gate and carries the
// step's DialogueID (dropped for legacy jobs with an empty dialogue id, like every
// other trace). The decoder already caps each entry's bytes via truncateUTF8
// (maxWorkLogEntryBytes), and the gate applies its own cap/redaction too, so this
// path is defense-in-depth safe — and it NEVER emits thinking/thinking_delta
// (workLog has none; the store allowlist would reject it anyway).
func (c *ClaudeStepRunner) emitWorkLog(ctx context.Context, emit runner.StepRecordEmitter, outputPath string) {
	if emit == nil {
		return
	}
	entries := runner.DecodeWorkLog(outputPath)
	if len(entries) == 0 {
		return
	}
	// Discover the trace capability the same way streamClaudeEvents does: the
	// real stepEmitter implements TraceEmitter (and stamps DialogueID/TaskID/
	// StepID/Attempt); NopEmitter and emitters without Trace yield a nop trace.
	trace := runner.TraceEmitterFrom(emit)
	for _, e := range entries {
		_ = emit.Emit(ctx, model.ExecutionRecordSummary, e)
		_ = trace.Trace(ctx, string(model.WorkTraceAssistant), e)
	}
}

// emitClarificationTrace is the Step 3 high-impact-uncertainty trigger. When the
// agent signals NeedsUserInput (it cannot proceed without user clarification),
// it emits a clarification.required trace (WorkTraceClarification) carrying the
// question(s) the user must answer. Low-risk warnings (where the agent made a
// default choice without blocking) emit an assumption.recorded trace
// (WorkTraceAssumption) so they appear in the change summary. Both flow through
// the trace seam → the server's recordAndPublishWorkTrace gate.
//
// The deterministic trigger is NeedsUserInput (the gate-closed signal from the
// validated output). Finer "high-impact vs low-risk" classification is keyed on
// whether questions are present: questions ⇒ clarification (the turn pauses);
// warnings-only ⇒ assumption (the turn continues). trace is a nop when the
// emitter has no trace capability, so this is safe to call unconditionally.
func emitClarificationTrace(ctx context.Context, trace runner.TraceEmitter, questions []runner.Question, warnings []string) {
	if trace == nil {
		return
	}
	if len(questions) > 0 {
		_ = trace.Trace(ctx, string(model.WorkTraceClarification), clarificationPayload(questions))
	}
	for _, w := range warnings {
		if w = strings.TrimSpace(w); w != "" {
			_ = trace.Trace(ctx, string(model.WorkTraceAssumption), assumptionPayload(w))
		}
	}
}

// clarificationPayload builds a JSON payload for a clarification.required trace
// carrying the question text, the agent's suggested default answer, AND the
// structured options the agent offered — the public clarification the user must
// resolve. No tool I/O or reasoning. Options let the conversation UI render a
// pickable card instead of a bare text blob.
func clarificationPayload(questions []runner.Question) string {
	type opt struct {
		Value       string `json:"value,omitempty"`
		Label       string `json:"label,omitempty"`
		Recommended bool   `json:"recommended,omitempty"`
	}
	type q struct {
		ID            string `json:"id,omitempty"`
		Question      string `json:"question"`
		DefaultAnswer string `json:"defaultAnswer,omitempty"`
		InputType     string `json:"inputType,omitempty"`
		Options       []opt  `json:"options,omitempty"`
	}
	out := make([]q, 0, len(questions))
	for _, qq := range questions {
		opts := make([]opt, 0, len(qq.Options))
		for _, o := range qq.Options {
			opts = append(opts, opt{Value: o.Value, Label: o.Label, Recommended: o.Recommended})
		}
		out = append(out, q{ID: qq.ID, Question: qq.Question, DefaultAnswer: qq.DefaultAnswer, InputType: qq.InputType, Options: opts})
	}
	b, err := json.Marshal(struct {
		Questions []q `json:"questions"`
	}{Questions: out})
	if err != nil {
		return `{"questions":[]}`
	}
	return string(b)
}

// assumptionPayload builds a JSON payload for an assumption.recorded trace
// carrying one low-risk warning the agent defaulted on.
func assumptionPayload(warning string) string {
	b, err := json.Marshal(struct {
		Assumption string `json:"assumption"`
	}{Assumption: warning})
	if err != nil {
		return `{"assumption":""}`
	}
	return string(b)
}

// finishReviewGate decodes a blocking-review gate's output.json and maps its
// status field to a StepResult. The gate prompt asks the agent to emit a JSON
// object with a top-level "status" of "passed" or "blocked" (plus optional
// blockingFindings / advisoryFindings arrays). "blocked" → failed with
// ErrorBlockingReview so the bounded-repair policy can rewind to code_generation;
// "passed" (or a missing/empty status) → succeeded. The first blocking finding's
// text becomes the error message so repairReasonKey (kind:code:message) is
// stable for the SAME underlying block. Decoding is lenient via the shared
// runner.ReadAndDecode so prose-wrapped / ```json-fenced output is tolerated.
func finishReviewGate(ctx context.Context, trace runner.TraceEmitter, step model.JobStep, outputPath string) StepResult {
	var raw reviewGateOutput
	if err := runner.ReadAndDecode(outputPath, &raw); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorOutputInvalidJSON, ErrorMessage: err.Error()}
	}
	if strings.EqualFold(raw.Status, "blocked") {
		msg := "blocking review"
		if len(raw.BlockingFindings) > 0 {
			f := raw.BlockingFindings[0]
			if f.Message != "" {
				msg = f.Message
			} else if f.Title != "" {
				msg = f.Title
			}
		}
		// Surface the block as an assumption trace so the dialogue workbench
		// shows what was blocked, then return the blocking-review failure.
		if trace != nil {
			_ = trace.Trace(ctx, string(model.WorkTraceAssumption), reviewBlockedPayload(step, msg))
		}
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorBlockingReview, ErrorMessage: msg}
	}
	return StepResult{Status: model.StepStatusSucceeded, Summary: readStepSummary(outputPath)}
}

// readStepSummary extracts the human-readable `summary` field from a step's
// output.json so the executor can persist it on the job step (→ the workbench's
// agent blocks surface 思考摘要). Lenient: missing/empty/unreadable → "".
func readStepSummary(outputPath string) string {
	var shape struct {
		Summary string `json:"summary"`
	}
	if err := runner.ReadAndDecode(outputPath, &shape); err != nil {
		return ""
	}
	return strings.TrimSpace(shape.Summary)
}

// reviewGateOutput is the decoded shape of a blocking-review gate output.json.
// Only Status + the first blocking finding's text are load-bearing for the
// pass/block decision; advisory findings are decoded so they survive a future
// "advisory-only passed" refinement without re-shaping.
type reviewGateOutput struct {
	Status           string `json:"status"`
	BlockingFindings []struct {
		Title   string `json:"title"`
		Message string `json:"message"`
	} `json:"blockingFindings"`
	AdvisoryFindings []struct {
		Title   string `json:"title"`
		Message string `json:"message"`
	} `json:"advisoryFindings"`
}

func reviewBlockedPayload(step model.JobStep, msg string) string {
	b, err := json.Marshal(struct {
		Gate   string `json:"gate"`
		Reason string `json:"reason"`
	}{Gate: string(step.Kind), Reason: msg})
	if err != nil {
		return `{"gate":"","reason":""}`
	}
	return string(b)
}

func (c *ClaudeStepRunner) finishCodeGeneration(ctx context.Context, trace runner.TraceEmitter, job model.Job, step model.JobStep, outputPath string, baseline map[string]bool) StepResult {
	var raw codeGenerationStepOutput
	// Decode with the SAME lenient path the validators use (runner.ReadAndDecode):
	// output.json is LLM-produced, so it may carry extra audit fields or be
	// wrapped in prose / a ```json fence. The earlier strict decoder
	// (DisallowUnknownFields, from-offset) turned those benign shapes into
	// output_invalid_json (real failure: a plan-mode-blocked agent emitted prose
	// instead of code). projectDir/createdFiles are read here because the
	// validator returns only NeedsUserInput/Questions.
	if err := runner.ReadAndDecode(outputPath, &raw); err != nil {
		return c.failureFromError(err)
	}
	projectDir := filepath.Join(c.workspace(), raw.ProjectDir)
	out, err := runner.ValidateCodeGeneration(outputPath, projectDir)
	if err != nil {
		return c.failureFromError(err)
	}
	if len(out.Warnings) > 0 {
		emitClarificationTrace(ctx, trace, nil, out.Warnings)
	}
	if out.NeedsUserInput {
		// Step 3 (high-impact uncertainty): the agent flagged it cannot proceed
		// without user input. Emit a clarification.required trace BEFORE the
		// waiting transition so the dialogue's work-trace shows the question(s)
		// inline. The existing finalize→MarkStepWaitingUser then leaves the turn
		// waiting. Routed through the gate (persist-before-publish + allowlist).
		emitClarificationTrace(ctx, trace, out.Questions, raw.Warnings)
		return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true, Questions: out.Questions}
	}

	// Honest-data audit: when the confirmed requirement is a real-data policy
	// (live_api / mock_then_api), the generated app must not ship mock or
	// synthetic data. dataPolicy and the declared data skills are parsed from the
	// confirmed requirement carried on the job. A violation fails the step as a
	// schema_validation_failed with the offending file(s).
	confirmedReq := json.RawMessage(job.ConfirmedRequirementJSON)
	if len(bytes.TrimSpace(confirmedReq)) == 0 {
		confirmedReq = json.RawMessage("{}")
	}
	genProfile, _ := parseGenerationProfile(confirmedReq)
	if err := runner.AuditHonestData(projectDir, parseDataPolicy(confirmedReq), genProfile["data"]); err != nil {
		return c.failureFromError(err)
	}
	if err := runner.AuditCarrierOntologyContract(projectDir, parseDataPolicy(confirmedReq), genProfile["data"]); err != nil {
		return c.failureFromError(err)
	}

	if audit := c.AuditRunner; audit != nil {
		files := normalizeCreatedFiles(raw.ProjectDir, raw.CreatedFiles)
		if err := c.Claude.AuditFiles(ctx, audit, job.ID, slugFromProjectDir(raw.ProjectDir), files, baseline); err != nil {
			return c.failureFromError(err)
		}
	}

	app, err := c.applicationFromManifest(raw.ProjectDir)
	if err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed, ErrorMessage: err.Error()}
	}
	if err := c.Store.UpsertApplication(ctx, app); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("upsert app: %v", err)}
	}
	if err := c.Store.SetJobCreatedApp(ctx, job.ID, app.ID, app.Slug, app.Name); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("link job app: %v", err)}
	}
	return StepResult{Status: model.StepStatusSucceeded, Summary: readStepSummary(outputPath)}
}

func (c *ClaudeStepRunner) applicationFromManifest(projectDir string) (model.Application, error) {
	manifestPath := filepath.Join(projectDir, ".factory", "app.json")
	raw, err := os.ReadFile(filepath.Join(c.workspace(), manifestPath))
	if err != nil {
		return model.Application{}, fmt.Errorf("read manifest %s: %w", manifestPath, err)
	}
	m, err := scanner.ParseManifest(raw)
	if err != nil {
		return model.Application{}, err
	}
	relManifestPath := filepath.ToSlash(manifestPath)
	if err := scanner.ValidateManifest(relManifestPath, m); err != nil {
		return model.Application{}, err
	}
	now := time.Now()
	return model.Application{
		ID:           "app-" + m.Slug,
		Slug:         m.Slug,
		Name:         m.Name,
		Type:         m.Type,
		Source:       model.AppSource(m.Source),
		Description:  m.Description,
		Path:         m.Path,
		ManifestPath: relManifestPath,
		Status:       model.AppStatusStopped,
		CreatedAt:    now,
		UpdatedAt:    now,
	}, nil
}

func (c *ClaudeStepRunner) resultFromValidatedOutput(ctx context.Context, trace runner.TraceEmitter, out runner.StepOutput, outputPath string, err error) StepResult {
	if err != nil {
		return c.failureFromError(err)
	}
	if out.NeedsUserInput {
		// Step 3 (high-impact uncertainty): emit clarification.required before
		// the waiting transition. See finishCodeGeneration for the rationale.
		emitClarificationTrace(ctx, trace, out.Questions, nil)
		return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true, Questions: out.Questions}
	}
	if len(out.Warnings) > 0 {
		emitClarificationTrace(ctx, trace, nil, out.Warnings)
	}
	return StepResult{Status: model.StepStatusSucceeded, FrozenRequirementJSON: out.FrozenRequirementJSON, Summary: readStepSummary(outputPath)}
}

func (c *ClaudeStepRunner) failureFromError(err error) StepResult {
	code := model.ErrorUnknown
	switch {
	case errors.Is(err, runner.ErrRunnerExitNonzero):
		code = model.ErrorRunnerExitNonzero
	case errors.Is(err, runner.ErrOutputMissing):
		code = model.ErrorOutputMissing
	case errors.Is(err, runner.ErrOutputInvalidJSON):
		code = model.ErrorOutputInvalidJSON
	case errors.Is(err, runner.ErrSchemaValidationFailed):
		code = model.ErrorSchemaValidationFailed
	case errors.Is(err, runner.ErrFileConstraintViolated):
		code = model.ErrorFileConstraintViolated
	}
	return StepResult{Status: model.StepStatusFailed, ErrorCode: code, ErrorMessage: err.Error()}
}

func (c *ClaudeStepRunner) projectDocsAfterStep(ctx context.Context, trace runner.TraceEmitter, job model.Job, step model.JobStep, outputPath string, res StepResult) StepResult {
	if res.Status != model.StepStatusSucceeded || c.Store == nil {
		return res
	}
	root := ""
	if step.Kind == model.StepCodeGeneration {
		var out struct {
			ProjectDir string `json:"projectDir"`
		}
		if err := runner.ReadAndDecode(outputPath, &out); err == nil && out.ProjectDir != "" {
			root = filepath.Join(c.Workspace, filepath.FromSlash(out.ProjectDir))
		}
	}
	if root == "" {
		jobID := job.ApplicationID
		if jobID == "" {
			jobID = job.CreatedAppID
		}
		if jobID != "" {
			if app, err := c.Store.GetApplication(ctx, jobID); err == nil && app != nil && app.Path != "" {
				root = filepath.Join(c.Workspace, filepath.FromSlash(app.Path))
			}
		}
	}
	if root == "" && job.AppSlug != "" {
		root = filepath.Join(c.Workspace, "generated-apps", filepath.FromSlash(job.AppSlug))
	}
	if root != "" {
		_ = os.MkdirAll(filepath.Join(root, "docs"), 0o755)
	}
	if root == "" {
		return res
	}
	artifactID := ""
	artifacts, _ := c.Store.ListArtifactsByJob(ctx, job.ID)
	for _, art := range artifacts {
		if art.Kind == "output_json" && art.StepID == step.ID && art.Attempt == step.Attempt {
			artifactID = art.ID
			break
		}
	}
	if _, err := (projectdocs.Generator{}).ProjectStep(projectdocs.Source{ProjectRoot: root, JobID: job.ID, StepID: step.ID, Attempt: step.Attempt, AgentKey: step.AgentKey, StepKind: string(step.Kind), SourceArtifactID: artifactID, OutputPath: outputPath}); err != nil && trace != nil {
		_ = trace.Trace(ctx, string(model.WorkTraceWarning), `{"message":"project document projection failed"}`)
	}
	return res
}

// captureAuditArtifacts writes REDACTED, capped audit copies of the attempt's
// operational files and registers ONLY those copies as artifacts. The
// operational input.json / prompt.md / output.json / output.md stay
// byte-for-byte intact on disk — Claude execution and runner.Validate* depend
// on their exact bytes — so we never overwrite them and never register them
// directly. Copies land under <dir>/audit/. stdout.log / stderr.log are
// audit-only command logs: they are rewritten in place as redacted+capped
// files (their original bytes are not consumed by validation). All steps are
// best-effort: a capture error on one file does not abort the others, and none
// of this masks the step's real success/failure result.
func (c *ClaudeStepRunner) captureAuditArtifacts(ctx context.Context, jobID string, step model.JobStep, ws runner.AttemptWorkspace) {
	reg := &artifactRegistrar{store: c.Store, jobID: jobID, step: step}
	if reg.store == nil {
		return
	}
	// Operational contract files -> redacted copies under audit/, registered.
	_ = reg.registerRedactedCopy(ctx, "input_json", ws.InputPath(), ws.AuditPath("input.json"), "Claude step input contract (redacted)")
	_ = reg.registerRedactedCopy(ctx, "prompt_markdown", ws.PromptPath(), ws.AuditPath("prompt.md"), "Claude step prompt (redacted)")
	_ = reg.registerRedactedCopy(ctx, "output_json", ws.OutputPath(), ws.AuditPath("output.json"), "Claude step output contract (redacted)")
	if _, err := os.Stat(ws.OutputMDPath()); err == nil {
		_ = reg.registerRedactedCopy(ctx, "output_markdown", ws.OutputMDPath(), ws.AuditPath("output.md"), "Claude human-readable step output (redacted)")
	}
	// F3: command_STDOUT is deliberately NOT registered for Claude steps. With
	// Task 3's `--include-partial-messages --verbose` stream-json flags the raw
	// stdout is NDJSON that includes hidden thinking/thinking_delta events (the
	// model's private chain of thought). redactExecutionText only strips
	// credentials, NOT thinking, so registering stdout.log as a portal-readable
	// artifact would expose hidden reasoning — the design explicitly forbids
	// this ("不得展示隐藏 reasoning"). The SAFE audit trail for Claude stdout
	// already exists as `activity` records (tool_use, captured live by
	// streamClaudeEvents) and `summary` records (the public workLog from
	// output.json); the final public answer lands in output.json (registered
	// above as output_json, now the safe extracted result via F2). stdout.log
	// still exists on disk for server-side diagnostics; it just is not a
	// portal-readable artifact. stderr is kept: it is CLI diagnostics with no
	// model thinking.
	c.captureCommandLog(ctx, reg, "command_stderr", ws.StderrPath(), "Claude process stderr (redacted, capped)")
}

// captureCommandLog reads an audit-only command log, rewrites it in place as a
// redacted+capped file, and registers it. Reading-then-rewriting is safe here
// because stdout.log/stderr.log are never consumed as operational input by
// validation or Claude execution — they exist purely for audit.
func (c *ClaudeStepRunner) captureCommandLog(ctx context.Context, reg *artifactRegistrar, kind, path, summary string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return // missing log is fine (step may not have produced one)
	}
	_ = reg.registerCappedLog(ctx, kind, path, raw, false, summary)
}

func (c *ClaudeStepRunner) prompt(job model.Job, step model.JobStep, ws runner.AttemptWorkspace, skillPaths, blueprintPaths []string, dataPolicy string) string {
	if step.Kind == model.StepRequirementAnalysis {
		return "You are the software-factory requirement_analysis agent.\n" +
			"Read confirmedRequirement from input.json and freeze it into a single final JSON object.\n" +
			"Validate field completeness, capability boundaries, generationProfile, and blueprintRefs used only as reference scene docs. Record unsupported or out-of-scope asks in validation.unsupportedRequests.\n" +
			"Completeness is for business-confirmation fields only: appType, appName, targetUsers, coreScenario, mainEntities, acceptanceFocus, generationProfile. Do not mark validation.complete=false only because primaryView or dataPolicy is empty; those are deferred to interface/data stages and may remain empty.\n" +
			"Return exactly one raw JSON object with these top-level fields: confirmedRequirementId, summary, description, appType, appName, targetUsers, coreScenario, primaryView, mainEntities, dataPolicy, acceptanceFocus, generationProfile, constraints, risks, validation.\n" +
			"The validation object must contain: complete, supported, missingFields, unsupportedRequests.\n" +
			"Populate `description` with a concise Simplified-Chinese paragraph detailing the confirmed requirement (目标、范围、关键能力); mirror it from the confirmedRequirement when present, otherwise synthesize it from the requirement fields. Do not omit it.\n" +
			"All human-readable string values must be Simplified Chinese. This includes summary, scenario text, view descriptions, entity names, constraints, risks, and unsupported-request explanations. Only identifiers, slugs, enum keys, file paths, and code symbols may remain non-Chinese.\n" +
			"Only when a high-impact requirement decision cannot be inferred from prior dialogue or confirmedRequirement may you output needsUserInput=true with structured questions. Otherwise do not ask clarifying questions. Do not output markdown. Do not use code fences.\n" +
			"Do not call ExitPlanMode. Do not describe what you plan to do. Do not modify workspace files; only write the final JSON object to output.json at: " + absolutePath(ws.OutputPath()) + ".\n" +
			"If the requirement is incomplete, set validation.complete=false. If the request exceeds supported capability, set validation.supported=false.\n" +
			"The output.json file must contain raw JSON only. The final assistant message may be a short confirmation."
	}
	if step.Kind == model.StepSolutionDesign {
		return "你是软件工厂的方案设计 agent。读取 input.json，基于用户需求输出方案设计。必须把最终 JSON 对象写入 output.json：" + absolutePath(ws.OutputPath()) + "。output.json 不要 Markdown，不要代码块，不要输出隐藏推理链。最终 assistant 消息可以只给简短确认。JSON 格式必须包含 needsUserInput、questions、usedSkills，可包含 app、artifactPlan、warnings；不需要用户补充信息时 needsUserInput=false 且 questions=[]。所有供人阅读的输出字段必须使用简体中文，包括 questions、app 摘要、artifactPlan 描述、warnings、说明文案；只有标识符、slug、路径、枚举值、代码符号可保留非中文。" +
			"方案设计阶段不允许向用户提问：必须固定输出 needsUserInput=false 且 questions=[]。如果信息不足，只能基于已确认需求、历史对话、generationProfile、skills 和 blueprintDocs 做保守推断；仍缺失的数据字段、外部来源或能力必须写入 warnings，并在方案中设计降级态，不得把任务暂停给用户澄清。" +
			"如果 prompt 末尾出现 [user_input] 段落，那是历史回答或修复上下文，只能用于推进方案，不得继续追问。" +
			"用户需求：" + job.UserPrompt +
			skillsPromptBlock(skillPaths, blueprintPaths, dataPolicy)
	}
	if step.Kind == model.StepCodeGeneration {
		return "你是软件工厂的代码生成 agent。你的工作目录就是软件工厂仓库根目录。只能在 generated-apps/<slug>/ 下生成静态 Vite 应用和 .factory/app.json，禁止在 factory-server/generated-apps/ 或其他目录生成文件。" +
			"工作区根目录：" + c.workspace() + "。读取输入文件：input.json 路径：" + absolutePath(ws.InputPath()) + "。" +
			"output.json 必须写入：output.json 路径：" + absolutePath(ws.OutputPath()) + "；可选生成摘要写入：output.md 路径：" + absolutePath(ws.OutputMDPath()) + "。" +
			"output.json 必须包含 projectDir、createdFiles、needsUserInput、questions、usedSkills（可含 warnings）；projectDir 和 createdFiles 必须使用仓库相对路径。" +
			"代码生成阶段不允许向用户提问：必须固定输出 needsUserInput=false 且 questions=[]。如果仍缺少数据字段、接口字段、坐标、时间范围或外部来源，只能基于已确认需求和上游数据接入结论生成降级态；不得失败结束，也不得等待用户澄清。" +
			".factory/app.json 必须是以下 Factory manifest 契约：schemaVersion 为 1，slug 为 <slug>，name 非空，source 为 generated，entry 为 static-vite，path 为 generated-apps/<slug>，并包含 build{command:npm run build,outputDir:dist}、runtime{devCommand:npm run dev,defaultPort:5173}、docker{enabled:true,dockerfile:Dockerfile,context:.,runtimePort:80}。" +
			"manifest JSON 字段必须包含 \"schemaVersion\": 1、\"entry\": \"static-vite\"、\"path\": \"generated-apps/<slug>\"；不要使用 deployment 或 ports 代替 build/runtime/docker。" +
			"nginx.conf 必须可直接启动：不要在 conf.d/*.conf 中写 ${ENV_VAR}、$ENV_VAR 或未定义 nginx 变量；如需代理鉴权，前端应以缺失凭据的诚实错误态处理，不要让 nginx 因 unknown variable 启动失败。" +
			"面向用户的页面文案、标题、标签、图表说明、详情说明，以及 output.json / output.md 中的人类可读文本，默认必须使用简体中文；只有标识符、slug、路径、枚举值、代码符号可以保留非中文。" +
			"不要输出隐藏推理链。" +
			skillsPromptBlock(skillPaths, blueprintPaths, dataPolicy)
	}
	if isCollaborationProducerKind(step.Kind) {
		return collaborationProducerPrompt(job, step, ws)
	}
	switch step.Kind {
	case model.StepRequirementAnalysis:
		return "你是软件工厂的需求冻结 agent。读取 input.json 中的 confirmedRequirement，校验字段完整性、能力边界和 generationProfile。" +
			"AUDIT blueprintRefs（确认引用的 skill 存在于 .claude/skills/requirement-clarification/blueprints.json 且为 reference-only），将任何超出现有 skill 目录支持的请求记入 validation.unsupportedRequests。" +
			"完整性只检查业务确认字段：appType、appName、targetUsers、coreScenario、mainEntities、acceptanceFocus、generationProfile。primaryView 和 dataPolicy 属于后续界面解析/数据抓取阶段，可为空，不能仅因它们缺失设置 validation.complete=false。" +
			"输出 output.json，包含 confirmedRequirementId、summary、description、appType、appName、targetUsers、coreScenario、primaryView、mainEntities、dataPolicy、acceptanceFocus、generationProfile、constraints、risks、validation（含 complete、supported、missingFields、unsupportedRequests）。description 用简体中文写一段概括确认需求的详细说明（覆盖目标、范围、关键能力），confirmedRequirement 已带 description 时原样保留，否则据需求字段综合生成，不要省略。" +
			"只有当高影响需求决策无法从历史对话和 confirmedRequirement 推断时，才允许输出 needsUserInput=true 和结构化 questions；否则不要提问。不要输出隐藏推理链。需求不完整或超出现有能力时，validation.complete=false 或 validation.supported=false。必须把最终 JSON 对象写入 output.json：" + absolutePath(ws.OutputPath()) + "。文件不要 Markdown，不要代码块；最终 assistant 消息可以只给简短确认。"
	case model.StepSolutionDesign:
		return "你是软件工厂的方案设计 agent。读取 input.json，基于用户需求输出方案设计。必须把最终 JSON 对象写入 output.json：" + absolutePath(ws.OutputPath()) + "。文件不要 Markdown，不要代码块，不要隐藏推理链；最终 assistant 消息可以只给简短确认。JSON 格式必须包含 needsUserInput、questions、usedSkills，可包含 app 和 artifactPlan、warnings；方案设计阶段不允许向用户提问，必须输出 needsUserInput=false 且 questions=[]。缺失信息只能基于上游契约推断或设计降级态。\n用户需求：" + job.UserPrompt +
			skillsPromptBlock(skillPaths, blueprintPaths, dataPolicy)
	case model.StepCodeGeneration:
		return "你是软件工厂的代码生成 agent。你的工作目录就是软件工厂仓库根目录。只能在 generated-apps/<slug>/ 下生成静态 Vite 应用和 .factory/app.json，禁止在 factory-server/generated-apps/ 或其他目录生成文件。" +
			"工作区根目录：" + c.workspace() + "。读取输入文件：input.json 路径：" + absolutePath(ws.InputPath()) + "。" +
			"output.json 必须写入：output.json 路径：" + absolutePath(ws.OutputPath()) + "；可选生成摘要写入：output.md 路径：" + absolutePath(ws.OutputMDPath()) + "。" +
			"output.json 必须包含 projectDir、createdFiles、needsUserInput、questions、usedSkills（可含 warnings）；projectDir 和 createdFiles 必须使用仓库相对路径。" +
			"代码生成阶段不允许向用户提问，必须输出 needsUserInput=false 且 questions=[]；缺失字段或数据只能生成降级态，不得等待用户澄清。" +
			".factory/app.json 必须是以下 Factory manifest 契约：schemaVersion 为 1，slug 为 <slug>，name 非空，source 为 generated，entry 为 static-vite，path 为 generated-apps/<slug>，并包含 build{command:npm run build,outputDir:dist}、runtime{devCommand:npm run dev,defaultPort:5173}、docker{enabled:true,dockerfile:Dockerfile,context:.,runtimePort:80}。" +
			"manifest JSON 字段必须包含 \"schemaVersion\": 1、\"entry\": \"static-vite\"、\"path\": \"generated-apps/<slug>\"；不要使用 deployment 或 ports 代替 build/runtime/docker。" +
			"nginx.conf 必须可直接启动：不要在 conf.d/*.conf 中写 ${ENV_VAR}、$ENV_VAR 或未定义 nginx 变量；如需代理鉴权，前端应以缺失凭据的诚实错误态处理，不要让 nginx 因 unknown variable 启动失败。" +
			"不要输出隐藏推理链。" +
			skillsPromptBlock(skillPaths, blueprintPaths, dataPolicy)
	case model.StepCodeReview:
		return "你是软件工厂的代码审查门禁。只输出 JSON：{\"blockingFindings\":[],\"advisoryFindings\":[],\"status\":\"passed|blocked\"}。只有影响正确性、可部署性、数据诚实、安全或确认用户行为的问题可以 blocking。"
	case model.StepProductAcceptance:
		return "你是软件工厂的产品验收智能体。对照确认需求摘要、设计契约、数据契约和主要用户流程验收。只输出 JSON：{\"blockingFindings\":[],\"advisoryFindings\":[],\"status\":\"passed|blocked\"}。"
	case model.StepSecurityReview:
		return "你是软件工厂的安全审查智能体。检查公网数据、认证、上传、外部接口、敏感数据、权限和暴露部署面。只输出 JSON：{\"blockingFindings\":[],\"advisoryFindings\":[],\"status\":\"passed|blocked\"}。"
	default:
		return job.UserPrompt
	}
}

func isCollaborationProducerKind(kind model.StepKind) bool {
	switch kind {
	case model.StepCollaborationOrchestration, model.StepDomainAnalysis, model.StepDesignContract, model.StepDataIntegration:
		return true
	default:
		return false
	}
}

func collaborationProducerPrompt(job model.Job, step model.JobStep, ws runner.AttemptWorkspace) string {
	// Task 8: the design_contract step is the interface-parsing producer. It has
	// a specialized contract (designDocument + assumedDataFields) the generic
	// collaboration prompt does not surface, and it is explicitly forbidden from
	// writing preview files — the executor builds the task-owned snapshot from
	// its designDocument. Route it to the dedicated prompt before the generic
	// body. (data_integration gets its own branch in Task 9.)
	if step.Kind == model.StepDesignContract {
		return designContractPrompt(job, ws)
	}
	if step.Kind == model.StepDataIntegration {
		return dataIntegrationPrompt(job, ws)
	}
	questionPolicy := "本阶段不允许向用户提问：必须输出 needsUserInput=false 且 questions=[]；如果信息不足，只能基于已确认需求、历史对话和上游契约推断，仍缺失的信息写入 warnings 并降级处理。"
	if canAskUserInStep(step.Kind) {
		questionPolicy = "本阶段允许在高影响事项无法从已确认需求、历史对话和上游契约推断时提问；需要用户确认时输出 needsUserInput=true、status=\"needs_input\"，questions 必须是结构化数组。"
	}
	return "你是软件工厂的" + collaborationProducerName(step.Kind) + "协作智能体。读取 input.json，基于 confirmedRequirement、generationProfile、skills、blueprintDocs、collaborationSnapshot 产出本阶段的结构化结论。" +
		"不要修改仓库文件，除当前 output.json 外不要写其他文件；不要调用 ExitPlanMode，不要输出隐藏推理链。" +
		"必须把最终 JSON 对象写入 output.json：" + absolutePath(ws.OutputPath()) + "。文件不要 Markdown，不要代码块，不要在 JSON 前后添加解释文字；最终 assistant 消息可以只给简短确认。" +
		"output.json 路径：" + absolutePath(ws.OutputPath()) + "。" +
		"JSON 必须包含：status、summary、needsUserInput、questions、workLog、warnings。" +
		"status 只能是 passed 或 needs_input；不需要用户补充时 needsUserInput=false 且 questions=[]。" +
		questionPolicy +
		"若本阶段允许提问，questions 每项必须包含 id、question、options；options 每项包含 value、label，可包含 recommended:true。" +
		"如果 prompt 末尾出现 [user_input] 段落，那是用户对上一轮协作澄清的回答，必须据此推进，不要重复提出已回答过的问题。" +
		"workLog 必须是面向用户的简短过程摘要数组，每项包含 title 和 summary；warnings 用于记录非阻塞风险。" +
		"所有人类可读文本必须使用简体中文；只有标识符、路径、枚举值和代码符号可以保留英文。" +
		"用户需求：" + job.UserPrompt
}

// designContractPrompt is the specialized prompt for the design_contract
// (prototype design) collaboration producer. It routes the agent to the
// prototype-design skill, feeds businessDesign as the primary input, and
// constrains the agent to writing files only inside the attempt directory.
func designContractPrompt(job model.Job, ws runner.AttemptWorkspace) string {
	return "你是软件工厂的原型设计协作智能体，运行在用户可见的界面解析阶段。先 Read 并严格遵循项目本地 skill：.claude/skills/prototype-design/SKILL.md。" +
		"读取 input.json，其中 businessDesign 是原型设计的主输入，来自业务智能体完整设计方案；confirmedRequirement 只作为边界与一致性校验，不能替代完整设计方案。" +
		"如果 businessDesign 缺失，只能使用 confirmedRequirement 兼容推进，并在 warnings 记录降级原因。" +
		"需要在原型风格、目标用户、目标平台或保真度缺失、冲突、影响验收时，输出 status=\"needs_input\"、needsUserInput=true 和结构化 questions。" +
		"默认 fidelity=static，targetPlatform=responsive，prototype 必须描述静态原型页面方案，默认首页为 home。" +
		"允许在当前 attempt 目录下写入 prototype/index.html、prototype/styles.css、prototype/preview-manifest.json、prototype/prototype-contract.json；禁止写入仓库工作目录或最终应用目录，禁止调用 Bash。" +
		"必须把最终 JSON 对象写入 output.json：" + absolutePath(ws.OutputPath()) + "。文件不要 Markdown，不要代码块；最终 assistant 消息可以只给简短确认。" +
		"JSON 必须包含：status、summary、needsUserInput、questions、designDocument、assumedDataFields、prototype、workLog、warnings。" +
		"designDocument 与 prototype 必须描述同一套页面设计；如用户后续确认原型，预览将成为后续验收基线。" +
		"所有人类可读文本必须使用简体中文；只有标识符、路径、枚举值和代码符号可以保留英文。用户需求：" + job.UserPrompt
}

// dataIntegrationPrompt is the specialized prompt for the data_integration
// (data-capture) collaboration producer. It enforces the data-capture fallback
// contract (decision #30/#31): ontology boundary first, then internet, then
// demo, and the agent MUST ask before crossing a fallback boundary — silent
// degradation is forbidden. controlledCredentialRefs is referenced in the
// input description for forward-compatibility (Task 12 injects controlled
// credential handles); the prompt string is correct as-is even though the
// field is not injected into input.json yet, because the agent tolerates a
// missing optional input key.
func dataIntegrationPrompt(job model.Job, ws runner.AttemptWorkspace) string {
	return "你是软件工厂的数据接入协作智能体。读取 input.json，必须基于 confirmedRequirement；interfaceDesign/blueprintDocs 如存在只作为数据槽位补充，不存在也可以完成数据接入；controlledCredentialRefs 如存在只能按 handle 引用，不能要求或输出明文密钥。" +
		"目标是判断本次需求需要哪些数据、从哪里获取、是否真实可用、字段是否满足、失败时如何降级，并产出数据获取方案草案和用户确认摘要。" +
		"真实数据判断必须基于小样本真实探测或实际联网访问证据，不能只靠模型记忆；探测边界：单源最多 3 次请求、单次超时 30 秒、总请求不超过 20 次、单响应样例最多 20KB、爬取最多 1-2 个页面样本，禁止绕过登录/验证码/反爬。" +
		"数据源优先级：用户提供接口/鉴权、本体数据、公网官方 API/开放数据接口、公开网页爬取/搜索整理、不填/本次不接入、mock。mock 只能在用户明确选择时使用，不能自动从真实数据失败降级到 mock。" +
		"当业务口径、鉴权、核心字段、是否 mock、是否不填等阻断事项无法判断时，输出 needsUserInput=true、status=\"needs_input\" 并只提出具体阻断问题；凭证类澄清问题必须设置 inputType:\"credential\"。" +
		"当可以闭环时，输出 needsUserInput=false、status=\"passed\"，并必须包含 dataAccessResult 和 dataAccessMarkdown。dataAccessResult.status 必须是 pending_confirmation，canFinalize=true，blockingIssues=[]。" +
		"dataAccessResult 必须包含 schemaVersion、stage=data_access、version、status、canFinalize、blockingIssues、sourceInputs、dataAccessMode、dataNeeds、sourceCandidates、probeResults、fieldMappings、degradationPolicy、runtimeArchitecture、credentialRefs、securityReviewRequired、securityReviewReasons、codegenConstraints、summary。" +
		"强契约类型：schemaVersion 必须是数字 1，version 必须是字符串版本号（例如 \"1.0.0\"），不能把 schemaVersion 写成 \"1.0.0\"，不能把 version 写成数字。" +
		"dataAccessMarkdown 必须使用固定章节：# 数据获取方案、1 输入依据、2 数据需求、3 数据源候选、4 探测记录、5 字段映射、6 满足度结论、7 降级与空态策略、8 代码生成输入、9 待用户确认摘要。" +
		"内部 dataAccessResult 可包含用户提供的完整鉴权值或 handle 供后续代码生成使用；但 summary、workLog、warnings、用户可见文本中不得泄漏 token/cookie/password 等敏感值。" +
		"必须把最终 JSON 对象写入 output.json：" + absolutePath(ws.OutputPath()) + "。文件不要 Markdown，不要代码块，不要隐藏推理链；最终 assistant 消息可以只给简短确认。用户需求：" + job.UserPrompt
}

func finalDataAccessPromptBlock(input *finalDataAccessInput, kind model.StepKind) string {
	if input == nil || (kind != model.StepSolutionDesign && kind != model.StepCodeGeneration) {
		return ""
	}
	return "\n\n[dataAccess 最终数据接入结果]\n" +
		"本任务已有用户确认的数据接入结果，必须先读取并遵循以下文件：\n" +
		"- 内部 JSON（可供代码生成读取，可能含鉴权）： " + input.ResultPath + "\n" +
		"- 内部 Markdown： " + input.MarkdownPath + "\n" +
		"- 脱敏 JSON（用户可见/审计）： " + input.RedactedResultPath + "\n" +
		"- 脱敏 Markdown（用户可见/审计）： " + input.RedactedMarkdownPath + "\n" +
		"硬约束：PENDING_AUTH/PENDING_PROBE/PENDING_INTEGRATION/UNSUPPORTED 不能当作已打通；未选择 mock 不能生成 mock；长期密钥不得写入前端源码、静态 bundle、README、用户可见文档或日志；需要鉴权的外部接口默认走代理/env/server-side config；mock_then_api 不能解释为失败后 mock。"
}

func collaborationProducerName(kind model.StepKind) string {
	switch kind {
	case model.StepCollaborationOrchestration:
		return "协作编排"
	case model.StepDomainAnalysis:
		return "领域分析"
	case model.StepDesignContract:
		return "界面设计"
	case model.StepDataIntegration:
		return "数据接入"
	default:
		return string(kind)
	}
}

func absolutePath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// skillsPromptBlock is the instruction appended to the solution_design +
// code_generation prompts telling Claude to load+follow the project-local
// skills selected by the confirmed requirement's generationProfile and to treat
// any matched 场景蓝本 docs as read-only style/structure references. It lists
// concrete, workspace-relative file paths so Claude can Read them directly.
func skillsPromptBlock(skillPaths, blueprintPaths []string, dataPolicy string) string {
	var b strings.Builder
	b.WriteString("\n\n[generationProfile 指令] ")
	if len(skillPaths) == 0 {
		b.WriteString("input.json 的 generationProfile 未选择任何 skill。这是异常情况：把缺失情况写入 output.json 的 warnings，并使用默认 baseline skill（.claude/skills/software-factory-app/SKILL.md）作为兜底，不要选择不相关 skill。")
	} else {
		b.WriteString("先 Read 并遵循下列项目本地 skill（base/domain/pattern），再产出方案/代码：")
		for _, p := range skillPaths {
			b.WriteString("\n- " + p)
		}
	}
	// Honest-data contract: enforced whenever dataPolicy is a real-data policy
	// (live_api or mock_then_api), REGARDLESS of whether a data-skill happens to
	// be in the profile. The data skills already say "real data is mandatory",
	// but the agent has been observed ignoring a soft "use real data by default"
	// rule and shipping mock "to ensure build success", so the rule that the
	// agent always sees is keyed on the authoritative dataPolicy, not on skill
	// presence. mock_data / empty policy is not bound by this contract.
	realData := dataPolicy == "live_api" || dataPolicy == "mock_then_api"
	if realData {
		b.WriteString("\n\n[诚实数据契约 — 违反即判定生成失败] confirmedRequirement.dataPolicy 为 " + dataPolicy + "，生成的应用必须以真实数据为准。")
		// When data-acquisition skills ARE selected, name them so the agent fetches
		// through the right real adapter rather than inventing one.
		var dataSkills []string
		for _, p := range skillPaths {
			if strings.Contains(p, "data-skill") {
				dataSkills = append(dataSkills, p)
			}
		}
		if len(dataSkills) > 0 {
			b.WriteString("先 Read 并严格遵循下列 data-skill 的 Fetch Adapter 发起真实公开数据请求（tide→NOAA CO-OPS，deck-wind→Open-Meteo GFS，ais→历史归档，carrier→已提交的 ontology/公开源），解析真实返回值填充数据层：")
			for _, p := range dataSkills {
				b.WriteString("\n- " + p)
			}
			b.WriteString(" ")
		}
		if hasPromptSkill(skillPaths, "carrier-affiliation-data-skill") {
			b.WriteString("[航母本体字段硬契约 — 违反即判定生成失败] 生成 ontology/DaaS adapter 时，columns 只能使用 Swagger/skill 已文档化原始字段，禁止发送 UI 归一化字段或猜测字段。")
			b.WriteString("AviationCarrier columns: id, name, longitude, latitude, curStatus, curHeading, curSpeed, mmsi, airWing, aircraftCarried, homeportStation; forbidden: curLongitude, curLatitude, heading, speed, homeport。")
			b.WriteString("AircraftCarrier columns: id, name, refHMId, typeCode, curStatus, longitude, latitude。")
			b.WriteString("AircraftCarrierTrackLog columns: refAviationCarrier, trackInitTime, longitude, latitude, trackStatusCode; forbidden: recordTime, speed, heading, refHMId。")
			b.WriteString("MaritimeBaseCombatPlatform columns: id, name, typeCode, mmsi, longitude, latitude, curStatus, maxSpeed, cruiseRange; forbidden: callsign; 需要标识时用 mmsi，缺失时用 id fallback。")
			b.WriteString("RawADSData columns: icao, callsign, lat, lon, altitude, groundspeed, track, heading, startTime; filter must be { column: 'icao', logic: 'is not null', condition: null }，不要写 logic: 'is not'。")
			b.WriteString("RawAISData columns: mmsi, latitude, longitude, sog, courseOverGround, trueHeading, shipName, callsign, navigationalStatus, typeCode, startTime, dataUpdateTime。")
		}
		b.WriteString("**严禁**：用 synthetic/mock/fake/demo 数据替代真实请求；用 Math.random、确定性公式或 Math.sin/Math.cos 曲线合成潮汐/风/密度/航迹等核心序列；取数失败后 fallback 到 mock；为「保证构建成功」而硬编码看似真实的数据。")
		b.WriteString("**文件命名同样受诚实数据审计约束**：src/ 下严禁出现名为 mock / mocks / mockData / mock-data / mock_data / fake / dummy / placeholder 的源文件——审计按文件名判定，即使该文件只放常量/阈值/标签/格式化函数也会被判定生成失败。常量、阈值、标签、格式化等辅助内容请命名为 constants / thresholds / labels / format / ui 等，绝不使用 mock 系文件名。")
		b.WriteString("真实取数失败时（源不可达、覆盖范围不支持、鉴权缺失），应用必须渲染**降级态（Degraded State）**而不是一行裸「数据异常」——这是「所有真实源均失败」时**完整、合规、可交付**的终态，不要为此重试去编造数据，也不要卡死。降级态必须包含：(1) 顶部说明 banner：数据源不可用 + 失败原因 + 已尝试的数据源列表 + 手动重试按钮；(2) 数据视图的结构预览（图表轴标签 / 表格列头 / 卡片标题等「数据回来后会展示什么」的骨架，**严禁填充任何编造数值**，用空数组 / 占位线 / 「—」即可）；(3) 官方数据源链接；(4) 一句「数据恢复后此处将显示…」的说明。降级态组件命名为 EmptyState / DegradedState / DataUnavailable，**不要**使用 mock / fake / dummy / placeholder / sampleData / demoData 等命名（受诚实数据审计约束）。取数必须在**运行时（浏览器端）**进行，`npm run build` 必须能**完全离线**通过，禁止任何构建期取数依赖，保证页面在任何数据状况下都能产出来。降级判定必须快速：真实源**首次探测**即无覆盖或不可达时立即进入降级态，禁止对不可达源逐网格点/逐年份反复探测（用短超时 + 单点探测即可判定覆盖，绝不让用户长时间盯着加载圈等待）。把失败原因与已尝试源记入 output.json 的 warnings——交付假数据（含为「让构建通过」而硬编码的看似真实数值）等同于本次生成失败。")
		b.WriteString("仅当 dataPolicy=mock_data 或 useMock=true 时才允许使用 mock 数据（且 UI 须明确标注 mock/演示）。")
		b.WriteString("注意：mock_then_api 表示「真实优先、失败诚实报错」，**不是**失败后回退 mock。")
	}
	b.WriteString("\n若某个必需 skill 缺失，在 output.json 的 warnings 中记录，不要改用不相关 skill。")
	if len(blueprintPaths) > 0 {
		b.WriteString("\n[场景蓝本引用] 当 generationProfile/blueprintRefs 存在时，把以下 scene 文档作为 STYLE / STRUCTURE / INTERACTION / DATA-MODEL 的参考（布局、控件、交互、mock 数据形态），")
		b.WriteString("在 generated-apps/<slug>/ 下生成原创代码；严禁复制 scene/ 源码：")
		for _, p := range blueprintPaths {
			b.WriteString("\n- " + p)
		}
	}
	b.WriteString("\n[usedSkills 报告] 在 output.json 的 usedSkills 数组中列出你实际加载并遵循的每一个 skill 的文件路径（即上面列出的 SKILL.md 路径中真实被使用的子集）。usedSkills 不得为空。")
	return b.String()
}

func hasPromptSkill(skillPaths []string, name string) bool {
	name = strings.ToLower(name)
	for _, p := range skillPaths {
		if strings.Contains(strings.ToLower(p), name) {
			return true
		}
	}
	return false
}

func (c *ClaudeStepRunner) workspace() string {
	if c.Workspace == "" {
		return "."
	}
	return c.Workspace
}

// SafeName reports whether s is a single safe path segment suitable for
// embedding into a workspace-relative path (skill key or scene slug). It must
// be non-empty, match ^[A-Za-z0-9][A-Za-z0-9_.-]*$, and contain no path
// separators, no "..", and no drive/absolute markers. This is the canonical
// containment validator shared by the executor's path builders and the server's
// fail-closed API validation — keep one definition (the server imports it) so
// both layers agree on what a safe segment is.
func SafeName(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			r == '_' || r == '.' || r == '-'
		if !ok {
			return false
		}
	}
	// Reject any segment that is or contains a parent-directory traversal.
	if strings.Contains(s, "..") {
		return false
	}
	return true
}

// selectedSkillPaths maps a confirmed requirement's generationProfile
// (base/domain/pattern/data → skill keys) to the concrete project-local
// SKILL.md file paths under <workspace>/.claude/skills/<key>/SKILL.md. The
// order is base → domain → pattern → data so downstream prompts list
// foundational/UI skills first and data-acquisition skills last.
// Paths are slash-normalised so they can be embedded verbatim in input.json and
// prompt text for Claude to Read. Missing files are NOT filtered out here: the
// prompt instructs Claude to report a missing required skill in warnings rather
// than silently picking an unrelated one, so the path must still be surfaced.
//
// Defense in depth (P2#1): keys failing SafeName (e.g. "..", "/", absolute-ish)
// are dropped, and every candidate path is asserted to stay inside the allowed
// skills root via filepath.Rel — anything that would escape is dropped. Safe
// names that simply do not exist on disk are still surfaced (existing behavior).
func selectedSkillPaths(workspace string, profile map[string][]string) []string {
	keys := []string{}
	for _, group := range []string{"base", "domain", "pattern", "data"} {
		keys = append(keys, profile[group]...)
	}
	allowedRoot := filepath.Clean(filepath.Join(workspace, ".claude", "skills"))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if !SafeName(key) {
			continue
		}
		candidate := filepath.Clean(filepath.Join(allowedRoot, key, "SKILL.md"))
		if !withinRoot(allowedRoot, candidate) {
			continue
		}
		out = append(out, filepath.ToSlash(candidate))
	}
	return out
}

// blueprintRefPaths maps confirmed blueprintRefs (scene slugs) to their scene
// reference docs. These are STYLE/STRUCTURE/INTERACTION/DATA-MODEL references
// only — the prompt forbids copying scene source. Prefers scene.md when present,
// else falls back to README.md. Paths that do not exist on disk are still
// returned (the prompt instructs Claude to note a missing ref in warnings
// rather than silently substituting another scene).
//
// Defense in depth (P2#1): slugs failing SafeName are dropped, and every
// candidate path is asserted to stay inside <workspace>/scene via filepath.Rel.
func blueprintRefPaths(workspace string, refs []string) []string {
	allowedRoot := filepath.Clean(filepath.Join(workspace, "scene"))
	out := make([]string, 0, len(refs))
	for _, slug := range refs {
		if !SafeName(slug) {
			continue
		}
		sceneDir := filepath.Clean(filepath.Join(allowedRoot, slug))
		if !withinRoot(allowedRoot, sceneDir) {
			continue
		}
		base := filepath.ToSlash(sceneDir)
		sceneMD := base + "/scene.md"
		if _, err := os.Stat(filepath.FromSlash(sceneMD)); err == nil {
			out = append(out, sceneMD)
			continue
		}
		out = append(out, base+"/README.md")
	}
	return out
}

// withinRoot reports whether absPath is inside root (root-inclusive). It computes
// filepath.Rel(root, absPath) and requires the result to be non-empty, not start
// with "..", and not be an absolute path. This is the second layer of the
// containment defense: even if a future SafeName bypass existed, an escaping
// candidate would still be rejected here.
func withinRoot(root, absPath string) bool {
	rel, err := filepath.Rel(root, absPath)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if rel == "" || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return false
	}
	if filepath.IsAbs(rel) {
		return false
	}
	return true
}

// confirmedRequirementShape is the minimal projection of the confirmed
// requirement JSON needed to derive the generationProfile + blueprintRefs. It is
// decoded leniently (json.Unmarshal, not strict) because the full confirmed
// requirement is opaque to the executor and may carry extra fields.
type confirmedRequirementShape struct {
	GenerationProfile map[string][]string `json:"generationProfile"`
	BlueprintRefs     []string            `json:"blueprintRefs"`
}

// parseGenerationProfile extracts the generationProfile + blueprintRefs from the
// confirmed requirement JSON carried on the Job. It is defensive: a blank or
// unparseable requirement (legacy/direct-created jobs) yields empty values, in
// which case the generative prompts fall back to the default baseline skill and
// emit no blueprint refs. This never fails the step — profile derivation is the
// server's job (Task 5 confirms it before the job is queued); by the time a step
// runs, a well-formed requirement is expected.
func parseGenerationProfile(confirmedReq json.RawMessage) (map[string][]string, []string) {
	if len(bytes.TrimSpace(confirmedReq)) == 0 {
		return nil, nil
	}
	var shape confirmedRequirementShape
	if err := json.Unmarshal(confirmedReq, &shape); err != nil {
		return nil, nil
	}
	return shape.GenerationProfile, shape.BlueprintRefs
}

// parseDataPolicy extracts confirmedRequirement.dataPolicy. It is defensive like
// parseGenerationProfile: blank/garbage yields "". The honest-data contract in
// the generative prompt and the post-code-gen audit both gate on this value.
func parseDataPolicy(confirmedReq json.RawMessage) string {
	if len(bytes.TrimSpace(confirmedReq)) == 0 {
		return ""
	}
	var shape struct {
		DataPolicy string `json:"dataPolicy"`
	}
	if err := json.Unmarshal(confirmedReq, &shape); err != nil {
		return ""
	}
	return shape.DataPolicy
}

func (c *ClaudeStepRunner) artifactRoot() string {
	if c.ArtifactRoot == "" {
		return ".factory-runs"
	}
	return c.ArtifactRoot
}

// createInterfacePreviewSnapshot derives the task-owned interface-preview
// artifact from a VALIDATED design contract (Task 8). The agent is forbidden
// from writing preview files, so this is the single deterministic producer:
// it projects the design contract's summary + designDocument + assumedDataFields
// into a static manifest under the artifact root, content-hashes it, and
// returns a WorkbenchArtifactRef (Kind=interface_preview, CardKey=
// interface_parsing, Status=provisional) for the orchestration view to render.
//
// PreviewURL points at the GET /api/jobs/:id/interface-preview serving endpoint
// (F4) so the view model surfaces a fetchable URL. It serves the manifest JSON
// for inspection; rendering it as a runnable HTML preview is a separate, larger
// generation-capability follow-up (deferred). The Path stays under the artifact
// root (jobs/<job>/design_contract/attempt-<n>/interface-preview/manifest.json)
// and contains ONLY design metadata — no credentials, no provider reasoning
// (Constraint #9: the manifest is built from the public design contract fields
// the agent authored, never from hidden provider data).
func (c *ClaudeStepRunner) createInterfacePreviewSnapshot(ctx context.Context, job model.Job, step model.JobStep, ws runner.AttemptWorkspace, design runner.DesignContractOutput) (model.WorkbenchArtifactRef, error) {
	raw, err := json.MarshalIndent(map[string]any{
		"kind":              "static_manifest",
		"summary":           design.Summary,
		"designDocument":    design.DesignDocument,
		"assumedDataFields": design.AssumedDataFields,
	}, "", "  ")
	if err != nil {
		return model.WorkbenchArtifactRef{}, err
	}
	previewRel := filepath.ToSlash(filepath.Join("jobs", job.ID, string(step.Kind), fmt.Sprintf("attempt-%d", step.Attempt), "interface-preview", "manifest.json"))
	full := filepath.Join(c.artifactRoot(), filepath.FromSlash(previewRel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return model.WorkbenchArtifactRef{}, err
	}
	if err := os.WriteFile(full, raw, 0o644); err != nil {
		return model.WorkbenchArtifactRef{}, err
	}
	sum := sha256.Sum256(raw)
	now := time.Now()
	refID := "warf_" + id.New()
	return model.WorkbenchArtifactRef{
		ID:           refID,
		DialogueID:   job.DialogueID,
		JobID:        job.ID,
		StepID:       step.ID,
		CardKey:      "interface_parsing",
		Kind:         model.WorkbenchArtifactInterfacePreview,
		Label:        "界面预览",
		Path:         previewRel,
		PreviewURL:   fmt.Sprintf("/api/jobs/%s/interface-preview?artifactId=%s", job.ID, refID),
		SnapshotHash: "sha256:" + hex.EncodeToString(sum[:]),
		Status:       "provisional",
		CreatedAt:    now,
		UpdatedAt:    now,
	}, nil
}

func (c *ClaudeStepRunner) prototypeContextPromptBlock(ctx context.Context, jobID string, kind model.StepKind) string {
	if c.Store == nil || (kind != model.StepSolutionDesign && kind != model.StepCodeGeneration && kind != model.StepProductAcceptance) {
		return ""
	}
	refs, err := c.Store.ListWorkbenchArtifactRefsByJob(ctx, jobID)
	if err != nil {
		return ""
	}
	var ref *model.WorkbenchArtifactRef
	for i := range refs {
		if refs[i].Kind == model.WorkbenchArtifactInterfacePreview && refs[i].CardKey == "interface_parsing" {
			if ref == nil || refs[i].UpdatedAt.After(ref.UpdatedAt) {
				ref = &refs[i]
			}
		}
	}
	if ref == nil {
		return ""
	}
	level := "reference"
	if ref.Status == "confirmed" {
		level = "hard_constraint"
	}
	contractPath := strings.TrimSuffix(ref.Path, "/preview-manifest.json") + "/prototype-contract.json"
	return "\n\n[prototype 原型设计约束]\n" +
		"本任务已有界面解析/原型设计产物，必须读取并遵循：\n" +
		"- preview-manifest: " + ref.Path + "\n" +
		"- prototype-contract: " + contractPath + "\n" +
		"- prototypeStatus: " + ref.Status + "\n" +
		"- downstreamConstraintLevel: " + level + "\n" +
		"当 downstreamConstraintLevel=hard_constraint 时，不得自由改变首页结构、核心组件、主要交互和响应式约束；当为 reference 时，只能作为参考，不能声称用户已确认原型。"
}

func (c *ClaudeStepRunner) dataIntegrationUpstreamPromptBlock(ctx context.Context, job model.Job, kind model.StepKind) string {
	if kind != model.StepDataIntegration {
		return ""
	}
	lines := []string{}
	if strings.TrimSpace(job.AppSlug) != "" {
		reqPath := absolutePath(filepath.Join(c.workspace(), "generated-apps", filepath.FromSlash(job.AppSlug), "docs", "01-requirements.md"))
		lines = append(lines, "- 需求文档: "+reqPath)
	}
	if c.Store != nil {
		if ref := c.latestInterfacePreviewRef(ctx, job.ID); ref != nil {
			level := "reference"
			if ref.Status == "confirmed" {
				level = "hard_constraint"
			}
			contractPath := strings.TrimSuffix(ref.Path, "/preview-manifest.json") + "/prototype-contract.json"
			lines = append(lines,
				"- 原型预览 preview-manifest: "+absolutePath(filepath.Join(c.artifactRoot(), filepath.FromSlash(ref.Path))),
				"- 原型预览 prototype-contract: "+absolutePath(filepath.Join(c.artifactRoot(), filepath.FromSlash(contractPath))),
				"- 原型状态: "+ref.Status,
				"- 原型下游约束级别: "+level,
			)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return "\n\n[dataAccess 上游输入依据]\n" +
		"生成数据获取方案时，必须把以下用户可见产物作为数据需求、字段映射和代码生成输入的主要依据；文件存在时先 Read 后再下结论，缺失时在 warnings 中说明降级原因：\n" +
		strings.Join(lines, "\n") + "\n" +
		"数据方案的“1 输入依据”章节必须明确列出已参考的需求文档和原型预览/契约。"
}

func (c *ClaudeStepRunner) latestInterfacePreviewRef(ctx context.Context, jobID string) *model.WorkbenchArtifactRef {
	if c.Store == nil {
		return nil
	}
	refs, err := c.Store.ListWorkbenchArtifactRefsByJob(ctx, jobID)
	if err != nil {
		return nil
	}
	var ref *model.WorkbenchArtifactRef
	for i := range refs {
		if refs[i].Kind == model.WorkbenchArtifactInterfacePreview && refs[i].CardKey == "interface_parsing" {
			if ref == nil || refs[i].UpdatedAt.After(ref.UpdatedAt) {
				ref = &refs[i]
			}
		}
	}
	return ref
}

func (c *ClaudeStepRunner) createPrototypePreviewArtifact(ctx context.Context, job model.Job, step model.JobStep, ws runner.AttemptWorkspace, design runner.DesignContractOutput, bundle prototypeBundle) (model.WorkbenchArtifactRef, error) {
	raw, err := json.Marshal(bundle.Manifest)
	if err != nil {
		return model.WorkbenchArtifactRef{}, err
	}
	sum := sha256.Sum256(raw)
	now := time.Now()
	refID := "warf_" + id.New()
	metaRaw, _ := json.Marshal(map[string]any{
		"contractPath": bundle.ContractRelPath,
		"indexPath":    bundle.IndexRelPath,
		"prototype":    design.Prototype,
	})
	return model.WorkbenchArtifactRef{
		ID:           refID,
		DialogueID:   job.DialogueID,
		JobID:        job.ID,
		StepID:       step.ID,
		CardKey:      "interface_parsing",
		Kind:         model.WorkbenchArtifactInterfacePreview,
		Label:        "原型预览",
		Path:         bundle.PreviewRelPath,
		PreviewURL:   fmt.Sprintf("/api/jobs/%s/steps/%s/prototype/preview", job.ID, step.ID),
		SnapshotHash: "sha256:" + hex.EncodeToString(sum[:]),
		Status:       "unconfirmed",
		Metadata:     string(metaRaw),
		CreatedAt:    now,
		UpdatedAt:    now,
	}, nil
}

// requirementDocumentRef builds the workbench artifact ref for the 需求文档
// that projectDocsAfterStep projects (docs/01-requirements.md) after a
// successful requirement_analysis step. Path is app-relative so the frontend's
// openProjectDocument can fetch it via GET /api/jobs/:id/project-docs/file.
// CardKey=business_logic places it on the 业务逻辑 card; Kind=project_document
// routes the open click to the markdown preview.
func requirementDocumentRef(job model.Job, step model.JobStep) model.WorkbenchArtifactRef {
	now := time.Now()
	return model.WorkbenchArtifactRef{
		ID:         "warf_" + id.New(),
		DialogueID: job.DialogueID,
		JobID:      job.ID,
		StepID:     step.ID,
		CardKey:    "business_logic",
		Kind:       model.WorkbenchArtifactProjectDocument,
		Label:      "需求文档",
		Path:       "docs/01-requirements.md",
		Status:     "active",
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func dataAccessPlanRef(job model.Job, step model.JobStep, result dataaccess.Result) model.WorkbenchArtifactRef {
	now := time.Now()
	return model.WorkbenchArtifactRef{
		ID:         "warf_" + id.New(),
		DialogueID: job.DialogueID,
		JobID:      job.ID,
		StepID:     step.ID,
		CardKey:    "data_capture",
		Kind:       model.WorkbenchArtifactDataAccessPlan,
		Label:      "数据方案",
		Path:       filepath.ToSlash(filepath.Join("jobs", job.ID, "data-access", "versions", result.Version, "data-access.redacted.md")),
		Status:     dataaccess.StatusPendingConfirmation,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

// upsertWorkbenchArtifact persists a WorkbenchArtifactRef so the orchestration
// view can render it on its card. Nil-safe on c.Store (test runners may run
// without a store) and on an empty ref ID (defensive: never upsert a ref that
// was not populated). Errors are swallowed: a preview-snapshot persistence
// failure must not fail an otherwise-successful design step after the snapshot
// itself was already written to disk.
func (c *ClaudeStepRunner) upsertWorkbenchArtifact(ctx context.Context, ref model.WorkbenchArtifactRef) {
	if c.Store == nil || ref.ID == "" {
		return
	}
	_ = c.Store.UpsertWorkbenchArtifactRef(ctx, ref)
}

func normalizeCreatedFiles(projectDir string, files []string) []string {
	out := make([]string, 0, len(files))
	projectDir = filepath.ToSlash(strings.Trim(projectDir, "/"))
	for _, f := range files {
		norm := filepath.ToSlash(strings.TrimSpace(f))
		if norm == "" {
			continue
		}
		if strings.HasPrefix(norm, projectDir+"/") || strings.HasPrefix(norm, ".factory-runs/") {
			out = append(out, norm)
			continue
		}
		out = append(out, projectDir+"/"+norm)
	}
	return out
}

// slugFromProjectDir extracts the app slug from a code-generation project
// directory. The directory is normally generated-apps/<slug>, but after a
// review block the re-run targets a versioned directory
// generated-apps/<slug>/versions/ver_<id>; in that case the slug is the
// segment immediately after generated-apps/, NOT the trailing ver_<id>.
// Returning ver_<id> would make AuditFiles's allowed root
// generated-apps/ver_<id>/ and reject every declared file under the real app
// tree (file_constraint_violated).
func slugFromProjectDir(projectDir string) string {
	p := filepath.ToSlash(projectDir)
	idx := strings.Index(p, "generated-apps/")
	if idx < 0 {
		// Not under generated-apps/ — fall back to the last segment so the
		// audit still has a (best-effort) root rather than blocking everything.
		trimmed := strings.Trim(p, "/")
		if trimmed == "" {
			return ""
		}
		parts := strings.Split(trimmed, "/")
		return parts[len(parts)-1]
	}
	tail := strings.Trim(p[idx+len("generated-apps/"):], "/")
	if tail == "" {
		return ""
	}
	if i := strings.Index(tail, "/"); i >= 0 {
		return tail[:i]
	}
	return tail
}

// dataContractVerification is the per-boundary verdict projected onto the
// data_capture card. It mirrors runner.DataVerificationNode but lives here so
// the projection is an explicit, frontend-facing contract rather than a leak of
// the runner's internal struct tags.
type dataContractVerificationNode struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

type dataContractProjectionResult struct {
	Metadata string
	Status   string
	Label    string
	Path     string
	Project  bool
}

// buildDataContractMetadata marshals a frontend-facing verification summary from
// the decoded DataIntegrationOutput. The shape is fixed:
//
//	{
//	  "sourceBoundary": <ontology|internet|demo>,
//	  "verification": { "ontology": {...}, "internet": {...}, "demo": {...} },
//	  "fallbackHistory": [...],
//	  "sampleCount": <n>,
//	  "fieldCount": <n>
//	}
//
// The data_capture card's data-flow track reads this to derive node states: the
// sourceBoundary node is the selected source (succeeded/active), a boundary in
// fallbackHistory (or whose verification status is "failed") renders red, and
// fieldCount/sampleCount annotate the processing nodes.
func buildDataContractMetadata(detail runner.DataIntegrationOutput) (string, error) {
	summary := struct {
		SourceBoundary  string                                  `json:"sourceBoundary"`
		Verification    map[string]dataContractVerificationNode `json:"verification"`
		FallbackHistory []string                                `json:"fallbackHistory"`
		SampleCount     int                                     `json:"sampleCount"`
		FieldCount      int                                     `json:"fieldCount"`
	}{
		SourceBoundary: detail.SourceBoundary,
		Verification: map[string]dataContractVerificationNode{
			"ontology": {Status: detail.Verification.Ontology.Status, Reason: detail.Verification.Ontology.Reason},
			"internet": {Status: detail.Verification.Internet.Status, Reason: detail.Verification.Internet.Reason},
			"demo":     {Status: detail.Verification.Demo.Status, Reason: detail.Verification.Demo.Reason},
		},
		FallbackHistory: detail.FallbackHistory,
		SampleCount:     detail.DataContract.SampleCount,
		FieldCount:      len(detail.DataContract.Fields),
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		return "", fmt.Errorf("marshal data-contract metadata: %w", err)
	}
	return string(raw), nil
}

// dataContractProjection decides whether the data_integration step should
// project a data_contract workbench artifact for the given result status, and
// when so returns the verification-summary metadata to carry on the ref. The
// summary is projected on BOTH success AND needs_input (waiting_user): during
// the degradation-confirmation wait the workbench data-flow track must render
// the real per-boundary state (e.g. ontology red breakpoint + internet waiting),
// not just a card-level waiting state (spec #32). Other statuses do not
// project. err is non-nil only on the near-impossible metadata-marshal failure,
// which the caller treats as a step failure (preserving the prior behavior).
func dataContractProjection(detail runner.DataIntegrationOutput, resStatus model.StepStatus) (dataContractProjectionResult, error) {
	if resStatus != model.StepStatusSucceeded && resStatus != model.StepStatusWaitingUser {
		return dataContractProjectionResult{}, nil
	}
	meta, err := buildDataContractMetadata(detail)
	if err != nil {
		return dataContractProjectionResult{}, err
	}
	proj := dataContractProjectionResult{
		Metadata: meta,
		Status:   detail.SourceBoundary,
		Label:    "数据契约",
		Path:     "docs/data-integration.md",
		Project:  true,
	}
	if resStatus == model.StepStatusWaitingUser {
		proj.Label = "数据验证状态"
		proj.Path = ""
	}
	if strings.EqualFold(detail.Compatibility.Status, "failed") {
		proj.Status = "compatible_failed"
		proj.Label = "界面兼容待确认"
		proj.Path = ""
	}
	return proj, nil
}
