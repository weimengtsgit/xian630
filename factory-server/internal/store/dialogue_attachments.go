package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Store) CreateDialogueAttachment(ctx context.Context, a model.DialogueAttachment) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dialogue_attachments(id,dialogue_id,focus_key,original_name,stored_path,mime,extension,size_bytes,sha256,preview_kind,status,created_at,deactivated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.DialogueID, a.FocusKey, a.OriginalName, a.StoredPath, a.Mime, a.Extension, a.SizeBytes, a.SHA256,
		string(a.PreviewKind), string(a.Status), ms(a.CreatedAt), nullableMs(a.DeactivatedAt))
	return err
}

func (s *Store) GetDialogueAttachment(ctx context.Context, dialogueID, attachmentID string) (*model.DialogueAttachment, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,dialogue_id,focus_key,original_name,stored_path,mime,extension,size_bytes,sha256,preview_kind,status,created_at,deactivated_at FROM dialogue_attachments WHERE dialogue_id=? AND id=?`, dialogueID, attachmentID)
	return scanDialogueAttachment(row)
}

func (s *Store) CreateDialogueAttachmentRef(ctx context.Context, r model.DialogueAttachmentRef) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dialogue_attachment_refs(id,dialogue_id,message_id,attachment_id,focus_key,active,created_at,deactivated_at)
VALUES(?,?,?,?,?,?,?,?)`,
		r.ID, r.DialogueID, r.MessageID, r.AttachmentID, r.FocusKey, boolInt(r.Active), ms(r.CreatedAt), nullableMs(r.DeactivatedAt))
	return err
}

func (s *Store) ListDialogueAttachmentRefs(ctx context.Context, dialogueID string) ([]model.DialogueAttachmentRef, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT r.id,r.dialogue_id,r.message_id,r.attachment_id,r.focus_key,r.active,r.created_at,r.deactivated_at,
       a.id,a.dialogue_id,a.focus_key,a.original_name,a.stored_path,a.mime,a.extension,a.size_bytes,a.sha256,a.preview_kind,a.status,a.created_at,a.deactivated_at
FROM dialogue_attachment_refs r
JOIN dialogue_attachments a ON a.id = r.attachment_id
WHERE r.dialogue_id=?
ORDER BY r.created_at ASC`, dialogueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.DialogueAttachmentRef
	for rows.Next() {
		var r model.DialogueAttachmentRef
		var active int
		var created, attCreated int64
		var deactivated, attDeactivated sql.NullInt64
		var preview, status string
		if err := rows.Scan(&r.ID, &r.DialogueID, &r.MessageID, &r.AttachmentID, &r.FocusKey, &active, &created, &deactivated,
			&r.Attachment.ID, &r.Attachment.DialogueID, &r.Attachment.FocusKey, &r.Attachment.OriginalName, &r.Attachment.StoredPath,
			&r.Attachment.Mime, &r.Attachment.Extension, &r.Attachment.SizeBytes, &r.Attachment.SHA256, &preview, &status, &attCreated, &attDeactivated); err != nil {
			return nil, err
		}
		r.Active = active == 1
		r.CreatedAt = time.UnixMilli(created)
		r.DeactivatedAt = ptrFromMs(deactivated)
		r.Attachment.PreviewKind = model.AttachmentPreviewKind(preview)
		r.Attachment.Status = model.AttachmentStatus(status)
		r.Attachment.CreatedAt = time.UnixMilli(attCreated)
		r.Attachment.DeactivatedAt = ptrFromMs(attDeactivated)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) DeactivateDialogueAttachmentRef(ctx context.Context, dialogueID, refID string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE dialogue_attachment_refs SET active=0,deactivated_at=? WHERE dialogue_id=? AND id=?`, ms(now), dialogueID, refID)
	return err
}

type rowScanner interface{ Scan(dest ...any) error }

func scanDialogueAttachment(row rowScanner) (*model.DialogueAttachment, error) {
	var a model.DialogueAttachment
	var created int64
	var deactivated sql.NullInt64
	var preview, status string
	if err := row.Scan(&a.ID, &a.DialogueID, &a.FocusKey, &a.OriginalName, &a.StoredPath, &a.Mime, &a.Extension, &a.SizeBytes, &a.SHA256, &preview, &status, &created, &deactivated); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	a.PreviewKind = model.AttachmentPreviewKind(preview)
	a.Status = model.AttachmentStatus(status)
	a.CreatedAt = time.UnixMilli(created)
	a.DeactivatedAt = ptrFromMs(deactivated)
	return &a, nil
}

// boolInt converts a bool into the INTEGER column representation (1/0) used by
// dialogue_attachment_refs.active. It is a genuinely new helper — the existing
// store package has no bool-to-int converter.
func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
