package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
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

type inputCommandRunner interface {
	RunWithInput(ctx context.Context, dir string, input string, name string, args ...string) (CommandResult, error)
}

// ClaudeRunner drives one `claude --print` invocation per step attempt and the
// post-run file audit. It does not know about the executor or store.
type ClaudeRunner struct {
	Runner  CommandRunner // invokes claude (and git, for AuditFiles)
	Binary  string        // claude binary name; defaults to "claude" at first use
	WorkDir string        // workspace root for code_generation; other stages run in the attempt artifact directory
}

func (r *ClaudeRunner) binary() string {
	if r.Binary == "" {
		return "claude"
	}
	return r.Binary
}

// argv builds the `claude --print` argument vector for one attempt. Read-only
// steps (requirement_analysis, solution_design) get Read/Grep/Glob only and run
// in plan mode. The code_generation step additionally gets Edit/Write and MUST
// run in acceptEdits mode, NOT plan: plan mode blocks ALL file mutations
// regardless of --allowedTools, so an agent in plan mode can neither generate
// the app files nor write output.json — observed in production as glm-5.1
// emitting a prose "I couldn't write files" essay instead of code, which then
// failed validation as output_invalid_json. acceptEdits auto-approves Edit/Write
// in headless --print; every stage still forbids Bash via --disallowedTools,
// because MVP never lets Claude run shell commands (design §9) — npm and podman
// are executed by Factory itself. Defense in depth is preserved by AuditFiles,
// which rejects any change to protected paths (scene/, factory-server/, .git/)
// and any declared file outside generated-apps/<slug>/.
//
// Task 3: every stage now runs with --output-format stream-json
// --include-partial-messages --verbose so the runner can parse SAFE tool-use
// events (Read/Grep/Glob/Edit/Write) into activity records as they happen,
// rather than only after the agent exits. stream-json emits one JSON object per
// line; the parser (streamClaudeEvents) ignores thinking/reasoning and every
// other hidden provider field — only tool_use + the public workLog in the final
// result become records.
// ClaudeRunMode controls the tool-permission profile and working directory for
// one claude invocation. ReadOnly grants Read/Grep/Glob only (the analysis
// stages); WorkspaceWrite additionally grants Edit/Write and runs in the
// configured WorkDir (code_generation); AttemptWrite grants Edit/Write but runs
// inside the attempt artifact directory (prototype design under design_contract).
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

func claudeModelArgs() []string {
	for _, key := range []string{"CLAUDE_CODE_MODEL", "ANTHROPIC_MODEL"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return []string{"--model", value}
		}
	}
	return nil
}

// Run writes the attempt input.json and prompt.md, then invokes the claude
// binary with stage-tightened tool permissions and captures stdout/stderr into
// the attempt artifact dir. On a non-zero exit it returns an error wrapping
// ErrRunnerExitNonzero. It does NOT validate output.json or run the file audit;
// callers do those separately. Read-only stages run in the attempt directory.
// Code generation runs in WorkDir so generated-apps/<slug> resolves against the
// configured workspace rather than the factory-server process directory. Its
// prompt carries absolute artifact paths for input/output files.
//
// Task 3: emit receives SAFE activity records parsed from the stream-json
// stdout — one activity record per tool_use (Read/Grep/Glob/Edit/Write) with a
// redacted relative path. thinking/reasoning and every other hidden provider
// field are ignored by streamClaudeEvents. A nil emit is treated as a no-op so
// tests that don't care about records can pass nil.
func (r *ClaudeRunner) Run(ctx context.Context, ws AttemptWorkspace, prompt string, inputData []byte, codegen bool, emit StepRecordEmitter) error {
	mode := ClaudeRunReadOnly
	if codegen {
		mode = ClaudeRunWorkspaceWrite
	}
	return r.RunWithMode(ctx, ws, prompt, inputData, mode, emit)
}

// RunWithMode writes the attempt input.json and prompt.md, then invokes the
// claude binary with stage-tightened tool permissions determined by mode.
// ClaudeRunReadOnly runs with Read/Grep/Glob only in the attempt directory.
// ClaudeRunWorkspaceWrite runs with Edit/Write in the configured WorkDir (code
// generation). ClaudeRunAttemptWrite runs with Edit/Write in the attempt
// artifact directory (prototype design).
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
	// Capture whatever we got, even on failure, for audit/debugging.
	_ = os.WriteFile(ws.StdoutPath(), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(ws.StderrPath(), []byte(res.Stderr), 0o644)
	for _, line := range strings.Split(res.Stderr, "\n") {
		LLMConsoleStderr(line)
	}
	for _, line := range strings.Split(res.Stdout, "\n") {
		LLMConsoleStreamLine(line)
	}
	// Even on the non-streaming path, parse the captured stdout for tool-use
	// events so records are still emitted (the stream flags are in argv, so the
	// stdout IS stream-json). This keeps the streaming-contract test honest when
	// the fake runner is a plain RunWithInput fake.
	streamClaudeEvents(ctx, emit, res.Stdout)
	if err != nil {
		return fmt.Errorf("claude run: %w", err)
	}
	if res.ExitCode != 0 {
		if !streamHasSuccessResult(res.Stdout) {
			return fmt.Errorf("claude exit %d: %w", res.ExitCode, ErrRunnerExitNonzero)
		}
		// Tolerated non-zero exit: the Claude Code CLI sometimes appends a
		// spurious trailing result error (e.g. "only prompt commands are
		// supported in streaming mode", seen with stdin-piped prompts under
		// stream-json during acceptEdits code generation) AFTER the genuine
		// success result, then exits non-zero. The streamed success result
		// proves the agent finished its work, so proceed rather than discard
		// completed output (output.json + generated files).
		LLMConsoleStderr(fmt.Sprintf("claude exited %d but a success result was streamed; tolerating spurious trailing CLI error", res.ExitCode))
	}
	if strings.TrimSpace(res.Stdout) != "" {
		if _, statErr := os.Stat(ws.OutputPath()); errors.Is(statErr, os.ErrNotExist) {
			// F2: stdout is stream-json NDJSON, not the contract. Extract the
			// final type=result event's `result` string (the agent's final public
			// answer) and write THAT. Without this, the read-only stages (plan
			// mode, cannot write output.json themselves) would get the raw stream
			// envelope and fail validation. code_generation writes its own
			// output.json so this branch is skipped via the absent-file guard.
			if out := extractStreamResult(res.Stdout); out != "" {
				_ = os.WriteFile(ws.OutputPath(), []byte(out), 0o644)
			}
		}
	}
	return nil
}

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

// streamCommandRunner is the optional interface a CommandRunner can implement to
// stream stdout/stderr line-by-line as the process runs. The OSRunner
// implements it; test fakes implement RunWithInput and fall through to the
// non-streaming path (which still parses the captured stdout for events).
type streamCommandRunner interface {
	RunStreamWithInput(ctx context.Context, dir, input string, onStdout func(string), onStderr func(string), name string, args ...string) (CommandResult, error)
}

// runStreamWithMode invokes claude via the streaming runner, forwarding each
// stdout line to streamClaudeEvents (which emits activity records for safe
// tool_use events and ignores thinking/reasoning) and each stderr line to a
// command_stderr record. stdout/stderr are also captured in full for the audit
// log + output.json fallback.
func (r *ClaudeRunner) runStreamWithMode(ctx context.Context, ws AttemptWorkspace, prompt string, mode ClaudeRunMode, emit StepRecordEmitter, sr streamCommandRunner) error {
	runDir := runDirForMode(ws, r.WorkDir, mode)
	stage := stageForMode(mode)
	args := claudeArgvForMode(mode)
	LLMConsoleRequest(stage, r.binary(), args, prompt)
	var stdoutBuf, stderrBuf strings.Builder
	onStdout := func(line string) {
		LLMConsoleStreamLine(line)
		stdoutBuf.WriteString(line)
		stdoutBuf.WriteByte('\n')
		streamClaudeEvents(ctx, emit, line)
	}
	onStderr := func(line string) {
		LLMConsoleStderr(line)
		stderrBuf.WriteString(line)
		stderrBuf.WriteByte('\n')
		_ = emit.Emit(ctx, model.ExecutionRecordCommandStderr, line)
	}
	res, err := sr.RunStreamWithInput(ctx, runDir, prompt, onStdout, onStderr, r.binary(), args...)
	if stdoutBuf.Len() > 0 && res.Stdout == "" {
		res.Stdout = stdoutBuf.String()
	}
	if stderrBuf.Len() > 0 && res.Stderr == "" {
		res.Stderr = stderrBuf.String()
	}
	_ = os.WriteFile(ws.StdoutPath(), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(ws.StderrPath(), []byte(res.Stderr), 0o644)
	if err != nil {
		return fmt.Errorf("claude run: %w", err)
	}
	if res.ExitCode != 0 {
		if !streamHasSuccessResult(res.Stdout) {
			return fmt.Errorf("claude exit %d: %w", res.ExitCode, ErrRunnerExitNonzero)
		}
		// Tolerated non-zero exit: the Claude Code CLI sometimes appends a
		// spurious trailing result error (e.g. "only prompt commands are
		// supported in streaming mode", seen with stdin-piped prompts under
		// stream-json during acceptEdits code generation) AFTER the genuine
		// success result, then exits non-zero. The streamed success result
		// proves the agent finished its work, so proceed rather than discard
		// completed output (output.json + generated files).
		LLMConsoleStderr(fmt.Sprintf("claude exited %d but a success result was streamed; tolerating spurious trailing CLI error", res.ExitCode))
	}
	if strings.TrimSpace(res.Stdout) != "" {
		if _, statErr := os.Stat(ws.OutputPath()); errors.Is(statErr, os.ErrNotExist) {
			// F2: stdout is stream-json NDJSON, not the contract. Extract the
			// final type=result event's `result` string and write THAT (see Run
			// for the full rationale).
			if out := extractStreamResult(res.Stdout); out != "" {
				_ = os.WriteFile(ws.OutputPath(), []byte(out), 0o644)
			}
		}
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

// BaselineStatus returns the set of working-tree paths git reports as changed
// BEFORE a step runs. Pass it to AuditFiles as the baseline so the audit ignores
// pre-existing dirty paths (the developer's in-progress work under protected
// prefixes) and only flags changes the agent made DURING the run. Without this,
// `git status --porcelain` reports the whole tree and any already-dirty
// protected file (e.g. cc-status/README.md, factory-server/*.go) is falsely
// blamed on every code_generation run. Returns nil on git failure or a nil
// runner — fail-open: a missing baseline degrades to the original whole-tree
// audit rather than blocking the step.
func (r *ClaudeRunner) BaselineStatus(ctx context.Context, runner CommandRunner) map[string]bool {
	if runner == nil {
		return nil
	}
	res, err := runner.Run(ctx, "", "git", "status", "--porcelain")
	if err != nil || res.ExitCode != 0 {
		return nil
	}
	return porcelainPathSet(res.Stdout)
}

// porcelainPathSet parses `git status --porcelain` stdout into the set of
// changed paths (slash-normalised). Renames contribute their whole tail.
func porcelainPathSet(stdout string) map[string]bool {
	set := make(map[string]bool)
	for _, line := range strings.Split(stdout, "\n") {
		if p := porcelainPath(line); p != "" {
			set[filepath.ToSlash(p)] = true
		}
	}
	return set
}

// AuditFiles implements the post-run audit from design §9: parse
// `git status --porcelain`, reject any change under a protected path, then
// reject any declared output file that is not under generated-apps/<slug>/ or
// .factory-runs/jobs/<jobID>/. runner is taken as a parameter (rather than
// r.Runner) so callers can pass a distinct audit-time git runner if needed; in
// practice it is the same instance.
//
// baseline is the pre-run working-tree state captured by BaselineStatus. Paths
// present in baseline are SKIPPED in the protected-path sweep — they are the
// developer's pre-existing dirty files, not changes the agent made this run, so
// flagging them is a false positive. A nil baseline preserves the original
// whole-tree behavior. Limitation: if the agent modifies a file that was
// ALREADY dirty (path in both sets), the path-match cannot distinguish the
// agent's edit from the prior change; the declaredFiles check still gates the
// agent's declared output regardless.
func (r *ClaudeRunner) AuditFiles(ctx context.Context, runner CommandRunner, jobID string, slug string, declaredFiles []string, baseline map[string]bool) error {
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
		if baseline[norm] {
			continue // pre-existing dirty, not the agent's change this run
		}
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
