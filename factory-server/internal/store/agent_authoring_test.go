package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestAgentAuthoringSessionDraftLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	sess := model.AgentAuthoringSession{
		ID:        "auth_1",
		Mode:      "create",
		Status:    model.AgentAuthoringDrafting,
		DraftJSON: `{}`,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := st.CreateAgentAuthoringSession(ctx, sess); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := st.CreateAgentAuthoringMessage(ctx, model.AgentAuthoringMessage{
		ID:        "msg_1",
		SessionID: "auth_1",
		Role:      "user",
		Kind:      "message",
		Content:   "做海事预警",
		CreatedAt: now,
	}); err != nil {
		t.Fatalf("create message: %v", err)
	}
	if err := st.UpdateAgentAuthoringDraft(ctx, "auth_1", `{"name":"海事预警专家"}`, model.AgentAuthoringReadyToSave); err != nil {
		t.Fatalf("update draft: %v", err)
	}
	got, err := st.GetAgentAuthoringSession(ctx, "auth_1")
	if err != nil || got.Status != model.AgentAuthoringReadyToSave || !strings.Contains(got.DraftJSON, "海事预警专家") {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	messages, err := st.ListAgentAuthoringMessages(ctx, "auth_1")
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(messages) != 1 || messages[0].Content != "做海事预警" {
		t.Fatalf("messages = %+v", messages)
	}
}
