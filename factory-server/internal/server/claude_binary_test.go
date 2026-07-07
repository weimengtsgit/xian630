package server

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveClaudeBinaryUsesEnvOverride(t *testing.T) {
	got := resolveClaudeBinaryWith(
		func(key string) string {
			if key == "FACTORY_CLAUDE_BINARY" {
				return `C:\tools\claude.exe`
			}
			return ""
		},
		nil,
		nil,
		"windows",
	)

	if got != `C:\tools\claude.exe` {
		t.Fatalf("binary = %q, want env override", got)
	}
}

func TestResolveClaudeBinaryFindsWindowsNPMExe(t *testing.T) {
	wrapper := filepath.Join(`C:\Users\PC\AppData\Roaming\npm`, "claude.cmd")
	want := filepath.Join(
		filepath.Dir(wrapper),
		"node_modules",
		"@anthropic-ai",
		"claude-code",
		"bin",
		"claude.exe",
	)

	got := resolveClaudeBinaryWith(
		func(string) string { return "" },
		func(name string) (string, error) {
			if name == "claude.cmd" {
				return wrapper, nil
			}
			return "", errors.New("not found")
		},
		func(path string) (os.FileInfo, error) {
			if path == want {
				return nil, nil
			}
			return nil, errors.New("not found")
		},
		"windows",
	)

	if got != want {
		t.Fatalf("binary = %q, want %q", got, want)
	}
}

func TestResolveClaudeBinaryFallsBackToClaude(t *testing.T) {
	got := resolveClaudeBinaryWith(
		func(string) string { return "" },
		func(string) (string, error) { return "", errors.New("not found") },
		func(string) (os.FileInfo, error) { return nil, errors.New("not found") },
		"windows",
	)

	if got != "claude" {
		t.Fatalf("binary = %q, want claude", got)
	}
}
