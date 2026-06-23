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
	UsedSkills     []string          `json:"usedSkills"`
	Warnings       []string          `json:"warnings,omitempty"`
}

func (c *ClaudeStepRunner) Run(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	if emit == nil {
		emit = runner.NopEmitter{}
	}
	switch step.Kind {
	case model.StepRequirementAnalysis, model.StepSolutionDesign, model.StepCodeGeneration:
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
	if err := c.Claude.Run(ctx, ws, c.prompt(job, step, ws, skillPaths, blueprintPaths), input, step.Kind == model.StepCodeGeneration, emit); err != nil {
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
		return c.resultFromValidatedOutput(out, err), nil
	case model.StepSolutionDesign:
		out, err := runner.ValidateSolutionDesign(ws.OutputPath())
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		return c.resultFromValidatedOutput(out, err), nil
	case model.StepCodeGeneration:
		res := c.finishCodeGeneration(ctx, job, step, ws.OutputPath(), baseline)
		c.emitWorkLog(ctx, emit, ws.OutputPath())
		return res, nil
	default:
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "unsupported claude step"}, nil
	}
}

// emitWorkLog decodes the PUBLIC workLog array from the step's output.json and
// forwards each entry as a summary record. workLog is the ONLY agent-authored
// field that becomes a record — thinking/reasoning and every other hidden
// provider field are deliberately NOT decoded into records (the decoder's struct
// only models workLog, so unknown fields are dropped by json.Unmarshal). Best
// effort: a missing/empty workLog is a no-op, never a failure.
func (c *ClaudeStepRunner) emitWorkLog(ctx context.Context, emit runner.StepRecordEmitter, outputPath string) {
	if emit == nil {
		return
	}
	entries := runner.DecodeWorkLog(outputPath)
	for _, e := range entries {
		_ = emit.Emit(ctx, model.ExecutionRecordSummary, e)
	}
}

func (c *ClaudeStepRunner) finishCodeGeneration(ctx context.Context, job model.Job, step model.JobStep, outputPath string, baseline map[string]bool) StepResult {
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
		return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true}
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

func (c *ClaudeStepRunner) resultFromValidatedOutput(out runner.StepOutput, err error) StepResult {
	if err != nil {
		return c.failureFromError(err)
	}
	if out.NeedsUserInput {
		return StepResult{Status: model.StepStatusWaitingUser, NeedsUserInput: true}
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

func (c *ClaudeStepRunner) prompt(job model.Job, step model.JobStep, ws runner.AttemptWorkspace, skillPaths, blueprintPaths []string) string {
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
		return "你是软件工厂的方案设计 agent。读取 input.json，基于用户需求输出方案设计。最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块，不要输出隐藏推理链。Factory 会把 stdout 保存为 output.json。JSON 格式必须包含 needsUserInput、questions、usedSkills，可包含 app、artifactPlan、warnings；不需要用户补充信息时 needsUserInput=false 且 questions=[]。所有供人阅读的输出字段必须使用简体中文，包括 questions、app 摘要、artifactPlan 描述、warnings、说明文案；只有标识符、slug、路径、枚举值、代码符号可保留非中文。用户需求：" + job.UserPrompt +
			skillsPromptBlock(skillPaths, blueprintPaths)
	}
	if step.Kind == model.StepCodeGeneration {
		return "你是软件工厂的代码生成 agent。你的工作目录就是软件工厂仓库根目录。只能在 generated-apps/<slug>/ 下生成静态 Vite 应用和 .factory/app.json，禁止在 factory-server/generated-apps/ 或其他目录生成文件。" +
			"工作区根目录：" + c.workspace() + "。读取输入文件：input.json 路径：" + absolutePath(ws.InputPath()) + "。" +
			"output.json 必须写入：output.json 路径：" + absolutePath(ws.OutputPath()) + "；可选生成摘要写入：output.md 路径：" + absolutePath(ws.OutputMDPath()) + "。" +
			"output.json 必须包含 projectDir、createdFiles、needsUserInput、questions、usedSkills（可含 warnings）；projectDir 和 createdFiles 必须使用仓库相对路径。" +
			".factory/app.json 必须是以下 Factory manifest 契约：schemaVersion 为 1，slug 为 <slug>，name 非空，source 为 generated，entry 为 static-vite，path 为 generated-apps/<slug>，并包含 build{command:npm run build,outputDir:dist}、runtime{devCommand:npm run dev,defaultPort:5173}、docker{enabled:true,dockerfile:Dockerfile,context:.,runtimePort:80}。" +
			"manifest JSON 字段必须包含 \"schemaVersion\": 1、\"entry\": \"static-vite\"、\"path\": \"generated-apps/<slug>\"；不要使用 deployment 或 ports 代替 build/runtime/docker。" +
			"面向用户的页面文案、标题、标签、图表说明、详情说明，以及 output.json / output.md 中的人类可读文本，默认必须使用简体中文；只有标识符、slug、路径、枚举值、代码符号可以保留非中文。" +
			"不要输出隐藏推理链。" +
			skillsPromptBlock(skillPaths, blueprintPaths)
	}
	switch step.Kind {
	case model.StepRequirementAnalysis:
		return "你是软件工厂的需求冻结 agent。读取 input.json 中的 confirmedRequirement，校验字段完整性、能力边界和 generationProfile。" +
			"AUDIT blueprintRefs（确认引用的 skill 存在于 .claude/skills/requirement-clarification/blueprints.json 且为 reference-only），将任何超出现有 skill 目录支持的请求记入 validation.unsupportedRequests。" +
			"输出 output.json，包含 confirmedRequirementId、summary、appType、appName、targetUsers、coreScenario、primaryView、mainEntities、dataPolicy、acceptanceFocus、generationProfile、constraints、risks、validation（含 complete、supported、missingFields、unsupportedRequests）。" +
			"不要进行多轮澄清（澄清已在 Job 创建前完成），不要输出 needsUserInput/questions，不要输出隐藏推理链。需求不完整或超出现有能力时，validation.complete=false 或 validation.supported=false。最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块。Factory 会把 stdout 保存为 output.json。"
	case model.StepSolutionDesign:
		return "你是软件工厂的方案设计 agent。读取 input.json，基于用户需求输出方案设计。最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块，不要隐藏推理链。Factory 会把 stdout 保存为 output.json。JSON 格式必须包含 needsUserInput、questions、usedSkills，可包含 app 和 artifactPlan、warnings；不需要用户补充信息时 needsUserInput=false 且 questions=[]。\n用户需求：" + job.UserPrompt +
			skillsPromptBlock(skillPaths, blueprintPaths)
	case model.StepCodeGeneration:
		return "你是软件工厂的代码生成 agent。你的工作目录就是软件工厂仓库根目录。只能在 generated-apps/<slug>/ 下生成静态 Vite 应用和 .factory/app.json，禁止在 factory-server/generated-apps/ 或其他目录生成文件。" +
			"工作区根目录：" + c.workspace() + "。读取输入文件：input.json 路径：" + absolutePath(ws.InputPath()) + "。" +
			"output.json 必须写入：output.json 路径：" + absolutePath(ws.OutputPath()) + "；可选生成摘要写入：output.md 路径：" + absolutePath(ws.OutputMDPath()) + "。" +
			"output.json 必须包含 projectDir、createdFiles、needsUserInput、questions、usedSkills（可含 warnings）；projectDir 和 createdFiles 必须使用仓库相对路径。" +
			".factory/app.json 必须是以下 Factory manifest 契约：schemaVersion 为 1，slug 为 <slug>，name 非空，source 为 generated，entry 为 static-vite，path 为 generated-apps/<slug>，并包含 build{command:npm run build,outputDir:dist}、runtime{devCommand:npm run dev,defaultPort:5173}、docker{enabled:true,dockerfile:Dockerfile,context:.,runtimePort:80}。" +
			"manifest JSON 字段必须包含 \"schemaVersion\": 1、\"entry\": \"static-vite\"、\"path\": \"generated-apps/<slug>\"；不要使用 deployment 或 ports 代替 build/runtime/docker。" +
			"不要输出隐藏推理链。" +
			skillsPromptBlock(skillPaths, blueprintPaths)
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
func skillsPromptBlock(skillPaths, blueprintPaths []string) string {
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
// (base/domain/pattern → skill keys) to the concrete project-local SKILL.md
// file paths under <workspace>/.claude/skills/<key>/SKILL.md. The order is
// base → domain → pattern so downstream prompts list foundational skills first.
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
	for _, group := range []string{"base", "domain", "pattern"} {
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
