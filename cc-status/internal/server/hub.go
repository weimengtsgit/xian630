package server

import (
	"sync"
	"time"

	"github.com/weimengtsgit/xian630/cc-status/internal/hook"
	"github.com/weimengtsgit/xian630/cc-status/internal/model"
)

// Hub fans out ingested events to SSE subscribers. Slow subscribers drop events
// rather than block ingestion.
type Hub struct {
	mu   sync.RWMutex
	subs map[chan model.EventRow]struct{}
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{subs: map[chan model.EventRow]struct{}{}}
}

// Subscribe returns a buffered channel of event rows; call Unsubscribe to stop.
func (h *Hub) Subscribe() chan model.EventRow {
	ch := make(chan model.EventRow, 64)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

// Unsubscribe removes and closes a subscriber channel.
func (h *Hub) Unsubscribe(ch chan model.EventRow) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
	close(ch)
}

// Publish broadcasts an event row to all subscribers (non-blocking).
func (h *Hub) Publish(seq int64, e *hook.Event) {
	er := model.EventRow{
		Seq:           seq,
		Ts:            time.Now(),
		HookEventName: e.HookEventName,
		SessionID:     e.SessionID,
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs {
		select {
		case ch <- er:
		default:
			// subscriber is lagging; drop to protect the ingest hot path
		}
	}
}
