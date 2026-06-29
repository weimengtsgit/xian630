package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Store) UpsertProjectDocumentDraft(ctx context.Context, d model.ProjectDocumentDraft) (model.ProjectDocumentDraft, error) {
	now := time.Now()
	var existing model.ProjectDocumentDraft
	row := s.db.QueryRowContext(ctx, `
SELECT id,application_id,dialogue_id,path,source_checksum,content,status,conversion_error,created_at,updated_at,proposed_turn_id,proposed_at
FROM project_document_drafts
WHERE application_id=? AND dialogue_id=? AND path=? AND source_checksum=?`, d.ApplicationID, d.DialogueID, d.Path, d.SourceChecksum)
	if err := scanProjectDocumentDraft(row, &existing); err == nil {
		if d.Status == "" {
			d.Status = model.ProjectDocumentDraftStatusDraft
		}
		_, err := s.db.ExecContext(ctx, `
UPDATE project_document_drafts
SET content=?, status=?, conversion_error='', updated_at=?, proposed_turn_id='', proposed_at=NULL
WHERE id=?`, d.Content, string(d.Status), ms(now), existing.ID)
		if err != nil {
			return model.ProjectDocumentDraft{}, err
		}
		return s.getProjectDocumentDraftByID(ctx, existing.ID)
	} else if err != sql.ErrNoRows {
		return model.ProjectDocumentDraft{}, err
	}
	if d.ID == "" {
		d.ID = "pdd_" + id.New()
	}
	if d.Status == "" {
		d.Status = model.ProjectDocumentDraftStatusDraft
	}
	if d.CreatedAt.IsZero() {
		d.CreatedAt = now
	}
	d.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
INSERT INTO project_document_drafts(id,application_id,dialogue_id,path,source_checksum,content,status,conversion_error,created_at,updated_at,proposed_turn_id,proposed_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)`, d.ID, d.ApplicationID, d.DialogueID, d.Path, d.SourceChecksum, d.Content, string(d.Status), d.ConversionError, ms(d.CreatedAt), ms(d.UpdatedAt), d.ProposedTurnID)
	if err != nil {
		return model.ProjectDocumentDraft{}, err
	}
	return d, nil
}

func (s *Store) GetProjectDocumentDraft(ctx context.Context, applicationID, dialogueID, path, sourceChecksum string) (*model.ProjectDocumentDraft, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id,application_id,dialogue_id,path,source_checksum,content,status,conversion_error,created_at,updated_at,proposed_turn_id,proposed_at
FROM project_document_drafts WHERE application_id=? AND dialogue_id=? AND path=? AND source_checksum=?`, applicationID, dialogueID, path, sourceChecksum)
	var d model.ProjectDocumentDraft
	if err := scanProjectDocumentDraft(row, &d); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &d, nil
}

func (s *Store) GetLatestProjectDocumentDraft(ctx context.Context, applicationID, dialogueID, path string) (*model.ProjectDocumentDraft, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id,application_id,dialogue_id,path,source_checksum,content,status,conversion_error,created_at,updated_at,proposed_turn_id,proposed_at
FROM project_document_drafts WHERE application_id=? AND dialogue_id=? AND path=? ORDER BY updated_at DESC LIMIT 1`, applicationID, dialogueID, path)
	var d model.ProjectDocumentDraft
	if err := scanProjectDocumentDraft(row, &d); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &d, nil
}

func (s *Store) ListProjectDocumentDrafts(ctx context.Context, applicationID, dialogueID string) ([]model.ProjectDocumentDraft, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id,application_id,dialogue_id,path,source_checksum,content,status,conversion_error,created_at,updated_at,proposed_turn_id,proposed_at
FROM project_document_drafts WHERE application_id=? AND dialogue_id=? ORDER BY updated_at DESC`, applicationID, dialogueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ProjectDocumentDraft{}
	for rows.Next() {
		var d model.ProjectDocumentDraft
		if err := scanProjectDocumentDraft(rows, &d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) MarkProjectDocumentDraftProposed(ctx context.Context, draftID, turnID string, proposedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE project_document_drafts SET status=?, proposed_turn_id=?, proposed_at=?, updated_at=? WHERE id=?`, string(model.ProjectDocumentDraftStatusProposed), turnID, ms(proposedAt), ms(proposedAt), draftID)
	return err
}

func (s *Store) DiscardProjectDocumentDraft(ctx context.Context, draftID string) error {
	now := time.Now()
	_, err := s.db.ExecContext(ctx, `UPDATE project_document_drafts SET status=?, updated_at=? WHERE id=?`, string(model.ProjectDocumentDraftStatusDiscarded), ms(now), draftID)
	return err
}

func (s *Store) getProjectDocumentDraftByID(ctx context.Context, id string) (model.ProjectDocumentDraft, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id,application_id,dialogue_id,path,source_checksum,content,status,conversion_error,created_at,updated_at,proposed_turn_id,proposed_at
FROM project_document_drafts WHERE id=?`, id)
	var d model.ProjectDocumentDraft
	return d, scanProjectDocumentDraft(row, &d)
}

func scanProjectDocumentDraft(sc scanner, d *model.ProjectDocumentDraft) error {
	var status string
	var created, updated int64
	var proposed sql.NullInt64
	if err := sc.Scan(&d.ID, &d.ApplicationID, &d.DialogueID, &d.Path, &d.SourceChecksum, &d.Content, &status, &d.ConversionError, &created, &updated, &d.ProposedTurnID, &proposed); err != nil {
		return err
	}
	d.Status = model.ProjectDocumentDraftStatus(status)
	d.CreatedAt = time.UnixMilli(created)
	d.UpdatedAt = time.UnixMilli(updated)
	if proposed.Valid {
		t := time.UnixMilli(proposed.Int64)
		d.ProposedAt = &t
	}
	return nil
}
