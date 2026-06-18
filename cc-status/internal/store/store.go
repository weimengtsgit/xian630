// Package store is the SQLite persistence layer for cc-status.
//
// It stores the four entities (sessions, subagents, skills, background_tasks)
// plus an append-only raw event log. All timestamp columns are INTEGER unix
// milliseconds; Go time.Time values are converted at the boundary.
package store

import (
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/weimengtsgit/xian630/cc-status/internal/model"

	// Pure-Go SQLite driver (keeps a single static binary, no C toolchain).
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

// Store wraps a SQLite connection.
type Store struct {
	db *sql.DB
}

// Open opens (creating the parent dir) and migrates the database at path.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create db dir: %w", err)
		}
	}
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// Single writer is simplest and avoids SQLITE_BUSY with the hook CLI +
	// background loops all touching the same file.
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set WAL: %w", err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the underlying connection.
func (s *Store) Close() error { return s.db.Close() }

// ----------------------------- helpers --------------------------------------

func ms(t time.Time) int64 { return t.UnixMilli() }

func fromMs(v sql.NullInt64) time.Time {
	if !v.Valid {
		return time.Time{}
	}
	return time.UnixMilli(v.Int64)
}

func ptrFromMs(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := time.UnixMilli(v.Int64)
	return &t
}

// ----------------------------- sessions -------------------------------------

// UpsertSession inserts a session or, on conflict, refreshes mutable fields.
func (s *Store) UpsertSession(sess model.Session) error {
	_, err := s.db.Exec(`
INSERT INTO sessions(id, cwd, source, model, started_at, last_seen_at, ended_at, status)
VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  cwd          = COALESCE(NULLIF(excluded.cwd,''), sessions.cwd),
  source       = COALESCE(NULLIF(excluded.source,''), sessions.source),
  model        = COALESCE(NULLIF(excluded.model,''), sessions.model),
  last_seen_at = excluded.last_seen_at,
  status       = CASE WHEN sessions.status='running' THEN excluded.status ELSE sessions.status END`,
		sess.ID, sess.Cwd, sess.Source, sess.Model, ms(sess.StartedAt), ms(sess.LastSeenAt), nullableMs(sess.EndedAt), string(sess.Status))
	return err
}

func nullableMs(t *time.Time) any {
	if t == nil {
		return nil
	}
	return ms(*t)
}

// TouchSession ensures the session row exists and bumps last_seen_at (reviving
// it to running). Upsert so a session whose first observed event is not a
// SessionStart (e.g. the server started mid-session) is still tracked.
func (s *Store) TouchSession(id string, ts time.Time) error {
	_, err := s.db.Exec(`
INSERT INTO sessions(id, started_at, last_seen_at, status) VALUES(?, ?, ?, 'running')
ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, status='running'`, id, ms(ts), ms(ts))
	return err
}

// EndSession marks a session ended.
func (s *Store) EndSession(id string, ts time.Time) error {
	_, err := s.db.Exec(`UPDATE sessions SET ended_at=?, status='completed', last_seen_at=? WHERE id=?`, ms(ts), ms(ts), id)
	return err
}

// GetSession returns one session by id.
func (s *Store) GetSession(id string) (*model.Session, error) {
	row := s.db.QueryRow(`SELECT id, cwd, source, model, started_at, last_seen_at, ended_at, status FROM sessions WHERE id=?`, id)
	sess, err := scanSession(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return sess, err
}

// ListSessions returns sessions, optionally filtered by status.
func (s *Store) ListSessions(status string, limit, offset int) ([]model.Session, error) {
	q := `SELECT id, cwd, source, model, started_at, last_seen_at, ended_at, status FROM sessions`
	var args []any
	if status != "" {
		q += ` WHERE status=?`
		args = append(args, status)
	}
	q += ` ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`
	args = append(args, defaultLimit(limit), offset)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Session, 0)
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sess)
	}
	return out, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanSession(sc scanner) (*model.Session, error) {
	var s model.Session
	var ended sql.NullInt64
	var started, last int64
	var status string
	var cwd, source, mdl sql.NullString
	if err := sc.Scan(&s.ID, &cwd, &source, &mdl, &started, &last, &ended, &status); err != nil {
		return nil, err
	}
	s.Cwd = cwd.String
	s.Source = source.String
	s.Model = mdl.String
	s.StartedAt = time.UnixMilli(started)
	s.LastSeenAt = time.UnixMilli(last)
	s.EndedAt = ptrFromMs(ended)
	s.Status = model.Status(status)
	return &s, nil
}
