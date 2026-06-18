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

	// Pure-Go SQLite driver — keeps the factory server a single static binary
	// with no C toolchain dependency.
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

// Store wraps a SQLite connection pool.
type Store struct {
	db *sql.DB
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
	return &Store{db: db}, nil
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
