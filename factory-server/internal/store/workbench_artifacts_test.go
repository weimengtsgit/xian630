package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestWorkbenchArtifactRefsLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	ref := model.WorkbenchArtifactRef{
		ID: "warf_1", DialogueID: "dlg_1", JobID: "job_1", StepID: "step_design",
		CardKey: "interface_parsing", Kind: model.WorkbenchArtifactInterfacePreview,
		Label: "界面预览", Path: "jobs/job_1/design/preview/index.html",
		SnapshotHash: "sha256:abc", Status: "provisional", CreatedAt: time.UnixMilli(1700000000000),
	}
	if err := st.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef: %v", err)
	}
	got, err := st.ListWorkbenchArtifactRefsByDialogue(ctx, "dlg_1")
	if err != nil {
		t.Fatalf("ListWorkbenchArtifactRefsByDialogue: %v", err)
	}
	if len(got) != 1 || got[0].Kind != model.WorkbenchArtifactInterfacePreview || got[0].SnapshotHash != "sha256:abc" {
		t.Fatalf("got = %#v", got)
	}
	// Upsert by ID updates the same row (same ID -> one row, new status).
	ref.Status = "active"
	if err := st.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef (update): %v", err)
	}
	byJob, err := st.ListWorkbenchArtifactRefsByJob(ctx, "job_1")
	if err != nil {
		t.Fatalf("ListWorkbenchArtifactRefsByJob: %v", err)
	}
	if len(byJob) != 1 || byJob[0].Status != "active" {
		t.Fatalf("expected one active ref by job, got %#v", byJob)
	}
}
