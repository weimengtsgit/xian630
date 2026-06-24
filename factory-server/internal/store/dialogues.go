package store

import (
	"context"
	"database/sql"
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// dialogueSessionCols lists the dialogue_sessions columns in scan order,
// shared by the SELECTs below to keep the query and scanDialogueSession in
// sync.
const dialogueSessionCols = `id,initial_prompt,draft_json,error_code,error_message,status,intent,route_locked,clarification_session_id,resolved_application_id,created_agent_id,created_at,updated_at,resolved_at,abandoned_at`

// CreateDialogueSession inserts a new dialogue session row.
func (s *Store) CreateDialogueSession(ctx context.Context, d model.DialogueSession) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dialogue_sessions(id,initial_prompt,draft_json,error_code,error_message,status,intent,route_locked,clarification_session_id,resolved_application_id,created_agent_id,created_at,updated_at,resolved_at,abandoned_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		d.ID, d.InitialPrompt, d.DraftJSON, d.ErrorCode, d.ErrorMessage,
		string(d.Status), string(d.Intent), boolToInt(d.RouteLocked),
		d.ClarificationSessionID, d.ResolvedApplicationID, d.CreatedAgentID,
		ms(d.CreatedAt), ms(d.UpdatedAt),
		nullableMs(d.ResolvedAt), nullableMs(d.AbandonedAt))
	return err
}

// GetDialogueSession returns the session with the given id. It returns
// (nil, nil) on a miss — a missing row is not an error — mirroring GetJob.
func (s *Store) GetDialogueSession(ctx context.Context, id string) (*model.DialogueSession, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+dialogueSessionCols+` FROM dialogue_sessions WHERE id = ?`, id)
	d, err := scanDialogueSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return d, nil
}

// ListDialogueSessions returns dialogue sessions newest-first (by updated_at).
// limit <= 0 defaults to 50; limit > 200 is capped to 200.
func (s *Store) ListDialogueSessions(ctx context.Context, limit int) ([]model.DialogueSession, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT `+dialogueSessionCols+`
FROM dialogue_sessions
ORDER BY updated_at DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.DialogueSession{}
	for rows.Next() {
		d, err := scanDialogueSession(rows)
		if err != nil {
			return nil, err
		}
		if d != nil {
			out = append(out, *d)
		}
	}
	return out, rows.Err()
}

// AppendDialogueMessage inserts one message into the dialogue thread. CreatedAt
// must be set by the caller; the store does not re-stamp it.
func (s *Store) AppendDialogueMessage(ctx context.Context, msg model.DialogueMessage) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dialogue_messages(id,dialogue_id,role,kind,content,metadata_json,created_at)
VALUES(?,?,?,?,?,?,?)`,
		msg.ID, msg.DialogueID, msg.Role, msg.Kind, msg.Content, msg.MetadataJSON, ms(msg.CreatedAt))
	return err
}

// LatestDialogueMessages returns the session's most-recent messages, oldest
// first, capped to the last `limit` rows. limit <= 0 defaults to 50; limit >
// 200 is capped to 200. A limit greater than the row count returns everything.
func (s *Store) LatestDialogueMessages(ctx context.Context, dialogueID string, limit int) ([]model.DialogueMessage, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id,dialogue_id,role,kind,content,metadata_json,created_at FROM (
  SELECT id,dialogue_id,role,kind,content,metadata_json,created_at,rowid
  FROM dialogue_messages WHERE dialogue_id = ?
  ORDER BY created_at DESC, rowid DESC LIMIT ?
) ORDER BY created_at ASC, rowid ASC`, dialogueID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.DialogueMessage{}
	for rows.Next() {
		var m model.DialogueMessage
		var created int64
		if err := rows.Scan(&m.ID, &m.DialogueID, &m.Role, &m.Kind, &m.Content, &m.MetadataJSON, &created); err != nil {
			return nil, err
		}
		m.CreatedAt = time.UnixMilli(created)
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpdateDialogueRoute locks the dialogue's route: it sets intent, status, the
// in-progress draft payload, and (when lockRoute is true) marks the route
// chosen so it cannot be re-routed. It always bumps updated_at.
func (s *Store) UpdateDialogueRoute(ctx context.Context, id string, intent model.DialogueIntent, status model.DialogueStatus, draftJSON string, lockRoute bool) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE dialogue_sessions
SET intent = ?, status = ?, draft_json = ?,
    route_locked = CASE WHEN ? THEN 1 ELSE route_locked END,
    updated_at = ?
WHERE id = ?`,
		string(intent), string(status), draftJSON, boolToInt(lockRoute), ms(time.Now()), id)
	return err
}

// UpdateDialogueStatus sets the session status (and optional error code/message)
// and bumps updated_at. It stamps resolved_at on a transition to "resolved" and
// abandoned_at on a transition to "abandoned".
func (s *Store) UpdateDialogueStatus(ctx context.Context, id string, status model.DialogueStatus, code, message string) error {
	now := time.Now()
	_, err := s.db.ExecContext(ctx, `
UPDATE dialogue_sessions
SET status = ?, error_code = ?, error_message = ?, updated_at = ?,
    resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
    abandoned_at = CASE WHEN ? = 'abandoned' THEN ? ELSE abandoned_at END
WHERE id = ?`,
		string(status), code, message, ms(now),
		string(status), ms(now), string(status), ms(now), id)
	return err
}

// SetDialogueClarificationID links a child clarification session to a dialogue
// by stamping the clarification_session_id column. It bumps updated_at.
func (s *Store) SetDialogueClarificationID(ctx context.Context, id, clarificationID string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE dialogue_sessions
SET clarification_session_id = ?, updated_at = ?
WHERE id = ?`, clarificationID, ms(time.Now()), id)
	return err
}

// SetDialogueResolved marks the dialogue resolved and records the terminal
// result links: the application id it produced (for application_generation)
// and/or the agent id it created (for business_processing_agent). Either may be
// empty when not applicable. It stamps resolved_at and sets status=resolved.
func (s *Store) SetDialogueResolved(ctx context.Context, id, resolvedAppID, createdAgentID string) error {
	now := time.Now()
	_, err := s.db.ExecContext(ctx, `
UPDATE dialogue_sessions
SET status = 'resolved', resolved_application_id = ?, created_agent_id = ?,
    resolved_at = ?, updated_at = ?
WHERE id = ?`,
		resolvedAppID, createdAgentID, ms(now), ms(now), id)
	return err
}

// ClearDialoguesReferencingApp nulls resolved_application_id on every dialogue
// that pointed at appID — used when the application is deleted so no dialogue
// row carries a dangling reference to a non-existent application (which would
// otherwise make composeDialogueView silently drop resolvedApplication and lock
// the continuous loop). The dialogue status is left untouched: the session can
// still re-generate. Returns the ids of the dialogues that were reconciled so
// the caller can publish refresh events.
func (s *Store) ClearDialoguesReferencingApp(ctx context.Context, appID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM dialogue_sessions WHERE resolved_application_id = ?`, appID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(ids) > 0 {
		if _, err := s.db.ExecContext(ctx, `
UPDATE dialogue_sessions
SET resolved_application_id = '', updated_at = ?
WHERE resolved_application_id = ?`,
			ms(time.Now()), appID); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// DeleteDialogueSession removes one dialogue session and its transcript
// messages in a transaction. Linked jobs, apps, agents, and execution records
// are intentionally left untouched.
func (s *Store) DeleteDialogueSession(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM dialogue_messages WHERE dialogue_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM dialogue_sessions WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// FindDialogueByClarificationID returns the dialogue id linked to a legacy
// clarification session (if any). It is the idempotency guard for the startup
// backfill: a clarification session that already has a dialogue is skipped.
func (s *Store) FindDialogueByClarificationID(ctx context.Context, clarificationID string) (string, bool) {
	var id string
	err := s.db.QueryRowContext(ctx,
		`SELECT id FROM dialogue_sessions WHERE clarification_session_id = ? LIMIT 1`, clarificationID).Scan(&id)
	if err == sql.ErrNoRows || clarificationID == "" {
		return "", false
	}
	if err != nil {
		return "", false
	}
	return id, true
}

// scanDialogueSession reads a dialogue_sessions row. It works for both *sql.Row
// and *sql.Rows via the package's scanner interface.
func scanDialogueSession(sc scanner) (*model.DialogueSession, error) {
	var d model.DialogueSession
	var status, intent string
	var routeLocked int
	var created, updated int64
	var resolved, abandoned sql.NullInt64
	err := sc.Scan(&d.ID, &d.InitialPrompt, &d.DraftJSON, &d.ErrorCode, &d.ErrorMessage,
		&status, &intent, &routeLocked, &d.ClarificationSessionID,
		&d.ResolvedApplicationID, &d.CreatedAgentID,
		&created, &updated, &resolved, &abandoned)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d.Status = model.DialogueStatus(status)
	d.Intent = model.DialogueIntent(intent)
	d.RouteLocked = routeLocked != 0
	d.CreatedAt = time.UnixMilli(created)
	d.UpdatedAt = time.UnixMilli(updated)
	d.ResolvedAt = ptrFromMs(resolved)
	d.AbandonedAt = ptrFromMs(abandoned)
	return &d, nil
}

// BackfillClarificationDialogues is the idempotent startup migration that
// creates one application_generation dialogue for every legacy clarification
// session that does not already have a linked dialogue. It copies the session's
// initial_prompt, links it via clarification_session_id, and assigns a parent
// status derived from the child status:
//   - active/waiting_user/ready_to_confirm -> drafting_application
//   - confirmed                             -> resolved (and resolved_at)
//   - failed                                -> failed
//   - abandoned                             -> abandoned
//
// All backfilled rows are route-locked (the user already chose application
// generation). Re-running is safe: FindDialogueByClarificationID skips rows
// that already have a dialogue.
func (s *Store) BackfillClarificationDialogues(ctx context.Context) error {
	// Fetch every legacy session in one pass, uncapped. ListAllClarificationSessions
	// intentionally has no row cap (unlike ListClarificationSessions, which the
	// API uses for paginated history): a deployment with >200 legacy sessions
	// must visit them all so the oldest rows still get a parent dialogue. This
	// runs once per startup.
	legacy, err := s.ListAllClarificationSessions(ctx)
	if err != nil {
		return err
	}
	now := time.Now()
	for _, cs := range legacy {
		if cs.ID == "" {
			continue
		}
		if _, ok := s.FindDialogueByClarificationID(ctx, cs.ID); ok {
			continue // already backfilled
		}
		status := mapClarificationToDialogueStatus(cs.Status)
		dlg := model.DialogueSession{
			ID:                     "dlg_" + idpkg.New(),
			InitialPrompt:          cs.InitialPrompt,
			Status:                 status,
			Intent:                 model.DialogueIntentApplicationGeneration,
			RouteLocked:            true,
			ClarificationSessionID: cs.ID,
			CreatedAt:              now,
			UpdatedAt:              now,
		}
		if status == model.DialogueStatusResolved {
			t := now
			dlg.ResolvedAt = &t
			if cs.CreatedJobID != "" {
				if job, err := s.GetJob(ctx, cs.CreatedJobID); err == nil && job != nil && job.CreatedAppID != "" {
					dlg.ResolvedApplicationID = job.CreatedAppID
				}
			}
		}
		if err := s.CreateDialogueSession(ctx, dlg); err != nil {
			return err
		}
	}
	return nil
}

// mapClarificationToDialogueStatus maps a legacy clarification status to the
// parent dialogue status the backfill should assign.
func mapClarificationToDialogueStatus(cs model.ClarificationStatus) model.DialogueStatus {
	switch cs {
	case model.ClarificationStatusConfirmed:
		return model.DialogueStatusResolved
	case model.ClarificationStatusFailed:
		return model.DialogueStatusFailed
	case model.ClarificationStatusAbandoned:
		return model.DialogueStatusAbandoned
	default:
		// active / waiting_user / ready_to_confirm — still in flight.
		return model.DialogueStatusDraftingApplication
	}
}
