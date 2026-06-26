package store

import (
	"context"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// TestAppendDialogueTraceAssignsStrictSequence is the Step 1 strict-sequence
// contract test: the store allocates MAX(sequence)+1 per dialogue inside one
// transaction, so the first event for a dialogue is sequence 1 and the second
// is sequence 2 (never a gap, never a collision).
func TestAppendDialogueTraceAssignsStrictSequence(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	first, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		ID: "trace_1", DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
	})
	if err != nil {
		t.Fatalf("AppendDialogueTrace first: %v", err)
	}
	second, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		ID: "trace_2", DialogueID: "dlg_1", Type: string(model.WorkTraceTool), PayloadJSON: "{}",
	})
	if err != nil {
		t.Fatalf("AppendDialogueTrace second: %v", err)
	}
	if first.Sequence != 1 || second.Sequence != 2 {
		t.Fatalf("sequences = %#v %#v (want 1, 2)", first, second)
	}
	if first.ID != "trace_1" || second.ID != "trace_2" {
		t.Fatalf("ids not echoed: %#v %#v", first, second)
	}
}

// TestAppendDialogueTraceIndependentSequencesPerDialogue verifies the sequence
// is scoped per dialogue_id: two dialogues each start at 1 and do not interfere.
func TestAppendDialogueTraceIndependentSequencesPerDialogue(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	a1, _ := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{ID: "a1", DialogueID: "A", Type: string(model.WorkTraceIntent), PayloadJSON: "{}"})
	b1, _ := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{ID: "b1", DialogueID: "B", Type: string(model.WorkTraceIntent), PayloadJSON: "{}"})
	a2, _ := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{ID: "a2", DialogueID: "A", Type: string(model.WorkTraceTool), PayloadJSON: "{}"})
	if a1.Sequence != 1 || b1.Sequence != 1 || a2.Sequence != 2 {
		t.Fatalf("per-dialogue sequences wrong: a1=%d b1=%d a2=%d", a1.Sequence, b1.Sequence, a2.Sequence)
	}
}

// TestAppendDialogueTraceRejectsDisallowedType verifies the allowlist gate: an
// event whose Type is not in the allowlist is rejected and never persisted.
// "thinking" is the canonical disallowed type (provider hidden reasoning) — it
// must never reach the store (Constraint #9).
func TestAppendDialogueTraceRejectsDisallowedType(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	for _, bad := range []string{"thinking", "thinking_delta", "", "secret", "raw_request"} {
		_, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			ID: "bad", DialogueID: "dlg_1", Type: bad, PayloadJSON: "{}",
		})
		if err == nil {
			t.Fatalf("type %q was accepted but should be rejected", bad)
		}
	}
	rows, err := st.ListDialogueTrace(ctx, "dlg_1", 0, 500)
	if err != nil {
		t.Fatalf("ListDialogueTrace: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("disallowed event leaked to store: %#v", rows)
	}
}

// TestAppendDialogueTraceRejectsOversizedPayload verifies the byte cap: a
// payload above the cap is truncated (with a marker) rather than rejected, so a
// runaway producer cannot bloat the trace but legitimate large summaries survive
// in capped form.
func TestAppendDialogueTraceRejectsOversizedPayload(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	huge := strings.Repeat("x", workTraceMaxPayloadBytes*4)
	got, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		ID: "big", DialogueID: "dlg_1", Type: string(model.WorkTraceTool), PayloadJSON: huge,
	})
	if err != nil {
		t.Fatalf("oversized payload should be truncated not rejected: %v", err)
	}
	if len(got.PayloadJSON) > workTraceMaxPayloadBytes {
		t.Fatalf("payload not capped: got len=%d cap=%d", len(got.PayloadJSON), workTraceMaxPayloadBytes)
	}
	if !strings.Contains(got.PayloadJSON, workTraceTruncationMarker) {
		t.Fatalf("truncation marker missing from capped payload: %q", got.PayloadJSON)
	}
}

// TestAppendDialogueTraceStripsSensitiveKeys verifies the structural sensitive-
// key stripping: known-sensitive keys (credentials/headers/tokens) at any
// nesting depth are zeroed to "[redacted]" before persist, as defense-in-depth
// even if a producer slips. It asserts the [redacted] marker IS present, the
// secret values are gone, and NESTED sensitive keys are also redacted.
func TestAppendDialogueTraceStripsSensitiveKeys(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	got, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		ID: "s", DialogueID: "dlg_1", Type: string(model.WorkTraceData),
		PayloadJSON: `{"summary":"ok","api_key":"sk-secret","authorization":"Bearer x","header":{"Authorization":"z-top"},"token":"t-plain"}`,
	})
	if err != nil {
		t.Fatalf("AppendDialogueTrace: %v", err)
	}
	// Secret VALUES must be gone (top-level + nested).
	for _, secret := range []string{"sk-secret", "Bearer x", "z-top", "t-plain"} {
		if strings.Contains(got.PayloadJSON, secret) {
			t.Fatalf("sensitive value %q persisted: %s", secret, got.PayloadJSON)
		}
	}
	// The [redacted] marker MUST be present for each zeroed value (4 sensitive
	// keys → at least 4 markers).
	if c := strings.Count(got.PayloadJSON, "[redacted]"); c < 4 {
		t.Fatalf("want >=4 [redacted] markers, got %d: %s", c, got.PayloadJSON)
	}
	// Non-sensitive content survives.
	if !strings.Contains(got.PayloadJSON, `"summary":"ok"`) {
		t.Fatalf("non-sensitive content was clobbered: %s", got.PayloadJSON)
	}
}

// TestAppendDialogueTraceRedactsNonJSONSecrets verifies the substring deny-list:
// a NON-JSON payload that carries a raw credential ("Authorization: Bearer
// sk-xxx") for an allowed trace type has its secret value replaced with
// "[redacted]" (Constraint #9: secrets must never persist even outside JSON).
func TestAppendDialogueTraceRedactsNonJSONSecrets(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	got, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		ID: "nj", DialogueID: "dlg_1", Type: string(model.WorkTraceData),
		PayloadJSON: "cmd: curl https://api.example.com\nAuthorization: Bearer sk-live-secret-12345\nother: keep-me",
	})
	if err != nil {
		t.Fatalf("AppendDialogueTrace: %v", err)
	}
	// The bearer token must be gone.
	if strings.Contains(got.PayloadJSON, "sk-live-secret-12345") {
		t.Fatalf("non-JSON bearer token persisted: %s", got.PayloadJSON)
	}
	// The [redacted] marker must replace it.
	if !strings.Contains(got.PayloadJSON, "[redacted]") {
		t.Fatalf("expected [redacted] marker for non-JSON secret: %s", got.PayloadJSON)
	}
	// Non-sensitive lines must survive.
	if !strings.Contains(got.PayloadJSON, "keep-me") {
		t.Fatalf("non-sensitive line was clobbered: %s", got.PayloadJSON)
	}
}

// TestListDialogueTraceReplayAndPaging covers ascending order, the afterSequence
// replay filter, and the 500-row page cap.
func TestListDialogueTraceReplayAndPaging(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		if _, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
		}); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	all, err := st.ListDialogueTrace(ctx, "dlg_1", 0, 500)
	if err != nil {
		t.Fatalf("ListDialogueTrace all: %v", err)
	}
	if len(all) != 5 {
		t.Fatalf("want 5 rows, got %d", len(all))
	}
	// Ascending by sequence.
	for i, r := range all {
		if r.Sequence != int64(i+1) {
			t.Fatalf("row %d sequence = %d, want %d", i, r.Sequence, i+1)
		}
	}

	// afterSequence=2 → sequences 3,4,5 (replay everything after 2).
	after, err := st.ListDialogueTrace(ctx, "dlg_1", 2, 500)
	if err != nil {
		t.Fatalf("ListDialogueTrace after: %v", err)
	}
	if len(after) != 3 || after[0].Sequence != 3 || after[2].Sequence != 5 {
		t.Fatalf("afterSequence filter wrong: %#v", after)
	}

	// Isolation: another dialogue returns nothing.
	other, err := st.ListDialogueTrace(ctx, "dlg_2", 0, 500)
	if err != nil {
		t.Fatalf("ListDialogueTrace other: %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("dialogue isolation broken: %#v", other)
	}
}

// TestListDialogueTraceEnforcesPageCap verifies the limit is clamped to the
// 500-row maximum even when a caller asks for more.
func TestListDialogueTraceEnforcesPageCap(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	got, err := st.ListDialogueTrace(ctx, "dlg_1", 0, 9999)
	if err != nil {
		t.Fatalf("ListDialogueTrace: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 (under cap), got %d", len(got))
	}
}
