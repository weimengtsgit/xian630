package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// clarificationSessionCols lists the clarification_sessions columns in scan
// order, shared by the SELECTs below to keep the query and
// scanClarificationSession in sync.
const clarificationSessionCols = `id,status,initial_prompt,round,max_rounds,requirement_json,open_high_impact_json,created_job_id,error_code,error_message,created_at,updated_at,confirmed_at,abandoned_at`

// CreateClarificationSession inserts a new clarification session row.
func (s *Store) CreateClarificationSession(ctx context.Context, cs model.ClarificationSession) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clarification_sessions(id,status,initial_prompt,round,max_rounds,requirement_json,open_high_impact_json,created_job_id,error_code,error_message,created_at,updated_at,confirmed_at,abandoned_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		cs.ID, string(cs.Status), cs.InitialPrompt, cs.Round, cs.MaxRounds, cs.RequirementJSON,
		cs.OpenHighImpactJSON, cs.CreatedJobID, cs.ErrorCode, cs.ErrorMessage, ms(cs.CreatedAt), ms(cs.UpdatedAt),
		nullableMs(cs.ConfirmedAt), nullableMs(cs.AbandonedAt))
	return err
}

// GetClarificationSession returns the session with the given id. It returns
// (nil, nil) on a miss — a missing row is not an error — mirroring GetJob.
func (s *Store) GetClarificationSession(ctx context.Context, id string) (*model.ClarificationSession, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+clarificationSessionCols+` FROM clarification_sessions WHERE id = ?`, id)
	cs, err := scanClarificationSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return cs, nil
}

// GetActiveClarificationSession returns the most-recently-updated session that
// is still in flight (active, waiting_user, or ready_to_confirm), or (nil, nil)
// when none exists.
func (s *Store) GetActiveClarificationSession(ctx context.Context) (*model.ClarificationSession, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT `+clarificationSessionCols+`
FROM clarification_sessions
WHERE status IN (?,?,?)
ORDER BY updated_at DESC LIMIT 1`,
		string(model.ClarificationStatusActive),
		string(model.ClarificationStatusWaitingUser),
		string(model.ClarificationStatusReadyToConfirm))
	cs, err := scanClarificationSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return cs, nil
}

// ListClarificationSessions returns clarification sessions newest-first.
// limit <= 0 defaults to 50; limit > 200 is capped to 200.
func (s *Store) ListClarificationSessions(ctx context.Context, limit int) ([]model.ClarificationSession, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT `+clarificationSessionCols+`
FROM clarification_sessions
ORDER BY updated_at DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.ClarificationSession{}
	for rows.Next() {
		cs, err := scanClarificationSession(rows)
		if err != nil {
			return nil, err
		}
		if cs != nil {
			out = append(out, *cs)
		}
	}
	return out, rows.Err()
}

// ListAllClarificationSessions returns EVERY clarification session without the
// shared list cap, ordered deterministically oldest-first (created_at ASC then
// id ASC). It is intended for one-shot startup migrations (e.g. the legacy
// dialogue backfill) that must visit every row, not for the paginated API
// history — that still goes through ListClarificationSessions with its cap.
func (s *Store) ListAllClarificationSessions(ctx context.Context) ([]model.ClarificationSession, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT `+clarificationSessionCols+`
FROM clarification_sessions
ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ClarificationSession{}
	for rows.Next() {
		cs, err := scanClarificationSession(rows)
		if err != nil {
			return nil, err
		}
		if cs != nil {
			out = append(out, *cs)
		}
	}
	return out, rows.Err()
}

// DeleteClarificationSession removes one clarification session and its transcript
// messages in a transaction. Linked jobs, apps, artifacts, and execution records
// are intentionally left untouched.
func (s *Store) DeleteClarificationSession(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM clarification_messages WHERE session_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM clarification_sessions WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateClarificationRound advances the persisted `round` column to the round
// that actually ran and bumps updated_at. Without this the persisted round
// stays at its creation value (0), so GET /api/clarifications/:id would
// report a stale round and retry-current-round could not reliably determine
// the current round.
func (s *Store) UpdateClarificationRound(ctx context.Context, id string, round int) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions SET round = ?, updated_at = ? WHERE id = ?`,
		round, ms(time.Now()), id)
	return err
}

// UpdateClarificationRequirement overwrites the session's requirement_json and
// bumps updated_at.
func (s *Store) UpdateClarificationRequirement(ctx context.Context, id, requirementJSON string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions SET requirement_json = ?, updated_at = ? WHERE id = ?`,
		requirementJSON, ms(time.Now()), id)
	return err
}

// UpdateClarificationOpenHighImpact persists the latest open-high-impact list
// (as JSON) so the non-model readiness sites (advanceAfterUserTurn at the round
// cap and normalizeClarificationReadiness on read) can re-apply the D3 gate
// WITHOUT a fresh model turn. An empty json argument clears it. The list is the
// single source of truth for whether the session may reach ready_to_confirm.
func (s *Store) UpdateClarificationOpenHighImpact(ctx context.Context, id, json string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions SET open_high_impact_json = ?, updated_at = ? WHERE id = ?`,
		json, ms(time.Now()), id)
	return err
}

// SetClarificationStatus sets the session status (and optional error code/message),
// stamps confirmed_at on a transition to "confirmed" and abandoned_at on a
// transition to "abandoned", and bumps updated_at.
func (s *Store) SetClarificationStatus(ctx context.Context, id string, status model.ClarificationStatus, code, message string) error {
	now := time.Now()
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions
SET status = ?, error_code = ?, error_message = ?, updated_at = ?,
    confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
    abandoned_at = CASE WHEN ? = 'abandoned' THEN ? ELSE abandoned_at END
WHERE id = ?`,
		string(status), code, message, ms(now), string(status), ms(now), string(status), ms(now), id)
	return err
}

// LinkClarificationJob records the Job a confirmed session produced.
func (s *Store) LinkClarificationJob(ctx context.Context, id, jobID string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE clarification_sessions SET created_job_id = ?, updated_at = ? WHERE id = ?`,
		jobID, ms(time.Now()), id)
	return err
}

// AddClarificationMessage inserts one message into the session's thread.
func (s *Store) AddClarificationMessage(ctx context.Context, msg model.ClarificationMessage) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clarification_messages(id,session_id,role,kind,content,metadata_json,created_at)
VALUES(?,?,?,?,?,?,?)`,
		msg.ID, msg.SessionID, msg.Role, msg.Kind, msg.Content, msg.MetadataJSON, ms(msg.CreatedAt))
	return err
}

// ListClarificationMessages returns a session's messages oldest-first.
func (s *Store) ListClarificationMessages(ctx context.Context, sessionID string) ([]model.ClarificationMessage, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id,session_id,role,kind,content,metadata_json,created_at
FROM clarification_messages WHERE session_id = ? ORDER BY created_at ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ClarificationMessage{}
	for rows.Next() {
		var m model.ClarificationMessage
		var created int64
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Kind, &m.Content, &m.MetadataJSON, &created); err != nil {
			return nil, err
		}
		m.CreatedAt = time.UnixMilli(created)
		out = append(out, m)
	}
	return out, rows.Err()
}

// scanClarificationSession reads a clarification_sessions row. It works for
// both *sql.Row and *sql.Rows via the package's scanner interface.
func scanClarificationSession(sc scanner) (*model.ClarificationSession, error) {
	var s model.ClarificationSession
	var status string
	var created, updated int64
	var confirmed, abandoned sql.NullInt64
	err := sc.Scan(&s.ID, &status, &s.InitialPrompt, &s.Round, &s.MaxRounds,
		&s.RequirementJSON, &s.OpenHighImpactJSON, &s.CreatedJobID, &s.ErrorCode, &s.ErrorMessage,
		&created, &updated, &confirmed, &abandoned)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Status = model.ClarificationStatus(status)
	s.CreatedAt = time.UnixMilli(created)
	s.UpdatedAt = time.UnixMilli(updated)
	s.ConfirmedAt = ptrFromMs(confirmed)
	s.AbandonedAt = ptrFromMs(abandoned)
	return &s, nil
}
