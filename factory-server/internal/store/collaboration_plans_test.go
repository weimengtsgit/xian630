package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestCollaborationPlanRoundTrip(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	now := time.Now()
	job := model.Job{
		ID: "job_plan", UserPrompt: "生成复盘智能体", Status: model.JobStatusQueued,
		CurrentStepKind:          model.StepKind("collaboration_orchestration"),
		ConfirmedRequirementJSON: `{"appName":"复盘智能体"}`,
		CollaborationPlanJSON:    `{"schemaVersion":1,"mode":"topological_serial","agents":[],"edges":[]}`,
		CreatedAt:                now, UpdatedAt: now,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	got, err := st.GetJob(context.Background(), job.ID)
	if err != nil || got == nil {
		t.Fatalf("GetJob: got=%#v err=%v", got, err)
	}
	if got.CollaborationPlanJSON != job.CollaborationPlanJSON {
		t.Fatalf("CollaborationPlanJSON = %q, want %q", got.CollaborationPlanJSON, job.CollaborationPlanJSON)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(got.CollaborationPlanJSON), &decoded); err != nil {
		t.Fatalf("plan json invalid: %v", err)
	}
}

func TestJobStepSnapshotAndEdgesRoundTrip(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	now := time.Now()
	job := model.Job{
		ID: "job_edges", UserPrompt: "生成", Status: model.JobStatusQueued,
		CurrentStepKind:          model.StepKind("collaboration_orchestration"),
		ConfirmedRequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	stepA := model.JobStep{
		ID: "step_a", JobID: job.ID, Kind: model.StepKind("collaboration_orchestration"),
		Seq: 1, AgentKey: "collaboration-orchestrator", Status: model.StepStatusPending,
		SnapshotJSON: `{"agentKey":"collaboration-orchestrator","lane":"analysis"}`,
	}
	stepB := model.JobStep{
		ID: "step_b", JobID: job.ID, Kind: model.StepKind("requirement_analysis"),
		Seq: 2, AgentKey: "requirement-analyst", Status: model.StepStatusPending,
		SnapshotJSON: `{"agentKey":"requirement-analyst","lane":"analysis"}`,
	}
	if err := st.CreateJobStep(context.Background(), stepA); err != nil {
		t.Fatalf("CreateJobStep A: %v", err)
	}
	if err := st.CreateJobStep(context.Background(), stepB); err != nil {
		t.Fatalf("CreateJobStep B: %v", err)
	}
	if err := st.CreateJobStepEdge(context.Background(), model.JobStepEdge{
		JobID: job.ID, FromStepID: stepA.ID, ToStepID: stepB.ID,
	}); err != nil {
		t.Fatalf("CreateJobStepEdge: %v", err)
	}

	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	if len(steps) != 2 || steps[0].SnapshotJSON == "" || steps[1].SnapshotJSON == "" {
		t.Fatalf("steps snapshots not preserved: %+v", steps)
	}
	edges, err := st.ListJobStepEdges(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobStepEdges: %v", err)
	}
	if len(edges) != 1 || edges[0].FromStepID != stepA.ID || edges[0].ToStepID != stepB.ID {
		t.Fatalf("edges = %+v, want A->B", edges)
	}
}
