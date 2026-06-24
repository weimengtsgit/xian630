package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// Event is a single Server-Sent-Events payload broadcast by the Hub. Seq is a
// monotonically increasing per-hub sequence number assigned by Publish.
type Event struct {
	Seq  int64     `json:"seq"`
	Type string    `json:"type"`
	Data any       `json:"data,omitempty"`
	At   time.Time `json:"at"`
}

// Hub fans out Events to SSE subscribers. Slow subscribers drop events rather
// than block the publisher (non-blocking send).
type Hub struct {
	mu   sync.RWMutex
	subs map[chan Event]struct{}
	seq  atomic.Int64
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{subs: map[chan Event]struct{}{}}
}

// Subscribe returns a buffered channel of Events; call Unsubscribe to stop.
func (h *Hub) Subscribe() chan Event {
	ch := make(chan Event, 16)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

// Unsubscribe removes and closes a subscriber channel.
func (h *Hub) Unsubscribe(ch chan Event) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
	close(ch)
}

// Publish fills in Seq (incremented atomically) and At (now if zero), then
// broadcasts the event to all subscribers. Sends are non-blocking: a slow
// subscriber's event is dropped, never held.
func (h *Hub) Publish(ev Event) {
	ev.Seq = h.seq.Add(1)
	if ev.At.IsZero() {
		ev.At = time.Now()
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
			// subscriber is lagging; drop to protect the publish hot path
		}
	}
}

// events handles GET /api/events — a Server-Sent-Events stream of every Event
// published to the hub. The connection stays open until the client disconnects;
// a 15s keep-alive comment (": ping") is emitted between events.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	if _, err := w.Write([]byte(": connected\n\n")); err != nil {
		return
	}
	fl.Flush()

	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-ch:
			if _, err := writeSSE(w, ev); err != nil {
				return
			}
			fl.Flush()
		case <-ticker.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

// writeSSE formats an Event as an SSE frame: an "event:" line keyed by Type and
// a "data:" line holding the JSON-encoded Event. Returns the bytes written.
func writeSSE(w http.ResponseWriter, ev Event) ([]byte, error) {
	payload, err := json.Marshal(ev)
	if err != nil {
		return nil, err
	}
	out := append([]byte("event: "), ev.Type...)
	out = append(out, '\n')
	out = append(out, "data: "...)
	out = append(out, payload...)
	out = append(out, '\n', '\n')
	if _, err := w.Write(out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Server) publishAppUpdated(ctx context.Context, appID string) {
	if s.hub == nil || s.store == nil {
		return
	}
	app, err := s.store.GetApplication(ctx, appID)
	if err != nil || app == nil {
		return
	}
	s.hub.Publish(Event{Type: "app.updated", Data: app})
}

func (s *Server) publishDeploymentUpdated(ctx context.Context, deploymentID string) {
	if s.hub == nil || s.store == nil {
		return
	}
	dep, err := s.store.GetDeployment(ctx, deploymentID)
	if err != nil || dep == nil {
		return
	}
	s.hub.Publish(Event{Type: "deployment.updated", Data: dep})
}

func (s *Server) publishJobUpdated(ctx context.Context, jobID string) {
	if s.hub == nil || s.store == nil {
		return
	}
	job, err := s.store.GetJob(ctx, jobID)
	if err != nil || job == nil {
		return
	}
	s.hub.Publish(Event{Type: "job.updated", Data: job})
}

func (s *Server) publishStepUpdated(_ context.Context, stepID string) {
	if s.hub == nil || stepID == "" {
		return
	}
	s.hub.Publish(Event{Type: "step.updated", Data: map[string]string{"id": stepID}})
}

// workTraceEventType is the SSE event type for a live work-trace event.
const workTraceEventType = "dialogue.work_trace"

// recordAndPublishWorkTrace is the centralized PERSIST-BEFORE-PUBLISH path for
// visible work-trace events (Constraint #8). It persists the trace row (which
// assigns its dialogue-scoped sequence and runs the security gate) and ONLY on
// success publishes it to the hub. It never publishes an unpersisted event: the
// store call returning an error short-circuits the publish.
//
// The published Event carries the persisted trace row as Data, tagged with the
// event type workTraceEventType, so the dialogue-scoped SSE stream can filter by
// dialogue_id and assign the row's sequence as the SSE id. A nil hub is a no-op
// for the publish half but the row is still persisted (persist is the source of
// truth; publish is a best-effort live nudge).
func (s *Server) recordAndPublishWorkTrace(ctx context.Context, ev model.WorkTraceEvent) (model.WorkTraceEvent, error) {
	persisted, err := s.store.AppendDialogueTrace(ctx, ev)
	if err != nil {
		return model.WorkTraceEvent{}, err
	}
	if s.hub != nil {
		s.hub.Publish(Event{Type: workTraceEventType, Data: persisted})
	}
	return persisted, nil
}

// dialogueTraceEvents handles GET /api/dialogues/:id/work-trace — the REST
// hydration endpoint. It returns the persisted work-trace rows for a dialogue,
// ascending by sequence, honoring the optional afterSequence replay cursor.
// Paging is capped server-side at 500 rows.
func (s *Server) dialogueTraceEvents(w http.ResponseWriter, r *http.Request) {
	dialogueID := Param(r, "id")
	if dialogueID == "" {
		http.Error(w, "missing dialogue id", http.StatusBadRequest)
		return
	}
	afterSequence := parseSequenceQuery(r.URL.Query().Get("afterSequence"))
	rows, err := s.store.ListDialogueTrace(r.Context(), dialogueID, afterSequence, 0)
	if err != nil {
		http.Error(w, "list work traces: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if rows == nil {
		rows = []model.WorkTraceEvent{}
	}
	if err := json.NewEncoder(w).Encode(rows); err != nil {
		http.Error(w, "encode: "+err.Error(), http.StatusInternalServerError)
		return
	}
}

// dialogueTraceStream handles GET /api/dialogues/:id/work-trace/stream — the
// dialogue-scoped SSE transport (Constraint #7/#8). On connect it determines the
// replay cursor from the Last-Event-ID request header (standard SSE reconnect)
// or, absent that, the afterSequence query param, REPLAYS persisted rows from
// that sequence FIRST, then subscribes to live hub events and forwards ONLY
// those filtered to this dialogue_id. Each emitted frame carries the trace
// row's dialogue-scoped sequence as the SSE id: so a client reconnecting with
// Last-Event-ID resumes exactly after it.
//
// Filtering is server-side: other dialogues' events are never sent. Dedup by
// sequence across the replay→live boundary so an event that was both replayed
// and in-flight on subscribe is sent exactly once.
func (s *Server) dialogueTraceStream(w http.ResponseWriter, r *http.Request) {
	dialogueID := Param(r, "id")
	if dialogueID == "" {
		http.Error(w, "missing dialogue id", http.StatusBadRequest)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Resolve the replay cursor BEFORE committing the SSE response. Last-Event-ID
	// (standard SSE reconnect) takes precedence over the query param when both are
	// present.
	startAfter := parseSequenceQuery(r.URL.Query().Get("afterSequence"))
	if lid := r.Header.Get("Last-Event-ID"); lid != "" {
		if v, ok := parseSequence(lid); ok {
			startAfter = v
		}
	}

	// Subscribe BEFORE reading the replay snapshot. Otherwise an event persisted
	// between ListDialogueTrace and Hub.Subscribe is in neither the snapshot nor
	// the live channel and can remain invisible until a later reconnect.
	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)

	// Read the persisted replay snapshot before the SSE headers are flushed
	// so a store error can still be reported as a proper HTTP error (Fix 6: an
	// http.Error after the text/event-stream headers are committed is a no-op).
	rows, err := s.store.ListDialogueTrace(r.Context(), dialogueID, startAfter, 0)
	if err != nil {
		http.Error(w, "list work traces: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	if _, err := w.Write([]byte(": connected\n\n")); err != nil {
		return
	}
	fl.Flush()

	// Emit the replayed rows, tracking the highest sequence emitted so the live
	// phase can dedup against it.
	lastEmitted := startAfter
	for _, row := range rows {
		if row.Sequence <= lastEmitted {
			continue // dedup guard
		}
		if werr := writeTraceSSE(w, row); werr != nil {
			return
		}
		fl.Flush()
		lastEmitted = row.Sequence
	}

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-ch:
			row, ok := traceRowForDialogue(ev, dialogueID)
			if !ok {
				continue // not a work-trace event, or for another dialogue
			}
			if row.Sequence <= lastEmitted {
				continue // dedup across replay→live boundary
			}
			// STORE-VALIDATED forward (Fix 2): confirm a persisted
			// work_trace_events row exists for this (dialogue_id, sequence)
			// before forwarding. This enforces the security property that NO
			// unpersisted trace event can reach the wire: an event injected
			// directly via the hub (bypassing recordAndPublishWorkTrace, so
			// never persisted) is dropped here.
			if !s.store.WorkTraceRowExists(ctx, dialogueID, row.Sequence) {
				continue
			}
			if werr := writeTraceSSE(w, row); werr != nil {
				return
			}
			lastEmitted = row.Sequence
			fl.Flush()
		case <-ticker.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

// writeTraceSSE emits one work-trace row as an SSE frame with the row's
// sequence as the id: line and the row JSON as the data: line.
func writeTraceSSE(w http.ResponseWriter, row model.WorkTraceEvent) error {
	payload, err := json.Marshal(row)
	if err != nil {
		return err
	}
	out := []byte("event: " + workTraceEventType + "\n")
	out = append(out, []byte("id: ")...)
	out = strconv.AppendInt(out, row.Sequence, 10)
	out = append(out, '\n')
	out = append(out, []byte("data: ")...)
	out = append(out, payload...)
	out = append(out, '\n', '\n')
	_, err = w.Write(out)
	return err
}

// traceRowForDialogue extracts a WorkTraceEvent from a hub Event iff it is a
// work-trace event scoped to dialogueID. It returns (row, true) only when the
// event is a work-trace event whose dialogue_id matches; everything else
// (including other dialogues' trace events and all non-trace events) is
// rejected — server-side filtering, never trusting the client.
func traceRowForDialogue(ev Event, dialogueID string) (model.WorkTraceEvent, bool) {
	if ev.Type != workTraceEventType {
		return model.WorkTraceEvent{}, false
	}
	// The published Data is the persisted trace row. Round-trip it to its typed
	// form to read dialogue_id + sequence.
	b, err := json.Marshal(ev.Data)
	if err != nil {
		return model.WorkTraceEvent{}, false
	}
	var row model.WorkTraceEvent
	if err := json.Unmarshal(b, &row); err != nil {
		return model.WorkTraceEvent{}, false
	}
	if row.DialogueID != dialogueID {
		return model.WorkTraceEvent{}, false
	}
	return row, true
}

// parseSequenceQuery parses a non-negative integer query/header value. It
// returns 0 for empty or unparseable input (meaning "start from the
// beginning").
func parseSequenceQuery(s string) int64 {
	v, ok := parseSequence(s)
	if !ok {
		return 0
	}
	return v
}

// parseSequence parses a non-negative int64, returning ok=false on empty or
// invalid input.
func parseSequence(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	var n int64
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int64(r-'0')
	}
	return n, true
}
