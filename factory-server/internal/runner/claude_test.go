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
	stdout      string
	exitCode    int
	err         error
	records     [][]string // each Run appended
	dirs        []string
	stdoutFiles map[string]string // if a recorded argv matches a path pattern, write stdout to it
}

func (f *fakeRunner) Run(ctx context.Context, dir string, name string, args ...string) (CommandResult, error) {
	rec := append([]string{name}, args...)
	f.records = append(f.records, rec)
	f.dirs = append(f.dirs, dir)
	f.name = name
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

func TestClaudeRunReadOnlyArgv(t *testing.T) {
	fr := &fakeRunner{stdout: "hello stdout"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	if err := r.Run(context.Background(), ws, "PROMPT", []byte(`{"x":1}`), false); err != nil {
		t.Fatalf("Run err = %v", err)
	}

	// name is the binary
	if fr.name != "claude" {
		t.Errorf("name = %q, want claude", fr.name)
	}
	got := joinArgs(fr.argv)
	wantRo := "--print --permission-mode plan --allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write"
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
	if string(pr) != "PROMPT" {
		t.Errorf("prompt.md = %q, want PROMPT", string(pr))
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
	fr := &fakeRunner{stdout: "ok"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)
	ws.StepKind = model.StepCodeGeneration

	if err := r.Run(context.Background(), ws, "P", nil, true); err != nil {
		t.Fatalf("Run err = %v", err)
	}
	got := joinArgs(fr.argv)
	wantCg := "--print --permission-mode plan --allowedTools Read,Grep,Glob,Edit,Write --disallowedTools Bash"
	if got != wantCg {
		t.Errorf("codegen argv =\n got: %q\nwant: %q", got, wantCg)
	}
}

func TestClaudeRunNonzeroExit(t *testing.T) {
	fr := &fakeRunner{exitCode: 1, stdout: "boom"}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)

	err := r.Run(context.Background(), ws, "P", nil, false)
	if !errors.Is(err, ErrRunnerExitNonzero) {
		t.Fatalf("err = %v, want ErrRunnerExitNonzero", err)
	}
	// even on failure stdout/stderr must be captured for audit
	if _, e := os.Stat(ws.StdoutPath()); e != nil {
		t.Errorf("stdout.log not written on nonzero exit: %v", e)
	}
}

func TestClaudeRunDefaultBinary(t *testing.T) {
	fr := &fakeRunner{}
	r := ClaudeRunner{Runner: fr} // Binary empty -> default "claude"
	if r.binary() != "claude" {
		t.Fatalf("binary() = %q, want claude", r.binary())
	}
	ws := newWS(t)
	if err := r.Run(context.Background(), ws, "P", nil, false); err != nil {
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

func TestAuditRejectsProtectedPath(t *testing.T) {
	r := ClaudeRunner{Binary: "claude"}
	ctx := context.Background()

	// 1) scene/ modified -> rejected
	ar := &auditRunner{stdout: " M scene/foo.go\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("scene change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 2) factory-server/ -> rejected
	ar = &auditRunner{stdout: "?? factory-server/x\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("factory-server change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 3) cc-status/ -> rejected
	ar = &auditRunner{stdout: " M cc-status/main.go\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("cc-status change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 4) .git/ -> rejected
	ar = &auditRunner{stdout: " M .git/config\n"}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", nil); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf(".git change: err = %v, want ErrFileConstraintViolated", err)
	}
	// 5) clean status -> nil
	ar = &auditRunner{stdout: ""}
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"generated-apps/slug/src/a.tsx", ".factory-runs/jobs/job_1/output.json"}); err != nil {
		t.Errorf("clean: err = %v, want nil", err)
	}
}

func TestAuditRejectsDeclaredFileOutsideAllowed(t *testing.T) {
	r := ClaudeRunner{Binary: "claude"}
	ctx := context.Background()
	ar := &auditRunner{stdout: ""} // clean git status

	// declared file outside allowed roots -> rejected
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"somewhere/else.txt"}); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("outside declared: err = %v, want ErrFileConstraintViolated", err)
	}
	// absolute path -> rejected
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"/etc/passwd"}); !errors.Is(err, ErrFileConstraintViolated) {
		t.Errorf("/etc/passwd: err = %v, want ErrFileConstraintViolated", err)
	}
	// file under generated-apps/<slug>/... -> ok
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{"generated-apps/slug/src/a.tsx"}); err != nil {
		t.Errorf("under generated-apps/<slug>: err = %v, want nil", err)
	}
	// file under .factory-runs/jobs/<jobID>/... -> ok
	if err := r.AuditFiles(ctx, ar, "job_1", "slug", []string{".factory-runs/jobs/job_1/output.json"}); err != nil {
		t.Errorf("under .factory-runs/jobs/<id>: err = %v, want nil", err)
	}
}
