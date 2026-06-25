package deploy

import (
	"net"
	"strings"
	"testing"
)

func TestPodmanMachineGatewayEmptyWhenPodmanUnavailable(t *testing.T) {
	// This test assumes podman is not on PATH in the test environment (true for
	// CI and most dev machines). If podman IS available, the function may return
	// a real gateway IP, which is also acceptable.
	got := PodmanMachineGateway()
	if got != "" && net.ParseIP(got) == nil {
		t.Fatalf("PodmanMachineGateway() returned non-IP %q", got)
	}
}

func TestPodmanMachineGatewayParsesIP(t *testing.T) {
	// The function itself delegates to podman; this just documents the expected
	// output shape when podman machine returns a gateway.
	ip := PodmanMachineGateway()
	if ip == "" {
		t.Skip("podman machine not available in this environment")
	}
	if strings.TrimSpace(ip) != ip {
		t.Fatalf("PodmanMachineGateway() returned IP with surrounding whitespace: %q", ip)
	}
}
