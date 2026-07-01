package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/collaboration"
	"github.com/weimengtsgit/xian630/factory-server/internal/dataaccess"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

const maxSkillSnapshotContentBytes = 64 * 1024

var safeSnapshotSkillKey = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

type skillSnapshotCredentialRule struct {
	pattern     *regexp.Regexp
	replacement string
}

var skillSnapshotCredentialRules = []skillSnapshotCredentialRule{
	{regexp.MustCompile(`(?i)(authorization)\s*:\s*([^"\r\n][^\r\n]*)`), `${1}: [REDACTED]`},
	{regexp.MustCompile(`(?i)(authorization)\s*[:=]?\s*bearer\s+([^\s,]+)`), `${1}: Bearer [REDACTED]`},
	{regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*|"\s*:\s*"|'\s*:\s*')("([^"]*)"|'([^']*)'|([^\s,"']+))`), `${1}${2}[REDACTED]`},
}

// stepPlan is the fixed six-step pipeline seeded for every new job, in order.
// kind → agent_key follows design §4. Both code-generator/requirement-analyst
// style keys are owned by the agents table (Task 2 seeds the registry).
var stepPlan = []struct {
	kind     model.StepKind
	agentKey string
}{
	{model.StepRequirementAnalysis, "requirement-analyst"},
	{model.StepSolutionDesign, "solution-designer"},
	{model.StepCodeGeneration, "code-generator"},
	{model.StepTestVerification, "tester"},
	{model.StepImageBuild, "image-builder"},
	{model.StepDeployment, "deployer"},
}

// collaborationSteps builds the job_steps + job_step_edges that materialize a
// collaboration plan into runnable rows. Each plan agent becomes one pending
// JobStep (Kind = the agent's role, AgentKey = the agent key, SnapshotJSON = the
// frozen agent configuration); each plan edge becomes one JobStepEdge keyed by
// the materialized step ids. The first step's role is returned implicitly via
// plan.Agents[0].Role — callers set CurrentStepKind from it so a freshly seeded
// job points at the executable head of the plan.
func collaborationSteps(jobID string, plan collaboration.Plan, workspaceRoot string) ([]model.JobStep, []model.JobStepEdge, error) {
	keyToStepID := make(map[string]string, len(plan.Agents))
	steps := make([]model.JobStep, 0, len(plan.Agents))
	for i, agent := range plan.Agents {
		stepID := "step_" + idpkg.New()
		keyToStepID[agent.Key] = stepID
		snapshot := hydrateSnapshotSkillContents(agent.Snapshot, workspaceRoot)
		snapshotBytes, err := json.Marshal(snapshot)
		if err != nil {
			return nil, nil, err
		}
		steps = append(steps, model.JobStep{
			ID: stepID, JobID: jobID, Kind: model.StepKind(agent.Role), Seq: i + 1,
			AgentKey: agent.Key, Status: model.StepStatusPending, Attempt: 0,
			SnapshotJSON: string(snapshotBytes),
		})
	}
	edges := make([]model.JobStepEdge, 0, len(plan.Edges))
	for _, edge := range plan.Edges {
		fromID := keyToStepID[edge.From]
		toID := keyToStepID[edge.To]
		if fromID == "" || toID == "" {
			return nil, nil, fmt.Errorf("unknown collaboration edge %s -> %s", edge.From, edge.To)
		}
		edges = append(edges, model.JobStepEdge{JobID: jobID, FromStepID: fromID, ToStepID: toID})
	}
	return steps, edges, nil
}

func hydrateSnapshotSkillContents(snapshot collaboration.Snapshot, workspaceRoot string) collaboration.Snapshot {
	if len(snapshot.SelectedSkills) == 0 {
		return snapshot
	}
	root := workspaceRoot
	if strings.TrimSpace(root) == "" {
		root = "."
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	seen := map[string]bool{}
	for _, override := range snapshot.SkillOverrides {
		seen[filepath.ToSlash(override.Path)] = true
	}
	for _, skill := range snapshot.SelectedSkills {
		key := strings.TrimSpace(skill)
		if !safeSnapshotSkillKey.MatchString(key) {
			continue
		}
		skillsRoot := filepath.Join(root, ".claude", "skills")
		rel := filepath.ToSlash(filepath.Join(".claude", "skills", key, "SKILL.md"))
		if seen[rel] {
			continue
		}
		fullPath := filepath.Clean(filepath.Join(skillsRoot, key, "SKILL.md"))
		rootRel, err := filepath.Rel(skillsRoot, fullPath)
		if err != nil || rootRel == ".." || strings.HasPrefix(rootRel, ".."+string(filepath.Separator)) || filepath.IsAbs(rootRel) {
			continue
		}
		content, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}
		snapshot.SkillOverrides = append(snapshot.SkillOverrides, collaboration.SkillOverride{
			Path:    rel,
			Content: limitSkillSnapshotContent(redactSkillSnapshotContent(string(content))),
			Scope:   "task",
		})
		seen[rel] = true
	}
	return snapshot
}

func redactSkillSnapshotContent(content string) string {
	for _, rule := range skillSnapshotCredentialRules {
		content = rule.pattern.ReplaceAllString(content, rule.replacement)
	}
	return content
}

func limitSkillSnapshotContent(content string) string {
	if len(content) <= maxSkillSnapshotContentBytes {
		return content
	}
	const marker = "\n[TRUNCATED: skill content exceeds snapshot cap]\n"
	keep := maxSkillSnapshotContentBytes - len(marker)
	if keep <= 0 {
		return marker
	}
	out := content[:keep]
	for !utf8.ValidString(out) && len(out) > 0 {
		out = out[:len(out)-1]
	}
	return out + marker
}

// createJobBody is the request body accepted by POST /api/jobs. As of Task 5,
// jobs are created from a CONFIRMED clarification requirement, not from a bare
// prompt: when a prompt is present the caller MUST also supply a
// confirmed_requirement_json (the frozen requirement the requirement_analysis
// step audits). The internal confirmClarification path creates jobs via
// store.CreateJob directly and is unaffected by this gate.
type createJobBody struct {
	Prompt                   string `json:"prompt"`
	ClarificationSessionID   string `json:"clarification_session_id"`
	ConfirmedRequirementJSON string `json:"confirmed_requirement_json"`
}

// createJob handles POST /api/jobs. It enqueues a job at the first pipeline
// step (requirement_analysis) and seeds all six steps as pending, then records
// the user's prompt as the first conversation message. A prompt without a
// confirmed requirement is rejected with 400 confirmed_requirement_required —
// callers must run a clarification session to /confirm first.
func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	var body createJobBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.Prompt == "" {
		writeError(w, http.StatusBadRequest, "missing prompt")
		return
	}
	if body.ConfirmedRequirementJSON == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":      "jobs must be created from confirmed clarification requirements",
			"error_code": "confirmed_requirement_required",
		})
		return
	}

	now := time.Now()
	jobID := "job_" + idpkg.New()

	// Build the default collaboration plan from the confirmed requirement, then
	// materialize it into job_steps + job_step_edges. The plan is persisted onto
	// the job row (CollaborationPlanJSON) so the UI can render the lane/card view
	// (Task 4) and the executor can drive it (Task 6). CurrentStepKind points at
	// the FIRST plan agent's role so the job is executable from its plan head.
	plan := collaboration.DefaultPlan(collaboration.RequirementContext{ConfirmedRequirementJSON: body.ConfirmedRequirementJSON})
	planJSON, err := plan.JSON()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "build collaboration plan")
		return
	}
	steps, edges, err := collaborationSteps(jobID, plan, s.cfg.WorkspaceRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "build collaboration steps")
		return
	}
	currentStep := model.StepRequirementAnalysis
	if len(plan.Agents) > 0 {
		currentStep = model.StepKind(plan.Agents[0].Role)
	}

	job := model.Job{
		ID:                       jobID,
		UserPrompt:               body.Prompt,
		AppName:                  deriveJobDisplayName(body.Prompt),
		Status:                   model.JobStatusQueued,
		CurrentStepKind:          currentStep,
		ClarificationSessionID:   body.ClarificationSessionID,
		ConfirmedRequirementJSON: body.ConfirmedRequirementJSON,
		CollaborationPlanJSON:    planJSON,
		CreatedAt:                now,
		UpdatedAt:                now,
	}
	// Seed the job, its steps, AND its edges in ONE transaction so a freshly
	// created collaboration-plan job is never left with steps but no edges.
	if err := s.store.SeedJobWithEdges(r.Context(), job, steps, edges); err != nil {
		writeError(w, http.StatusInternalServerError, "create job")
		return
	}

	msg := model.ConversationMessage{
		ID:        "conv_" + idpkg.New(),
		JobID:     jobID,
		Role:      "user",
		Content:   body.Prompt,
		CreatedAt: now,
	}
	if err := s.store.AddConversation(r.Context(), msg); err != nil {
		writeError(w, http.StatusInternalServerError, "add conversation")
		return
	}

	s.hub.Publish(Event{Type: "job.created", Data: job})
	s.logEvent("job_queued", map[string]any{
		"job_id":                   job.ID,
		"app_name":                 job.AppName,
		"current_step_kind":        string(job.CurrentStepKind),
		"clarification_session_id": job.ClarificationSessionID,
		"source":                   "api",
	})

	// Wake the executor's drain loop so it picks up the new queued job.
	s.exec.Signal()

	writeJSON(w, http.StatusCreated, job)
}

func deriveJobDisplayName(prompt string) string {
	title := strings.TrimSpace(prompt)
	for _, prefix := range []string{"请帮我", "帮我", "生成一个", "生成", "做一个", "创建一个", "创建"} {
		title = strings.TrimSpace(strings.TrimPrefix(title, prefix))
	}
	if title == "" {
		return "未命名任务"
	}
	const maxRunes = 32
	runes := []rune(title)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes]) + "..."
	}
	return title
}

// listJobs handles GET /api/jobs with an optional ?status= filter.
func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	jobs, err := s.store.ListJobs(r.Context(), status)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list jobs")
		return
	}
	writeJSON(w, http.StatusOK, jobs)
}

// getJob handles GET /api/jobs/:id. In addition to the job, it reports whether
// the optional cc-status observation service is reachable via the
// cc_status_available field. cc-status is OPTIONAL: a down service yields
// cc_status_available=false but never fails this endpoint. When the job is
// waiting for user input, the current step's clarifying questions are surfaced
// as `pending_questions` so the UI can show WHAT the user must answer.
func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.GetJob(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	available := s.ccStatusAvailable(r.Context())

	// Surface the waiting step's questions (JSON string → parsed array) when the
	// job is paused for user input. Best-effort: a missing/unparseable snapshot
	// just leaves the field empty so the UI falls back to its generic message.
	var pendingQuestions any
	if job.Status == model.JobStatusWaitingUser && job.CurrentStepKind != "" {
		if step, qerr := s.store.GetStepByKind(r.Context(), job.ID, job.CurrentStepKind); qerr == nil && step != nil && step.PendingQuestions != "" {
			var qs any
			if jerr := json.Unmarshal([]byte(step.PendingQuestions), &qs); jerr == nil {
				pendingQuestions = qs
			}
		}
	}

	// Anonymous struct so we can extend the fixed model.Job with the flag
	// without changing the model package. JSON-marshals to the job's fields
	// plus "cc_status_available".
	writeJSON(w, http.StatusOK, struct {
		model.Job
		CCStatusAvailable bool `json:"cc_status_available"`
		PendingQuestions  any  `json:"pending_questions"`
	}{
		Job:               *job,
		CCStatusAvailable: available,
		PendingQuestions:  pendingQuestions,
	})
}

// ccStatusAvailable reports whether the cc-status service answers a health
// probe. A nil client (defensive) or any probe failure yields false without
// error — callers MUST treat cc-status as best-effort.
func (s *Server) ccStatusAvailable(ctx context.Context) bool {
	if s.cc == nil {
		return false
	}
	return s.cc.Health(ctx) == nil
}

// jobSteps handles GET /api/jobs/:id/steps.
func (s *Server) jobSteps(w http.ResponseWriter, r *http.Request) {
	steps, err := s.store.ListJobSteps(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	writeJSON(w, http.StatusOK, steps)
}

// jobExecutionSummary handles GET /api/jobs/:id/execution-summary — the six-card
// hydration snapshot. It returns one StepExecutionSummary per step (latest
// attempt + latest record). A missing job is 404.
func (s *Server) jobExecutionSummary(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	job, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	summaries, err := s.store.ListStepExecutionSummaries(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list summaries")
		return
	}
	writeJSON(w, http.StatusOK, summaries)
}

// getJobCollaborationPlan handles GET /api/jobs/:id/collaboration-plan. It
// returns the job together with its parsed collaboration plan, materialized
// steps, and dependency edges so the UI can render the lane/card view. A missing
// job is 404; invalid plan JSON is 500.
func (s *Server) getJobCollaborationPlan(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	job, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	steps, err := s.store.ListJobSteps(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	edges, err := s.store.ListJobStepEdges(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list step edges")
		return
	}
	var plan any = map[string]any{}
	if strings.TrimSpace(job.CollaborationPlanJSON) != "" {
		if err := json.Unmarshal([]byte(job.CollaborationPlanJSON), &plan); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "invalid collaboration plan"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job":   job,
		"plan":  plan,
		"steps": steps,
		"edges": edges,
	})
}

// jobStepExecutionRecords handles GET
// /api/jobs/:id/steps/:stepID/execution-records — the drawer pagination snapshot.
// It is scoped to one (job, step, attempt) tuple. attempt defaults to the step's
// latest attempt when absent; before_sequence (0/absent = newest page) and limit
// (store caps at 200) drive backwards pagination. Both the job and the step must
// exist and the step must belong to the requested job (else 404).
func (s *Server) jobStepExecutionRecords(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	stepID := Param(r, "stepID")

	job, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// Validate the step exists AND belongs to this job. ListJobSteps is the
	// existing API that returns the job's steps; matching by id confirms both
	// existence and ownership in one call.
	steps, err := s.store.ListJobSteps(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	var step *model.JobStep
	for i := range steps {
		if steps[i].ID == stepID {
			step = &steps[i]
			break
		}
	}
	if step == nil {
		writeError(w, http.StatusNotFound, "step not found")
		return
	}

	attempt := 0
	if a := r.URL.Query().Get("attempt"); a != "" {
		if n, err := strconv.Atoi(a); err == nil && n >= 1 {
			attempt = n
		}
	}
	if attempt == 0 {
		// Default to the latest attempt that produced any record for this step.
		// The job_steps.attempt counter only advances when the executor runs a
		// step, so a freshly-seeded step still reads attempt=0 even when records
		// exist for higher attempts — derive the default from the records
		// themselves via the per-step summary rollup.
		summaries, err := s.store.ListStepExecutionSummaries(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "list summaries")
			return
		}
		for _, sm := range summaries {
			if sm.StepID == stepID && sm.LatestAttempt > attempt {
				attempt = sm.LatestAttempt
			}
		}
	}

	beforeSequence := 0
	if bs := r.URL.Query().Get("before_sequence"); bs != "" {
		if n, err := strconv.Atoi(bs); err == nil && n > 0 {
			beforeSequence = n
		}
	}
	limit := 0
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}

	records, err := s.store.ListStepExecutionRecordPage(r.Context(), id, stepID, attempt, beforeSequence, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list records")
		return
	}
	if records == nil {
		records = []model.StepExecutionRecord{}
	}
	writeJSON(w, http.StatusOK, records)
}

// jobArtifacts handles GET /api/jobs/:id/artifacts.
func (s *Server) jobArtifacts(w http.ResponseWriter, r *http.Request) {
	arts, err := s.store.ListArtifactsByJob(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list artifacts")
		return
	}
	writeJSON(w, http.StatusOK, arts)
}

// cancelJob handles POST /api/jobs/:id/cancel. It cancels the job in the store
// and, if the job is currently being executed, kills the in-flight step via the
// executor.
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	if err := s.exec.Cancel(r.Context(), id); err != nil {
		// A missing job surfaces as a plain error from the executor; map it to
		// 404, everything else to 500.
		if err.Error() == "job not found" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "cancel job")
		return
	}
	job, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	s.hub.Publish(Event{Type: "job.updated", Data: job})
	writeJSON(w, http.StatusOK, job)
}

// answerJobBody is accepted by POST /api/jobs/:id/answer; either "answer" or
// "content" is accepted for interoperability with older clients.
type answerJobBody struct {
	Answer        string   `json:"answer"`
	Content       string   `json:"content"`
	StepID        string   `json:"stepId"`
	StepIDSnake   string   `json:"step_id"`
	Attempt       int      `json:"attempt"`
	AttachmentIDs []string `json:"attachmentIds,omitempty"`
}

// answerJob handles POST /api/jobs/:id/answer — appends a user conversation
// message to the job's thread. When the request carries stepId/attempt it is a
// task-internal clarification answer and is routed to exactly that waiting step;
// omitted stepId preserves the legacy current-step behavior.
func (s *Server) answerJob(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	job, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	var body answerJobBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	content := body.Answer
	if content == "" {
		content = body.Content
	}
	stepID := strings.TrimSpace(body.StepID)
	if stepID == "" {
		stepID = strings.TrimSpace(body.StepIDSnake)
	}

	var targetStep *model.JobStep
	if stepID != "" {
		if job.Status != model.JobStatusWaitingUser {
			writeError(w, http.StatusConflict, "job is not waiting for user input")
			return
		}
		steps, err := s.store.ListJobSteps(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "list steps")
			return
		}
		for i := range steps {
			if steps[i].ID == stepID {
				targetStep = &steps[i]
				break
			}
		}
		if targetStep == nil {
			writeError(w, http.StatusNotFound, "step not found")
			return
		}
		if targetStep.Status != model.StepStatusWaitingUser || !targetStep.NeedsUserInput {
			writeError(w, http.StatusConflict, "step is not waiting for user input")
			return
		}
		if body.Attempt > 0 && targetStep.Attempt != body.Attempt {
			writeError(w, http.StatusConflict, "stale step attempt")
			return
		}
	} else if job.Status == model.JobStatusWaitingUser {
		step, err := s.store.GetStepByKind(r.Context(), id, job.CurrentStepKind)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "get step")
			return
		}
		targetStep = step
	}
	originalTargetStep := targetStep
	reroutedForCompatibility := false
	if targetStep != nil {
		routeStep, rerouted, err := s.compatibilityRevalidationTarget(r.Context(), job, targetStep)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "route compatibility revalidation")
			return
		}
		if rerouted && routeStep != nil {
			targetStep = routeStep
			stepID = targetStep.ID
			reroutedForCompatibility = true
		}
	}

	msg := model.ConversationMessage{
		ID:        "conv_" + idpkg.New(),
		JobID:     id,
		Role:      "user",
		Content:   content,
		CreatedAt: time.Now(),
	}
	if err := s.store.AddConversation(r.Context(), msg); err != nil {
		writeError(w, http.StatusInternalServerError, "add conversation")
		return
	}
	if stepID != "" && job.DialogueID != "" && targetStep != nil {
		metadata, _ := json.Marshal(map[string]any{
			"taskId":   id,
			"stepId":   targetStep.ID,
			"attempt":  targetStep.Attempt,
			"agentKey": targetStep.AgentKey,
		})
		dlgMsg := model.DialogueMessage{
			ID:           "msg_" + idpkg.New(),
			DialogueID:   job.DialogueID,
			Role:         "user",
			Kind:         "task_clarification_answer",
			Content:      content,
			MetadataJSON: string(metadata),
			CreatedAt:    time.Now(),
		}
		if err := s.store.AppendDialogueMessage(r.Context(), dlgMsg); err != nil {
			writeError(w, http.StatusInternalServerError, "append dialogue answer")
			return
		}
		// Bind any attachments the user pinned to this task-internal clarification
		// answer. Each id is validated (active check) by createDialogueAttachmentRefs;
		// only the attachment id + focus key are persisted, never file content or
		// credentials. Without this the attachments the user supplied during a
		// 业务逻辑/界面解析/数据抓取 phase were dropped.
		if len(body.AttachmentIDs) > 0 {
			focusKey := stepKindToFocusKey(targetStep.Kind)
			if err := s.createDialogueAttachmentRefs(r.Context(), job.DialogueID, dlgMsg.ID, body.AttachmentIDs, focusKey); err != nil {
				writeError(w, http.StatusBadRequest, "invalid attachment reference")
				return
			}
		}
	}
	if job.Status == model.JobStatusWaitingUser && targetStep != nil {
		if isManualStepConfirmationQuestions(targetStep.PendingQuestions) {
			writeError(w, http.StatusConflict, "step is waiting for manual confirmation; use the step confirm endpoint")
			return
		}
		// Persist the user's answer onto the step's user_prompt so the re-run can
		// read it (the generative-step prompts append step.UserPrompt as a
		// clarification). Without this the step re-runs with identical input and
		// re-asks the same question.
		if strings.TrimSpace(content) != "" {
			if err := s.store.SetStepUserPrompt(r.Context(), targetStep.ID, content); err != nil {
				writeError(w, http.StatusInternalServerError, "set step answer")
				return
			}
		}
		if err := s.store.ResetStepToPending(r.Context(), targetStep.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "reset step")
			return
		}
		if reroutedForCompatibility && originalTargetStep != nil && originalTargetStep.ID != targetStep.ID {
			if err := s.store.ResetStepToPending(r.Context(), originalTargetStep.ID); err != nil {
				writeError(w, http.StatusInternalServerError, "reset compatibility step")
				return
			}
			if err := s.markCompatibilityRevalidationRequested(r.Context(), id, originalTargetStep.ID); err != nil {
				writeError(w, http.StatusInternalServerError, "mark compatibility revalidation")
				return
			}
			s.publishStepUpdated(r.Context(), originalTargetStep.ID)
		}
		// Step-scoped answers may target a waiting step that is not the job's current
		// pointer. Move current_step_kind before re-queueing so the executor reruns
		// the step the user actually answered.
		if stepID != "" {
			if err := s.store.AdvanceJobStep(r.Context(), id, targetStep.Kind); err != nil {
				writeError(w, http.StatusInternalServerError, "point job to step")
				return
			}
		}
		s.publishStepUpdated(r.Context(), targetStep.ID)
		if err := s.store.MarkJobQueued(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, "queue job")
			return
		}
		s.exec.Signal()
		job, err = s.store.GetJob(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "get job")
			return
		}
	}
	s.hub.Publish(Event{Type: "job.updated", Data: job})
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) compatibilityRevalidationTarget(ctx context.Context, job *model.Job, targetStep *model.JobStep) (*model.JobStep, bool, error) {
	if job == nil || targetStep == nil || targetStep.Kind != model.StepDataIntegration {
		return targetStep, false, nil
	}
	refs, err := s.store.ListWorkbenchArtifactRefsByJob(ctx, job.ID)
	if err != nil {
		return nil, false, err
	}
	hasCompatibilityFailure := false
	for _, ref := range refs {
		if ref.Kind == model.WorkbenchArtifactDataContract && ref.Status == "compatible_failed" {
			hasCompatibilityFailure = true
			break
		}
	}
	if !hasCompatibilityFailure {
		return targetStep, false, nil
	}
	steps, err := s.store.ListJobSteps(ctx, job.ID)
	if err != nil {
		return nil, false, err
	}
	for i := range steps {
		if steps[i].Kind == model.StepDesignContract {
			return &steps[i], true, nil
		}
	}
	return targetStep, false, nil
}

func (s *Server) markCompatibilityRevalidationRequested(ctx context.Context, jobID string, dataStepID string) error {
	refs, err := s.store.ListWorkbenchArtifactRefsByJob(ctx, jobID)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if ref.Kind != model.WorkbenchArtifactDataContract || ref.Status != "compatible_failed" {
			continue
		}
		if dataStepID != "" && ref.StepID != dataStepID {
			continue
		}
		ref.Status = "interface_revalidation_requested"
		if err := s.store.UpsertWorkbenchArtifactRef(ctx, ref); err != nil {
			return err
		}
	}
	return nil
}

func isManualStepConfirmationQuestions(raw string) bool {
	if strings.TrimSpace(raw) == "" {
		return false
	}
	var items []struct {
		Type    string `json:"type"`
		Confirm bool   `json:"confirm"`
	}
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return false
	}
	for _, item := range items {
		if item.Type == "manual_step_confirmation" && item.Confirm {
			return true
		}
	}
	return false
}

// stepKindToFocusKey projects a job step kind onto the workbench focus key the
// task-internal clarification binding uses. It mirrors currentWorkbenchFocusKey
// (dialogue_handlers.go) so an attachment pinned during a task-internal
// clarification lands on the same focus lane as the step that asked for it.
func stepKindToFocusKey(kind model.StepKind) string {
	switch kind {
	case model.StepDesignContract:
		return "interface_parsing"
	case model.StepDataIntegration:
		return "data_capture"
	case model.StepSolutionDesign, model.StepCodeGeneration, model.StepCodeReview, model.StepSecurityReview, model.StepTestVerification, model.StepProductAcceptance, model.StepImageBuild, model.StepDeployment:
		return "production_delivery"
	default:
		return "business_logic"
	}
}

// retryCurrentStep handles POST /api/jobs/:id/retry-current-step. It resets the
// job's current failed step to pending and re-queues the job. Only failed jobs
// may be retried; anything else is a 409.
func (s *Server) retryCurrentStep(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	job, err := s.exec.RetryCurrentStep(r.Context(), id)
	if err != nil {
		// A missing job → 404; a non-retryable state → 409; otherwise 500.
		if err.Error() == "job not found" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	s.hub.Publish(Event{Type: "job.updated", Data: job})
	writeJSON(w, http.StatusOK, job)
}

type confirmJobStepBody struct {
	Attempt int `json:"attempt"`
}

func (s *Server) confirmJobStep(w http.ResponseWriter, r *http.Request) {
	jobID := Param(r, "id")
	stepID := Param(r, "stepID")
	var body confirmJobStepBody
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
	}
	job, err := s.exec.ConfirmManualStep(r.Context(), jobID, stepID, body.Attempt)
	if err != nil {
		switch {
		case err.Error() == "job not found" || err.Error() == "step not found":
			writeError(w, http.StatusNotFound, "not found")
		default:
			writeError(w, http.StatusConflict, err.Error())
		}
		return
	}
	s.publishStepUpdated(r.Context(), stepID)
	s.hub.Publish(Event{Type: "job.updated", Data: job})
	writeJSON(w, http.StatusOK, job)
}

type confirmDataAccessBody struct {
	Version string `json:"version"`
	Attempt int    `json:"attempt"`
}

func (s *Server) confirmDataAccessStep(w http.ResponseWriter, r *http.Request) {
	jobID := Param(r, "id")
	stepID := Param(r, "stepID")
	var body confirmDataAccessBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	body.Version = strings.TrimSpace(body.Version)
	if body.Version == "" {
		writeError(w, http.StatusBadRequest, "version required")
		return
	}
	if err := s.exec.ValidateDataAccessStepConfirmation(r.Context(), jobID, stepID, body.Attempt); err != nil {
		switch {
		case err.Error() == "job not found" || err.Error() == "step not found":
			writeError(w, http.StatusNotFound, "not found")
		default:
			writeError(w, http.StatusConflict, err.Error())
		}
		return
	}
	// 数据接入确认只固化当前草案版本，不重跑模型；推进由 executor 统一处理。
	if err := dataaccess.FinalizeVersion(s.cfg.ArtifactRoot, jobID, body.Version, "user"); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	job, err := s.exec.ConfirmDataAccessStep(r.Context(), jobID, stepID, body.Attempt)
	if err != nil {
		switch {
		case err.Error() == "job not found" || err.Error() == "step not found":
			writeError(w, http.StatusNotFound, "not found")
		default:
			writeError(w, http.StatusConflict, err.Error())
		}
		return
	}
	s.publishStepUpdated(r.Context(), stepID)
	s.hub.Publish(Event{Type: "job.updated", Data: job})
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) repairFromFailure(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	job, err := s.exec.RepairFromFailure(r.Context(), id)
	if err != nil {
		if err.Error() == "job not found" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	s.hub.Publish(Event{Type: "job.updated", Data: job})
	writeJSON(w, http.StatusOK, job)
}

// patchJobStepSnapshot handles PATCH
// /api/jobs/:id/steps/:stepID/snapshot — overwrites the per-task snapshot
// (job_steps.snapshot_json) for one step. This edits ONLY this generation
// task's copy; it never writes back to the global agents/skills registry.
// Response contract: 200 {step_id, snapshot}, 400 invalid/empty JSON,
// 404 step not found, 409 step has started (snapshot read-only), 500 store error.
func (s *Server) patchJobStepSnapshot(w http.ResponseWriter, r *http.Request) {
	jobID := Param(r, "id")
	stepID := Param(r, "stepID")

	var body struct {
		Snapshot json.RawMessage `json:"snapshot"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(body.Snapshot) == 0 || !json.Valid(body.Snapshot) {
		writeError(w, http.StatusBadRequest, "snapshot must be valid json")
		return
	}

	// Validate the step exists AND belongs to this job. ListJobSteps is the
	// existing API that returns the job's steps; matching by id confirms both
	// existence and ownership in one call. It also returns the step's full row
	// (including Status), so the read-only gate below is server-authoritative
	// even if the UI is stale.
	steps, err := s.store.ListJobSteps(r.Context(), jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	var step *model.JobStep
	for i := range steps {
		if steps[i].ID == stepID {
			step = &steps[i]
			break
		}
	}
	if step == nil {
		writeError(w, http.StatusNotFound, "step not found")
		return
	}

	// Status gate (data-integrity invariant): a snapshot is editable ONLY while
	// its step is still pending — i.e. before the upcoming attempt starts. Any
	// other status (running/waiting_user/succeeded/failed/canceled/skipped, plus
	// historical attempts) is read-only. Reject with 409 so a stale UI cannot
	// mutate a snapshot that an in-flight or terminal attempt already consumed.
	if step.Status != model.StepStatusPending {
		writeError(w, http.StatusConflict, "snapshot is read-only after the step has started")
		return
	}

	if err := s.store.SetStepSnapshot(r.Context(), stepID, string(body.Snapshot)); err != nil {
		writeError(w, http.StatusInternalServerError, "update snapshot")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"step_id": stepID, "snapshot": json.RawMessage(body.Snapshot)})
}
