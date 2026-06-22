package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestClarificationSessionLifecycle(t *testing.T) {
	st := newTestStore(t)
	now := time.Now()
	s := model.ClarificationSession{
		ID:              "clar_1",
		Status:          model.ClarificationStatusActive,
		InitialPrompt:   "生成一个航母编队复盘应用",
		Round:           1,
		MaxRounds:       3,
		RequirementJSON: `{"appType":"situation_replay"}`,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := st.CreateClarificationSession(context.Background(), s); err != nil {
		t.Fatalf("CreateClarificationSession: %v", err)
	}
	got, err := st.GetClarificationSession(context.Background(), "clar_1")
	if err != nil || got == nil {
		t.Fatalf("GetClarificationSession = %#v, %v", got, err)
	}
	if got.Status != model.ClarificationStatusActive || got.Round != 1 {
		t.Fatalf("session = %#v", got)
	}
	if err := st.UpdateClarificationRequirement(context.Background(), "clar_1", `{"appType":"command_dashboard"}`); err != nil {
		t.Fatalf("UpdateClarificationRequirement: %v", err)
	}
	got, _ = st.GetClarificationSession(context.Background(), "clar_1")
	if got.RequirementJSON != `{"appType":"command_dashboard"}` {
		t.Fatalf("RequirementJSON = %s", got.RequirementJSON)
	}
}

func TestUpdateClarificationRound(t *testing.T) {
	st := newTestStore(t)
	now := time.Now()
	if err := st.CreateClarificationSession(context.Background(), model.ClarificationSession{
		ID: "clar_round", Status: model.ClarificationStatusActive, InitialPrompt: "x",
		Round: 1, MaxRounds: 3, RequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := st.UpdateClarificationRound(context.Background(), "clar_round", 2); err != nil {
		t.Fatalf("UpdateClarificationRound: %v", err)
	}
	got, err := st.GetClarificationSession(context.Background(), "clar_round")
	if err != nil || got == nil {
		t.Fatalf("GetClarificationSession = %#v, %v", got, err)
	}
	if got.Round != 2 {
		t.Fatalf("round = %d, want 2", got.Round)
	}
}

func TestClarificationMessages(t *testing.T) {
	st := newTestStore(t)
	now := time.Now()
	if err := st.CreateClarificationSession(context.Background(), model.ClarificationSession{
		ID: "clar_1", Status: model.ClarificationStatusActive, InitialPrompt: "x",
		Round: 1, MaxRounds: 3, RequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	msg := model.ClarificationMessage{
		ID: "msg_1", SessionID: "clar_1", Role: "agent", Kind: "analysis_work_log",
		Content: "识别到这是态势复盘类应用。", CreatedAt: now,
	}
	if err := st.AddClarificationMessage(context.Background(), msg); err != nil {
		t.Fatalf("AddClarificationMessage: %v", err)
	}
	msgs, err := st.ListClarificationMessages(context.Background(), "clar_1")
	if err != nil {
		t.Fatalf("ListClarificationMessages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Kind != "analysis_work_log" {
		t.Fatalf("messages = %#v", msgs)
	}
}
