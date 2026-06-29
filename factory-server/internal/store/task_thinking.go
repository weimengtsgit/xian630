package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

const taskThinkingMaxContentBytes = 8 * 1024
const taskThinkingTruncationMarker = "…[truncated]"
const taskThinkingMaxPageSize = 500

const taskThinkingCols = `id,dialogue_id,task_id,step_id,attempt,agent_key,dialogue_sequence,step_sequence,content,redacted,created_at`

// AppendTaskThinking appends a task-thinking event to the store, allocating
// both dialogue_sequence (per dialogue_id) and step_sequence (per
// task_id+step_id+attempt). The event's Content is sanitized: credentials are
// redacted, and the total byte length is capped. Returns the fully populated
// event including store-allocated fields and sanitized content.
func (s *Store) AppendTaskThinking(ctx context.Context, ev model.TaskThinkingEvent) (model.TaskThinkingEvent, error) {
	if strings.TrimSpace(ev.DialogueID) == "" {
		return model.TaskThinkingEvent{}, fmt.Errorf("task thinking: missing dialogue_id")
	}
	if ev.ID == "" {
		ev.ID = newTraceID()
	}
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = time.Now()
	}
	content, redacted := sanitizeTaskThinkingContent(ev.Content)
	ev.Content = content
	ev.Redacted = ev.Redacted || redacted

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return model.TaskThinkingEvent{}, fmt.Errorf("task thinking begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var maxDialogue sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT MAX(dialogue_sequence) FROM task_thinking_events WHERE dialogue_id = ?`, ev.DialogueID).Scan(&maxDialogue); err != nil {
		return model.TaskThinkingEvent{}, fmt.Errorf("task thinking dialogue seq: %w", err)
	}
	ev.DialogueSequence = maxDialogue.Int64 + 1

	var maxStep sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT MAX(step_sequence) FROM task_thinking_events WHERE task_id = ? AND step_id = ? AND attempt = ?`,
		ev.TaskID, ev.StepID, ev.Attempt).Scan(&maxStep); err != nil {
		return model.TaskThinkingEvent{}, fmt.Errorf("task thinking step seq: %w", err)
	}
	ev.StepSequence = int(maxStep.Int64 + 1)

	redactedInt := 0
	if ev.Redacted {
		redactedInt = 1
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO task_thinking_events(id,dialogue_id,task_id,step_id,attempt,agent_key,dialogue_sequence,step_sequence,content,redacted,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		ev.ID, ev.DialogueID, ev.TaskID, ev.StepID, ev.Attempt, ev.AgentKey,
		ev.DialogueSequence, ev.StepSequence, ev.Content, redactedInt, ms(ev.CreatedAt)); err != nil {
		return model.TaskThinkingEvent{}, fmt.Errorf("task thinking insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return model.TaskThinkingEvent{}, fmt.Errorf("task thinking commit: %w", err)
	}
	return ev, nil
}

// ListTaskThinking returns task-thinking events for dialogue_id with
// dialogue_sequence > afterDialogueSequence, ordered by dialogue_sequence
// ascending, up to limit (capped at taskThinkingMaxPageSize).
func (s *Store) ListTaskThinking(ctx context.Context, dialogueID string, afterDialogueSequence int64, limit int) ([]model.TaskThinkingEvent, error) {
	if limit <= 0 || limit > taskThinkingMaxPageSize {
		limit = taskThinkingMaxPageSize
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT `+taskThinkingCols+` FROM task_thinking_events
WHERE dialogue_id = ? AND dialogue_sequence > ?
ORDER BY dialogue_sequence ASC
LIMIT ?`, dialogueID, afterDialogueSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.TaskThinkingEvent{}
	for rows.Next() {
		ev, err := scanTaskThinking(rows)
		if err != nil {
			return nil, err
		}
		if ev != nil {
			out = append(out, *ev)
		}
	}
	return out, rows.Err()
}

// TaskThinkingRowExists reports whether a row with the given dialogue_id and
// dialogue_sequence exists.
func (s *Store) TaskThinkingRowExists(ctx context.Context, dialogueID string, dialogueSequence int64) bool {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM task_thinking_events WHERE dialogue_id = ? AND dialogue_sequence = ? LIMIT 1`,
		dialogueID, dialogueSequence).Scan(&one)
	return err == nil
}

// DeleteTaskThinkingByDialogue deletes all task-thinking events for dialogueID.
func (s *Store) DeleteTaskThinkingByDialogue(ctx context.Context, dialogueID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM task_thinking_events WHERE dialogue_id = ?`, dialogueID)
	return err
}

func scanTaskThinking(sc scanner) (*model.TaskThinkingEvent, error) {
	var ev model.TaskThinkingEvent
	var redacted int
	var created int64
	err := sc.Scan(&ev.ID, &ev.DialogueID, &ev.TaskID, &ev.StepID, &ev.Attempt, &ev.AgentKey,
		&ev.DialogueSequence, &ev.StepSequence, &ev.Content, &redacted, &created)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ev.Redacted = redacted != 0
	ev.CreatedAt = time.UnixMilli(created)
	return &ev, nil
}

func sanitizeTaskThinkingContent(content string) (string, bool) {
	original := content
	content = redactSensitiveSubstring(content)
	redacted := content != original
	if len([]byte(content)) > taskThinkingMaxContentBytes {
		b := []byte(content)
		marker := []byte(taskThinkingTruncationMarker)
		keep := taskThinkingMaxContentBytes - len(marker)
		if keep < 0 {
			keep = 0
		}
		for keep > 0 && !utf8.Valid(b[:keep]) {
			keep--
		}
		content = string(b[:keep]) + taskThinkingTruncationMarker
		redacted = true
	}
	return content, redacted
}
