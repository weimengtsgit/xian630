// Package deploy contains the Podman-backed runtime: it builds container
// images for software-factory applications and runs/stops/removes the
// resulting containers. All shell-outs go through a CommandRunner interface so
// tests can substitute a fake and avoid depending on a host-installed Podman.
package deploy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// ErrRunnerFailed is the sentinel error returned when an underlying command
// exits non-zero. Callers wrap it to produce app-level error codes such as
// image_build_failed / podman_run_failed.
var ErrRunnerFailed = errors.New("runner command failed")

// CommandRunner runs a named command in an optional working directory. The
// signature mirrors os/exec.CommandContext but returns a structured result so
// callers can inspect stdout/stderr/exit code without parsing.
type CommandRunner interface {
	Run(ctx context.Context, dir string, name string, args ...string) (CommandResult, error)
}

// StreamCommandRunner is the OPTIONAL streaming capability a CommandRunner may
// also satisfy. When the configured runner satisfies it, the factory steps and
// the Podman helper route commands through RunStreamWithInput so each output
// line becomes a live command_stdout/command_stderr record; when it does not
// (e.g. the test fakeCmdRunner), they fall back to the non-streaming Run path
// unchanged. OSRunner satisfies this interface in production.
type StreamCommandRunner interface {
	RunStreamWithInput(ctx context.Context, dir, input string, onStdout func(string), onStderr func(string), name string, args ...string) (CommandResult, error)
}

// CommandResult captures the outcome of one command invocation.
//
// StdoutTruncated/StderrTruncated are set true by the streaming path
// (runStreamOS) when that stream's output exceeded maxStreamTailBytes and the
// retained content is the tail (i.e. the head was discarded). They propagate to
// the factory steps so the stored command_stdout/command_stderr artifact can be
// stamped with the [TRUNCATED: ...] marker even though the retained bytes are
// exactly at the per-artifact cap. The non-streaming path leaves them false:
// its buffers are unbounded, so truncation (if any) happens later inside the
// per-artifact cap and is detected there.
type CommandResult struct {
	Stdout          string
	Stderr          string
	StdoutTruncated bool
	StderrTruncated bool
	ExitCode        int
	DurationMs      int64
}

// ImageRef identifies a built container image by its full name (registry/repo:tag).
type ImageRef struct {
	FullName string
}

// ContainerRef identifies a running or stopped container by name.
type ContainerRef struct {
	Name string
}

// Podman drives the local Podman runtime via a CommandRunner.
type Podman struct {
	Runner CommandRunner
}

// NewPodman builds a Podman that shells out through r.
func NewPodman(r CommandRunner) *Podman {
	return &Podman{Runner: r}
}

// imageRepo is the design-default image registry/repo prefix (§5.5).
const imageRepo = "localhost/software-factory"

// runWithCallbacks runs `podman <args>` (or `name <args>`) through the runner.
// When the runner satisfies StreamCommandRunner it is invoked via
// RunStreamWithInput so each stdout/stderr line is forwarded to onStdout/onStderr
// (which the factory steps wire to the command-record batcher); otherwise it
// falls back to the non-streaming Run. Either way the returned CommandResult
// carries the (tail-capped) stdout/stderr + exit code with the SAME exit-code
// semantics as Run (non-zero exit → ExitCode set, nil error), so error-code
// mapping is identical on both paths.
func (p *Podman) runWithCallbacks(ctx context.Context, dir string, onStdout, onStderr func(string), name string, args ...string) (CommandResult, error) {
	if sr, ok := p.Runner.(StreamCommandRunner); ok && (onStdout != nil || onStderr != nil) {
		return sr.RunStreamWithInput(ctx, dir, "", onStdout, onStderr, name, args...)
	}
	return p.Runner.Run(ctx, dir, name, args...)
}

// BuildImage runs `podman build -t <repo>/<slug>:<tag> .` from the app's Path
// directory. On a non-zero exit it returns the CommandResult plus an error
// wrapping ErrRunnerFailed so callers can record image_build_failed. When the
// runner is streaming-capable and callbacks are supplied, stdout/stderr lines
// are forwarded live (the podman argv stays centralized here).
func (p *Podman) BuildImage(ctx context.Context, app model.Application, tag string) (ImageRef, CommandResult, error) {
	return p.BuildImageWithCallbacks(ctx, app, tag, nil, nil)
}

// BuildImageWithCallbacks is the streaming variant of BuildImage.
func (p *Podman) BuildImageWithCallbacks(ctx context.Context, app model.Application, tag string, onStdout, onStderr func(string)) (ImageRef, CommandResult, error) {
	fullName := fmt.Sprintf("%s/%s:%s", imageRepo, app.Slug, tag)
	args := []string{"build", "-t", fullName, "."}
	res, err := p.runWithCallbacks(ctx, app.Path, onStdout, onStderr, "podman", args...)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: podman build exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return ImageRef{}, res, err
	}
	return ImageRef{FullName: fullName}, res, nil
}

// RunContainer runs `podman run -d --name sf-<slug>-<8hex> -p host:ctr <image>`.
// The 8-hex suffix is the first 8 chars of a fresh random id. It returns the
// generated container name.
func (p *Podman) RunContainer(ctx context.Context, image ImageRef, appSlug string, hostPort, containerPort int) (ContainerRef, CommandResult, error) {
	return p.RunContainerWithCallbacks(ctx, image, appSlug, hostPort, containerPort, nil, nil)
}

// RunContainerWithCallbacks is the streaming variant of RunContainer.
func (p *Podman) RunContainerWithCallbacks(ctx context.Context, image ImageRef, appSlug string, hostPort, containerPort int, onStdout, onStderr func(string)) (ContainerRef, CommandResult, error) {
	suffix := id.New()[:8]
	name := fmt.Sprintf("sf-%s-%s", appSlug, suffix)
	port := fmt.Sprintf("%d:%d", hostPort, containerPort)
	args := []string{"run", "-d", "--name", name, "-p", port, image.FullName}
	res, err := p.runWithCallbacks(ctx, "", onStdout, onStderr, "podman", args...)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: podman run exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return ContainerRef{Name: name}, res, err
	}
	return ContainerRef{Name: name}, res, nil
}

// StopContainer runs `podman stop <containerName>`.
func (p *Podman) StopContainer(ctx context.Context, containerName string) (CommandResult, error) {
	res, err := p.Runner.Run(ctx, "", "podman", "stop", containerName)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: podman stop exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return res, err
	}
	return res, nil
}

// RemoveContainer runs `podman rm <containerName>`.
func (p *Podman) RemoveContainer(ctx context.Context, containerName string) (CommandResult, error) {
	res, err := p.Runner.Run(ctx, "", "podman", "rm", containerName)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: podman rm exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return res, err
	}
	return res, nil
}

// OSRunner is the production CommandRunner backed by os/exec. It is the default
// set by server.New; tests substitute a fake.
type OSRunner struct{}

// Run executes name with args in dir (empty dir = inherit cwd). stdout and
// stderr are captured separately. The duration is measured wall-clock.
func (OSRunner) Run(ctx context.Context, dir, name string, args ...string) (CommandResult, error) {
	return runOSCommand(ctx, dir, "", name, args...)
}

// RunWithInput executes name with args and writes input to stdin.
func (OSRunner) RunWithInput(ctx context.Context, dir, input, name string, args ...string) (CommandResult, error) {
	return runOSCommand(ctx, dir, input, name, args...)
}

// RunStream executes name with args and invokes onStdoutLine as each stdout
// line arrives. It still returns the complete captured stdout/stderr so callers
// can persist exact command artifacts.
func (OSRunner) RunStream(ctx context.Context, dir, name string, onStdoutLine func(string), args ...string) (CommandResult, error) {
	return runStreamOS(ctx, dir, "", name, args, onStdoutLine, nil)
}

// RunStreamWithInput is the streaming variant that also writes input to stdin
// and forwards BOTH stdout and stderr line-by-line to callbacks. It is the path
// the factory's streaming command runner uses for npm/podman so each output
// line can become a command_stdout/command_stderr record as it happens, while
// the full (tail-capped) output is still returned for the capped artifact.
func (OSRunner) RunStreamWithInput(ctx context.Context, dir, input string, onStdout func(string), onStderr func(string), name string, args ...string) (CommandResult, error) {
	return runStreamOS(ctx, dir, input, name, args, onStdout, onStderr)
}

// streamTailBuffer is a bounded accumulator for streaming command output. It
// keeps the NEWEST maxStreamTailBytes (10 MiB) of output rather than growing
// unboundedly, because a chatty npm/podman run can emit tens of MiB and the
// capped artifact only keeps the tail anyway. Writes are UTF-8-safe: a write
// that would split a rune is deferred until the rune completes. The mutex makes
// concurrent stdout/stderr writes safe, though in practice each stream has its
// own goroutine and its own buffer.
//
// truncated records whether the head was EVER discarded to satisfy the cap.
// The retained tail is exactly maxStreamTailBytes once truncation has occurred,
// so the downstream per-artifact cap cannot detect the truncation on its own
// (len <= cap is true). Truncated() lets the factory steps stamp the
// [TRUNCATED: ...] marker + flag on the stored artifact regardless.
type streamTailBuffer struct {
	buf       []byte
	truncated bool
}

// maxStreamTailBytes caps the retained tail of one command stream. 10 MiB
// mirrors the per-artifact cap so the streaming buffer and the final capped
// artifact agree on how much history is kept.
const maxStreamTailBytes = 10 * 1024 * 1024

func newStreamTailBuffer() *streamTailBuffer { return &streamTailBuffer{} }

// Write appends data, keeping only the newest maxStreamTailBytes. When the cap
// is exceeded the head is discarded (and truncated is latched true); the trim
// lands on a UTF-8 rune boundary so the retained tail is always valid UTF-8. It
// implements io.Writer.
func (t *streamTailBuffer) Write(data []byte) (int, error) {
	t.buf = append(t.buf, data...)
	if len(t.buf) > maxStreamTailBytes {
		cut := len(t.buf) - maxStreamTailBytes
		for cut < len(t.buf) && !utf8.RuneStart(t.buf[cut]) {
			cut++
		}
		t.buf = t.buf[cut:]
		t.truncated = true
	}
	return len(data), nil
}

// Truncated reports whether the head was ever discarded to satisfy the cap.
func (t *streamTailBuffer) Truncated() bool { return t.truncated }

// String returns the retained tail.
func (t *streamTailBuffer) String() string { return string(t.buf) }

// runStreamOS is the shared streaming implementation. stdoutCB/stderrCB receive
// each line as it arrives (sans trailing newline); nil callbacks are ignored.
// The returned CommandResult.Stdout/Stderr hold the tail-capped full output.
// Exit-code semantics match Run: a non-zero exit produces ExitCode + nil error
// (so callers can map to runner_exit_nonzero / image_build_failed as before);
// other exec errors propagate.
func runStreamOS(ctx context.Context, dir, input, name string, args []string, stdoutCB, stderrCB func(string)) (CommandResult, error) {
	start := time.Now()
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return CommandResult{ExitCode: 1}, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return CommandResult{ExitCode: 1}, err
	}
	if err := cmd.Start(); err != nil {
		return CommandResult{ExitCode: 1}, err
	}

	stdoutBuf := newStreamTailBuffer()
	stderrBuf := newStreamTailBuffer()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		copyLines(stdoutPipe, stdoutBuf, stdoutCB)
	}()
	go func() {
		defer wg.Done()
		copyLines(stderrPipe, stderrBuf, stderrCB)
	}()
	runErr := cmd.Wait()
	wg.Wait()

	res := CommandResult{
		Stdout:          stdoutBuf.String(),
		Stderr:          stderrBuf.String(),
		StdoutTruncated: stdoutBuf.Truncated(),
		StderrTruncated: stderrBuf.Truncated(),
		DurationMs:      time.Since(start).Milliseconds(),
	}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	} else if runErr != nil {
		res.ExitCode = 1
	}
	if runErr != nil {
		if res.ExitCode == 0 {
			res.ExitCode = 1
		}
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return res, runErr
		}
	}
	return res, nil
}

func copyLines(r io.Reader, dst io.Writer, onLine func(string)) {
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			_, _ = dst.Write([]byte(line))
			if onLine != nil {
				onLine(strings.TrimRight(line, "\r\n"))
			}
		}
		if err != nil {
			return
		}
	}
}

func runOSCommand(ctx context.Context, dir, input, name string, args ...string) (CommandResult, error) {
	start := time.Now()
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	res := CommandResult{
		Stdout:     stdout.String(),
		Stderr:     stderr.String(),
		DurationMs: time.Since(start).Milliseconds(),
	}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	} else if runErr != nil {
		res.ExitCode = 1
	}
	// exec errors other than non-zero exit (e.g. binary not found) propagate
	// directly; non-zero exit is represented via ExitCode + nil error so callers
	// can distinguish using CommandResult.
	if runErr != nil {
		if res.ExitCode == 0 {
			res.ExitCode = 1
		}
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return res, runErr
		}
	}
	return res, nil
}
