// Package deploy contains the Podman-backed runtime: it builds container
// images for software-factory applications and runs/stops/removes the
// resulting containers. All shell-outs go through a CommandRunner interface so
// tests can substitute a fake and avoid depending on a host-installed Podman.
package deploy

import (
	"context"
	"fmt"

	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// PodmanRuntime drives the local Podman runtime via a CommandRunner.
type PodmanRuntime struct {
	Runner CommandRunner
}

// NewPodman builds a PodmanRuntime that shells out through r.
func NewPodman(r CommandRunner) *PodmanRuntime {
	return &PodmanRuntime{Runner: r}
}

// Name returns "podman" for logging and error messages.
func (p *PodmanRuntime) Name() string {
	return "podman"
}

// imageRepo is the design-default image registry/repo prefix (§5.5).
const imageRepo = "localhost/software-factory"

// BuildImage runs `podman build -t <repo>/<slug>:<tag> .` from the app's Path
// directory. On a non-zero exit it returns the CommandResult plus an error
// wrapping ErrRunnerFailed so callers can record image_build_failed.
func (p *PodmanRuntime) BuildImage(ctx context.Context, app model.Application, tag string) (ImageRef, CommandResult, error) {
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
func (p *PodmanRuntime) RunContainer(ctx context.Context, image ImageRef, appSlug string, hostPort, containerPort int) (ContainerRef, CommandResult, error) {
	suffix := id.New()[:8]
	name := fmt.Sprintf("sf-%s-%s", appSlug, suffix)
	port := fmt.Sprintf("%d:%d", hostPort, containerPort)
	args := []string{"run", "-d", "--name", name, "-p", port, image.FullName}
	res, err := p.Runner.Run(ctx, "", "podman", args...)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: podman run exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return ContainerRef{Name: name}, res, err
	}
	return ContainerRef{Name: name}, res, nil
}

// StopContainer runs `podman stop <containerName>`.
func (p *PodmanRuntime) StopContainer(ctx context.Context, containerName string) (CommandResult, error) {
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
func (p *PodmanRuntime) RemoveContainer(ctx context.Context, containerName string) (CommandResult, error) {
	res, err := p.Runner.Run(ctx, "", "podman", "rm", containerName)
	if err != nil || res.ExitCode != 0 {
		if err == nil {
			err = fmt.Errorf("%w: podman rm exited %d", ErrRunnerFailed, res.ExitCode)
		}
		return res, err
	}
	return res, nil
}
