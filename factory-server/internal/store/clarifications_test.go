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

func TestListClarificationSessionsNewestFirst(t *testing.T) {
	st := newTestStore(t)
	base := time.Now()
	rows := []model.ClarificationSession{
		{ID: "clar_old", Status: model.ClarificationStatusWaitingUser, InitialPrompt: "old", Round: 1, MaxRounds: 3, RequirementJSON: `{"appName":"旧会话"}`, CreatedAt: base, UpdatedAt: base},
		{ID: "clar_new", Status: model.ClarificationStatusReadyToConfirm, InitialPrompt: "new", Round: 2, MaxRounds: 3, RequirementJSON: `{"appName":"新会话"}`, CreatedAt: base.Add(time.Second), UpdatedAt: base.Add(time.Second)},
	}
	for _, row := range rows {
		if err := st.CreateClarificationSession(context.Background(), row); err != nil {
			t.Fatalf("CreateClarificationSession(%s): %v", row.ID, err)
		}
	}

	got, err := st.ListClarificationSessions(context.Background(), 50)
	if err != nil {
		t.Fatalf("ListClarificationSessions: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2: %#v", len(got), got)
	}
	if got[0].ID != "clar_new" || got[1].ID != "clar_old" {
		t.Fatalf("order = %s,%s; want clar_new,clar_old", got[0].ID, got[1].ID)
	}
}

func TestDeleteClarificationSessionDeletesMessagesButKeepsJob(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	sess := model.ClarificationSession{
		ID:              "clar_delete",
		Status:          model.ClarificationStatusConfirmed,
		InitialPrompt:   "生成历史会话",
		Round:           2,
		MaxRounds:       3,
		RequirementJSON: `{}`,
		CreatedJobID:    "job_delete_keep",
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := st.CreateClarificationSession(ctx, sess); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := st.AddClarificationMessage(ctx, model.ClarificationMessage{
		ID: "cmsg_delete", SessionID: sess.ID, Role: "agent", Kind: "analysis_work_log",
		Content: "历史内容", CreatedAt: now,
	}); err != nil {
		t.Fatalf("add message: %v", err)
	}
	job := model.Job{
		ID: "job_delete_keep", UserPrompt: "生成历史会话", Status: model.JobStatusCompleted,
		CurrentStepKind: model.StepDeployment, CreatedAt: now, UpdatedAt: now,
		ClarificationSessionID: sess.ID,
	}
	if err := st.CreateJob(ctx, job); err != nil {
		t.Fatalf("create job: %v", err)
	}

	if err := st.DeleteClarificationSession(ctx, sess.ID); err != nil {
		t.Fatalf("DeleteClarificationSession: %v", err)
	}
	got, err := st.GetClarificationSession(ctx, sess.ID)
	if err != nil {
		t.Fatalf("get deleted session: %v", err)
	}
	if got != nil {
		t.Fatalf("session still exists: %#v", got)
	}
	msgs, err := st.ListClarificationMessages(ctx, sess.ID)
	if err != nil {
		t.Fatalf("list deleted messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("messages = %#v, want none", msgs)
	}
	gotJob, err := st.GetJob(ctx, job.ID)
	if err != nil || gotJob == nil {
		t.Fatalf("linked job was deleted: %#v err=%v", gotJob, err)
	}
}
