package dialogue

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// TurnInput is the bounded input one per-message turn round consumes. It carries
// the dialogue id, the new user message, the full message history, and the
// application currently linked to the dialogue (so a modification/inquiry turn
// knows which app it targets). The classifier must emit exactly one of the five
// model.TurnIntent values.
type TurnInput struct {
	DialogueID            string                `json:"dialogueId"`
	UserMessage           string                `json:"userMessage"`
	Messages              []DialogueMessageView `json:"messages"`
	LinkedApplicationID   string                `json:"linkedApplicationId,omitempty"`
	LinkedApplicationSlug string                `json:"linkedApplicationSlug,omitempty"`
}

// DocumentDraftChangeRef links a change summary to a saved document draft.
type DocumentDraftChangeRef struct {
	DraftID        string `json:"draftId"`
	ApplicationID  string `json:"applicationId"`
	DialogueID     string `json:"dialogueId"`
	Path           string `json:"path"`
	SourceChecksum string `json:"sourceChecksum"`
}

// TurnSummary is the structured result of a modification turn: the change the
// user is asking for, in human-facing terms, plus a machine-facing change list.
// Inquiry/control/general turns carry no summary (the round produced no job).
type TurnSummary struct {
	Intent         model.TurnIntent `json:"intent"`
	UserFacingText string           `json:"userFacingText"`
	// ChangeDescription is the modification change summary (non-empty only for a
	// modification turn). It is what the change-confirmation step presents.
	ChangeDescription string `json:"changeDescription,omitempty"`
	// ForkTargetInitialPrompt is the seed prompt for the new dialogue created by a
	// new_application turn (non-empty only for that intent).
	ForkTargetInitialPrompt string `json:"forkTargetInitialPrompt,omitempty"`
	// Reply is the conversational reply for inquiry/general turns.
	Reply string `json:"reply,omitempty"`
	// DocumentDraftChange links the summary to a saved document draft for
	// document-draft-initiated change proposals. Non-nil only when the change
	// originated from an applied document draft.
	DocumentDraftChange *DocumentDraftChangeRef `json:"documentDraftChange,omitempty"`
	// Converter indicates which converter produced the summary: "llm" or "deterministic".
	Converter string `json:"converter,omitempty"`
	// ConversionError records any error that occurred during conversion when fallback was used.
	ConversionError string `json:"conversionError,omitempty"`
}

// TurnOutput is the validated result of one turn-intent round.
type TurnOutput struct {
	Intent  model.TurnIntent
	Summary TurnSummary
}

// TurnClassifier classifies one user message on a continuing dialogue session
// into one of the five turn intents, optionally producing a change summary
// (modification), a fork target (new_application), or a conversational reply
// (inquiry/general). It is the injectable seam the server holds (like
// CommandRunner for routing); the production impl is Runner.ClassifyTurn and
// tests substitute a fake.
type TurnClassifier interface {
	ClassifyTurn(ctx context.Context, input TurnInput, emit func(StreamEvent)) (TurnOutput, error)
}

// ErrTurnInvalidIntent is returned when the turn classifier emits an intent
// outside the five allowed values.
var ErrTurnInvalidIntent = fmt.Errorf("turn intent must be one of application_modification, new_application, application_inquiry, task_control, general_dialogue")

// ClassifyTurn is the production turn-intent round. It runs the claude CLI in
// plan mode (Read/Grep/Glob only, like routing), parses + validates the
// TurnSummary, and emits redacted stream events. A modification turn carries a
// change description; new_application carries a fork seed; inquiry/control/
// general carry no job and may carry a conversational reply.
func (r Runner) ClassifyTurn(ctx context.Context, input TurnInput, emit func(StreamEvent)) (TurnOutput, error) {
	for attempt := 1; attempt <= maxDialogueInvalidJSONAttempts; attempt++ {
		out, err := r.classifyTurnOnce(ctx, input, emit)
		if !shouldRetryDialogueInvalidJSON(err, attempt) {
			return out, err
		}
	}
	return TurnOutput{}, nil
}

func (r Runner) classifyTurnOnce(ctx context.Context, input TurnInput, emit func(StreamEvent)) (TurnOutput, error) {
	dir := filepath.Join(r.artifactRoot(), "dialogues", input.DialogueID, "turn")
	out, err := r.runModel(ctx, dir, input.DialogueID, "turn", input, r.turnPrompt, emit, "dialogue.turn")
	if err != nil {
		return TurnOutput{}, err
	}
	var summary TurnSummary
	if err := json.Unmarshal([]byte(out), &summary); err != nil {
		return TurnOutput{}, fmt.Errorf("decode turn output: %v: %w", err, runner.ErrOutputInvalidJSON)
	}
	if !model.ValidTurnIntent(string(summary.Intent)) {
		return TurnOutput{}, fmt.Errorf("intent %q: %w", summary.Intent, ErrTurnInvalidIntent)
	}
	outBytes, _ := json.MarshalIndent(summary, "", "  ")
	_ = os.WriteFile(filepath.Join(dir, "output.json"), outBytes, 0o644)
	events := []StreamEvent{
		{Type: "dialogue.turn.completed", DialogueID: input.DialogueID, Data: summary},
	}
	if err := writeStream(filepath.Join(dir, "stream.jsonl"), events); err != nil {
		return TurnOutput{}, err
	}
	for _, ev := range events {
		emit(ev)
	}
	return TurnOutput{Intent: summary.Intent, Summary: summary}, nil
}

func (r Runner) turnPrompt(inputPath string) string {
	return "Classify the user's latest message on a continuing application dialogue. " +
		fmt.Sprintf("The turn input is at the absolute path %s — read it with the Read tool. ", inputPath) +
		"Output ONLY valid JSON with an `intent` field set to exactly one of: application_modification, new_application, application_inquiry, task_control, general_dialogue. " +
		"For application_modification, set changeDescription to the requested change. " +
		"For new_application, set forkTargetInitialPrompt to the new application's seed request. " +
		"For application_inquiry or general_dialogue, set reply to a concise answer and do not imply any job. " +
		"For task_control, set reply to acknowledge the control action. " +
		"Never expose hidden reasoning; never invent resource names."
}
