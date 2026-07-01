package store

import (
	"context"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// UpsertWorkbenchArtifactRef inserts a workbench artifact ref, or — when a ref
// with the same ID already exists — updates its mutable fields (label, path,
// preview URL, snapshot hash, status). The ID is the upsert key: a design-
// contract step that re-runs produces a NEW ref per attempt (the id encodes the
// attempt via the executor's idpkg.New()), so re-runs do not clobber prior
// snapshots; an explicit re-promotion of the SAME ref (same id) updates in
// place. CreatedAt is preserved on update; UpdatedAt always advances.
func (s *Store) UpsertWorkbenchArtifactRef(ctx context.Context, r model.WorkbenchArtifactRef) error {
	now := time.Now()
	if r.CreatedAt.IsZero() {
		r.CreatedAt = now
	}
	r.UpdatedAt = now
	// Try update first (id is PK). preserving created_at.
	res, err := s.db.ExecContext(ctx, `
UPDATE workbench_artifact_refs
SET dialogue_id=?, job_id=?, step_id=?, card_key=?, kind=?, label=?, path=?, preview_url=?, snapshot_hash=?, status=?, metadata=?, updated_at=?
WHERE id=?`,
		r.DialogueID, r.JobID, r.StepID, r.CardKey, string(r.Kind), r.Label, r.Path, r.PreviewURL, r.SnapshotHash, r.Status, r.Metadata, ms(r.UpdatedAt), r.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO workbench_artifact_refs(id,dialogue_id,job_id,step_id,card_key,kind,label,path,preview_url,snapshot_hash,status,metadata,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.DialogueID, r.JobID, r.StepID, r.CardKey, string(r.Kind), r.Label, r.Path, r.PreviewURL, r.SnapshotHash, r.Status, r.Metadata, ms(r.CreatedAt), ms(r.UpdatedAt))
	return err
}

// ListWorkbenchArtifactRefsByDialogue returns every artifact ref attributed to
// a dialogue, newest-created first. Empty (but non-nil) for a dialogue with no
// artifacts yet.
func (s *Store) ListWorkbenchArtifactRefsByDialogue(ctx context.Context, dialogueID string) ([]model.WorkbenchArtifactRef, error) {
	rows, err := s.db.QueryContext(ctx, `
	SELECT id,dialogue_id,job_id,step_id,card_key,kind,label,path,preview_url,snapshot_hash,status,metadata,created_at,updated_at
	FROM workbench_artifact_refs WHERE dialogue_id=? ORDER BY created_at DESC`, dialogueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.WorkbenchArtifactRef{}
	for rows.Next() {
		ref := model.WorkbenchArtifactRef{}
		if err := scanWorkbenchArtifactRef(rows, &ref); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// scanWorkbenchArtifactRef scans one workbench_artifact_refs row into a ref.
// kind is read as a string and cast to WorkbenchArtifactKind; an unknown kind
// value survives as its raw string (the frontend routes by kind, and a future
// kind should not break older reads). created_at/updated_at are INTEGER unix-ms.
func scanWorkbenchArtifactRef(sc scanner, r *model.WorkbenchArtifactRef) error {
	var kind string
	var created, updated int64
	if err := sc.Scan(&r.ID, &r.DialogueID, &r.JobID, &r.StepID, &r.CardKey, &kind, &r.Label, &r.Path, &r.PreviewURL, &r.SnapshotHash, &r.Status, &r.Metadata, &created, &updated); err != nil {
		return err
	}
	r.Kind = model.WorkbenchArtifactKind(kind)
	r.CreatedAt = time.UnixMilli(created)
	r.UpdatedAt = time.UnixMilli(updated)
	return nil
}
// ListWorkbenchArtifactRefsByJob returns every artifact ref produced by a job,
// newest-created first.
func (s *Store) ListWorkbenchArtifactRefsByJob(ctx context.Context, jobID string) ([]model.WorkbenchArtifactRef, error) {
	rows, err := s.db.QueryContext(ctx, `
	SELECT id,dialogue_id,job_id,step_id,card_key,kind,label,path,preview_url,snapshot_hash,status,metadata,created_at,updated_at
	FROM workbench_artifact_refs WHERE job_id=? ORDER BY created_at DESC`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.WorkbenchArtifactRef{}
	for rows.Next() {
		ref := model.WorkbenchArtifactRef{}
		if err := scanWorkbenchArtifactRef(rows, &ref); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}
