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
	"github.com/weimengtsgit/xian630/factory-server/internal/collaboration"
	"github.com/weimengtsgit/xian630/factory-server/internal/dialogue"
	"github.com/weimengtsgit/xian630/factory-server/internal/executor"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
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
	Requirement     json.RawMessage `json:"requirement"`
	ExecutionPolicy struct {
		ManualStepConfirmation bool `json:"manualStepConfirmation"`
	} `json:"executionPolicy"`
}

// clarificationView is the enriched GET shape: the session plus its parsed
// requirement (empty object when requirement_json is blank/invalid). The round
// is read straight off the persisted session row — runRoundAndPersist advances
// the persisted `round` column via Store.UpdateClarificationRound, so the
// response (which re-reads the session after persisting) always reflects the
// round that actually ran. No response-side round override is needed.
type clarificationView struct {
	model.ClarificationSession
	Requirement      clarification.Requirement  `json:"requirement"`
	Messages         []clarificationMessageView `json:"messages,omitempty"`
	CreatedJob       *model.Job                 `json:"created_job,omitempty"`
	Application      *model.Application         `json:"application,omitempty"`
	ApplicationState string                     `json:"application_state,omitempty"`
}

// clarificationMessageView is a child clarification thread entry in the response
// shape the conversation workbench reads. The portal's openChildQuestions scans
// role/kind/metadata_json to surface the open high-impact question card, and
// latestConsolidation reads the round-5 consolidation message — without these in
// the child view the question card can never render (only the requirement
// summary shows). The standalone clarification surface fetches its thread via
// GET /clarifications/:id/messages, so it keeps the message-free viewFromSession.
type clarificationMessageView struct {
	ID           string `json:"id,omitempty"`
	Role         string `json:"role"`
	Kind         string `json:"kind"`
	Content      string `json:"content"`
	MetadataJSON string `json:"metadata_json,omitempty"`
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

// viewFromSessionWithMessages builds the base view and attaches the persisted
// child message thread. It is used by the dialogue composition path so the
// conversation workbench can render the open high-impact question card and the
// round-5 consolidation table (openChildQuestions/latestConsolidation read
// child.messages). Errors loading messages are non-fatal: the view degrades to
// the message-free shape rather than failing the whole composed dialogue view.
func (s *Server) viewFromSessionWithMessages(ctx context.Context, sess *model.ClarificationSession) clarificationView {
	v := s.viewFromSession(sess)
	msgs, err := s.store.ListClarificationMessages(ctx, sess.ID)
	if err != nil {
		return v
	}
	views := make([]clarificationMessageView, 0, len(msgs))
	for _, m := range msgs {
		views = append(views, clarificationMessageView{
			ID:           m.ID,
			Role:         m.Role,
			Kind:         m.Kind,
			Content:      m.Content,
			MetadataJSON: m.MetadataJSON,
		})
	}
	v.Messages = views
	return v
}

func (s *Server) enrichClarificationHistoryView(ctx context.Context, v clarificationView) (clarificationView, error) {
	if v.CreatedJobID == "" {
		return v, nil
	}
	job, err := s.store.GetJob(ctx, v.CreatedJobID)
	if err != nil {
		return v, err
	}
	if job == nil {
		return v, nil
	}
	v.CreatedJob = job
	if job.CreatedAppID == "" {
		return v, nil
	}
	app, err := s.store.GetApplication(ctx, job.CreatedAppID)
	if err != nil {
		return v, err
	}
	if app == nil {
		v.ApplicationState = "deleted"
		return v, nil
	}
	v.Application = app
	v.ApplicationState = string(app.Status)
	return v, nil
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

	// Run round 1 outside the request path. Events stream live to any
	// pre-subscribed SSE client; on failure the session is marked failed (no job).
	s.runAsync(func(asyncCtx context.Context) {
		s.runRoundAndPersist(asyncCtx, sessID, 1)
	})
	updated, _ := s.store.GetClarificationSession(ctx, sessID)
	if updated == nil {
		updated = &sess
	}
	if updated.Status == model.ClarificationStatusFailed {
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
		view, err := s.enrichClarificationHistoryView(r.Context(), s.viewFromSession(&sess))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "enrich sessions")
			return
		}
		out = append(out, view)
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

// deleteClarification handles DELETE /api/clarifications/:id. It removes only
// the clarification history row and transcript messages; generated jobs/apps and
// execution artifacts remain intact. A currently-active analysis round is not
// deletable because the runner may still be appending messages.
func (s *Server) deleteClarification(w http.ResponseWriter, r *http.Request) {
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
	if sess.Status == model.ClarificationStatusActive {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "active session cannot be deleted", "status": sess.Status})
		return
	}
	if err := s.store.DeleteClarificationSession(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "delete session")
		return
	}
	s.publishClarificationEvent(clarification.StreamEvent{
		Type:      "clarification.deleted",
		SessionID: id,
		Data:      map[string]string{"id": id},
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": id})
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
// running again). The next model round is scheduled outside the request path.
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
	_ = s.store.SetClarificationStatus(ctx, id, model.ClarificationStatusActive, "", "")
	s.runAsync(func(asyncCtx context.Context) {
		s.advanceAfterUserTurn(asyncCtx, id, sess)
	})
	updated, _ := s.store.GetClarificationSession(ctx, id)
	writeJSON(w, http.StatusOK, s.viewFromSession(updated))
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
	req.BlueprintRefs = s.sanitizeBlueprintRefs(req.BlueprintRefs)
	req.GenerationProfile = recomputeGenerationProfile(req)
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
		Data:      clarification.PublicRequirement(req),
	})
	// Advance the round exactly like the free-text path (P2#2): the structured
	// answer + merged requirement must be visible to the next clarifier round,
	// otherwise the conversation stalls before ready_to_confirm.
	ctx := r.Context()
	_ = s.store.SetClarificationStatus(ctx, id, model.ClarificationStatusActive, "", "")
	s.runAsync(func(asyncCtx context.Context) {
		s.advanceAfterUserTurn(asyncCtx, id, updated)
	})
	fresh, _ := s.store.GetClarificationSession(ctx, id)
	writeJSON(w, http.StatusOK, s.viewFromSession(fresh))
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
	req.BlueprintRefs = s.sanitizeBlueprintRefs(req.BlueprintRefs)
	req.GenerationProfile = recomputeGenerationProfile(req)
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
		Data:      clarification.PublicRequirement(req),
	})

	_ = s.store.SetClarificationStatus(r.Context(), id, model.ClarificationStatusActive, "", "")
	s.runAsync(func(asyncCtx context.Context) {
		s.advanceAfterUserTurn(asyncCtx, id, updated)
	})
	fresh, _ := s.store.GetClarificationSession(r.Context(), id)
	writeJSON(w, http.StatusOK, s.viewFromSession(fresh))
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
	if incoming.Description != "" {
		current.Description = incoming.Description
	}
	current.JudgementBoundary = mergeJudgementBoundaryDefaults(incoming.JudgementBoundary, current.JudgementBoundary)
	current.BlueprintRefs = s.sanitizeBlueprintRefs(incoming.BlueprintRefs)
	// Always (re)compute the profile from the application type and internal
	// blueprint refs — never trust the client-supplied skill list — while
	// preserving the server-derived `data` group selected during clarification.
	current.GenerationProfile = recomputeGenerationProfile(current)

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
		Data:      clarification.PublicRequirement(current),
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

	s.runAsync(func(asyncCtx context.Context) {
		s.runRoundAndPersist(asyncCtx, id, retryRound)
	})
	updated, _ := s.store.GetClarificationSession(r.Context(), id)
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
		if !blueprintRefsAllSafe(incoming.BlueprintRefs) {
			writeError(w, http.StatusBadRequest, "invalid blueprintRef slug")
			return
		}
		// The confirmed requirement may carry business fields; recompute the
		// profile from appType so a client can never inject one at confirm time,
		// plus internal blueprint refs, while preserving the persisted `data`
		// skill group across the recompute.
		incoming.JudgementBoundary = mergeJudgementBoundaryDefaults(incoming.JudgementBoundary, req.JudgementBoundary)
		incoming.BlueprintRefs = s.sanitizeBlueprintRefs(incoming.BlueprintRefs)
		incoming.GenerationProfile = recomputeGenerationProfile(incoming, req.GenerationProfile)
		req = incoming
	} else {
		if !blueprintRefsAllSafe(req.BlueprintRefs) {
			writeError(w, http.StatusBadRequest, "invalid blueprintRef slug")
			return
		}
		// Recompute the profile defensively even on the persisted requirement,
		// preserving the server-derived `data` skill group and blueprint-derived
		// pattern skills.
		req.BlueprintRefs = s.sanitizeBlueprintRefs(req.BlueprintRefs)
		req.GenerationProfile = recomputeGenerationProfile(req)
	}

	if missing := missingRequiredFields(req); len(missing) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "confirmed requirement missing required fields",
			"missing": missing,
		})
		return
	}
	req.ExecutionPolicy.ManualStepConfirmation = body.ExecutionPolicy.ManualStepConfirmation

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

	// Build the default collaboration plan from the confirmed requirement and
	// materialize it into job_steps + job_step_edges. The plan is persisted onto
	// the job row so the UI and executor can drive it. CurrentStepKind points at
	// the FIRST plan agent's role so the job is executable from its plan head.
	plan := collaboration.DefaultPlan(collaboration.RequirementContext{ConfirmedRequirementJSON: string(reqBytes)})
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
		UserPrompt:               sess.InitialPrompt,
		AppName:                  displayName,
		Status:                   model.JobStatusQueued,
		CurrentStepKind:          currentStep,
		ClarificationSessionID:   id,
		ConfirmedRequirementJSON: string(reqBytes),
		CollaborationPlanJSON:    planJSON,
		CreatedAt:                now,
		UpdatedAt:                now,
	}
	// Seed the job + steps + edges + clarification link in ONE transaction: on
	// failure there is NO orphaned job and the session is moved to a diagnosable
	// failed state (never left ready_to_confirm with no linked job).
	if err := s.store.SeedClarificationJobWithEdges(r.Context(), job, steps, edges, id); err != nil {
		_ = s.store.SetClarificationStatus(r.Context(), id, model.ClarificationStatusFailed, "job_seed_failed", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "seed job", "code": "job_seed_failed"})
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
// Callers may run this from a background task so HTTP requests are not held open
// while the model is queued or rate-limited. Events are published to the hub
// during the round, so any SSE client already subscribed receives them live.
//
// Round persistence: the `round` column is advanced (via
// Store.UpdateClarificationRound) to the round that actually ran, so the
// persisted session is the single source of truth. GET /api/clarifications/:id
// reads it directly, and retryClarificationRound reads the current round from
// the persisted session without a fallback.
//
// D2 (clarification delta reachability): when dialogueID is non-empty the round
// is being run for the application-generation DIALOGUE flow (a child
// clarification session linked to a parent dialogue). In that case each child
// clarification.message.delta (the safe work-log text the runner derives from
// text_delta) is ALSO republished as a dialogue.clarification.delta, and each
// clarification.message.thinking (the model's raw reasoning, from
// thinking_delta) is republished as a dialogue.clarification.thinking — both
// carrying the parent dialogue_id so the portal dispatcher folds them into the
// conversation timeline live (analysis → 分析过程, thinking → 思考过程). The
// conversation surface streams the model's thinking; #9 applies to the
// executor/trace pipeline, not here. When dialogueID is empty this is the
// legacy standalone clarification flow, whose own surface consumes the bare
// clarification.message.* events; that path is unaffected.
func (s *Server) runRoundAndPersist(ctx context.Context, sessID string, round int) (*model.ClarificationSession, int, bool) {
	return s.runRoundAndPersistForDialogue(ctx, sessID, round, "")
}

// runRoundAndPersistForDialogue is the dialogue-aware variant. It behaves
// identically to runRoundAndPersist, except that when dialogueID != "" each
// child clarification.message.delta is additionally republished as a
// dialogue.clarification.delta and each clarification.message.thinking as a
// dialogue.clarification.thinking (set-not-append, full-so-far) carrying the
// parent dialogue_id. The legacy bare clarification.message.* events are still
// emitted unchanged so the standalone clarification surface keeps working.
func (s *Server) runRoundAndPersistForDialogue(ctx context.Context, sessID string, round int, dialogueID string) (*model.ClarificationSession, int, bool) {
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

	cfg := s.loadSceneCatalog(ctx)
	roundThinking := ""
	out, err := s.clarifier.RunRound(ctx, input, func(ev clarification.StreamEvent) {
		filtered := s.filterClarificationEvent(cfg, ev)
		s.publishClarificationEvent(filtered)
		// D2: in the dialogue flow, mirror the live analysis delta AND the raw
		// thinking stream as dialogue-attributed events so the portal folds them
		// live (analysis → 分析过程, thinking → 思考过程). Policy: the conversation
		// surface now streams the model's thinking; #9 applies to the executor/
		// trace pipeline, NOT this conversation surface.
		if dialogueID != "" && filtered.Type == "clarification.message.delta" {
			// Mirror dialogue.draft.delta's wire shape exactly (top-level
			// dialogue_id/message_id/delta) so applyLiveAnalysisEvent — which
			// reads ev.dialogue_id, ev.delta and ev.message_id — folds it
			// identically. Uses the dialogue.StreamEvent shape (dialogue_id
			// json tag) rather than the clarification one (session_id).
			s.publishDialogueEvent(dialogue.StreamEvent{
				Type:       "dialogue.clarification.delta",
				DialogueID: dialogueID,
				MessageID:  filtered.MessageID,
				Delta:      filtered.Delta,
			})
		}
		if dialogueID != "" && filtered.Type == "clarification.message.thinking" {
			roundThinking = filtered.Delta
			s.publishDialogueEvent(dialogue.StreamEvent{
				Type:       "dialogue.clarification.thinking",
				DialogueID: dialogueID,
				MessageID:  filtered.MessageID,
				Delta:      filtered.Delta,
			})
		}
	})
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
	if len(out.CollaborationAdjustments) > 0 {
		out.Requirement.CollaborationAdjustments = append([]clarification.CollaborationAdjustment(nil), out.CollaborationAdjustments...)
	}
	out.Requirement.BlueprintRefs = s.sanitizeBlueprintRefs(out.Requirement.BlueprintRefs)
	// The LLM may suggest business fields and safe blueprint refs, but the skill
	// profile is always Factory-derived from those refs, while preserving the
	// LLM-selected `data` group.
	out.Requirement.GenerationProfile = recomputeGenerationProfile(out.Requirement)
	now := time.Now()
	reqBytes, _ := json.Marshal(out.Requirement)
	if err := s.store.UpdateClarificationRequirement(ctx, sessID, string(reqBytes)); err != nil {
		return sess, roundN, false
	}
	analysisAt := now
	if strings.TrimSpace(roundThinking) != "" {
		if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
			ID:        "cmsg_" + idpkg.New(),
			SessionID: sessID,
			Role:      "agent",
			Kind:      "thinking",
			Content:   roundThinking,
			CreatedAt: now,
		}); err != nil {
			return sess, roundN, false
		}
		analysisAt = now.Add(time.Millisecond)
	}
	// Item 1 — surface low-impact auto-defaulted clarifications. The model may
	// fill low-impact requirement fields directly (without surfacing them as
	// high-impact questions). Those decisions are implicit assumptions; surface
	// them as a concise Chinese work-log entry so the user can perceive the
	// auto-applied defaults in the 分析过程 and adjust before confirming. Only
	// fields that were empty before this round AND were not asked as an
	// open-high-impact question count as auto-defaults — high-impact items stay
	// in the user-facing question flow unchanged.
	if entry := summarizeLowImpactAutoDefaults(input.CurrentRequirement, out); entry != "" {
		out.WorkLog = append(out.WorkLog, clarification.WorkLog{
			Type:    "analysis_work_log",
			Content: entry,
		})
	}
	for _, wl := range out.WorkLog {
		if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
			ID:        "cmsg_" + idpkg.New(),
			SessionID: sessID,
			Role:      "agent",
			Kind:      "analysis_work_log",
			Content:   wl.Content,
			CreatedAt: analysisAt,
		}); err != nil {
			return sess, roundN, false
		}
	}
	questionAt := analysisAt.Add(time.Millisecond)
	for _, q := range out.Questions {
		qBytes, _ := json.Marshal(q)
		if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
			ID:           "cmsg_" + idpkg.New(),
			SessionID:    sessID,
			Role:         "agent",
			Kind:         "question",
			MetadataJSON: string(qBytes),
			CreatedAt:    questionAt,
		}); err != nil {
			return sess, roundN, false
		}
	}
	// Persist the round-5 consolidation list as a recommendation_consolidation
	// message so the round-6 adjust handler (Task 4 dialogue facade) can load it
	// via ApplyConsolidationAdjustment without a model turn.
	if len(out.Consolidation) > 0 {
		consBytes, _ := json.Marshal(out.Consolidation)
		if err := s.store.AddClarificationMessage(ctx, model.ClarificationMessage{
			ID:           "cmsg_" + idpkg.New(),
			SessionID:    sessID,
			Role:         "agent",
			Kind:         "recommendation_consolidation",
			MetadataJSON: string(consBytes),
			CreatedAt:    now,
		}); err != nil {
			return sess, roundN, false
		}
	}

	// Persist the round's open-high-impact list so the non-model readiness
	// sites (advanceAfterUserTurn at the round cap, normalizeClarificationReadiness
	// on read) can re-apply the D3 gate without a fresh model turn. Persist BEFORE
	// computing status so the gate decision and the persisted snapshot are
	// consistent even if the status write below succeeds.
	hiJSON := ""
	if len(out.OpenHighImpact) > 0 {
		b, _ := json.Marshal(out.OpenHighImpact)
		hiJSON = string(b)
	}
	if err := s.store.UpdateClarificationOpenHighImpact(ctx, sessID, hiJSON); err != nil {
		return sess, roundN, false
	}

	// Map the runner's reported status onto the session status, defaulting to
	// waiting_user when the runner did not declare readiness. D3 / ADR 0006:
	// ready_to_confirm requires openHighImpact to be EMPTY in addition to the
	// model declaring readiness (or a no-question complete requirement). A
	// blueprint-assumed field is NOT a confirmed high-impact decision, so a
	// detailed first message does NOT bypass this gate.
	status := model.ClarificationStatusWaitingUser
	ready := (clarification.IsReadyToConfirmStatus(out.Status) || (len(out.Questions) == 0 && len(missingRequiredFields(out.Requirement)) == 0)) && len(out.OpenHighImpact) == 0
	if ready {
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

	// B1: in the dialogue flow, signal the portal to reload the composed view now
	// that the round has persisted its question, requirement, and status. A round
	// only mirrors its analysis delta as dialogue.clarification.delta (above), and
	// deltas do not trigger a view reload — without this non-delta signal the
	// dispatcher never sets needsRefresh, the workbench stays on the pre-round
	// view, and the high-impact question card never renders. publishDialogueChild
	// emits clarification.summary.updated (standalone surface) + the
	// dialogue-attributed dialogue.clarification.updated (portal reload trigger).
	if dialogueID != "" {
		s.publishDialogueChild(ctx, dialogueID, sessID, out.Requirement)
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
	return s.advanceAfterUserTurnForDialogue(ctx, sessID, sess, "")
}

// advanceAfterUserTurnForDialogue is the dialogue-aware variant. When dialogueID
// is non-empty the next round is run via runRoundAndPersistForDialogue so its
// streaming deltas are mirrored as dialogue.clarification.delta (D2). The legacy
// callers (empty dialogueID) are unchanged.
func (s *Server) advanceAfterUserTurnForDialogue(ctx context.Context, sessID string, sess *model.ClarificationSession, dialogueID string) (*model.ClarificationSession, bool) {
	nextRound := sess.Round + 1
	if nextRound > sess.MaxRounds {
		// Reached the round cap without the clarifier declaring readiness.
		// D3 / ADR 0006: a session that still has open high-impact confirmation
		// items must NOT be auto-promoted to ready_to_confirm at the cap — it
		// stays waiting_user so the user can still answer the blocking question.
		// Only when openHighImpact is empty do we promote so the user can confirm.
		status := model.ClarificationStatusReadyToConfirm
		if s.openHighImpactOpen(sess) {
			status = model.ClarificationStatusWaitingUser
		}
		if err := s.store.SetClarificationStatus(ctx, sessID, status, "", ""); err != nil {
			return sess, false
		}
		updated, err := s.store.GetClarificationSession(ctx, sessID)
		if err != nil || updated == nil {
			return sess, false
		}
		return updated, true
	}

	updated, _, ok := s.runRoundAndPersistForDialogue(ctx, sessID, nextRound, dialogueID)
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
	// D3 / ADR 0006: even when all required fields are filled, a session with
	// open high-impact confirmation items must NOT be promoted to
	// ready_to_confirm. Required fields may have been filled from blueprint
	// assumptions; a confirmed high-impact decision requires an explicit user
	// answer, so stay waiting_user while openHighImpact is non-empty.
	if s.openHighImpactOpen(sess) {
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
func (s *Server) sanitizeBlueprintRefs(refs []string) []string {
	out := refs[:0:0]
	catalog, err := scanner.LoadSceneCatalogForSurface(s.cfg.WorkspaceRoot)
	if err != nil {
		return out
	}
	for _, slug := range refs {
		if executor.SafeName(slug) && catalog.IsBlueprint(slug) {
			out = append(out, slug)
		}
	}
	return out
}

func (s *Server) filterClarificationEvent(cfg scanner.SceneCatalog, ev clarification.StreamEvent) clarification.StreamEvent {
	switch ev.Type {
	case "clarification.summary.updated", "clarification.ready_to_confirm":
		req, ok := ev.Data.(clarification.Requirement)
		if !ok {
			return ev
		}
		req.BlueprintRefs = filterBlueprintRefs(cfg, req.BlueprintRefs)
		ev.Data = req
	}
	return ev
}

func filterBlueprintRefs(cfg scanner.SceneCatalog, refs []string) []string {
	out := refs[:0:0]
	for _, ref := range refs {
		if cfg.IsBlueprint(ref) {
			out = append(out, ref)
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
	if next.Description == "" {
		next.Description = current.Description
	}
	next.JudgementBoundary = mergeJudgementBoundaryDefaults(next.JudgementBoundary, current.JudgementBoundary)
	if len(next.GenerationProfile) == 0 {
		next.GenerationProfile = cloneStringListMap(current.GenerationProfile)
	}
	if len(next.BlueprintRefs) == 0 {
		next.BlueprintRefs = append([]string(nil), current.BlueprintRefs...)
	}
	if len(next.CollaborationAdjustments) == 0 {
		next.CollaborationAdjustments = append([]clarification.CollaborationAdjustment(nil), current.CollaborationAdjustments...)
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

// lowImpactFieldLabel maps a requirement JSON field name to a concise Chinese
// label + the chosen value for the Item-1 auto-default work-log entry. Returns
// ("", false) for fields we deliberately do not surface (e.g. internal
// blueprintRefs / generationProfile / collaborationAdjustments, which are
// Factory-derived, not user decisions). Order mirrors the Requirement struct so
// the rendered list is stable.
func lowImpactFieldDisplay(field string, req clarification.Requirement) (string, bool) {
	switch field {
	case "appType":
		if req.AppType == "" {
			return "", false
		}
		return "应用类型 = " + req.AppType, true
	case "appName":
		if req.AppName == "" {
			return "", false
		}
		return "应用名称 = " + req.AppName, true
	case "targetUsers":
		if len(req.TargetUsers) == 0 {
			return "", false
		}
		return "主要使用角色 = " + strings.Join(req.TargetUsers, "、"), true
	case "coreScenario":
		if req.CoreScenario == "" {
			return "", false
		}
		return "核心场景 = " + req.CoreScenario, true
	case "primaryView":
		if req.PrimaryView == "" {
			return "", false
		}
		return "主视图 = " + req.PrimaryView, true
	case "mainEntities":
		if len(req.MainEntities) == 0 {
			return "", false
		}
		return "主要对象 = " + strings.Join(req.MainEntities, "、"), true
	case "dataPolicy":
		if req.DataPolicy == "" {
			return "", false
		}
		return "数据策略 = " + req.DataPolicy, true
	case "acceptanceFocus":
		if len(req.AcceptanceFocus) == 0 {
			return "", false
		}
		return "验收重点 = " + strings.Join(req.AcceptanceFocus, "、"), true
	case "judgementBoundary":
		summary := strings.TrimSpace(req.JudgementBoundary.Summary)
		if summary == "" {
			return "", false
		}
		return "研判边界 = " + summary, true
	}
	return "", false
}

// openHighImpactFieldNames returns the set of requirement fields the round's
// open-high-impact questions are confirming, so summarizeLowImpactAutoDefaults
// can exclude them from the auto-default list (those are user decisions, not
// auto-applied). The high-impact item carries a plain-language `id`/`label`,
// not a JSON field name, so this is a best-effort keyword match. Unknown ids
// simply do not exclude anything, which keeps the surfacing conservative.
func openHighImpactFieldNames(items []clarification.HighImpactItem) map[string]bool {
	out := make(map[string]bool)
	for _, it := range items {
		text := strings.ToLower(it.ID + " " + it.Label)
		switch {
		case strings.Contains(text, "数据策略") || strings.Contains(text, "datapolicy"):
			out["dataPolicy"] = true
		case strings.Contains(text, "应用类型") || strings.Contains(text, "apptype"):
			out["appType"] = true
		case strings.Contains(text, "应用名称") || strings.Contains(text, "appname"):
			out["appName"] = true
		case strings.Contains(text, "核心场景") || strings.Contains(text, "corescenario"):
			out["coreScenario"] = true
		case strings.Contains(text, "主视图") || strings.Contains(text, "primaryview"):
			out["primaryView"] = true
		case strings.Contains(text, "主要对象") || strings.Contains(text, "mainentities"):
			out["mainEntities"] = true
		case strings.Contains(text, "角色") || strings.Contains(text, "targetusers"):
			out["targetUsers"] = true
		case strings.Contains(text, "验收") || strings.Contains(text, "acceptancefocus"):
			out["acceptanceFocus"] = true
		case strings.Contains(text, "研判") || strings.Contains(text, "judgementboundary"):
			out["judgementBoundary"] = true
		}
	}
	return out
}

// summarizeLowImpactAutoDefaults builds a concise Chinese work-log entry naming
// the low-impact requirement fields the model auto-decided this round (filled
// directly, not asked as a high-impact question), so the assumptions surface in
// the 分析过程. Returns "" when nothing was auto-defaulted this round.
//
// A field counts as auto-defaulted when it was empty in `prev` and is now
// populated in `out.Requirement`, AND it is not one of this round's open
// high-impact items. Internal Factory-derived fields (blueprintRefs /
// generationProfile / collaborationAdjustments / description) are deliberately
// not surfaced: they are not user decisions. Only the first round that fills a
// field reports it (subsequent rounds carry the prior value via
// mergeRequirementDefaults, so prev is non-empty and the field is skipped).
func summarizeLowImpactAutoDefaults(prev clarification.Requirement, out clarification.RoundOutput) string {
	type delta struct{ empty, filled bool }
	states := map[string]delta{
		"appType":           {prev.AppType == "", out.Requirement.AppType != ""},
		"appName":           {prev.AppName == "", out.Requirement.AppName != ""},
		"targetUsers":       {len(prev.TargetUsers) == 0, len(out.Requirement.TargetUsers) > 0},
		"coreScenario":      {prev.CoreScenario == "", out.Requirement.CoreScenario != ""},
		"primaryView":       {prev.PrimaryView == "", out.Requirement.PrimaryView != ""},
		"mainEntities":      {len(prev.MainEntities) == 0, len(out.Requirement.MainEntities) > 0},
		"dataPolicy":        {prev.DataPolicy == "", out.Requirement.DataPolicy != ""},
		"acceptanceFocus":   {len(prev.AcceptanceFocus) == 0, len(out.Requirement.AcceptanceFocus) > 0},
		"judgementBoundary": {strings.TrimSpace(prev.JudgementBoundary.Summary) == "", strings.TrimSpace(out.Requirement.JudgementBoundary.Summary) != ""},
	}
	excluded := openHighImpactFieldNames(out.OpenHighImpact)
	order := []string{
		"appType", "appName", "targetUsers", "coreScenario", "primaryView",
		"mainEntities", "dataPolicy", "acceptanceFocus", "judgementBoundary",
	}
	var parts []string
	for _, field := range order {
		d := states[field]
		if !d.empty || !d.filled || excluded[field] {
			continue
		}
		label, ok := lowImpactFieldDisplay(field, out.Requirement)
		if !ok {
			continue
		}
		parts = append(parts, label)
	}
	if len(parts) == 0 {
		return ""
	}
	return "已按默认设定（低影响，可在确认前调整）：" + strings.Join(parts, "；") + "。"
}

func cloneJudgementBoundary(in clarification.JudgementBoundary) clarification.JudgementBoundary {
	return clarification.JudgementBoundary{
		DataSources: append([]string(nil), in.DataSources...),
		Summary:     in.Summary,
	}
}

func mergeJudgementBoundaryDefaults(next, current clarification.JudgementBoundary) clarification.JudgementBoundary {
	out := cloneJudgementBoundary(next)
	if len(out.DataSources) == 0 {
		out.DataSources = append([]string(nil), current.DataSources...)
	}
	if strings.TrimSpace(out.Summary) == "" {
		out.Summary = current.Summary
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

// parseOpenHighImpact reads the persisted open-high-impact JSON snapshot back
// into the validated shape. openHighImpactOpen (below) calls this to re-apply
// the D3 gate from the persisted state without a model turn. Re-validation is
// defensive: the list was validated by the runner before persist, but a corrupt
// row should fail-safe to "open" only when the JSON genuinely decodes to items.
func (s *Server) parseOpenHighImpact(raw string) []clarification.HighImpactItem {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var items []clarification.HighImpactItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil
	}
	return items
}

// openHighImpactOpen is the single D3 / ADR 0006 gate predicate for the
// non-model readiness sites: a session with open high-impact confirmation
// items must NOT be promoted to ready_to_confirm regardless of message detail.
// Every no-model promotion path (advanceAfterUserTurn's cap branch,
// normalizeClarificationReadiness, and the consolidation-apply path in
// answerDialogueClarificationBatch) MUST consult this helper so a future site
// cannot silently bypass the gate. The model-output site runRoundAndPersist is
// exempt: it inspects the fresh out.OpenHighImpact, not the persisted snapshot.
func (s *Server) openHighImpactOpen(sess *model.ClarificationSession) bool {
	if sess == nil {
		return false
	}
	return len(s.parseOpenHighImpact(sess.OpenHighImpactJSON)) > 0
}

// applyAnswerToRequirement merges a structured answer into the requirement for a
// handful of well-known question ids. Unknown ids are stored as the answer
// message only (handled by the caller) and do not alter the requirement.
func applyAnswerToRequirement(req *clarification.Requirement, questionID, value string) {
	switch questionID {
	case "appType", "app_type":
		if value != "" {
			req.AppType = value
			req.GenerationProfile = recomputeGenerationProfile(*req)
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
	case "judgementBoundary.dataSources", "judgement_boundary.data_sources", "judgementDataSources", "judgement_data_sources", "dataSources", "data_sources":
		req.JudgementBoundary.DataSources = mergeAnswerList(req.JudgementBoundary.DataSources, value)
	case "judgementBoundary.summary", "judgement_boundary.summary", "judgementBoundarySummary", "judgement_boundary_summary":
		if value != "" {
			req.JudgementBoundary.Summary = value
		}
	case "judgementBoundary", "judgement_boundary":
		mergeJudgementBoundaryAnswer(req, value)
	case "blueprintRefs", "blueprint_refs":
		req.BlueprintRefs = mergeAnswerList(req.BlueprintRefs, value)
		req.GenerationProfile = recomputeGenerationProfile(*req)
	default:
		// Unknown question id — the answer is recorded as a message only.
	}
}

func mergeJudgementBoundaryAnswer(req *clarification.Requirement, value string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	var boundary clarification.JudgementBoundary
	if err := json.Unmarshal([]byte(value), &boundary); err == nil {
		req.JudgementBoundary = boundary
		return
	}
	req.JudgementBoundary.Summary = value
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
// missingRequiredFields lists the BUSINESS-LOGIC fields the 业务逻辑 clarification
// must settle before ready_to_confirm. Interface (primaryView) and data-source
// (dataPolicy) details are intentionally NOT required here — they are clarified
// in later stages (界面解析 / 数据抓取), so the requirement may carry them empty
// and the requirement_analysis freeze step + downstream contracts fill them.
// mainEntities (the business domain objects) stays required — it is business
// logic, not a data-source detail.
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
	if len(req.MainEntities) == 0 {
		missing = append(missing, "mainEntities")
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

// generationProfileForRequirement derives the Factory-owned profile from the
// supported application type, then augments it with capabilities required by
// internal scene blueprints. It also preserves the server/model-derived `data`
// skill group that was selected during clarification; client-supplied skill
// lists are still rejected before this helper is called.
func generationProfileForRequirement(appType string, blueprintRefs []string, existingProfiles ...map[string][]string) map[string][]string {
	profile := generationProfileForAppType(appType)
	for _, slug := range blueprintRefs {
		for group, additions := range blueprintProfileAdditions[slug] {
			if profile == nil {
				profile = map[string][]string{}
			}
			profile[group] = appendUniqueSkills(profile[group], additions)
		}
	}
	if len(existingProfiles) > 0 {
		if dataGroup := existingProfiles[0]["data"]; len(dataGroup) > 0 {
			if profile == nil {
				profile = map[string][]string{}
			}
			profile["data"] = append([]string(nil), dataGroup...)
		}
	}
	return profile
}

var blueprintProfileAdditions = map[string]map[string][]string{
	"carrier-homeport-tide-window": {
		"pattern": {"maritime-alert-dashboard"},
	},
	"carrier-deck-wind-calculator": {
		"pattern": {"maritime-alert-dashboard"},
	},
	"merchant-density-grid-alert": {
		"pattern": {"maritime-alert-dashboard"},
	},
	"social-sighting-cluster-alert": {
		"pattern": {"maritime-alert-dashboard"},
	},
	"carrier-air-wing-affiliation-inference": {
		"pattern": {"maritime-alert-dashboard", "affiliation-inference-dashboard"},
	},
}

func appendUniqueSkills(current, additions []string) []string {
	for _, addition := range additions {
		found := false
		for _, existing := range current {
			if existing == addition {
				found = true
				break
			}
		}
		if !found {
			current = append(current, addition)
		}
	}
	return current
}

// dataDomainKeywords maps each data-acquisition skill to the intent keywords
// (ASCII matched case-insensitively, Chinese verbatim) that indicate the
// requirement needs that real-data capability. Sets are deliberately inclusive:
// over-deriving only makes a real-data skill available to the generator
// (benign), whereas UNDER-deriving is the bug this fixes — a real-data app that
// silently ships with no data capability. Keywords come from each skill's Trigger
// Mapping + description.
var dataDomainKeywords = []struct {
	skill    string
	keywords []string
}{
	{"tide-data-skill", []string{
		"潮汐", "潮位", "潮高", "潮水", "涨潮", "落潮", "吃水", "水位",
		"离港窗口", "出港窗口", "departure window", "draft threshold",
		"tide", "tidal", "tide level", "port forecast",
	}},
	{"deck-wind-data-skill", []string{
		"甲板风", "风速", "风向", "起飞风", "着舰风", "弹射风", "回收风",
		"deck wind", "10 m wind", "10m wind", "wind speed", "wind direction",
		"launch wind", "recovery wind", "风力", "海面风",
	}},
	{"ais-density-data-skill", []string{
		"ais", "商船密度", "航运密度", "船舶密度", "船舶交通", "50海里", "50 海里",
		"50-nautical-mile", "merchant density", "shipping density", "vessel traffic",
		"船舶流量", "船流密度",
	}},
	{"carrier-affiliation-data-skill", []string{
		"舰载机", "归属推断", "归属", "ads-b", "adsb", "icao", "航母位置",
		"航母已知位置", "离舰判定", "离舰", "起降识别", "海陆掩膜", "海陆分类",
		"ontology", "aviationcarrier", "carrieraviation", "rawads",
		"aircraftcarriertracklog", "opensky", "usni", "航母舰载机",
		// Military-vessel AIS: per the merchant/military AIS split, ANY military
		// vessel (carriers, warships, navy) routes here — its ontology RawAISData
		// adapter is the real AIS source for military vessel tracks. Merchant
		// density stays on ais-density-data-skill (MarineCadastre), which carries
		// no military vessels. ais-density may also match the bare token "ais"
		// (over-deriving is benign); the SKILL docs disambiguate by target fleet.
		"航母", "舰船", "军舰", "军船", "舰艇", "水面舰艇", "水面舰", "战舰",
		"驱逐舰", "巡洋舰", "护卫舰", "两栖舰", "舰队", "军用舰船", "军队",
		"舰船航迹", "军舰ais", "rawais",
		"warship", "naval vessel", "naval ship", "naval", "navy",
		"destroyer", "cruiser", "frigate", "military vessel", "military ship",
	}},
}

// deriveDataSkills returns the data-acquisition skills a real-data requirement
// needs, inferred from its text fields (MainEntities, AppName, CoreScenario,
// PrimaryView, AcceptanceFocus). This is the server-side derivation that
// guarantees a live_api/mock_then_api requirement hitting a data domain always
// carries the matching data skill, so confirm never silently passes a real-data
// app that lacks its data capability.
//
// It returns nil when dataPolicy is mock_data (mock is explicit — never auto-add
// a data skill for it) or when no domain matches. Matching is substring-based
// and case-insensitive for ASCII.
func deriveDataSkills(req clarification.Requirement) []string {
	if req.DataPolicy == "mock_data" {
		return nil
	}
	haystack := strings.ToLower(strings.Join(req.MainEntities, " ") + " " +
		req.AppName + " " + req.CoreScenario + " " + req.PrimaryView + " " +
		strings.Join(req.AcceptanceFocus, " "))
	var out []string
	for _, domain := range dataDomainKeywords {
		for _, kw := range domain.keywords {
			if strings.Contains(haystack, strings.ToLower(kw)) {
				out = append(out, domain.skill)
				break
			}
		}
	}
	if hasMilitaryAISIntent(haystack) {
		out = withoutSkill(out, "ais-density-data-skill")
		if !containsSkill(out, "carrier-affiliation-data-skill") {
			out = append(out, "carrier-affiliation-data-skill")
		}
	}
	return out
}

func hasMilitaryAISIntent(haystack string) bool {
	if !strings.Contains(haystack, "ais") && !strings.Contains(haystack, "rawais") {
		return false
	}
	for _, kw := range []string{
		"航母", "舰船", "军舰", "军船", "舰艇", "水面舰艇", "战舰",
		"驱逐舰", "巡洋舰", "护卫舰", "两栖舰", "舰队", "军用舰船", "军队",
		"warship", "naval vessel", "naval ship", "naval", "navy",
		"destroyer", "cruiser", "frigate", "military vessel", "military ship",
	} {
		if strings.Contains(haystack, strings.ToLower(kw)) {
			return true
		}
	}
	return false
}

func withoutSkill(skills []string, key string) []string {
	out := skills[:0]
	for _, skill := range skills {
		if skill != key {
			out = append(out, skill)
		}
	}
	return out
}

// containsSkill reports whether the data-skill list contains key. Order is not
// part of the contract; only presence matters.
func containsSkill(skills []string, key string) bool {
	for _, skill := range skills {
		if skill == key {
			return true
		}
	}
	return false
}

// recomputeGenerationProfile is the single server-side entrypoint for deriving a
// requirement's generationProfile. It builds base/domain/pattern from appType +
// blueprint refs (via generationProfileForRequirement, preserving any existing
// data group), then merges in the data skills derived from the requirement's
// dataPolicy + text fields. mock_data derives nothing; live_api/mock_then_api add
// the matching data skills so a real-data domain is never left without its
// capability. The optional existing map lets the confirm path preserve a
// persisted data group while deriving from an incoming requirement body.
func recomputeGenerationProfile(req clarification.Requirement, existing ...map[string][]string) map[string][]string {
	base := req.GenerationProfile
	if len(existing) > 0 {
		base = existing[0]
	}
	// generationProfileForRequirement derives base/domain/pattern (+ blueprint
	// pattern skills) and preserves the existing `data` group UNCONDITIONALLY.
	// Real-data skills are only valid under a real-data policy, so we re-apply the
	// data group under our own policy rules here: live_api / mock_then_api keep the
	// inherited group and merge newly-derived skills (deduped); mock_data and an
	// empty/unknown policy must NOT carry a real-data capability, so any inherited
	// data group is dropped. This prevents a requirement that was live_api (and
	// derived e.g. tide-data-skill) from keeping that skill after the user switches
	// it to mock_data via PATCH/confirm.
	profile := generationProfileForRequirement(req.AppType, req.BlueprintRefs, base)
	switch req.DataPolicy {
	case "live_api", "mock_then_api":
		if derived := deriveDataSkills(req); len(derived) > 0 {
			if profile == nil {
				profile = map[string][]string{}
			}
			profile["data"] = appendUniqueSkills(profile["data"], derived)
		}
	default:
		// mock_data / "" / unknown: drop any inherited real-data capability.
		if profile != nil {
			delete(profile, "data")
		}
	}
	return profile
}
