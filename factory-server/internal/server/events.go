package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
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
