package server

import (
	"encoding/json"
	"net/http"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

type clarificationBusinessAgentsBody struct {
	AgentIDs []string `json:"agent_ids"`
}

func (s *Server) listClarificationBusinessAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListClarificationBusinessAgents(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list business agents")
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

func (s *Server) replaceClarificationBusinessAgents(w http.ResponseWriter, r *http.Request) {
	var body clarificationBusinessAgentsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}

	sess, err := s.store.GetClarificationSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if isTerminalClarificationStatus(sess.Status) || sess.Status == model.ClarificationStatusConfirmed {
		writeError(w, http.StatusConflict, "session is terminal")
		return
	}

	if err := s.store.ReplaceClarificationBusinessAgents(r.Context(), sess.ID, body.AgentIDs); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	agents, err := s.store.ListClarificationBusinessAgents(r.Context(), sess.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list business agents")
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

func (s *Server) removeClarificationBusinessAgent(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetClarificationSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if isTerminalClarificationStatus(sess.Status) || sess.Status == model.ClarificationStatusConfirmed {
		writeError(w, http.StatusConflict, "session is terminal")
		return
	}

	agents, err := s.store.ListClarificationBusinessAgents(r.Context(), sess.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list business agents")
		return
	}
	removeID := Param(r, "agent_id")
	keep := make([]string, 0, len(agents))
	for _, a := range agents {
		if a.ID != removeID {
			keep = append(keep, a.ID)
		}
	}
	if err := s.store.ReplaceClarificationBusinessAgents(r.Context(), sess.ID, keep); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}
