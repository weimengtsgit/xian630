package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// fakeClarRunner is a runner.CommandRunner that returns a canned clarification
// RoundOutput as JSON stdout. The tests inject it into srv.clarifier so the
// real claude CLI is never invoked. clarification.Runner.RunRound decodes the
// stdout it returns into a RoundOutput.
type fakeClarRunner struct {
	stdout  string // JSON RoundOutput to emit on success
	exitErr bool   // when true, Run returns a non-zero exit code (no Go error)
}

func (f fakeClarRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	if f.exitErr {
		// Mirror the real CLI's non-zero-exit contract: no Go error, but a
		// failing exit code, which clarification.Runner.RunRound turns into a
		// "claude exit N" error.
		return runner.CommandResult{ExitCode: 2, Stderr: "boom"}, nil
	}
	return runner.CommandResult{ExitCode: 0, Stdout: f.stdout}, nil
}

type sequenceClarRunner struct {
	outputs []string
	calls   int
}

func (f *sequenceClarRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	f.calls++
	if len(f.outputs) == 0 {
		return runner.CommandResult{ExitCode: 0, Stdout: waitingUserOutput}, nil
	}
	index := f.calls - 1
	if index >= len(f.outputs) {
		index = len(f.outputs) - 1
	}
	return runner.CommandResult{ExitCode: 0, Stdout: f.outputs[index]}, nil
}

// waitingUserOutput is a canned RoundOutput whose status is waiting_user, so the
// session stays in-flight after round 1 (no job yet).
const waitingUserOutput = `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"analysis","content":"需要明确目标用户"}],
  "questions": [{"id":"q1","label":"用户","question":"面向哪类用户?","options":[{"value":"ops","label":"作战参谋"}]}],
  "requirement": {"appType":"situation_replay","appName":"复盘应用","generationProfile":{"base":["software-factory-app"]}}
}`

// readyToConfirmOutput drives the session to ready_to_confirm so the confirm
// handler can validate required fields and create a job. Its requirement carries
// the COMPLETE required-field set (appType, appName, targetUsers, coreScenario,
// primaryView, mainEntities, dataPolicy, acceptanceFocus, generationProfile) so
// it passes the full required-fields gate confirmClarification now enforces (P1#2).
const readyToConfirmOutput = `{
  "status": "ready_to_confirm",
  "round": 2,
  "workLog": [{"type":"analysis","content":"需求已收敛"}],
  "questions": [],
  "requirement": {
    "appType": "situation_replay",
    "appName": "航母编队复盘应用",
    "targetUsers": ["作战参谋"],
    "coreScenario": "复盘近 1 个月航迹",
    "primaryView": "地图 + 时间轴",
    "mainEntities": ["编队","事件"],
    "dataPolicy": "mock_data",
    "acceptanceFocus": ["轨迹联动"],
    "generationProfile": {"base":["software-factory-app"],"domain":["defense-operations-ui"],"pattern":["map-timeline-replay"]}
  }
}`

const llmConfirmedOutput = `{
  "status": "confirmed",
  "round": 1,
  "workLog": [{"type":"ready","content":"需求规格已就绪"}],
  "questions": [],
  "requirement": {
    "appType": "command_dashboard",
    "appName": "航母母港潮汐窗口计算器",
    "targetUsers": ["作战指挥人员"],
    "coreScenario": "四大母港潮汐窗口监控",
    "primaryView": "2×2 港口卡片矩阵",
    "mainEntities": ["港口","潮汐"],
    "dataPolicy": "mock_then_api",
    "acceptanceFocus": ["窗口计算"],
    "generationProfile": {"base":["software-factory-app"]}
  }
}`

const waitingNoQuestionsCompleteOutput = `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"ready","content":"需求规格已就绪但状态写错"}],
  "questions": [],
  "requirement": {
    "appType": "command_dashboard",
    "appName": "航母母港潮汐窗口计算器",
    "targetUsers": ["作战指挥人员"],
    "coreScenario": "四大母港潮汐窗口监控",
    "primaryView": "2×2 港口卡片矩阵",
    "mainEntities": ["港口","潮汐"],
    "dataPolicy": "mock_then_api",
    "acceptanceFocus": ["窗口计算"],
    "generationProfile": {"base":["software-factory-app"]}
  }
}`

// newClarTestServer builds an in-memory test Server and overrides its unexported
// clarifier with one backed by the given fake runner. It mirrors the existing
// newJobsTestServer harness (in-memory store, routes registered) and reuses the
// package-shared doJSON helper. WorkspaceRoot/ArtifactRoot point at temp dirs so
// clarification.Runner.RunRound can write its round artifacts without touching
// the real workspace.
func newClarTestServer(t *testing.T, fake runner.CommandRunner) (*Server, *Router, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv := New(config.Config{ArtifactRoot: t.TempDir(), WorkspaceRoot: t.TempDir()}, st, scanner.Scanner{})
	srv.clarifier = clarification.Runner{
		Cmd:           fake,
		WorkspaceRoot: t.TempDir(),
		ArtifactRoot:  t.TempDir(),
	}
	return srv, srv.routes(), st
}

// doPost is a thin wrapper that JSON-encodes the body and dispatches through the
// router. It mirrors doJSON but is named distinctly here for clarity.
func doPost(t *testing.T, r *Router, method, path string, body any) *httptest.ResponseRecorder {
	return doJSON(t, r, method, path, body)
}

// TestCreateClarificationDoesNotCreateJob verifies that POST /api/clarifications
// creates a session (201) and does NOT create a generation Job — a job is only
// created on confirm. The fake clarifier returns a waiting_user round so the
// session stays active.
func TestCreateClarificationDoesNotCreateJob(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	req := httptest.NewRequest(http.MethodPost, "/api/clarifications", strings.NewReader(`{"prompt":"生成一个航母编队复盘应用"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}

	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %#v, want none before confirmation", jobs)
	}

	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusWaitingUser {
		t.Fatalf("session status = %q, want waiting_user", sess.Status)
	}
	if sess.Round != 1 {
		t.Fatalf("session round = %d, want 1", sess.Round)
	}
}

func TestCreateClarificationTreatsLLMConfirmedAsReadyToConfirm(t *testing.T) {
	_, r, _ := newClarTestServer(t, fakeClarRunner{stdout: llmConfirmedOutput})

	rec := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母母港潮汐窗口计算器"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("session status = %q, want ready_to_confirm", sess.Status)
	}
	if sess.Round != 1 {
		t.Fatalf("round = %d, want 1", sess.Round)
	}
}

func TestCreateClarificationTreatsCompleteNoQuestionOutputAsReadyToConfirm(t *testing.T) {
	_, r, _ := newClarTestServer(t, fakeClarRunner{stdout: waitingNoQuestionsCompleteOutput})

	rec := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母母港潮汐窗口计算器"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("session status = %q, want ready_to_confirm", sess.Status)
	}
}

func TestGetActiveClarificationNormalizesLegacyCompleteWaitingSession(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母母港潮汐窗口计算器"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	completeReq := `{"appType":"command_dashboard","appName":"航母母港潮汐窗口计算器","targetUsers":["作战指挥人员"],"coreScenario":"四大母港潮汐窗口监控","primaryView":"2×2 港口卡片矩阵","mainEntities":["港口","潮汐"],"dataPolicy":"mock_then_api","acceptanceFocus":["窗口计算"],"generationProfile":{"base":["software-factory-app"]}}`
	if err := st.UpdateClarificationRequirement(context.Background(), sess.ID, completeReq); err != nil {
		t.Fatalf("seed requirement: %v", err)
	}
	if err := st.UpdateClarificationRound(context.Background(), sess.ID, 3); err != nil {
		t.Fatalf("seed round: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/clarifications/active", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("active status = %d body=%s", rec.Code, rec.Body.String())
	}
	var active model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&active); err != nil {
		t.Fatalf("decode active: %v", err)
	}
	if active.ID != sess.ID {
		t.Fatalf("active id = %q, want %q", active.ID, sess.ID)
	}
	if active.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("active status = %q, want ready_to_confirm", active.Status)
	}
}

func TestCreateClarificationAllowsMultipleActiveSessions(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母母港潮汐窗口计算器"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	completeReq := `{"appType":"command_dashboard","appName":"航母母港潮汐窗口计算器","targetUsers":["作战指挥人员"],"coreScenario":"四大母港潮汐窗口监控","primaryView":"2×2 港口卡片矩阵","mainEntities":["港口","潮汐"],"dataPolicy":"mock_then_api","acceptanceFocus":["窗口计算"],"generationProfile":{"base":["software-factory-app"]}}`
	if err := st.UpdateClarificationRequirement(context.Background(), sess.ID, completeReq); err != nil {
		t.Fatalf("seed requirement: %v", err)
	}

	second := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成另一个应用"})
	if second.Code != http.StatusCreated {
		t.Fatalf("second create status = %d body=%s, want 201", second.Code, second.Body.String())
	}
	var secondSess model.ClarificationSession
	if err := json.NewDecoder(second.Body).Decode(&secondSess); err != nil {
		t.Fatalf("decode second session: %v", err)
	}
	if secondSess.ID == sess.ID {
		t.Fatalf("second session reused active session id %q", sess.ID)
	}

	sessions, err := st.ListClarificationSessions(context.Background(), 50)
	if err != nil {
		t.Fatalf("ListClarificationSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("sessions = %#v, want 2", sessions)
	}
}

func TestCreateClarificationMapsInvalidOutputToOutputInvalidJSON(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: `not-json`})

	rec := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成应用"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusFailed {
		t.Fatalf("status = %q, want failed", sess.Status)
	}
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("GetClarificationSession: %#v, %v", got, err)
	}
	if got.ErrorCode != string(model.ErrorOutputInvalidJSON) {
		t.Fatalf("error_code = %q, want %q; message=%s", got.ErrorCode, model.ErrorOutputInvalidJSON, got.ErrorMessage)
	}
}

// TestAnswerClarificationAddsMessageAndRunsRound verifies that posting a user
// message to a session triggers the next round and appends a fresh agent
// message. The first round is waiting_user; the next round (via the message
// endpoint) returns ready_to_confirm with a new agent analysis entry.
func TestAnswerClarificationAddsMessageAndRunsRound(t *testing.T) {
	srv, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	// Create the session (round 1 → waiting_user).
	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	// Swap the fake so the next round yields ready_to_confirm with a distinct
	// work-log entry we can assert on.
	srv.clarifier = clarification.Runner{
		Cmd:           fakeClarRunner{stdout: readyToConfirmOutput},
		WorkspaceRoot: srv.clarifier.WorkspaceRoot,
		ArtifactRoot:  srv.clarifier.ArtifactRoot,
	}

	msgBefore, err := st.ListClarificationMessages(context.Background(), sess.ID)
	if err != nil {
		t.Fatalf("list messages before: %v", err)
	}

	add := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/messages", map[string]string{"content": "面向作战参谋"})
	if add.Code != http.StatusOK {
		t.Fatalf("add message status = %d body=%s", add.Code, add.Body.String())
	}
	if err := json.NewDecoder(add.Body).Decode(&sess); err != nil {
		t.Fatalf("decode updated session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("session status = %q, want ready_to_confirm", sess.Status)
	}
	if sess.Round != 2 {
		t.Fatalf("session round = %d, want 2", sess.Round)
	}

	msgAfter, err := st.ListClarificationMessages(context.Background(), sess.ID)
	if err != nil {
		t.Fatalf("list messages after: %v", err)
	}
	if len(msgAfter) <= len(msgBefore) {
		t.Fatalf("messages did not grow: before=%d after=%d", len(msgBefore), len(msgAfter))
	}
	// The new agent analysis entry from readyToConfirmOutput.
	var sawAgentAnalysis bool
	for _, m := range msgAfter {
		if m.Role == "agent" && m.Kind == "analysis_work_log" && m.Content == "需求已收敛" {
			sawAgentAnalysis = true
		}
	}
	if !sawAgentAnalysis {
		t.Fatalf("new agent analysis_work_log message not found; messages=%#v", msgAfter)
	}
}

// TestConfirmClarificationCreatesQueuedJob verifies that confirming a
// ready_to_confirm session creates a queued generation job, links
// created_job_id, sets the session status confirmed, and the job is observable
// via ListJobs with status queued.
func TestConfirmClarificationCreatesQueuedJob(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	// Create + immediately drive to ready_to_confirm (round 1 already yields it
	// with this fake).
	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("precondition: session status = %q, want ready_to_confirm", sess.Status)
	}

	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", map[string]any{"requirement": json.RawMessage(`{"appType":"situation_replay","appName":"航母编队复盘应用","targetUsers":["作战参谋"],"coreScenario":"复盘近 1 个月航迹","primaryView":"地图 + 时间轴","mainEntities":["编队","事件"],"dataPolicy":"mock_data","acceptanceFocus":["轨迹联动"]}`)})
	if confirm.Code != http.StatusOK && confirm.Code != http.StatusCreated {
		t.Fatalf("confirm status = %d body=%s", confirm.Code, confirm.Body.String())
	}
	var confirmed model.ClarificationSession
	if err := json.NewDecoder(confirm.Body).Decode(&confirmed); err != nil {
		t.Fatalf("decode confirmed session: %v", err)
	}
	if confirmed.Status != model.ClarificationStatusConfirmed {
		t.Fatalf("session status = %q, want confirmed", confirmed.Status)
	}
	if confirmed.CreatedJobID == "" {
		t.Fatalf("created_job_id is empty")
	}

	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("jobs = %#v, want exactly 1", jobs)
	}
	if jobs[0].ID != confirmed.CreatedJobID {
		t.Fatalf("job id = %q, want %q", jobs[0].ID, confirmed.CreatedJobID)
	}
	if jobs[0].Status != model.JobStatusQueued {
		t.Fatalf("job status = %q, want queued", jobs[0].Status)
	}
	// Task 5: the job must carry the confirmed requirement (so the
	// requirement_analysis step can freeze/audit it) and the session link.
	if jobs[0].ConfirmedRequirementJSON == "" {
		t.Fatalf("job.confirmed_requirement_json is empty; confirmClarification must thread the frozen requirement onto the job")
	}
	if jobs[0].ClarificationSessionID != sess.ID {
		t.Fatalf("job.clarification_session_id = %q, want %q", jobs[0].ClarificationSessionID, sess.ID)
	}

	// The linked session row should carry the job id.
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	if got.CreatedJobID != jobs[0].ID {
		t.Fatalf("session.created_job_id = %q, want %q", got.CreatedJobID, jobs[0].ID)
	}
}

// TestGetClarificationReportsPersistedRound verifies that GET
// /api/clarifications/:id returns the persisted round after a round has run.
// This covers the previously-broken read path: before the persisted round
// column was advanced, GET returned round 0 (stale). Now runRoundAndPersist
// advances the persisted round, so GET reads the true current round.
func TestGetClarificationReportsPersistedRound(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	// Create the session — round 1 runs (waitingUserOutput reports round 1).
	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Round != 1 {
		t.Fatalf("create response round = %d, want 1", sess.Round)
	}

	// The persisted row must carry round 1 (the column was previously left at 0).
	persisted, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || persisted == nil {
		t.Fatalf("persisted session: %#v %v", persisted, err)
	}
	if persisted.Round != 1 {
		t.Fatalf("persisted round = %d, want 1", persisted.Round)
	}

	// GET /:id must report the persisted round — not 0.
	get := httptest.NewRequest(http.MethodGet, "/api/clarifications/"+sess.ID, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, get)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d body=%s", rec.Code, rec.Body.String())
	}
	var got model.ClarificationSession
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode get session: %v", err)
	}
	if got.Round != 1 {
		t.Fatalf("GET round = %d, want 1", got.Round)
	}
}

// TestFailedClarificationDoesNotCreateJob verifies that when the clarifier
// fails (non-zero claude exit), the session becomes failed, a
// clarification.failed event is published, and no generation job is created.
func TestFailedClarificationDoesNotCreateJob(t *testing.T) {
	srv, r, st := newClarTestServer(t, fakeClarRunner{exitErr: true})

	// Subscribe to the hub so we can observe the clarification.failed event.
	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	// On failure the handler returns 200 with the failed session (status failed).
	if create.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusFailed {
		t.Fatalf("session status = %q, want failed", sess.Status)
	}

	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %#v, want none on failure", jobs)
	}

	// Drain hub events and assert a clarification.failed was published.
	var sawFailed bool
	for {
		select {
		case ev := <-ch:
			if ev.Type == "clarification.failed" {
				sawFailed = true
			}
		default:
			goto done
		}
	}
done:
	if !sawFailed {
		t.Fatalf("did not observe clarification.failed event on hub")
	}
}

// TestConfirmRejectsNotReady verifies the status gate (P1#2): a session still
// waiting_user (round 1 not yet converged) must be rejected with 409 and must
// NOT spawn a generation job.
func TestConfirmRejectsNotReady(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusWaitingUser {
		t.Fatalf("precondition: status = %q, want waiting_user", sess.Status)
	}

	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", map[string]any{"requirement": json.RawMessage(`{"appType":"situation_replay","appName":"x"}`)})
	if confirm.Code != http.StatusConflict {
		t.Fatalf("confirm status = %d body=%s, want 409", confirm.Code, confirm.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(confirm.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode confirm body: %v", err)
	}
	if body["error"] != "session not ready to confirm" {
		t.Fatalf("error = %v, want 'session not ready to confirm'", body["error"])
	}
	if body["status"] != string(model.ClarificationStatusWaitingUser) {
		t.Fatalf("status in body = %v, want %q", body["status"], model.ClarificationStatusWaitingUser)
	}

	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %#v, want none when session not ready", jobs)
	}
}

// TestConfirmRejectsIncompleteRequirement verifies the required-field gate
// (P1#2): a ready_to_confirm session whose confirmed requirement is missing a
// required field (coreScenario) must be rejected with 422 and a `missing` list
// naming it; no job is created.
func TestConfirmRejectsIncompleteRequirement(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("precondition: status = %q, want ready_to_confirm", sess.Status)
	}

	// Confirm with a requirement missing coreScenario (and other required
	// fields). Assert 422 and that coreScenario appears in the missing list.
	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", map[string]any{
		"requirement": json.RawMessage(`{"appType":"situation_replay","appName":"航母编队复盘应用","targetUsers":["作战参谋"],"primaryView":"地图 + 时间轴","mainEntities":["编队","事件"],"dataPolicy":"mock_data","acceptanceFocus":["轨迹联动"]}`),
	})
	if confirm.Code != http.StatusUnprocessableEntity {
		t.Fatalf("confirm status = %d body=%s, want 422", confirm.Code, confirm.Body.String())
	}
	var body struct {
		Error   string   `json:"error"`
		Missing []string `json:"missing"`
	}
	if err := json.Unmarshal(confirm.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode confirm body: %v", err)
	}
	if body.Error != "confirmed requirement missing required fields" {
		t.Fatalf("error = %q, want confirmed requirement missing required fields", body.Error)
	}
	var sawCoreScenario bool
	for _, f := range body.Missing {
		if f == "coreScenario" {
			sawCoreScenario = true
		}
	}
	if !sawCoreScenario {
		t.Fatalf("missing = %v, want it to contain coreScenario", body.Missing)
	}

	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %#v, want none when requirement incomplete", jobs)
	}
}

// TestPatchRequirementRejectsUnsafeBlueprintRef verifies the fail-closed slug
// gate (P2#1): a blueprintRef slug containing a traversal must be rejected with
// 400 before any path is built or persisted.
func TestPatchRequirementRejectsUnsafeBlueprintRef(t *testing.T) {
	_, r, _ := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	patch := doPost(t, r, http.MethodPatch, "/api/clarifications/"+sess.ID+"/requirement", map[string]any{
		"requirement": json.RawMessage(`{"appType":"situation_replay","blueprintRefs":["../evil"]}`),
	})
	if patch.Code != http.StatusBadRequest {
		t.Fatalf("patch status = %d body=%s, want 400", patch.Code, patch.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(patch.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode patch body: %v", err)
	}
	if body["error"] != "invalid blueprintRef slug" {
		t.Fatalf("error = %v, want 'invalid blueprintRef slug'", body["error"])
	}
}

// TestConfirmRejectsUnsafeBlueprintRef verifies the confirm-time fail-closed
// slug gate (P2#1): an unsafe blueprintRef slug at confirm must be 400.
func TestConfirmRejectsUnsafeBlueprintRef(t *testing.T) {
	_, r, _ := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", map[string]any{
		"requirement": json.RawMessage(`{"appType":"situation_replay","appName":"航母编队复盘应用","targetUsers":["作战参谋"],"coreScenario":"复盘近 1 个月航迹","primaryView":"地图 + 时间轴","mainEntities":["编队","事件"],"dataPolicy":"mock_data","acceptanceFocus":["轨迹联动"],"blueprintRefs":["../evil"]}`),
	})
	if confirm.Code != http.StatusBadRequest {
		t.Fatalf("confirm status = %d body=%s, want 400", confirm.Code, confirm.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(confirm.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode confirm body: %v", err)
	}
	if body["error"] != "invalid blueprintRef slug" {
		t.Fatalf("error = %v, want 'invalid blueprintRef slug'", body["error"])
	}
}

// TestAnswerClarificationRunsNextRound verifies the structured-answer path now
// advances the round (P2#2): answering a recommended option at round 1
// (waiting_user) must run round 2 and surface a fresh agent analysis message.
// Without the shared advanceAfterUserTurn helper, the answer path stored the
// answer but never ran a round, so the session stalled before ready_to_confirm.
func TestAnswerClarificationRunsNextRound(t *testing.T) {
	srv, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusWaitingUser || sess.Round != 1 {
		t.Fatalf("precondition: status=%q round=%d, want waiting_user round 1", sess.Status, sess.Round)
	}

	// Swap the fake so the next round yields ready_to_confirm with a distinct
	// analysis entry we can assert on.
	srv.clarifier = clarification.Runner{
		Cmd:           fakeClarRunner{stdout: readyToConfirmOutput},
		WorkspaceRoot: srv.clarifier.WorkspaceRoot,
		ArtifactRoot:  srv.clarifier.ArtifactRoot,
	}

	msgBefore, err := st.ListClarificationMessages(context.Background(), sess.ID)
	if err != nil {
		t.Fatalf("list messages before: %v", err)
	}

	// Answer the round-1 question (id q1, value ops). The round advancement must
	// run round 2 (ready_to_confirm) and append the agent analysis entry.
	ans := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers", map[string]string{"questionId": "q1", "value": "ops"})
	if ans.Code != http.StatusOK {
		t.Fatalf("answer status = %d body=%s", ans.Code, ans.Body.String())
	}
	if err := json.NewDecoder(ans.Body).Decode(&sess); err != nil {
		t.Fatalf("decode answered session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("session status = %q, want ready_to_confirm (answer must advance the round)", sess.Status)
	}
	if sess.Round != 2 {
		t.Fatalf("session round = %d, want 2", sess.Round)
	}

	msgAfter, err := st.ListClarificationMessages(context.Background(), sess.ID)
	if err != nil {
		t.Fatalf("list messages after: %v", err)
	}
	if len(msgAfter) <= len(msgBefore) {
		t.Fatalf("messages did not grow after answer: before=%d after=%d", len(msgBefore), len(msgAfter))
	}
	var sawAgentAnalysis bool
	for _, m := range msgAfter {
		if m.Role == "agent" && m.Kind == "analysis_work_log" && m.Content == "需求已收敛" {
			sawAgentAnalysis = true
		}
	}
	if !sawAgentAnalysis {
		t.Fatalf("answer did not run a round: new agent analysis_work_log not found; messages=%#v", msgAfter)
	}
}

func TestBatchAnswersRunsNextRoundOnce(t *testing.T) {
	const readyOmittingAnsweredFieldsOutput = `{
  "status": "ready_to_confirm",
  "round": 2,
  "workLog": [{"type":"analysis","content":"批量答案已收敛"}],
  "questions": [],
  "requirement": {
    "appType": "situation_replay",
    "appName": "航母编队复盘应用",
    "coreScenario": "复盘近 1 个月航迹",
    "primaryView": "地图 + 时间轴",
    "mainEntities": ["编队","事件"],
    "dataPolicy": "mock_data",
    "generationProfile": {"base":["software-factory-app"]}
  }
}`
	fake := &sequenceClarRunner{outputs: []string{waitingUserOutput, readyOmittingAnsweredFieldsOutput}}
	_, r, st := newClarTestServer(t, fake)

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	if fake.calls != 1 {
		t.Fatalf("runner calls after create = %d, want 1", fake.calls)
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	batch := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers/batch", map[string]any{
		"answers": []map[string]string{
			{"questionId": "targetUsers", "value": "作战参谋"},
			{"questionId": "acceptanceFocus", "value": `["轨迹联动","倒计时准确"]`},
			{"questionId": "dataPolicy", "value": "mock_data"},
		},
	})
	if batch.Code != http.StatusOK {
		t.Fatalf("batch status = %d body=%s", batch.Code, batch.Body.String())
	}
	if fake.calls != 2 {
		t.Fatalf("runner calls after batch = %d, want 2 (create + one batch advancement)", fake.calls)
	}
	if err := json.NewDecoder(batch.Body).Decode(&sess); err != nil {
		t.Fatalf("decode batch session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("session status = %q, want ready_to_confirm", sess.Status)
	}

	msgs, err := st.ListClarificationMessages(context.Background(), sess.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	var answerCount int
	for _, m := range msgs {
		if m.Role == "user" && m.Kind == "answer" {
			answerCount++
		}
	}
	if answerCount != 3 {
		t.Fatalf("answer messages = %d, want 3", answerCount)
	}

	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	var req clarification.Requirement
	if err := json.Unmarshal([]byte(got.RequirementJSON), &req); err != nil {
		t.Fatalf("decode requirement: %v", err)
	}
	if strings.Join(req.TargetUsers, ",") != "作战参谋" {
		t.Fatalf("targetUsers = %#v, want preserved batch answer", req.TargetUsers)
	}
	if strings.Join(req.AcceptanceFocus, ",") != "轨迹联动,倒计时准确" {
		t.Fatalf("acceptanceFocus = %#v, want preserved batch answers", req.AcceptanceFocus)
	}
}

func TestReadyToConfirmRejectsAnswers(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("precondition: status=%q, want ready_to_confirm", sess.Status)
	}

	before, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || before == nil {
		t.Fatalf("get before: %#v %v", before, err)
	}

	single := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers", map[string]string{"questionId": "targetUsers", "value": "值班军官"})
	if single.Code != http.StatusConflict {
		t.Fatalf("single answer status = %d body=%s, want 409", single.Code, single.Body.String())
	}
	msg := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/messages", map[string]string{"content": "继续修改"})
	if msg.Code != http.StatusConflict {
		t.Fatalf("message status = %d body=%s, want 409", msg.Code, msg.Body.String())
	}
	batch := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers/batch", map[string]any{
		"answers": []map[string]string{{"questionId": "targetUsers", "value": "值班军官"}},
	})
	if batch.Code != http.StatusConflict {
		t.Fatalf("batch answer status = %d body=%s, want 409", batch.Code, batch.Body.String())
	}

	after, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || after == nil {
		t.Fatalf("get after: %#v %v", after, err)
	}
	if after.RequirementJSON != before.RequirementJSON {
		t.Fatalf("ready_to_confirm answers mutated requirement\nbefore=%s\nafter=%s", before.RequirementJSON, after.RequirementJSON)
	}
	if after.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("status = %q, want ready_to_confirm", after.Status)
	}
}

func TestApplyAnswerToRequirementMapsRequiredListFields(t *testing.T) {
	req := clarification.Requirement{}

	applyAnswerToRequirement(&req, "targetUsers", "作战参谋")
	applyAnswerToRequirement(&req, "main_entities", "航母编队，事件点、伴随舰")
	applyAnswerToRequirement(&req, "acceptance_focus", "轨迹联动, 时间轴回放")

	if got, want := strings.Join(req.TargetUsers, ","), "作战参谋"; got != want {
		t.Fatalf("targetUsers = %q, want %q", got, want)
	}
	if got, want := strings.Join(req.MainEntities, ","), "航母编队,事件点,伴随舰"; got != want {
		t.Fatalf("mainEntities = %q, want %q", got, want)
	}
	if got, want := strings.Join(req.AcceptanceFocus, ","), "轨迹联动,时间轴回放"; got != want {
		t.Fatalf("acceptanceFocus = %q, want %q", got, want)
	}
}

func TestApplyAnswerToRequirementAddsBlueprintSpecificGenerationSkills(t *testing.T) {
	req := clarification.Requirement{
		BlueprintRefs: []string{"carrier-air-wing-affiliation-inference"},
	}

	applyAnswerToRequirement(&req, "appType", "command_dashboard")

	patterns := strings.Join(req.GenerationProfile["pattern"], ",")
	if !strings.Contains(patterns, "maritime-alert-dashboard") || !strings.Contains(patterns, "affiliation-inference-dashboard") {
		t.Fatalf("generationProfile.pattern = %q, want carrier-air-wing skills", patterns)
	}
}

func TestAnswerClarificationPreservesMappedRequirementWhenNextRoundOmitsField(t *testing.T) {
	const omittedTargetUsersOutput = `{
  "status": "waiting_user",
  "round": 2,
  "workLog": [{"type":"analysis","content":"继续澄清其他字段"}],
  "questions": [{"id":"mainEntities","label":"主体","question":"关注哪些主体?","options":[{"value":"航母编队","label":"航母编队"}]}],
  "requirement": {
    "appType": "situation_replay",
    "appName": "复盘应用",
    "generationProfile": {"base":["software-factory-app"]}
  }
}`
	srv, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	srv.clarifier = clarification.Runner{
		Cmd:           fakeClarRunner{stdout: omittedTargetUsersOutput},
		WorkspaceRoot: srv.clarifier.WorkspaceRoot,
		ArtifactRoot:  srv.clarifier.ArtifactRoot,
	}

	ans := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers", map[string]string{"questionId": "targetUsers", "value": "作战参谋"})
	if ans.Code != http.StatusOK {
		t.Fatalf("answer status = %d body=%s", ans.Code, ans.Body.String())
	}

	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	var req clarification.Requirement
	if err := json.Unmarshal([]byte(got.RequirementJSON), &req); err != nil {
		t.Fatalf("decode persisted requirement: %v", err)
	}
	if got, want := strings.Join(req.TargetUsers, ","), "作战参谋"; got != want {
		t.Fatalf("targetUsers after next round = %q, want preserved %q", got, want)
	}
}

// drainClarificationHub reads all currently-buffered events off ch. The hub is
// buffered (see events.go) so a synchronous handler call completes before we
// drain, capturing every event it published.
func drainClarificationHub(ch <-chan Event) []Event {
	var out []Event
	for {
		select {
		case ev := <-ch:
			out = append(out, ev)
		default:
			return out
		}
	}
}

// TestConfirmPublishesConfirmedSession verifies the P1 fix: the
// clarification.confirmed SSE event must carry the refreshed confirmed SESSION
// (status=confirmed, created_job_id set), NOT the requirement object. Before
// the fix the handler published `req`, which overwrote the frontend's session
// slot with a requirement (no id/status) and routed chat to
// /api/clarifications/undefined/messages.
func TestConfirmPublishesConfirmedSession(t *testing.T) {
	srv, r, _ := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	ch := srv.hub.Subscribe()
	defer srv.hub.Unsubscribe(ch)

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("precondition: status = %q, want ready_to_confirm", sess.Status)
	}

	// Drain the round-1 events so the buffer is clean before confirm.
	_ = drainClarificationHub(ch)

	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", nil)
	if confirm.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", confirm.Code, confirm.Body.String())
	}

	events := drainClarificationHub(ch)
	var confirmedEv *Event
	for i := range events {
		if events[i].Type == "clarification.confirmed" {
			confirmedEv = &events[i]
			break
		}
	}
	if confirmedEv == nil {
		t.Fatalf("did not observe clarification.confirmed event; got %#v", events)
	}

	// Event.Data is the bare clarification.StreamEvent; its .data is whatever the
	// publisher put there. The fix publishes the refreshed *model.ClarificationSession.
	raw, err := json.Marshal(confirmedEv.Data)
	if err != nil {
		t.Fatalf("marshal confirmed event data: %v", err)
	}
	var stream clarification.StreamEvent
	if err := json.Unmarshal(raw, &stream); err != nil {
		t.Fatalf("unmarshal StreamEvent: %v", err)
	}
	payload, err := json.Marshal(stream.Data)
	if err != nil {
		t.Fatalf("marshal stream payload: %v", err)
	}
	var s map[string]any
	if err := json.Unmarshal(payload, &s); err != nil {
		t.Fatalf("unmarshal stream payload map: %v", err)
	}

	// It must look like a SESSION, not a requirement.
	if s["id"] != sess.ID {
		t.Fatalf("confirmed payload id = %v, want session id %q", s["id"], sess.ID)
	}
	if s["status"] != string(model.ClarificationStatusConfirmed) {
		t.Fatalf("confirmed payload status = %v, want %q", s["status"], model.ClarificationStatusConfirmed)
	}
	jobID, _ := s["created_job_id"].(string)
	if jobID == "" {
		t.Fatalf("confirmed payload created_job_id is empty; want the linked job id; payload=%#v", s)
	}
	// A requirement object would carry top-level appType but no id/status. Assert
	// the payload does NOT look like a requirement (no top-level appType).
	if _, hasAppType := s["appType"]; hasAppType {
		t.Fatalf("confirmed payload looks like a requirement (has appType); want a session; payload=%#v", s)
	}
}

// TestTerminalSessionRejectsMessagesAndAnswers verifies the P2 fix: once a
// session is confirmed (terminal), POST /messages and POST /answers must return
// 409 and must NOT advance the session. A failed session is recovered via the
// dedicated retry-current-round endpoint, not via messages/answers.
func TestTerminalSessionRejectsMessagesAndAnswers(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("precondition: status = %q, want ready_to_confirm", sess.Status)
	}

	// Confirm -> confirmed (terminal).
	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", nil)
	if confirm.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", confirm.Code, confirm.Body.String())
	}

	// POST /messages on a confirmed session must be 409.
	msg := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/messages", map[string]string{"content": "post-confirm chat"})
	if msg.Code != http.StatusConflict {
		t.Fatalf("messages status = %d body=%s, want 409 (terminal session)", msg.Code, msg.Body.String())
	}

	// POST /answers on a confirmed session must be 409.
	ans := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/answers", map[string]string{"questionId": "q1", "value": "ops"})
	if ans.Code != http.StatusConflict {
		t.Fatalf("answers status = %d body=%s, want 409 (terminal session)", ans.Code, ans.Body.String())
	}

	// The session must remain confirmed (the rejected turns did not flip status).
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	if got.Status != model.ClarificationStatusConfirmed {
		t.Fatalf("session status = %q, want confirmed (terminal turns must not advance it)", got.Status)
	}
}

// TestTerminalAbandonedSessionRejectsMessage is the abandoned-status variant of
// the terminal-session guard: an abandoned session must also reject messages.
func TestTerminalAbandonedSessionRejectsMessage(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	// Abandon -> abandoned (terminal).
	if err := st.SetClarificationStatus(context.Background(), sess.ID, model.ClarificationStatusAbandoned, "", ""); err != nil {
		t.Fatalf("set abandoned: %v", err)
	}

	msg := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/messages", map[string]string{"content": "after abandon"})
	if msg.Code != http.StatusConflict {
		t.Fatalf("messages status = %d body=%s, want 409 (abandoned terminal session)", msg.Code, msg.Body.String())
	}
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	if got.Status != model.ClarificationStatusAbandoned {
		t.Fatalf("session status = %q, want abandoned", got.Status)
	}
}

// TestRetryRejectsConfirmedSession verifies that retry-current-round is the
// FAILED-recovery path only: a confirmed (terminal) session must reject retry
// with 409 and stay confirmed, rather than being revived to
// waiting_user/ready_to_confirm by runRoundAndPersist.
func TestRetryRejectsConfirmedSession(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	// Confirm -> confirmed (terminal).
	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", nil)
	if confirm.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", confirm.Code, confirm.Body.String())
	}

	retry := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/retry-current-round", nil)
	if retry.Code != http.StatusConflict {
		t.Fatalf("retry status = %d body=%s, want 409 (confirmed session is not retriable)", retry.Code, retry.Body.String())
	}
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	if got.Status != model.ClarificationStatusConfirmed {
		t.Fatalf("session status = %q, want confirmed (retry must not revive a terminal session)", got.Status)
	}
}

// TestRetryRejectsAbandonedSession is the abandoned-status variant: an abandoned
// (terminal) session must also reject retry-current-round with 409.
func TestRetryRejectsAbandonedSession(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	// Abandon -> abandoned (terminal).
	if err := st.SetClarificationStatus(context.Background(), sess.ID, model.ClarificationStatusAbandoned, "", ""); err != nil {
		t.Fatalf("set abandoned: %v", err)
	}

	retry := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/retry-current-round", nil)
	if retry.Code != http.StatusConflict {
		t.Fatalf("retry status = %d body=%s, want 409 (abandoned session is not retriable)", retry.Code, retry.Body.String())
	}
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	if got.Status != model.ClarificationStatusAbandoned {
		t.Fatalf("session status = %q, want abandoned (retry must not revive a terminal session)", got.Status)
	}
}

// TestConfirmRejectsUnsafePersistedBlueprintRef verifies the P2 fix on the
// empty-body confirm path: the persisted requirement itself (bypassing PATCH,
// which now rejects unsafe slugs) carries an unsafe blueprintRef, and confirm
// with an EMPTY body must still fail-closed with 400. Before the fix the slug
// loop ran only inside the body.Requirement branch.
func TestConfirmRejectsUnsafePersistedBlueprintRef(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		t.Fatalf("precondition: status = %q, want ready_to_confirm", sess.Status)
	}

	// Seed the persisted requirement with an unsafe blueprintRef directly via the
	// store, bypassing PATCH (which rejects unsafe slugs). Keep all required
	// fields populated so the slug check is the only failing gate.
	unsafeReq := `{"appType":"situation_replay","appName":"航母编队复盘应用","targetUsers":["作战参谋"],"coreScenario":"复盘近 1 个月航迹","primaryView":"地图 + 时间轴","mainEntities":["编队","事件"],"dataPolicy":"mock_data","acceptanceFocus":["轨迹联动"],"blueprintRefs":["../evil"],"generationProfile":{"base":["software-factory-app"]}}`
	if err := st.UpdateClarificationRequirement(context.Background(), sess.ID, unsafeReq); err != nil {
		t.Fatalf("seed persisted requirement: %v", err)
	}

	// Confirm with an EMPTY body → must fail-closed 400 on the persisted slug.
	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", nil)
	if confirm.Code != http.StatusBadRequest {
		t.Fatalf("confirm status = %d body=%s, want 400 (unsafe persisted blueprintRef)", confirm.Code, confirm.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(confirm.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode confirm body: %v", err)
	}
	if body["error"] != "invalid blueprintRef slug" {
		t.Fatalf("error = %v, want 'invalid blueprintRef slug'", body["error"])
	}

	// No job must have been created.
	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %#v, want none when persisted blueprintRef is unsafe", jobs)
	}
}

// TestRunRoundSanitizesUnsafeBlueprintRefs verifies the P2 fix: when the LLM
// (fake runner) returns a requirement with a mix of safe and unsafe
// blueprintRefs, runRoundAndPersist must DROP the unsafe slugs before
// persisting, keeping only the safe ones. Sanitize, not fail — a single bad slug
// must not abort the round.
func TestRunRoundSanitizesUnsafeBlueprintRefs(t *testing.T) {
	const mixedRefsOutput = `{
  "status": "ready_to_confirm",
  "round": 1,
  "workLog": [{"type":"analysis","content":"收敛"}],
  "questions": [],
  "requirement": {
    "appType": "situation_replay",
    "appName": "航母编队复盘应用",
    "targetUsers": ["作战参谋"],
    "coreScenario": "复盘近 1 个月航迹",
    "primaryView": "地图 + 时间轴",
    "mainEntities": ["编队","事件"],
    "dataPolicy": "mock_data",
    "acceptanceFocus": ["轨迹联动"],
    "blueprintRefs": ["carrier-formation-replay", "../x"],
    "generationProfile": {"base":["software-factory-app"]}
  }
}`
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: mixedRefsOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}
	var sess model.ClarificationSession
	if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	// Re-get the persisted session and inspect requirement_json.
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("re-get session: %#v %v", got, err)
	}
	var persisted struct {
		BlueprintRefs []string `json:"blueprintRefs"`
	}
	if err := json.Unmarshal([]byte(got.RequirementJSON), &persisted); err != nil {
		t.Fatalf("unmarshal persisted requirement: %v", err)
	}
	if len(persisted.BlueprintRefs) != 1 {
		t.Fatalf("persisted blueprintRefs = %#v, want exactly 1 (safe slug only)", persisted.BlueprintRefs)
	}
	if persisted.BlueprintRefs[0] != "carrier-formation-replay" {
		t.Fatalf("persisted blueprintRef[0] = %q, want 'carrier-formation-replay'", persisted.BlueprintRefs[0])
	}
}

func TestListClarificationsReturnsParsedRequirement(t *testing.T) {
	_, r, _ := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})

	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/clarifications?limit=50", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var views []clarificationView
	if err := json.NewDecoder(rec.Body).Decode(&views); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("len = %d, want 1", len(views))
	}
	if views[0].Requirement.AppName != "航母编队复盘应用" {
		t.Fatalf("appName = %q", views[0].Requirement.AppName)
	}
}

func TestListClarificationsIncludesLinkedJobAndDeletedApplicationState(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})
	now := time.Now()
	sess := model.ClarificationSession{
		ID:              "clar_linked",
		Status:          model.ClarificationStatusConfirmed,
		InitialPrompt:   "生成已删除应用",
		Round:           2,
		MaxRounds:       3,
		RequirementJSON: `{"appType":"command_dashboard","appName":"已删除应用","coreScenario":"查看历史状态"}`,
		CreatedJobID:    "job_linked",
		CreatedAt:       now,
		UpdatedAt:       now,
		ConfirmedAt:     &now,
	}
	if err := st.CreateClarificationSession(context.Background(), sess); err != nil {
		t.Fatalf("seed clarification: %v", err)
	}
	job := model.Job{
		ID:                     "job_linked",
		UserPrompt:             "生成已删除应用",
		AppSlug:                "deleted-app",
		AppName:                "已删除应用",
		Status:                 model.JobStatusCompleted,
		CurrentStepKind:        model.StepDeployment,
		CreatedAppID:           "app_deleted",
		CreatedAt:              now,
		UpdatedAt:              now,
		ClarificationSessionID: sess.ID,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("seed job: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/clarifications?limit=50", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var views []clarificationView
	if err := json.NewDecoder(rec.Body).Decode(&views); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	var linked *clarificationView
	for i := range views {
		if views[i].ID == sess.ID {
			linked = &views[i]
		}
	}
	if linked == nil {
		t.Fatalf("linked session missing from views: %#v", views)
	}
	if linked.CreatedJob == nil || linked.CreatedJob.ID != job.ID {
		t.Fatalf("created job = %#v, want %s", linked.CreatedJob, job.ID)
	}
	if linked.ApplicationState != "deleted" {
		t.Fatalf("application_state = %q, want deleted", linked.ApplicationState)
	}
}

func TestDeleteClarificationDeletesSessionMessagesButKeepsJob(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})
	ctx := context.Background()
	now := time.Now()
	sess := model.ClarificationSession{
		ID:              "clar_delete",
		Status:          model.ClarificationStatusConfirmed,
		InitialPrompt:   "生成历史会话",
		Round:           2,
		MaxRounds:       3,
		RequirementJSON: `{}`,
		CreatedJobID:    "job_delete_keep",
		CreatedAt:       now,
		UpdatedAt:       now,
		ConfirmedAt:     &now,
	}
	if err := st.CreateClarificationSession(ctx, sess); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if err := st.AddClarificationMessage(ctx, model.ClarificationMessage{
		ID: "cmsg_delete", SessionID: sess.ID, Role: "agent", Kind: "analysis_work_log",
		Content: "历史内容", CreatedAt: now,
	}); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	job := model.Job{
		ID: "job_delete_keep", UserPrompt: "生成历史会话", Status: model.JobStatusCompleted,
		CurrentStepKind: model.StepDeployment, CreatedAt: now, UpdatedAt: now,
		ClarificationSessionID: sess.ID,
	}
	if err := st.CreateJob(ctx, job); err != nil {
		t.Fatalf("seed job: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/clarifications/"+sess.ID, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", rec.Code, rec.Body.String())
	}
	got, err := st.GetClarificationSession(ctx, sess.ID)
	if err != nil {
		t.Fatalf("get deleted session: %v", err)
	}
	if got != nil {
		t.Fatalf("session still exists: %#v", got)
	}
	msgs, err := st.ListClarificationMessages(ctx, sess.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("messages = %#v, want none", msgs)
	}
	gotJob, err := st.GetJob(ctx, job.ID)
	if err != nil || gotJob == nil {
		t.Fatalf("linked job was deleted: %#v err=%v", gotJob, err)
	}
}

func TestDeleteClarificationRejectsActiveSession(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})
	now := time.Now()
	sess := model.ClarificationSession{
		ID: "clar_active_delete", Status: model.ClarificationStatusActive, InitialPrompt: "分析中",
		Round: 1, MaxRounds: 3, RequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateClarificationSession(context.Background(), sess); err != nil {
		t.Fatalf("seed active session: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/clarifications/"+sess.ID, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete active status = %d body=%s, want 409", rec.Code, rec.Body.String())
	}
	got, err := st.GetClarificationSession(context.Background(), sess.ID)
	if err != nil || got == nil {
		t.Fatalf("active session should remain: %#v err=%v", got, err)
	}
}

// blueprintRefsRequirementJSON is a complete requirement that ALSO carries an
// internal blueprint slug. Handlers re-publish the requirement over SSE on
// answer / batch-answer / patch; those events must NOT carry blueprintRefs.
const blueprintRefsRequirementJSON = `{"appType":"command_dashboard","appName":"航母母港潮汐窗口计算器","targetUsers":["作战指挥人员"],"coreScenario":"四大母港潮汐窗口监控","primaryView":"2×2 港口卡片矩阵","mainEntities":["港口","潮汐"],"dataPolicy":"mock_then_api","acceptanceFocus":["窗口计算"],"generationProfile":{"base":["software-factory-app"]},"blueprintRefs":["carrier-homeport-tide-window"]}`

const leakSlug = "carrier-homeport-tide-window"

// assertNoBlueprintLeak fails the test if body contains the blueprintRefs JSON
// key or the internal slug string. Mirrors the marshal-and-assert style of
// clarification.TestRunnerRedactsBlueprintRefsFromUserFacingEvents.
func assertNoBlueprintLeak(t *testing.T, label, body string) {
	t.Helper()
	if strings.Contains(body, "blueprintRefs") {
		t.Fatalf("%s leaks blueprintRefs key: %s", label, body)
	}
	if strings.Contains(body, leakSlug) {
		t.Fatalf("%s leaks blueprint slug: %s", label, body)
	}
}

// summaryUpdatedPayloads extracts the marshaled JSON payload strings of every
// clarification.summary.updated event captured off the hub. The hub wraps each
// clarification.StreamEvent inside Event.Data, so we peel two layers.
func summaryUpdatedPayloads(t *testing.T, events []Event) []string {
	t.Helper()
	var out []string
	for _, ev := range events {
		if ev.Type != "clarification.summary.updated" {
			continue
		}
		raw, err := json.Marshal(ev.Data)
		if err != nil {
			t.Fatalf("marshal event data: %v", err)
		}
		var stream clarification.StreamEvent
		if err := json.Unmarshal(raw, &stream); err != nil {
			t.Fatalf("unmarshal StreamEvent: %v", err)
		}
		payload, err := json.Marshal(stream.Data)
		if err != nil {
			t.Fatalf("marshal stream payload: %v", err)
		}
		out = append(out, string(payload))
	}
	return out
}

// TestHandlerRedactsBlueprintRefsFromSSEEvents is the handler/SSE-layer guard
// the per-task reviews missed: after (a) a single answer, (b) a batch answer,
// and (c) a requirement patch, the clarification.summary.updated event MUST
// contain neither the blueprintRefs key nor the internal slug, while the
// persisted server-side requirement still carries BlueprintRefs intact.
func TestHandlerRedactsBlueprintRefsFromSSEEvents(t *testing.T) {
	cases := []struct {
		name   string
		action func(t *testing.T, srv *Server, r *Router, sessID string)
	}{
		{
			name: "single answer",
			action: func(t *testing.T, srv *Server, r *Router, sessID string) {
				// Keep the session waiting_user so the answer advances without
				// a model round overwriting the seeded requirement.
				srv.clarifier = clarification.Runner{
					Cmd:           fakeClarRunner{stdout: waitingUserOutput},
					WorkspaceRoot: srv.clarifier.WorkspaceRoot,
					ArtifactRoot:  srv.clarifier.ArtifactRoot,
				}
				rec := doPost(t, r, http.MethodPost, "/api/clarifications/"+sessID+"/answers", map[string]string{"questionId": "q1", "value": "ops"})
				if rec.Code != http.StatusOK {
					t.Fatalf("answer status = %d body=%s", rec.Code, rec.Body.String())
				}
			},
		},
		{
			name: "batch answer",
			action: func(t *testing.T, srv *Server, r *Router, sessID string) {
				srv.clarifier = clarification.Runner{
					Cmd:           fakeClarRunner{stdout: waitingUserOutput},
					WorkspaceRoot: srv.clarifier.WorkspaceRoot,
					ArtifactRoot:  srv.clarifier.ArtifactRoot,
				}
				rec := doPost(t, r, http.MethodPost, "/api/clarifications/"+sessID+"/answers/batch", map[string]any{
					"answers": []map[string]string{{"questionId": "q1", "value": "ops"}},
				})
				if rec.Code != http.StatusOK {
					t.Fatalf("batch answer status = %d body=%s", rec.Code, rec.Body.String())
				}
			},
		},
		{
			name: "requirement patch",
			action: func(t *testing.T, srv *Server, r *Router, sessID string) {
				// generationProfile is server-derived and rejected by the patch
				// endpoint, so send every editable field plus the blueprint slug.
				patchReq := `{"appType":"command_dashboard","appName":"航母母港潮汐窗口计算器","targetUsers":["作战指挥人员"],"coreScenario":"四大母港潮汐窗口监控","primaryView":"2×2 港口卡片矩阵","mainEntities":["港口","潮汐"],"dataPolicy":"mock_then_api","acceptanceFocus":["窗口计算"],"blueprintRefs":["carrier-homeport-tide-window"]}`
				patchBody := map[string]any{"requirement": json.RawMessage(patchReq)}
				rec := doPost(t, r, http.MethodPatch, "/api/clarifications/"+sessID+"/requirement", patchBody)
				if rec.Code != http.StatusOK {
					t.Fatalf("patch status = %d body=%s", rec.Code, rec.Body.String())
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, r, st := newClarTestServer(t, fakeClarRunner{stdout: waitingUserOutput})

			create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母母港潮汐窗口计算器"})
			if create.Code != http.StatusCreated {
				t.Fatalf("create status = %d body=%s", create.Code, create.Body.String())
			}
			var sess model.ClarificationSession
			if err := json.NewDecoder(create.Body).Decode(&sess); err != nil {
				t.Fatalf("decode session: %v", err)
			}
			// Seed a requirement that carries the internal blueprint slug; the
			// re-publish on the handler path must strip it.
			if err := st.UpdateClarificationRequirement(context.Background(), sess.ID, blueprintRefsRequirementJSON); err != nil {
				t.Fatalf("seed requirement: %v", err)
			}

			ch := srv.hub.Subscribe()
			defer srv.hub.Unsubscribe(ch)
			_ = drainClarificationHub(ch) // flush round-1 events

			tc.action(t, srv, r, sess.ID)

			payloads := summaryUpdatedPayloads(t, drainClarificationHub(ch))
			if len(payloads) == 0 {
				t.Fatalf("no clarification.summary.updated event observed for %s", tc.name)
			}
			for i, body := range payloads {
				assertNoBlueprintLeak(t, tc.name+" clarification.summary.updated["+itoa(i)+"]", body)
			}

			// Server-side retention: the persisted requirement STILL carries the
			// internal slug (redaction is user-facing-only).
			got, err := st.GetClarificationSession(context.Background(), sess.ID)
			if err != nil || got == nil {
				t.Fatalf("re-get session: %#v %v", got, err)
			}
			if !strings.Contains(got.RequirementJSON, leakSlug) {
				t.Fatalf("server-side requirement lost blueprint slug; redaction must be user-facing only: %s", got.RequirementJSON)
			}
		})
	}
}

// itoa avoids importing strconv solely for an index label.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
