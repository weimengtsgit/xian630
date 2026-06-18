// Package hook parses Claude Code hook stdin payloads (the observational
// hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart,
// SubagentStop, Stop) and reports them to the cc-status server.
//
// Field names follow the verified Claude Code hook input schema.
// See: https://code.claude.com/docs/en/hooks.md
package hook

import (
	"encoding/json"
	"fmt"
	"io"
)

// Event is a superset of every Claude Code hook input payload. Unknown fields
// are ignored; callers switch on HookEventName. Field names mirror the hook
// input JSON exactly.
type Event struct {
	HookEventName string `json:"hook_event_name"`

	// Common fields present on (almost) every event.
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	Cwd            string `json:"cwd"`
	PermissionMode string `json:"permission_mode"`
	AgentID        string `json:"agent_id,omitempty"`   // only inside a subagent
	AgentType      string `json:"agent_type,omitempty"` // --agent or inside subagent

	// SessionStart.
	Source       string `json:"source,omitempty"` // startup|resume|clear|compact
	Model        string `json:"model,omitempty"`
	SessionTitle string `json:"session_title,omitempty"`

	// UserPromptSubmit.
	Prompt string `json:"prompt,omitempty"`

	// PreToolUse / PostToolUse.
	ToolName     string         `json:"tool_name,omitempty"`
	ToolInput    map[string]any `json:"tool_input,omitempty"`
	ToolResponse map[string]any `json:"tool_response,omitempty"`
	ToolUseID    string         `json:"tool_use_id,omitempty"`
	DurationMs   int64          `json:"duration_ms,omitempty"`

	// SubagentStop / Stop.
	StopHookActive       bool             `json:"stop_hook_active,omitempty"`
	AgentTranscriptPath  string           `json:"agent_transcript_path,omitempty"`
	LastAssistantMessage string           `json:"last_assistant_message,omitempty"`
	BackgroundTasks      []map[string]any `json:"background_tasks,omitempty"`
	SessionCrons         []map[string]any `json:"session_crons,omitempty"`

	// Raw is the original payload bytes, preserved for the append-log / SSE.
	Raw json.RawMessage `json:"-"`
}

// Parse reads one JSON hook payload from r.
func Parse(r io.Reader) (*Event, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read stdin: %w", err)
	}
	var e Event
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("decode hook json: %w", err)
	}
	e.Raw = raw
	if e.HookEventName == "" {
		return nil, fmt.Errorf("missing hook_event_name")
	}
	return &e, nil
}

// Str returns a string field from a map, tolerating non-string JSON values.
func Str(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, ok := m[key]
	if !ok {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// I64 returns an int64 field from a map (JSON numbers decode to float64).
func I64(m map[string]any, key string) int64 {
	if m == nil {
		return 0
	}
	switch t := m[key].(type) {
	case float64:
		return int64(t)
	case int:
		return int64(t)
	case int64:
		return t
	default:
		return 0
	}
}
