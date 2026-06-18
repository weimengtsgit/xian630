// Package install wires cc-status into Claude Code by injecting observational
// hooks into settings.json, and (optionally) installs a launchd/systemd
// LaunchAgent to keep the server alive. All operations are idempotent and
// preserve the user's existing settings.
package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// hookEvents lists the hook events we register, with an optional tool matcher.
type hookEvent struct {
	Event   string
	Matcher string // empty = match all
}

// ObservedEvents is the set of hooks cc-status registers. We only hook the
// bounded lifecycle events (not every tool call) to keep per-event process
// spawns low.
var ObservedEvents = []hookEvent{
	{Event: "SessionStart"},
	{Event: "SessionEnd"},
	{Event: "UserPromptSubmit"},
	{Event: "Stop"},
	{Event: "SubagentStart"},
	{Event: "SubagentStop"},
	{Event: "PreToolUse", Matcher: "Skill"},
	{Event: "PostToolUse", Matcher: "Skill|Agent"},
}

// SettingsPath returns the settings.json path for the given scope.
func SettingsPath(project bool) (string, error) {
	if project {
		p, err := filepath.Abs(filepath.Join(".claude", "settings.json"))
		return p, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// LoadSettings reads settings.json (returning an empty map if absent).
func LoadSettings(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

// SaveSettings writes settings.json with stable 2-space indentation.
func SaveSettings(path string, m map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}

// ourHandler builds the hook command handler pointing at binaryPath.
func ourHandler(binaryPath string) map[string]any {
	return map[string]any{
		"type":    "command",
		"command": binaryPath,
		"args":    []any{"hook"},
		"timeout": 10,
	}
}

// isOurs reports whether a handler object is one we installed for binaryPath.
func isOurs(handler any, binaryPath string) bool {
	h, ok := handler.(map[string]any)
	if !ok {
		return false
	}
	cmd, _ := h["command"].(string)
	return cmd == binaryPath
}

// InstallHooks adds our handlers for every observed event. Returns true if the
// settings map changed.
func InstallHooks(settings map[string]any, binaryPath string) bool {
	hooksAny, ok := settings["hooks"]
	var hooks map[string]any
	if ok {
		if m, ok := hooksAny.(map[string]any); ok {
			hooks = m
		}
	}
	if hooks == nil {
		hooks = map[string]any{}
	}

	changed := false
	for _, ev := range ObservedEvents {
		groupsAny, _ := hooks[ev.Event].([]any)
		// Skip if our handler is already present in any group.
		if hasOurHandler(groupsAny, binaryPath) {
			continue
		}
		group := map[string]any{
			"hooks": []any{ourHandler(binaryPath)},
		}
		if ev.Matcher != "" {
			group["matcher"] = ev.Matcher
		}
		groupsAny = append(groupsAny, group)
		hooks[ev.Event] = groupsAny
		changed = true
	}
	if changed {
		settings["hooks"] = hooks
	}
	return changed
}

func hasOurHandler(groups []any, binaryPath string) bool {
	for _, g := range groups {
		gm, ok := g.(map[string]any)
		if !ok {
			continue
		}
		hs, _ := gm["hooks"].([]any)
		for _, h := range hs {
			if isOurs(h, binaryPath) {
				return true
			}
		}
	}
	return false
}

// UninstallHooks removes our handlers for binaryPath. Returns true if changed.
func UninstallHooks(settings map[string]any, binaryPath string) bool {
	hooksAny, ok := settings["hooks"]
	if !ok {
		return false
	}
	hooks, ok := hooksAny.(map[string]any)
	if !ok {
		return false
	}
	changed := false
	for _, ev := range ObservedEvents {
		groupsAny, _ := hooks[ev.Event].([]any)
		if groupsAny == nil {
			continue
		}
		filtered := groupsAny[:0:0]
		removed := false
		for _, g := range groupsAny {
			gm, ok := g.(map[string]any)
			if !ok {
				filtered = append(filtered, g)
				continue
			}
			hs, _ := gm["hooks"].([]any)
			kept := hs[:0:0]
			for _, h := range hs {
				if isOurs(h, binaryPath) {
					removed = true
					continue
				}
				kept = append(kept, h)
			}
			if len(kept) == 0 && len(hs) > 0 {
				removed = true
				continue
			}
			if len(kept) != len(hs) {
				gm["hooks"] = kept
			}
			filtered = append(filtered, g)
		}
		if removed {
			changed = true
			if len(filtered) == 0 {
				delete(hooks, ev.Event)
			} else {
				hooks[ev.Event] = filtered
			}
		}
	}
	if len(hooks) == 0 {
		delete(settings, "hooks")
	} else {
		settings["hooks"] = hooks
	}
	return changed
}

// SortedEventNames returns observed event names sorted (for diagnostics).
func SortedEventNames() []string {
	out := make([]string, 0, len(ObservedEvents))
	for _, e := range ObservedEvents {
		out = append(out, e.Event)
	}
	sort.Strings(out)
	return out
}
