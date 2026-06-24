package server

// This file implements the per-dialogue turn worker (Task 2). A continuing
// dialogue session accepts follow-up messages asynchronously: POST .../messages
// persists the user message + a pending dialogue_turn, signals this worker, and
// returns 202. The worker claims the OLDEST pending turn for a dialogue, runs
// the turn-intent round, and marks the turn terminal before the next turn for
// that dialogue begins — so at most one analysis turn runs per session at a
// time, and later messages queue in order. A user-cancel flips the running turn
// to canceled; the worker finishes the in-flight round then drains the next
// pending turn.
//
// Per-dialogue single-flight is enforced with a per-dialogue running gate (a
// *atomic.Bool per dialogue id). The worker is a single drain goroutine that
// loops over dialogues with pending turns; within one dialogue it never runs two
// turns concurrently because it holds that dialogue's gate for the whole round.

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/weimengtsgit/xian630/factory-server/internal/dialogue"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// TurnWorker drains pending dialogue turns. One instance lives on the Server
// (like the job executor) and is started from Server.Start. It is also
// startable from newDialogueTestServer so tests can drive it.
type TurnWorker struct {
	store         dialogueTurnStore
	classifier    dialogue.TurnClassifier
	server        *Server // callbacks into the server (publish + fork); nil-safe in tests
	signal        chan struct{}
	dialogueGates sync.Map // dialogueID -> *atomic.Bool running gate

	// gatesMu serializes get-or-create of a dialogue gate so two concurrent
	// signals for the same dialogue cannot create two gates.
	gatesMu sync.Mutex

	// currentTurnCancel / currentTurnID mirror the executor's currentCancel /
	// currentJobID atomics: when a turn starts running, its context.CancelFunc +
	// id are stored so CancelRunningTurn can kill the in-flight model round for
	// THIS turn (and only this turn). Reset on round exit. This is what makes "a
	// cancelled turn becomes terminal before the next turn begins" hold under a
	// real round — the cancel path invokes the cancel func, the classifier aborts,
	// and the worker proceeds to the next pending turn rather than relying on the
	// row-flip alone.
	currentTurnCancel atomic.Value // func()
	currentTurnID     atomic.Value // string
}

// dialogueTurnStore is the store seam the worker depends on. *store.Store
// satisfies it; tests substitute an instrumented store if needed.
type dialogueTurnStore interface {
	ListDialogueSessions(ctx context.Context, limit int) ([]model.DialogueSession, error)
	ClaimPendingDialogueTurn(ctx context.Context, dialogueID string) (*model.DialogueTurn, error)
	HasRunningDialogueTurn(ctx context.Context, dialogueID string) (bool, error)
	SetDialogueTurnIntent(ctx context.Context, id string, intent model.TurnIntent, summaryJSON string) error
	CompleteDialogueTurn(ctx context.Context, id string, status model.TurnStatus) error
	GetDialogueSession(ctx context.Context, id string) (*model.DialogueSession, error)
	LatestDialogueMessages(ctx context.Context, dialogueID string, limit int) ([]model.DialogueMessage, error)
	GetDialogueTurn(ctx context.Context, id string) (*model.DialogueTurn, error)
	CancelRunningDialogueTurn(ctx context.Context, dialogueID string) (string, error)
}

// NewTurnWorker builds a TurnWorker over st using classifier. server is the
// owning Server (used for SSE publishing and fork creation); it may be nil in
// isolated unit tests that only exercise claim/complete.
func NewTurnWorker(server *Server, st dialogueTurnStore, classifier dialogue.TurnClassifier) *TurnWorker {
	return &TurnWorker{
		store:      st,
		classifier: classifier,
		server:     server,
		signal:     make(chan struct{}, 1),
	}
}

// Signal is a non-blocking notify that wakes the drain loop. Mirrors
// executor.Signal.
func (w *TurnWorker) Signal() {
	select {
	case w.signal <- struct{}{}:
	default:
	}
}

// Start launches the drain loop that processes pending turns whenever Signaled.
// It returns immediately; the loop exits when ctx is cancelled. Mirrors
// executor.Start.
func (w *TurnWorker) Start(ctx context.Context) {
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-w.signal:
				for {
					if ctx.Err() != nil {
						return
					}
					ran, err := w.drainOnce(ctx)
					if err != nil {
						log.Printf("turn worker: drain: %v", err)
						break
					}
					if !ran {
						break // nothing left pending
					}
				}
			}
		}
	}()
}

// CancelRunningTurn cancels the in-flight model round for the given turn id, if
// that turn is the one currently running. It returns true if the cancel func was
// invoked (i.e. the turn was actively running in this worker). Mirrors the
// executor's Cancel: store the cancel func on round start, invoke it on cancel.
// The caller (cancelDialogueTurn handler) has already flipped the row to
// canceled via store.CancelRunningDialogueTurn; this makes the model round
// actually abort so the worker does not keep a stale in-flight round alive.
func (w *TurnWorker) CancelRunningTurn(turnID string) bool {
	active, _ := w.currentTurnID.Load().(string)
	if active != turnID || active == "" {
		return false
	}
	if fn, ok := w.currentTurnCancel.Load().(func()); ok && fn != nil {
		fn()
		return true
	}
	return false
}

// gateFor returns the per-dialogue running gate, creating it on first use.
func (w *TurnWorker) gateFor(dialogueID string) *atomic.Bool {
	w.gatesMu.Lock()
	defer w.gatesMu.Unlock()
	if v, ok := w.dialogueGates.Load(dialogueID); ok {
		return v.(*atomic.Bool)
	}
	g := new(atomic.Bool)
	w.dialogueGates.Store(dialogueID, g)
	return g
}

// drainOnce runs one pass over dialogues with pending turns, claiming + running
// each oldest pending turn per dialogue. It returns (ranSomething, error).
func (w *TurnWorker) drainOnce(ctx context.Context) (bool, error) {
	sessions, err := w.store.ListDialogueSessions(ctx, 200)
	if err != nil {
		return false, err
	}
	ran := false
	for i := range sessions {
		dlg := sessions[i]
		if !model.IsContinuingDialogueStatus(dlg.Status) {
			continue
		}
		// Per-dialogue single-flight: skip if a turn is already running for it.
		running, err := w.store.HasRunningDialogueTurn(ctx, dlg.ID)
		if err != nil {
			log.Printf("turn worker: has-running %s: %v", dlg.ID, err)
			continue
		}
		if running {
			continue
		}
		if w.runOneTurn(ctx, dlg.ID) {
			ran = true
		}
	}
	return ran, nil
}

// runOneTurn claims the oldest pending turn for one dialogue and runs it. It
// returns false if there was no pending turn to claim (or the single-flight gate
// was already held). Holding the per-dialogue gate for the whole round — across
// claim, classify, persist, complete — is what enforces "at most one turn
// running per session".
func (w *TurnWorker) runOneTurn(ctx context.Context, dialogueID string) bool {
	gate := w.gateFor(dialogueID)
	if !gate.CompareAndSwap(false, true) {
		return false // another turn is already running for this dialogue
	}
	defer gate.Store(false)

	turn, err := w.store.ClaimPendingDialogueTurn(ctx, dialogueID)
	if err != nil {
		log.Printf("turn worker: claim %s: %v", dialogueID, err)
		return false
	}
	if turn == nil {
		return false
	}
	w.processTurn(ctx, dialogueID, turn)
	return true
}

// processTurn runs the turn-intent round for one claimed turn, persists the
// result, and marks the turn terminal. It also performs the side effects the
// intent dictates: a modification turn produces a change summary (and moves the
// session to change_confirmation); new_application forks the dialogue; inquiry/
// control/general produce no job. The server reference drives the SSE publishes
// and the fork creation; when server is nil (isolated worker tests) the side
// effects are skipped but the store transitions still happen.
//
// The round runs under a cancellable context stored on the worker (currentTurn*
// atomics) so CancelRunningTurn can abort the in-flight model round for THIS
// turn. A turn that was already canceled (the handler flips the row terminal
// before invoking cancel) is finalized as canceled rather than completed, so a
// cancel wins even if the classifier was about to return.
func (w *TurnWorker) processTurn(ctx context.Context, dialogueID string, turn *model.DialogueTurn) {
	if w.server != nil {
		w.server.publishDialogueSimple("dialogue.turn.started", dialogueID, map[string]any{
			"turn_id": turn.ID, "message_id": turn.MessageID,
		})
	}
	dlg, _ := w.store.GetDialogueSession(ctx, dialogueID)
	if dlg != nil {
		_ = w.serverUpdateDialogueStatus(ctx, dialogueID, model.DialogueStatusAnalyzing)
	}

	// Cancellable context for this round, stored so CancelRunningTurn can kill
	// the in-flight model round (mirrors executor.runJobStep). Reset on exit.
	runCtx, cancel := context.WithCancel(ctx)
	w.currentTurnCancel.Store(turnCancelFunc(cancel))
	w.currentTurnID.Store(turn.ID)
	defer func() {
		w.currentTurnCancel.Store(turnCancelFunc(func() {}))
		w.currentTurnID.Store("")
	}()

	w.runRound(runCtx, ctx, dialogueID, turn)
}

// runRound is the body of processTurn after the cancel context is wired. It is a
// separate method so processTurn's defer reliably resets the currentTurn*
// atomics. runCtx is the cancellable context for the model round; ctx is the
// worker's own (uncancelled) context used for terminal-status persistence.
func (w *TurnWorker) runRound(runCtx, ctx context.Context, dialogueID string, turn *model.DialogueTurn) {
	// Fix 2: an empty user message must not be classified. A missing/corrupt
	// message row is a failed turn, not a round on empty input.
	input, err := w.buildTurnInput(ctx, dialogueID, turn)
	if err != nil {
		log.Printf("turn worker: build input %s: %v", dialogueID, err)
		w.failTurn(ctx, dialogueID, turn)
		return
	}
	if strings.TrimSpace(input.UserMessage) == "" {
		log.Printf("turn worker: turn %s has no user message to classify", turn.ID)
		w.failTurn(ctx, dialogueID, turn)
		return
	}
	out, err := w.classifier.ClassifyTurn(runCtx, input, w.emitFn())
	if err != nil {
		// A cancel that arrived during the round wins over any result: the
		// handler already flipped the row to canceled, so finalize as canceled.
		if fresh, _ := w.store.GetDialogueTurn(ctx, turn.ID); fresh != nil && fresh.Status == model.TurnStatusCanceled {
			w.finalizeCanceled(ctx, dialogueID, turn)
			return
		}
		log.Printf("turn worker: classify %s turn %s: %v", dialogueID, turn.ID, err)
		w.failTurn(ctx, dialogueID, turn)
		return
	}
	// The row may have been flipped to canceled while the classifier was in
	// flight (the cancel handler invokes the cancel func AND flips the row). In
	// that case discard the result and finalize as canceled.
	if fresh, _ := w.store.GetDialogueTurn(ctx, turn.ID); fresh != nil && fresh.Status == model.TurnStatusCanceled {
		w.finalizeCanceled(ctx, dialogueID, turn)
		return
	}
	summaryJSON := marshalTurnSummary(out.Summary)
	_ = w.store.SetDialogueTurnIntent(ctx, turn.ID, out.Intent, summaryJSON)
	// Fix 4: a fork that fails to create the new dialogue (returns "") must fail
	// the turn, not emit a bogus dialogue.forked with an empty new_dialogue_id.
	if !w.applyTurnIntent(ctx, dialogueID, turn, out) {
		w.failTurn(ctx, dialogueID, turn)
		return
	}
	w.completeTurn(ctx, dialogueID, turn, out)
}

// failTransition logs a terminal-status store error instead of silently
// discarding it (Fix 3). The best-effort non-terminal writes inside processTurn
// still use _ = since they do not gate control flow; only the terminal
// transitions are surfaced so a stuck-running turn is observable.
func failTransition(label, dialogueID, turnID string, err error) {
	log.Printf("turn worker: %s dialogue %s turn %s: %v", label, dialogueID, turnID, err)
}

// failTurn marks the turn failed, restores the session to active, and emits the
// failed lifecycle event. Used by every failure path (build-input, empty
// message, classify, fork).
func (w *TurnWorker) failTurn(ctx context.Context, dialogueID string, turn *model.DialogueTurn) {
	if err := w.store.CompleteDialogueTurn(ctx, turn.ID, model.TurnStatusFailed); err != nil {
		failTransition("complete(failed)", dialogueID, turn.ID, err)
	}
	_ = w.serverUpdateDialogueStatus(ctx, dialogueID, model.DialogueStatusActive)
	if w.server != nil {
		w.server.publishDialogueSimple("dialogue.turn.failed", dialogueID, map[string]any{"turn_id": turn.ID})
	}
}

// finalizeCanceled marks the turn canceled (if not already) and emits the
// canceled lifecycle event. The handler usually already flipped the row; this
// makes the worker's terminal transition explicit and idempotent.
func (w *TurnWorker) finalizeCanceled(ctx context.Context, dialogueID string, turn *model.DialogueTurn) {
	if fresh, _ := w.store.GetDialogueTurn(ctx, turn.ID); fresh == nil || fresh.Status != model.TurnStatusCanceled {
		if _, err := w.store.CancelRunningDialogueTurn(ctx, dialogueID); err != nil {
			failTransition("cancel", dialogueID, turn.ID, err)
		}
	}
	_ = w.serverUpdateDialogueStatus(ctx, dialogueID, model.DialogueStatusActive)
	if w.server != nil {
		w.server.publishDialogueSimple("dialogue.turn.canceled", dialogueID, map[string]any{"turn_id": turn.ID})
	}
}

// completeTurn is the success path: it marks the turn completed and emits the
// completed lifecycle event. The terminal transition is logged on error (Fix 3)
// so a stuck-running turn is observable.
func (w *TurnWorker) completeTurn(ctx context.Context, dialogueID string, turn *model.DialogueTurn, out dialogue.TurnOutput) {
	if err := w.store.CompleteDialogueTurn(ctx, turn.ID, model.TurnStatusCompleted); err != nil {
		failTransition("complete", dialogueID, turn.ID, err)
	}
	status := model.DialogueStatusActive
	if out.Intent == model.TurnIntentApplicationModification {
		status = model.DialogueStatusChangeConfirmation
	}
	_ = w.serverUpdateDialogueStatus(ctx, dialogueID, status)
	if w.server != nil {
		w.server.publishDialogueSimple("dialogue.turn.completed", dialogueID, map[string]any{
			"turn_id": turn.ID, "intent": string(out.Intent),
		})
	}
}

// turnCancelFunc adapts context.CancelFunc (func()) to the empty func() stored
// in an atomic.Value; storing a typed nil CancelFunc would surprise Load.
// Mirrors executor.cancelFunc.
func turnCancelFunc(f context.CancelFunc) func() {
	return func() { f() }
}

// serverUpdateDialogueStatus wraps the store call so the worker is testable with
// a nil server (the store seam carries it). It is a thin indirection that lets a
// nil-server test still flip status.
func (w *TurnWorker) serverUpdateDialogueStatus(ctx context.Context, dialogueID string, status model.DialogueStatus) error {
	if st, ok := w.store.(interface {
		UpdateDialogueStatus(ctx context.Context, id string, status model.DialogueStatus, code, message string) error
	}); ok {
		return st.UpdateDialogueStatus(ctx, dialogueID, status, "", "")
	}
	return nil
}

// emitFn returns the SSE publish callback handed to the classifier. It is nil in
// isolated worker tests (no server); the classifier must tolerate a nil emit.
func (w *TurnWorker) emitFn() func(dialogue.StreamEvent) {
	if w.server == nil {
		return func(dialogue.StreamEvent) {}
	}
	return w.server.publishDialogueEvent
}

// buildTurnInput assembles the bounded turn input from the persisted session +
// message history.
func (w *TurnWorker) buildTurnInput(ctx context.Context, dialogueID string, turn *model.DialogueTurn) (dialogue.TurnInput, error) {
	msgs, err := w.store.LatestDialogueMessages(ctx, dialogueID, 100)
	if err != nil {
		return dialogue.TurnInput{}, err
	}
	userMessage := ""
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].ID == turn.MessageID {
			userMessage = msgs[i].Content
			break
		}
	}
	input := dialogue.TurnInput{
		DialogueID:  dialogueID,
		UserMessage: userMessage,
		Messages:    messageViews(msgs),
	}
	if dlg, _ := w.store.GetDialogueSession(ctx, dialogueID); dlg != nil {
		input.LinkedApplicationID = dlg.ResolvedApplicationID
	}
	return input, nil
}

// applyTurnIntent performs the intent-specific side effects for a completed
// turn. modification -> change summary + change_confirmation; new_application ->
// fork (new dialogue draft) + dialogue.forked; inquiry/control/general -> no
// job. It returns false if a side effect failed irrecoverably (a fork that could
// not create the new dialogue), in which case the caller fails the turn rather
// than emitting a bogus event.
func (w *TurnWorker) applyTurnIntent(ctx context.Context, dialogueID string, turn *model.DialogueTurn, out dialogue.TurnOutput) bool {
	switch out.Intent {
	case model.TurnIntentApplicationModification:
		_ = w.serverUpdateDialogueStatus(ctx, dialogueID, model.DialogueStatusChangeConfirmation)
		if w.server != nil {
			payload, _ := json.Marshal(map[string]string{
				"turn_id": turn.ID, "summary": out.Summary.ChangeDescription,
			})
			_, _ = w.server.recordAndPublishWorkTrace(ctx, model.WorkTraceEvent{
				DialogueID: dialogueID, Type: string(model.WorkTraceChangeConfirm), PayloadJSON: string(payload),
			})
			w.server.publishDialogueSimple("dialogue.change.proposed", dialogueID, map[string]any{
				"turn_id":            turn.ID,
				"change_description": out.Summary.ChangeDescription,
			})
		}
	case model.TurnIntentNewApplication:
		// Fork: create a new dialogue draft seeded by the turn's fork target and
		// emit dialogue.forked. The new dialogue starts in routing so it gets its
		// own first-message route. A FAILED fork (CreateDialogueSession error ->
		// forkID "") fails the turn: it is not a fork, so no dialogue.forked event
		// with an empty new_dialogue_id is emitted.
		if w.server != nil {
			forkID := w.server.forkDialogue(ctx, dialogueID, out.Summary.ForkTargetInitialPrompt)
			if forkID == "" {
				log.Printf("turn worker: fork failed (no new dialogue) for turn %s", turn.ID)
				return false
			}
			w.server.publishDialogueSimple("dialogue.forked", dialogueID, map[string]any{
				"source_dialogue_id": dialogueID,
				"new_dialogue_id":    forkID,
				"turn_id":            turn.ID,
			})
		}
		_ = w.serverUpdateDialogueStatus(ctx, dialogueID, model.DialogueStatusActive)
	case model.TurnIntentApplicationInquiry,
		model.TurnIntentTaskControl,
		model.TurnIntentGeneralDialogue:
		// No job. A conversational reply (if any) was emitted by the classifier.
	}
	return true
}

func marshalTurnSummary(s dialogue.TurnSummary) string {
	b, _ := json.Marshal(s)
	return string(b)
}
