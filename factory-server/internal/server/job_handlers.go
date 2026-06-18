package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

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
	{model.StepImageBuild, "deployer"},
	{model.StepDeployment, "deployer"},
}

// createJobBody is the request body accepted by POST /api/jobs.
type createJobBody struct {
	Prompt string `json:"prompt"`
}

// createJob handles POST /api/jobs. It enqueues a job at the first pipeline
// step (requirement_analysis) and seeds all six steps as pending, then records
// the user's prompt as the first conversation message.
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

	now := time.Now()
	jobID := "job_" + idpkg.New()
	job := model.Job{
		ID:              jobID,
		UserPrompt:      body.Prompt,
		Status:          model.JobStatusQueued,
		CurrentStepKind: model.StepRequirementAnalysis,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.store.CreateJob(r.Context(), job); err != nil {
		writeError(w, http.StatusInternalServerError, "create job")
		return
	}

	for i, sp := range stepPlan {
		step := model.JobStep{
			ID:       "step_" + idpkg.New(),
			JobID:    jobID,
			Kind:     sp.kind,
			Seq:      i + 1,
			AgentKey: sp.agentKey,
			Status:   model.StepStatusPending,
			Attempt:  0,
		}
		if err := s.store.CreateJobStep(r.Context(), step); err != nil {
			writeError(w, http.StatusInternalServerError, "create step")
			return
		}
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

	// Wake the executor's drain loop so it picks up the new queued job.
	s.exec.Signal()

	writeJSON(w, http.StatusCreated, job)
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
// cc_status_available=false but never fails this endpoint.
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

	// Anonymous struct so we can extend the fixed model.Job with the flag
	// without changing the model package. JSON-marshals to the job's fields
	// plus "cc_status_available".
	writeJSON(w, http.StatusOK, struct {
		model.Job
		CCStatusAvailable bool `json:"cc_status_available"`
	}{
		Job:               *job,
		CCStatusAvailable: available,
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
	Answer  string `json:"answer"`
	Content string `json:"content"`
}

// answerJob handles POST /api/jobs/:id/answer — appends a user conversation
// message to the job's thread.
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
	s.hub.Publish(Event{Type: "job.updated", Data: job})
	writeJSON(w, http.StatusOK, job)
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
