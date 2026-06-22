// Package deploy contains container runtime abstractions for building and
// running containers. It supports both Podman and Docker as interchangeable
// backends, selected via configuration.
package deploy

import (
	"context"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

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
