package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// CreateJob inserts a new job row.
func (s *Store) CreateJob(ctx context.Context, job model.Job) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO jobs(id, user_prompt, normalized_prompt, app_slug, app_name, status, current_step_kind, created_app_id, lock_owner, created_at, started_at, ended_at, updated_at, clarification_session_id, confirmed_requirement_json, dialogue_id, application_id, base_version_id, kind, collaboration_plan_json)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		job.ID, job.UserPrompt, job.NormalizedPrompt, job.AppSlug, job.AppName,
		string(job.Status), string(job.CurrentStepKind), job.CreatedAppID, job.LockOwner,
		ms(job.CreatedAt), nullableMs(job.StartedAt), nullableMs(job.EndedAt), ms(job.UpdatedAt),
		job.ClarificationSessionID, job.ConfirmedRequirementJSON,
		job.DialogueID, job.ApplicationID, job.BaseVersionID, job.Kind, job.CollaborationPlanJSON)
	return err
}

// CreateJobStep inserts a new job step row.
func (s *Store) CreateJobStep(ctx context.Context, step model.JobStep) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO job_steps(id, job_id, kind, seq, agent_key, status, attempt, started_at, ended_at, needs_user_input, user_prompt, pending_questions, error_code, error_message, claude_session_id, cc_status_session_id, snapshot_json)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		step.ID, step.JobID, string(step.Kind), step.Seq, step.AgentKey,
		string(step.Status), step.Attempt, nullableMs(step.StartedAt), nullableMs(step.EndedAt),
		boolToInt(step.NeedsUserInput), step.UserPrompt, step.PendingQuestions, string(step.ErrorCode), step.ErrorMessage,
		step.ClaudeSessionID, step.CCStatusSessionID, step.SnapshotJSON)
	return err
}

// createJobStepInTx inserts a job step row inside an already-open transaction.
// It is the building block SeedClarificationJob uses so the job + all its steps
// + the clarification link are committed atomically.
func createJobStepInTx(ctx context.Context, tx *sql.Tx, step model.JobStep) error {
	_, err := tx.ExecContext(ctx, `
INSERT INTO job_steps(id, job_id, kind, seq, agent_key, status, attempt, started_at, ended_at, needs_user_input, user_prompt, pending_questions, error_code, error_message, claude_session_id, cc_status_session_id, snapshot_json)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		step.ID, step.JobID, string(step.Kind), step.Seq, step.AgentKey,
		string(step.Status), step.Attempt, nullableMs(step.StartedAt), nullableMs(step.EndedAt),
		boolToInt(step.NeedsUserInput), step.UserPrompt, step.PendingQuestions, string(step.ErrorCode), step.ErrorMessage,
		step.ClaudeSessionID, step.CCStatusSessionID, step.SnapshotJSON)
	return err
}

func createJobInTx(ctx context.Context, tx *sql.Tx, job model.Job) error {
	_, err := tx.ExecContext(ctx, `
INSERT INTO jobs(id, user_prompt, normalized_prompt, app_slug, app_name, status, current_step_kind, created_app_id, lock_owner, created_at, started_at, ended_at, updated_at, clarification_session_id, confirmed_requirement_json, dialogue_id, application_id, base_version_id, kind, collaboration_plan_json)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		job.ID, job.UserPrompt, job.NormalizedPrompt, job.AppSlug, job.AppName,
		string(job.Status), string(job.CurrentStepKind), job.CreatedAppID, job.LockOwner,
		ms(job.CreatedAt), nullableMs(job.StartedAt), nullableMs(job.EndedAt), ms(job.UpdatedAt),
		job.ClarificationSessionID, job.ConfirmedRequirementJSON,
		job.DialogueID, job.ApplicationID, job.BaseVersionID, job.Kind, job.CollaborationPlanJSON)
	return err
}

// seedJobInTx inserts the job row, then each step (invoking the optional
// jobOnCreateStepHook test seam), then each dependency edge, all inside the
// caller's transaction. The job, its steps, and its edges commit together.
func (s *Store) seedJobInTx(ctx context.Context, tx *sql.Tx, job model.Job, steps []model.JobStep, edges []model.JobStepEdge) error {
	if err := createJobInTx(ctx, tx, job); err != nil {
		return err
	}
	for _, step := range steps {
		if s.jobOnCreateStepHook != nil {
			if err := s.jobOnCreateStepHook(step); err != nil {
				return err
			}
		}
		if err := createJobStepInTx(ctx, tx, step); err != nil {
			return err
		}
	}
	for _, edge := range edges {
		if err := createJobStepEdgeInTx(ctx, tx, edge); err != nil {
			return err
		}
	}
	return nil
}

// SeedJob atomically creates a job and its full fixed step plan. It is used by
// revision generation as well as initial generation so either path rolls back
// completely when an individual step insert fails.
func (s *Store) SeedJob(ctx context.Context, job model.Job, steps []model.JobStep) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.seedJobInTx(ctx, tx, job, steps, nil); err != nil {
		return err
	}
	return tx.Commit()
}

// SeedJobWithEdges atomically creates a job, its steps, AND its dependency edges
// in a SINGLE transaction: the job, its steps, and its edges commit together, so
// a freshly created collaboration-plan job is never left with steps but no edges
// (or vice versa). On failure nothing is committed.
func (s *Store) SeedJobWithEdges(ctx context.Context, job model.Job, steps []model.JobStep, edges []model.JobStepEdge) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.seedJobInTx(ctx, tx, job, steps, edges); err != nil {
		return err
	}
	return tx.Commit()
}

// SeedJobWithApplicationVersion atomically creates a revision job, its steps,
// and the queued immutable candidate version. The caller derives application
// and parent-version ids from server-side lineage before invoking this method.
func (s *Store) SeedJobWithApplicationVersion(ctx context.Context, job model.Job, steps []model.JobStep, version model.ApplicationVersion) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.seedJobInTx(ctx, tx, job, steps, nil); err != nil {
		return err
	}
	if version.CreatedAt.IsZero() {
		version.CreatedAt = time.Now()
	}
	if err := createApplicationVersion(ctx, tx, version); err != nil {
		return err
	}
	return tx.Commit()
}

// SeedClarificationJob atomically creates a confirmed clarification's generation
// job: it inserts the job row, all of its steps, and links the clarification
// session to the job inside a SINGLE transaction. If any statement fails the
// whole transaction rolls back, so a confirmation failure leaves NO orphaned job
// (and the caller marks the clarification failed). jobOnCreateStepHook, when
// non-nil, is invoked once per step insert and lets tests inject a mid-seed
// failure to verify rollback.
func (s *Store) SeedClarificationJob(ctx context.Context, job model.Job, steps []model.JobStep, clarificationID string) error {
	return s.SeedClarificationJobWithEdges(ctx, job, steps, nil, clarificationID)
}

// SeedClarificationJobWithEdges atomically creates a confirmed clarification's
// generation job WITH its collaboration-plan dependency edges: the job, its
// steps, its edges, AND the clarification-session link all commit in a SINGLE
// transaction. On failure the whole transaction rolls back, so a confirmation
// failure leaves NO orphaned job and the caller marks the clarification failed.
func (s *Store) SeedClarificationJobWithEdges(ctx context.Context, job model.Job, steps []model.JobStep, edges []model.JobStepEdge, clarificationID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if err := s.seedJobInTx(ctx, tx, job, steps, edges); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE clarification_sessions SET created_job_id = ?, updated_at = ? WHERE id = ?`,
		job.ID, ms(time.Now()), clarificationID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetJobStepSeedHook installs a callback invoked once per job-step insert
// inside SeedClarificationJob. It is a test seam used to inject a mid-seed
// failure so the atomic rollback contract can be verified; it has no effect in
// production (the field is always nil there).
func (s *Store) SetJobStepSeedHook(fn func(model.JobStep) error) {
	s.jobOnCreateStepHook = fn
}

// ListJobSteps returns the steps for a job ordered by sequence.
func (s *Store) ListJobSteps(ctx context.Context, jobID string) ([]model.JobStep, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, job_id, kind, seq, agent_key, status, attempt, started_at, ended_at, needs_user_input, user_prompt, pending_questions, error_code, error_message, claude_session_id, cc_status_session_id, snapshot_json
FROM job_steps
WHERE job_id = ?
ORDER BY seq`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.JobStep, 0)
	for rows.Next() {
		var st model.JobStep
		var kind, status, errorCode string
		var started, ended sql.NullInt64
		var needsUserInput int
		if err := rows.Scan(&st.ID, &st.JobID, &kind, &st.Seq, &st.AgentKey,
			&status, &st.Attempt, &started, &ended, &needsUserInput,
			&st.UserPrompt, &st.PendingQuestions, &errorCode, &st.ErrorMessage,
			&st.ClaudeSessionID, &st.CCStatusSessionID, &st.SnapshotJSON); err != nil {
			return nil, err
		}
		st.Kind = model.StepKind(kind)
		st.Status = model.StepStatus(status)
		st.ErrorCode = model.ErrorCode(errorCode)
		st.StartedAt = ptrFromMs(started)
		st.EndedAt = ptrFromMs(ended)
		st.NeedsUserInput = needsUserInput != 0
		out = append(out, st)
	}
	return out, rows.Err()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// scanJob reads a jobs row into *model.Job, handling the nullable
// started_at/ended_at columns. It works for both sql.Row and sql.Rows.
func scanJob(sc scanner) (*model.Job, error) {
	var j model.Job
	var status, stepKind string
	var createdMs, updatedMs int64
	var started, ended sql.NullInt64
	if err := sc.Scan(&j.ID, &j.UserPrompt, &j.NormalizedPrompt, &j.AppSlug, &j.AppName,
		&status, &stepKind, &j.CreatedAppID, &j.LockOwner,
		&createdMs, &started, &ended, &updatedMs,
		&j.ClarificationSessionID, &j.ConfirmedRequirementJSON,
		&j.DialogueID, &j.ApplicationID, &j.BaseVersionID, &j.Kind, &j.CollaborationPlanJSON); err != nil {
		return nil, err
	}
	j.Status = model.JobStatus(status)
	j.CurrentStepKind = model.StepKind(stepKind)
	j.CreatedAt = time.UnixMilli(createdMs)
	j.UpdatedAt = time.UnixMilli(updatedMs)
	j.StartedAt = ptrFromMs(started)
	j.EndedAt = ptrFromMs(ended)
	return &j, nil
}

// jobSelectCols lists the jobs columns in scan order, shared by GetJob and
// ListJobs to keep the SELECT and scanJob in sync.
const jobSelectCols = `id, user_prompt, normalized_prompt, app_slug, app_name, status, current_step_kind, created_app_id, lock_owner, created_at, started_at, ended_at, updated_at, clarification_session_id, confirmed_requirement_json, dialogue_id, application_id, base_version_id, kind, collaboration_plan_json`

// GetJob returns the job with the given id. It returns (nil, nil) on a miss —
// a missing row is not an error — mirroring GetApplication/GetAgent.
func (s *Store) GetJob(ctx context.Context, id string) (*model.Job, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+jobSelectCols+` FROM jobs WHERE id = ?`, id)
	j, err := scanJob(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return j, nil
}

// ListJobs returns jobs ordered newest-first. When status is non-empty the
// result is restricted to jobs in that status.
func (s *Store) ListJobs(ctx context.Context, status string) ([]model.Job, error) {
	q := `SELECT ` + jobSelectCols + ` FROM jobs`
	var (
		rows *sql.Rows
		err  error
	)
	if status != "" {
		rows, err = s.db.QueryContext(ctx, q+` WHERE status = ? ORDER BY created_at DESC`, status)
	} else {
		rows, err = s.db.QueryContext(ctx, q+` ORDER BY created_at DESC`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.Job, 0)
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *j)
	}
	return out, rows.Err()
}

// ListJobsByDialogue returns every job linked to a dialogue (via dialogue_id),
// oldest-first. deleteDialogue uses it to cancel any still-in-flight job before
// removing a dialogue the user can now delete in any status.
func (s *Store) ListJobsByDialogue(ctx context.Context, dialogueID string) ([]model.Job, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+jobSelectCols+` FROM jobs WHERE dialogue_id = ? ORDER BY created_at ASC`, dialogueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Job, 0)
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *j)
	}
	return out, rows.Err()
}

// CancelJob marks a job as canceled (status=canceled, ended_at=now,
// updated_at=now) and cancels the step currently pointed at by the job's
// current_step_kind, provided that step is not already in a terminal state
// (succeeded or canceled). A no-op when the job does not exist.
func (s *Store) CancelJob(ctx context.Context, jobID string) error {
	now := ms(time.Now())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Read the job's current step kind so we only cancel the in-flight step.
	var currentStep string
	switch err := tx.QueryRowContext(ctx, `SELECT current_step_kind FROM jobs WHERE id = ?`, jobID).Scan(&currentStep); {
	case err == sql.ErrNoRows:
		// Job missing: nothing to cancel, but commit the no-op transaction.
		return tx.Commit()
	case err != nil:
		return err
	}

	if _, err := tx.ExecContext(ctx, `
UPDATE jobs
SET status = ?, ended_at = ?, updated_at = ?
WHERE id = ?`, string(model.JobStatusCanceled), now, now, jobID); err != nil {
		return err
	}

	if currentStep != "" {
		// Cancel the in-flight step, leaving already-terminal steps (succeeded /
		// canceled) untouched.
		if _, err := tx.ExecContext(ctx, `
UPDATE job_steps
SET status = ?, ended_at = ?
WHERE job_id = ? AND kind = ? AND status NOT IN (?, ?)`,
			string(model.StepStatusCanceled), now, jobID, currentStep,
			string(model.StepStatusSucceeded), string(model.StepStatusCanceled)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetOldestQueuedJob returns the oldest job (lowest created_at) still in the
// queued state — the next job the executor should run. It returns (nil, nil)
// when no queued job exists.
func (s *Store) GetOldestQueuedJob(ctx context.Context) (*model.Job, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+jobSelectCols+` FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1`, string(model.JobStatusQueued))
	j, err := scanJob(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return j, nil
}

// ClaimNextRunnableJob atomically claims the next job a worker should run:
// the oldest QUEUED job whose app_slug has NO currently RUNNING job, flipped to
// running with lock_owner stamped and started_at stamped on first run. It
// returns (nil, nil) when no such job exists (every queued job's app already has
// a running job, or nothing is queued).
//
// ATOMICITY: the claim is a BeginTx→SELECT→UPDATE→Commit transaction (two
// statements), NOT a single UPDATE. Atomicity depends on the single-connection
// pool (store.Open pins SetMaxOpenConns(1)): concurrent workers' BeginTx calls
// serialize on that one connection, so worker B cannot begin until worker A
// commits — its SELECT then sees the row already flipped to running. Do NOT
// raise SetMaxOpenConns (e.g. for read concurrency) without first collapsing
// the SELECT+UPDATE into a single conditional UPDATE: a bare
// SELECT-then-UPDATE double-claims once the pool can hand out >1 connection,
// because Go's database/sql releases the connection back to the pool between the
// two statements and two workers can SELECT the same queued row before either
// UPDATEs.
//
// SERIALIZATION KEY IS app_slug (NOT application_id). Two jobs for the same app
// both write generated-apps/<slug>/ and the same image tag — a destructive race
// — so the claim must serialize them by slug. application_id is empty for
// generation jobs until the app registers mid-run, so keying the claim on it
// would fail to serialize same-app generation jobs. app_slug is the stable
// per-lineage key present at seed for BOTH job kinds: generation pre-allocates
// it (dialogue_handlers.go), and modification targets an existing app whose slug
// is known. The claim therefore excludes queued jobs whose app_slug matches any
// running job's app_slug.
func (s *Store) ClaimNextRunnableJob(ctx context.Context, workerID string) (*model.Job, error) {
	now := ms(time.Now())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// Inside the transaction: SELECT the oldest eligible queued job, then UPDATE
	// it to running by id. Because the pool has a single connection
	// (SetMaxOpenConns(1)), a second worker's BeginTx blocks until this tx
	// commits — so its SELECT cannot see the same queued row the first worker is
	// about to flip. This serialization is the atomicity guarantee; it relies on
	// the single-connection pool, NOT on SQLite's writer lock alone.
	var jobID string
	err = tx.QueryRowContext(ctx, `
SELECT j.id FROM jobs j
WHERE j.status = ?
  AND NOT EXISTS (
    SELECT 1 FROM jobs r
    WHERE r.status IN (?, ?) AND r.app_slug = j.app_slug AND r.app_slug <> ''
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs r
    WHERE r.status IN (?, ?) AND r.app_slug = '' AND j.app_slug = ''
  )
ORDER BY j.created_at ASC
LIMIT 1`,
		string(model.JobStatusQueued),
		string(model.JobStatusRunning),
		string(model.JobStatusWaitingUser),
		string(model.JobStatusRunning),
		string(model.JobStatusWaitingUser)).Scan(&jobID)
	if err == sql.ErrNoRows {
		// Nothing eligible: commit the read tx (no write lock held) and return.
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE jobs
SET status = ?, lock_owner = ?, started_at = COALESCE(started_at, ?), updated_at = ?
WHERE id = ?`,
		string(model.JobStatusRunning), workerID, now, now, jobID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// Re-read so the returned job reflects the flipped status + started_at.
	return s.GetJob(ctx, jobID)
}

// CountRunningJobsByAppSlug returns the number of jobs currently in the running
// state for the given app_slug. rebuildApp uses it to scope the executor-busy
// conflict per app: a rebuild conflicts only with a running JOB for the same
// app, not with jobs of unrelated apps.
func (s *Store) CountRunningJobsByAppSlug(ctx context.Context, appSlug string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM jobs WHERE status = ? AND app_slug = ?`,
		string(model.JobStatusRunning), appSlug).Scan(&n)
	return n, err
}

// CountRecentRunningJobsByAppSlug returns running jobs for appSlug whose store
// row was updated at or after since. It lets operators rebuild after a crashed
// executor leaves an old running row behind, while still serializing against a
// currently active same-app pipeline.
func (s *Store) CountRecentRunningJobsByAppSlug(ctx context.Context, appSlug string, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM jobs WHERE status = ? AND app_slug = ? AND updated_at >= ?`,
		string(model.JobStatusRunning), appSlug, ms(since)).Scan(&n)
	return n, err
}

// MarkJobRunning flips a job to running, sets lock_owner, stamps started_at the
// first time the job runs, and bumps updated_at.
func (s *Store) MarkJobRunning(ctx context.Context, jobID, lockOwner string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs
SET status = ?, lock_owner = ?, started_at = COALESCE(started_at, ?), updated_at = ?
WHERE id = ?`,
		string(model.JobStatusRunning), lockOwner, now, now, jobID)
	return err
}

// AdvanceJobStep moves the job's current_step_kind pointer to nextKind and
// bumps updated_at. Called after a step succeeds and is not the final step.
func (s *Store) AdvanceJobStep(ctx context.Context, jobID string, nextKind model.StepKind) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs SET current_step_kind = ?, updated_at = ? WHERE id = ?`,
		string(nextKind), now, jobID)
	return err
}

// MarkJobCompleted sets a job to its terminal completed state with ended_at.
func (s *Store) MarkJobCompleted(ctx context.Context, jobID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
		string(model.JobStatusCompleted), now, now, jobID)
	return err
}

// MarkJobFailed sets a job to its terminal failed state with ended_at.
func (s *Store) MarkJobFailed(ctx context.Context, jobID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
		string(model.JobStatusFailed), now, now, jobID)
	return err
}

// MarkJobQueued flips a job back to queued (used on retry). updated_at bumped.
func (s *Store) MarkJobQueued(ctx context.Context, jobID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`,
		string(model.JobStatusQueued), now, jobID)
	return err
}

// MarkJobCanceled sets a job to the terminal canceled state with ended_at. Used
// by the executor when an in-flight step's ctx is cancelled.
func (s *Store) MarkJobCanceled(ctx context.Context, jobID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
		string(model.JobStatusCanceled), now, now, jobID)
	return err
}
func (s *Store) MarkJobWaitingUser(ctx context.Context, jobID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`,
		string(model.JobStatusWaitingUser), now, jobID)
	return err
}

// SetJobCreatedApp links a job to the application its code_generation step
// produced: it stamps created_app_id, app_slug and app_name and bumps updated_at.
// It is called by the fake-claude (and, later, the real claude) runner after it
// registers the generated app, so the factory steps can resolve the app via
// CreatedAppID instead of relying on the slug alone.
func (s *Store) SetJobCreatedApp(ctx context.Context, jobID, appID, slug, name string) error {
	now := ms(time.Now())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
UPDATE jobs SET created_app_id = ?, application_id = ?, app_slug = ?, app_name = ?, updated_at = ? WHERE id = ?`,
		appID, appID, slug, name, now, jobID); err != nil {
		return err
	}
	var dialogueID string
	if err := tx.QueryRowContext(ctx, `SELECT dialogue_id FROM jobs WHERE id = ?`, jobID).Scan(&dialogueID); err != nil {
		return err
	}
	if dialogueID != "" {
		if _, err := tx.ExecContext(ctx, `
UPDATE dialogue_sessions
SET resolved_application_id = ?, status = CASE WHEN status = ? THEN ? ELSE status END, updated_at = ?
WHERE id = ?`, appID, string(model.DialogueStatusTaskRunning), string(model.DialogueStatusActive), now, dialogueID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetLatestJobForApplication returns the newest job that produced or targets
// appID. Revision confirmation reuses its server-confirmed requirement rather
// than accepting a requirement payload from the browser.
func (s *Store) GetLatestJobForApplication(ctx context.Context, appID string) (*model.Job, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+jobSelectCols+`
FROM jobs WHERE application_id = ? OR created_app_id = ?
ORDER BY created_at DESC LIMIT 1`, appID, appID)
	j, err := scanJob(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return j, err
}

// MarkStepRunning flips a step to running, bumps attempt, and stamps started_at
// on its first attempt. updated via started_at set + the attempt counter.
func (s *Store) MarkStepRunning(ctx context.Context, stepID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps
SET status = ?, started_at = COALESCE(started_at, ?), ended_at = NULL,
    error_code = '', error_message = '', needs_user_input = 0
WHERE id = ?`,
		string(model.StepStatusRunning), now, stepID)
	return err
}

// IncrementStepAttempt atomically bumps the step's attempt counter.
func (s *Store) IncrementStepAttempt(ctx context.Context, stepID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE job_steps SET attempt = attempt + 1 WHERE id = ?`, stepID)
	return err
}

// MarkStepSucceeded flips a step to succeeded with ended_at.
func (s *Store) MarkStepSucceeded(ctx context.Context, stepID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps SET status = ?, ended_at = ? WHERE id = ?`,
		string(model.StepStatusSucceeded), now, stepID)
	return err
}

// MarkStepFailed flips a step to failed with ended_at + the error details.
func (s *Store) MarkStepFailed(ctx context.Context, stepID string, code model.ErrorCode, msg string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps SET status = ?, ended_at = ?, error_code = ?, error_message = ? WHERE id = ?`,
		string(model.StepStatusFailed), now, string(code), msg, stepID)
	return err
}

// MarkStepWaitingUser flips a step to waiting_user, recording whether the
// runner asked for user input and persisting the clarifying questions (JSON)
// the step raised so the job detail can surface them to the user.
func (s *Store) MarkStepWaitingUser(ctx context.Context, stepID, questionsJSON string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps SET status = ?, needs_user_input = 1, pending_questions = ?, ended_at = NULL WHERE id = ?`,
		string(model.StepStatusWaitingUser), questionsJSON, stepID)
	return err
}

// MarkStepCanceled flips a step to canceled with ended_at.
func (s *Store) MarkStepCanceled(ctx context.Context, stepID string) error {
	now := ms(time.Now())
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps SET status = ?, ended_at = ? WHERE id = ?`,
		string(model.StepStatusCanceled), now, stepID)
	return err
}

// GetStepByKind returns the step for the given job whose kind matches, or
// (nil, nil) if there is no such step.
func (s *Store) GetStepByKind(ctx context.Context, jobID string, kind model.StepKind) (*model.JobStep, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, job_id, kind, seq, agent_key, status, attempt, started_at, ended_at, needs_user_input, user_prompt, pending_questions, error_code, error_message, claude_session_id, cc_status_session_id, snapshot_json
FROM job_steps WHERE job_id = ? AND kind = ?`, jobID, string(kind))
	var st model.JobStep
	var kstatus, errorCode, kkind string
	var started, ended sql.NullInt64
	var needsUserInput int
	if err := row.Scan(&st.ID, &st.JobID, &kkind, &st.Seq, &st.AgentKey,
		&kstatus, &st.Attempt, &started, &ended, &needsUserInput,
		&st.UserPrompt, &st.PendingQuestions, &errorCode, &st.ErrorMessage,
		&st.ClaudeSessionID, &st.CCStatusSessionID, &st.SnapshotJSON); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	st.Kind = model.StepKind(kkind)
	st.Status = model.StepStatus(kstatus)
	st.ErrorCode = model.ErrorCode(errorCode)
	st.StartedAt = ptrFromMs(started)
	st.EndedAt = ptrFromMs(ended)
	st.NeedsUserInput = needsUserInput != 0
	return &st, nil
}

// ResetStepToPending flips a step back to pending (clearing ended_at and error
// fields) so it can be re-run on retry. The attempt counter is intentionally
// NOT reset here — IncrementStepAttempt is called again when the step next
// moves to running, so retries are visible as attempt+1.
func (s *Store) ResetStepToPending(ctx context.Context, stepID string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps
SET status = ?, ended_at = NULL, error_code = '', error_message = '', needs_user_input = 0, pending_questions = '', started_at = NULL
WHERE id = ?`,
		string(model.StepStatusPending), stepID)
	return err
}

// SetStepUserPrompt stores per-step operator context. The executor uses this
// for repair-from-failure runs so the next code_generation attempt receives the
// failed test/image-build output without changing the job's original prompt.
func (s *Store) SetStepUserPrompt(ctx context.Context, stepID, prompt string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps
SET user_prompt = ?
WHERE id = ?`, prompt, stepID)
	return err
}

// SetStepSnapshot overwrites the per-task snapshot (job_steps.snapshot_json)
// for a step. This is the editable copy that affects ONLY this generation task;
// it never writes back to the global agents/skills registry.
func (s *Store) SetStepSnapshot(ctx context.Context, stepID, snapshotJSON string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps
SET snapshot_json = ?
WHERE id = ?`, snapshotJSON, stepID)
	return err
}

// SetJobCollaborationPlan overwrites the job's collaboration_plan_json. The
// executor uses it to persist the bounded-repair state (repairState counters)
// back into the plan document it already carries. Modeled on SetStepUserPrompt.
func (s *Store) SetJobCollaborationPlan(ctx context.Context, jobID, planJSON string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE jobs
SET collaboration_plan_json = ?
WHERE id = ?`, planJSON, jobID)
	return err
}

// AddConversation inserts a conversation message row.
func (s *Store) AddConversation(ctx context.Context, msg model.ConversationMessage) error {
	var jobID any
	if msg.JobID != "" {
		jobID = msg.JobID
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO conversations(id, job_id, role, content, metadata_json, created_at)
VALUES(?,?,?,?,?,?)`,
		msg.ID, jobID, msg.Role, msg.Content, msg.MetadataJSON, ms(msg.CreatedAt))
	return err
}

// ListArtifactsByJob returns artifacts for a job ordered by created_at.
func (s *Store) ListArtifactsByJob(ctx context.Context, jobID string) ([]model.Artifact, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, job_id, step_id, attempt, kind, path, summary, created_at
FROM artifacts
WHERE job_id = ?
ORDER BY created_at`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.Artifact, 0)
	for rows.Next() {
		var a model.Artifact
		var createdMs int64
		if err := rows.Scan(&a.ID, &a.JobID, &a.StepID, &a.Attempt, &a.Kind, &a.Path, &a.Summary, &createdMs); err != nil {
			return nil, err
		}
		a.CreatedAt = time.UnixMilli(createdMs)
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetArtifact returns the artifact with the given id. It returns (nil, nil) on
// a miss — a missing row is not an error.
func (s *Store) GetArtifact(ctx context.Context, id string) (*model.Artifact, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, job_id, step_id, attempt, kind, path, summary, created_at
FROM artifacts
WHERE id = ?`, id)
	var a model.Artifact
	var createdMs int64
	if err := row.Scan(&a.ID, &a.JobID, &a.StepID, &a.Attempt, &a.Kind, &a.Path, &a.Summary, &createdMs); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	a.CreatedAt = time.UnixMilli(createdMs)
	return &a, nil
}

// CreateArtifact inserts a new artifact row. It is used by the content route's
// tests and (later) by the executor when it records step outputs.
func (s *Store) CreateArtifact(ctx context.Context, a model.Artifact) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO artifacts(id, job_id, step_id, attempt, kind, path, summary, created_at)
VALUES(?,?,?,?,?,?,?,?)`,
		a.ID, a.JobID, a.StepID, a.Attempt, a.Kind, a.Path, a.Summary, ms(a.CreatedAt))
	return err
}
