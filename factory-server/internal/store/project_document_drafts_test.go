package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestProjectDocumentDraftUpsertLatestProposeAndDiscard(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	draft, err := st.UpsertProjectDocumentDraft(ctx, model.ProjectDocumentDraft{
		ApplicationID:  "app_1",
		DialogueID:     "dlg_1",
		Path:           "docs/01-requirements.md",
		SourceChecksum: "sha256:source-a",
		Content:        "# Draft A",
		Status:         model.ProjectDocumentDraftStatusDraft,
	})
	if err != nil {
		t.Fatalf("UpsertProjectDocumentDraft: %v", err)
	}
	if draft.ID == "" || draft.Status != model.ProjectDocumentDraftStatusDraft {
		t.Fatalf("draft = %#v", draft)
	}

	updated, err := st.UpsertProjectDocumentDraft(ctx, model.ProjectDocumentDraft{
		ApplicationID:  "app_1",
		DialogueID:     "dlg_1",
		Path:           "docs/01-requirements.md",
		SourceChecksum: "sha256:source-a",
		Content:        "# Draft A edited",
		Status:         model.ProjectDocumentDraftStatusDraft,
	})
	if err != nil {
		t.Fatalf("UpsertProjectDocumentDraft update: %v", err)
	}
	if updated.ID != draft.ID || updated.Content != "# Draft A edited" {
		t.Fatalf("updated = %#v, want same id with new content", updated)
	}

	latest, err := st.GetLatestProjectDocumentDraft(ctx, "app_1", "dlg_1", "docs/01-requirements.md")
	if err != nil || latest == nil {
		t.Fatalf("GetLatestProjectDocumentDraft: %#v %v", latest, err)
	}
	if latest.ID != draft.ID || latest.Content != "# Draft A edited" {
		t.Fatalf("latest = %#v", latest)
	}

	if err := st.MarkProjectDocumentDraftProposed(ctx, draft.ID, "turn_1", time.Date(2026, 6, 29, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("MarkProjectDocumentDraftProposed: %v", err)
	}
	latest, _ = st.GetLatestProjectDocumentDraft(ctx, "app_1", "dlg_1", "docs/01-requirements.md")
	if latest.Status != model.ProjectDocumentDraftStatusProposed || latest.ProposedTurnID != "turn_1" || latest.ProposedAt == nil {
		t.Fatalf("proposed latest = %#v", latest)
	}

	if err := st.DiscardProjectDocumentDraft(ctx, draft.ID); err != nil {
		t.Fatalf("DiscardProjectDocumentDraft: %v", err)
	}
	latest, _ = st.GetLatestProjectDocumentDraft(ctx, "app_1", "dlg_1", "docs/01-requirements.md")
	if latest.Status != model.ProjectDocumentDraftStatusDiscarded {
		t.Fatalf("discarded latest = %#v", latest)
	}
}

func TestListProjectDocumentDraftsScopesByApplicationAndDialogue(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	_, _ = st.UpsertProjectDocumentDraft(ctx, model.ProjectDocumentDraft{ApplicationID: "app_1", DialogueID: "dlg_1", Path: "docs/a.md", SourceChecksum: "sha256:a", Content: "a", Status: model.ProjectDocumentDraftStatusDraft})
	_, _ = st.UpsertProjectDocumentDraft(ctx, model.ProjectDocumentDraft{ApplicationID: "app_1", DialogueID: "dlg_2", Path: "docs/b.md", SourceChecksum: "sha256:b", Content: "b", Status: model.ProjectDocumentDraftStatusDraft})
	_, _ = st.UpsertProjectDocumentDraft(ctx, model.ProjectDocumentDraft{ApplicationID: "app_2", DialogueID: "dlg_1", Path: "docs/c.md", SourceChecksum: "sha256:c", Content: "c", Status: model.ProjectDocumentDraftStatusDraft})

	rows, err := st.ListProjectDocumentDrafts(ctx, "app_1", "dlg_1")
	if err != nil {
		t.Fatalf("ListProjectDocumentDrafts: %v", err)
	}
	if len(rows) != 1 || rows[0].Path != "docs/a.md" {
		t.Fatalf("rows = %#v", rows)
	}
}

func TestGetProjectDocumentDraftByID(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// Create a draft
	draft, err := st.UpsertProjectDocumentDraft(ctx, model.ProjectDocumentDraft{
		ApplicationID:  "app_1",
		DialogueID:     "dlg_1",
		Path:           "docs/01-requirements.md",
		SourceChecksum: "sha256:source-a",
		Content:        "# Draft A",
		Status:         model.ProjectDocumentDraftStatusDraft,
	})
	if err != nil {
		t.Fatalf("UpsertProjectDocumentDraft: %v", err)
	}
	if draft.ID == "" {
		t.Fatalf("draft id empty after upsert")
	}

	// Get by ID - should succeed
	found, err := st.GetProjectDocumentDraftByID(ctx, draft.ID)
	if err != nil {
		t.Fatalf("GetProjectDocumentDraftByID: %v", err)
	}
	if found == nil {
		t.Fatalf("GetProjectDocumentDraftByID: got nil, want draft")
	}
	if found.ID != draft.ID || found.Content != "# Draft A" {
		t.Fatalf("found = %#v, want matching draft", found)
	}

	// Get by non-existent ID - should return nil
	notFound, err := st.GetProjectDocumentDraftByID(ctx, "non-existent-draft-id")
	if err != nil {
		t.Fatalf("GetProjectDocumentDraftByID for non-existent: %v", err)
	}
	if notFound != nil {
		t.Fatalf("GetProjectDocumentDraftByID for non-existent: got %#v, want nil", notFound)
	}
}
