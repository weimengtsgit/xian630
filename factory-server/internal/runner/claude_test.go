package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// fakeRunner is a CommandRunner that records argv, returns canned output, and
// optionally writes a stdout payload. It never invokes a real binary.
type fakeRunner struct {
	argv        []string
	dir         string
	name        string
	stdin       string
	stdout      string
	exitCode    int
	err         error
	records     [][]string // each Run appended
	dirs        []string
	stdoutFiles map[string]string // if a recorded argv matches a path pattern, write stdout to it
}

func (f *fakeRunner) Run(ctx context.Context, dir string, name string, args ...string) (CommandResult, error) {
	return f.run(ctx, dir, "", name, args...)
}

func (f *fakeRunner) RunWithInput(ctx context.Context, dir string, input string, name string, args ...string) (CommandResult, error) {
	return f.run(ctx, dir, input, name, args...)
}

func (f *fakeRunner) run(_ context.Context, dir string, input string, name string, args ...string) (CommandResult, error) {
	rec := append([]string{name}, args...)
	f.records = append(f.records, rec)
	f.dirs = append(f.dirs, dir)
	f.name = name
	f.stdin = input
	f.argv = args
	res := CommandResult{Stdout: f.stdout, ExitCode: f.exitCode}
	if f.err != nil {
		return res, f.err
	}
	return res, nil
}

func newWS(t *testing.T) AttemptWorkspace {
	t.Helper()
	return AttemptWorkspace{
		Root:     filepath.Join(t.TempDir(), ".factory-runs"),
		JobID:    "job_1",
		StepKind: model.StepRequirementAnalysis,
		Attempt:  1,
	}
}

func joinArgs(args []string) string { return strings.Join(args, " ") }

func clearClaudeModelEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CLAUDE_CODE_MODEL", "")
	t.Setenv("ANTHROPIC_MODEL", "")
}

func TestClaudeRunReadOnlyArgv(t *testing.T) {
	clearClaudeModelEnv(t)
	fr := &fakeRunner{stdout: "hello stdout"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)
	prompt := "PROMPT\n第二行"

	if err := r.Run(context.Background(), ws, prompt, []byte(`{"x":1}`), false, nil); err != nil {
		t.Fatalf("Run err = %v", err)
	}

	// name is the binary
	if fr.name != "claude" {
		t.Errorf("name = %q, want claude", fr.name)
	}
	if fr.stdin != prompt {
		t.Fatalf("stdin = %q, want prompt %q", fr.stdin, prompt)
	}
	got := joinArgs(fr.argv)
	// Task 3: every stage appends stream-json flags so the runner can parse
	// tool_use events into activity records. Read-only stages now avoid plan
	// mode because some Claude-compatible providers turn it into an approval
	// loop and emit prose instead of the required JSON contract.
	wantRo := "--print --permission-mode acceptEdits --allowedTools Read,Grep,Glob,Write --disallowedTools Bash,Edit --output-format stream-json --include-partial-messages --verbose"
	if got != wantRo {
		t.Errorf("read-only argv =\n got: %q\nwant: %q", got, wantRo)
	}

	// input.json + prompt.md written
	in, err := os.ReadFile(ws.InputPath())
	if err != nil {
		t.Fatalf("read input.json: %v", err)
	}
	if string(in) != `{"x":1}` {
		t.Errorf("input.json = %q, want `{\"x\":1}`", string(in))
	}
	pr, err := os.ReadFile(ws.PromptPath())
	if err != nil {
		t.Fatalf("read prompt.md: %v", err)
	}
	if string(pr) != prompt {
		t.Errorf("prompt.md = %q, want %q", string(pr), prompt)
	}
	// stdout.log captured
	out, err := os.ReadFile(ws.StdoutPath())
	if err != nil {
		t.Fatalf("read stdout.log: %v", err)
	}
	if string(out) != "hello stdout" {
		t.Errorf("stdout.log = %q, want 'hello stdout'", string(out))
	}
	// ran from the attempt dir so the agent can read inputs
	if fr.dirs[len(fr.dirs)-1] != ws.Dir() {
		t.Errorf("run dir = %q, want %q", fr.dirs[len(fr.dirs)-1], ws.Dir())
	}
}

func TestClaudeRunCodegenArgv(t *testing.T) {
	clearClaudeModelEnv(t)
	fr := &fakeRunner{stdout: "ok"}
	workspace := t.TempDir()
	r := ClaudeRunner{Runner: fr, Binary: "claude", WorkDir: workspace}
	ws := newWS(t)
	ws.StepKind = model.StepCodeGeneration
	prompt := "P\n生成应用"

	if err := r.Run(context.Background(), ws, prompt, nil, true, nil); err != nil {
		t.Fatalf("Run err = %v", err)
	}
	if fr.stdin != prompt {
		t.Fatalf("stdin = %q, want prompt %q", fr.stdin, prompt)
	}
	got := joinArgs(fr.argv)
	// code_generation must NOT run in plan mode: plan mode blocks ALL Edit/Write
	// regardless of --allowedTools, so the agent could neither generate app files
	// nor write output.json (real failure: glm-5.1 emitted prose instead of code
	// → output_invalid_json). acceptEdits auto-approves file writes in headless
	// --print while --disallowedTools Bash still forbids shell.
	wantCg := "--print --permission-mode acceptEdits --allowedTools Read,Grep,Glob,Edit,Write --disallowedTools Bash --output-format stream-json --include-partial-messages --verbose"
	if got != wantCg {
		t.Errorf("codegen argv =\n got: %q\nwant: %q", got, wantCg)
	}
	if got := fr.dirs[len(fr.dirs)-1]; got != workspace {
		t.Fatalf("codegen run dir = %q, want workspace %q", got, workspace)
	}
	if _, err := os.Stat(ws.InputPath()); err != nil {
		t.Fatalf("input artifact missing: %v", err)
	}
	if _, err := os.Stat(ws.PromptPath()); err != nil {
		t.Fatalf("prompt artifact missing: %v", err)
	}
}

func TestClaudeRunAppendsModelArgFromEnv(t *testing.T) {
	t.Setenv("CLAUDE_CODE_MODEL", "glm-5.1")
	t.Setenv("ANTHROPIC_MODEL", "")
	fr := &fakeRunner{stdout: "ok"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	if err := r.Run(context.Background(), ws, "P", nil, false, nil); err != nil {
		t.Fatalf("Run err = %v", err)
	}
	got := joinArgs(fr.argv)
	if !strings.Contains(got, "--model glm-5.1") {
		t.Fatalf("argv missing model override: %q", got)
	}
}

func TestClaudeRunNonzeroExit(t *testing.T) {
	fr := &fakeRunner{exitCode: 1, stdout: "boom"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	err := r.Run(context.Background(), ws, "P", nil, false, nil)
	if !errors.Is(err, ErrRunnerExitNonzero) {
		t.Fatalf("err = %v, want ErrRunnerExitNonzero", err)
	}
	// even on failure stdout/stderr must be captured for audit
	if _, e := os.Stat(ws.StdoutPath()); e != nil {
		t.Errorf("stdout.log not written on nonzero exit: %v", e)
	}
}

// TestClaudeRunToleratesSpuriousErrorAfterSuccess: the Claude Code CLI can emit a
// genuine success result AND a spurious trailing "error_during_execution"
// (e.g. "only prompt commands are supported in streaming mode", seen with
// stdin-piped prompts under stream-json during acceptEdits code generation) and
// then exit 1. When a success result is present, the non-zero exit is a transport
// quirk, not a step failure — Run must proceed so completed work is not
// discarded. Reproduces the job_32a76c2b0d13b0509c675798 code_generation failure.
func TestClaudeRunToleratesSpuriousErrorAfterSuccess(t *testing.T) {
	stdout := strings.Join([]string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"done"}`,
		`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["only prompt commands are supported in streaming mode"]}`,
		"",
	}, "\n")
	fr := &fakeRunner{exitCode: 1, stdout: stdout}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	if err := r.Run(context.Background(), ws, "P", nil, false, nil); err != nil {
		t.Fatalf("Run err = %v, want nil (success result present tolerates non-zero exit)", err)
	}
}

// TestClaudeRunNonzeroExitStillFailsWithoutSuccess: a non-zero exit whose stdout
// holds only an error result (no subtype:"success") is a real failure and must
// still surface ErrRunnerExitNonzero — the tolerance is strictly opt-in on a
// present success result, never a blanket ignore of non-zero exits.
func TestClaudeRunNonzeroExitStillFailsWithoutSuccess(t *testing.T) {
	stdout := strings.Join([]string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["real failure"]}`,
		"",
	}, "\n")
	fr := &fakeRunner{exitCode: 1, stdout: stdout}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	err := r.Run(context.Background(), ws, "P", nil, false, nil)
	if !errors.Is(err, ErrRunnerExitNonzero) {
		t.Fatalf("err = %v, want ErrRunnerExitNonzero", err)
	}
}

// TestClaudeRunWritesStreamResultToOutputWhenMissing (F2): with stream-json
// flags, stdout is NDJSON. When output.json is absent (read-only stages cannot
// write it themselves), ClaudeRunner.Run must extract the final type=result
// event's `result` string and write THAT — not the raw stream (which would make
// validation grab the first event envelope and fail).
func TestClaudeRunWritesStreamResultToOutputWhenMissing(t *testing.T) {
	contract := `{"needsUserInput":false,"questions":[]}`
	stdout := strings.Join([]string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"thinking","thinking":"hidden"}`,
		`{"type":"result","subtype":"success","result":` + jsonString(contract) + `}`,
		"",
	}, "\n")
	fr := &fakeRunner{stdout: stdout}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	if err := r.Run(context.Background(), ws, "P", nil, false, nil); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(ws.OutputPath())
	if err != nil {
		t.Fatalf("read output.json: %v", err)
	}
	if string(raw) != contract {
		t.Fatalf("output.json = %q, want the extracted result %q", string(raw), contract)
	}
}

func TestClaudeRunDefaultBinary(t *testing.T) {
	fr := &fakeRunner{}
	r := ClaudeRunner{Runner: fr} // Binary empty -> default "claude"
	if r.binary() != "claude" {
		t.Fatalf("binary() = %q, want claude", r.binary())
	}
	ws := newWS(t)
	if err := r.Run(context.Background(), ws, "P", nil, false, nil); err != nil {
		t.Fatal(err)
	}
	if fr.name != "claude" {
		t.Errorf("invoked name = %q, want claude", fr.name)
	}
}

// auditRunner returns a canned git-status stdout for any invocation.
type auditRunner struct {
	stdout   string
	exitCode int
}

func (a *auditRunner) Run(ctx context.Context, dir, name string, args ...string) (CommandResult, error) {
	return CommandResult{Stdout: a.stdout, ExitCode: a.exitCode}, nil
}

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

func TestClaudeRunReadOnlyAllowsOnlyOutputFileWrite(t *testing.T) {
	clearClaudeModelEnv(t)
	fr := &fakeRunner{stdout: "ok"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	if err := r.Run(context.Background(), ws, "readonly", []byte(`{}`), false, nil); err != nil {
		t.Fatalf("Run err = %v", err)
	}

	got := joinArgs(fr.argv)
	if !strings.Contains(got, "--allowedTools Read,Grep,Glob,Write") || !strings.Contains(got, "--disallowedTools Bash,Edit") {
		t.Fatalf("read-only permissions changed unexpectedly: %q", got)
	}
}

func TestAuditRejectsProtectedPath(t *testing.T) {
	r := ClaudeRunner{Binary: "claude"}
	ctx := context.Background()

	// 1) scene/ modified -> rejected
	ar := &auditRunner{stdout: " M scene/foo.go\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil, nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("scene change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 2) factory-server/ -> rejected
	ar = &auditRunner{stdout: "?? factory-server/x\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil, nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("factory-server change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 3) cc-status/ -> rejected
	ar = &auditRunner{stdout: " M cc-status/main.go\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil, nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("cc-status change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 4) .git/ -> rejected
	ar = &auditRunner{stdout: " M .git/config\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil, nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf(".git change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 5) clean status -> nil
	ar = &auditRunner{stdout: ""}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"generated-apps/slug/src/a.tsx", ".factory-runs/jobs/job_1/output.json"}, nil); err != nil {
		t.Errorf("clean: err = %v, want nil", err)
	}
}

func TestAuditRejectsDeclaredFileOutsideAllowed(t *testing.T) {
	r := ClaudeRunner{Binary: "claude"}
	ctx := context.Background()
	ar := &auditRunner{stdout: ""} // clean git status

	// declared file outside allowed roots -> rejected
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"somewhere/else.txt"}, nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("outside declared: err = %v, want ErrFileConstraintViolated", err)
	}
	// absolute path -> rejected
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"/etc/passwd"}, nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("/etc/passwd: err = %v, want ErrFileConstraintViolated", err)
	}
	// file under generated-apps/<slug>/... -> ok
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"generated-apps/slug/src/a.tsx"}, nil); err != nil {
		t.Errorf("under generated-apps/<slug>: err = %v, want nil", err)
	}
	// file under .factory-runs/jobs/<jobID>/... -> ok
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{".factory-runs/jobs/job_1/output.json"}, nil); err != nil {
		t.Errorf("under .factory-runs/jobs/<id>: err = %v, want nil", err)
	}
}

// TestAuditIgnoresPreExistingDirtyProtectedPath locks in the fix for the
// file_constraint_violated false positive: git status --porcelain reports the
// WHOLE working tree, so a developer's in-progress dirty files under protected
// prefixes (32 of them in the real repo) were blamed on every code_generation
// run even though the agent never touched them. BaselineStatus captures the
// pre-run dirty set; AuditFiles must skip those paths and only flag protected
// changes that appeared DURING the run.
func TestAuditIgnoresPreExistingDirtyProtectedPath(t *testing.T) {
	r := ClaudeRunner{Binary: "claude"}
	ctx := context.Background()

	// Pre-run baseline: the developer's already-dirty protected-path files.
	baseline := r.BaselineStatus(ctx, &auditRunner{stdout: " M cc-status/README.md\n M factory-server/internal/runner/claude.go\n"})
	if len(baseline) != 2 {
		t.Fatalf("baseline = %v, want 2 paths", baseline)
	}

	// After run: SAME dirty files (agent didn't touch them) + a legit generated
	// file under an allowed root. Must PASS.
	after := &auditRunner{stdout: " M cc-status/README.md\n M factory-server/internal/runner/claude.go\n?? generated-apps/slug/src/App.jsx\n"}
	if err := r.AuditFiles(ctx, after, "job_1", "slug", []string{"generated-apps/slug/src/App.jsx"}, baseline); err != nil {
		t.Errorf("pre-existing dirty: err = %v, want nil (agent did not modify them)", err)
	}

	// But a NEW protected-path change not in the baseline -> still rejected.
	afterNew := &auditRunner{stdout: " M cc-status/README.md\n M scene/blueprint.md\n"}
	if err := r.AuditFiles(ctx, afterNew, "job_1", "slug", nil, baseline); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("new protected change: err = %v, want ErrFileConstraintViolated", err)
	}
}
