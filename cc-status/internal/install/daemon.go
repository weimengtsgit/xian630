package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
)

const label = "com.weimengtsgit.cc-status"

// DaemonPaths returns the unit/plist path and the platform label used.
func DaemonPaths() (path string, lab string) {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "LaunchAgents", label+".plist"), label
	default: // linux and friends: systemd user unit
		return filepath.Join(home, ".config", "systemd", "user", "cc-status.service"), "cc-status"
	}
}

// logPaths returns stdout/stderr log paths under ~/.cc-status.
func logPaths() (string, string) {
	home, _ := os.UserHomeDir()
	base := filepath.Join(home, ".cc-status")
	return filepath.Join(base, "cc-status.out.log"), filepath.Join(base, "cc-status.err.log")
}

// InstallDaemon writes the daemon unit/plist and starts it. Best-effort: if the
// service manager command is missing, the file is still written and the error
// is returned for the caller to report.
func InstallDaemon(binaryPath string) error {
	path, lab := DaemonPaths()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var content string
	switch runtime.GOOS {
	case "darwin":
		content = darwinPlist(binaryPath)
	default:
		content = linuxUnit(binaryPath)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return err
	}

	switch runtime.GOOS {
	case "darwin":
		uid := strconv.Itoa(os.Getuid())
		// Unload any previous instance, then bootstrap.
		_, _ = exec.Command("launchctl", "bootout", "gui/"+uid+"/"+lab).CombinedOutput()
		if out, err := exec.Command("launchctl", "bootstrap", "gui/"+uid, path).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl bootstrap failed: %w\n%s", err, out)
		}
	default:
		if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl daemon-reload: %w\n%s", err, out)
		}
		if out, err := exec.Command("systemctl", "--user", "enable", "--now", lab).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl enable --now: %w\n%s", err, out)
		}
	}
	return nil
}

// UninstallDaemon stops and removes the daemon unit/plist.
func UninstallDaemon() error {
	_, lab := DaemonPaths()
	switch runtime.GOOS {
	case "darwin":
		uid := strconv.Itoa(os.Getuid())
		_, _ = exec.Command("launchctl", "bootout", "gui/"+uid+"/"+lab).CombinedOutput()
	default:
		_, _ = exec.Command("systemctl", "--user", "disable", "--now", lab).CombinedOutput()
	}
	path, _ := DaemonPaths()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func darwinPlist(binaryPath string) string {
	outLog, errLog := logPaths()
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, label, binaryPath, outLog, errLog)
}

func linuxUnit(binaryPath string) string {
	return fmt.Sprintf(`[Unit]
Description=cc-status (Claude Code status API)
After=network.target

[Service]
ExecStart=%s serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, binaryPath)
}
