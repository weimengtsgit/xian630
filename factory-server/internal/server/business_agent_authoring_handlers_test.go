package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestBusinessAgentAuthoringFinalizeCreatesAgent(t *testing.T) {
	_, r := newAgentTestServer(t)
	start := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring", map[string]string{"mode": "create"})
	if start.Code != http.StatusCreated {
		t.Fatalf("start status=%d body=%s", start.Code, start.Body.String())
	}
	var sess model.AgentAuthoringSession
	if err := json.NewDecoder(start.Body).Decode(&sess); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	if sess.Status != model.AgentAuthoringDrafting {
		t.Fatalf("status = %q, want drafting", sess.Status)
	}

	msg := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring/"+sess.ID+"/messages", map[string]string{"content": "创建海事预警专家，关注 AIS 异常航迹"})
	if msg.Code != http.StatusOK {
		t.Fatalf("msg status=%d body=%s", msg.Code, msg.Body.String())
	}
	var updated model.AgentAuthoringSession
	if err := json.NewDecoder(msg.Body).Decode(&updated); err != nil {
		t.Fatalf("decode message: %v", err)
	}
	if updated.Status != model.AgentAuthoringReadyToSave || updated.DraftJSON == "{}" {
		t.Fatalf("updated = %+v", updated)
	}

	finalize := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring/"+sess.ID+"/finalize", nil)
	if finalize.Code != http.StatusCreated {
		t.Fatalf("finalize status=%d body=%s", finalize.Code, finalize.Body.String())
	}
	var agent model.Agent
	if err := json.NewDecoder(finalize.Body).Decode(&agent); err != nil {
		t.Fatalf("decode agent: %v", err)
	}
	if agent.Category != model.AgentCategoryBusiness || agent.Prompt == "" || agent.Key != "maritime-alert-expert" {
		t.Fatalf("agent=%+v", agent)
	}
}

func TestBusinessAgentAuthoringDraftUsesMultipleMessages(t *testing.T) {
	_, r := newAgentTestServer(t)
	start := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring", map[string]string{"mode": "create"})
	var sess model.AgentAuthoringSession
	if err := json.NewDecoder(start.Body).Decode(&sess); err != nil {
		t.Fatalf("decode start: %v", err)
	}

	first := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring/"+sess.ID+"/messages", map[string]string{"content": "watch service errors"})
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	second := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring/"+sess.ID+"/messages", map[string]string{"content": "output severity and owner"})
	if second.Code != http.StatusOK {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
	var updated model.AgentAuthoringSession
	if err := json.NewDecoder(second.Body).Decode(&updated); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	if !strings.Contains(updated.DraftJSON, "watch service errors") || !strings.Contains(updated.DraftJSON, "output severity and owner") {
		t.Fatalf("draft does not include all messages: %s", updated.DraftJSON)
	}
}

func TestBusinessAgentAuthoringAbandon(t *testing.T) {
	_, r := newAgentTestServer(t)
	start := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring", map[string]string{"mode": "create"})
	var sess model.AgentAuthoringSession
	if err := json.NewDecoder(start.Body).Decode(&sess); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	abandon := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring/"+sess.ID+"/abandon", nil)
	if abandon.Code != http.StatusOK {
		t.Fatalf("abandon status=%d body=%s", abandon.Code, abandon.Body.String())
	}
	get := doJSON(t, r, http.MethodGet, "/api/business-agent-authoring/"+sess.ID, nil)
	var got model.AgentAuthoringSession
	if err := json.NewDecoder(get.Body).Decode(&got); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	if got.Status != model.AgentAuthoringAbandoned {
		t.Fatalf("status = %q, want abandoned", got.Status)
	}
}
