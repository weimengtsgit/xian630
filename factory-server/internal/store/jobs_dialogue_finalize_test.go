package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func createFinalizeTestDialogue(t *testing.T, st *Store, id string, status model.DialogueStatus) {
	t.Helper()
	now := time.Now()
	if err := st.CreateDialogueSession(context.Background(), model.DialogueSession{
		ID:            id,
		InitialPrompt: "生成测试应用",
		Status:        status,
		Intent:        model.DialogueIntentApplicationGeneration,
		CreatedAt:     now,
		UpdatedAt:     now,
	}); err != nil {
		t.Fatalf("create dialogue %s: %v", id, err)
	}
}

func createFinalizeTestJob(t *testing.T, st *Store, id, dialogueID, appID string) {
	t.Helper()
	now := time.Now()
	if err := st.CreateJob(context.Background(), model.Job{
		ID:              id,
		UserPrompt:      "生成测试应用",
		Status:          model.JobStatusRunning,
		CurrentStepKind: model.StepDeployment,
		DialogueID:      dialogueID,
		CreatedAppID:    appID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}); err != nil {
		t.Fatalf("create job %s: %v", id, err)
	}
}

// TestMarkJobCompletedResolvesDialogue: a generation job's session sits in
// active/task_running when the job completes (SetJobCreatedApp only does
// task_running→active); completion must flip it to resolved with the produced
// app id and resolved_at stamped — otherwise the session list shows 进行中
// forever (observed dlg_cc98e41bb2a83f78db12dc89).
func TestMarkJobCompletedResolvesDialogue(t *testing.T) {
	st := newTestStore(t)
	createFinalizeTestDialogue(t, st, "dlg_fin_1", model.DialogueStatusActive)
	createFinalizeTestJob(t, st, "job_fin_1", "dlg_fin_1", "app-generated-1")

	if err := st.MarkJobCompleted(context.Background(), "job_fin_1"); err != nil {
		t.Fatalf("MarkJobCompleted: %v", err)
	}
	dlg, err := st.GetDialogueSession(context.Background(), "dlg_fin_1")
	if err != nil || dlg == nil {
		t.Fatalf("get dialogue: %v", err)
	}
	if dlg.Status != model.DialogueStatusResolved {
		t.Fatalf("status = %s, want resolved", dlg.Status)
	}
	if dlg.ResolvedApplicationID != "app-generated-1" {
		t.Fatalf("resolved_application_id = %q, want app-generated-1", dlg.ResolvedApplicationID)
	}
	if dlg.ResolvedAt == nil {
		t.Fatalf("resolved_at not stamped")
	}
}

// TestMarkJobCompletedKeepsExistingResolved: a session the user already
// resolved by opening the app keeps its original resolved_at.
func TestMarkJobCompletedKeepsExistingResolved(t *testing.T) {
	st := newTestStore(t)
	createFinalizeTestDialogue(t, st, "dlg_fin_2", model.DialogueStatusActive)
	createFinalizeTestJob(t, st, "job_fin_2", "dlg_fin_2", "app-generated-2")
	if err := st.SetDialogueResolved(context.Background(), "dlg_fin_2", "app-opened-earlier", ""); err != nil {
		t.Fatalf("SetDialogueResolved: %v", err)
	}
	before, _ := st.GetDialogueSession(context.Background(), "dlg_fin_2")

	if err := st.MarkJobCompleted(context.Background(), "job_fin_2"); err != nil {
		t.Fatalf("MarkJobCompleted: %v", err)
	}
	dlg, _ := st.GetDialogueSession(context.Background(), "dlg_fin_2")
	if dlg.Status != model.DialogueStatusResolved {
		t.Fatalf("status = %s, want resolved", dlg.Status)
	}
	if dlg.ResolvedApplicationID != "app-opened-earlier" {
		t.Fatalf("resolved_application_id = %q, want the user's original app-opened-earlier", dlg.ResolvedApplicationID)
	}
	if dlg.ResolvedAt == nil || !dlg.ResolvedAt.Equal(*before.ResolvedAt) {
		t.Fatalf("resolved_at must keep its original stamp")
	}
}

// TestMarkJobFailedFailsTaskRunningDialogue: a job failure must surface on its
// task_running session (observed dlg_9e427165c7016d07ec3f9bcc stuck at
// task_running after the job failed terminally). Non-task_running sessions are
// left alone — the user may have moved the dialogue on.
func TestMarkJobFailedFailsTaskRunningDialogue(t *testing.T) {
	st := newTestStore(t)
	createFinalizeTestDialogue(t, st, "dlg_fin_3", model.DialogueStatusTaskRunning)
	createFinalizeTestJob(t, st, "job_fin_3", "dlg_fin_3", "")

	if err := st.MarkJobFailedWithCode(context.Background(), "job_fin_3", "schema_validation_failed", "boom"); err != nil {
		t.Fatalf("MarkJobFailedWithCode: %v", err)
	}
	dlg, _ := st.GetDialogueSession(context.Background(), "dlg_fin_3")
	if dlg.Status != model.DialogueStatusFailed {
		t.Fatalf("status = %s, want failed", dlg.Status)
	}
	if dlg.ErrorCode != "schema_validation_failed" || dlg.ErrorMessage != "boom" {
		t.Fatalf("error = %q/%q, want schema_validation_failed/boom", dlg.ErrorCode, dlg.ErrorMessage)
	}
}

// TestMarkJobFailedIgnoresOtherDialogueStates: an active (interactive) session
// is not failed by a job failure.
func TestMarkJobFailedIgnoresOtherDialogueStates(t *testing.T) {
	st := newTestStore(t)
	createFinalizeTestDialogue(t, st, "dlg_fin_4", model.DialogueStatusActive)
	createFinalizeTestJob(t, st, "job_fin_4", "dlg_fin_4", "")

	if err := st.MarkJobFailed(context.Background(), "job_fin_4"); err != nil {
		t.Fatalf("MarkJobFailed: %v", err)
	}
	dlg, _ := st.GetDialogueSession(context.Background(), "dlg_fin_4")
	if dlg.Status != model.DialogueStatusActive {
		t.Fatalf("status = %s, want active (untouched)", dlg.Status)
	}
}

// TestMarkJobTerminalWithoutDialogue: legacy jobs with no dialogue link must
// keep working.
func TestMarkJobTerminalWithoutDialogue(t *testing.T) {
	st := newTestStore(t)
	createFinalizeTestJob(t, st, "job_fin_5", "", "")
	if err := st.MarkJobCompleted(context.Background(), "job_fin_5"); err != nil {
		t.Fatalf("MarkJobCompleted without dialogue: %v", err)
	}
	if err := st.MarkJobFailed(context.Background(), "job_fin_5"); err != nil {
		t.Fatalf("MarkJobFailed without dialogue: %v", err)
	}
}

// TestMarkJobQueuedRevivesFailedDialogue: retrying a failed job (retry /
// repair both re-queue) must flip its failed dialogue back to task_running and
// clear the error, so the session list and the failure banner track the re-run
// (observed dlg_2f41: job re-queued and running while the session kept
// showing 已失败 + the failure banner).
func TestMarkJobQueuedRevivesFailedDialogue(t *testing.T) {
	st := newTestStore(t)
	createFinalizeTestDialogue(t, st, "dlg_fin_6", model.DialogueStatusFailed)
	createFinalizeTestJob(t, st, "job_fin_6", "dlg_fin_6", "")
	if err := st.UpdateDialogueStatus(context.Background(), "dlg_fin_6", model.DialogueStatusFailed, "schema_validation_failed", "boom"); err != nil {
		t.Fatalf("set failed: %v", err)
	}

	if err := st.MarkJobQueued(context.Background(), "job_fin_6"); err != nil {
		t.Fatalf("MarkJobQueued: %v", err)
	}
	dlg, _ := st.GetDialogueSession(context.Background(), "dlg_fin_6")
	if dlg.Status != model.DialogueStatusTaskRunning {
		t.Fatalf("status = %s, want task_running", dlg.Status)
	}
	if dlg.ErrorCode != "" || dlg.ErrorMessage != "" {
		t.Fatalf("error not cleared: %q/%q", dlg.ErrorCode, dlg.ErrorMessage)
	}
}

// TestMarkJobFailedRefreshesFailedDialogueError: when a retried job fails
// again, the dialogue's error must update to the LATEST failure.
func TestMarkJobFailedRefreshesFailedDialogueError(t *testing.T) {
	st := newTestStore(t)
	createFinalizeTestDialogue(t, st, "dlg_fin_7", model.DialogueStatusTaskRunning)
	createFinalizeTestJob(t, st, "job_fin_7", "dlg_fin_7", "")
	if err := st.MarkJobFailedWithCode(context.Background(), "job_fin_7", "first_error", "first"); err != nil {
		t.Fatalf("first MarkJobFailedWithCode: %v", err)
	}

	if err := st.MarkJobQueued(context.Background(), "job_fin_7"); err != nil {
		t.Fatalf("MarkJobQueued: %v", err)
	}
	if err := st.MarkJobFailedWithCode(context.Background(), "job_fin_7", "second_error", "second"); err != nil {
		t.Fatalf("second MarkJobFailedWithCode: %v", err)
	}
	dlg, _ := st.GetDialogueSession(context.Background(), "dlg_fin_7")
	if dlg.Status != model.DialogueStatusFailed {
		t.Fatalf("status = %s, want failed", dlg.Status)
	}
	if dlg.ErrorCode != "second_error" || dlg.ErrorMessage != "second" {
		t.Fatalf("error = %q/%q, want second_error/second", dlg.ErrorCode, dlg.ErrorMessage)
	}
}
