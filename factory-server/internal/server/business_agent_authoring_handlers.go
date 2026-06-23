package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

type businessAgentAuthoringCreateBody struct {
	Mode          string `json:"mode"`
	TargetAgentID string `json:"target_agent_id"`
}

type businessAgentAuthoringMessageBody struct {
	Content string `json:"content"`
}

func (s *Server) createBusinessAgentAuthoring(w http.ResponseWriter, r *http.Request) {
	var body businessAgentAuthoringCreateBody
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
	}
	mode := strings.TrimSpace(body.Mode)
	if mode == "" {
		mode = "create"
	}
	now := time.Now()
	sess := model.AgentAuthoringSession{
		ID:            "auth_" + idpkg.New(),
		Mode:          mode,
		TargetAgentID: strings.TrimSpace(body.TargetAgentID),
		Status:        model.AgentAuthoringDrafting,
		DraftJSON:     "{}",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.store.CreateAgentAuthoringSession(r.Context(), sess); err != nil {
		writeError(w, http.StatusInternalServerError, "create authoring")
		return
	}
	writeJSON(w, http.StatusCreated, sess)
}

func (s *Server) getBusinessAgentAuthoring(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetAgentAuthoringSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get authoring")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

func (s *Server) addBusinessAgentAuthoringMessage(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetAgentAuthoringSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get authoring")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var body businessAgentAuthoringMessageBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	content := strings.TrimSpace(body.Content)
	if content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	now := time.Now()
	if err := s.store.CreateAgentAuthoringMessage(r.Context(), model.AgentAuthoringMessage{
		ID:        "msg_" + idpkg.New(),
		SessionID: sess.ID,
		Role:      "user",
		Kind:      "message",
		Content:   content,
		CreatedAt: now,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "create message")
		return
	}
	draft := draftBusinessAgentFromText(content)
	raw, _ := json.Marshal(draft)
	if err := s.store.UpdateAgentAuthoringDraft(r.Context(), sess.ID, string(raw), model.AgentAuthoringReadyToSave); err != nil {
		writeError(w, http.StatusInternalServerError, "update draft")
		return
	}
	updated, err := s.store.GetAgentAuthoringSession(r.Context(), sess.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get authoring")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) finalizeBusinessAgentAuthoring(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetAgentAuthoringSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get authoring")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var body businessAgentBody
	if err := json.Unmarshal([]byte(sess.DraftJSON), &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid draft")
		return
	}
	agent, status, errText := s.createBusinessAgentFromBody(r, body)
	if errText != "" {
		writeError(w, status, errText)
		return
	}
	if err := s.store.UpdateAgentAuthoringDraft(r.Context(), sess.ID, sess.DraftJSON, model.AgentAuthoringSaved); err != nil {
		writeError(w, http.StatusInternalServerError, "mark saved")
		return
	}
	writeJSON(w, http.StatusCreated, agent)
}

func (s *Server) abandonBusinessAgentAuthoring(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetAgentAuthoringSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get authoring")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := s.store.UpdateAgentAuthoringDraft(r.Context(), sess.ID, sess.DraftJSON, model.AgentAuthoringAbandoned); err != nil {
		writeError(w, http.StatusInternalServerError, "abandon authoring")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "abandoned"})
}

func draftBusinessAgentFromText(content string) businessAgentBody {
	name := "业务智能体"
	if strings.Contains(content, "海事") {
		name = "海事预警专家"
	}
	return businessAgentBody{
		Key:         agentKeyFromName(name),
		Name:        name,
		Description: firstLine(content, 80),
		Prompt:      "你是" + name + "。请在需求分析、方案设计和代码生成时关注以下业务要求：" + content + "。不得覆盖软件工厂安全、文件、测试、构建和部署规则。",
	}
}

func agentKeyFromName(name string) string {
	if strings.Contains(name, "海事") {
		return "maritime-alert-expert"
	}
	return "business-agent"
}

func firstLine(s string, max int) string {
	s = strings.TrimSpace(strings.Split(s, "\n")[0])
	if len([]rune(s)) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}
