package deploy

import (
	"os"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
)

// TestRuntimeConfigSelection verifies that the FACTORY_CONTAINER_RUNTIME
// environment variable correctly selects the container runtime.
func TestRuntimeConfigSelection(t *testing.T) {
	tests := []struct {
		name     string
		envValue string
		want     string
	}{
		{"default (empty)", "", "podman"},
		{"explicit podman", "podman", "podman"},
		{"explicit docker", "docker", "docker"},
		{"uppercase PODMAN", "PODMAN", "podman"},
		{"uppercase DOCKER", "DOCKER", "docker"},
		{"mixed case Docker", "Docker", "docker"},
		{"mixed case PodMan", "PodMan", "podman"},
		{"invalid value falls back to podman", "containerd", "podman"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set environment variable
			if tt.envValue != "" {
				os.Setenv("FACTORY_CONTAINER_RUNTIME", tt.envValue)
			} else {
				os.Unsetenv("FACTORY_CONTAINER_RUNTIME")
			}
			defer os.Unsetenv("FACTORY_CONTAINER_RUNTIME")

			// Resolve config with a custom getenv that reads from our test env
			cfg := config.Resolve(os.Getenv)

			if cfg.ContainerRuntime != tt.want {
				t.Errorf("ContainerRuntime = %q, want %q", cfg.ContainerRuntime, tt.want)
			}
		})
	}
}

// TestRuntimeFactory verifies that NewPodman and NewDocker produce
// valid ContainerRuntime implementations.
func TestRuntimeFactory(t *testing.T) {
	runner := &OSRunner{}

	podman := NewPodman(runner)
	if podman == nil {
		t.Fatal("NewPodman returned nil")
	}
	if podman.Name() != "podman" {
		t.Errorf("podman.Name() = %q, want podman", podman.Name())
	}

	docker := NewDocker(runner)
	if docker == nil {
		t.Fatal("NewDocker returned nil")
	}
	if docker.Name() != "docker" {
		t.Errorf("docker.Name() = %q, want docker", docker.Name())
	}
}
