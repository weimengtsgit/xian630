// Package model defines the domain entities the status API exposes.
//
// We model four first-class entities, matching Claude Code's runtime:
//   - Session         (a running claude CLI session)
//   - Subagent        (a dispatched Agent/Task subagent)
//   - Skill           (a Skill-tool invocation or a slash-command skill)
//   - BackgroundTask  (an entry from the /tasks background set)
package model

import "time"

// Status is the lifecycle state of a trackable entity.
type Status string

const (
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
	// StatusStale marks an entity we believe is no longer actually running but
	// for which we never observed a clean Stop event (ghost reaper).
	StatusStale Status = "stale"
)

// EntityType enumerates the entity kinds, used for filtering and events.
type EntityType string

const (
	EntitySession        EntityType = "session"
	EntitySubagent       EntityType = "subagent"
	EntitySkill          EntityType = "skill"
	EntityBackgroundTask EntityType = "background_task"
)

// Session is a Claude Code CLI session (one session_id).
type Session struct {
	ID         string     `json:"id"`
	Cwd        string     `json:"cwd,omitempty"`
	Source     string     `json:"source,omitempty"` // startup|resume|clear|compact
	Model      string     `json:"model,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	Status     Status     `json:"status"`
}

// Subagent is a dispatched subagent (Agent/Task tool).
//
// Lifecycle fields come from SubagentStart/SubagentStop hooks; the detail
// fields (Model, TotalTokens, ToolUseCount, DurationMs) are enriched from the
// PostToolUse hook on the Agent tool's tool_response.
type Subagent struct {
	ID                   string     `json:"id"`
	SessionID            string     `json:"session_id"`
	AgentID              string     `json:"agent_id"`
	AgentType            string     `json:"agent_type"`
	Description          string     `json:"description,omitempty"`
	Status               Status     `json:"status"`
	StartedAt            time.Time  `json:"started_at"`
	EndedAt              *time.Time `json:"ended_at,omitempty"`
	DurationMs           int64      `json:"duration_ms,omitempty"`
	TranscriptPath       string     `json:"transcript_path,omitempty"`
	LastAssistantMessage string     `json:"last_assistant_message,omitempty"`
	Model                string     `json:"model,omitempty"` // resolvedModel
	TotalTokens          int64      `json:"total_tokens,omitempty"`
	ToolUseCount         int64      `json:"tool_use_count,omitempty"`
	ParentToolUseID      string     `json:"parent_tool_use_id,omitempty"`
	LastSeenAt           time.Time  `json:"last_seen_at"`
}

// Skill is a Skill invocation, either via the Skill tool (source="tool") or a
// slash command detected heuristically from UserPromptSubmit (source="slash").
type Skill struct {
	ID         string     `json:"id"`
	SessionID  string     `json:"session_id"`
	AgentID    string     `json:"agent_id,omitempty"` // non-empty if invoked inside a subagent
	Name       string     `json:"name"`
	Source     string     `json:"source"` // tool | slash
	Status     Status     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	DurationMs int64      `json:"duration_ms,omitempty"`
	ToolUseID  string     `json:"tool_use_id,omitempty"`
	LastSeenAt time.Time  `json:"last_seen_at"`
}

// BackgroundTask mirrors an entry in the background_tasks[] snapshot that
// appears on Stop/SubagentStop hooks.
type BackgroundTask struct {
	ID          string    `json:"id"`
	SessionID   string    `json:"session_id"`
	TaskID      string    `json:"task_id"` // id from the snapshot
	Type        string    `json:"type,omitempty"`
	Status      string    `json:"status"` // raw status string from Claude Code
	Description string    `json:"description,omitempty"`
	Command     string    `json:"command,omitempty"`
	AgentType   string    `json:"agent_type,omitempty"`
	Tool        string    `json:"tool,omitempty"`
	Name        string    `json:"name,omitempty"`
	FirstSeenAt time.Time `json:"first_seen_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
}

// RunningSnapshot is the aggregate view returned by GET /running.
type RunningSnapshot struct {
	Sessions        []Session        `json:"sessions"`
	Subagents       []Subagent       `json:"subagents"`
	Skills          []Skill          `json:"skills"`
	BackgroundTasks []BackgroundTask `json:"background_tasks"`
}

// EventRow is one entry from the raw event append-log (used for SSE history).
type EventRow struct {
	Seq           int64     `json:"seq"`
	Ts            time.Time `json:"ts"`
	SessionID     string    `json:"session_id,omitempty"`
	HookEventName string    `json:"hook_event_name"`
}
