// Package deploy contains the Podman-backed runtime: it builds container
// images for software-factory applications and runs/stops/removes the
// resulting containers. All shell-outs go through a CommandRunner interface so
// tests can substitute a fake and avoid depending on a host-installed Podman.
package deploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"

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

// CommandResult captures the outcome of one command invocation.
type CommandResult struct {
	Stdout     string
	Stderr     string
	ExitCode   int
	DurationMs int64
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

// BuildImage runs `podman build -t <repo>/<slug>:<tag> .` from the app's Path
// directory. On a non-zero exit it returns the CommandResult plus an error
// wrapping ErrRunnerFailed so callers can record image_build_failed.
func (p *Podman) BuildImage(ctx context.Context, app model.Application, tag string) (ImageRef, CommandResult, error) {
	fullName := fmt.Sprintf("%s/%s:%s", imageRepo, app.Slug, tag)
	args := []string{"build", "-t", fullName, "."}
	res, err := p.Runner.Run(ctx, app.Path, "podman", args...)
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
	suffix := id.New()[:8]
	name := fmt.Sprintf("sf-%s-%s", appSlug, suffix)
	port := fmt.Sprintf("%d:%d", hostPort, containerPort)
	args := []string{"run", "-d", "--name", name, "-p", port, image.FullName}
	res, err := p.Runner.Run(ctx, "", "podman", args...)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: podman run exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return ContainerRef{}, res, err
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
	start := time.Now()
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
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
