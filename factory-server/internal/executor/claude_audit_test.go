package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// fakeStreamClaudeCommand writes a raw stream-json stdout.log (containing a
// hidden thinking event with a canary) plus a valid output.json, exercising the
// F3 path: captureAuditArtifacts must NOT register the raw stdout as a readable
// artifact because it leaks hidden model reasoning.
type fakeStreamClaudeCommand struct {
	t            *testing.T
	workspace    string
	stdoutStream string // raw stream-json NDJSON for stdout.log
	output       map[string]any
}

func (f fakeStreamClaudeCommand) Run(_ context.Context, dir string, name string, args ...string) (runner.CommandResult, error) {
	return f.run(dir, name, args...)
}

func (f fakeStreamClaudeCommand) RunWithInput(_ context.Context, dir string, _ string, name string, args ...string) (runner.CommandResult, error) {
	return f.run(dir, name, args...)
}

func (f fakeStreamClaudeCommand) run(dir string, name string, args ...string) (runner.CommandResult, error) {
	if name == "git" {
		return runner.CommandResult{ExitCode: 0}, nil
	}
	if name != "claude" {
		f.t.Fatalf("command name = %q, want claude or git", name)
	}
	// Write the operational output.json the validator expects.
	raw, err := json.MarshalIndent(f.output, "", "  ")
	if err != nil {
		f.t.Fatalf("marshal output: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "output.json"), raw, 0o644); err != nil {
		f.t.Fatalf("write output.json: %v", err)
	}
	// Return the raw stream-json as stdout so ClaudeRunner.Run writes it to
	// stdout.log — exactly what the stream-json flags produce in production.
	return runner.CommandResult{ExitCode: 0, Stdout: f.stdoutStream}, nil
}

// TestCaptureAuditArtifactsHidesClaudeReasoning is the F3 regression: the raw
// Claude stdout (stream-json with --include-partial-messages --verbose) contains
// hidden thinking events. captureAuditArtifacts must NOT register that stdout as
// a portal-readable artifact — the safe audit trail for Claude stdout is the
// `activity`/`summary` records, and the public result lands in output.json.
// We plant a canary ("SECRET_REASONING") in a thinking event and assert NO
// registered artifact content contains it.
func TestCaptureAuditArtifactsHidesClaudeReasoning(t *testing.T) {
	st := newClaudeRunnerTestStore(t)
	ws := t.TempDir()
	// The raw stream-json stdout: a thinking event carrying the canary, plus the
	// final result whose `result` IS a valid contract (safe output.json content).
	contract := `{"confirmedRequirementId":"clar_ok","summary":"frozen","appType":"timeline-replay","appName":"demo","generationProfile":{"base":["software-factory-app"]},"validation":{"complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[]}}`
	stdoutStream := strings.Join([]string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"thinking","thinking":"SECRET_REASONING private chain of thought"}`,
		`{"type":"thinking_delta","thinking_delta":"more SECRET_PARTIAL reasoning"}`,
		`{"type":"tool_use","name":"Read","input":{"file_path":"scene/x/scene.md"}}`,
		`{"type":"result","subtype":"success","result":` + jsonStr(contract) + `}`,
		"",
	}, "\n")
	cmd := fakeStreamClaudeCommand{
		t:            t,
		workspace:    ws,
		stdoutStream: stdoutStream,
		output: map[string]any{
			"confirmedRequirementId": "clar_ok",
			"summary":                "frozen",
			"appType":                "timeline-replay",
			"appName":                "demo",
			"coreScenario":           "复盘航迹",
			"primaryView":            "地图+时间轴",
			"mainEntities":           []string{"编队", "事件"},
			"dataPolicy":             "mock_data",
			"acceptanceFocus":        []string{"轨迹联动"},
			"generationProfile":      map[string][]string{"base": {"software-factory-app"}},
			"validation": map[string]any{
				"complete":            true,
				"supported":           true,
				"missingFields":       []string{},
				"unsupportedRequests": []string{},
			},
		},
	}
	artifactRoot := filepath.Join(ws, ".factory-runs")
	r := &ClaudeStepRunner{
		Store:        st,
		Workspace:    ws,
		ArtifactRoot: artifactRoot,
		Claude:       &runner.ClaudeRunner{Runner: cmd},
		AuditRunner:  cmd,
	}
	job, step := claudeJobStep(model.StepRequirementAnalysis)
	// Seed a confirmed requirement whose summary-critical fields match the
	// frozen output above so the Task-6 consistency gate passes; without it the
	// executor coerces an empty ConfirmedRequirementJSON to "{}" and the step
	// fails before the audit/redaction invariants under test can run.
	job.ConfirmedRequirementJSON = `{"summary":"frozen","appType":"timeline-replay","appName":"demo","coreScenario":"复盘航迹","primaryView":"地图+时间轴","mainEntities":["编队","事件"],"dataPolicy":"mock_data","acceptanceFocus":["轨迹联动"]}`
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded — confirms F2 extraction yields a valid contract", res.Status, res.ErrorMessage)
	}

	arts, err := st.ListArtifactsByJob(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("list artifacts: %v", err)
	}
	if len(arts) == 0 {
		t.Fatalf("no artifacts registered")
	}
	for _, a := range arts {
		// No artifact may be the raw Claude stdout (it carries hidden reasoning).
		if a.Kind == "command_stdout" {
			t.Errorf("command_stdout artifact registered for a Claude step (kind=%s id=%s) — raw stream-json stdout must not be a portal-readable artifact", a.Kind, a.ID)
		}
		// Read the artifact content (same path the content endpoint would) and
		// assert the thinking canary never appears in any readable artifact.
		content, rerr := os.ReadFile(a.Path)
		if rerr != nil {
			// Some artifact paths (e.g. command_stderr) may legitimately not exist
			// in this fake run; only flag a content canary when we can read it.
			continue
		}
		if strings.Contains(string(content), "SECRET_REASONING") {
			t.Errorf("artifact kind=%s id=%s path=%q leaked hidden reasoning canary", a.Kind, a.ID, a.Path)
		}
		if strings.Contains(string(content), "SECRET_PARTIAL") {
			t.Errorf("artifact kind=%s id=%s path=%q leaked hidden reasoning partial canary", a.Kind, a.ID, a.Path)
		}
	}
}

// jsonStr returns s as a JSON string literal.
func jsonStr(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}
