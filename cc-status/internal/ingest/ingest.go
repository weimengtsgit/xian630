// Package ingest translates hook events into store mutations and SSE
// notifications. It is the only place that knows how a raw hook payload maps
// onto the four entity lifecycle states.
package ingest

import (
	"time"

	"github.com/weimengtsgit/xian630/cc-status/internal/hook"
	"github.com/weimengtsgit/xian630/cc-status/internal/model"
	"github.com/weimengtsgit/xian630/cc-status/internal/skills"
	"github.com/weimengtsgit/xian630/cc-status/internal/store"
)

// Publish is invoked after an event is persisted, to fan-out to SSE clients.
// Implementations must be safe to call from the ingest hot path.
type Publish func(seq int64, e *hook.Event)

// Ingest applies hook events to the store.
type Ingest struct {
	Store   *store.Store
	Skills  *skills.Scanner
	Publish Publish
}

// Handle processes one hook event: appends the raw payload, applies lifecycle
// mutations, then publishes the sequence number for live clients.
func (ig *Ingest) Handle(e *hook.Event) error {
	now := time.Now()

	seq, err := ig.Store.AppendEvent(e.SessionID, e.HookEventName, e.Raw)
	if err != nil {
		return err
	}

	switch e.HookEventName {
	case "SessionStart":
		_ = ig.Store.UpsertSession(model.Session{
			ID:         e.SessionID,
			Cwd:        e.Cwd,
			Source:     e.Source,
			Model:      e.Model,
			StartedAt:  now,
			LastSeenAt: now,
			Status:     model.StatusRunning,
		})

	case "SessionEnd":
		_ = ig.Store.EndSession(e.SessionID, now)

	case "UserPromptSubmit":
		_ = ig.Store.TouchSession(e.SessionID, now)
		if name, ok := ig.Skills.MatchSlash(e.Prompt); ok {
			_ = ig.Store.StartSkill(model.Skill{
				SessionID: e.SessionID,
				Name:      name,
				Source:    "slash",
				StartedAt: now, LastSeenAt: now,
			})
		}

	case "PreToolUse":
		_ = ig.Store.TouchSession(e.SessionID, now)
		if e.ToolName == "Skill" {
			name := hook.Str(e.ToolInput, "name")
			if name == "" {
				name = "(skill)"
			}
			_ = ig.Store.StartSkill(model.Skill{
				ID:         e.ToolUseID,
				SessionID:  e.SessionID,
				AgentID:    e.AgentID,
				Name:       name,
				Source:     "tool",
				StartedAt:  now,
				LastSeenAt: now,
				ToolUseID:  e.ToolUseID,
			})
		}

	case "PostToolUse":
		_ = ig.Store.TouchSession(e.SessionID, now)
		switch e.ToolName {
		case "Skill":
			_ = ig.Store.StopSkill(e.ToolUseID, now, e.DurationMs)
		case "Agent":
			ig.enrichAgent(e)
		}

	case "SubagentStart":
		_ = ig.Store.TouchSession(e.SessionID, now)
		_ = ig.Store.StartSubagent(model.Subagent{
			ID:         e.AgentID,
			SessionID:  e.SessionID,
			AgentID:    e.AgentID,
			AgentType:  e.AgentType,
			StartedAt:  now,
			LastSeenAt: now,
		})

	case "SubagentStop":
		_ = ig.Store.StopSubagent(e.AgentID, now, e.LastAssistantMessage, e.AgentTranscriptPath)
		ig.syncBackgroundTasks(e.SessionID, e.BackgroundTasks, now)

	case "Stop":
		_ = ig.Store.TouchSession(e.SessionID, now)
		_ = ig.Store.CloseOpenSlashSkills(e.SessionID, now)
		ig.syncBackgroundTasks(e.SessionID, e.BackgroundTasks, now)
	}

	if ig.Publish != nil {
		ig.Publish(seq, e)
	}
	return nil
}

// enrichAgent merges PostToolUse(Agent) tool_response details into the subagent
// identified by tool_response.agentId.
func (ig *Ingest) enrichAgent(e *hook.Event) {
	agentID := hook.Str(e.ToolResponse, "agentId")
	if agentID == "" {
		return
	}
	desc := hook.Str(e.ToolInput, "description")
	if desc == "" {
		desc = hook.Str(e.ToolInput, "prompt")
	}
	_ = ig.Store.EnrichSubagent(agentID,
		hook.Str(e.ToolResponse, "resolvedModel"),
		hook.I64(e.ToolResponse, "totalTokens"),
		hook.I64(e.ToolResponse, "totalToolUseCount"),
		hook.I64(e.ToolResponse, "totalDurationMs"),
		desc,
	)
}

func (ig *Ingest) syncBackgroundTasks(sessionID string, tasks []map[string]any, now time.Time) {
	bts := make([]model.BackgroundTask, 0, len(tasks))
	for _, t := range tasks {
		id := hook.Str(t, "id")
		if id == "" {
			continue
		}
		bts = append(bts, model.BackgroundTask{
			TaskID:      id,
			Type:        hook.Str(t, "type"),
			Status:      hook.Str(t, "status"),
			Description: hook.Str(t, "description"),
			Command:     hook.Str(t, "command"),
			AgentType:   hook.Str(t, "agent_type"),
			Tool:        hook.Str(t, "tool"),
			Name:        hook.Str(t, "name"),
		})
	}
	_ = ig.Store.SyncBackgroundTasks(sessionID, bts, now)
}
