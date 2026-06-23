package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Store) CreateAgentAuthoringSession(ctx context.Context, sess model.AgentAuthoringSession) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agent_authoring_sessions(id, mode, target_agent_id, status, draft_json, created_at, updated_at)
VALUES(?,?,?,?,?,?,?)`,
		sess.ID, sess.Mode, sess.TargetAgentID, string(sess.Status), sess.DraftJSON, ms(sess.CreatedAt), ms(sess.UpdatedAt))
	return err
}

func (s *Store) GetAgentAuthoringSession(ctx context.Context, id string) (*model.AgentAuthoringSession, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, mode, target_agent_id, status, draft_json, created_at, updated_at
FROM agent_authoring_sessions
WHERE id = ?`, id)
	return scanAgentAuthoringSession(row)
}

func (s *Store) CreateAgentAuthoringMessage(ctx context.Context, msg model.AgentAuthoringMessage) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agent_authoring_messages(id, session_id, role, kind, content, metadata_json, created_at)
VALUES(?,?,?,?,?,?,?)`,
		msg.ID, msg.SessionID, msg.Role, msg.Kind, msg.Content, msg.MetadataJSON, ms(msg.CreatedAt))
	return err
}

func (s *Store) ListAgentAuthoringMessages(ctx context.Context, sessionID string) ([]model.AgentAuthoringMessage, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, session_id, role, kind, content, metadata_json, created_at
FROM agent_authoring_messages
WHERE session_id = ?
ORDER BY created_at ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.AgentAuthoringMessage{}
	for rows.Next() {
		msg, err := scanAgentAuthoringMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *msg)
	}
	return out, rows.Err()
}

func (s *Store) UpdateAgentAuthoringDraft(ctx context.Context, id, draftJSON string, status model.AgentAuthoringStatus) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE agent_authoring_sessions
SET draft_json = ?, status = ?, updated_at = ?
WHERE id = ?`, draftJSON, string(status), ms(time.Now()), id)
	return err
}

func scanAgentAuthoringSession(sc scanner) (*model.AgentAuthoringSession, error) {
	var sess model.AgentAuthoringSession
	var status string
	var createdMs, updatedMs int64
	if err := sc.Scan(&sess.ID, &sess.Mode, &sess.TargetAgentID, &status, &sess.DraftJSON, &createdMs, &updatedMs); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	sess.Status = model.AgentAuthoringStatus(status)
	sess.CreatedAt = time.UnixMilli(createdMs)
	sess.UpdatedAt = time.UnixMilli(updatedMs)
	return &sess, nil
}

func scanAgentAuthoringMessage(sc scanner) (*model.AgentAuthoringMessage, error) {
	var msg model.AgentAuthoringMessage
	var createdMs int64
	if err := sc.Scan(&msg.ID, &msg.SessionID, &msg.Role, &msg.Kind, &msg.Content, &msg.MetadataJSON, &createdMs); err != nil {
		return nil, err
	}
	msg.CreatedAt = time.UnixMilli(createdMs)
	return &msg, nil
}
