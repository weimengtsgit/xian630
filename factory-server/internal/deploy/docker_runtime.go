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

// BuildImage runs `docker build -t <repo>/<slug>:<tag> .` from the app's Path
// directory. On a non-zero exit it returns the CommandResult plus an error
// wrapping ErrRunnerFailed so callers can record image_build_failed.
func (d *DockerRuntime) BuildImage(ctx context.Context, app model.Application, tag string) (ImageRef, CommandResult, error) {
	fullName := fmt.Sprintf("%s/%s:%s", dockerImageRepo, app.Slug, tag)
	args := []string{"build", "-t", fullName, "."}
	res, err := d.Runner.Run(ctx, app.Path, "docker", args...)
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
	suffix := id.New()[:8]
	name := fmt.Sprintf("sf-%s-%s", appSlug, suffix)
	port := fmt.Sprintf("%d:%d", hostPort, containerPort)
	args := []string{"run", "-d", "--name", name, "-p", port, image.FullName}
	res, err := d.Runner.Run(ctx, "", "docker", args...)
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
