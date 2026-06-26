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
	if err := createApplicationVersion(ctx, s.db, v); err != nil {
		return nil, err
	}
	return &v, nil
}

type applicationVersionExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func createApplicationVersion(ctx context.Context, exec applicationVersionExecutor, v model.ApplicationVersion) error {
	_, err := exec.ExecContext(ctx, `
INSERT INTO application_versions(id, app_id, parent_version_id, job_id, status, source_path, deployment_id, created_at, promoted_at)
VALUES(?,?,?,?,?,?,?,?,?)`,
		v.ID, v.ApplicationID, v.ParentVersionID, v.JobID, string(v.Status),
		v.SourcePath, v.DeploymentID, ms(v.CreatedAt), nullableMs(v.PromotedAt))
	return err
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

// GetApplicationVersionByID returns the version with the given id, or (nil, nil)
// when no such row exists.
func (s *Store) GetApplicationVersionByID(ctx context.Context, id string) (*model.ApplicationVersion, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, app_id, parent_version_id, job_id, status, source_path, deployment_id, created_at, promoted_at
FROM application_versions
WHERE id = ?`, id)
	got, err := scanApplicationVersion(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return got, err
}

// GetApplicationVersionByJob returns the version produced by the given job, or
// (nil, nil) when no such row exists.
func (s *Store) GetApplicationVersionByJob(ctx context.Context, jobID string) (*model.ApplicationVersion, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, app_id, parent_version_id, job_id, status, source_path, deployment_id, created_at, promoted_at
FROM application_versions
WHERE job_id = ?`, jobID)
	got, err := scanApplicationVersion(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return got, err
}

// MarkApplicationVersionStatus flips a single version's status (e.g. building →
// failed). It does NOT touch promoted_at or deployment_id — those change only on
// a promotion. Used by the retain-on-failure path to mark ONLY the candidate
// failed while leaving the prior effective version untouched.
func (s *Store) MarkApplicationVersionStatus(ctx context.Context, versionID string, status model.ApplicationVersionStatus) error {
	_, err := s.db.ExecContext(ctx, `UPDATE application_versions SET status = ? WHERE id = ?`, string(status), versionID)
	return err
}

// PromoteApplicationVersion makes newVersionID the single effective version of
// an application in ONE transaction: the new version is stamped effective with
// promoted_at + deployment_id, every OTHER currently-effective version of the
// app is superseded, and the application's status/runtime_url are flipped atomically.
// The old effective container must be stopped OUTSIDE this transaction (best-effort);
// the transaction only flips DB state so a failure leaves nothing half-promoted.
//
// It is safe to call with newVersionID already effective (idempotent promote) and
// when there is no prior effective version (first promotion of a fresh app).
func (s *Store) PromoteApplicationVersion(ctx context.Context, appID, newVersionID, deploymentID, runtimeURL string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// 1. Supersede every currently-effective version of this app (at most one,
	//    but the bulk UPDATE is robust to a data-invariant violation).
	if _, err := tx.ExecContext(ctx, `
UPDATE application_versions
SET status = ?
WHERE app_id = ? AND status = ?`, string(model.ApplicationVersionSuperseded), appID, string(model.ApplicationVersionEffective)); err != nil {
		return err
	}

	// 2. Promote the new version: effective + promoted_at + deployment_id.
	if _, err := tx.ExecContext(ctx, `
UPDATE application_versions
SET status = ?, promoted_at = ?, deployment_id = ?
WHERE id = ?`,
		string(model.ApplicationVersionEffective), ms(time.Now()), deploymentID, newVersionID); err != nil {
		return err
	}

	// 3. Flip the application status to running + the new runtime URL.
	if _, err := tx.ExecContext(ctx, `
UPDATE applications
SET status = ?, runtime_url = ?, updated_at = ?
WHERE id = ?`, string(model.AppStatusRunning), runtimeURL, ms(time.Now()), appID); err != nil {
		return err
	}
	return tx.Commit()
}

// GetPreviousApplicationVersion returns the most-recently-superseded version of
// an app that is NOT the currently-effective one — the rollback target. It
// returns (nil, nil) when no superseded version exists (fresh app, nothing to
// roll back to).
func (s *Store) GetPreviousApplicationVersion(ctx context.Context, appID string) (*model.ApplicationVersion, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, app_id, parent_version_id, job_id, status, source_path, deployment_id, created_at, promoted_at
FROM application_versions
WHERE app_id = ? AND status = ?
ORDER BY promoted_at DESC
LIMIT 1`, appID, string(model.ApplicationVersionSuperseded))
	got, err := scanApplicationVersion(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return got, err
}
