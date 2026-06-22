package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
	"github.com/weimengtsgit/xian630/factory-server/internal/executor"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// publishClarificationEvent forwards a normalized clarification.StreamEvent onto
// the SSE hub under its own Type. The hub accepts arbitrary event types, so
// events.go needs no change. Raw claude stdout is never forwarded — only the
// normalized clarification.* events the runner emits.
func (s *Server) publishClarificationEvent(ev clarification.StreamEvent) {
	if s.hub == nil {
		return
	}
	s.hub.Publish(Event{Type: ev.Type, Data: ev})
}

// ---- request/response bodies -------------------------------------------------

type createClarificationBody struct {
	Prompt        string `json:"prompt"`
	AbandonActive bool   `json:"abandonActive"`
}

type addClarificationMessageBody struct {
	Content string `json:"content"`
}

type clarificationAnswerBody struct {
	QuestionID string `json:"questionId"`
	Value      string `json:"value"`
}

type clarificationBatchAnswersBody struct {
	Answers []clarificationAnswerBody `json:"answers"`
}

type patchRequirementBody struct {
	Requirement json.RawMessage `json:"requirement"`
}

type confirmClarificationBody struct {
	Requirement json.RawMessage `json:"requirement"`
}

// clarificationView is the enriched GET shape: the session plus its parsed
// requirement (empty object when requirement_json is blank/invalid). The round
// is read straight off the persisted session row — runRoundAndPersist advances
// the persisted `round` column via Store.UpdateClarificationRound, so the
// response (which re-reads the session after persisting) always reflects the
// round that actually ran. No response-side round override is needed.
type clarificationView struct {
	model.ClarificationSession
	Requirement clarification.Requirement `json:"requirement"`
}

func (s *Server) viewFromSession(sess *model.ClarificationSession) clarificationView {
	v := clarificationView{ClarificationSession: *sess}
	if sess.RequirementJSON != "" {
		_ = json.Unmarshal([]byte(sess.RequirementJSON), &v.Requirement)
	}
	if v.Requirement.AppType == "" && v.Requirement.AppName == "" {
		// Normalize an unpopulated requirement to an explicit empty object so the
		// frontend always sees {} rather than a zero struct with nil slices.
		v.Requirement.GenerationProfile = nil
	}
	return v
}

// ---- handlers ---------------------------------------------------------------

// createClarification handles POST /api/clarifications. It rejects empty
// prompts, resolves an existing active session (abandon-on-flag or 409), creates
// a session + the first user message, publishes clarification.created, then runs
// round 1 synchronously. On round failure the session becomes failed and a
// clarification.failed event is published; NO job is ever created here. A job is
// only created by confirmClarification.
func (s *Server) createClarification(w http.ResponseWriter, r *http.Request) {
	var body createClarificationBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.Prompt == "" {
		writeError(w, http.StatusBadRequest, "missing prompt")
		return
	}

	ctx := r.Context()
	if body.AbandonActive {
		if active, err := s.store.GetActiveClarificationSession(ctx); err != nil {
			writeError(w, http.StatusInternalServerError, "get active session")
			return
		} else if active != nil {
			if err := s.store.SetClarificationStatus(ctx, active.ID, model.ClarificationStatusAbandoned, "", ""); err != nil {
				writeError(w, http.StatusInternalServerError, "abandon active session")
				return
			}
			s.publishClarificationEvent(clarification.StreamEvent{
				Type:      "clarification.abandoned",
				SessionID: active.ID,
				Data:      active,
			})
		}
	}

	now := time.Now()
	sessID := "clar_" + idpkg.New()
	reqJSON := "{}"
	sess := model.ClarificationSession{
		ID:              sessID,
		Status:          model.ClarificationStatusActive,
		InitialPrompt:   body.Prompt,
		Round:           0,
		MaxRounds:       3,
		RequirementJSON: reqJSON,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.store.CreateClarificationSession(ctx, sess); err != nil {
		writeError(w, http.StatusInternalServerError, "create session")
		return
	}
	if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
		ID:        "cmsg_" + idpkg.New(),
		SessionID: sessID,
		Role:      "user",
		Kind:      "prompt",
		Content:   body.Prompt,
		CreatedAt: now,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "create prompt message")
		return
	}
	s.publishClarificationEvent(clarification.StreamEvent{
		Type:      "clarification.created",
		SessionID: sessID,
		Data:      sess,
	})

	// Run round 1 synchronously. Events stream live to any pre-subscribed SSE
	// client via publishClarificationEvent during the request. On failure the
	// session is marked failed (no job) and we still return 200 with the session.
	updated, _, ok := s.runRoundAndPersist(ctx, sessID, 1)
	if !ok {
		// Failure path already set status=failed + published clarification.failed.
		writeJSON(w, http.StatusOK, s.viewFromSession(updated))
		return
	}
	writeJSON(w, http.StatusCreated, s.viewFromSession(updated))
}

// listClarifications handles GET /api/clarifications.
func (s *Server) listClarifications(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	sessions, err := s.store.ListClarificationSessions(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list sessions")
		return
	}
	out := make([]clarificationView, 0, len(sessions))
	for i := range sessions {
		sess := sessions[i]
		out = append(out, s.viewFromSession(&sess))
	}
	writeJSON(w, http.StatusOK, out)
}

// getActiveClarification handles GET /api/clarifications/active. It lets the
// portal rehydrate an in-flight clarification after a browser reload, avoiding
// a confusing POST /api/clarifications 409 when the server still has an active
// session.
func (s *Server) getActiveClarification(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetActiveClarificationSession(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get active session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	sess, err = s.normalizeClarificationReadiness(r.Context(), sess)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "normalize session")
		return
	}
	writeJSON(w, http.StatusOK, s.viewFromSession(sess))
}

// getClarification handles GET /api/clarifications/:id — returns the session
// with its parsed requirement.
func (s *Server) getClarification(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetClarificationSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, s.viewFromSession(sess))
}

// listClarificationMessages handles GET /api/clarifications/:id/messages.
func (s *Server) listClarificationMessages(w http.ResponseWriter, r *http.Request) {
	msgs, err := s.store.ListClarificationMessages(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list messages")
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

// addClarificationMessage handles POST /api/clarifications/:id/messages. It
// appends a user message then runs the next round (round = current+1, capped at
// max_rounds; at the cap the session transitions to ready_to_confirm instead of
// running again).
func (s *Server) addClarificationMessage(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	sess, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if clarificationStatusRejectsMessages(sess.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session does not accept messages", "status": sess.Status})
		return
	}

	var body addClarificationMessageBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.Content == "" {
		writeError(w, http.StatusBadRequest, "missing content")
		return
	}

	if err := s.store.AddClarificationMessage(r.Context(), model.ClarificationMessage{
		ID:        "cmsg_" + idpkg.New(),
		SessionID: id,
		Role:      "user",
		Kind:      "message",
		Content:   body.Content,
		CreatedAt: time.Now(),
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "add message")
		return
	}

	ctx := r.Context()
	updated, ok := s.advanceAfterUserTurn(ctx, id, sess)
	writeJSON(w, http.StatusOK, s.viewFromSession(updated))
	if !ok {
		// Round failed: the view already carries status=failed. Nothing else to
		// do — a job is never created on this path.
		return
	}
}

// answerClarification handles POST /api/clarifications/:id/answers. It persists
// the structured answer as a user message (kind=answer) and merges it into the
// session's requirement_json where it maps to a known requirement field.
func (s *Server) answerClarification(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	sess, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if clarificationStatusRejectsAnswers(sess.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session does not accept answers", "status": sess.Status})
		return
	}

	var body clarificationAnswerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.QuestionID == "" {
		writeError(w, http.StatusBadRequest, "missing questionId")
		return
	}

	req := s.parseRequirement(sess.RequirementJSON)
	if err := s.persistClarificationAnswer(r.Context(), id, body, &req); err != nil {
		writeError(w, http.StatusInternalServerError, "add answer message")
		return
	}
	reqBytes, _ := json.Marshal(req)
	if err := s.store.UpdateClarificationRequirement(r.Context(), id, string(reqBytes)); err != nil {
		writeError(w, http.StatusInternalServerError, "update requirement")
		return
	}

	updated, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil || updated == nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	s.publishClarificationEvent(clarification.StreamEvent{
		Type:      "clarification.summary.updated",
		SessionID: id,
		Data:      req,
	})
	// Advance the round exactly like the free-text path (P2#2): the structured
	// answer + merged requirement must be visible to the next clarifier round,
	// otherwise the conversation stalls before ready_to_confirm.
	ctx := r.Context()
	advanced, ok := s.advanceAfterUserTurn(ctx, id, updated)
	writeJSON(w, http.StatusOK, s.viewFromSession(advanced))
	if !ok {
		// Round failed: the view already carries status=failed.
		return
	}
}

// answerClarificationBatch handles POST /api/clarifications/:id/answers/batch.
// The portal uses this as a round-level form submit: every visible question in
// the current round is persisted, the requirement is merged once, then the
// clarifier advances exactly ONE round. This prevents option clicks from
// triggering multiple overlapping turns.
func (s *Server) answerClarificationBatch(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	sess, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if clarificationStatusRejectsAnswers(sess.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session does not accept answers", "status": sess.Status})
		return
	}

	var body clarificationBatchAnswersBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(body.Answers) == 0 {
		writeError(w, http.StatusBadRequest, "missing answers")
		return
	}
	for _, answer := range body.Answers {
		if answer.QuestionID == "" {
			writeError(w, http.StatusBadRequest, "missing questionId")
			return
		}
	}

	req := s.parseRequirement(sess.RequirementJSON)
	for _, answer := range body.Answers {
		if err := s.persistClarificationAnswer(r.Context(), id, answer, &req); err != nil {
			writeError(w, http.StatusInternalServerError, "add answer message")
			return
		}
	}
	reqBytes, _ := json.Marshal(req)
	if err := s.store.UpdateClarificationRequirement(r.Context(), id, string(reqBytes)); err != nil {
		writeError(w, http.StatusInternalServerError, "update requirement")
		return
	}

	updated, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil || updated == nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	s.publishClarificationEvent(clarification.StreamEvent{
		Type:      "clarification.summary.updated",
		SessionID: id,
		Data:      req,
	})

	advanced, ok := s.advanceAfterUserTurn(r.Context(), id, updated)
	writeJSON(w, http.StatusOK, s.viewFromSession(advanced))
	if !ok {
		return
	}
}

// patchClarificationRequirement handles PATCH /api/clarifications/:id/requirement.
// It accepts ONLY the business fields (appType, appName, targetUsers,
// coreScenario, primaryView, mainEntities, dataPolicy, acceptanceFocus,
// blueprintRefs). Client-supplied generationProfile is REJECTED with 400 —
// generationProfile is Factory-derived and users cannot edit it; it is always
// recomputed server-side from appType.
func (s *Server) patchClarificationRequirement(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	sess, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if isTerminalClarificationStatus(sess.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "session is terminal", "status": sess.Status})
		return
	}

	var body patchRequirementBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(body.Requirement) == 0 {
		writeError(w, http.StatusBadRequest, "missing requirement")
		return
	}

	// Decode into the canonical requirement to validate the shape and to detect
	// a client-supplied generationProfile (which we reject outright).
	var incoming clarification.Requirement
	if err := json.Unmarshal(body.Requirement, &incoming); err != nil {
		writeError(w, http.StatusBadRequest, "invalid requirement json")
		return
	}
	if len(incoming.GenerationProfile) > 0 {
		writeError(w, http.StatusBadRequest, "generationProfile is server-derived and cannot be set by the client")
		return
	}
	// Fail closed on unsafe blueprintRef slugs (P2#1): a slug like "../evil"
	// would otherwise flow into a workspace-relative path builder. Reject before
	// any path is constructed or persisted.
	if !blueprintRefsAllSafe(incoming.BlueprintRefs) {
		writeError(w, http.StatusBadRequest, "invalid blueprintRef slug")
		return
	}

	// Start from the persisted requirement and overlay the business fields the
	// client is allowed to edit, preserving any previously-derived profile.
	current := s.parseRequirement(sess.RequirementJSON)
	current.AppType = incoming.AppType
	current.AppName = incoming.AppName
	current.TargetUsers = incoming.TargetUsers
	current.CoreScenario = incoming.CoreScenario
	current.PrimaryView = incoming.PrimaryView
	current.MainEntities = incoming.MainEntities
	current.DataPolicy = incoming.DataPolicy
	current.AcceptanceFocus = incoming.AcceptanceFocus
	current.BlueprintRefs = incoming.BlueprintRefs
	// Always (re)compute the profile from appType — never trust the client.
	current.GenerationProfile = generationProfileForAppType(current.AppType)

	reqBytes, _ := json.Marshal(current)
	if err := s.store.UpdateClarificationRequirement(r.Context(), id, string(reqBytes)); err != nil {
		writeError(w, http.StatusInternalServerError, "update requirement")
		return
	}
	updated, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil || updated == nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	s.publishClarificationEvent(clarification.StreamEvent{
		Type:      "clarification.summary.updated",
		SessionID: id,
		Data:      current,
	})
	writeJSON(w, http.StatusOK, s.viewFromSession(updated))
}

// retryClarificationRound handles POST /api/clarifications/:id/retry-current-round.
// It clears any failed state and re-runs the session's current round number.
func (s *Server) retryClarificationRound(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	sess, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// retry-current-round is the FAILED-recovery path: only a failed session may be
	// retried. A confirmed/abandoned session is terminal (no further user turns),
	// and re-running a non-failed round is not a documented turn. Reject anything
	// that is not failed so a stale UI / direct API call cannot revive a terminal
	// session back to waiting_user/ready_to_confirm.
	if sess.Status != model.ClarificationStatusFailed {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":  "session is not failed; retry-current-round only applies to failed sessions",
			"status": sess.Status,
		})
		return
	}

	// Clear failed state before re-running so the next round can succeed.
	if sess.Status == model.ClarificationStatusFailed {
		if err := s.store.SetClarificationStatus(r.Context(), id, model.ClarificationStatusActive, "", ""); err != nil {
			writeError(w, http.StatusInternalServerError, "clear failed state")
			return
		}
	}

	// Re-run the current round. runRoundAndPersist advances the persisted round
	// column, so sess.Round is the true current round for every session this
	// handler sees (including the round-1 failure case, where round 1 was
	// persisted before the round failed).
	retryRound := sess.Round
	if retryRound < 1 {
		retryRound = 1
	}

	updated, _, ok := s.runRoundAndPersist(r.Context(), id, retryRound)
	if !ok {
		writeJSON(w, http.StatusOK, s.viewFromSession(updated))
		return
	}
	writeJSON(w, http.StatusOK, s.viewFromSession(updated))
}

// abandonClarification handles POST /api/clarifications/:id/abandon.
func (s *Server) abandonClarification(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	sess, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := s.store.SetClarificationStatus(r.Context(), id, model.ClarificationStatusAbandoned, "", ""); err != nil {
		writeError(w, http.StatusInternalServerError, "abandon session")
		return
	}
	s.publishClarificationEvent(clarification.StreamEvent{
		Type:      "clarification.abandoned",
		SessionID: id,
		Data:      sess,
	})
	updated, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil || updated == nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	writeJSON(w, http.StatusOK, s.viewFromSession(updated))
}

// confirmClarification handles POST /api/clarifications/:id/confirm. It validates
// the confirmed requirement (at minimum appType, appName, and a non-empty
// generationProfile), creates a queued generation Job + its six steps (mirroring
// createJob), links it to the session, sets status confirmed, and signals the
// executor. The created Job carries the CONFIRMED requirement JSON (and the
// session id) so the requirement_analysis pipeline step can audit/freeze it
// rather than re-clarify. This is the NORMAL job-creation path; the direct
// POST /api/jobs handler is gated to require a confirmed requirement too.
func (s *Server) confirmClarification(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	sess, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// Status gate (P1#2): only a ready_to_confirm session may be confirmed. This
	// prevents a failed/abandoned/active session from spawning a generation job.
	if sess.Status != model.ClarificationStatusReadyToConfirm {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":  "session not ready to confirm",
			"status": sess.Status,
		})
		return
	}

	var body confirmClarificationBody
	// An empty body is allowed: we confirm the session's already-persisted
	// requirement. A supplied requirement (if any) is validated and used.
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
	}

	req := s.parseRequirement(sess.RequirementJSON)
	if len(body.Requirement) > 0 {
		var incoming clarification.Requirement
		if err := json.Unmarshal(body.Requirement, &incoming); err != nil {
			writeError(w, http.StatusBadRequest, "invalid requirement json")
			return
		}
		// The confirmed requirement may carry business fields; recompute the
		// profile from appType so a client can never inject one at confirm time.
		incoming.GenerationProfile = generationProfileForAppType(incoming.AppType)
		req = incoming
	} else {
		// Recompute the profile defensively even on the persisted requirement.
		req.GenerationProfile = generationProfileForAppType(req.AppType)
	}

	// Fail closed on unsafe blueprintRef slugs (P2#1): unified check covers BOTH
	// the client-supplied requirement (body.Requirement branch above) AND the
	// empty-body path that confirms the persisted requirement as-is.
	if !blueprintRefsAllSafe(req.BlueprintRefs) {
		writeError(w, http.StatusBadRequest, "invalid blueprintRef slug")
		return
	}

	if missing := missingRequiredFields(req); len(missing) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "confirmed requirement missing required fields",
			"missing": missing,
		})
		return
	}

	// Persist the finalized requirement before creating the job.
	reqBytes, _ := json.Marshal(req)
	if err := s.store.UpdateClarificationRequirement(r.Context(), id, string(reqBytes)); err != nil {
		writeError(w, http.StatusInternalServerError, "update requirement")
		return
	}

	// Create the generation job + six steps, mirroring createJob. The job now
	// carries the CONFIRMED requirement so the requirement_analysis pipeline step
	// can audit/freeze it (Task 5) instead of clarifying from scratch.
	now := time.Now()
	jobID := "job_" + idpkg.New()
	displayName := req.AppName
	if displayName == "" {
		displayName = deriveJobDisplayName(sess.InitialPrompt)
	}
	job := model.Job{
		ID:                       jobID,
		UserPrompt:               sess.InitialPrompt,
		AppName:                  displayName,
		Status:                   model.JobStatusQueued,
		CurrentStepKind:          model.StepRequirementAnalysis,
		ClarificationSessionID:   id,
		ConfirmedRequirementJSON: string(reqBytes),
		CreatedAt:                now,
		UpdatedAt:                now,
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

	if err := s.store.LinkClarificationJob(r.Context(), id, jobID); err != nil {
		writeError(w, http.StatusInternalServerError, "link job")
		return
	}
	if err := s.store.SetClarificationStatus(r.Context(), id, model.ClarificationStatusConfirmed, "", ""); err != nil {
		writeError(w, http.StatusInternalServerError, "set confirmed")
		return
	}

	// Re-read the session BEFORE publishing so the confirmed SSE event carries the
	// refreshed session (status=confirmed, created_job_id set) — NOT the
	// requirement. Publishing `req` here previously overwrote the frontend's
	// session slot with the requirement object (no id/status), which then routed
	// subsequent chat to /api/clarifications/undefined/messages.
	updated, err := s.store.GetClarificationSession(r.Context(), id)
	if err != nil || updated == nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}

	s.hub.Publish(Event{Type: "job.created", Data: job})
	s.logEvent("job_queued", map[string]any{
		"job_id":                   job.ID,
		"app_name":                 job.AppName,
		"current_step_kind":        string(job.CurrentStepKind),
		"clarification_session_id": job.ClarificationSessionID,
		"source":                   "clarification_confirm",
	})
	s.publishClarificationEvent(clarification.StreamEvent{
		Type:      "clarification.confirmed",
		SessionID: id,
		Data:      updated,
	})

	// Wake the executor's drain loop so it picks up the new queued job.
	s.exec.Signal()

	writeJSON(w, http.StatusOK, s.viewFromSession(updated))
}

// ---- shared helpers ---------------------------------------------------------

// runRoundAndPersist runs one clarification round for the session at the given
// round number, persists the resulting work-log/questions/requirement, advances
// the persisted `round` column, and updates the session status. It returns the
// refreshed session, the authoritative round number it ran, and a bool that is
// false when the round failed (the caller should return 200 with the failed
// session in that case). On failure it advances the persisted round to the
// round that was attempted, sets status=failed, records the error code/message,
// and publishes clarification.failed; NO job is created.
//
// The round is run SYNCHRONOUSLY: the request blocks until the round completes
// (fast with the test fake, ~seconds with the real CLI). Events are published to
// the hub DURING the request, so any SSE client already subscribed to
// /api/events receives them live. This matches the plan's testable shape.
//
// Round persistence: the `round` column is advanced (via
// Store.UpdateClarificationRound) to the round that actually ran, so the
// persisted session is the single source of truth. GET /api/clarifications/:id
// reads it directly, and retryClarificationRound reads the current round from
// the persisted session without a fallback.
func (s *Server) runRoundAndPersist(ctx context.Context, sessID string, round int) (*model.ClarificationSession, int, bool) {
	sess, err := s.store.GetClarificationSession(ctx, sessID)
	if err != nil || sess == nil {
		return sess, round, false
	}
	msgs, err := s.store.ListClarificationMessages(ctx, sessID)
	if err != nil {
		return sess, round, false
	}
	views := make([]clarification.MessageView, 0, len(msgs))
	for _, m := range msgs {
		views = append(views, clarification.MessageView{Role: m.Role, Kind: m.Kind, Content: m.Content})
	}
	input := clarification.RoundInput{
		SessionID:          sessID,
		Round:              round,
		MaxRounds:          sess.MaxRounds,
		InitialPrompt:      sess.InitialPrompt,
		Messages:           views,
		CurrentRequirement: s.parseRequirement(sess.RequirementJSON),
	}

	out, err := s.clarifier.RunRound(ctx, input, s.publishClarificationEvent)
	if err != nil {
		// Round failed: advance the persisted round to the round we attempted so
		// retry-current-round re-runs the right round, mark the session failed,
		// publish a normalized failure event, and do NOT create a job.
		_ = s.store.UpdateClarificationRound(ctx, sessID, round)
		errorCode := clarificationFailureCode(err)
		_ = s.store.SetClarificationStatus(ctx, sessID, model.ClarificationStatusFailed, string(errorCode), err.Error())
		s.publishClarificationEvent(clarification.StreamEvent{
			Type:      "clarification.failed",
			SessionID: sessID,
			Data: map[string]any{
				"session_id":    sessID,
				"error_code":    string(errorCode),
				"error_message": err.Error(),
			},
		})
		refreshed, _ := s.store.GetClarificationSession(ctx, sessID)
		if refreshed == nil {
			refreshed = sess
		}
		return refreshed, round, false
	}

	// Authoritative round number: prefer the runner's reported round, falling
	// back to the round we requested when the runner omits it.
	roundN := out.Round
	if roundN == 0 {
		roundN = round
	}

	// Persist the round output. Sanitize LLM-produced blueprintRefs so an unsafe
	// slug (e.g. "../x") can never land in the persisted requirement — sanitize,
	// not fail: a single bad slug should not abort the round; the executor drops
	// unsafe refs for Reads regardless (wave-1 path-builder containment).
	out.Requirement = mergeRequirementDefaults(out.Requirement, input.CurrentRequirement)
	out.Requirement.BlueprintRefs = sanitizeBlueprintRefs(out.Requirement.BlueprintRefs)
	now := time.Now()
	reqBytes, _ := json.Marshal(out.Requirement)
	if err := s.store.UpdateClarificationRequirement(ctx, sessID, string(reqBytes)); err != nil {
		return sess, roundN, false
	}
	for _, wl := range out.WorkLog {
		if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
			ID:        "cmsg_" + idpkg.New(),
			SessionID: sessID,
			Role:      "agent",
			Kind:      "analysis_work_log",
			Content:   wl.Content,
			CreatedAt: now,
		}); err != nil {
			return sess, round, false
		}
	}
	for _, q := range out.Questions {
		qBytes, _ := json.Marshal(q)
		if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
			ID:           "cmsg_" + idpkg.New(),
			SessionID:    sessID,
			Role:         "agent",
			Kind:         "question",
			MetadataJSON: string(qBytes),
			CreatedAt:    now,
		}); err != nil {
			return sess, roundN, false
		}
	}

	// Map the runner's reported status onto the session status, defaulting to
	// waiting_user when the runner did not declare readiness.
	status := model.ClarificationStatusWaitingUser
	if clarification.IsReadyToConfirmStatus(out.Status) || (len(out.Questions) == 0 && len(missingRequiredFields(out.Requirement)) == 0) {
		status = model.ClarificationStatusReadyToConfirm
	} else if out.Status == string(model.ClarificationStatusActive) {
		status = model.ClarificationStatusActive
	}
	if err := s.store.SetClarificationStatus(ctx, sessID, status, "", ""); err != nil {
		return sess, roundN, false
	}

	// Advance the persisted round column so the session is the single source of
	// truth for the current round (GET /:id and retry-current-round read it
	// directly). Done last so a transient store error here cannot leave the
	// round advanced while status/work-log writes above are uncommitted.
	if err := s.store.UpdateClarificationRound(ctx, sessID, roundN); err != nil {
		return sess, roundN, false
	}

	refreshed, err := s.store.GetClarificationSession(ctx, sessID)
	if err != nil || refreshed == nil {
		return sess, roundN, true
	}
	return refreshed, roundN, true
}

func clarificationFailureCode(err error) model.ErrorCode {
	switch {
	case errors.Is(err, runner.ErrOutputInvalidJSON):
		return model.ErrorOutputInvalidJSON
	case errors.Is(err, runner.ErrRunnerExitNonzero):
		return model.ErrorRunnerExitNonzero
	default:
		return model.ErrorUnknown
	}
}

// advanceAfterUserTurn computes the next round (sess.Round+1), transitions the
// session to ready_to_confirm at the MaxRounds cap, otherwise runs the round via
// runRoundAndPersist so the clarifier sees the just-appended user message. It
// returns the refreshed session view and a bool that is false when the round
// failed (the caller should return 200 with the failed session in that case).
//
// This is the shared round-advancement tail extracted from addClarificationMessage
// (P2#2) so the structured-answer path (answerClarification) advances the round
// exactly like the free-text path — without it the clarifier never sees the
// answer and the conversation stalls before ready_to_confirm. Behavior is
// identical to the prior inline logic, including the MaxRounds cap.
func (s *Server) advanceAfterUserTurn(ctx context.Context, sessID string, sess *model.ClarificationSession) (*model.ClarificationSession, bool) {
	nextRound := sess.Round + 1
	if nextRound > sess.MaxRounds {
		// Reached the round cap without the clarifier declaring readiness —
		// transition to ready_to_confirm so the user can confirm.
		if err := s.store.SetClarificationStatus(ctx, sessID, model.ClarificationStatusReadyToConfirm, "", ""); err != nil {
			return sess, false
		}
		updated, err := s.store.GetClarificationSession(ctx, sessID)
		if err != nil || updated == nil {
			return sess, false
		}
		return updated, true
	}

	updated, _, ok := s.runRoundAndPersist(ctx, sessID, nextRound)
	return updated, ok
}

// isTerminalClarificationStatus reports whether a session status is terminal: no
// further user turns (messages/answers/requirement edits) may advance it. A
// failed session is recovered via the dedicated retry-current-round endpoint,
// not via messages/answers.
func isTerminalClarificationStatus(status model.ClarificationStatus) bool {
	switch status {
	case model.ClarificationStatusConfirmed,
		model.ClarificationStatusAbandoned,
		model.ClarificationStatusFailed:
		return true
	}
	return false
}

func (s *Server) normalizeClarificationReadiness(ctx context.Context, sess *model.ClarificationSession) (*model.ClarificationSession, error) {
	if sess == nil || sess.Status != model.ClarificationStatusWaitingUser {
		return sess, nil
	}
	req := s.parseRequirement(sess.RequirementJSON)
	if len(missingRequiredFields(req)) > 0 {
		return sess, nil
	}
	if err := s.store.SetClarificationStatus(ctx, sess.ID, model.ClarificationStatusReadyToConfirm, "", ""); err != nil {
		return nil, err
	}
	updated, err := s.store.GetClarificationSession(ctx, sess.ID)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return sess, nil
	}
	return updated, nil
}

func clarificationStatusRejectsAnswers(status model.ClarificationStatus) bool {
	return isTerminalClarificationStatus(status) || status == model.ClarificationStatusReadyToConfirm
}

func clarificationStatusRejectsMessages(status model.ClarificationStatus) bool {
	return isTerminalClarificationStatus(status) || status == model.ClarificationStatusReadyToConfirm
}

func (s *Server) persistClarificationAnswer(ctx context.Context, sessionID string, answer clarificationAnswerBody, req *clarification.Requirement) error {
	meta, _ := json.Marshal(map[string]string{"questionId": answer.QuestionID, "value": answer.Value})
	if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
		ID:           "cmsg_" + idpkg.New(),
		SessionID:    sessionID,
		Role:         "user",
		Kind:         "answer",
		Content:      answer.Value,
		MetadataJSON: string(meta),
		CreatedAt:    time.Now(),
	}); err != nil {
		return err
	}

	// Merge the answer into the requirement. We map a handful of well-known
	// question ids to requirement fields; unknown ids are stored as the message
	// only (still observable in the transcript) without altering the requirement.
	applyAnswerToRequirement(req, answer.QuestionID, answer.Value)
	return nil
}

// blueprintRefsAllSafe reports whether every blueprintRef slug is a safe path
// segment (single segment, no traversal/separators). Used to fail-closed on
// client-supplied and persisted refs before they reach any path builder.
func blueprintRefsAllSafe(refs []string) bool {
	for _, slug := range refs {
		if !executor.SafeName(slug) {
			return false
		}
	}
	return true
}

// sanitizeBlueprintRefs drops any unsafe blueprintRef slug, keeping only safe
// ones. Used on LLM-produced refs (semi-trusted): a single bad slug should not
// abort the whole round; the executor drops unsafe refs for Reads regardless.
func sanitizeBlueprintRefs(refs []string) []string {
	out := refs[:0:0]
	for _, slug := range refs {
		if executor.SafeName(slug) {
			out = append(out, slug)
		}
	}
	return out
}

func mergeRequirementDefaults(next, current clarification.Requirement) clarification.Requirement {
	if next.AppType == "" {
		next.AppType = current.AppType
	}
	if next.AppName == "" {
		next.AppName = current.AppName
	}
	if len(next.TargetUsers) == 0 {
		next.TargetUsers = append([]string(nil), current.TargetUsers...)
	}
	if next.CoreScenario == "" {
		next.CoreScenario = current.CoreScenario
	}
	if next.PrimaryView == "" {
		next.PrimaryView = current.PrimaryView
	}
	if len(next.MainEntities) == 0 {
		next.MainEntities = append([]string(nil), current.MainEntities...)
	}
	if next.DataPolicy == "" {
		next.DataPolicy = current.DataPolicy
	}
	if len(next.AcceptanceFocus) == 0 {
		next.AcceptanceFocus = append([]string(nil), current.AcceptanceFocus...)
	}
	if len(next.GenerationProfile) == 0 {
		next.GenerationProfile = cloneStringListMap(current.GenerationProfile)
	}
	if len(next.BlueprintRefs) == 0 {
		next.BlueprintRefs = append([]string(nil), current.BlueprintRefs...)
	}
	return next
}

func cloneStringListMap(in map[string][]string) map[string][]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string][]string, len(in))
	for key, values := range in {
		out[key] = append([]string(nil), values...)
	}
	return out
}

// parseRequirement decodes the session's requirement_json into a Requirement,
// returning a zero value (not an error) on failure/emptiness.
func (s *Server) parseRequirement(raw string) clarification.Requirement {
	var req clarification.Requirement
	if raw == "" || raw == "{}" {
		return req
	}
	_ = json.Unmarshal([]byte(raw), &req)
	return req
}

// applyAnswerToRequirement merges a structured answer into the requirement for a
// handful of well-known question ids. Unknown ids are stored as the answer
// message only (handled by the caller) and do not alter the requirement.
func applyAnswerToRequirement(req *clarification.Requirement, questionID, value string) {
	switch questionID {
	case "appType", "app_type":
		if value != "" {
			req.AppType = value
			req.GenerationProfile = generationProfileForAppType(value)
		}
	case "appName", "app_name":
		if value != "" {
			req.AppName = value
		}
	case "primaryView", "primary_view":
		if value != "" {
			req.PrimaryView = value
		}
	case "coreScenario", "core_scenario":
		if value != "" {
			req.CoreScenario = value
		}
	case "dataPolicy", "data_policy":
		if value != "" {
			req.DataPolicy = value
		}
	case "targetUsers", "target_users":
		req.TargetUsers = mergeAnswerList(req.TargetUsers, value)
	case "mainEntities", "main_entities":
		req.MainEntities = mergeAnswerList(req.MainEntities, value)
	case "acceptanceFocus", "acceptance_focus":
		req.AcceptanceFocus = mergeAnswerList(req.AcceptanceFocus, value)
	case "blueprintRefs", "blueprint_refs":
		req.BlueprintRefs = sanitizeBlueprintRefs(mergeAnswerList(req.BlueprintRefs, value))
	default:
		// Unknown question id — the answer is recorded as a message only.
	}
}

func mergeAnswerList(existing []string, value string) []string {
	values := splitAnswerList(value)
	if len(values) == 0 {
		return existing
	}
	out := append([]string(nil), existing...)
	seen := make(map[string]struct{}, len(out)+len(values))
	for _, item := range out {
		seen[item] = struct{}{}
	}
	for _, item := range values {
		if _, ok := seen[item]; ok {
			continue
		}
		out = append(out, item)
		seen[item] = struct{}{}
	}
	return out
}

func splitAnswerList(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	var jsonValues []string
	if strings.HasPrefix(value, "[") && json.Unmarshal([]byte(value), &jsonValues) == nil {
		return compactAnswerList(jsonValues)
	}
	parts := strings.FieldsFunc(value, func(r rune) bool {
		switch r {
		case ',', '，', '、', ';', '；', '\n', '\t':
			return true
		default:
			return false
		}
	})
	return compactAnswerList(parts)
}

func compactAnswerList(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		out = append(out, value)
		seen[value] = struct{}{}
	}
	return out
}

// missingRequiredFields reports the required confirmation fields that are absent
// on the given Requirement. The required set (per the implementation plan's
// "Required Confirmed Requirement Fields") is: non-empty strings (appType,
// appName, coreScenario, primaryView, dataPolicy), non-empty slices
// (targetUsers, mainEntities, acceptanceFocus), and a non-empty
// generationProfile map. Returns the list of camelCase field names that are
// missing (empty slice if all present). This is the verdict confirmClarification
// uses for its 422 body.
func missingRequiredFields(req clarification.Requirement) []string {
	var missing []string
	if req.AppType == "" {
		missing = append(missing, "appType")
	}
	if req.AppName == "" {
		missing = append(missing, "appName")
	}
	if len(req.TargetUsers) == 0 {
		missing = append(missing, "targetUsers")
	}
	if req.CoreScenario == "" {
		missing = append(missing, "coreScenario")
	}
	if req.PrimaryView == "" {
		missing = append(missing, "primaryView")
	}
	if len(req.MainEntities) == 0 {
		missing = append(missing, "mainEntities")
	}
	if req.DataPolicy == "" {
		missing = append(missing, "dataPolicy")
	}
	if len(req.AcceptanceFocus) == 0 {
		missing = append(missing, "acceptanceFocus")
	}
	if len(req.GenerationProfile) == 0 {
		missing = append(missing, "generationProfile")
	}
	return missing
}

// generationProfileForAppType maps a requirement appType to the Factory-derived
// skill/base/domain/pattern triplet. This is the ONLY place generationProfile is
// computed; it is never accepted from the client.
func generationProfileForAppType(appType string) map[string][]string {
	switch appType {
	case "situation_replay":
		return map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"map-timeline-replay"},
		}
	case "operations_management":
		return map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"operations-management-console"},
		}
	case "command_dashboard":
		return map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"command-dashboard"},
		}
	default:
		return nil
	}
}
