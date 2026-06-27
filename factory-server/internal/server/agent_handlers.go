package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// listAgents handles GET /api/agents — returns every known agent ordered by
// sort_order ascending.
func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListAgents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list agents")
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

type agentCreateBody struct {
	Key             string `json:"key"`
	Name            string `json:"name"`
	Role            string `json:"role"`
	Description     string `json:"description"`
	ClaudeAgentName string `json:"claude_agent_name"`
	SkillsJSON      string `json:"skills_json"`
	Category        string `json:"category"`
	Prompt          string `json:"prompt"`
	Enabled         *bool  `json:"enabled"`
}

// createAgent handles POST /api/agents. It appends user-defined agents after
// the seeded default registry and rejects duplicates instead of overwriting.
func (s *Server) createAgent(w http.ResponseWriter, r *http.Request) {
	var body agentCreateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}

	key := strings.TrimSpace(body.Key)
	name := strings.TrimSpace(body.Name)
	role := strings.TrimSpace(body.Role)
	if key == "" || name == "" || role == "" {
		writeError(w, http.StatusBadRequest, "key, name, and role are required")
		return
	}

	skillsJSON := strings.TrimSpace(body.SkillsJSON)
	if skillsJSON == "" {
		skillsJSON = "[]"
	}
	if !json.Valid([]byte(skillsJSON)) {
		writeError(w, http.StatusBadRequest, "skills_json must be valid json")
		return
	}

	// Manual agent creation is intentionally restrictive: the software-
	// development category is owned by the registry-seeded collaboration
	// pipeline agents, so a manually-created agent cannot claim it; a
	// business-processing agent must carry a non-empty system prompt. The normal
	// creator of business agents is the dialogue confirmation path, not the
	// browser.
	category := model.AgentCategoryBusinessProcessing
	if c := strings.TrimSpace(body.Category); c != "" {
		category = model.AgentCategory(c)
	}
	prompt := strings.TrimSpace(body.Prompt)
	switch category {
	case model.AgentCategorySoftwareDevelopment:
		writeError(w, http.StatusBadRequest, "software_development category is reserved for pipeline agents")
		return
	case model.AgentCategoryBusinessProcessing:
		if prompt == "" {
			writeError(w, http.StatusBadRequest, "business_processing agents require a non-empty prompt")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "category must be software_development or business_processing")
		return
	}

	existing, err := s.store.ListAgents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list agents")
		return
	}
	id := agentIDFromKey(key)
	sortOrder := 1
	for _, agent := range existing {
		if agent.SortOrder >= sortOrder {
			sortOrder = agent.SortOrder + 1
		}
		if agent.ID == id || agent.Key == key {
			writeError(w, http.StatusConflict, "agent already exists")
			return
		}
	}

	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	claudeAgentName := strings.TrimSpace(body.ClaudeAgentName)
	if claudeAgentName == "" {
		claudeAgentName = key
	}

	agent := model.Agent{
		ID:              id,
		Key:             key,
		Name:            name,
		Role:            role,
		Description:     strings.TrimSpace(body.Description),
		ClaudeAgentName: claudeAgentName,
		SkillsJSON:      skillsJSON,
		Category:        category,
		Prompt:          prompt,
		Enabled:         enabled,
		SortOrder:       sortOrder,
	}
	if err := s.store.CreateAgent(r.Context(), agent); err != nil {
		writeError(w, http.StatusInternalServerError, "create agent")
		return
	}
	writeJSON(w, http.StatusCreated, agent)
}

func agentIDFromKey(key string) string {
	var b strings.Builder
	b.WriteString("agent_")
	lastUnderscore := false
	for _, r := range strings.ToLower(key) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastUnderscore = false
		case !lastUnderscore:
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	return strings.TrimRight(b.String(), "_")
}

// agentPatchBody is the subset of the Agent resource that PATCH /api/agents/:id
// accepts. Unknown fields are ignored by the decoder.
type agentPatchBody struct {
	Enabled *bool `json:"enabled"`
}

// updateAgent handles PATCH /api/agents/:id — currently only the enabled flag
// is mutable. A malformed body is a 400; an unknown id is a 404 (checked after
// the update so SetAgentEnabled's idempotent no-op-on-miss is safe).
func (s *Server) updateAgent(w http.ResponseWriter, r *http.Request) {
	var body agentPatchBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	enabled := false
	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	id := Param(r, "id")
	if err := s.store.SetAgentEnabled(r.Context(), id, enabled); err != nil {
		writeError(w, http.StatusInternalServerError, "update agent")
		return
	}

	agent, err := s.store.GetAgent(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get agent")
		return
	}
	if agent == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, agent)
}

// deleteAgent handles DELETE /api/agents/:id. Only business_processing agents
// (user/dialogue-created) may be deleted; registry-seeded software_development
// pipeline agents are protected (409) — they are re-seeded on every startup, so
// a hard delete is both pointless and would break the pipeline. Clears
// created_agent_id on dialogues referencing the agent (no dangling pointer) and
// publishes agent.deleted.
func (s *Server) deleteAgent(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	agent, err := s.store.GetAgent(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get agent")
		return
	}
	if agent == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if agent.Category == model.AgentCategorySoftwareDevelopment {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "built-in pipeline agents cannot be deleted"})
		return
	}
	if err := s.store.DeleteAgent(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "delete agent")
		return
	}
	if _, err := s.store.ClearDialoguesReferencingAgent(r.Context(), id); err != nil {
		// The agent row is already gone; a failed reference cleanup is logged but
		// not fatal — it leaves a harmless dangling id, not data loss.
		log.Printf("delete agent %s: clear dialogue references: %v", id, err)
	}
	if s.hub != nil {
		s.hub.Publish(Event{Type: "agent.deleted", Data: map[string]string{"id": id}})
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": id})
}

// agentRunsResponse is the shape of GET /api/agents/:id/runs. The contract is
// always 200: cc-status is an OPTIONAL observation dependency, so a down or
// missing service yields available=false plus a warning rather than an error.
type agentRunsResponse struct {
	Available bool                `json:"available"`
	Runs      []ccstatus.Subagent `json:"runs"`
	Warning   string              `json:"warning,omitempty"`
}

// agentRuns handles GET /api/agents/:id/runs — proxies to cc-status, filtering
// the returned subagents by the Factory agent's ClaudeAgentName when possible.
// cc-status is an OPTIONAL dependency: a missing/down service degrades to
// available=false with an empty runs array and never fails the request.
func (s *Server) agentRuns(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	agent, err := s.store.GetAgent(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get agent")
		return
	}
	if agent == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// No client wired (defensive): degrade without panicking.
	if s.cc == nil {
		writeJSON(w, http.StatusOK, agentRunsResponse{
			Available: false,
			Runs:      []ccstatus.Subagent{},
			Warning:   "cc-status unavailable",
		})
		return
	}

	subagents, err := s.cc.ListAgents(r.Context(), "running")
	if err != nil {
		// cc-status down (network / non-2xx / decode). Record the shared code as
		// the warning but keep the request successful.
		writeJSON(w, http.StatusOK, agentRunsResponse{
			Available: false,
			Runs:      []ccstatus.Subagent{},
			Warning:   "cc-status unavailable",
		})
		return
	}

	// Best-effort filter: keep subagents whose AgentType matches the Factory
	// agent's ClaudeAgentName. If the filter yields nothing useful, fall back to
	// all running subagents so the operator still sees activity (per brief).
	runs := filterSubagents(subagents, agent.ClaudeAgentName)
	writeJSON(w, http.StatusOK, agentRunsResponse{
		Available: true,
		Runs:      runs,
	})
}

// filterSubagents returns the subset of subagents whose AgentType matches name
// when any match exists. If name is empty or nothing matches, it returns the
// full input unchanged so the runs view stays useful rather than empty.
func filterSubagents(all []ccstatus.Subagent, name string) []ccstatus.Subagent {
	out := make([]ccstatus.Subagent, 0, len(all))
	if name == "" {
		return append(out, all...)
	}
	for _, sa := range all {
		if sa.AgentType == name {
			out = append(out, sa)
		}
	}
	if len(out) == 0 {
		// Fall back to everything so the UI is not silently empty.
		return append(out, all...)
	}
	return out
}
