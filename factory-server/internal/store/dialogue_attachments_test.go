package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestDialogueAttachmentsReferenceLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.UnixMilli(1700000000000)
	att := model.DialogueAttachment{
		ID: "att_1", DialogueID: "dlg_1", FocusKey: "business_logic",
		OriginalName: "requirements.md", StoredPath: "dialogue-attachments/dlg_1/att_1/requirements.md",
		Mime: "text/markdown", Extension: ".md", SizeBytes: 128, SHA256: "sha256:abc",
		PreviewKind: model.AttachmentPreviewMarkdown, Status: model.AttachmentStatusActive,
		CreatedAt: now,
	}
	if err := st.CreateDialogueAttachment(ctx, att); err != nil {
		t.Fatalf("CreateDialogueAttachment: %v", err)
	}
	ref := model.DialogueAttachmentRef{
		ID: "aref_1", DialogueID: "dlg_1", MessageID: "dmsg_1", AttachmentID: "att_1",
		FocusKey: "business_logic", Active: true, CreatedAt: now,
	}
	if err := st.CreateDialogueAttachmentRef(ctx, ref); err != nil {
		t.Fatalf("CreateDialogueAttachmentRef: %v", err)
	}
	refs, err := st.ListDialogueAttachmentRefs(ctx, "dlg_1")
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs: %v", err)
	}
	if len(refs) != 1 || refs[0].Attachment.OriginalName != "requirements.md" || !refs[0].Active {
		t.Fatalf("refs = %#v", refs)
	}
	if err := st.DeactivateDialogueAttachmentRef(ctx, "dlg_1", "aref_1", now.Add(time.Minute)); err != nil {
		t.Fatalf("DeactivateDialogueAttachmentRef: %v", err)
	}
	refs, err = st.ListDialogueAttachmentRefs(ctx, "dlg_1")
	if err != nil {
		t.Fatalf("ListDialogueAttachmentRefs after deactivate: %v", err)
	}
	if len(refs) != 1 || refs[0].Active {
		t.Fatalf("deactivated ref must stay visible but inactive: %#v", refs)
	}
}
