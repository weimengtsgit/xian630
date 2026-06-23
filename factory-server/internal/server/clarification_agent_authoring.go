package server

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// agentDraftBody is the structured agent draft embedded in agent_draft messages.
type agentDraftBody struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
	Enabled     bool   `json:"enabled"`
}

// generateAgentDraft builds an agent draft from the conversation messages.
// It concatenates all user messages and derives a structured draft using
// template-based heuristics (same approach as the existing authoring API).
func generateAgentDraft(messages []model.ClarificationMessage) agentDraftBody {
	parts := make([]string, 0, len(messages))
	for _, msg := range messages {
		if msg.Role == "user" && strings.TrimSpace(msg.Content) != "" {
			parts = append(parts, strings.TrimSpace(msg.Content))
		}
	}
	content := strings.Join(parts, "\n")
	return draftAgentFromConversation(content)
}

// draftAgentFromConversation generates an agent draft from concatenated user
// messages. Uses the same template approach as draftBusinessAgentFromText in
// business_agent_authoring_handlers.go.
func draftAgentFromConversation(content string) agentDraftBody {
	name := "业务智能体"
	key := "business-agent"
	if strings.Contains(content, "海事") {
		name = "海事预警专家"
		key = "maritime-alert-expert"
	} else if strings.Contains(content, "报表") {
		name = "报表生成专家"
		key = "report-writer"
	} else if strings.Contains(content, "态势") {
		name = "态势分析专家"
		key = "situation-analyst"
	}
	description := firstLine(content, 80)
	prompt := "你是" + name + "。请在需求分析、方案设计和代码生成时关注以下业务要求：" + content + "。不得覆盖软件工厂安全、文件、测试、构建和部署规则。"
	return agentDraftBody{
		Key:         key,
		Name:        name,
		Description: description,
		Prompt:      prompt,
		Enabled:     true,
	}
}

// persistAgentDraft creates an agent_draft message and publishes the SSE event.
// Called by runRoundAndPersist when the session mode is agent_authoring.
func (s *Server) persistAgentDraft(ctx context.Context, sessionID string, draft agentDraftBody) error {
	draftBytes, _ := json.Marshal(draft)
	now := time.Now()
	if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
		ID:           "cmsg_" + idpkg.New(),
		SessionID:    sessionID,
		Role:         "agent",
		Kind:         "agent_draft",
		Content:      "已根据对话更新智能体预览",
		MetadataJSON: string(draftBytes),
		CreatedAt:    now,
	}); err != nil {
		return err
	}
	if s.hub != nil {
		s.hub.Publish(Event{
			Type: "agent_authoring.draft.updated",
			Data: map[string]any{
				"session_id": sessionID,
				"data":       draft,
			},
		})
	}
	return nil
}

// isAgentAuthoringMode checks whether a clarification session is in agent
// authoring mode.
func isAgentAuthoringMode(sess *model.ClarificationSession) bool {
	return sess != nil && sess.Mode == "agent_authoring"
}

