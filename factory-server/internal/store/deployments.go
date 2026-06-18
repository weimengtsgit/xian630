package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// deploymentStatus are the lifecycle values stored in deployments.status.
const (
	deploymentRunning = "running"
	deploymentStopped = "stopped"
	deploymentFailed  = "failed"
)

// CreateDeployment inserts a new deployment row.
func (s *Store) CreateDeployment(ctx context.Context, d model.Deployment) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO deployments(id, app_id, job_id, image_name, image_tag, container_name, host_port, container_port, url, status, created_at, started_at, stopped_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		d.ID, d.AppID, d.JobID, d.ImageName, d.ImageTag, d.ContainerName,
		d.HostPort, d.ContainerPort, d.URL, d.Status,
		ms(d.CreatedAt), nullableMs(d.StartedAt), nullableMs(d.StoppedAt))
	return err
}

// GetDeployment returns the deployment with the given id, or (nil, nil) if no
// such row exists.
func (s *Store) GetDeployment(ctx context.Context, id string) (*model.Deployment, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, app_id, job_id, image_name, image_tag, container_name, host_port, container_port, url, status, created_at, started_at, stopped_at
FROM deployments
WHERE id = ?`, id)
	d, err := scanDeployment(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return d, err
}

// GetActiveDeployment returns the single running deployment for an app, or
// (nil, nil) when none exists. There should be at most one per app; if more
// than one is somehow present, the most recent is returned.
func (s *Store) GetActiveDeployment(ctx context.Context, appID string) (*model.Deployment, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, app_id, job_id, image_name, image_tag, container_name, host_port, container_port, url, status, created_at, started_at, stopped_at
FROM deployments
WHERE app_id = ? AND status = ?
ORDER BY created_at DESC
LIMIT 1`, appID, deploymentRunning)
	d, err := scanDeployment(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return d, err
}

// ListDeploymentsByApp returns every deployment for an app, newest first.
func (s *Store) ListDeploymentsByApp(ctx context.Context, appID string) ([]model.Deployment, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, app_id, job_id, image_name, image_tag, container_name, host_port, container_port, url, status, created_at, started_at, stopped_at
FROM deployments
WHERE app_id = ?
ORDER BY created_at DESC`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.Deployment, 0)
	for rows.Next() {
		d, err := scanDeployment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// UpdateDeploymentStatus flips a deployment's status and stamps the matching
// timestamp: running → started_at=now; stopped/failed → stopped_at=now.
func (s *Store) UpdateDeploymentStatus(ctx context.Context, id, status string) error {
	now := time.Now()
	var startedAt, stoppedAt any
	switch status {
	case deploymentRunning:
		startedAt = ms(now)
	case deploymentStopped, deploymentFailed:
		stoppedAt = ms(now)
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE deployments
SET status = ?, started_at = COALESCE(?, started_at), stopped_at = COALESCE(?, stopped_at)
WHERE id = ?`, status, startedAt, stoppedAt, id)
	return err
}

// SetAppRuntime flips an application's status and runtime_url atomically.
// Stopping an app passes status="stopped" and an empty runtime_url.
func (s *Store) SetAppRuntime(ctx context.Context, appID, status, runtimeURL string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE applications
SET status = ?, runtime_url = ?, updated_at = ?
WHERE id = ?`, status, runtimeURL, ms(time.Now()), appID)
	return err
}

// scanDeployment reads a deployments row into *model.Deployment, handling the
// nullable started_at/stopped_at columns. It works for both sql.Row and
// sql.Rows.
func scanDeployment(sc scanner) (*model.Deployment, error) {
	var d model.Deployment
	var started, stopped sql.NullInt64
	var created int64
	if err := sc.Scan(&d.ID, &d.AppID, &d.JobID, &d.ImageName, &d.ImageTag,
		&d.ContainerName, &d.HostPort, &d.ContainerPort, &d.URL, &d.Status,
		&created, &started, &stopped); err != nil {
		return nil, err
	}
	d.CreatedAt = time.UnixMilli(created)
	d.StartedAt = ptrFromMs(started)
	d.StoppedAt = ptrFromMs(stopped)
	return &d, nil
}
