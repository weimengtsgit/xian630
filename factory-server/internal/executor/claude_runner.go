package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

type ClaudeStepRunner struct {
	Store        *store.Store
	Workspace    string
	ArtifactRoot string
	Claude       *runner.ClaudeRunner
	AuditRunner  runner.CommandRunner
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

	input, err := json.MarshalIndent(map[string]any{
		"job":                  job,
		"step":                 step,
		"confirmedRequirement": confirmedReq,
		"generationProfile":    profile,
		"blueprintRefs":        blueprintRefs,
		"skills":               skillPaths,
		"blueprintDocs":        blueprintPaths,
		"repairContext":        step.UserPrompt,
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
	// step.UserPrompt carries the user's answer when a step is re-run after
	// pausing for clarification (waiting_user → answerJob → SetStepUserPrompt),
	// OR a repair-from-failure instruction. For generative steps we surface it
	// so the agent incorporates the answer instead of re-asking the same
	// question. Without this the re-run is blind (identical input).
	if strings.TrimSpace(step.UserPrompt) != "" &&
		(step.Kind == model.StepSolutionDesign || step.Kind == model.StepCodeGeneration) {
		prompt += "\n\n[user_input]\n" + step.UserPrompt + "\n"
	}
	if err := c.Claude.Run(ctx, ws, prompt, input, step.Kind == model.StepCodeGeneration, emit); err != nil {
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
		out, err := runner.ValidateRequirementAnalysis(ws.OutputPath())
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		return c.resultFromValidatedOutput(ctx, trace, out, err), nil
	case model.StepSolutionDesign:
		out, err := runner.ValidateSolutionDesign(ws.OutputPath())
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		return c.resultFromValidatedOutput(ctx, trace, out, err), nil
	case model.StepCodeGeneration:
		res := c.finishCodeGeneration(ctx, trace, job, step, ws.OutputPath(), baseline)
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		return res, nil
	case model.StepCodeReview, model.StepSecurityReview, model.StepProductAcceptance:
		// Blocking review gate: decode the gate's JSON status. status:"blocked"
		// → failed with ErrorBlockingReview (the bounded-repair policy treats this
		// as a repairable gate); status:"passed" (or absent) → succeeded. The
		// gate output is produced by the prompt switch's review cases; decoding is
		// lenient (prose/```json-wrapped output tolerated) the same way the
		// generative steps are.
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		return finishReviewGate(ctx, trace, step, ws.OutputPath()), nil
	default:
		// The remaining admitted gate kinds (collaboration_orchestration,
		// domain_analysis, design_contract, data_integration) are analysis/
		// contract producers with no executor-side validation beyond a parseable
		// output.json. Succeed when output exists; fail output_invalid_json
		// otherwise. They are NOT blocking gates, so they never carry
		// ErrorBlockingReview and never trigger auto-repair.
		var raw map[string]any
		if err := runner.ReadAndDecode(ws.OutputPath(), &raw); err != nil {
			return c.failureFromError(err), nil
		}
		return StepResult{Status: model.StepStatusSucceeded}, nil
	}
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
		Options       []opt  `json:"options,omitempty"`
	}
	out := make([]q, 0, len(questions))
	for _, qq := range questions {
		opts := make([]opt, 0, len(qq.Options))
		for _, o := range qq.Options {
			opts = append(opts, opt{Value: o.Value, Label: o.Label, Recommended: o.Recommended})
		}
		out = append(out, q{ID: qq.ID, Question: qq.Question, DefaultAnswer: qq.DefaultAnswer, Options: opts})
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
	return StepResult{Status: model.StepStatusSucceeded}
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
	return StepResult{Status: model.StepStatusSucceeded}
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

func (c *ClaudeStepRunner) resultFromValidatedOutput(ctx context.Context, trace runner.TraceEmitter, out runner.StepOutput, err error) StepResult {
	if err != nil {
		return c.failureFromError(err)
	}
	if out.NeedsUserInput {
		// Step 3 (high-impact uncertainty): emit clarification.required before
		// the waiting transition. See finishCodeGeneration for the rationale.
		emitClarificationTrace(ctx, trace, out.Questions, nil)
		return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true, Questions: out.Questions}
	}
	return StepResult{Status: model.StepStatusSucceeded}
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
			"Return exactly one raw JSON object with these top-level fields: confirmedRequirementId, summary, appType, appName, targetUsers, coreScenario, primaryView, mainEntities, dataPolicy, acceptanceFocus, generationProfile, constraints, risks, validation.\n" +
			"The validation object must contain: complete, supported, missingFields, unsupportedRequests.\n" +
			"All human-readable string values must be Simplified Chinese. This includes summary, scenario text, view descriptions, entity names, constraints, risks, and unsupported-request explanations. Only identifiers, slugs, enum keys, file paths, and code symbols may remain non-Chinese.\n" +
			"Do not ask clarifying questions. Do not output needsUserInput or questions. Do not output markdown. Do not use code fences. Do not add any prose before or after the JSON.\n" +
			"Do not call ExitPlanMode. Do not describe what you plan to do. Do not attempt to write files or modify the workspace.\n" +
			"If the requirement is incomplete, set validation.complete=false. If the request exceeds supported capability, set validation.supported=false.\n" +
			"Your final assistant message must be the raw JSON payload only. Factory saves stdout as output.json."
	}
	if step.Kind == model.StepSolutionDesign {
		return "你是软件工厂的方案设计 agent。读取 input.json，基于用户需求输出方案设计。最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块，不要输出隐藏推理链。Factory 会把 stdout 保存为 output.json。JSON 格式必须包含 needsUserInput、questions、usedSkills，可包含 app、artifactPlan、warnings；不需要用户补充信息时 needsUserInput=false 且 questions=[]。所有供人阅读的输出字段必须使用简体中文，包括 questions、app 摘要、artifactPlan 描述、warnings、说明文案；只有标识符、slug、路径、枚举值、代码符号可保留非中文。" +
			"需要用户澄清时，questions 中每个问题必须用结构化字段：question 为问题文本（只描述要决策什么，不要把选项塞进 question），options 为选项数组，每个选项含 value（机器可读的选项值，如 mock_data、real_api）和 label（中文可读选项描述），可在最推荐选项上加 recommended:true。禁止把 (A)/(B)/(C) 等选项写进 question 文本；选项必须放在 options 数组里，否则前端无法渲染成可点击选项。示例：{\"id\":\"data-source\",\"question\":\"请确认数据获取方式\",\"options\":[{\"value\":\"mock_data\",\"label\":\"使用演示数据\",\"recommended\":true},{\"value\":\"real_api\",\"label\":\"提供真实后端API\"}]}。" +
			"如果 prompt 末尾出现 [user_input] 段落，那是用户对上一轮澄清问题的回答，必须据此推进方案（例如用户选择演示数据则 dataPolicy 按 mock_data 处理），不要再重复提出已回答过的澄清问题；只有在出现全新且未决的决策点时才再次 needsUserInput=true。" +
			"用户需求：" + job.UserPrompt +
			skillsPromptBlock(skillPaths, blueprintPaths, dataPolicy)
	}
	if step.Kind == model.StepCodeGeneration {
		return "你是软件工厂的代码生成 agent。你的工作目录就是软件工厂仓库根目录。只能在 generated-apps/<slug>/ 下生成静态 Vite 应用和 .factory/app.json，禁止在 factory-server/generated-apps/ 或其他目录生成文件。" +
			"工作区根目录：" + c.workspace() + "。读取输入文件：input.json 路径：" + absolutePath(ws.InputPath()) + "。" +
			"output.json 必须写入：output.json 路径：" + absolutePath(ws.OutputPath()) + "；可选生成摘要写入：output.md 路径：" + absolutePath(ws.OutputMDPath()) + "。" +
			"output.json 必须包含 projectDir、createdFiles、needsUserInput、questions、usedSkills（可含 warnings）；projectDir 和 createdFiles 必须使用仓库相对路径。" +
			".factory/app.json 必须是以下 Factory manifest 契约：schemaVersion 为 1，slug 为 <slug>，name 非空，source 为 generated，entry 为 static-vite，path 为 generated-apps/<slug>，并包含 build{command:npm run build,outputDir:dist}、runtime{devCommand:npm run dev,defaultPort:5173}、docker{enabled:true,dockerfile:Dockerfile,context:.,runtimePort:80}。" +
			"manifest JSON 字段必须包含 \"schemaVersion\": 1、\"entry\": \"static-vite\"、\"path\": \"generated-apps/<slug>\"；不要使用 deployment 或 ports 代替 build/runtime/docker。" +
			"nginx.conf 必须可直接启动：不要在 conf.d/*.conf 中写 ${ENV_VAR}、$ENV_VAR 或未定义 nginx 变量；如需代理鉴权，前端应以缺失凭据的诚实错误态处理，不要让 nginx 因 unknown variable 启动失败。" +
			"面向用户的页面文案、标题、标签、图表说明、详情说明，以及 output.json / output.md 中的人类可读文本，默认必须使用简体中文；只有标识符、slug、路径、枚举值、代码符号可以保留非中文。" +
			"不要输出隐藏推理链。" +
			skillsPromptBlock(skillPaths, blueprintPaths, dataPolicy)
	}
	switch step.Kind {
	case model.StepRequirementAnalysis:
		return "你是软件工厂的需求冻结 agent。读取 input.json 中的 confirmedRequirement，校验字段完整性、能力边界和 generationProfile。" +
			"AUDIT blueprintRefs（确认引用的 skill 存在于 .claude/skills/requirement-clarification/blueprints.json 且为 reference-only），将任何超出现有 skill 目录支持的请求记入 validation.unsupportedRequests。" +
			"输出 output.json，包含 confirmedRequirementId、summary、appType、appName、targetUsers、coreScenario、primaryView、mainEntities、dataPolicy、acceptanceFocus、generationProfile、constraints、risks、validation（含 complete、supported、missingFields、unsupportedRequests）。" +
			"不要进行多轮澄清（澄清已在 Job 创建前完成），不要输出 needsUserInput/questions，不要输出隐藏推理链。需求不完整或超出现有能力时，validation.complete=false 或 validation.supported=false。最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块。Factory 会把 stdout 保存为 output.json。"
	case model.StepSolutionDesign:
		return "你是软件工厂的方案设计 agent。读取 input.json，基于用户需求输出方案设计。最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块，不要隐藏推理链。Factory 会把 stdout 保存为 output.json。JSON 格式必须包含 needsUserInput、questions、usedSkills，可包含 app 和 artifactPlan、warnings；不需要用户补充信息时 needsUserInput=false 且 questions=[]。\n如果 prompt 末尾出现 [user_input] 段落，那是用户对上一轮澄清问题的回答，必须据此推进方案，不要重复提出已回答过的澄清问题。\n用户需求：" + job.UserPrompt +
			skillsPromptBlock(skillPaths, blueprintPaths, dataPolicy)
	case model.StepCodeGeneration:
		return "你是软件工厂的代码生成 agent。你的工作目录就是软件工厂仓库根目录。只能在 generated-apps/<slug>/ 下生成静态 Vite 应用和 .factory/app.json，禁止在 factory-server/generated-apps/ 或其他目录生成文件。" +
			"工作区根目录：" + c.workspace() + "。读取输入文件：input.json 路径：" + absolutePath(ws.InputPath()) + "。" +
			"output.json 必须写入：output.json 路径：" + absolutePath(ws.OutputPath()) + "；可选生成摘要写入：output.md 路径：" + absolutePath(ws.OutputMDPath()) + "。" +
			"output.json 必须包含 projectDir、createdFiles、needsUserInput、questions、usedSkills（可含 warnings）；projectDir 和 createdFiles 必须使用仓库相对路径。" +
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

func slugFromProjectDir(projectDir string) string {
	projectDir = strings.Trim(filepath.ToSlash(projectDir), "/")
	if projectDir == "" {
		return ""
	}
	parts := strings.Split(projectDir, "/")
	return parts[len(parts)-1]
}
