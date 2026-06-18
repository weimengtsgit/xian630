package install

import "testing"

func TestInstallUninstallHooksIdempotent(t *testing.T) {
	bin := "/x/cc-status"
	settings := map[string]any{}

	if !InstallHooks(settings, bin) {
		t.Fatal("first install should report a change")
	}
	if InstallHooks(settings, bin) {
		t.Fatal("second install should be a no-op")
	}
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks map missing")
	}
	if len(hooks) != len(ObservedEvents) {
		t.Fatalf("event count = %d, want %d", len(hooks), len(ObservedEvents))
	}

	if !UninstallHooks(settings, bin) {
		t.Fatal("uninstall should report a change")
	}
	if _, ok := settings["hooks"]; ok {
		t.Fatal("hooks key should be removed after uninstall")
	}
	if UninstallHooks(settings, bin) {
		t.Fatal("second uninstall should be a no-op")
	}
}

func TestInstallPreservesExistingHooks(t *testing.T) {
	bin := "/x/cc-status"
	settings := map[string]any{"hooks": map[string]any{
		"PreToolUse": []any{
			map[string]any{"matcher": "Bash", "hooks": []any{map[string]any{"type": "command", "command": "/usr/bin/true"}}},
		},
	}}

	InstallHooks(settings, bin)
	groups := settings["hooks"].(map[string]any)["PreToolUse"].([]any)
	if len(groups) != 2 {
		t.Fatalf("expected 2 PreToolUse groups (existing + ours), got %d", len(groups))
	}

	// Uninstall removes only our group, leaving the user's Bash hook intact.
	UninstallHooks(settings, bin)
	groups = settings["hooks"].(map[string]any)["PreToolUse"].([]any)
	if len(groups) != 1 {
		t.Fatalf("expected existing hook preserved, got %d groups", len(groups))
	}
}

func TestOurHandlerShape(t *testing.T) {
	h := ourHandler("/path/to/cc-status")
	if h["type"] != "command" {
		t.Errorf("type = %v", h["type"])
	}
	if h["command"] != "/path/to/cc-status" {
		t.Errorf("command = %v", h["command"])
	}
	args, ok := h["args"].([]any)
	if !ok || len(args) != 1 || args[0] != "hook" {
		t.Errorf("args = %v", h["args"])
	}
}
