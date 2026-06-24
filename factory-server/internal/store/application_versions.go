package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// CreateApplicationVersion persists an immutable application-version row and
// returns the persisted version. It stamps CreatedAt when unset so a caller can
// omit it. The UNIQUE(job_id) constraint enforces one version per job; a
// collision surfaces as the underlying SQLite error.
//
// This is the persistence primitive only — it does not create the job. The
// transactional job+version creation that derives application_id and
// base_version_id server-side is a higher-level concern owned by the scheduler
// (later tasks); callers of this method must already supply both values.
func (s *Store) CreateApplicationVersion(ctx context.Context, v model.ApplicationVersion) (*model.ApplicationVersion, error) {
	if v.CreatedAt.IsZero() {
		v.CreatedAt = time.Now()
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO application_versions(id, app_id, parent_version_id, job_id, status, source_path, deployment_id, created_at, promoted_at)
VALUES(?,?,?,?,?,?,?,?,?)`,
		v.ID, v.ApplicationID, v.ParentVersionID, v.JobID, string(v.Status),
		v.SourcePath, v.DeploymentID, ms(v.CreatedAt), nullableMs(v.PromotedAt)); err != nil {
		return nil, err
	}
	return &v, nil
}

// GetEffectiveApplicationVersion returns the single currently-effective version
// of an application (the one with status='effective'). It returns (nil, nil)
// when no effective version exists — a miss is not an error — mirroring the
// GetApplication convention. If more than one effective row ever exists (a data
// invariant violation) the most recently promoted one wins.
func (s *Store) GetEffectiveApplicationVersion(ctx context.Context, appID string) (*model.ApplicationVersion, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, app_id, parent_version_id, job_id, status, source_path, deployment_id, created_at, promoted_at
FROM application_versions
WHERE app_id = ? AND status = ?
ORDER BY promoted_at DESC
LIMIT 1`, appID, string(model.ApplicationVersionEffective))

	got, err := scanApplicationVersion(row)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return got, nil
}

// ListApplicationVersions returns every version of an application ordered by
// created_at ASC — the lineage order from root to newest. An application with
// no versions yields an empty (non-nil) slice and no error.
func (s *Store) ListApplicationVersions(ctx context.Context, appID string) ([]model.ApplicationVersion, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, app_id, parent_version_id, job_id, status, source_path, deployment_id, created_at, promoted_at
FROM application_versions
WHERE app_id = ?
ORDER BY created_at ASC`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.ApplicationVersion, 0)
	for rows.Next() {
		got, err := scanApplicationVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *got)
	}
	return out, rows.Err()
}

// scanApplicationVersion scans one application_versions row from either a
// sql.Row or sql.Rows via the shared scanner interface.
func scanApplicationVersion(sc scanner) (*model.ApplicationVersion, error) {
	var v model.ApplicationVersion
	var status string
	var created int64
	var promoted sql.NullInt64
	if err := sc.Scan(&v.ID, &v.ApplicationID, &v.ParentVersionID, &v.JobID, &status,
		&v.SourcePath, &v.DeploymentID, &created, &promoted); err != nil {
		return nil, err
	}
	v.Status = model.ApplicationVersionStatus(status)
	v.CreatedAt = time.UnixMilli(created)
	v.PromotedAt = ptrFromMs(promoted)
	return &v, nil
}
