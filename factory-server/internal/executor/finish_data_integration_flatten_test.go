package executor

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// TestFinishDataIntegrationRejectsFlattenedDataAccess reproduces the AZ2F drift
// (job_aab0f4a92248b7087f614f31): the model writes every dataAccessResult field
// at the TOP LEVEL and omits the nested object. The step must fail with
// output_invalid_json (bounded auto-retry) instead of being accepted as a plain
// producer success — the old behavior left no data-access/final artifact and
// code_generation died on its start guard one step later.
func TestFinishDataIntegrationRejectsFlattenedDataAccess(t *testing.T) {
	st := newClaudeRunnerTestStore(t)
	ws := t.TempDir()
	cmd := fakeClaudeCommand{
		t:         t,
		workspace: ws,
		output: map[string]any{
			"status":            "pending_confirmation",
			"needsUserInput":    false,
			"questions":         []any{},
			"workLog":           []any{},
			"summary":           "内嵌模拟数据生成器，字段与契约对齐",
			"schemaVersion":     1,
			"stage":             "data_access",
			"version":           "1.0.0",
			"canFinalize":       true,
			"blockingIssues":    []any{},
			"dataAccessMode":    "mock",
			"dataNeeds":         []any{map[string]any{"key": "wind_10m"}},
			"sourceCandidates":  []any{map[string]any{"name": "NOAA NDBC"}},
			"dataAccessMarkdown": "# 数据获取方案\n",
		},
	}
	r := &ClaudeStepRunner{
		Store:        st,
		Workspace:    ws,
		ArtifactRoot: filepath.Join(ws, ".factory-runs"),
		Claude:       &runner.ClaudeRunner{Runner: cmd},
		AuditRunner:  cmd,
	}
	job, step := claudeJobStep(model.StepDataIntegration)
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}

	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed {
		t.Fatalf("status = %s, want failed", res.Status)
	}
	if res.ErrorCode != model.ErrorOutputInvalidJSON {
		t.Fatalf("error code = %q (%s), want output_invalid_json", res.ErrorCode, res.ErrorMessage)
	}
}

// TestFinishDataIntegrationStillAcceptsPlainProducerOutput guards the other
// side of the new check: a data_integration output that neither nests
// dataAccessResult NOR carries its flattened characteristic fields is still a
// plain collaboration producer success (the analysis-lane contract).
func TestFinishDataIntegrationStillAcceptsPlainProducerOutput(t *testing.T) {
	st := newClaudeRunnerTestStore(t)
	ws := t.TempDir()
	cmd := fakeClaudeCommand{
		t:         t,
		workspace: ws,
		output: map[string]any{
			"status":         "passed",
			"needsUserInput": false,
			"questions":      []any{},
			"workLog":        []any{},
			"summary":        "数据接入分析完成",
		},
	}
	r := &ClaudeStepRunner{
		Store:        st,
		Workspace:    ws,
		ArtifactRoot: filepath.Join(ws, ".factory-runs"),
		Claude:       &runner.ClaudeRunner{Runner: cmd},
		AuditRunner:  cmd,
	}
	job, step := claudeJobStep(model.StepDataIntegration)
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}

	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
}
