package deploy

import (
	"testing"
)

func TestRuntimeInterface(t *testing.T) {
	// Verify that both Podman and Docker implement the ContainerRuntime interface.
	var r ContainerRuntime

	// Podman implements ContainerRuntime
	r = NewPodman(&OSRunner{})
	if r.Name() != "podman" {
		t.Errorf("Podman name = %q, want podman", r.Name())
	}

	// Docker implements ContainerRuntime
	r = NewDocker(&OSRunner{})
	if r.Name() != "docker" {
		t.Errorf("Docker name = %q, want docker", r.Name())
	}
}
