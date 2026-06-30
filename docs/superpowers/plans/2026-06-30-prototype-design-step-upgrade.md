# 原型设计步骤升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 `design_contract` 步骤替换升级为用户可感知的「原型设计」对话步骤：读取需求分析文档，生成静态原型页面，支持风格、目标用户、目标平台反馈，并允许用户确认或不确认继续。

**Architecture:** 保留内部 step kind `design_contract`，避免数据库迁移和历史任务断裂；在后端改变该步骤的提示词、运行权限、产物校验、Artifact 登记和预览 API，在前端将其展示为「原型设计」。原型文件只写入 Claude attempt 目录，通过 Artifact 清单安全暴露预览；确认后成为后续步骤硬约束，未确认则仅作为参考上下文。

**Tech Stack:** Go `factory-server`、现有 Job/Step/Artifact Store、Claude Runner、React/Vite `sf-portal-mvp`、Node 脚本校验、Markdown 文档。

---

## 已确认需求

- 对现有 `designer/design_contract` 做替换升级，不新增平行的 prototype step。
- 用户界面展示名称为「原型设计」，内部短期仍使用 `design_contract`。
- 输入是需求分析生成并确认的文档，不是原始用户 prompt。
- 输出是静态原型页面；允许多页面，但默认只生成并展示首页。
- 只有用户明确要求高保真可交互页面时，才生成高保真交互原型。
- 用户可以用自然语言反馈；如果反馈含糊、影响范围大或要求高保真，需要返回具体选项让用户选择。
- 原型确认不是强制动作；用户可选择「继续但不确认」。
- 已确认原型不可再改，并作为后续方案设计、代码生成、产品验收的硬约束。
- 未确认原型只能作为参考，后续步骤不得声明「用户已确认原型」。

## 文件职责

- `factory-server/internal/runner/claude.go`：增加 attempt 目录写入模式，让原型生成能写文件但不能执行 Bash，也不能写入 repo 工作目录。
- `factory-server/internal/runner/claude_test.go`：锁定 Claude Runner 权限和工作目录行为。
- `factory-server/internal/model/prototype.go`：定义 server 和 executor 共用的原型 Manifest/Contract DTO。
- `factory-server/internal/executor/prototype_contract.go`：读取并校验 Claude 生成的原型输出文件。
- `factory-server/internal/executor/claude_runner.go`：让 `design_contract` 使用原型生成提示词、attempt 写入模式、产物校验、Artifact 登记和下游上下文注入。
- `factory-server/internal/executor/execution_records.go`：支持把 attempt 目录中已生成的文件登记为 Artifact。
- `factory-server/internal/executor/executor.go`：提供确认原型、继续但不确认两个执行器入口。
- `factory-server/internal/server/prototype_handlers.go`：提供原型摘要、预览、反馈、确认、继续但不确认 API。
- `factory-server/internal/server/server.go`：注册原型相关路由。
- `factory-server/internal/collaboration/plan.go`：把内置 designer agent 文案从「设计契约」改成「原型设计」。
- `sf-portal-mvp/src/api/client.js`：增加原型相关前端 API client。
- `sf-portal-mvp/src/hooks/prototypeState.js`：规范化原型摘要状态，供组件使用。
- `sf-portal-mvp/src/hooks/dialogueTimeline.js`：把 `design_contract` 标记为「原型设计」任务块。
- `sf-portal-mvp/src/components/ConversationWorkbench.jsx`：渲染原型预览卡片、反馈入口、确认和继续按钮。
- `sf-portal-mvp/src/components/ConversationWorkbench.css`：补充原型预览卡片样式。
- `sf-portal-mvp/scripts/check-prototype-card.mjs`：用纯 Node 校验状态归一化和任务块标记。
- `sf-portal-mvp/scripts/check-collaboration-plan.mjs`：校验执行图中的「原型设计」标签。
- `docs/software-factory-local-runbook.md`：记录 `design_contract` 兼容键与原型设计流程。

---

### Task 1: 为 Claude Runner 增加 attempt 目录写入模式

**Files:**
- Modify: `factory-server/internal/runner/claude.go`
- Test: `factory-server/internal/runner/claude_test.go`

- [ ] **Step 1: 编写失败测试，锁定权限边界**

在 `factory-server/internal/runner/claude_test.go` 增加：

```go
func TestClaudeArgvAttemptWriteAllowsWriteWithoutBash(t *testing.T) {
	argv := claudeArgvForMode(ClaudeRunAttemptWrite)
	joined := strings.Join(argv, "\n")

	if !strings.Contains(joined, "Write") || !strings.Contains(joined, "Edit") {
		t.Fatalf("attempt write mode must allow Write/Edit: %s", joined)
	}
	if strings.Contains(joined, "Bash") {
		t.Fatalf("attempt write mode must not allow Bash: %s", joined)
	}
	if !strings.Contains(joined, "--disallowedTools") {
		t.Fatalf("expected disallowedTools flag: %#v", argv)
	}
}
```

再增加工作目录测试：

```go
func TestClaudeRunnerAttemptWriteRunsInAttemptDirectory(t *testing.T) {
	ws := runnerWorkspace(t)
	bin := filepath.Join(t.TempDir(), "claude.cmd")
	logPath := filepath.Join(t.TempDir(), "cwd.txt")
	script := "@echo off\r\necho %CD% > \"" + logPath + "\"\r\necho {\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\"}\r\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	r := &ClaudeRunner{Binary: bin}
	if err := r.RunWithMode(context.Background(), ws, "prompt", nil, ClaudeRunAttemptWrite, nil); err != nil {
		t.Fatalf("RunWithMode returned error: %v", err)
	}

	gotBytes, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read cwd log: %v", err)
	}
	if got := strings.TrimSpace(string(gotBytes)); got != ws.AttemptDir {
		t.Fatalf("cwd = %q, want %q", got, ws.AttemptDir)
	}
}

func runnerWorkspace(t *testing.T) Workspace {
	t.Helper()
	root := t.TempDir()
	attemptDir := filepath.Join(root, "attempt")
	workDir := filepath.Join(root, "work")
	if err := os.MkdirAll(attemptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return Workspace{Root: root, AttemptDir: attemptDir, WorkDir: workDir}
}
```

需要的 import：

```go
import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)
```

- [ ] **Step 2: 运行测试，确认红灯**

```powershell
go test ./factory-server/internal/runner -run "TestClaudeArgvAttemptWriteAllowsWriteWithoutBash|TestClaudeRunnerAttemptWriteRunsInAttemptDirectory" -count=1
```

预期：编译失败，提示 `claudeArgvForMode`、`ClaudeRunAttemptWrite` 或 `RunWithMode` 未定义。

- [ ] **Step 3: 实现 Claude 运行模式**

在 `factory-server/internal/runner/claude.go` 添加：

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
	argv := []string{"--print", "--verbose", "--output-format", "stream-json"}
	switch mode {
	case ClaudeRunWorkspaceWrite:
		return append(argv, "--allowedTools", "Read,Grep,Glob,Edit,MultiEdit,Write,Bash")
	case ClaudeRunAttemptWrite:
		return append(argv, "--allowedTools", "Read,Grep,Glob,Edit,MultiEdit,Write", "--disallowedTools", "Bash")
	default:
		return append(argv, "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Edit,MultiEdit,Write,Bash")
	}
}
```

- [ ] **Step 4: 增加 `RunWithMode`，保持旧 `Run` 兼容**

在同一文件中将旧 `Run` 改成委托：

```go
func (r *ClaudeRunner) Run(ctx context.Context, ws Workspace, prompt string, inputData any, codegen bool, emit EventEmitter) error {
	mode := ClaudeRunReadOnly
	if codegen {
		mode = ClaudeRunWorkspaceWrite
	}
	return r.RunWithMode(ctx, ws, prompt, inputData, mode, emit)
}

func (r *ClaudeRunner) RunWithMode(ctx context.Context, ws Workspace, prompt string, inputData any, mode ClaudeRunMode, emit EventEmitter) error {
	if emit == nil {
		emit = func(Event) {}
	}
	if err := os.MkdirAll(ws.AttemptDir, 0o755); err != nil {
		return fmt.Errorf("create attempt dir: %w", err)
	}
	if err := os.WriteFile(filepath.Join(ws.AttemptDir, "prompt.md"), []byte(prompt), 0o644); err != nil {
		return fmt.Errorf("write prompt: %w", err)
	}
	if inputData != nil {
		b, err := json.MarshalIndent(inputData, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal input: %w", err)
		}
		if err := os.WriteFile(filepath.Join(ws.AttemptDir, "input.json"), b, 0o644); err != nil {
			return fmt.Errorf("write input: %w", err)
		}
	}

	cmd := exec.CommandContext(ctx, r.binary(), claudeArgvForMode(mode)...)
	cmd.Dir = runDirForMode(ws, mode)
	cmd.Env = os.Environ()
	cmd.Stdin = strings.NewReader(prompt)
	emit(Event{Stage: stageNameForMode(mode), Message: "claude runner started"})
	return r.runStream(ctx, cmd, ws.AttemptDir, emit)
}

func runDirForMode(ws Workspace, mode ClaudeRunMode) string {
	switch mode {
	case ClaudeRunWorkspaceWrite:
		if ws.WorkDir != "" {
			return ws.WorkDir
		}
		return ws.Root
	case ClaudeRunAttemptWrite:
		return ws.AttemptDir
	default:
		return ws.Root
	}
}

func stageNameForMode(mode ClaudeRunMode) string {
	switch mode {
	case ClaudeRunWorkspaceWrite:
		return "claude_codegen"
	case ClaudeRunAttemptWrite:
		return "claude_attempt_write"
	default:
		return "claude_readonly"
	}
}
```

如果旧 `Run` 中直接内联了 stdout/stderr stream 解析逻辑，将该逻辑原样抽成：

```go
func (r *ClaudeRunner) runStream(ctx context.Context, cmd *exec.Cmd, attemptDir string, emit EventEmitter) error {
	// 将现有 stream-json 扫描、result 捕获、错误处理逻辑搬到这里，行为不变。
}
```

- [ ] **Step 5: 验证并提交**

```powershell
gofmt -w factory-server/internal/runner/claude.go factory-server/internal/runner/claude_test.go
go test ./factory-server/internal/runner -count=1
git add factory-server/internal/runner/claude.go factory-server/internal/runner/claude_test.go
git commit -m "feat: add attempt write mode for claude runner"
```

预期：测试通过，提交只包含 Runner 相关文件。
---

### Task 2: 让 `design_contract` 生成并登记原型产物

**Files:**
- Create: `factory-server/internal/model/prototype.go`
- Create: `factory-server/internal/executor/prototype_contract.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/executor/execution_records.go`
- Test: `factory-server/internal/executor/claude_runner_test.go`

- [ ] **Step 1: 编写失败测试，定义原型输出契约**

在 `factory-server/internal/executor/claude_runner_test.go` 增加：

```go
func TestValidatePrototypeOutputAcceptsStaticHomepage(t *testing.T) {
	attemptDir := t.TempDir()
	prototypeDir := filepath.Join(attemptDir, "prototype")
	if err := os.MkdirAll(prototypeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(prototypeDir, "index.html"), "<main>Home</main>")
	mustWriteFile(t, filepath.Join(prototypeDir, "styles.css"), "body{font-family:sans-serif}")
	mustWriteFile(t, filepath.Join(prototypeDir, "mock-data.js"), "window.__MOCK_DATA__={}")
	mustWriteJSON(t, filepath.Join(prototypeDir, "preview-manifest.json"), model.PrototypeManifest{
		DefaultPage: "index.html",
		Fidelity:    "static",
		Pages:       []model.PrototypePage{{ID: "home", Title: "首页", Path: "index.html"}},
	})
	mustWriteJSON(t, filepath.Join(prototypeDir, "prototype-contract.json"), model.PrototypeContract{
		Style:       "专业简洁",
		Audience:    "UED",
		Platform:    "responsive",
		Fidelity:    "static",
		Confirmed:   false,
		Constraints: []string{"默认首页静态展示"},
	})
	mustWriteJSON(t, filepath.Join(attemptDir, "output.json"), prototypeDesignOutput{
		Summary:      "生成首页静态原型",
		PrototypeDir: "prototype",
		Manifest:     "prototype/preview-manifest.json",
		Contract:     "prototype/prototype-contract.json",
	})

	got, err := validatePrototypeDesignOutput(filepath.Join(attemptDir, "output.json"), attemptDir)
	if err != nil {
		t.Fatalf("validatePrototypeDesignOutput returned error: %v", err)
	}
	if got.Manifest.DefaultPage != "index.html" {
		t.Fatalf("default page = %q", got.Manifest.DefaultPage)
	}
	if got.Contract.Fidelity != "static" {
		t.Fatalf("fidelity = %q", got.Contract.Fidelity)
	}
}

func TestValidatePrototypeOutputRejectsTraversal(t *testing.T) {
	attemptDir := t.TempDir()
	mustWriteJSON(t, filepath.Join(attemptDir, "output.json"), prototypeDesignOutput{
		Summary:      "bad",
		PrototypeDir: "../outside",
		Manifest:     "prototype/preview-manifest.json",
		Contract:     "prototype/prototype-contract.json",
	})
	_, err := validatePrototypeDesignOutput(filepath.Join(attemptDir, "output.json"), attemptDir)
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("error = %v, want escape rejection", err)
	}
}
```

测试 helper：

```go
func mustWriteFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustWriteJSON(t *testing.T, path string, value any) {
	t.Helper()
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, path, string(b))
}
```

需要的 import：

```go
import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"factory-server/internal/model"
)
```

- [ ] **Step 2: 运行测试，确认红灯**

```powershell
go test ./factory-server/internal/executor -run "TestValidatePrototypeOutput" -count=1
```

预期：编译失败，提示 `model.PrototypeManifest`、`model.PrototypeContract`、`validatePrototypeDesignOutput` 或 `prototypeDesignOutput` 未定义。

- [ ] **Step 3: 创建共享原型 DTO**

创建 `factory-server/internal/model/prototype.go`：

```go
package model

type PrototypeManifest struct {
	DefaultPage string          `json:"default_page"`
	Fidelity    string          `json:"fidelity"`
	Pages       []PrototypePage `json:"pages"`
}

type PrototypePage struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Path  string `json:"path"`
}

type PrototypeContract struct {
	Style       string   `json:"style"`
	Audience    string   `json:"audience"`
	Platform    string   `json:"platform"`
	Fidelity    string   `json:"fidelity"`
	Confirmed   bool     `json:"confirmed"`
	Constraints []string `json:"constraints"`
}
```

- [ ] **Step 4: 创建原型输出校验器**

创建 `factory-server/internal/executor/prototype_contract.go`：

```go
package executor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"factory-server/internal/model"
)

type prototypeDesignOutput struct {
	Summary      string `json:"summary"`
	PrototypeDir string `json:"prototype_dir"`
	Manifest     string `json:"manifest"`
	Contract     string `json:"contract"`
}

type validatedPrototypeOutput struct {
	Output       prototypeDesignOutput
	Manifest     model.PrototypeManifest
	Contract     model.PrototypeContract
	PrototypeDir string
	ManifestPath string
	ContractPath string
	DefaultPath  string
}

func validatePrototypeDesignOutput(outputPath string, attemptDir string) (validatedPrototypeOutput, error) {
	var out prototypeDesignOutput
	if err := readJSONFile(outputPath, &out); err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("read prototype output %s: %w", outputPath, err)
	}
	prototypeDir, err := safeAttemptPath(attemptDir, out.PrototypeDir)
	if err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("prototype_dir: %w", err)
	}
	manifestPath, err := safeAttemptPath(attemptDir, out.Manifest)
	if err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("manifest: %w", err)
	}
	contractPath, err := safeAttemptPath(attemptDir, out.Contract)
	if err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("contract: %w", err)
	}
	var manifest model.PrototypeManifest
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("read prototype manifest: %w", err)
	}
	var contract model.PrototypeContract
	if err := readJSONFile(contractPath, &contract); err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("read prototype contract: %w", err)
	}
	if strings.TrimSpace(manifest.DefaultPage) == "" || len(manifest.Pages) == 0 {
		return validatedPrototypeOutput{}, fmt.Errorf("prototype manifest missing default page or pages")
	}
	defaultPath, err := safeAttemptPath(prototypeDir, manifest.DefaultPage)
	if err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("default page: %w", err)
	}
	if _, err := os.Stat(defaultPath); err != nil {
		return validatedPrototypeOutput{}, fmt.Errorf("default page %s: %w", manifest.DefaultPage, err)
	}
	return validatedPrototypeOutput{Output: out, Manifest: manifest, Contract: contract, PrototypeDir: prototypeDir, ManifestPath: manifestPath, ContractPath: contractPath, DefaultPath: defaultPath}, nil
}

func safeAttemptPath(root string, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("absolute paths are not allowed: %s", rel)
	}
	clean := filepath.Clean(rel)
	if clean == "." || strings.HasPrefix(clean, "..") {
		return "", fmt.Errorf("path escapes attempt directory: %s", rel)
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	joined, err := filepath.Abs(filepath.Join(rootAbs, clean))
	if err != nil {
		return "", err
	}
	if joined != rootAbs && !strings.HasPrefix(joined, rootAbs+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes attempt directory: %s", rel)
	}
	return joined, nil
}

func readJSONFile(path string, target any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, target)
}
```

- [ ] **Step 5: 支持登记已生成文件为 Artifact**

在 `factory-server/internal/executor/execution_records.go` 的 `artifactRegistrar` 上增加：

```go
func (r *artifactRegistrar) registerExistingFile(ctx context.Context, kind string, sourcePath string, title string, metadata map[string]any) (*model.Artifact, error) {
	if r == nil || r.store == nil {
		return nil, nil
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		return nil, fmt.Errorf("stat artifact source: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("artifact source is a directory: %s", sourcePath)
	}
	return r.store.CreateArtifact(ctx, model.Artifact{
		JobID:     r.job.ID,
		StepID:    r.step.ID,
		Attempt:   r.step.Attempt,
		Kind:      kind,
		Title:     title,
		Path:      sourcePath,
		Bytes:     info.Size(),
		Metadata:  metadata,
		CreatedAt: time.Now().UTC(),
	})
}
```

- [ ] **Step 6: 让 `design_contract` 使用 attempt 写入模式并登记原型产物**

在 `factory-server/internal/executor/claude_runner.go` 中选择运行模式：

```go
mode := runner.ClaudeRunReadOnly
switch step.Kind {
case model.StepCodeGeneration:
	mode = runner.ClaudeRunWorkspaceWrite
case model.StepDesignContract:
	mode = runner.ClaudeRunAttemptWrite
}
if err := c.Claude.RunWithMode(ctx, ws, prompt, input, mode, emit); err != nil {
	return StepResult{}, err
}
```

在读取 `output.json` 后，为 `StepDesignContract` 增加专用分支：

```go
if step.Kind == model.StepDesignContract {
	validated, err := validatePrototypeDesignOutput(filepath.Join(ws.AttemptDir, "output.json"), ws.AttemptDir)
	if err != nil {
		return StepResult{}, err
	}
	artifacts, err := c.registerPrototypeArtifacts(ctx, registrar, validated)
	if err != nil {
		return StepResult{}, err
	}
	return StepResult{
		Status:         model.StepStatusWaitingUser,
		Summary:        validated.Output.Summary,
		Artifacts:      artifacts,
		NeedsUserInput: true,
		Questions:      prototypeDecisionQuestions(),
	}, nil
}
```

增加 helper：

```go
func (c *ClaudeStepRunner) registerPrototypeArtifacts(ctx context.Context, registrar *artifactRegistrar, validated validatedPrototypeOutput) ([]model.Artifact, error) {
	metadata := map[string]any{"default_page": validated.Manifest.DefaultPage, "fidelity": validated.Manifest.Fidelity, "confirmed": validated.Contract.Confirmed}
	created := make([]model.Artifact, 0, 3)
	for _, item := range []struct{ kind, path, title string }{
		{"prototype_manifest", validated.ManifestPath, "原型预览清单"},
		{"prototype_contract", validated.ContractPath, "原型设计契约"},
		{"prototype_page", validated.DefaultPath, "原型首页"},
	} {
		artifact, err := registrar.registerExistingFile(ctx, item.kind, item.path, item.title, metadata)
		if err != nil {
			return nil, err
		}
		if artifact != nil {
			created = append(created, *artifact)
		}
	}
	return created, nil
}

func prototypeDecisionQuestions() []runner.Question {
	return []runner.Question{{
		ID:       "prototype_decision",
		Title:    "确认原型设计",
		Prompt:   "请预览原型。可以确认原型、继续但不确认，或用自然语言反馈需要调整的风格、目标用户、目标平台或保真度。",
		Required: false,
		Options: []runner.QuestionOption{
			{Value: "confirm", Label: "确认原型，作为后续硬约束"},
			{Value: "continue_without_confirmation", Label: "继续执行，但仅作为参考"},
		},
	}}
}
```

- [ ] **Step 7: 替换 `design_contract` 提示词为原型设计提示词**

在 `collaborationProducerPrompt` 或相邻 prompt builder 中，对 `model.StepDesignContract` 返回：

```go
func prototypeDesignPrompt() string {
	return `你是软件工厂的原型设计代理。你必须读取需求分析步骤生成并已确认的文档，生成可预览的静态原型页面。

默认行为：
- 默认只生成首页静态页面，可以在 manifest 中列出多页面，但不要默认实现所有页面。
- 仅当用户明确要求高保真交互时，才生成高保真可交互页面。
- 原型需要体现用户选择或默认推断的风格、目标用户和目标平台。
- 目标用户可包含 UED、开发、产品、业务评审等。
- 目标平台可包含 responsive、web、mobile。

必须在 attempt 目录下创建：
- prototype/index.html
- prototype/styles.css
- prototype/mock-data.js
- prototype/preview-manifest.json
- prototype/prototype-contract.json
- output.json

output.json schema：
{
  "summary": "一句话说明生成的原型",
  "prototype_dir": "prototype",
  "manifest": "prototype/preview-manifest.json",
  "contract": "prototype/prototype-contract.json"
}`
}
```

- [ ] **Step 8: 验证并提交**

```powershell
gofmt -w factory-server/internal/model/prototype.go factory-server/internal/executor/prototype_contract.go factory-server/internal/executor/claude_runner.go factory-server/internal/executor/execution_records.go factory-server/internal/executor/claude_runner_test.go
go test ./factory-server/internal/executor -count=1
git add factory-server/internal/model/prototype.go factory-server/internal/executor/prototype_contract.go factory-server/internal/executor/claude_runner.go factory-server/internal/executor/execution_records.go factory-server/internal/executor/claude_runner_test.go
git commit -m "feat: generate prototype artifacts from design step"
```

预期：executor 包测试通过，提交只包含原型产物生成相关文件。

---

### Task 3: 增加原型预览、反馈、确认和继续 API

**Files:**
- Create: `factory-server/internal/server/prototype_handlers.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/executor/executor.go`
- Test: `factory-server/internal/server/prototype_handlers_test.go`
- Test: `factory-server/internal/executor/executor_test.go`

- [ ] **Step 1: 编写失败测试，锁定预览安全和确认后不可改**

创建 `factory-server/internal/server/prototype_handlers_test.go`：

```go
package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPrototypePreviewRejectsTraversal(t *testing.T) {
	srv := newTestServerWithPrototype(t, false)
	req := httptest.NewRequest(http.MethodGet, "/api/jobs/job-1/steps/design/prototype/preview?path=../secret.txt", nil)
	rec := httptest.NewRecorder()

	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestPrototypeFeedbackRejectsConfirmedPrototype(t *testing.T) {
	srv := newTestServerWithPrototype(t, true)
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/job-1/steps/design/prototype/feedback", strings.NewReader(`{"feedback":"改成移动端"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}
```

测试 helper 需要在内存 store 中创建一个 job、一个 `design_contract` step、一个 `prototype_manifest` Artifact、一个 `prototype_contract` Artifact。`confirmed=true` 时，contract JSON 中 `confirmed` 字段为 `true`。

- [ ] **Step 2: 运行测试，确认红灯**

```powershell
go test ./factory-server/internal/server -run "TestPrototype" -count=1
```

预期：路由、handler 或 helper 未实现导致失败。

- [ ] **Step 3: 在 Executor 中增加原型决策入口**

在 `factory-server/internal/executor/executor.go` 增加：

```go
func (e *Executor) ConfirmPrototypeStep(ctx context.Context, jobID string, stepID string, attempt int) error {
	return e.releasePrototypeStep(ctx, jobID, stepID, attempt, "confirmed")
}

func (e *Executor) ContinuePrototypeStep(ctx context.Context, jobID string, stepID string, attempt int) error {
	return e.releasePrototypeStep(ctx, jobID, stepID, attempt, "reference")
}

func (e *Executor) releasePrototypeStep(ctx context.Context, jobID string, stepID string, attempt int, decision string) error {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil {
		return err
	}
	step, ok := job.StepByID(stepID)
	if !ok {
		return fmt.Errorf("step %s not found", stepID)
	}
	if step.Kind != model.StepDesignContract {
		return fmt.Errorf("step %s is not prototype design", stepID)
	}
	if step.Attempt != attempt {
		return fmt.Errorf("attempt mismatch: got %d want %d", attempt, step.Attempt)
	}
	if step.Status != model.StepStatusWaitingUser {
		return fmt.Errorf("prototype step is not waiting for user")
	}
	if err := e.store.UpdateStepSnapshot(ctx, jobID, stepID, map[string]any{"prototype_decision": decision}); err != nil {
		return err
	}
	if err := e.store.MarkStepCompleted(ctx, jobID, stepID, "prototype "+decision); err != nil {
		return err
	}
	if err := e.store.AdvanceJobAfterStep(ctx, jobID, stepID); err != nil {
		return err
	}
	return e.QueueJob(ctx, jobID)
}
```

如果 store 真实方法名不同，使用 `ConfirmManualStep` 当前已经调用的完成、推进、排队方法；行为必须保持相同。

- [ ] **Step 4: 实现 Server handler**

创建 `factory-server/internal/server/prototype_handlers.go`：

```go
package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"factory-server/internal/model"
)

var errBadPrototypePath = errors.New("bad prototype path")

type prototypeFeedbackRequest struct {
	Feedback string `json:"feedback"`
	Choice   string `json:"choice"`
}

type prototypeDecisionRequest struct {
	Attempt int `json:"attempt"`
}

type prototypeBundle struct {
	JobID        string                  `json:"job_id"`
	StepID       string                  `json:"step_id"`
	Attempt      int                     `json:"attempt"`
	PreviewURL   string                  `json:"preview_url"`
	PrototypeDir string                  `json:"-"`
	Manifest     model.PrototypeManifest `json:"manifest"`
	Contract     model.PrototypeContract `json:"contract"`
}

func (s *Server) prototypeSummary(w http.ResponseWriter, r *http.Request) {
	bundle, err := s.loadPrototypeBundle(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "stepID"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bundle)
}

func (s *Server) prototypePreview(w http.ResponseWriter, r *http.Request) {
	bundle, err := s.loadPrototypeBundle(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "stepID"))
	if err != nil {
		writeError(w, err)
		return
	}
	pagePath := r.URL.Query().Get("path")
	if pagePath == "" {
		pagePath = bundle.Manifest.DefaultPage
	}
	filePath, err := safePrototypeFile(bundle.PrototypeDir, pagePath)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	http.ServeFile(w, r, filePath)
}

func (s *Server) prototypeFeedback(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "id")
	stepID := chi.URLParam(r, "stepID")
	bundle, err := s.loadPrototypeBundle(r.Context(), jobID, stepID)
	if err != nil {
		writeError(w, err)
		return
	}
	if bundle.Contract.Confirmed {
		writeJSONError(w, http.StatusConflict, "prototype is already confirmed")
		return
	}
	var req prototypeFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	feedback := strings.TrimSpace(req.Feedback)
	if feedback == "" && strings.TrimSpace(req.Choice) == "" {
		writeJSONError(w, http.StatusBadRequest, "feedback or choice is required")
		return
	}
	if requiresConcretePrototypeChoice(feedback) && strings.TrimSpace(req.Choice) == "" {
		writeJSON(w, http.StatusAccepted, map[string]any{"needs_choice": true, "choices": prototypeFeedbackChoices()})
		return
	}
	if err := s.executor.AnswerJob(r.Context(), jobID, stepID, bundle.Attempt, feedback); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"queued": true})
}

func (s *Server) prototypeConfirm(w http.ResponseWriter, r *http.Request) {
	var req prototypeDecisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := s.executor.ConfirmPrototypeStep(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "stepID"), req.Attempt); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "confirmed"})
}

func (s *Server) prototypeContinueWithoutConfirmation(w http.ResponseWriter, r *http.Request) {
	var req prototypeDecisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := s.executor.ContinuePrototypeStep(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "stepID"), req.Attempt); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "reference"})
}
```

- [ ] **Step 5: 增加 bundle 加载和路径安全 helper**

继续在 `prototype_handlers.go` 增加：

```go
func (s *Server) loadPrototypeBundle(ctx context.Context, jobID string, stepID string) (prototypeBundle, error) {
	job, err := s.store.GetJob(ctx, jobID)
	if err != nil {
		return prototypeBundle{}, err
	}
	step, ok := job.StepByID(stepID)
	if !ok {
		return prototypeBundle{}, errNotFound("step")
	}
	if step.Kind != model.StepDesignContract {
		return prototypeBundle{}, errBadRequest("step is not prototype design")
	}
	artifacts, err := s.store.ListArtifactsByJob(ctx, jobID)
	if err != nil {
		return prototypeBundle{}, err
	}
	manifestArtifact, contractArtifact := latestPrototypeArtifacts(artifacts, stepID, step.Attempt)
	if manifestArtifact == nil || contractArtifact == nil {
		return prototypeBundle{}, errNotFound("prototype artifacts")
	}
	var manifest model.PrototypeManifest
	if err := readPrototypeJSONFile(manifestArtifact.Path, &manifest); err != nil {
		return prototypeBundle{}, err
	}
	var contract model.PrototypeContract
	if err := readPrototypeJSONFile(contractArtifact.Path, &contract); err != nil {
		return prototypeBundle{}, err
	}
	return prototypeBundle{JobID: jobID, StepID: stepID, Attempt: step.Attempt, PreviewURL: "/api/jobs/" + jobID + "/steps/" + stepID + "/prototype/preview", PrototypeDir: filepath.Dir(manifestArtifact.Path), Manifest: manifest, Contract: contract}, nil
}

func safePrototypeFile(root string, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", errBadPrototypePath
	}
	clean := filepath.Clean(rel)
	if clean == "." || strings.HasPrefix(clean, "..") {
		return "", errBadPrototypePath
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	joined, err := filepath.Abs(filepath.Join(rootAbs, clean))
	if err != nil {
		return "", err
	}
	if joined != rootAbs && !strings.HasPrefix(joined, rootAbs+string(filepath.Separator)) {
		return "", errBadPrototypePath
	}
	return joined, nil
}

func readPrototypeJSONFile(path string, target any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, target)
}

func requiresConcretePrototypeChoice(feedback string) bool {
	text := strings.ToLower(strings.TrimSpace(feedback))
	return strings.Contains(text, "高保真") || strings.Contains(text, "交互") || strings.Contains(text, "随便") || strings.Contains(text, "都行")
}

func prototypeFeedbackChoices() []map[string]string {
	return []map[string]string{
		{"value": "style", "label": "调整视觉风格"},
		{"value": "audience", "label": "调整目标用户"},
		{"value": "platform", "label": "调整目标平台"},
		{"value": "fidelity", "label": "升级保真度"},
	}
}
```

`latestPrototypeArtifacts` 选择同一 step、同一 attempt 下最新的 `prototype_manifest` 与 `prototype_contract`；如果 store 已经按创建时间排序，取最后一个，否则按 `CreatedAt` 比较。

- [ ] **Step 6: 注册路由**

在 `factory-server/internal/server/server.go` 的 job step 路由附近增加：

```go
r.Get("/api/jobs/{id}/steps/{stepID}/prototype", s.prototypeSummary)
r.Get("/api/jobs/{id}/steps/{stepID}/prototype/preview", s.prototypePreview)
r.Post("/api/jobs/{id}/steps/{stepID}/prototype/feedback", s.prototypeFeedback)
r.Post("/api/jobs/{id}/steps/{stepID}/prototype/confirm", s.prototypeConfirm)
r.Post("/api/jobs/{id}/steps/{stepID}/prototype/continue-without-confirmation", s.prototypeContinueWithoutConfirmation)
```

如果现有 router 使用 `:id` 风格，按现有风格改写为一致的路由语法。

- [ ] **Step 7: 验证并提交**

```powershell
gofmt -w factory-server/internal/server/prototype_handlers.go factory-server/internal/server/server.go factory-server/internal/executor/executor.go factory-server/internal/server/prototype_handlers_test.go factory-server/internal/executor/executor_test.go
go test ./factory-server/internal/server ./factory-server/internal/executor -count=1
git add factory-server/internal/server/prototype_handlers.go factory-server/internal/server/server.go factory-server/internal/executor/executor.go factory-server/internal/server/prototype_handlers_test.go factory-server/internal/executor/executor_test.go
git commit -m "feat: add prototype preview and decision APIs"
```

预期：server 和 executor 包测试通过。
---

### Task 4: 在对话工作台渲染原型预览卡片

**Files:**
- Modify: `sf-portal-mvp/src/api/client.js`
- Create: `sf-portal-mvp/src/hooks/prototypeState.js`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Create: `sf-portal-mvp/scripts/check-prototype-card.mjs`

- [ ] **Step 1: 编写失败的前端纯函数校验脚本**

创建 `sf-portal-mvp/scripts/check-prototype-card.mjs`：

```js
import assert from 'node:assert/strict';
import { normalizePrototypeSummary } from '../src/hooks/prototypeState.js';
import { buildTaskBlocks, STEP_STAGE_LABEL } from '../src/hooks/dialogueTimeline.js';

const summary = normalizePrototypeSummary({
  job_id: 'job-1',
  step_id: 'design',
  attempt: 2,
  preview_url: '/api/jobs/job-1/steps/design/prototype/preview',
  manifest: { default_page: 'index.html', fidelity: 'static', pages: [{ id: 'home', title: '首页', path: 'index.html' }] },
  contract: { style: '专业简洁', audience: 'UED', platform: 'responsive', fidelity: 'static', confirmed: false, constraints: ['默认首页静态展示'] },
});

assert.equal(summary.defaultPage.path, 'index.html');
assert.equal(summary.previewUrl, '/api/jobs/job-1/steps/design/prototype/preview');
assert.equal(summary.decision, 'pending');
assert.equal(summary.contract.audience, 'UED');
assert.equal(STEP_STAGE_LABEL.design_contract, '原型设计');

const blocks = buildTaskBlocks({
  job: { id: 'job-1', steps: [{ id: 'design', kind: 'design_contract', title: '设计', status: 'waiting_user', attempt: 2 }] },
  traces: [],
  thinking: [],
});

assert.equal(blocks[0].stageLabel, '原型设计');
assert.equal(blocks[0].isPrototypeDesign, true);
console.log('prototype card checks passed');
```

- [ ] **Step 2: 运行脚本，确认红灯**

```powershell
node sf-portal-mvp/scripts/check-prototype-card.mjs
```

预期：失败，原因是 `prototypeState.js` 不存在，或 `design_contract` 仍未映射为「原型设计」。

- [ ] **Step 3: 增加前端 API client**

在 `sf-portal-mvp/src/api/client.js` 增加：

```js
export async function getPrototypeSummary(jobId, stepId) {
  return request(`/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/prototype`);
}

export function prototypePreviewUrl(jobId, stepId, path = '') {
  const base = `/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/prototype/preview`;
  return path ? `${base}?path=${encodeURIComponent(path)}` : base;
}

export async function confirmPrototype(jobId, stepId, attempt) {
  return request(`/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/prototype/confirm`, {
    method: 'POST',
    body: JSON.stringify({ attempt }),
  });
}

export async function continuePrototypeWithoutConfirmation(jobId, stepId, attempt) {
  return request(`/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/prototype/continue-without-confirmation`, {
    method: 'POST',
    body: JSON.stringify({ attempt }),
  });
}

export async function feedbackPrototype(jobId, stepId, payload) {
  return request(`/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/prototype/feedback`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

沿用文件中已有 `request` 的 headers、base URL 和错误处理规则。

- [ ] **Step 4: 增加原型状态归一化 hook**

创建 `sf-portal-mvp/src/hooks/prototypeState.js`：

```js
export function normalizePrototypeSummary(raw) {
  const manifest = raw?.manifest ?? {};
  const contract = raw?.contract ?? {};
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  const defaultPath = manifest.default_page || pages[0]?.path || 'index.html';
  const defaultPage = pages.find((page) => page.path === defaultPath) ?? pages[0] ?? { id: 'home', title: '首页', path: defaultPath };
  const confirmed = Boolean(contract.confirmed);
  return {
    jobId: raw?.job_id ?? '',
    stepId: raw?.step_id ?? '',
    attempt: Number(raw?.attempt ?? 0),
    previewUrl: raw?.preview_url ?? '',
    pages,
    defaultPage,
    contract: {
      style: contract.style || '未指定',
      audience: contract.audience || '混合',
      platform: contract.platform || 'responsive',
      fidelity: contract.fidelity || manifest.fidelity || 'static',
      confirmed,
      constraints: Array.isArray(contract.constraints) ? contract.constraints : [],
    },
    decision: confirmed ? 'confirmed' : 'pending',
  };
}

export function prototypeDecisionText(decision) {
  if (decision === 'confirmed') return '已确认，作为后续硬约束';
  if (decision === 'reference') return '未确认，后续仅作为参考';
  return '待处理';
}
```

- [ ] **Step 5: 更新任务块标签和元数据**

在 `sf-portal-mvp/src/hooks/dialogueTimeline.js` 中保证 label map 包含：

```js
export const STEP_STAGE_LABEL = {
  requirement_analysis: '需求分析',
  design_contract: '原型设计',
  domain_analysis: '领域分析',
  data_integration: '数据接入',
  solution_design: '方案设计',
  code_generation: '代码生成',
  code_review: '代码评审',
  product_acceptance: '产品验收',
};
```

在 `buildTaskBlocks` 构造每个 block 时增加：

```js
const isPrototypeDesign = step.kind === 'design_contract';
return {
  ...block,
  stageLabel: STEP_STAGE_LABEL[step.kind] ?? step.title ?? step.kind,
  isPrototypeDesign,
  prototypeDecision: isPrototypeDesign ? step.snapshot?.prototype_decision ?? 'pending' : null,
};
```

保持原本 timeline、trace、thinking 字段不变。

- [ ] **Step 6: 增加 `PrototypePreviewCard` 组件**

在 `sf-portal-mvp/src/components/ConversationWorkbench.jsx` 引入：

```js
import { confirmPrototype, continuePrototypeWithoutConfirmation, feedbackPrototype, getPrototypeSummary, prototypePreviewUrl } from '../api/client.js';
import { normalizePrototypeSummary, prototypeDecisionText } from '../hooks/prototypeState.js';
```

添加组件：

```jsx
function PrototypePreviewCard({ jobId, block, onChanged }) {
  const [summary, setSummary] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [choice, setChoice] = useState('');
  const [choicePrompt, setChoicePrompt] = useState(null);
  const [busy, setBusy] = useState(false);
  const stepId = block.step?.id ?? block.id;

  useEffect(() => {
    let cancelled = false;
    getPrototypeSummary(jobId, stepId).then((raw) => {
      if (!cancelled) setSummary(normalizePrototypeSummary(raw));
    }).catch(() => {
      if (!cancelled) setSummary(null);
    });
    return () => { cancelled = true; };
  }, [jobId, stepId, block.step?.attempt]);

  if (!summary) return null;
  const previewSrc = prototypePreviewUrl(jobId, stepId, summary.defaultPage.path);
  const confirmed = summary.decision === 'confirmed';

  async function submitFeedback() {
    setBusy(true);
    try {
      const result = await feedbackPrototype(jobId, stepId, { feedback, choice });
      if (result?.needs_choice) {
        setChoicePrompt(result.choices ?? []);
      } else {
        setFeedback('');
        setChoice('');
        setChoicePrompt(null);
        await onChanged?.();
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    try {
      await confirmPrototype(jobId, stepId, summary.attempt);
      await onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function continueWithoutConfirmation() {
    setBusy(true);
    try {
      await continuePrototypeWithoutConfirmation(jobId, stepId, summary.attempt);
      await onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cw-prototype-card" aria-label="原型设计预览">
      <div className="cw-prototype-toolbar">
        <div><strong>原型预览</strong><span>{prototypeDecisionText(summary.decision)}</span></div>
        <a href={previewSrc} target="_blank" rel="noreferrer">新窗口打开</a>
      </div>
      <iframe className="cw-prototype-frame" src={previewSrc} title="原型设计预览" />
      <div className="cw-prototype-meta">
        <span>风格：{summary.contract.style}</span>
        <span>用户：{summary.contract.audience}</span>
        <span>平台：{summary.contract.platform}</span>
        <span>保真度：{summary.contract.fidelity}</span>
      </div>
      {!confirmed && (
        <div className="cw-prototype-actions">
          {choicePrompt && <div className="cw-prototype-choices">{choicePrompt.map((item) => <button key={item.value} type="button" className={choice === item.value ? 'active' : ''} onClick={() => setChoice(item.value)}>{item.label}</button>)}</div>}
          <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="反馈风格、目标用户、目标平台或保真度" />
          <div className="cw-prototype-buttons">
            <button type="button" onClick={submitFeedback} disabled={busy || (!feedback.trim() && !choice)}>提交反馈</button>
            <button type="button" onClick={continueWithoutConfirmation} disabled={busy}>继续但不确认</button>
            <button type="button" className="primary" onClick={confirm} disabled={busy}>确认原型</button>
          </div>
        </div>
      )}
    </section>
  );
}
```

在 task block 渲染处加入：

```jsx
{block.isPrototypeDesign && job?.id && (
  <PrototypePreviewCard jobId={job.id} block={block} onChanged={reloadJob} />
)}
```

`reloadJob` 使用文件中已有的刷新函数真实名称。

- [ ] **Step 7: 增加样式**

在 `sf-portal-mvp/src/components/ConversationWorkbench.css` 追加：

```css
.cw-prototype-card {
  border: 1px solid var(--border-muted, #d9dee7);
  border-radius: 8px;
  background: var(--surface, #fff);
  padding: 12px;
  display: grid;
  gap: 10px;
}

.cw-prototype-toolbar,
.cw-prototype-meta,
.cw-prototype-buttons,
.cw-prototype-choices {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cw-prototype-toolbar { justify-content: space-between; }
.cw-prototype-toolbar span,
.cw-prototype-meta span { color: var(--text-muted, #5f6b7a); font-size: 12px; }
.cw-prototype-frame { width: 100%; min-height: 420px; border: 1px solid var(--border-muted, #d9dee7); border-radius: 6px; background: #fff; }
.cw-prototype-actions { display: grid; gap: 8px; }
.cw-prototype-actions textarea { min-height: 76px; resize: vertical; }
.cw-prototype-buttons .primary { background: var(--accent, #2454d6); color: #fff; }
.cw-prototype-choices button.active { border-color: var(--accent, #2454d6); color: var(--accent, #2454d6); }
```

- [ ] **Step 8: 验证并提交**

```powershell
node sf-portal-mvp/scripts/check-prototype-card.mjs
node sf-portal-mvp/scripts/check-dialogue-workbench.mjs
git add sf-portal-mvp/src/api/client.js sf-portal-mvp/src/hooks/prototypeState.js sf-portal-mvp/src/hooks/dialogueTimeline.js sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/scripts/check-prototype-card.mjs
git commit -m "feat: render prototype preview card"
```

预期：`prototype card checks passed`，现有 dialogue workbench 脚本继续通过。

---

### Task 5: 将原型确认状态注入下游步骤并稳定标签

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/collaboration/plan.go`
- Modify: `sf-portal-mvp/src/hooks/collaborationExecutionGraphState.js`
- Create or modify: `sf-portal-mvp/scripts/check-collaboration-plan.mjs`
- Test: `factory-server/internal/executor/claude_runner_test.go`

- [ ] **Step 1: 编写失败测试，确认下游 prompt 带原型上下文**

在 `factory-server/internal/executor/claude_runner_test.go` 增加：

```go
func TestPrototypeContextIncludedForSolutionDesign(t *testing.T) {
	contractPath := filepath.Join(t.TempDir(), "prototype-contract.json")
	mustWriteJSON(t, contractPath, model.PrototypeContract{
		Style: "专业简洁", Audience: "开发", Platform: "responsive", Fidelity: "static", Confirmed: true,
		Constraints: []string{"首页优先展示核心任务入口", "保留响应式布局"},
	})
	ctx := prototypePromptContext([]model.Artifact{{Kind: "prototype_contract", Path: contractPath}})
	if !strings.Contains(ctx, "prototype_design_context") {
		t.Fatalf("context missing marker: %s", ctx)
	}
	if !strings.Contains(ctx, "硬约束") {
		t.Fatalf("confirmed prototype should be hard constraint: %s", ctx)
	}
}
```

- [ ] **Step 2: 运行测试，确认红灯**

```powershell
go test ./factory-server/internal/executor -run TestPrototypeContextIncludedForSolutionDesign -count=1
```

预期：`prototypePromptContext` 未定义。

- [ ] **Step 3: 增加原型上下文 helper**

在 `factory-server/internal/executor/claude_runner.go` 增加：

```go
func prototypePromptContext(artifacts []model.Artifact) string {
	var latest *model.Artifact
	for i := range artifacts {
		if artifacts[i].Kind == "prototype_contract" {
			latest = &artifacts[i]
		}
	}
	if latest == nil || latest.Path == "" {
		return ""
	}
	var contract model.PrototypeContract
	if err := readJSONFile(latest.Path, &contract); err != nil {
		return ""
	}
	constraintLevel := "参考"
	if contract.Confirmed {
		constraintLevel = "硬约束"
	}
	return fmt.Sprintf(`[prototype_design_context]
约束级别：%s
风格：%s
目标用户：%s
目标平台：%s
保真度：%s
约束：%s
[/prototype_design_context]`, constraintLevel, contract.Style, contract.Audience, contract.Platform, contract.Fidelity, strings.Join(contract.Constraints, "；"))
}
```

- [ ] **Step 4: 只向下游步骤追加原型上下文**

在 prompt 构造处加入：

```go
switch step.Kind {
case model.StepSolutionDesign, model.StepCodeGeneration, model.StepProductAcceptance:
	if ctx := prototypePromptContext(input.Artifacts); ctx != "" {
		prompt += "\n\n" + ctx + "\n"
	}
}
```

不要向 `requirement_analysis` 和 `design_contract` 注入该上下文。

- [ ] **Step 5: 更新协作计划中的 designer 文案**

在 `factory-server/internal/collaboration/plan.go` 将 designer agent 改为：

```go
agent(
	"designer",
	"原型设计",
	"design_contract",
	"analysis",
	false,
	"产出可预览的静态原型页面和结构化原型契约。",
	"读取需求分析文档，确认原型风格、目标用户、目标平台和保真度；默认生成首页静态原型，除非用户明确要求高保真交互。",
	[]string{"prototype-homepage", "responsive-static-page"},
)
```

保持函数参数顺序与原文件一致。

- [ ] **Step 6: 更新前端执行图标签**

在 `sf-portal-mvp/src/hooks/collaborationExecutionGraphState.js` 中增加或修改纯函数：

```js
const STEP_LABELS = {
  requirement_analysis: '需求分析',
  design_contract: '原型设计',
  domain_analysis: '领域分析',
  data_integration: '数据接入',
  solution_design: '方案设计',
  code_generation: '代码生成',
  code_review: '代码评审',
  product_acceptance: '产品验收',
};

const STEP_DESCRIPTIONS = {
  design_contract: '基于需求分析文档生成可预览的静态原型页面，并记录风格、目标用户、目标平台和确认状态。',
};

export function getStepLabel(kind) {
  return STEP_LABELS[kind] ?? kind;
}

export function getStepDescription(kind) {
  return STEP_DESCRIPTIONS[kind] ?? '';
}
```

合并到已有结构中，不重复定义同名常量。

- [ ] **Step 7: 增加执行图校验脚本**

创建或修改 `sf-portal-mvp/scripts/check-collaboration-plan.mjs`：

```js
import assert from 'node:assert/strict';
import { getStepLabel, getStepDescription } from '../src/hooks/collaborationExecutionGraphState.js';

assert.equal(getStepLabel('design_contract'), '原型设计');
assert.match(getStepDescription('design_contract'), /静态原型页面/);
console.log('collaboration plan checks passed');
```

- [ ] **Step 8: 验证并提交**

```powershell
gofmt -w factory-server/internal/executor/claude_runner.go factory-server/internal/executor/claude_runner_test.go factory-server/internal/collaboration/plan.go
go test ./factory-server/internal/executor -run TestPrototypeContextIncludedForSolutionDesign -count=1
node sf-portal-mvp/scripts/check-collaboration-plan.mjs
git add factory-server/internal/executor/claude_runner.go factory-server/internal/executor/claude_runner_test.go factory-server/internal/collaboration/plan.go sf-portal-mvp/src/hooks/collaborationExecutionGraphState.js sf-portal-mvp/scripts/check-collaboration-plan.mjs
git commit -m "feat: pass prototype context downstream"
```

预期：Go 测试通过，Node 脚本输出 `collaboration plan checks passed`。

---

### Task 6: 集成验证和文档收尾

**Files:**
- Modify: `docs/software-factory-local-runbook.md`
- Review only: `docs/superpowers/specs/2026-06-30-prototype-design-step-upgrade-design.md`
- Review only: `CONTEXT.md`

- [ ] **Step 1: 在运行手册记录原型设计步骤**

在 `docs/software-factory-local-runbook.md` 的软件工厂任务流章节追加：

```markdown
### 原型设计步骤

`design_contract` 是历史兼容的内部 step kind，用户界面展示为「原型设计」。该步骤读取需求分析生成并确认的文档，默认生成首页静态原型页面，可记录风格、目标用户、目标平台和保真度。

用户可以在原型预览卡片中执行三类动作：

- 提交自然语言反馈；当反馈涉及模糊方向、高保真交互或重大范围变化时，系统返回具体选项让用户选择。
- 确认原型；确认后原型不可再改，并作为后续方案设计、代码生成和产品验收的硬约束。
- 继续但不确认；后续步骤可参考原型，但不得声明用户已确认该原型。
```

- [ ] **Step 2: 执行后端完整验证**

```powershell
gofmt -w factory-server/internal/runner/claude.go factory-server/internal/runner/claude_test.go factory-server/internal/model/prototype.go factory-server/internal/executor/prototype_contract.go factory-server/internal/executor/claude_runner.go factory-server/internal/executor/execution_records.go factory-server/internal/executor/executor.go factory-server/internal/collaboration/plan.go factory-server/internal/server/prototype_handlers.go factory-server/internal/server/server.go factory-server/internal/server/prototype_handlers_test.go
go test ./factory-server/internal/runner ./factory-server/internal/executor ./factory-server/internal/server ./factory-server/internal/store -count=1
```

预期：所有列出的 Go package 均 PASS。

- [ ] **Step 3: 执行前端脚本验证**

```powershell
node sf-portal-mvp/scripts/check-dialogue-workbench.mjs
node sf-portal-mvp/scripts/check-prototype-card.mjs
node sf-portal-mvp/scripts/check-collaboration-plan.mjs
```

预期：`prototype card checks passed`、`collaboration plan checks passed`，现有 dialogue workbench 脚本也通过。

- [ ] **Step 4: 执行 diff 卫生检查**

```powershell
git diff --check
git diff --stat
```

预期：`git diff --check` 无输出并以 0 退出；`git diff --stat` 中只出现本计划列出的文件。

- [ ] **Step 5: 提交文档收尾**

```powershell
git add docs/software-factory-local-runbook.md
git commit -m "docs: document prototype design flow"
```

如果执行时将 Task 6 文档变更合入 Task 5 提交，需要在最终说明中明确文档已包含在 `feat: pass prototype context downstream`。

---

## 验证矩阵

- Runner 权限边界：`go test ./factory-server/internal/runner -count=1`
- 原型产物校验和下游上下文：`go test ./factory-server/internal/executor -count=1`
- 原型预览和决策 API：`go test ./factory-server/internal/server -count=1`
- Store 兼容性：`go test ./factory-server/internal/store -count=1`
- 对话工作台回归：`node sf-portal-mvp/scripts/check-dialogue-workbench.mjs`
- 原型卡片行为：`node sf-portal-mvp/scripts/check-prototype-card.mjs`
- 执行图标签：`node sf-portal-mvp/scripts/check-collaboration-plan.mjs`
- Diff 卫生：`git diff --check`

## 实施顺序

1. 先做 Task 1，建立 Claude attempt 目录写入边界，避免原型生成获得 repo 级写权限。
2. 再做 Task 2，让 `design_contract` 真正生成、校验并登记原型产物。
3. 再做 Task 3，将原型以安全 API 暴露给前端，并实现确认与继续语义。
4. 再做 Task 4，在对话工作台呈现可预览、可反馈、可确认的原型卡片。
5. 再做 Task 5，把确认状态转化为下游 agent 可理解的约束上下文。
6. 最后做 Task 6，跑完整验证并补运行手册。

## 风险和处理

- 如果 store 没有 `UpdateStepSnapshot` 或 `AdvanceJobAfterStep` 这类方法，直接复用 `ConfirmManualStep` 当前使用的内部路径，不新增第二套推进逻辑。
- 如果 `AnswerJob` 不能按 stepId/attempt 精确重跑，先复用现有 `/api/jobs/:id/answer` 的 step-scoped 路径，并在 handler 中传入当前 prototype step。
- 如果前端已有刷新函数不叫 `reloadJob`，使用现有函数名；组件约定是 `onChanged` 返回 Promise 即可。
- 如果 `design_contract` 历史任务没有原型 Artifact，`prototypeSummary` 返回 404，前端卡片静默不渲染，不影响历史任务查看。