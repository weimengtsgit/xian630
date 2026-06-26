package deploy

import (
	"encoding/json"
	"net"
	"os/exec"
	"strings"
)

// PodmanMachineGateway returns the gateway IP of the default podman machine
// when published container ports are reachable via that gateway rather than
// 127.0.0.1. It returns an empty string when podman machine is unavailable,
// uses user-mode networking (where ports are reachable on 127.0.0.1), or has
// no usable gateway.
func PodmanMachineGateway() string {
	// Inspect the machine once. Newer versions include NetworkSettings.Gateway;
	// older versions include UserModeNetworking. When user-mode networking is
	// enabled, gvproxy forwards published ports to the host's localhost, so the
	// gateway IP must NOT be used for health checks.
	out, err := exec.Command("podman", "machine", "inspect").Output()
	if err != nil {
		return ""
	}
	var infos []struct {
		NetworkSettings *struct {
			Gateway string `json:"Gateway"`
		} `json:"NetworkSettings"`
		UserModeNetworking bool `json:"UserModeNetworking"`
	}
	if err := json.Unmarshal(out, &infos); err != nil || len(infos) == 0 {
		return ""
	}
	info := infos[0]
	if info.UserModeNetworking {
		return ""
	}
	if info.NetworkSettings != nil {
		ip := strings.TrimSpace(info.NetworkSettings.Gateway)
		if net.ParseIP(ip) != nil {
			return ip
		}
	}

	// Older versions without NetworkSettings but also without user-mode
	// networking: derive the gateway from the VM's default route.
	out, err = exec.Command("podman", "machine", "ssh", "--", "ip", "-json", "route", "get", "1.1.1.1").Output()
	if err == nil {
		var routes []struct {
			Gateway string `json:"gateway"`
		}
		if json.Unmarshal(out, &routes) == nil && len(routes) > 0 {
			ip := strings.TrimSpace(routes[0].Gateway)
			if net.ParseIP(ip) != nil {
				return ip
			}
		}
	}

	return ""
}
