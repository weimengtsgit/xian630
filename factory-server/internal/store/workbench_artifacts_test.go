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

// TestWorkbenchArtifactRefsMetadataRoundTrip locks F6: the data_capture card's
// data_contract artifact carries a producer-authored JSON verification summary
// (sourceBoundary + per-boundary verdicts + fallback history + sample/field
// counts) that the workbench's data-flow track renders as real node states. The
// metadata column must round-trip verbatim through the upsert/list boundary so
// the executor's projection survives a read.
func TestWorkbenchArtifactRefsMetadataRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	meta := `{"sourceBoundary":"internet","verification":{"ontology":{"status":"failed","reason":"unreachable"},"internet":{"status":"passed","reason":"ok"},"demo":{"status":"pending","reason":""}},"fallbackHistory":["ontology_failed"],"sampleCount":24,"fieldCount":5}`
	ref := model.WorkbenchArtifactRef{
		ID: "warf_data", DialogueID: "dlg_data", JobID: "job_data", StepID: "step_data",
		CardKey: "data_capture", Kind: model.WorkbenchArtifactDataContract,
		Label: "数据契约", Path: "docs/data-integration.md",
		Status: "internet", Metadata: meta, CreatedAt: time.UnixMilli(1700000000000),
	}
	if err := st.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef: %v", err)
	}
	got, err := st.ListWorkbenchArtifactRefsByDialogue(ctx, "dlg_data")
	if err != nil {
		t.Fatalf("ListWorkbenchArtifactRefsByDialogue: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected one ref, got %d", len(got))
	}
	if got[0].Metadata != meta {
		t.Fatalf("metadata did not round-trip:\nwant %s\ngot  %s", meta, got[0].Metadata)
	}
	if got[0].Status != "internet" {
		t.Fatalf("status = %q, want internet", got[0].Status)
	}
	// Upserting again with updated metadata updates the row in place.
	ref.Metadata = `{"sourceBoundary":"demo","verification":{"ontology":{"status":"failed"},"internet":{"status":"failed"},"demo":{"status":"passed"}},"fallbackHistory":["ontology_failed","internet_failed"],"sampleCount":3,"fieldCount":2}`
	if err := st.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
		t.Fatalf("UpsertWorkbenchArtifactRef (update): %v", err)
	}
	again, err := st.ListWorkbenchArtifactRefsByDialogue(ctx, "dlg_data")
	if err != nil {
		t.Fatalf("ListWorkbenchArtifactRefsByDialogue (update): %v", err)
	}
	if len(again) != 1 || again[0].Metadata != ref.Metadata {
		t.Fatalf("metadata update did not persist, got %#v", again)
	}
}
