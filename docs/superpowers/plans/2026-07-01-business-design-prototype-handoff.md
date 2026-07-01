# Business Design Prototype Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing `design_contract` step so the user-facing 界面解析/原型设计 stage reads the complete business-design handoff, asks prototype preference questions when needed, generates static prototype artifacts, and passes prototype constraints downstream.

**Architecture:** Keep `job_steps.kind=design_contract` for compatibility. Add an attempt-write Claude run mode for prototype artifacts, extend the design contract output with a `prototype` payload, inject a `businessDesign` handoff into `input.json`, serve prototype summaries and files through contained artifact APIs, and render prototype controls on the existing workbench interface-parsing card.

**Tech Stack:** Go `factory-server`, existing `runner.ClaudeRunner`, `executor.ClaudeStepRunner`, SQLite-backed store, `WorkbenchArtifactRef`, React/Vite `sf-portal-mvp`, Node verification scripts, project-local `.claude/skills/prototype-design/SKILL.md`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-30-prototype-design-step-upgrade-design.md`
- `docs/superpowers/specs/2026-07-01-business-design-to-prototype-flow-design.md`
- `.claude/skills/prototype-design/SKILL.md`

## Scope Check

The two specs describe one coherent subsystem: keep the existing `design_contract` step and upgrade it into a prototype-design handoff. The work crosses backend execution, server APIs, and frontend rendering, but each task below produces a testable increment on the same step contract.

## File Responsibilities

- `factory-server/internal/runner/claude.go`: add explicit Claude run modes so `design_contract` can write only inside its attempt directory.
- `factory-server/internal/runner/claude_test.go`: lock read-only, codegen, and attempt-write argv plus working directories.
- `factory-server/internal/model/prototype.go`: define prototype manifest and contract DTOs shared by executor/server tests.
- `factory-server/internal/model/model.go`: keep the existing `WorkbenchArtifactInterfacePreview` kind for prototype previews so store and frontend artifact filtering remain compatible.
- `factory-server/internal/runner/contracts.go`: extend `DesignContractOutput` to include `Prototype` while keeping `designDocument` compatibility.
- `factory-server/internal/runner/contracts_test.go`: validate prototype output, required homepage, and `needs_input` behavior.
- `factory-server/internal/executor/prototype_contract.go`: read and validate `prototype/preview-manifest.json`, `prototype/prototype-contract.json`, and `prototype/index.html` under the attempt directory.
- `factory-server/internal/executor/claude_runner.go`: inject `businessDesign`, route `design_contract` through attempt-write mode, validate prototype artifacts, register workbench artifact refs, and add prototype context for downstream steps.
- `factory-server/internal/executor/claude_runner_test.go`: cover prompt wording, input handoff, artifact registration, and downstream prototype context.
- `factory-server/internal/server/prototype_handlers.go`: serve prototype summary, preview files, feedback, confirmation, and continue-without-confirmation endpoints with path containment.
- `factory-server/internal/server/server.go`: register prototype routes.
- `factory-server/internal/server/prototype_handlers_test.go`: cover summary, preview, traversal rejection, feedback rerun, confirm, and continue-without-confirmation.
- `sf-portal-mvp/src/api/client.js`: add prototype API calls.
- `sf-portal-mvp/src/hooks/prototypeState.js`: normalize backend prototype summary for rendering.
- `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`: preserve artifact `stepId` so prototype actions can target the design step.
- `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`: render prototype preview, feedback, confirm, and continue controls on the `interface_parsing` card.
- `sf-portal-mvp/src/components/ConversationWorkbench.jsx`: wire card callbacks to the new API methods.
- `sf-portal-mvp/src/components/ConversationWorkbench.css`: style the prototype action row and embedded preview entry.
- `sf-portal-mvp/scripts/check-prototype-handoff.mjs`: static frontend regression script.
- `docs/software-factory-local-runbook.md`: document the `design_contract` compatibility key and prototype flow.

---

### Task 1: Add Claude Attempt-Write Mode

**Files:**
- Modify: `factory-server/internal/runner/claude.go`
- Test: `factory-server/internal/runner/claude_test.go`

- [ ] **Step 1: Write failing runner tests**

Append these tests to `factory-server/internal/runner/claude_test.go`:

```go
func TestClaudeRunAttemptWriteArgv(t *testing.T) {
	clearClaudeModelEnv(t)
	fr := &fakeRunner{stdout: `{"type":"result","subtype":"success","result":"{\"status\":\"passed\"}"}`}
	r := ClaudeRunner{Runner: fr, Binary: "claude", WorkDir: t.TempDir()}
	ws := newWS(t)
	ws.StepKind = model.StepDesignContract

	if err := r.RunWithMode(context.Background(), ws, "prototype prompt", []byte(`{"x":1}`), ClaudeRunAttemptWrite, nil); err != nil {
		t.Fatalf("RunWithMode err = %v", err)
	}

	got := joinArgs(fr.argv)
	want := "--print --permission-mode acceptEdits --allowedTools Read,Grep,Glob,Edit,Write --disallowedTools Bash --output-format stream-json --include-partial-messages --verbose"
	if got != want {
		t.Fatalf("attempt-write argv =\n got: %q\nwant: %q", got, want)
	}
	if gotDir := fr.dirs[len(fr.dirs)-1]; gotDir != ws.Dir() {
		t.Fatalf("attempt-write run dir = %q, want %q", gotDir, ws.Dir())
	}
}

func TestClaudeRunReadOnlyStillDisallowsWrite(t *testing.T) {
	clearClaudeModelEnv(t)
	fr := &fakeRunner{stdout: "ok"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	if err := r.Run(context.Background(), ws, "readonly", []byte(`{}`), false, nil); err != nil {
		t.Fatalf("Run err = %v", err)
	}

	got := joinArgs(fr.argv)
	if !strings.Contains(got, "--allowedTools Read,Grep,Glob") || !strings.Contains(got, "--disallowedTools Bash,Edit,Write") {
		t.Fatalf("read-only permissions changed unexpectedly: %q", got)
	}
}
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run:

```powershell
cd factory-server
go test ./internal/runner -run "TestClaudeRunAttemptWriteArgv|TestClaudeRunReadOnlyStillDisallowsWrite" -count=1
```

Expected: compile failure naming `RunWithMode` and `ClaudeRunAttemptWrite` as undefined.

- [ ] **Step 3: Add run mode types and argv builder**

In `factory-server/internal/runner/claude.go`, replace `func claudeArgv(codegen bool) []string` with:

```go
type ClaudeRunMode string

const (
	ClaudeRunReadOnly       ClaudeRunMode = "read_only"
	ClaudeRunWorkspaceWrite ClaudeRunMode = "workspace_write"
	ClaudeRunAttemptWrite   ClaudeRunMode = "attempt_write"
)

func claudeArgv(codegen bool) []string {
	if codegen {
		return claudeArgvForMode(ClaudeRunWorkspaceWrite)
	}
	return claudeArgvForMode(ClaudeRunReadOnly)
}

func claudeArgvForMode(mode ClaudeRunMode) []string {
	modelArgs := claudeModelArgs()
	stream := []string{
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
	}
	base := []string{"--print", "--permission-mode", "acceptEdits"}
	switch mode {
	case ClaudeRunWorkspaceWrite:
		return append(append(append(base, "--allowedTools", "Read,Grep,Glob,Edit,Write", "--disallowedTools", "Bash"), modelArgs...), stream...)
	case ClaudeRunAttemptWrite:
		return append(append(append(base, "--allowedTools", "Read,Grep,Glob,Edit,Write", "--disallowedTools", "Bash"), modelArgs...), stream...)
	default:
		return append(append(append(base, "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write"), modelArgs...), stream...)
	}
}
```

- [ ] **Step 4: Add `RunWithMode` and delegate `Run`**

Change `Run` to delegate:

```go
func (r *ClaudeRunner) Run(ctx context.Context, ws AttemptWorkspace, prompt string, inputData []byte, codegen bool, emit StepRecordEmitter) error {
	mode := ClaudeRunReadOnly
	if codegen {
		mode = ClaudeRunWorkspaceWrite
	}
	return r.RunWithMode(ctx, ws, prompt, inputData, mode, emit)
}
```

Create `RunWithMode` by moving the old `Run` body below the delegate. Inside that body:

```go
func (r *ClaudeRunner) RunWithMode(ctx context.Context, ws AttemptWorkspace, prompt string, inputData []byte, mode ClaudeRunMode, emit StepRecordEmitter) error {
	if emit == nil {
		emit = NopEmitter{}
	}
	if err := os.MkdirAll(ws.Dir(), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", ws.Dir(), err)
	}
	if err := os.WriteFile(ws.InputPath(), inputData, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", ws.InputPath(), err)
	}
	if err := os.WriteFile(ws.PromptPath(), []byte(prompt), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", ws.PromptPath(), err)
	}

	streamRunner, ok := r.Runner.(streamCommandRunner)
	if ok {
		return r.runStreamWithMode(ctx, ws, prompt, mode, emit, streamRunner)
	}
	inputRunner, ok := r.Runner.(inputCommandRunner)
	if !ok {
		return fmt.Errorf("claude runner does not support stdin")
	}
	runDir := runDirForMode(ws, r.WorkDir, mode)
	stage := stageForMode(mode)
	args := claudeArgvForMode(mode)
	LLMConsoleRequest(stage, r.binary(), args, prompt)
	res, err := inputRunner.RunWithInput(ctx, runDir, prompt, r.binary(), args...)
```

Keep the rest of the existing stdout/stderr capture and output fallback logic unchanged.

Add helpers:

```go
func runDirForMode(ws AttemptWorkspace, workDir string, mode ClaudeRunMode) string {
	if mode == ClaudeRunWorkspaceWrite && workDir != "" {
		return workDir
	}
	return ws.Dir()
}

func stageForMode(mode ClaudeRunMode) string {
	switch mode {
	case ClaudeRunWorkspaceWrite:
		return "code_generation"
	case ClaudeRunAttemptWrite:
		return "prototype_design"
	default:
		return "analysis_step"
	}
}
```

Rename `runStream` to `runStreamWithMode` and change its run-dir, stage, and args setup:

```go
func (r *ClaudeRunner) runStreamWithMode(ctx context.Context, ws AttemptWorkspace, prompt string, mode ClaudeRunMode, emit StepRecordEmitter, sr streamCommandRunner) error {
	runDir := runDirForMode(ws, r.WorkDir, mode)
	stage := stageForMode(mode)
	args := claudeArgvForMode(mode)
```

- [ ] **Step 5: Run runner tests and commit**

Run:

```powershell
cd factory-server
gofmt -w internal/runner/claude.go internal/runner/claude_test.go
go test ./internal/runner -count=1
```

Expected: `ok github.com/weimengtsgit/xian630/factory-server/internal/runner`.

Commit:

```powershell
git add factory-server/internal/runner/claude.go factory-server/internal/runner/claude_test.go
git commit -m "feat: add claude attempt write mode"
```

---

### Task 2: Define Prototype Output Contracts

**Files:**
- Create: `factory-server/internal/model/prototype.go`
- Modify: `factory-server/internal/runner/contracts.go`
- Test: `factory-server/internal/runner/contracts_test.go`

- [ ] **Step 1: Write failing contract tests**

Append to `factory-server/internal/runner/contracts_test.go`:

```go
func TestValidateDesignContractRequiresPrototypeHomePage(t *testing.T) {
	path := writeTempJSON(t, map[string]any{
		"status":            "passed",
		"summary":           "首页静态原型已生成",
		"needsUserInput":    false,
		"questions":         []any{},
		"designDocument":    map[string]any{"views": []string{"home"}},
		"assumedDataFields": []string{"name"},
		"prototype": map[string]any{
			"style":          "ued_review",
			"targetAudience": "ued",
			"targetPlatform": "responsive",
			"fidelity":       "static",
			"defaultPage":    "home",
			"pages": []any{
				map[string]any{"id": "home", "title": "首页", "generated": true, "visibleByDefault": true},
			},
			"confirmationPolicy": "unconfirmed_reference",
		},
		"workLog":  []any{},
		"warnings": []any{},
	})

	out, detail, err := ValidateDesignContract(path)
	if err != nil {
		t.Fatalf("ValidateDesignContract err = %v", err)
	}
	if out.NeedsUserInput {
		t.Fatalf("NeedsUserInput = true, want false")
	}
	if detail.Prototype.DefaultPage != "home" || len(detail.Prototype.Pages) != 1 {
		t.Fatalf("prototype not decoded: %+v", detail.Prototype)
	}
}

func TestValidateDesignContractRejectsPrototypeWithoutHome(t *testing.T) {
	path := writeTempJSON(t, map[string]any{
		"status":            "passed",
		"summary":           "bad prototype",
		"needsUserInput":    false,
		"questions":         []any{},
		"designDocument":    map[string]any{"views": []string{"home"}},
		"assumedDataFields": []string{},
		"prototype": map[string]any{
			"style":              "business_demo",
			"targetAudience":     "business_reviewer",
			"targetPlatform":     "web",
			"fidelity":           "static",
			"defaultPage":        "home",
			"pages":              []any{},
			"confirmationPolicy": "unconfirmed_reference",
		},
		"workLog":  []any{},
		"warnings": []any{},
	})

	_, _, err := ValidateDesignContract(path)
	if err == nil {
		t.Fatalf("expected schema error for missing homepage")
	}
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed", err)
	}
}
```

If the file lacks `writeTempJSON`, add this helper once:

```go
func writeTempJSON(t *testing.T, v any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "output.json")
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
```

Imports needed if absent: `encoding/json`, `errors`, `os`, `path/filepath`.

- [ ] **Step 2: Run the focused tests and confirm red**

Run:

```powershell
cd factory-server
go test ./internal/runner -run "TestValidateDesignContractRequiresPrototypeHomePage|TestValidateDesignContractRejectsPrototypeWithoutHome" -count=1
```

Expected: compile failure because `DesignContractOutput.Prototype` is undefined.

- [ ] **Step 3: Create model DTOs**

Create `factory-server/internal/model/prototype.go`:

```go
package model

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

type PrototypeSection struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content"`
}

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

type PrototypeManifest struct {
	Mode        string          `json:"mode"`
	DefaultPage string          `json:"defaultPage"`
	Fidelity    string          `json:"fidelity"`
	Pages       []PrototypePage `json:"pages"`
}

type PrototypeContract struct {
	PrototypeStatus          string          `json:"prototypeStatus"`
	DownstreamConstraintLevel string          `json:"downstreamConstraintLevel"`
	Immutable                bool            `json:"immutable"`
	Prototype                PrototypeSpec   `json:"prototype"`
	DesignDocument           any             `json:"designDocument,omitempty"`
	AssumedDataFields        []string        `json:"assumedDataFields,omitempty"`
}
```

- [ ] **Step 4: Extend `DesignContractOutput` and validate homepage**

In `factory-server/internal/runner/contracts.go`, add the import:

```go
import "github.com/weimengtsgit/xian630/factory-server/internal/model"
```

Add a field to `DesignContractOutput`:

```go
Prototype model.PrototypeSpec `json:"prototype"`
```

After the existing `summary/designDocument` check in `ValidateDesignContract`, add:

```go
if err := validatePrototypeSpec(raw.Prototype); err != nil {
	return StepOutput{}, raw, err
}
```

Add:

```go
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
```

- [ ] **Step 5: Run contract tests and commit**

Run:

```powershell
cd factory-server
gofmt -w internal/model/prototype.go internal/runner/contracts.go internal/runner/contracts_test.go
go test ./internal/runner -run "DesignContract|Prototype" -count=1
```

Expected: focused tests pass.

Commit:

```powershell
git add factory-server/internal/model/prototype.go factory-server/internal/runner/contracts.go factory-server/internal/runner/contracts_test.go
git commit -m "feat: define prototype design contract"
```

---

### Task 3: Inject Business Design Handoff Into `design_contract`

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go`
- Test: `factory-server/internal/executor/claude_runner_test.go`

- [ ] **Step 1: Write failing input and prompt tests**

Append to `factory-server/internal/executor/claude_runner_test.go`:

```go
func TestDesignContractInputIncludesBusinessDesignHandoff(t *testing.T) {
	ws := t.TempDir()
	st := store.NewMemoryStore(t)
	job, step := claudeJobStep(model.StepDesignContract)
	job.ID = "job_business_handoff"
	job.DialogueID = "dlg_business_handoff"
	job.ConfirmedRequirementJSON = `{"appName":"请假管理","coreScenario":"员工提交请假并由主管审批"}`
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if err := st.CreateJobStep(context.Background(), model.JobStep{
		ID: "step_req", JobID: job.ID, Kind: model.StepRequirementAnalysis, Seq: 1, Status: model.StepStatusSucceeded, Attempt: 1,
	}); err != nil {
		t.Fatalf("CreateJobStep requirement: %v", err)
	}

	artifactRoot := filepath.Join(ws, ".factory-runs")
	reqDir := filepath.Join(artifactRoot, "jobs", job.ID, "requirement_analysis", "attempt-1")
	if err := os.MkdirAll(reqDir, 0o755); err != nil {
		t.Fatal(err)
	}
	businessDesign := `{"summary":"完整业务设计方案","actors":["员工","主管"],"flows":["提交","审批"]}`
	if err := os.WriteFile(filepath.Join(reqDir, "output.json"), []byte(businessDesign), 0o644); err != nil {
		t.Fatal(err)
	}

	fr := &fakeClaudeRunner{output: designContractOutputWithPrototype(t)}
	r := &ClaudeStepRunner{
		Store: st,
		Workspace: ws,
		ArtifactRoot: artifactRoot,
		Claude: &runner.ClaudeRunner{Runner: fr, Binary: "claude"},
	}

	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s: %s", res.Status, res.ErrorMessage)
	}

	inputPath := filepath.Join(artifactRoot, "jobs", job.ID, "design_contract", "attempt-1", "input.json")
	input, err := os.ReadFile(inputPath)
	if err != nil {
		t.Fatalf("read input: %v", err)
	}
	if !bytes.Contains(input, []byte(`"businessDesign"`)) || !bytes.Contains(input, []byte("完整业务设计方案")) {
		t.Fatalf("input missing businessDesign handoff:\n%s", input)
	}
	if !bytes.Contains(input, []byte(`"businessDesignArtifact"`)) || !bytes.Contains(input, []byte("requirement_analysis/attempt-1/output.json")) {
		t.Fatalf("input missing businessDesignArtifact:\n%s", input)
	}
}

func TestDesignContractPromptNamesBusinessDesignAsPrimaryInput(t *testing.T) {
	ws := runner.AttemptWorkspace{Root: t.TempDir(), JobID: "job_prompt", StepKind: model.StepDesignContract, Attempt: 1}
	job, step := claudeJobStep(model.StepDesignContract)
	prompt := collaborationProducerPrompt(job, step, ws)

	for _, want := range []string{
		"业务智能体完整设计方案",
		"businessDesign 是原型设计的主输入",
		".claude/skills/prototype-design/SKILL.md",
		"原型风格、目标用户、目标平台",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}
```

Add helper if absent:

```go
func designContractOutputWithPrototype(t *testing.T) string {
	t.Helper()
	return mustJSON(t, map[string]any{
		"status":            "passed",
		"summary":           "已生成静态原型",
		"needsUserInput":    false,
		"questions":         []any{},
		"designDocument":    map[string]any{"views": []string{"home"}},
		"assumedDataFields": []string{"applicant"},
		"prototype": map[string]any{
			"style": "ued_review", "targetAudience": "ued", "targetPlatform": "responsive",
			"fidelity": "static", "defaultPage": "home", "confirmationPolicy": "unconfirmed_reference",
			"pages": []any{map[string]any{"id": "home", "title": "首页", "generated": true, "visibleByDefault": true}},
		},
		"workLog":  []any{},
		"warnings": []any{},
	})
}
```

- [ ] **Step 2: Run focused tests and confirm red**

Run:

```powershell
cd factory-server
go test ./internal/executor -run "TestDesignContractInputIncludesBusinessDesignHandoff|TestDesignContractPromptNamesBusinessDesignAsPrimaryInput" -count=1
```

Expected: input test fails because `businessDesign` is absent; prompt test fails because current wording still centers interface contract.

- [ ] **Step 3: Add business-design handoff loader**

In `factory-server/internal/executor/claude_runner.go`, add:

```go
type businessDesignHandoff struct {
	Content      json.RawMessage `json:"content,omitempty"`
	Summary      string          `json:"summary,omitempty"`
	ArtifactPath string          `json:"artifactPath,omitempty"`
}

func (c *ClaudeStepRunner) businessDesignHandoff(job model.Job, step model.JobStep) (businessDesignHandoff, error) {
	if step.Kind != model.StepDesignContract {
		return businessDesignHandoff{}, nil
	}
	path := filepath.ToSlash(filepath.Join("jobs", job.ID, string(model.StepRequirementAnalysis), "attempt-1", "output.json"))
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
```

- [ ] **Step 4: Inject handoff into `input.json`**

Before `json.MarshalIndent(map[string]any{...})`, compute:

```go
businessDesign, err := c.businessDesignHandoff(job, step)
if err != nil {
	return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
}
```

Add these keys to the input map:

```go
"businessDesign":         businessDesign.Content,
"businessDesignSummary":  businessDesign.Summary,
"businessDesignArtifact": businessDesign.ArtifactPath,
```

- [ ] **Step 5: Rewrite `designContractPrompt`**

Replace `designContractPrompt` with:

```go
func designContractPrompt(job model.Job, ws runner.AttemptWorkspace) string {
	return "你是软件工厂的原型设计协作智能体，运行在用户可见的界面解析阶段。先 Read 并严格遵循项目本地 skill：.claude/skills/prototype-design/SKILL.md。" +
		"读取 input.json，其中 businessDesign 是原型设计的主输入，来自业务智能体完整设计方案；confirmedRequirement 只作为边界与一致性校验，不能替代完整设计方案。" +
		"如果 businessDesign 缺失，只能使用 confirmedRequirement 兼容推进，并在 warnings 记录降级原因。" +
		"需要在原型风格、目标用户、目标平台或保真度缺失、冲突、影响验收时，输出 status=\"needs_input\"、needsUserInput=true 和结构化 questions。" +
		"默认 fidelity=static，targetPlatform=responsive，prototype 必须描述静态原型页面方案，默认首页为 home。" +
		"允许在当前 attempt 目录下写入 prototype/index.html、prototype/styles.css、prototype/preview-manifest.json、prototype/prototype-contract.json；禁止写入仓库工作目录或最终应用目录，禁止调用 Bash。" +
		"最终回答必须只包含一个 JSON 对象，不要 Markdown，不要代码块。Factory 会把 stdout 保存为 output.json，路径：" + absolutePath(ws.OutputPath()) + "。" +
		"JSON 必须包含：status、summary、needsUserInput、questions、designDocument、assumedDataFields、prototype、workLog、warnings。" +
		"designDocument 与 prototype 必须描述同一套页面设计；如用户后续确认原型，预览将成为后续验收基线。" +
		"所有人类可读文本必须使用简体中文；只有标识符、路径、枚举值和代码符号可以保留英文。用户需求：" + job.UserPrompt
}
```

- [ ] **Step 6: Run executor tests and commit**

Run:

```powershell
cd factory-server
gofmt -w internal/executor/claude_runner.go internal/executor/claude_runner_test.go
go test ./internal/executor -run "DesignContract|BusinessDesign" -count=1
```

Expected: focused tests pass.

Commit:

```powershell
git add factory-server/internal/executor/claude_runner.go factory-server/internal/executor/claude_runner_test.go
git commit -m "feat: pass business design into prototype step"
```

---

### Task 4: Validate And Register Prototype Artifacts

**Files:**
- Create: `factory-server/internal/executor/prototype_contract.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Test: `factory-server/internal/executor/prototype_contract_test.go`
- Test: `factory-server/internal/executor/claude_runner_test.go`

- [ ] **Step 1: Write failing prototype artifact tests**

Create `factory-server/internal/executor/prototype_contract_test.go`:

```go
package executor

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

func TestReadPrototypeBundleRequiresContainedFiles(t *testing.T) {
	ws := runner.AttemptWorkspace{Root: t.TempDir(), JobID: "job_1", StepKind: model.StepDesignContract, Attempt: 1}
	protoDir := filepath.Join(ws.Dir(), "prototype")
	if err := os.MkdirAll(protoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(protoDir, "index.html"), "<!doctype html><title>首页</title>")
	writeFile(t, filepath.Join(protoDir, "styles.css"), "body{margin:0}")
	writeFile(t, filepath.Join(protoDir, "preview-manifest.json"), `{"mode":"static","defaultPage":"home","fidelity":"static","pages":[{"id":"home","title":"首页","file":"prototype/index.html","generated":true,"visibleByDefault":true}]}`)
	writeFile(t, filepath.Join(protoDir, "prototype-contract.json"), `{"prototypeStatus":"unconfirmed","downstreamConstraintLevel":"reference","immutable":false,"prototype":{"style":"ued_review","targetAudience":"ued","targetPlatform":"responsive","fidelity":"static","defaultPage":"home","confirmationPolicy":"unconfirmed_reference","pages":[{"id":"home","title":"首页","generated":true,"visibleByDefault":true}]}}`)

	bundle, err := readPrototypeBundle(ws)
	if err != nil {
		t.Fatalf("readPrototypeBundle err = %v", err)
	}
	if bundle.PreviewRelPath != "jobs/job_1/design_contract/attempt-1/prototype/preview-manifest.json" {
		t.Fatalf("PreviewRelPath = %q", bundle.PreviewRelPath)
	}
}

func TestReadPrototypeBundleRejectsPreviewOutsidePrototypeDir(t *testing.T) {
	ws := runner.AttemptWorkspace{Root: t.TempDir(), JobID: "job_1", StepKind: model.StepDesignContract, Attempt: 1}
	protoDir := filepath.Join(ws.Dir(), "prototype")
	if err := os.MkdirAll(protoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(protoDir, "index.html"), "<!doctype html>")
	writeFile(t, filepath.Join(protoDir, "styles.css"), "body{}")
	writeFile(t, filepath.Join(protoDir, "preview-manifest.json"), `{"mode":"static","defaultPage":"home","fidelity":"static","pages":[{"id":"home","title":"首页","file":"../secret.html","generated":true,"visibleByDefault":true}]}`)
	writeFile(t, filepath.Join(protoDir, "prototype-contract.json"), `{"prototypeStatus":"unconfirmed","downstreamConstraintLevel":"reference","immutable":false,"prototype":{"style":"ued_review","targetAudience":"ued","targetPlatform":"responsive","fidelity":"static","defaultPage":"home","confirmationPolicy":"unconfirmed_reference","pages":[{"id":"home","title":"首页","generated":true,"visibleByDefault":true}]}}`)

	if _, err := readPrototypeBundle(ws); err == nil {
		t.Fatalf("expected traversal-style preview file to be rejected")
	}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
```

- [ ] **Step 2: Run focused tests and confirm red**

Run:

```powershell
cd factory-server
go test ./internal/executor -run "TestReadPrototypeBundle" -count=1
```

Expected: compile failure because `readPrototypeBundle` is undefined.

- [ ] **Step 3: Implement bundle reader**

Create `factory-server/internal/executor/prototype_contract.go`:

```go
package executor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

type prototypeBundle struct {
	Manifest       model.PrototypeManifest
	Contract       model.PrototypeContract
	PreviewRelPath string
	ContractRelPath string
	IndexRelPath   string
}

func readPrototypeBundle(ws runner.AttemptWorkspace) (prototypeBundle, error) {
	protoDir := filepath.Join(ws.Dir(), "prototype")
	manifestPath := filepath.Join(protoDir, "preview-manifest.json")
	contractPath := filepath.Join(protoDir, "prototype-contract.json")
	indexPath := filepath.Join(protoDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		return prototypeBundle{}, fmt.Errorf("prototype index.html required: %w", err)
	}
	var manifest model.PrototypeManifest
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		return prototypeBundle{}, err
	}
	var contract model.PrototypeContract
	if err := readJSONFile(contractPath, &contract); err != nil {
		return prototypeBundle{}, err
	}
	if manifest.DefaultPage != "home" || len(manifest.Pages) == 0 {
		return prototypeBundle{}, fmt.Errorf("prototype manifest home page required")
	}
	for _, page := range manifest.Pages {
		if page.Generated && !safePrototypeFile(page.File) {
			return prototypeBundle{}, fmt.Errorf("unsafe prototype page file %q", page.File)
		}
	}
	baseRel := filepath.ToSlash(filepath.Join("jobs", ws.JobID, string(ws.StepKind), fmt.Sprintf("attempt-%d", ws.Attempt), "prototype"))
	return prototypeBundle{
		Manifest:        manifest,
		Contract:        contract,
		PreviewRelPath:  baseRel + "/preview-manifest.json",
		ContractRelPath: baseRel + "/prototype-contract.json",
		IndexRelPath:    baseRel + "/index.html",
	}, nil
}

func readJSONFile(path string, out any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

func safePrototypeFile(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	return strings.HasPrefix(clean, "prototype/") && !strings.Contains(clean, "../") && !filepath.IsAbs(clean)
}
```

- [ ] **Step 4: Route `design_contract` through attempt-write mode and register artifact**

In `ClaudeStepRunner.Run`, replace:

```go
if err := c.Claude.Run(ctx, ws, prompt, input, step.Kind == model.StepCodeGeneration, emit); err != nil {
```

with:

```go
mode := runner.ClaudeRunReadOnly
if step.Kind == model.StepCodeGeneration {
	mode = runner.ClaudeRunWorkspaceWrite
}
if step.Kind == model.StepDesignContract {
	mode = runner.ClaudeRunAttemptWrite
}
if err := c.Claude.RunWithMode(ctx, ws, prompt, input, mode, emit); err != nil {
```

In the `model.StepDesignContract` success branch, after `ValidateDesignContract`, replace deterministic manifest-only snapshot creation with:

```go
bundle, perr := readPrototypeBundle(ws)
if perr != nil {
	return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed, ErrorMessage: perr.Error()}, nil
}
ref, perr := c.createPrototypePreviewArtifact(ctx, job, step, ws, design, bundle)
if perr != nil {
	return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed, ErrorMessage: perr.Error()}, nil
}
c.upsertWorkbenchArtifact(ctx, ref)
```

Add:

```go
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
```

- [ ] **Step 5: Run executor tests and commit**

Run:

```powershell
cd factory-server
gofmt -w internal/executor/prototype_contract.go internal/executor/prototype_contract_test.go internal/executor/claude_runner.go
go test ./internal/executor -run "Prototype|DesignContract" -count=1
```

Expected: focused tests pass.

Commit:

```powershell
git add factory-server/internal/executor/prototype_contract.go factory-server/internal/executor/prototype_contract_test.go factory-server/internal/executor/claude_runner.go factory-server/internal/executor/claude_runner_test.go
git commit -m "feat: retain prototype artifacts from design contract"
```

---

### Task 5: Add Prototype Server APIs

**Files:**
- Create: `factory-server/internal/server/prototype_handlers.go`
- Modify: `factory-server/internal/server/server.go`
- Test: `factory-server/internal/server/prototype_handlers_test.go`

- [ ] **Step 1: Write failing API tests**

Create `factory-server/internal/server/prototype_handlers_test.go` with tests named:

```go
func TestJobPrototypeSummaryReturnsLatestPrototypeRef(t *testing.T)
func TestJobPrototypePreviewServesIndexWithNoStore(t *testing.T)
func TestJobPrototypePreviewRejectsTraversalPage(t *testing.T)
func TestConfirmPrototypeMarksArtifactConfirmed(t *testing.T)
func TestContinuePrototypeMarksReference(t *testing.T)
```

Use existing server test helpers from `workbench_artifact_handlers_test.go`: create a job, create a `design_contract` step, write prototype files under `ArtifactRoot/jobs/<job>/design_contract/attempt-1/prototype/`, upsert an `interface_preview` ref with `Label: "原型预览"`, then call the routes below.

Expected route assertions:

```go
GET  /api/jobs/job_1/steps/step_design/prototype
GET  /api/jobs/job_1/steps/step_design/prototype/preview
POST /api/jobs/job_1/steps/step_design/prototype/confirm
POST /api/jobs/job_1/steps/step_design/prototype/continue-without-confirmation
```

For preview response:

```go
if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
	t.Fatalf("content-type = %q", ct)
}
if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
	t.Fatalf("Cache-Control = %q, want no-store", cc)
}
```

- [ ] **Step 2: Run focused tests and confirm red**

Run:

```powershell
cd factory-server
go test ./internal/server -run "Prototype" -count=1
```

Expected: 404 for unregistered routes or compile failure for missing handlers.

- [ ] **Step 3: Register routes**

In `factory-server/internal/server/server.go`, add:

```go
r.Handle("GET", "/api/jobs/:id/steps/:stepID/prototype", s.jobPrototypeSummary)
r.Handle("GET", "/api/jobs/:id/steps/:stepID/prototype/preview", s.jobPrototypePreview)
r.Handle("POST", "/api/jobs/:id/steps/:stepID/prototype/feedback", s.jobPrototypeFeedback)
r.Handle("POST", "/api/jobs/:id/steps/:stepID/prototype/confirm", s.confirmJobPrototype)
r.Handle("POST", "/api/jobs/:id/steps/:stepID/prototype/continue-without-confirmation", s.continueJobPrototypeWithoutConfirmation)
```

- [ ] **Step 4: Implement contained summary and preview**

Create `factory-server/internal/server/prototype_handlers.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Server) jobPrototypeSummary(w http.ResponseWriter, r *http.Request) {
	ref, manifest, contract, ok := s.latestPrototypeRef(r, true)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"artifactId":    ref.ID,
		"status":        ref.Status,
		"label":         ref.Label,
		"previewUrl":    ref.PreviewURL,
		"manifest":      manifest,
		"contract":      contract,
		"snapshotHash":  ref.SnapshotHash,
		"updatedAt":     ref.UpdatedAt,
	})
}

func (s *Server) jobPrototypePreview(w http.ResponseWriter, r *http.Request) {
	ref, _, _, ok := s.latestPrototypeRef(r, false)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	indexPath := prototypeIndexPathFromRef(ref)
	full, ok := resolveAttachmentPath(s.cfg.ArtifactRoot, indexPath)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusNotFound, "prototype unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

func prototypeIndexPathFromRef(ref *model.WorkbenchArtifactRef) string {
	if strings.HasSuffix(ref.Path, "/preview-manifest.json") {
		return strings.TrimSuffix(ref.Path, "/preview-manifest.json") + "/index.html"
	}
	return filepath.ToSlash(filepath.Join(filepath.Dir(ref.Path), "index.html"))
}
```

Also add `latestPrototypeRef` to load refs, ensure job/step match, read JSON manifest and contract, and reject missing files:

```go
func (s *Server) latestPrototypeRef(r *http.Request, readDetails bool) (*model.WorkbenchArtifactRef, map[string]any, map[string]any, bool) {
	jobID := Param(r, "id")
	stepID := Param(r, "stepID")
	refs, err := s.store.ListWorkbenchArtifactRefsByJob(r.Context(), jobID)
	if err != nil {
		return nil, nil, nil, false
	}
	var match *model.WorkbenchArtifactRef
	for i := range refs {
		ref := &refs[i]
		if ref.StepID != stepID || ref.Kind != model.WorkbenchArtifactInterfacePreview || ref.CardKey != "interface_parsing" {
			continue
		}
		if match == nil || ref.UpdatedAt.After(match.UpdatedAt) {
			match = ref
		}
	}
	if match == nil {
		return nil, nil, nil, false
	}
	if !readDetails {
		return match, nil, nil, true
	}
	var manifest map[string]any
	if !readArtifactJSON(s.cfg.ArtifactRoot, match.Path, &manifest) {
		return nil, nil, nil, false
	}
	contractPath := strings.TrimSuffix(match.Path, "/preview-manifest.json") + "/prototype-contract.json"
	var contract map[string]any
	if !readArtifactJSON(s.cfg.ArtifactRoot, contractPath, &contract) {
		return nil, nil, nil, false
	}
	return match, manifest, contract, true
}

func readArtifactJSON(root, rel string, out any) bool {
	full, ok := resolveAttachmentPath(root, rel)
	if !ok {
		return false
	}
	raw, err := os.ReadFile(full)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, out) == nil
}
```

- [ ] **Step 5: Implement confirm and continue**

In the same file:

```go
func (s *Server) confirmJobPrototype(w http.ResponseWriter, r *http.Request) {
	s.setPrototypeStatus(w, r, "confirmed")
}

func (s *Server) continueJobPrototypeWithoutConfirmation(w http.ResponseWriter, r *http.Request) {
	s.setPrototypeStatus(w, r, "continued_without_confirmation")
}

func (s *Server) setPrototypeStatus(w http.ResponseWriter, r *http.Request, status string) {
	ref, manifest, contract, ok := s.latestPrototypeRef(r, true)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	if ref.Status == "confirmed" && status != "confirmed" {
		writeError(w, http.StatusConflict, "confirmed prototype is immutable")
		return
	}
	ref.Status = status
	ref.UpdatedAt = time.Now()
	if err := s.store.UpsertWorkbenchArtifactRef(r.Context(), *ref); err != nil {
		writeError(w, http.StatusInternalServerError, "update prototype")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"artifactId": ref.ID,
		"status":     ref.Status,
		"manifest":   manifest,
		"contract":   contract,
	})
}

func (s *Server) jobPrototypeFeedback(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Feedback string `json:"feedback"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Feedback) == "" {
		writeError(w, http.StatusBadRequest, "feedback required")
		return
	}
	id := Param(r, "id")
	stepID := Param(r, "stepID")
	job, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	steps, err := s.store.ListJobSteps(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	var targetStep *model.JobStep
	for i := range steps {
		if steps[i].ID == stepID {
			targetStep = &steps[i]
			break
		}
	}
	if targetStep == nil || targetStep.Kind != model.StepDesignContract {
		writeError(w, http.StatusNotFound, "prototype step not found")
		return
	}
	if err := s.store.SetStepUserPrompt(r.Context(), targetStep.ID, strings.TrimSpace(body.Feedback)); err != nil {
		writeError(w, http.StatusInternalServerError, "set prototype feedback")
		return
	}
	if err := s.store.ResetStepToPending(r.Context(), targetStep.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "reset prototype step")
		return
	}
	s.publishStepUpdated(r.Context(), targetStep.ID)
	if s.exec != nil {
		s.exec.Signal()
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "accepted", "stepId": targetStep.ID})
}
```

This endpoint mirrors the step-answer behavior used by `/api/jobs/:id/answer`: it persists the feedback into `job_steps.user_prompt`, resets the `design_contract` step to pending, publishes the step update, and signals the executor.

- [ ] **Step 6: Run server tests and commit**

Run:

```powershell
cd factory-server
gofmt -w internal/server/prototype_handlers.go internal/server/prototype_handlers_test.go internal/server/server.go
go test ./internal/server -run "Prototype|InterfacePreview" -count=1
```

Expected: focused server tests pass.

Commit:

```powershell
git add factory-server/internal/server/prototype_handlers.go factory-server/internal/server/prototype_handlers_test.go factory-server/internal/server/server.go
git commit -m "feat: expose prototype preview APIs"
```

---

### Task 6: Pass Prototype Context Downstream

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go`
- Test: `factory-server/internal/executor/claude_runner_test.go`

- [ ] **Step 1: Write failing downstream context test**

Append:

```go
func TestSolutionDesignPromptIncludesConfirmedPrototypeContext(t *testing.T) {
	st := store.NewMemoryStore(t)
	job, step := claudeJobStep(model.StepSolutionDesign)
	job.ID = "job_proto_downstream"
	job.DialogueID = "dlg_proto_downstream"
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := st.UpsertWorkbenchArtifactRef(context.Background(), model.WorkbenchArtifactRef{
		ID: "warf_proto_1", DialogueID: job.DialogueID, JobID: job.ID, StepID: "step_design",
		CardKey: "interface_parsing", Kind: model.WorkbenchArtifactInterfacePreview,
		Label: "原型预览", Path: "jobs/job_proto_downstream/design_contract/attempt-1/prototype/preview-manifest.json",
		Status: "confirmed", Metadata: `{"contractPath":"jobs/job_proto_downstream/design_contract/attempt-1/prototype/prototype-contract.json"}`,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	r := &ClaudeStepRunner{Store: st, Workspace: t.TempDir(), ArtifactRoot: t.TempDir()}
	prompt := r.prompt(job, step, runner.AttemptWorkspace{Root: t.TempDir(), JobID: job.ID, StepKind: step.Kind, Attempt: 1}, nil, nil, "")
	block := r.prototypeContextPromptBlock(context.Background(), job.ID, step.Kind)

	if !strings.Contains(block, "prototype-contract.json") || !strings.Contains(block, "hard_constraint") {
		t.Fatalf("prototype block missing confirmed constraint:\n%s\nprompt:\n%s", block, prompt)
	}
}
```

- [ ] **Step 2: Run focused test and confirm red**

Run:

```powershell
cd factory-server
go test ./internal/executor -run TestSolutionDesignPromptIncludesConfirmedPrototypeContext -count=1
```

Expected: compile failure because `prototypeContextPromptBlock` is missing.

- [ ] **Step 3: Implement prototype prompt block**

In `factory-server/internal/executor/claude_runner.go` add:

```go
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
```

After existing `finalDataAccessPromptBlock` and `collaborationSnapshotPromptBlock` appends, add:

```go
if block := c.prototypeContextPromptBlock(ctx, job.ID, step.Kind); block != "" {
	prompt += block
}
```

- [ ] **Step 4: Run executor tests and commit**

Run:

```powershell
cd factory-server
gofmt -w internal/executor/claude_runner.go internal/executor/claude_runner_test.go
go test ./internal/executor -run "Prototype|SolutionDesignPrompt" -count=1
```

Expected: focused tests pass.

Commit:

```powershell
git add factory-server/internal/executor/claude_runner.go factory-server/internal/executor/claude_runner_test.go
git commit -m "feat: pass prototype constraints downstream"
```

---

### Task 7: Render Prototype Controls In Workbench

**Files:**
- Modify: `sf-portal-mvp/src/api/client.js`
- Create: `sf-portal-mvp/src/hooks/prototypeState.js`
- Modify: `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`
- Modify: `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Test: `sf-portal-mvp/scripts/check-prototype-handoff.mjs`
- Modify: `sf-portal-mvp/package.json`

- [ ] **Step 1: Write failing frontend regression script**

Create `sf-portal-mvp/scripts/check-prototype-handoff.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('src/api/client.js', 'utf8')
const hook = fs.existsSync('src/hooks/prototypeState.js') ? fs.readFileSync('src/hooks/prototypeState.js', 'utf8') : ''
const block = fs.readFileSync('src/components/WorkbenchAgentBlock.jsx', 'utf8')
const workbench = fs.readFileSync('src/components/ConversationWorkbench.jsx', 'utf8')

for (const token of [
  'getJobPrototype',
  'getJobPrototypePreviewUrl',
  'sendPrototypeFeedback',
  'confirmPrototype',
  'continuePrototypeWithoutConfirmation',
]) {
  assert.match(client, new RegExp(token), `client missing ${token}`)
}

assert.match(hook, /normalizePrototypeSummary/, 'prototypeState hook missing normalizer')
assert.match(fs.readFileSync('src/hooks/workbenchOrchestrationState.js', 'utf8'), /stepId: String\(item.stepId/, 'artifact normalization must preserve stepId')
assert.match(block, /原型预览/, 'agent block missing prototype preview copy')
assert.match(block, /确认原型并继续/, 'agent block missing confirm prototype action')
assert.match(block, /直接进入方案设计/, 'agent block missing continue action')
assert.match(workbench, /handlePrototypeFeedback/, 'workbench missing prototype feedback wiring')

console.log('prototype handoff checks passed')
```

Add to `sf-portal-mvp/package.json` scripts:

```json
"check:prototype-handoff": "node scripts/check-prototype-handoff.mjs"
```

- [ ] **Step 2: Run script and confirm red**

Run:

```powershell
cd sf-portal-mvp
npm run check:prototype-handoff
```

Expected: assertion failure because API methods and UI copy are missing.

- [ ] **Step 3: Add API methods**

In `sf-portal-mvp/src/api/client.js`, add:

```js
  getJobPrototype: (jobId, stepId) =>
    request(`/api/jobs/${jobId}/steps/${stepId}/prototype`),
  getJobPrototypePreviewUrl: (jobId, stepId) =>
    `${API_BASE_URL}/api/jobs/${jobId}/steps/${stepId}/prototype/preview`,
  sendPrototypeFeedback: (jobId, stepId, feedback) =>
    request(`/api/jobs/${jobId}/steps/${stepId}/prototype/feedback`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    }),
  confirmPrototype: (jobId, stepId) =>
    request(`/api/jobs/${jobId}/steps/${stepId}/prototype/confirm`, { method: 'POST' }),
  continuePrototypeWithoutConfirmation: (jobId, stepId) =>
    request(`/api/jobs/${jobId}/steps/${stepId}/prototype/continue-without-confirmation`, { method: 'POST' }),
```

- [ ] **Step 4: Preserve artifact step ids and create prototype state normalizer**

In `sf-portal-mvp/src/hooks/workbenchOrchestrationState.js`, extend each artifact projection in `artifactsForCard` with:

```js
      stepId: String(item.stepId || item.step_id || ''),
```

Create `sf-portal-mvp/src/hooks/prototypeState.js`:

```js
export function normalizePrototypeSummary(summary) {
  if (!summary) return null
  const manifest = summary.manifest || {}
  const contract = summary.contract || {}
  const pages = Array.isArray(manifest.pages) ? manifest.pages : []
  return {
    artifactId: summary.artifactId || '',
    status: summary.status || 'unconfirmed',
    label: summary.label || '原型预览',
    previewUrl: summary.previewUrl || '',
    jobId: summary.jobId || '',
    stepId: summary.stepId || '',
    defaultPage: manifest.defaultPage || 'home',
    fidelity: manifest.fidelity || contract?.prototype?.fidelity || 'static',
    pages,
    pageLabels: pages.map(page => page.title || page.id).filter(Boolean),
    canConfirm: summary.status !== 'confirmed',
    canContinue: summary.status !== 'confirmed',
  }
}
```

- [ ] **Step 5: Render prototype controls**

In `sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx`, update the signature:

```js
export function WorkbenchAgentBlock({
  card,
  thinking,
  analysisLog,
  questions = [],
  prototype,
  onConfirm,
  onOpenArtifact,
  onSubmitCredential,
  onOpenPrototype,
  onPrototypeFeedback,
  onConfirmPrototype,
  onContinuePrototype,
}) {
```

Inside the body after `ArtifactList`, add:

```jsx
          {prototype ? (
            <section className="cw-agent-section cw-prototype-card">
              <h4>原型预览</h4>
              <p>{prototype.label} · {prototype.fidelity} · 默认页：{prototype.defaultPage}</p>
              {prototype.pageLabels.length ? <p>页面清单：{prototype.pageLabels.join(' / ')}</p> : null}
              <div className="cw-prototype-actions">
                <button type="button" onClick={() => onOpenPrototype && onOpenPrototype(prototype)}>打开预览</button>
                <button type="button" onClick={() => onPrototypeFeedback && onPrototypeFeedback(prototype)}>提出修改</button>
                {prototype.canConfirm ? <button type="button" onClick={() => onConfirmPrototype && onConfirmPrototype(prototype)}>确认原型并继续</button> : null}
                {prototype.canContinue ? <button type="button" onClick={() => onContinuePrototype && onContinuePrototype(prototype)}>直接进入方案设计</button> : null}
              </div>
            </section>
          ) : null}
```

- [ ] **Step 6: Wire workbench callbacks**

In `sf-portal-mvp/src/components/ConversationWorkbench.jsx`, import:

```js
import { normalizePrototypeSummary } from '../hooks/prototypeState'
```

Derive `prototype` directly from the `interface_parsing` card's latest `interface_preview` artifact:

```js
function prototypeFromCard(card) {
  const artifact = (card.artifacts || []).find(item => item.kind === 'interface_preview')
  if (!artifact) return null
  return normalizePrototypeSummary({
    artifactId: artifact.id,
    status: artifact.status,
    label: artifact.label,
    previewUrl: artifact.previewUrl,
    jobId: artifact.jobId,
    stepId: artifact.stepId,
    manifest: artifact.metadata && artifact.metadata.manifest ? artifact.metadata.manifest : {},
    contract: artifact.metadata && artifact.metadata.contract ? artifact.metadata.contract : {},
  })
}
```

Pass `prototype={card.key === 'interface_parsing' ? prototypeFromCard(card) : null}` to `WorkbenchAgentBlock`.

Add handlers:

```js
async function handleOpenPrototype(prototype) {
  if (prototype.previewUrl) window.open(prototype.previewUrl, '_blank', 'noopener,noreferrer')
}

async function handlePrototypeFeedback(prototype) {
  const feedback = window.prompt('请输入原型修改意见')
  if (!feedback || !feedback.trim()) return
  await factoryApi.sendPrototypeFeedback(prototype.jobId, prototype.stepId, feedback.trim())
}

async function handleConfirmPrototype(prototype) {
  await factoryApi.confirmPrototype(prototype.jobId, prototype.stepId)
}

async function handleContinuePrototype(prototype) {
  await factoryApi.continuePrototypeWithoutConfirmation(prototype.jobId, prototype.stepId)
}
```

Pass these handlers into `WorkbenchAgentBlock`.

- [ ] **Step 7: Add CSS**

In `sf-portal-mvp/src/components/ConversationWorkbench.css`, add:

```css
.cw-prototype-card {
  border: 1px solid rgba(35, 46, 72, 0.14);
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}

.cw-prototype-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.cw-prototype-actions button {
  min-height: 32px;
  border: 1px solid rgba(35, 46, 72, 0.16);
  border-radius: 6px;
  background: #f8fafc;
  color: #1f2937;
  padding: 0 10px;
}
```

- [ ] **Step 8: Run frontend checks and commit**

Run:

```powershell
cd sf-portal-mvp
npm run check:prototype-handoff
npm run build
```

Expected: script prints `prototype handoff checks passed`; build completes successfully.

Commit:

```powershell
git add sf-portal-mvp/src/api/client.js sf-portal-mvp/src/hooks/prototypeState.js sf-portal-mvp/src/hooks/workbenchOrchestrationState.js sf-portal-mvp/src/components/WorkbenchAgentBlock.jsx sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/scripts/check-prototype-handoff.mjs sf-portal-mvp/package.json
git commit -m "feat: show prototype handoff controls"
```

---

### Task 8: Update Runbook And Full Verification

**Files:**
- Modify: `docs/software-factory-local-runbook.md`

- [ ] **Step 1: Add runbook section**

Append:

```markdown
## 界面解析 / 原型设计兼容键

Factory 仍使用内部 step kind `design_contract` 表示界面解析阶段，避免历史 job 和数据库迁移断裂。用户界面将该阶段展示为“界面解析/原型设计”。

执行输入以业务智能体完整设计方案为主：

- `businessDesign`
- `businessDesignArtifact`
- `confirmedRequirement`
- `generationProfile`
- `skills`
- `blueprintDocs`
- `collaborationSnapshot`

该步骤必须读取 `.claude/skills/prototype-design/SKILL.md`，默认生成静态首页原型，并在缺少原型风格、目标用户、目标平台或保真度时进入 `waiting_user`。

原型产物位于：

```text
.factory-runs/jobs/<job-id>/design_contract/attempt-<n>/prototype/
  index.html
  styles.css
  preview-manifest.json
  prototype-contract.json
```

确认原型后，下游步骤按 `hard_constraint` 使用；直接继续但不确认时，下游只能按 `reference` 使用。
```

- [ ] **Step 2: Run backend verification**

Run:

```powershell
cd factory-server
go test ./internal/runner ./internal/executor ./internal/server -count=1
```

Expected: all three packages pass.

- [ ] **Step 3: Run frontend verification**

Run:

```powershell
cd sf-portal-mvp
npm run check:prototype-handoff
npm run build
```

Expected: check script passes and Vite build completes.

- [ ] **Step 4: Commit documentation**

Commit:

```powershell
git add docs/software-factory-local-runbook.md
git commit -m "docs: document prototype design handoff"
```

---

## Self-Review

Spec coverage:

- Preserves internal `design_contract`: Tasks 3, 4, 5, 6, and 7 keep the existing kind.
- Reads complete business-design handoff: Task 3 injects `businessDesign` and updates prompt priority.
- Reads `prototype-design` skill: Task 3 prompt requires `.claude/skills/prototype-design/SKILL.md`.
- Supports style, target user, target platform, fidelity questions: Task 2 contract and Task 3 prompt preserve structured `questions`; frontend rendering is already through existing question list.
- Generates static prototype artifacts: Task 4 validates and registers `prototype/index.html`, `styles.css`, `preview-manifest.json`, and `prototype-contract.json`.
- Allows preview, feedback, confirm, continue: Task 5 adds APIs and Task 7 wires UI.
- Pushes downstream constraints: Task 6 adds solution/codegen/acceptance prompt context.
- Documents local operation: Task 8 updates the runbook.

Placeholder scan:

- The plan avoids placeholder markers and names every file, command, expected result, and main code shape.

Type consistency:

- Backend contract names use `model.PrototypeSpec`, `model.PrototypeManifest`, and `model.PrototypeContract`.
- Existing artifact kind remains `model.WorkbenchArtifactInterfacePreview` to avoid broad frontend/store migrations.
- Existing focus key remains `interface_parsing`.




