package runner

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func toSlash(t *testing.T, p string) string {
	t.Helper()
	return filepath.ToSlash(p)
}

func TestAttemptWorkspacePaths(t *testing.T) {
	ws := AttemptWorkspace{
		Root:     ".factory-runs",
		JobID:    "job_1",
		StepKind: model.StepRequirementAnalysis,
		Attempt:  1,
	}

	wantDir := ".factory-runs/jobs/job_1/requirement_analysis/attempt-1"
	if got := toSlash(t, ws.Dir()); !strings.HasSuffix(got, wantDir) {
		t.Fatalf("Dir() = %q, want suffix %q", got, wantDir)
	}

	cases := []struct {
		name string
		got  string
		want string
	}{
		{"InputPath", toSlash(t, ws.InputPath()), "/attempt-1/input.json"},
		{"PromptPath", toSlash(t, ws.PromptPath()), "/attempt-1/prompt.md"},
		{"OutputPath", toSlash(t, ws.OutputPath()), "/attempt-1/output.json"},
		{"StdoutPath", toSlash(t, ws.StdoutPath()), "/attempt-1/stdout.log"},
		{"StderrPath", toSlash(t, ws.StderrPath()), "/attempt-1/stderr.log"},
		{"OutputMDPath", toSlash(t, ws.OutputMDPath()), "/attempt-1/output.md"},
	}
	for _, c := range cases {
		if !strings.HasSuffix(c.got, c.want) {
			t.Errorf("%s = %q, want suffix %q", c.name, c.got, c.want)
		}
		// ensure each file path lives directly under Dir()
		if d := toSlash(t, ws.Dir()); !strings.HasPrefix(c.got, d+"/") {
			t.Errorf("%s = %q, want it under Dir %q", c.name, c.got, d)
		}
	}
}
