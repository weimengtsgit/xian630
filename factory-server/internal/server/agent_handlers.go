package server

import (
	"encoding/json"
	"net/http"

	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
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
