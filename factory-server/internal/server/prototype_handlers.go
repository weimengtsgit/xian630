package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Server) jobPrototypeSummary(w http.ResponseWriter, r *http.Request) {
	ref, manifest, contract, ok := s.latestPrototypeRef(r, true)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"artifactId":   ref.ID,
		"status":       ref.Status,
		"label":        ref.Label,
		"previewUrl":   ref.PreviewURL,
		"manifest":     manifest,
		"contract":     contract,
		"snapshotHash": ref.SnapshotHash,
		"updatedAt":    ref.UpdatedAt,
	})
}

func (s *Server) jobPrototypePreview(w http.ResponseWriter, r *http.Request) {
	ref, _, _, ok := s.latestPrototypeRef(r, false)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	indexPath := prototypeIndexPathFromRef(ref)
	full, ok := resolveAttachmentPath(s.cfg.ArtifactRoot, indexPath)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeError(w, http.StatusNotFound, "prototype unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

func prototypeIndexPathFromRef(ref *model.WorkbenchArtifactRef) string {
	if strings.HasSuffix(ref.Path, "/preview-manifest.json") {
		return strings.TrimSuffix(ref.Path, "/preview-manifest.json") + "/index.html"
	}
	return filepath.ToSlash(filepath.Join(filepath.Dir(ref.Path), "index.html"))
}

func (s *Server) latestPrototypeRef(r *http.Request, readDetails bool) (*model.WorkbenchArtifactRef, map[string]any, map[string]any, bool) {
	jobID := Param(r, "id")
	stepID := Param(r, "stepID")
	refs, err := s.store.ListWorkbenchArtifactRefsByJob(r.Context(), jobID)
	if err != nil {
		return nil, nil, nil, false
	}
	var match *model.WorkbenchArtifactRef
	for i := range refs {
		ref := &refs[i]
		if ref.StepID != stepID || ref.Kind != model.WorkbenchArtifactInterfacePreview || ref.CardKey != "interface_parsing" {
			continue
		}
		if match == nil || ref.UpdatedAt.After(match.UpdatedAt) {
			match = ref
		}
	}
	if match == nil {
		return nil, nil, nil, false
	}
	if !readDetails {
		return match, nil, nil, true
	}
	var manifest map[string]any
	if !readArtifactJSON(s.cfg.ArtifactRoot, match.Path, &manifest) {
		return nil, nil, nil, false
	}
	contractPath := strings.TrimSuffix(match.Path, "/preview-manifest.json") + "/prototype-contract.json"
	var contract map[string]any
	if !readArtifactJSON(s.cfg.ArtifactRoot, contractPath, &contract) {
		return nil, nil, nil, false
	}
	return match, manifest, contract, true
}

func readArtifactJSON(root, rel string, out any) bool {
	full, ok := resolveAttachmentPath(root, rel)
	if !ok {
		return false
	}
	raw, err := os.ReadFile(full)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, out) == nil
}

func (s *Server) confirmJobPrototype(w http.ResponseWriter, r *http.Request) {
	s.setPrototypeStatus(w, r, "confirmed")
}

func (s *Server) continueJobPrototypeWithoutConfirmation(w http.ResponseWriter, r *http.Request) {
	s.setPrototypeStatus(w, r, "continued_without_confirmation")
}

func (s *Server) setPrototypeStatus(w http.ResponseWriter, r *http.Request, status string) {
	ref, manifest, contract, ok := s.latestPrototypeRef(r, true)
	if !ok {
		writeError(w, http.StatusNotFound, "prototype not found")
		return
	}
	if err := s.applyPrototypeDecision(r.Context(), ref, status); err != nil {
		if err == errConfirmedPrototypeImmutable {
			writeError(w, http.StatusConflict, "confirmed prototype is immutable")
			return
		}
		writeError(w, http.StatusInternalServerError, "update prototype")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"artifactId": ref.ID,
		"status":     ref.Status,
		"manifest":   manifest,
		"contract":   contract,
	})
}

var errConfirmedPrototypeImmutable = errors.New("confirmed prototype is immutable")

func (s *Server) applyPrototypeDecision(ctx context.Context, ref *model.WorkbenchArtifactRef, status string) error {
	if ref.Status == "confirmed" && status != "confirmed" {
		return errConfirmedPrototypeImmutable
	}
	ref.Status = status
	ref.UpdatedAt = time.Now()
	if err := s.store.UpsertWorkbenchArtifactRef(ctx, *ref); err != nil {
		return err
	}
	if status == "confirmed" || status == "continued_without_confirmation" {
		if err := s.advancePrototypeStepAfterDecision(ctx, ref.JobID, ref.StepID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) applyLatestPrototypeDecision(ctx context.Context, jobID, stepID, status string) error {
	refs, err := s.store.ListWorkbenchArtifactRefsByJob(ctx, jobID)
	if err != nil {
		return err
	}
	var match *model.WorkbenchArtifactRef
	for i := range refs {
		ref := &refs[i]
		if ref.StepID != stepID || ref.Kind != model.WorkbenchArtifactInterfacePreview || ref.CardKey != "interface_parsing" {
			continue
		}
		if match == nil || ref.UpdatedAt.After(match.UpdatedAt) {
			match = ref
		}
	}
	if match == nil {
		return os.ErrNotExist
	}
	return s.applyPrototypeDecision(ctx, match, status)
}

func (s *Server) advancePrototypeStepAfterDecision(ctx context.Context, jobID, stepID string) error {
	steps, err := s.store.ListJobSteps(ctx, jobID)
	if err != nil {
		return err
	}
	var current *model.JobStep
	for i := range steps {
		if steps[i].ID == stepID {
			current = &steps[i]
			break
		}
	}
	if current == nil || current.Kind != model.StepDesignContract || current.Status != model.StepStatusWaitingUser {
		return nil
	}
	if err := s.store.MarkStepSucceeded(ctx, current.ID, ""); err != nil {
		return err
	}
	var next *model.JobStep
	for i := range steps {
		if steps[i].Seq > current.Seq && (next == nil || steps[i].Seq < next.Seq) {
			next = &steps[i]
		}
	}
	if next == nil {
		if err := s.store.MarkJobCompleted(ctx, jobID); err != nil {
			return err
		}
		s.publishStepUpdated(ctx, current.ID)
		s.hub.Publish(Event{Type: "job.updated", Data: map[string]any{"id": jobID, "status": model.JobStatusCompleted}})
		return nil
	}
	if err := s.store.AdvanceJobStep(ctx, jobID, next.Kind); err != nil {
		return err
	}
	if err := s.store.MarkJobQueued(ctx, jobID); err != nil {
		return err
	}
	s.publishStepUpdated(ctx, current.ID)
	if s.exec != nil {
		s.exec.Signal()
	}
	return nil
}
func (s *Server) jobPrototypeFeedback(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Feedback string `json:"feedback"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Feedback) == "" {
		writeError(w, http.StatusBadRequest, "feedback required")
		return
	}
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
	steps, err := s.store.ListJobSteps(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	var targetStep *model.JobStep
	for i := range steps {
		if steps[i].ID == stepID {
			targetStep = &steps[i]
			break
		}
	}
	if targetStep == nil || targetStep.Kind != model.StepDesignContract {
		writeError(w, http.StatusNotFound, "prototype step not found")
		return
	}
	if err := s.store.SetStepUserPrompt(r.Context(), targetStep.ID, strings.TrimSpace(body.Feedback)); err != nil {
		writeError(w, http.StatusInternalServerError, "set prototype feedback")
		return
	}
	if err := s.store.ResetStepToPending(r.Context(), targetStep.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "reset prototype step")
		return
	}
	s.publishStepUpdated(r.Context(), targetStep.ID)
	if s.exec != nil {
		s.exec.Signal()
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "accepted", "stepId": targetStep.ID})
}
