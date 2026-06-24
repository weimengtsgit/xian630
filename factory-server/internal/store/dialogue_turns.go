package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// dialogueTurnCols lists the dialogue_turns columns in scan order, shared by the
// SELECTs below to keep the query and scanDialogueTurn in sync.
const dialogueTurnCols = `id,dialogue_id,message_id,intent,status,summary_json,created_at,started_at,ended_at`

// CreateDialogueTurn inserts one dialogue turn row.
func (s *Store) CreateDialogueTurn(ctx context.Context, t model.DialogueTurn) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dialogue_turns(id,dialogue_id,message_id,intent,status,summary_json,created_at,started_at,ended_at)
VALUES(?,?,?,?,?,?,?,?,?)`,
		t.ID, t.DialogueID, t.MessageID, string(t.Intent), string(t.Status), t.SummaryJSON,
		ms(t.CreatedAt), nullableMs(t.StartedAt), nullableMs(t.EndedAt))
	return err
}

// GetDialogueTurn returns the turn with the given id. It returns (nil, nil) on a
// miss — a missing row is not an error — mirroring GetDialogueSession.
func (s *Store) GetDialogueTurn(ctx context.Context, id string) (*model.DialogueTurn, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+dialogueTurnCols+` FROM dialogue_turns WHERE id = ?`, id)
	t, err := scanDialogueTurn(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return t, nil
}

// ListDialogueTurns returns the turns for a dialogue, oldest-first. It is the
// ordered view the worker drains and the audit view the portal renders.
func (s *Store) ListDialogueTurns(ctx context.Context, dialogueID string) ([]model.DialogueTurn, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+dialogueTurnCols+` FROM dialogue_turns WHERE dialogue_id = ? ORDER BY created_at ASC`, dialogueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.DialogueTurn{}
	for rows.Next() {
		t, err := scanDialogueTurn(rows)
		if err != nil {
			return nil, err
		}
		if t != nil {
			out = append(out, *t)
		}
	}
	return out, rows.Err()
}

// ClaimPendingDialogueTurn atomically claims the OLDEST pending turn for the
// given dialogue: it flips that single row from pending -> running (stamps
// started_at) and returns it. It returns (nil, nil) when no pending turn exists.
// Per-dialogue single-flight is enforced by the worker holding a running gate;
// this method is the persistence-level claim that records the transition. The
// CASE expression ensures only a pending row is flipped, so a concurrent claim
// on an already-running dialogue flips nothing.
func (s *Store) ClaimPendingDialogueTurn(ctx context.Context, dialogueID string) (*model.DialogueTurn, error) {
	// Find the oldest pending turn id first (SQLite RETURNING is not uniformly
	// available across the driver versions in use), then flip it under a
	// conditional UPDATE.
	var id string
	err := s.db.QueryRowContext(ctx,
		`SELECT id FROM dialogue_turns WHERE dialogue_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
		dialogueID).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	now := time.Now()
	res, err := s.db.ExecContext(ctx, `
UPDATE dialogue_turns
SET status = 'running', started_at = ?
WHERE id = ? AND status = 'pending'`,
		ms(now), id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// A concurrent claim won the race; signal nothing-to-do for this caller.
		return nil, nil
	}
	return s.GetDialogueTurn(ctx, id)
}

// HasRunningDialogueTurn reports whether the dialogue currently has a turn in
// the running state. It is the single-flight guard: the worker refuses to start
// a new turn while one is in-flight for the same dialogue.
func (s *Store) HasRunningDialogueTurn(ctx context.Context, dialogueID string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM dialogue_turns WHERE dialogue_id = ? AND status = 'running'`, dialogueID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// SetDialogueTurnIntent stamps the inferred intent + summary on a turn (the
// worker does this once the model round completes, before marking it terminal).
func (s *Store) SetDialogueTurnIntent(ctx context.Context, id string, intent model.TurnIntent, summaryJSON string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE dialogue_turns SET intent = ?, summary_json = ? WHERE id = ?`,
		string(intent), summaryJSON, id)
	return err
}

// CompleteDialogueTurn marks a turn terminal (completed|canceled|failed) and
// stamps ended_at. The next pending turn for the dialogue becomes claimable.
func (s *Store) CompleteDialogueTurn(ctx context.Context, id string, status model.TurnStatus) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE dialogue_turns SET status = ?, ended_at = ? WHERE id = ?`,
		string(status), ms(time.Now()), id)
	return err
}

// CancelRunningDialogueTurn flips a dialogue's single running turn (if any) to
// canceled. It is the cancel path: a canceled turn becomes terminal before the
// next turn begins. Returns the canceled turn id (empty if none was running).
func (s *Store) CancelRunningDialogueTurn(ctx context.Context, dialogueID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx,
		`SELECT id FROM dialogue_turns WHERE dialogue_id = ? AND status = 'running' LIMIT 1`, dialogueID).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if err := s.CompleteDialogueTurn(ctx, id, model.TurnStatusCanceled); err != nil {
		return "", err
	}
	return id, nil
}

// scanDialogueTurn reads a dialogue_turns row. It works for both *sql.Row and
// *sql.Rows via the package's scanner interface.
func scanDialogueTurn(sc scanner) (*model.DialogueTurn, error) {
	var t model.DialogueTurn
	var intent, status string
	var created int64
	var started, ended sql.NullInt64
	err := sc.Scan(&t.ID, &t.DialogueID, &t.MessageID, &intent, &status, &t.SummaryJSON,
		&created, &started, &ended)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t.Intent = model.TurnIntent(intent)
	t.Status = model.TurnStatus(status)
	t.CreatedAt = time.UnixMilli(created)
	t.StartedAt = ptrFromMs(started)
	t.EndedAt = ptrFromMs(ended)
	return &t, nil
}

// BackfillResolvedDialoguesToActive is the idempotent one-time migration that
// transitions every legacy resolved dialogue into a continuing active session,
// so a dialogue whose first application is deployed stays open for follow-up
// modification/inquiry turns (Task 2). It preserves resolved_application_id /
// created_agent_id / resolved_at (the audit links) and only flips status +
// clears the resolved terminal marker semantics — the dialogue is still
// "resolved" in lineage terms but its interaction state is now active.
//
// Re-running is safe: only rows whose status is exactly 'resolved' are flipped,
// so an already-active session is a no-op.
func (s *Store) BackfillResolvedDialoguesToActive(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE dialogue_sessions SET status = 'active' WHERE status = 'resolved'`)
	return err
}
