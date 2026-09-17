package server

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// TestStatusPreservingResolved: once a dialogue reached its terminal resolved
// outcome (app linked + resolved_at stamped), a later turn ending must NOT
// bounce the status back to active — the session list would flip an
// already-completed session back to 进行中 (observed
// dlg_508abae48dcfe45dcc16c016: resolved_at stamped, status overwritten to
// active within the same second).
func TestStatusPreservingResolved(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	resolved := time.Now()
	if err := st.CreateDialogueSession(context.Background(), model.DialogueSession{
		ID:                    "dlg_resolved",
		InitialPrompt:         "接入潮汐 API",
		Status:                model.DialogueStatusResolved,
		Intent:                model.DialogueIntentExistingApplication,
		ResolvedApplicationID: "app-j98t",
		ResolvedAt:            &resolved,
		CreatedAt:             resolved,
		UpdatedAt:             resolved,
	}); err != nil {
		t.Fatalf("create resolved dialogue: %v", err)
	}
	now := time.Now()
	if err := st.CreateDialogueSession(context.Background(), model.DialogueSession{
		ID:            "dlg_open",
		InitialPrompt: "新的看板",
		Status:        model.DialogueStatusActive,
		Intent:        model.DialogueIntentApplicationGeneration,
		CreatedAt:     now,
		UpdatedAt:     now,
	}); err != nil {
		t.Fatalf("create active dialogue: %v", err)
	}

	w := &TurnWorker{store: st}
	if got := w.statusPreservingResolved(context.Background(), "dlg_resolved", model.DialogueStatusActive); got != model.DialogueStatusResolved {
		t.Fatalf("resolved dialogue: statusPreservingResolved = %s, want resolved", got)
	}
	if got := w.statusPreservingResolved(context.Background(), "dlg_open", model.DialogueStatusActive); got != model.DialogueStatusActive {
		t.Fatalf("open dialogue: statusPreservingResolved = %s, want active", got)
	}
}
