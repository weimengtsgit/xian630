// Package deploy contains the Docker-backed runtime: it builds container
// images for software-factory applications and runs/stops/removes the
// resulting containers. All shell-outs go through a CommandRunner interface so
// tests can substitute a fake and avoid depending on a host-installed Docker.
package deploy

import (
	"context"
	"fmt"

	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// imageRepo is the design-default image registry/repo prefix (§5.5).
const dockerImageRepo = "localhost/software-factory"

// DockerRuntime drives the local Docker runtime via a CommandRunner.
type DockerRuntime struct {
	Runner CommandRunner
}

// NewDocker builds a DockerRuntime that shells out through r.
func NewDocker(r CommandRunner) *DockerRuntime {
	return &DockerRuntime{Runner: r}
}

// Name returns "docker" for logging and error messages.
func (d *DockerRuntime) Name() string {
	return "docker"
}

// runWithCallbacks runs `docker <args>` (or `name <args>`) through the runner.
// When the runner satisfies StreamCommandRunner it is invoked via
// RunStreamWithInput so each stdout/stderr line is forwarded to onStdout/onStderr
// (which the factory steps wire to the command-record batcher); otherwise it
// falls back to the non-streaming Run. Either way the returned CommandResult
// carries the (tail-capped) stdout/stderr + exit code with the SAME exit-code
// semantics as Run (non-zero exit → ExitCode set, nil error), so error-code
// mapping is identical on both paths.
func (d *DockerRuntime) runWithCallbacks(ctx context.Context, dir string, onStdout, onStderr func(string), name string, args ...string) (CommandResult, error) {
	if sr, ok := d.Runner.(StreamCommandRunner); ok && (onStdout != nil || onStderr != nil) {
		return sr.RunStreamWithInput(ctx, dir, "", onStdout, onStderr, name, args...)
	}
	return d.Runner.Run(ctx, dir, name, args...)
}

// BuildImage runs `docker build -t <repo>/<slug>:<tag> .` from the app's Path
// directory. On a non-zero exit it returns the CommandResult plus an error
// wrapping ErrRunnerFailed so callers can record image_build_failed. When the
// runner is streaming-capable and callbacks are supplied, stdout/stderr lines
// are forwarded live (the docker argv stays centralized here).
func (d *DockerRuntime) BuildImage(ctx context.Context, app model.Application, tag string) (ImageRef, CommandResult, error) {
	return d.BuildImageWithCallbacks(ctx, app, tag, nil, nil)
}

// BuildImageWithCallbacks is the streaming variant of BuildImage.
func (d *DockerRuntime) BuildImageWithCallbacks(ctx context.Context, app model.Application, tag string, onStdout, onStderr func(string)) (ImageRef, CommandResult, error) {
	fullName := fmt.Sprintf("%s/%s:%s", dockerImageRepo, app.Slug, tag)
	args := []string{"build", "-t", fullName, "."}
	res, err := d.runWithCallbacks(ctx, app.Path, onStdout, onStderr, "docker", args...)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: docker build exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return ImageRef{}, res, err
	}
	return ImageRef{FullName: fullName}, res, nil
}

// RunContainer runs `docker run -d --name sf-<slug>-<8hex> -p host:ctr <image>`.
// The 8-hex suffix is the first 8 chars of a fresh random id. It returns the
// generated container name.
func (d *DockerRuntime) RunContainer(ctx context.Context, image ImageRef, appSlug string, hostPort, containerPort int) (ContainerRef, CommandResult, error) {
	return d.RunContainerWithCallbacks(ctx, image, appSlug, hostPort, containerPort, nil, nil)
}

// RunContainerWithCallbacks is the streaming variant of RunContainer.
func (d *DockerRuntime) RunContainerWithCallbacks(ctx context.Context, image ImageRef, appSlug string, hostPort, containerPort int, onStdout, onStderr func(string)) (ContainerRef, CommandResult, error) {
	suffix := id.New()[:8]
	name := fmt.Sprintf("sf-%s-%s", appSlug, suffix)
	port := fmt.Sprintf("%d:%d", hostPort, containerPort)
	args := []string{"run", "-d", "--name", name, "-p", port, image.FullName}
	res, err := d.runWithCallbacks(ctx, "", onStdout, onStderr, "docker", args...)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: docker run exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return ContainerRef{Name: name}, res, err
	}
	return ContainerRef{Name: name}, res, nil
}

// StopContainer runs `docker stop <containerName>`.
func (d *DockerRuntime) StopContainer(ctx context.Context, containerName string) (CommandResult, error) {
	res, err := d.Runner.Run(ctx, "", "docker", "stop", containerName)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: docker stop exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return res, err
	}
	return res, nil
}

// RemoveContainer runs `docker rm <containerName>`.
func (d *DockerRuntime) RemoveContainer(ctx context.Context, containerName string) (CommandResult, error) {
	res, err := d.Runner.Run(ctx, "", "docker", "rm", containerName)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: docker rm exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return res, err
	}
	return res, nil
}
