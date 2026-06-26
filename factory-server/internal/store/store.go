// Package store is the SQLite persistence layer for the intelligent software
// factory (factory-server).
//
// It owns the seven core tables (applications, agents, jobs, job_steps,
// artifacts, deployments, conversations) and exposes CRUD methods for the
// factory entities. All timestamp columns are INTEGER unix milliseconds; Go
// time.Time values are converted at the boundary, and nullable *time.Time
// fields map to nullable INTEGER columns.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	// Pure-Go SQLite driver — keeps the factory server a single static binary
	// with no C toolchain dependency.
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

// Store wraps a SQLite connection pool.
type Store struct {
	db *sql.DB
	// jobOnCreateStepHook, when non-nil, is invoked once per job-step insert
	// inside SeedClarificationJob. It is a test seam to inject a mid-seed failure
	// so the atomic rollback contract can be verified; it is always nil in
	// production.
	jobOnCreateStepHook func(model.JobStep) error
}

// Open opens (and migrates) the database at path. For an in-memory database
// (":memory:") the connection pool is pinned to a single connection so every
// query sees the same private database that the schema was applied to.
func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// modernc.org/sqlite gives each pooled connection its own private
	// :memory: database. Pin the pool so the schema we apply below is visible
	// to every subsequent query.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}

	s := &Store{db: db}
	// schema.sql only runs CREATE TABLE IF NOT EXISTS, so columns added to a
	// table that already exists on disk (e.g. ~/.software-factory/state.db)
	// would never appear. Backfill them idempotently. A present column is a
	// no-op; an ALTER failure on a missing column is a real error worth
	// surfacing rather than swallowing.
	ctx := context.Background()
	if err := s.ensureColumn(ctx, "jobs", "clarification_session_id",
		`ALTER TABLE jobs ADD COLUMN clarification_session_id TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate jobs.clarification_session_id: %w", err)
	}
	if err := s.ensureColumn(ctx, "jobs", "confirmed_requirement_json",
		`ALTER TABLE jobs ADD COLUMN confirmed_requirement_json TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate jobs.confirmed_requirement_json: %w", err)
	}
	// Added by the application-version-lineage task. Left unused by
	// CreateJob/scanJob until Job gains these fields.
	if err := s.ensureColumn(ctx, "jobs", "dialogue_id",
		`ALTER TABLE jobs ADD COLUMN dialogue_id TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate jobs.dialogue_id: %w", err)
	}
	if err := s.ensureColumn(ctx, "jobs", "application_id",
		`ALTER TABLE jobs ADD COLUMN application_id TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate jobs.application_id: %w", err)
	}
	if err := s.ensureColumn(ctx, "jobs", "base_version_id",
		`ALTER TABLE jobs ADD COLUMN base_version_id TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate jobs.base_version_id: %w", err)
	}
	if err := s.ensureColumn(ctx, "jobs", "kind",
		`ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate jobs.kind: %w", err)
	}
	if err := s.ensureColumn(ctx, "applications", "display_order",
		`ALTER TABLE applications ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate applications.display_order: %w", err)
	}
	// agents.category: software_development by default so existing rows backfill
	// to the pipeline category automatically.
	if err := s.ensureColumn(ctx, "agents", "category",
		`ALTER TABLE agents ADD COLUMN category TEXT NOT NULL DEFAULT 'software_development'`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate agents.category: %w", err)
	}
	if err := s.ensureColumn(ctx, "agents", "prompt",
		`ALTER TABLE agents ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate agents.prompt: %w", err)
	}
	// agents.created_at: when the agent was generated (seeded or created from a
	// dialogue). Existing rows backfill to 0; the UI renders 0 as no time.
	if err := s.ensureColumn(ctx, "agents", "created_at",
		`ALTER TABLE agents ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate agents.created_at: %w", err)
	}
	// clarification_sessions.open_high_impact_json: persisted snapshot of the
	// currently-open high-impact confirmation items (D3 / ADR 0006). The
	// non-model readiness sites (advanceAfterUserTurn round-cap promotion and
	// normalizeClarificationReadiness on read) re-check this WITHOUT a model
	// turn so a session with open high-impact items stays question/active even
	// at the MaxRounds cap, and is never auto-promoted to ready_to_confirm.
	if err := s.ensureColumn(ctx, "clarification_sessions", "open_high_impact_json",
		`ALTER TABLE clarification_sessions ADD COLUMN open_high_impact_json TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate clarification_sessions.open_high_impact_json: %w", err)
	}
	// job_steps.pending_questions: JSON-encoded clarifying questions a step asked
	// when it paused for user input (waiting_user). Surfaced via the job detail so
	// the task card/conversation can show WHAT the user must answer, not just that
	// input is needed. Empty for steps that never paused.
	if err := s.ensureColumn(ctx, "job_steps", "pending_questions",
		`ALTER TABLE job_steps ADD COLUMN pending_questions TEXT NOT NULL DEFAULT ''`); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate job_steps.pending_questions: %w", err)
	}
	return s, nil
}

// Close closes the underlying connection pool.
func (s *Store) Close() error { return s.db.Close() }

// Ping verifies the database is reachable.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// ----------------------------- helpers --------------------------------------

// scanner is the common interface between sql.Row and sql.Rows for Scan.
type scanner interface {
	Scan(dest ...any) error
}

// ms converts a time.Time to INTEGER unix milliseconds.
func ms(t time.Time) int64 { return t.UnixMilli() }

// fromMs converts a nullable millisecond column back to time.Time (zero value
// when NULL).
func fromMs(v sql.NullInt64) time.Time {
	if !v.Valid {
		return time.Time{}
	}
	return time.UnixMilli(v.Int64)
}

// ptrFromMs converts a nullable millisecond column to *time.Time (nil when
// NULL).
func ptrFromMs(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := time.UnixMilli(v.Int64)
	return &t
}

// nullableMs converts a *time.Time into a value suitable for an INTEGER column
// (nil when the pointer is nil).
func nullableMs(t *time.Time) any {
	if t == nil {
		return nil
	}
	return ms(*t)
}

// ensureColumn makes column exist on table. It is the lightweight migration
// helper used by Open to backfill columns that schema.sql (all CREATE TABLE IF
// NOT EXISTS) cannot add to a pre-existing table. If the column is already
// present it is a no-op; otherwise it runs ddl (typically an ALTER TABLE ADD
// COLUMN). It is safe to call on every startup.
func (s *Store) ensureColumn(ctx context.Context, table, column, ddl string) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil // already present
		}
	}
	_, err = s.db.ExecContext(ctx, ddl)
	return err
}
