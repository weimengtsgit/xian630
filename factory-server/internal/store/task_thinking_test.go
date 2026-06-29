package store

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestAppendTaskThinkingAllocatesDialogueAndStepSequences(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	a, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
		ID: "think_1", DialogueID: "dlg_1", TaskID: "job_1", StepID: "step_1", Attempt: 2, AgentKey: "designer", Content: "first",
	})
	if err != nil {
		t.Fatalf("AppendTaskThinking first: %v", err)
	}
	b, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
		ID: "think_2", DialogueID: "dlg_1", TaskID: "job_1", StepID: "step_1", Attempt: 2, AgentKey: "designer", Content: "second",
	})
	if err != nil {
		t.Fatalf("AppendTaskThinking second: %v", err)
	}
	c, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
		ID: "think_3", DialogueID: "dlg_1", TaskID: "job_1", StepID: "step_2", Attempt: 1, AgentKey: "coder", Content: "third",
	})
	if err != nil {
		t.Fatalf("AppendTaskThinking third: %v", err)
	}

	if a.DialogueSequence != 1 || b.DialogueSequence != 2 || c.DialogueSequence != 3 {
		t.Fatalf("dialogue sequences = %d,%d,%d want 1,2,3", a.DialogueSequence, b.DialogueSequence, c.DialogueSequence)
	}
	if a.StepSequence != 1 || b.StepSequence != 2 || c.StepSequence != 1 {
		t.Fatalf("step sequences = %d,%d,%d want 1,2,1", a.StepSequence, b.StepSequence, c.StepSequence)
	}
}

func TestListTaskThinkingHonorsReplayCursor(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	_, _ = st.AppendTaskThinking(ctx, model.TaskThinkingEvent{ID: "a", DialogueID: "dlg", TaskID: "job", StepID: "s", Content: "a"})
	_, _ = st.AppendTaskThinking(ctx, model.TaskThinkingEvent{ID: "b", DialogueID: "dlg", TaskID: "job", StepID: "s", Content: "b"})

	rows, err := st.ListTaskThinking(ctx, "dlg", 1, 500)
	if err != nil {
		t.Fatalf("ListTaskThinking: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "b" {
		t.Fatalf("rows after cursor = %#v, want only b", rows)
	}
}

func TestAppendTaskThinkingTruncatesAtUTF8Boundary(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	content := strings.Repeat("界", 4096) // 12KB of multibyte UTF-8 text
	row, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
		ID: "utf8", DialogueID: "dlg_utf8", TaskID: "job", StepID: "s", Content: content,
	})
	if err != nil {
		t.Fatalf("AppendTaskThinking: %v", err)
	}
	if !utf8.ValidString(row.Content) {
		t.Fatalf("truncated content is invalid UTF-8")
	}
	if !strings.HasSuffix(row.Content, taskThinkingTruncationMarker) {
		t.Fatalf("truncated content missing marker: %q", row.Content[len(row.Content)-32:])
	}
}

func TestAppendTaskThinkingRedactsAndCapsContent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	huge := strings.Repeat("x", 16*1024) // 16KB, which is 2x the 8KB cap
	row, err := st.AppendTaskThinking(ctx, model.TaskThinkingEvent{
		ID: "redact", DialogueID: "dlg", TaskID: "job", StepID: "s", Content: "Authorization: Bearer secret-token\n" + huge,
	})
	if err != nil {
		t.Fatalf("AppendTaskThinking: %v", err)
	}
	if strings.Contains(row.Content, "secret-token") {
		t.Fatalf("secret leaked in content: %q", row.Content)
	}
	if !strings.Contains(row.Content, "[redacted]") {
		t.Fatalf("redaction marker missing: %q", row.Content)
	}
	if !strings.Contains(row.Content, "…[truncated]") {
		t.Fatalf("truncation marker missing: len=%d content=%q", len(row.Content), row.Content)
	}
	if !row.Redacted {
		t.Fatalf("Redacted = false, want true")
	}
}
