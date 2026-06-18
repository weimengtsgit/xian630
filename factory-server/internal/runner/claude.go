package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CommandResult is the captured outcome of one CommandRunner.Run invocation.
type CommandResult struct {
	Stdout     string
	Stderr     string
	ExitCode   int
	DurationMs int64
}

// CommandRunner runs an external command (claude / git) in a directory and
// returns its captured output. The real implementation shells out via
// exec.Command; tests supply a fake.
type CommandRunner interface {
	Run(ctx context.Context, dir string, name string, args ...string) (CommandResult, error)
}

// ClaudeRunner drives one `claude --print` invocation per step attempt and the
// post-run file audit. It does not know about the executor or store.
type ClaudeRunner struct {
	Runner CommandRunner // invokes claude (and git, for AuditFiles)
	Binary string        // claude binary name; defaults to "claude" at first use
}

func (r *ClaudeRunner) binary() string {
	if r.Binary == "" {
		return "claude"
	}
	return r.Binary
}

// argv builds the `claude --print` argument vector for one attempt. Read-only
// steps (requirement_analysis, solution_design) get Read/Grep/Glob only; the
// code_generation step additionally gets Edit/Write. Every stage forbids Bash,
// because MVP never lets Claude run shell commands (design §9) — npm and
// podman are executed by Factory itself.
func claudeArgv(codegen bool) []string {
	if codegen {
		return []string{
			"--print",
			"--permission-mode", "plan",
			"--allowedTools", "Read,Grep,Glob,Edit,Write",
			"--disallowedTools", "Bash",
		}
	}
	return []string{
		"--print",
		"--permission-mode", "plan",
		"--allowedTools", "Read,Grep,Glob",
		"--disallowedTools", "Bash,Edit,Write",
	}
}

// Run writes the attempt input.json and prompt.md, then invokes the claude
// binary with stage-tightened tool permissions and captures stdout/stderr into
// the attempt artifact dir. On a non-zero exit it returns an error wrapping
// ErrRunnerExitNonzero. It does NOT validate output.json or run the file audit;
// callers do those separately. The claude process runs with its working
// directory set to the attempt dir so the agent can read input.json/prompt.md
// and write output.json via relative paths.
func (r *ClaudeRunner) Run(ctx context.Context, ws AttemptWorkspace, prompt string, inputData []byte, codegen bool) error {
	if err := os.MkdirAll(ws.Dir(), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", ws.Dir(), err)
	}
	if err := os.WriteFile(ws.InputPath(), inputData, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", ws.InputPath(), err)
	}
	if err := os.WriteFile(ws.PromptPath(), []byte(prompt), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", ws.PromptPath(), err)
	}

	args := append(claudeArgv(codegen), prompt)
	res, err := r.Runner.Run(ctx, ws.Dir(), r.binary(), args...)
	// Capture whatever we got, even on failure, for audit/debugging.
	_ = os.WriteFile(ws.StdoutPath(), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(ws.StderrPath(), []byte(res.Stderr), 0o644)
	if err != nil {
		return fmt.Errorf("claude run: %w", err)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("claude exit %d: %w", res.ExitCode, ErrRunnerExitNonzero)
	}
	return nil
}

// protectedPrefixes are repo paths that a Claude step must never modify. A
// change to any of them after a run is a hard file_constraint_violated (design
// §9). Trailing slashes so "scene/" does not match "scene-of-crime/".
var protectedPrefixes = []string{
	"scene/",
	"factory-server/",
	"cc-status/",
	".git/",
}

// AuditFiles implements the post-run audit from design §9: parse
// `git status --porcelain`, reject any change under a protected path, then
// reject any declared output file that is not under generated-apps/<slug>/ or
// .factory-runs/jobs/<jobID>/. runner is taken as a parameter (rather than
// r.Runner) so callers can pass a distinct audit-time git runner if needed; in
// practice it is the same instance.
func (r *ClaudeRunner) AuditFiles(ctx context.Context, runner CommandRunner, jobID string, slug string, declaredFiles []string) error {
	// git status --porcelain runs at the repo root; the fake runner ignores dir.
	res, err := runner.Run(ctx, "", "git", "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("git status: %w", err)
	}
	for _, line := range strings.Split(res.Stdout, "\n") {
		path := porcelainPath(line)
		if path == "" {
			continue
		}
		norm := filepath.ToSlash(path)
		for _, p := range protectedPrefixes {
			if strings.HasPrefix(norm, p) {
				return fmt.Errorf("protected path modified: %s: %w", norm, ErrFileConstraintViolated)
			}
		}
	}

	genRoot := "generated-apps/" + slug + "/"
	runRoot := ".factory-runs/jobs/" + jobID + "/"
	for _, f := range declaredFiles {
		norm := filepath.ToSlash(f)
		if strings.HasPrefix(norm, genRoot) || strings.HasPrefix(norm, runRoot) {
			continue
		}
		return fmt.Errorf("declared file outside allowed roots: %s: %w", norm, ErrFileConstraintViolated)
	}
	return nil
}

// porcelainPath extracts the path from one `git status --porcelain` line. The
// format is "XY <path>" where XY is two status chars; the path may be quoted
// (with special escaping) when it contains whitespace/non-ASCII, but for the
// paths this audit cares about (source under scene/ etc.) the simple split is
// sufficient and we don't unescape.
func porcelainPath(line string) string {
	line = strings.TrimRight(line, "\r")
	if len(line) < 4 {
		return ""
	}
	// cols 0,1 = XY; col 2 = space; path starts at col 3. For renames the path
	// is "old -> new"; we check both halves by returning the whole tail.
	return strings.TrimSpace(line[3:])
}
