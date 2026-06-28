package store

import (
	"context"
	"database/sql"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Store) CreateJobStepEdge(ctx context.Context, edge model.JobStepEdge) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO job_step_edges(job_id, from_step_id, to_step_id)
VALUES(?,?,?)`,
		edge.JobID, edge.FromStepID, edge.ToStepID)
	return err
}

// createJobStepEdgeInTx inserts a job-step dependency edge inside an already-open
// transaction. It is the building block SeedJobWithEdges /
// SeedClarificationJobWithEdges use so a job, its steps, AND its edges commit
// atomically.
func createJobStepEdgeInTx(ctx context.Context, tx *sql.Tx, edge model.JobStepEdge) error {
	_, err := tx.ExecContext(ctx, `
INSERT INTO job_step_edges(job_id, from_step_id, to_step_id)
VALUES(?,?,?)`,
		edge.JobID, edge.FromStepID, edge.ToStepID)
	return err
}

func (s *Store) ListJobStepEdges(ctx context.Context, jobID string) ([]model.JobStepEdge, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT job_id, from_step_id, to_step_id
FROM job_step_edges
WHERE job_id = ?
ORDER BY from_step_id, to_step_id`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.JobStepEdge, 0)
	for rows.Next() {
		var edge model.JobStepEdge
		if err := rows.Scan(&edge.JobID, &edge.FromStepID, &edge.ToStepID); err != nil {
			return nil, err
		}
		out = append(out, edge)
	}
	return out, rows.Err()
}
