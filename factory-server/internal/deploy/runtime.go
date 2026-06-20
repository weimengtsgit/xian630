// Package deploy contains container runtime abstractions for building and
// running containers. It supports both Podman and Docker as interchangeable
// backends, selected via configuration.
package deploy

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// ErrRunnerFailed is the sentinel error returned when an underlying command
// exits non-zero. Callers wrap it to produce app-level error codes such as
// image_build_failed / container_run_failed.
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

// ContainerRuntime defines the interface for container runtime operations.
// Both Podman and Docker implement this interface, allowing the factory
// server to work with either runtime transparently.
type ContainerRuntime interface {
	// BuildImage builds a container image for the application with the given tag.
	// The image is built from the application's Path directory using a Dockerfile.
	BuildImage(ctx context.Context, app model.Application, tag string) (ImageRef, CommandResult, error)

	// RunContainer runs a container from the image with port mapping.
	// The container is named using the appSlug plus a random suffix.
	RunContainer(ctx context.Context, image ImageRef, appSlug string, hostPort, containerPort int) (ContainerRef, CommandResult, error)

	// StopContainer stops a running container.
	StopContainer(ctx context.Context, containerName string) (CommandResult, error)

	// RemoveContainer removes a stopped container.
	RemoveContainer(ctx context.Context, containerName string) (CommandResult, error)

	// Name returns the runtime name for logging and error messages.
	Name() string
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
