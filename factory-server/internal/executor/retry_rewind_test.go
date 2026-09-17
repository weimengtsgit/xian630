package executor

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// seedGuardFailureJob builds a failed collaboration job whose code_generation
// step carries the finalized-data-access start-guard error, plus a failed
// dialogue linked to it — the exact AZ2F shape.
func seedGuardFailureJob(t *testing.T, st *store.Store) (string, string) {
	t.Helper()
	now := time.Now()
	jobID := "job_guard_" + itoa(int(randCounter.Add(1)))
	dlgID := "dlg_guard_" + itoa(int(randCounter.Add(1)))
	if err := st.CreateDialogueSession(context.Background(), model.DialogueSession{
		ID:            dlgID,
		InitialPrompt: "甲板风",
		Status:        model.DialogueStatusFailed,
		ErrorCode:     "schema_validation_failed",
		ErrorMessage:  "finalized data access required before code_generation",
		Intent:        model.DialogueIntentApplicationGeneration,
		CreatedAt:     now,
		UpdatedAt:     now,
	}); err != nil {
		t.Fatalf("create dialogue: %v", err)
	}
	if err := st.CreateJob(context.Background(), model.Job{
		ID:              jobID,
		UserPrompt:      "甲板风",
		Status:          model.JobStatusFailed,
		CurrentStepKind: model.StepCodeGeneration,
		DialogueID:      dlgID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}); err != nil {
		t.Fatalf("create job: %v", err)
	}
	kinds := []struct {
		kind   model.StepKind
		seq    int
		status model.StepStatus
	}{
		{model.StepRequirementAnalysis, 1, model.StepStatusSucceeded},
		{model.StepDesignContract, 2, model.StepStatusSucceeded},
		{model.StepDataIntegration, 3, model.StepStatusSucceeded},
		{model.StepCodeGeneration, 4, model.StepStatusFailed},
		{model.StepTestVerification, 5, model.StepStatusPending},
		{model.StepImageBuild, 6, model.StepStatusPending},
		{model.StepDeployment, 7, model.StepStatusPending},
	}
	for _, k := range kinds {
		step := model.JobStep{
			ID:      "step_guard_" + string(k.kind) + "_" + itoa(int(randCounter.Add(1))),
			JobID:   jobID,
			Kind:    k.kind,
			Seq:     k.seq,
			Status:  k.status,
			Attempt: 1,
		}
		if k.kind == model.StepCodeGeneration {
			step.ErrorCode = model.ErrorSchemaValidationFailed
			step.ErrorMessage = "finalized data access required before code_generation: schema_validation_failed"
		}
		if err := st.CreateJobStep(context.Background(), step); err != nil {
			t.Fatalf("create step %s: %v", k.kind, err)
		}
	}
	return jobID, dlgID
}

// TestRetryCurrentStepRewindsGuardFailureToDataIntegration: clicking retry on
// a code_generation step that failed the finalized-data-access start guard
// must rewind to data_integration (re-running code_generation alone re-trips
// the guard at second zero — observed attempts 1→4 identical failures), and
// the failed dialogue must revive to task_running so the session list and the
// failure banner clear.
func TestRetryCurrentStepRewindsGuardFailureToDataIntegration(t *testing.T) {
	e, st := newTestExecutor(t, nil)
	jobID, dlgID := seedGuardFailureJob(t, st)
	ctx := context.Background()

	updated, err := e.RetryCurrentStep(ctx, jobID)
	if err != nil {
		t.Fatalf("RetryCurrentStep: %v", err)
	}
	if updated.CurrentStepKind != model.StepDataIntegration {
		t.Fatalf("current_step_kind = %s, want data_integration", updated.CurrentStepKind)
	}
	if updated.Status != model.JobStatusQueued {
		t.Fatalf("job status = %s, want queued", updated.Status)
	}
	steps, _ := st.ListJobSteps(ctx, jobID)
	for _, s := range steps {
		if s.Seq < 3 && s.Status != model.StepStatusSucceeded {
			t.Fatalf("step %s (seq %d) = %s, upstream must stay succeeded", s.Kind, s.Seq, s.Status)
		}
		if s.Seq >= 3 && s.Status != model.StepStatusPending {
			t.Fatalf("step %s (seq %d) = %s, want pending after rewind", s.Kind, s.Seq, s.Status)
		}
	}
	dlg, _ := st.GetDialogueSession(ctx, dlgID)
	if dlg == nil || dlg.Status != model.DialogueStatusTaskRunning {
		t.Fatalf("dialogue status = %#v, want task_running", dlg)
	}
	if dlg.ErrorCode != "" || dlg.ErrorMessage != "" {
		t.Fatalf("dialogue error not cleared: %q/%q", dlg.ErrorCode, dlg.ErrorMessage)
	}
}

// TestRepairFromFailureRewindsGuardFailureToDataIntegration: the repair button
// (RepairFromFailure) takes the same rewind path for the guard failure.
func TestRepairFromFailureRewindsGuardFailureToDataIntegration(t *testing.T) {
	e, st := newTestExecutor(t, nil)
	jobID, _ := seedGuardFailureJob(t, st)
	ctx := context.Background()

	updated, err := e.RepairFromFailure(ctx, jobID)
	if err != nil {
		t.Fatalf("RepairFromFailure: %v", err)
	}
	if updated.CurrentStepKind != model.StepDataIntegration {
		t.Fatalf("current_step_kind = %s, want data_integration", updated.CurrentStepKind)
	}
	if updated.Status != model.JobStatusQueued {
		t.Fatalf("job status = %s, want queued", updated.Status)
	}
}
