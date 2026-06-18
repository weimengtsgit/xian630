package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/id"
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

type codeGenerationStepOutput struct {
	ProjectDir     string            `json:"projectDir"`
	CreatedFiles   []string          `json:"createdFiles"`
	NeedsUserInput bool              `json:"needsUserInput"`
	Questions      []runner.Question `json:"questions"`
}

func (c *ClaudeStepRunner) Run(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	switch step.Kind {
	case model.StepRequirementAnalysis, model.StepSolutionDesign, model.StepCodeGeneration:
	default:
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "claude runner cannot handle " + string(step.Kind)}, nil
	}
	if c.Claude == nil || c.Claude.Runner == nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "claude runner not configured"}, nil
	}

	ws := runner.AttemptWorkspace{Root: c.artifactRoot(), JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	input, err := json.MarshalIndent(map[string]any{
		"job":  job,
		"step": step,
	}, "", "  ")
	if err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	if err := c.Claude.Run(ctx, ws, c.prompt(job, step, ws), input, step.Kind == model.StepCodeGeneration); err != nil {
		return c.failureFromError(err), nil
	}
	c.recordArtifact(ctx, job.ID, step, "output_json", ws.OutputPath(), "Claude step output contract")
	if _, err := os.Stat(ws.OutputMDPath()); err == nil {
		c.recordArtifact(ctx, job.ID, step, "output_markdown", ws.OutputMDPath(), "Claude human-readable step output")
	}

	switch step.Kind {
	case model.StepRequirementAnalysis:
		out, err := runner.ValidateRequirementAnalysis(ws.OutputPath())
		return c.resultFromValidatedOutput(out, err), nil
	case model.StepSolutionDesign:
		out, err := runner.ValidateSolutionDesign(ws.OutputPath())
		return c.resultFromValidatedOutput(out, err), nil
	case model.StepCodeGeneration:
		return c.finishCodeGeneration(ctx, job, step, ws.OutputPath()), nil
	default:
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: "unsupported claude step"}, nil
	}
}

func (c *ClaudeStepRunner) finishCodeGeneration(ctx context.Context, job model.Job, step model.JobStep, outputPath string) StepResult {
	var raw codeGenerationStepOutput
	if err := decodeStrict(outputPath, &raw); err != nil {
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
		if err := c.Claude.AuditFiles(ctx, audit, job.ID, slugFromProjectDir(raw.ProjectDir), files); err != nil {
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

func (c *ClaudeStepRunner) recordArtifact(ctx context.Context, jobID string, step model.JobStep, kind, path, summary string) {
	if c.Store == nil {
		return
	}
	_ = c.Store.CreateArtifact(ctx, model.Artifact{
		ID:        "art_" + id.New(),
		JobID:     jobID,
		StepID:    step.ID,
		Attempt:   step.Attempt,
		Kind:      kind,
		Path:      path,
		Summary:   summary,
		CreatedAt: time.Now(),
	})
}

func (c *ClaudeStepRunner) prompt(job model.Job, step model.JobStep, ws runner.AttemptWorkspace) string {
	switch step.Kind {
	case model.StepRequirementAnalysis:
		return "你是软件工厂的需求分析 agent。读取 input.json，基于用户需求输出 output.json。格式必须包含 summary、appType、needsUserInput、questions。可以在 output.md 写可审计的需求分析摘要，不要输出隐藏推理链。\n用户需求：" + job.UserPrompt
	case model.StepSolutionDesign:
		return "你是软件工厂的方案设计 agent。读取 input.json，输出 output.json，必须包含 needsUserInput、questions，可包含 app 和 artifactPlan。可以在 output.md 写方案摘要，不要输出隐藏推理链。\n用户需求：" + job.UserPrompt
	case model.StepCodeGeneration:
		return "你是软件工厂的代码生成 agent。读取 input.json，在仓库 generated-apps/<slug>/ 下生成静态 Vite 应用和 .factory/app.json。output.json 必须包含 projectDir、createdFiles、needsUserInput、questions。createdFiles 使用仓库相对路径。可以在 output.md 写生成摘要，不要输出隐藏推理链。output.json 路径：" + ws.OutputPath()
	default:
		return job.UserPrompt
	}
}

func (c *ClaudeStepRunner) workspace() string {
	if c.Workspace == "" {
		return "."
	}
	return c.Workspace
}

func (c *ClaudeStepRunner) artifactRoot() string {
	if c.ArtifactRoot == "" {
		return ".factory-runs"
	}
	return c.ArtifactRoot
}

func decodeStrict(path string, target any) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s: %w", path, runner.ErrOutputMissing)
		}
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return fmt.Errorf("%s: %w", path, runner.ErrOutputInvalidJSON)
	}
	return nil
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
