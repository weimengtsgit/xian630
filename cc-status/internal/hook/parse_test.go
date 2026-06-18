package hook

import (
	"strings"
	"testing"
)

func TestParsePreToolUse(t *testing.T) {
	in := `{"hook_event_name":"PreToolUse","session_id":"abc","transcript_path":"/tmp/abc.jsonl","cwd":"/proj","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"toolu_1"}`
	e, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if e.HookEventName != "PreToolUse" {
		t.Fatalf("event = %q", e.HookEventName)
	}
	if e.ToolName != "Bash" {
		t.Fatalf("tool = %q", e.ToolName)
	}
	if got := Str(e.ToolInput, "command"); got != "npm test" {
		t.Fatalf("command = %q", got)
	}
	if e.ToolUseID != "toolu_1" {
		t.Fatalf("tool_use_id = %q", e.ToolUseID)
	}
	if len(e.Raw) == 0 {
		t.Fatal("raw payload not preserved")
	}
}

func TestParseSubagentStop(t *testing.T) {
	in := `{"hook_event_name":"SubagentStop","session_id":"abc","cwd":"/proj","permission_mode":"default","agent_id":"def","agent_type":"Explore","agent_transcript_path":"/tmp/sub.jsonl","last_assistant_message":"done","background_tasks":[{"id":"t1","type":"shell","status":"running","command":"sleep 1"}]}`
	e, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if e.AgentID != "def" || e.AgentType != "Explore" {
		t.Fatalf("agent = %q/%q", e.AgentID, e.AgentType)
	}
	if e.AgentTranscriptPath != "/tmp/sub.jsonl" {
		t.Fatalf("transcript = %q", e.AgentTranscriptPath)
	}
	if len(e.BackgroundTasks) != 1 {
		t.Fatalf("background_tasks len = %d", len(e.BackgroundTasks))
	}
	if got := Str(e.BackgroundTasks[0], "id"); got != "t1" {
		t.Fatalf("bt id = %q", got)
	}
}

func TestParsePostToolUseAgentResponse(t *testing.T) {
	in := `{"hook_event_name":"PostToolUse","session_id":"abc","tool_name":"Agent","tool_use_id":"toolu_9","tool_input":{"subagent_type":"Explore","description":"find auth"},"tool_response":{"agentId":"def","status":"completed","resolvedModel":"claude-sonnet-4","totalTokens":1234,"totalDurationMs":5000,"totalToolUseCount":7}}`
	e, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := Str(e.ToolResponse, "agentId"); got != "def" {
		t.Fatalf("agentId = %q", got)
	}
	if got := I64(e.ToolResponse, "totalTokens"); got != 1234 {
		t.Fatalf("tokens = %d", got)
	}
	if got := Str(e.ToolInput, "description"); got != "find auth" {
		t.Fatalf("description = %q", got)
	}
}

func TestParseRejectsMissingEvent(t *testing.T) {
	if _, err := Parse(strings.NewReader(`{"session_id":"abc"}`)); err == nil {
		t.Fatal("expected error for missing hook_event_name")
	}
}

func TestStrAndI64(t *testing.T) {
	m := map[string]any{"s": "x", "n": float64(42)}
	if Str(m, "s") != "x" {
		t.Fatal("Str")
	}
	if Str(nil, "missing") != "" {
		t.Fatal("Str nil")
	}
	if I64(m, "n") != 42 {
		t.Fatal("I64")
	}
	if I64(nil, "n") != 0 {
		t.Fatal("I64 nil")
	}
}
