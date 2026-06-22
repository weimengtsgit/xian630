package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// UpsertApplication inserts an application, or on id conflict refreshes its
// mutable fields from the supplied value.
func (s *Store) UpsertApplication(ctx context.Context, app model.Application) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO applications(id, slug, name, type, source, description, path, manifest_path, status, runtime_url, created_at, updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  slug         = excluded.slug,
  name         = excluded.name,
  type         = excluded.type,
  source       = excluded.source,
  description  = excluded.description,
  path         = excluded.path,
  manifest_path = excluded.manifest_path,
  status       = CASE
                   WHEN applications.status = 'running' THEN applications.status
                   ELSE excluded.status
                 END,
  runtime_url  = CASE
                   WHEN applications.status = 'running' THEN applications.runtime_url
                   ELSE excluded.runtime_url
                 END,
  updated_at   = excluded.updated_at`,
		app.ID, app.Slug, app.Name, app.Type, string(app.Source),
		app.Description, app.Path, app.ManifestPath, string(app.Status),
		app.RuntimeURL, ms(app.CreatedAt), ms(app.UpdatedAt))
	return err
}

// DeleteApplication deletes an application row by id.
func (s *Store) DeleteApplication(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM applications WHERE id = ?`, id)
	return err
}

// ListApplications returns every known application ordered by slug.
func (s *Store) ListApplications(ctx context.Context) ([]model.Application, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, slug, name, type, source, description, path, manifest_path, status, runtime_url, created_at, updated_at
FROM applications
ORDER BY slug`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.Application, 0)
	for rows.Next() {
		var a model.Application
		var source, status string
		var created, updated int64
		if err := rows.Scan(&a.ID, &a.Slug, &a.Name, &a.Type, &source,
			&a.Description, &a.Path, &a.ManifestPath, &status, &a.RuntimeURL,
			&created, &updated); err != nil {
			return nil, err
		}
		a.Source = model.AppSource(source)
		a.Status = model.AppStatus(status)
		a.CreatedAt = time.UnixMilli(created)
		a.UpdatedAt = time.UnixMilli(updated)
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetApplication returns the application with the given id. It returns
// (nil, nil) when no such application exists — a miss is not an error — mirroring
// the cc-status GetSession convention (sql.ErrNoRows is mapped to nil, nil).
func (s *Store) GetApplication(ctx context.Context, id string) (*model.Application, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, slug, name, type, source, description, path, manifest_path, status, runtime_url, created_at, updated_at
FROM applications
WHERE id = ?`, id)

	var a model.Application
	var source, status string
	var created, updated int64
	if err := row.Scan(&a.ID, &a.Slug, &a.Name, &a.Type, &source,
		&a.Description, &a.Path, &a.ManifestPath, &status, &a.RuntimeURL,
		&created, &updated); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	a.Source = model.AppSource(source)
	a.Status = model.AppStatus(status)
	a.CreatedAt = time.UnixMilli(created)
	a.UpdatedAt = time.UnixMilli(updated)
	return &a, nil
}

// GetApplicationBySlug returns the application with the given slug (most recent
// if duplicated), or (nil, nil) when no such application exists.
func (s *Store) GetApplicationBySlug(ctx context.Context, slug string) (*model.Application, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, slug, name, type, source, description, path, manifest_path, status, runtime_url, created_at, updated_at
FROM applications
WHERE slug = ?
ORDER BY updated_at DESC
LIMIT 1`, slug)

	var a model.Application
	var source, status string
	var created, updated int64
	if err := row.Scan(&a.ID, &a.Slug, &a.Name, &a.Type, &source,
		&a.Description, &a.Path, &a.ManifestPath, &status, &a.RuntimeURL,
		&created, &updated); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	a.Source = model.AppSource(source)
	a.Status = model.AppStatus(status)
	a.CreatedAt = time.UnixMilli(created)
	a.UpdatedAt = time.UnixMilli(updated)
	return &a, nil
}

// SyncApplications is the import path for a manifest scan: it upserts every
// scanned app, then marks any previously-known preset/generated app whose
// manifest_path is no longer present as 'missing' (design §8). It is safe to
// call with an empty scanned set — in that case nothing is upserted and nothing
// is marked missing (see MarkMissingApplications).
func (s *Store) SyncApplications(ctx context.Context, apps []model.Application) error {
	for _, app := range apps {
		if err := s.UpsertApplication(ctx, app); err != nil {
			return fmt.Errorf("upsert app %s: %w", app.Slug, err)
		}
	}

	seen := make([]string, 0, len(apps))
	for _, app := range apps {
		seen = append(seen, app.ManifestPath)
	}
	return s.MarkMissingApplications(ctx, seen)
}

// MarkMissingApplications sets status='missing' on every preset/generated app
// whose manifest_path is NOT in scannedPaths (and that is not already missing).
// If scannedPaths is empty, it is a no-op: an empty scan must never wipe the
// table, because a transiently empty workspace (e.g. a misconfigured root) would
// otherwise mark every known app missing.
func (s *Store) MarkMissingApplications(ctx context.Context, scannedPaths []string) error {
	if len(scannedPaths) == 0 {
		return nil
	}

	// Build "NOT IN (?, ?, ...)" placeholders and the argument list in the
	// exact order they appear in the SQL statement.
	placeholders := make([]string, len(scannedPaths))
	for i := range scannedPaths {
		placeholders[i] = "?"
	}
	q := fmt.Sprintf(`
UPDATE applications
SET status = ?, updated_at = ?
WHERE source IN (?, ?)
  AND manifest_path NOT IN (%s)
  AND status != ?`,
		strings.Join(placeholders, ", "))

	args := make([]any, 0, 4+len(scannedPaths))
	args = append(args,
		string(model.AppStatusMissing), // SET status
		ms(time.Now()),                 // SET updated_at
		string(model.AppSourcePreset),  // source IN (preset, generated)
		string(model.AppSourceGenerated),
	)
	for _, p := range scannedPaths { // manifest_path NOT IN (...)
		args = append(args, p)
	}
	args = append(args, string(model.AppStatusMissing)) // status != 'missing'

	_, err := s.db.ExecContext(ctx, q, args...)
	return err
}
