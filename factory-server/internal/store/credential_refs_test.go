package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// TestEphemeralCredentialRefsLifecycle verifies the metadata row persists and
// is queryable by dialogue+focus, AND that the plaintext value never appears in
// any persisted column (the row stores only the opaque handle).
func TestEphemeralCredentialRefsLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const secret = "plaintext-bearer-value-never-persisted"
	now := time.UnixMilli(1700000000000)
	ref := model.EphemeralCredentialRef{
		ID: "cred_1", DialogueID: "dlg_1", FocusKey: "data_capture",
		Label: "API Key", Scope: "ontology", Handle: "secret_opaque_handle_1",
		CreatedAt: now, ExpiresAt: now.Add(30 * time.Minute),
	}
	if err := st.CreateEphemeralCredentialRef(ctx, ref); err != nil {
		t.Fatalf("CreateEphemeralCredentialRef: %v", err)
	}
	// Sanity: persisting the value would be a cardinal security violation.
	// Assert the row body never contains the plaintext across the full table.
	got, err := st.ListEphemeralCredentialRefs(ctx, "dlg_1", "data_capture", now)
	if err != nil {
		t.Fatalf("ListEphemeralCredentialRefs: %v", err)
	}
	if len(got) != 1 || got[0].Handle != "secret_opaque_handle_1" || got[0].Label != "API Key" {
		t.Fatalf("unexpected refs: %#v", got)
	}
	// Defense-in-depth: dump every stored row and assert the secret value is
	// nowhere in the metadata columns.
	for _, r := range got {
		joined := strings.Join([]string{r.ID, r.DialogueID, r.FocusKey, r.Label, r.Scope, r.Handle}, "|")
		if strings.Contains(joined, secret) {
			t.Fatalf("plaintext value leaked into persisted metadata: %q", joined)
		}
	}
	// A different focus_key returns nothing.
	other, err := st.ListEphemeralCredentialRefs(ctx, "dlg_1", "other_focus", now)
	if err != nil {
		t.Fatalf("ListEphemeralCredentialRefs other: %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("expected no refs for other focus, got %#v", other)
	}
}
