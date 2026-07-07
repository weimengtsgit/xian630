package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestApplicationUpsertAndList(t *testing.T) {
	st := newTestStore(t)
	app := model.Application{
		ID:           "app_1",
		Slug:         "east-sea-situation",
		Name:         "东海目标态势演示",
		Type:         "map-dashboard",
		Source:       model.AppSourcePreset,
		Description:  "preset scene",
		Path:         "scene/east-sea-situation",
		ManifestPath: "scene/east-sea-situation/.factory/app.json",
		Status:       model.AppStatusStopped,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
	if err := st.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	apps, err := st.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(apps) != 1 || apps[0].Slug != "east-sea-situation" {
		t.Fatalf("apps = %#v", apps)
	}
}

func TestJobWithSteps(t *testing.T) {
	st := newTestStore(t)
	job := model.Job{
		ID:              "job_1",
		UserPrompt:      "生成航母编队月度航迹复盘",
		Status:          model.JobStatusQueued,
		CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	step := model.JobStep{
		ID:       "step_1",
		JobID:    "job_1",
		Kind:     model.StepRequirementAnalysis,
		Seq:      1,
		AgentKey: "requirement-analyst",
		Status:   model.StepStatusPending,
		Attempt:  0,
	}
	if err := st.CreateJobStep(context.Background(), step); err != nil {
		t.Fatalf("create step: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), "job_1")
	if err != nil {
		t.Fatalf("list steps: %v", err)
	}
	if len(steps) != 1 || steps[0].Kind != model.StepRequirementAnalysis {
		t.Fatalf("steps = %#v", steps)
	}
}

// TestOpenMigratesStepExecutionRecordsIdempotently proves the CREATE TABLE IF
// NOT EXISTS migration is safe to run against an existing database that already
// has the table (e.g. a real ~/.software-factory/state.db across versions).
func TestOpenMigratesStepExecutionRecordsIdempotently(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "state.db")

	// First open: schema applied, table created.
	st1, err := Open(dbPath)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	appendRecord(t, st1, "job_m", "step_m", 1, 1, "system", "seed")
	if err := st1.Close(); err != nil {
		t.Fatalf("close st1: %v", err)
	}

	// Second open against the SAME on-disk database: must not error and must
	// preserve the seeded row.
	st2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("second open (migration): %v", err)
	}
	t.Cleanup(func() { _ = st2.Close() })

	got, err := st2.ListStepExecutionRecordPage(context.Background(), "job_m", "step_m", 1, 0, 200)
	if err != nil {
		t.Fatalf("list after reopen: %v", err)
	}
	if len(got) != 1 || got[0].Content != "seed" {
		t.Fatalf("seed row lost across reopen: %#v", got)
	}
}

// TestOpenMigratesContinuousWorkbenchLegacyDB verifies that a database written
// by a pre-Workbench build upgrades cleanly when reopened by the current code:
//
//   - the four jobs lineage columns (dialogue_id/application_id/base_version_id/
//     kind) are backfilled via ensureColumn;
//   - the application_versions, dialogue_turns, and work_trace_events tables are
//     created (CREATE TABLE IF NOT EXISTS);
//   - a legacy RESOLVED dialogue is backfilled to ACTIVE by
//     BackfillResolvedDialoguesToActive, preserving its audit links;
//   - the pre-existing dialogue/job/application/deployment rows remain readable
//     (no data loss);
//   - re-opening the upgraded DB is a no-op (idempotent).
//
// TestOpenMigratesJobsCollaborationPlan reproduces the "/api/jobs 500 list jobs"
// failure: a DB created before jobs.collaboration_plan_json shipped lacks the
// column (CREATE TABLE IF NOT EXISTS never re-adds it to an existing table), and
// without an ensureColumn backfill the ListJobs SELECT fails with
// "no such column: collaboration_plan_json". Open() must backfill it.
func TestOpenMigratesJobsCollaborationPlan(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "state.db")
	now := time.Now()

	seed, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	if err := seed.CreateJob(ctx, model.Job{
		ID: "job_cp", UserPrompt: "协作计划", NormalizedPrompt: "协作计划",
		AppSlug: "cp-app", AppName: "协作应用", Status: model.JobStatusCompleted,
		CurrentStepKind: model.StepDeployment, CreatedAppID: "app_cp",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		seed.Close()
		t.Fatalf("seed job: %v", err)
	}
	// Degrade to the pre-collaboration-plan shape, mimicking an on-disk DB from
	// before the column existed.
	if _, err := seed.db.Exec(`ALTER TABLE jobs DROP COLUMN collaboration_plan_json`); err != nil {
		seed.Close()
		t.Fatalf("degrade drop collaboration_plan_json: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	st, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open upgraded db: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// ListJobs SELECTs collaboration_plan_json (see jobSelectCols); after the
	// backfill migration it must succeed and return the seeded row.
	jobs, err := st.ListJobs(ctx, "")
	if err != nil {
		t.Fatalf("ListJobs after migrate: %v", err)
	}
	if len(jobs) != 1 || jobs[0].ID != "job_cp" {
		t.Fatalf("expected seeded job_cp, got %+v", jobs)
	}
}

func TestOpenMigratesJobStepsSnapshotJSON(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "state.db")
	now := time.Now()

	seed, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	if err := seed.CreateJob(ctx, model.Job{
		ID: "job_snap", UserPrompt: "生成应用", NormalizedPrompt: "生成应用",
		Status: model.JobStatusQueued, CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		seed.Close()
		t.Fatalf("seed job: %v", err)
	}
	if err := seed.CreateJobStep(ctx, model.JobStep{
		ID: "step_old", JobID: "job_snap", Kind: model.StepRequirementAnalysis,
		Seq: 1, Status: model.StepStatusPending,
	}); err != nil {
		seed.Close()
		t.Fatalf("seed step: %v", err)
	}
	// 模拟旧版本磁盘库：job_steps 表存在，但还没有后续代码写入的快照列。
	if _, err := seed.db.Exec(`ALTER TABLE job_steps DROP COLUMN snapshot_json`); err != nil {
		seed.Close()
		t.Fatalf("degrade drop snapshot_json: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	st, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open upgraded db: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	if err := st.CreateJobStep(ctx, model.JobStep{
		ID: "step_new", JobID: "job_snap", Kind: model.StepSolutionDesign,
		Seq: 2, Status: model.StepStatusPending, SnapshotJSON: `{"agent":"solution"}`,
	}); err != nil {
		t.Fatalf("CreateJobStep after migrate: %v", err)
	}
	steps, err := st.ListJobSteps(ctx, "job_snap")
	if err != nil {
		t.Fatalf("ListJobSteps after migrate: %v", err)
	}
	if len(steps) != 2 || steps[1].SnapshotJSON != `{"agent":"solution"}` {
		t.Fatalf("migrated steps = %+v", steps)
	}
}

// To produce a realistic "prior" database without guessing the exact historical
// column set, the test opens the current schema once, then strips it back to the
// pre-Workbench shape (drops the four jobs columns and the three new tables)
// before seeding legacy rows. The second Open() then exercises the real
// migration code path (ensureColumn + CREATE TABLE IF NOT EXISTS) against that
// degraded DB.
func TestOpenMigratesContinuousWorkbenchLegacyDB(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "state.db")
	now := time.Now()

	// --- Phase 1: open the full schema, seed legacy rows via the typed API, then
	// degrade the DB to the pre-Workbench shape. Seeding first (against the full
	// schema) guarantees the rows match the current column set; the subsequent
	// column drops remove only the Workbench lineage columns, leaving the seeded
	// rows intact in the columns that predate the plan. ---
	seed, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	// Seed prior-shape rows: a resolved dialogue, a pre-version job, an
	// application, and a deployment — exactly as a pre-Workbench build would have
	// written them (the lineage columns and version rows did not exist yet; we
	// leave them unset here so the degrade faithfully reproduces that state).
	if err := seed.SyncApplications(ctx, []model.Application{{
		ID: "app_legacy", Slug: "legacy-app", Name: "遗留应用", Type: "situation_replay",
		Source: model.AppSourcePreset, Status: model.AppStatusRunning,
		Path: "scene/legacy-app", RuntimeURL: "http://localhost:5173", CreatedAt: now, UpdatedAt: now,
	}}); err != nil {
		seed.Close()
		t.Fatalf("seed app: %v", err)
	}
	if err := seed.CreateJob(ctx, model.Job{
		ID: "job_legacy", UserPrompt: "生成遗留应用", NormalizedPrompt: "生成遗留应用",
		AppSlug: "legacy-app", AppName: "遗留应用", Status: model.JobStatusCompleted,
		CurrentStepKind: model.StepDeployment, CreatedAppID: "app_legacy",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		seed.Close()
		t.Fatalf("seed job: %v", err)
	}
	if err := seed.CreateDeployment(ctx, model.Deployment{
		ID: "dep_legacy", AppID: "app_legacy", JobID: "job_legacy",
		ImageName: "img", ImageTag: "tag", ContainerName: "sf-legacy",
		HostPort: 5173, ContainerPort: 8080, URL: "http://localhost:5173",
		Status: "running", CreatedAt: now, StartedAt: &now,
	}); err != nil {
		seed.Close()
		t.Fatalf("seed deployment: %v", err)
	}
	if err := seed.CreateDialogueSession(ctx, model.DialogueSession{
		ID: "dlg_legacy", InitialPrompt: "遗留对话", Status: model.DialogueStatusResolved,
		Intent: model.DialogueIntentApplicationGeneration, RouteLocked: true,
		ResolvedApplicationID: "app_legacy", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		seed.Close()
		t.Fatalf("seed dialogue: %v", err)
	}
	if err := seed.AppendDialogueMessage(ctx, model.DialogueMessage{
		ID: "dmsg_legacy", DialogueID: "dlg_legacy", Role: "user", Kind: "text",
		Content: "遗留消息", CreatedAt: now,
	}); err != nil {
		seed.Close()
		t.Fatalf("seed message: %v", err)
	}
	// Degrade: remove the Workbench additions so the on-disk DB mimics a pre-plan
	// build. The seeded rows in jobs/dialogue_sessions/etc. survive because the
	// dropped columns are Workbench-only; the legacy data lives in older columns.
	degradeDDL := []string{
		`ALTER TABLE jobs DROP COLUMN dialogue_id`,
		`ALTER TABLE jobs DROP COLUMN application_id`,
		`ALTER TABLE jobs DROP COLUMN base_version_id`,
		`ALTER TABLE jobs DROP COLUMN kind`,
		`DROP TABLE IF EXISTS application_versions`,
		`DROP TABLE IF EXISTS dialogue_turns`,
		`DROP TABLE IF EXISTS work_trace_events`,
	}
	for _, ddl := range degradeDDL {
		if _, err := seed.db.Exec(ddl); err != nil {
			seed.Close()
			t.Fatalf("degrade ddl (%s): %v", ddl, err)
		}
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	// --- Phase 2: reopen with the CURRENT Open() (schema + ensureColumn). ---
	st, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open upgraded db: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// The four lineage columns now exist and default empty on the legacy row.
	job, err := st.GetJob(ctx, "job_legacy")
	if err != nil || job == nil {
		t.Fatalf("legacy job unreadable after upgrade: %v", err)
	}
	if job.DialogueID != "" || job.ApplicationID != "" || job.BaseVersionID != "" || job.Kind != "" {
		t.Fatalf("legacy job lineage columns not defaulted empty: %+v", job)
	}

	// The new tables exist and are writable (CREATE TABLE IF NOT EXISTS added them).
	ver, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_new", ApplicationID: "app_legacy", JobID: "job_new",
		Status: model.ApplicationVersionEffective, CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("application_versions not migrated/usable: %v", err)
	}
	if eff, err := st.GetEffectiveApplicationVersion(ctx, "app_legacy"); err != nil || eff == nil || eff.ID != ver.ID {
		t.Fatalf("effective version unreadable after migrate: %v (%+v)", err, eff)
	}
	if err := st.CreateDialogueTurn(ctx, model.DialogueTurn{
		ID: "turn_new", DialogueID: "dlg_legacy", MessageID: "dmsg_new",
		Status: model.TurnStatusPending, CreatedAt: now,
	}); err != nil {
		t.Fatalf("dialogue_turns not migrated/usable: %v", err)
	}
	if _, err := st.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		DialogueID: "dlg_legacy", Type: string(model.WorkTraceIntent), PayloadJSON: `{"note":"ok"}`,
	}); err != nil {
		t.Fatalf("work_trace_events not migrated/usable: %v", err)
	}

	// --- Phase 3: the startup backfill flips resolved → active, preserving audit. ---
	if err := st.BackfillResolvedDialoguesToActive(ctx); err != nil {
		t.Fatalf("backfill resolved→active: %v", err)
	}
	dlg, err := st.GetDialogueSession(ctx, "dlg_legacy")
	if err != nil || dlg == nil {
		t.Fatalf("legacy dialogue unreadable after backfill: %v", err)
	}
	if dlg.Status != model.DialogueStatusActive {
		t.Fatalf("resolved dialogue not backfilled to active: %q", dlg.Status)
	}
	if dlg.ResolvedApplicationID != "app_legacy" {
		t.Fatalf("audit link lost in backfill: resolved_application_id=%q", dlg.ResolvedApplicationID)
	}

	// The legacy application, deployment, and message rows survive the upgrade.
	if app, err := st.GetApplication(ctx, "app_legacy"); err != nil || app == nil || app.Slug != "legacy-app" {
		t.Fatalf("legacy application lost after upgrade: %v (%+v)", err, app)
	}
	if dep, err := st.GetDeployment(ctx, "dep_legacy"); err != nil || dep == nil || dep.Status != "running" {
		t.Fatalf("legacy deployment lost after upgrade: %v (%+v)", err, dep)
	}
	msgs, err := st.LatestDialogueMessages(ctx, "dlg_legacy", 50)
	if err != nil || len(msgs) != 1 || msgs[0].ID != "dmsg_legacy" {
		t.Fatalf("legacy dialogue message lost after upgrade: %v (%+v)", err, msgs)
	}

	// --- Phase 4: re-open is a no-op (idempotent). Rows and status unchanged. ---
	if err := st.Close(); err != nil {
		t.Fatalf("close before reopen: %v", err)
	}
	st2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("idempotent reopen: %v", err)
	}
	t.Cleanup(func() { _ = st2.Close() })
	if err := st2.BackfillResolvedDialoguesToActive(ctx); err != nil {
		t.Fatalf("idempotent backfill: %v", err)
	}
	dlg2, _ := st2.GetDialogueSession(ctx, "dlg_legacy")
	if dlg2 == nil || dlg2.Status != model.DialogueStatusActive {
		t.Fatalf("dialogue status changed on idempotent reopen: %+v", dlg2)
	}
	job2, _ := st2.GetJob(ctx, "job_legacy")
	if job2 == nil || job2.ID != "job_legacy" {
		t.Fatalf("legacy job lost on idempotent reopen: %+v", job2)
	}
}
