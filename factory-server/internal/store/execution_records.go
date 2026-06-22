package store

import (
	"context"
	"database/sql"
	"sort"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// executionRecordPageLimitCap is the maximum number of records a single
// ListStepExecutionRecordPage call will return, regardless of the limit the
// caller asked for. The portal streams pages, so an unbounded page is both a
// memory risk and an accidental-full-table-scan footgun.
const executionRecordPageLimitCap = 200

// AppendStepExecutionRecord inserts one immutable step-execution audit row.
// sequence is per (step_id, attempt) and assigned by the executor-side reporter
// — the store persists what it is given and relies on the UNIQUE(step_id,
// attempt, sequence) constraint to reject duplicates. A duplicate-sequence
// insert surfaces as the underlying SQLite constraint error.
func (s *Store) AppendStepExecutionRecord(ctx context.Context, rec model.StepExecutionRecord) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO step_execution_records(id, job_id, step_id, attempt, sequence, kind, content, truncated, created_at)
VALUES(?,?,?,?,?,?,?,?,?)`,
		rec.ID, rec.JobID, rec.StepID, rec.Attempt, rec.Sequence,
		string(rec.Kind), rec.Content, boolToInt(rec.Truncated), ms(rec.CreatedAt))
	return err
}

// ListStepExecutionRecordPage returns one page of records for a single
// (jobID, stepID, attempt) scope, ordered by sequence ascending. beforeSequence
// is an exclusive upper bound on sequence — 0 means "no upper bound, latest
// page". limit is capped at executionRecordPageLimitCap (200).
//
// Pagination selects newest-first (sequence < beforeSequence ORDER BY sequence
// DESC) to walk backwards from the cursor, but the returned slice is reversed
// back into ascending sequence order so callers always see oldest-to-newest.
// This matches the portal's "scroll up for history" UX without surprising
// callers who index into the slice.
func (s *Store) ListStepExecutionRecordPage(ctx context.Context, jobID, stepID string, attempt, beforeSequence, limit int) ([]model.StepExecutionRecord, error) {
	if limit <= 0 || limit > executionRecordPageLimitCap {
		limit = executionRecordPageLimitCap
	}

	q := `
SELECT id, job_id, step_id, attempt, sequence, kind, content, truncated, created_at
FROM step_execution_records
WHERE job_id = ? AND step_id = ? AND attempt = ?`
	args := []any{jobID, stepID, attempt}
	if beforeSequence > 0 {
		q += ` AND sequence < ?`
		args = append(args, beforeSequence)
	}
	q += ` ORDER BY sequence DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.StepExecutionRecord, 0)
	for rows.Next() {
		var r model.StepExecutionRecord
		var kind string
		var truncated int
		var createdMs int64
		if err := rows.Scan(&r.ID, &r.JobID, &r.StepID, &r.Attempt, &r.Sequence,
			&kind, &r.Content, &truncated, &createdMs); err != nil {
			return nil, err
		}
		r.Kind = model.ExecutionRecordKind(kind)
		r.Truncated = truncated != 0
		r.CreatedAt = time.UnixMilli(createdMs)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Reverse into ascending sequence order (query walked newest-first).
	sort.Slice(out, func(i, j int) bool { return out[i].Sequence < out[j].Sequence })
	return out, nil
}

// ListStepExecutionSummaries returns one summary per step_id for the given job:
// the highest attempt that produced any record, plus the highest-sequence
// record within that latest attempt. Steps are returned in ascending step_id
// order for deterministic rendering.
//
// Implementation note: SQLite makes the correlated "latest attempt" +
// "latest record within latest attempt" lookup awkward in a single statement,
// so we do two passes — find each step's max attempt, then for each (step,
// attempt) fetch its max-sequence row. The number of steps per job is small
// (the factory pipeline has six fixed steps), so the N+1 is bounded.
func (s *Store) ListStepExecutionSummaries(ctx context.Context, jobID string) ([]model.StepExecutionSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT step_id, MAX(attempt) AS latest_attempt
FROM step_execution_records
WHERE job_id = ?
GROUP BY step_id
ORDER BY step_id`, jobID)
	if err != nil {
		return nil, err
	}
	type stepAttempt struct {
		stepID        string
		latestAttempt int
	}
	pairs := make([]stepAttempt, 0)
	for rows.Next() {
		var sa stepAttempt
		if err := rows.Scan(&sa.stepID, &sa.latestAttempt); err != nil {
			return nil, err
		}
		pairs = append(pairs, sa)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	out := make([]model.StepExecutionSummary, 0, len(pairs))
	for _, sa := range pairs {
		summary := model.StepExecutionSummary{
			StepID:        sa.stepID,
			LatestAttempt: sa.latestAttempt,
		}
		// Latest record = highest sequence within the latest attempt.
		row := s.db.QueryRowContext(ctx, `
SELECT id, job_id, step_id, attempt, sequence, kind, content, truncated, created_at
FROM step_execution_records
WHERE job_id = ? AND step_id = ? AND attempt = ?
ORDER BY sequence DESC
LIMIT 1`, jobID, sa.stepID, sa.latestAttempt)
		var r model.StepExecutionRecord
		var kind string
		var truncated int
		var createdMs int64
		if err := row.Scan(&r.ID, &r.JobID, &r.StepID, &r.Attempt, &r.Sequence,
			&kind, &r.Content, &truncated, &createdMs); err != nil {
			if err == sql.ErrNoRows {
				// No records for the latest attempt: shouldn't happen given the
				// GROUP BY above, but treat defensively as an empty summary.
				out = append(out, summary)
				continue
			}
			return nil, err
		}
		r.Kind = model.ExecutionRecordKind(kind)
		r.Truncated = truncated != 0
		r.CreatedAt = time.UnixMilli(createdMs)
		summary.LatestRecord = &r
		out = append(out, summary)
	}
	return out, nil
}
