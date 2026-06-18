package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHubPublishesToSubscriber(t *testing.T) {
	h := NewHub()
	ch := h.Subscribe()
	defer h.Unsubscribe(ch)
	h.Publish(Event{Type: "job.updated", Data: map[string]any{"id": "job_1"}})
	select {
	case ev := <-ch:
		if ev.Type != "job.updated" {
			t.Fatalf("event = %#v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for event")
	}
}

func TestWriteSSEFormat(t *testing.T) {
	rec := httptest.NewRecorder()
	ev := Event{Seq: 1, Type: "job.updated", Data: map[string]any{"id": "job_1"}, At: time.Unix(0, 0).UTC()}
	out, err := writeSSE(rec, ev)
	if err != nil {
		t.Fatalf("writeSSE: %v", err)
	}
	s := string(out)
	if !strings.Contains(s, "event: job.updated\n") {
		t.Fatalf("missing event line in %q", s)
	}
	if !strings.Contains(s, "data: ") {
		t.Fatalf("missing data line in %q", s)
	}
	if !strings.Contains(s, `"type":"job.updated"`) {
		t.Fatalf("data line missing type field in %q", s)
	}
}
