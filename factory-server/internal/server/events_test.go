package server

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// newTraceTestServer wires a minimal Server (store + hub) for the work-trace
// stream tests. It does not start any background worker; tests drive the store
// and hub directly.
func newTraceTestServer(t *testing.T) *Server {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return New(config.Config{WorkspaceRoot: t.TempDir()}, st, scanner.Scanner{})
}

// readSSEEvent reads one SSE frame from the buffered reader and returns the
// event-type line, the id line, and the data line, plus an error if reading
// failed. It skips comment lines (": connected" / ": ping"). It does NOT call
// t.Fatalf internally (Fix 1): the caller asserts the error in the select
// branch so a misbehaving stream surfaces as a real test failure rather than a
// goroutine t.Fatalf that cannot stop the caller (and a deadlocked timeout).
func readSSEEvent(t *testing.T, br *bufio.Reader) (eventType, idLine, dataLine string, err error) {
	t.Helper()
	for {
		line, rerr := br.ReadString('\n')
		if rerr != nil {
			return eventType, idLine, dataLine, rerr
		}
		line = strings.TrimRight(line, "\n")
		if line == "" {
			// frame boundary; return accumulated event if any
			if eventType != "" || dataLine != "" {
				return eventType, idLine, dataLine, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // comment
		}
		switch {
		case strings.HasPrefix(line, "event: "):
			eventType = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "id: "):
			idLine = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "data: "):
			dataLine = strings.TrimPrefix(line, "data: ")
		}
	}
}

// TestWorkTraceRESTReplayReturnsPersistedRows verifies the REST hydration
// endpoint returns persisted rows ascending by sequence.
func TestWorkTraceRESTReplayReturnsPersistedRows(t *testing.T) {
	srv := newTraceTestServer(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			ID: "", DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	r := srv.routes()
	req := httptest.NewRequest("GET", "/api/dialogues/dlg_1/work-trace", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	// Three rows ascending; sequence present.
	if !strings.Contains(body, `"sequence":1`) || !strings.Contains(body, `"sequence":3`) {
		t.Fatalf("missing sequences in body: %s", body)
	}
}

// TestWorkTraceRESTAfterSequenceFilter verifies the REST afterSequence filter.
func TestWorkTraceRESTAfterSequenceFilter(t *testing.T) {
	srv := newTraceTestServer(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			ID: "", DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	r := srv.routes()
	req := httptest.NewRequest("GET", "/api/dialogues/dlg_1/work-trace?afterSequence=1", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status=%d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, `"sequence":1`) {
		t.Fatalf("afterSequence=1 should exclude seq 1: %s", body)
	}
	if !strings.Contains(body, `"sequence":2`) || !strings.Contains(body, `"sequence":3`) {
		t.Fatalf("afterSequence=1 should include seq 2,3: %s", body)
	}
}

// startTraceStreamServer runs the router behind a real httptest.Server so the
// SSE response body is a genuine live stream (httptest.NewRecorder cannot model
// a blocking streaming handler). It returns the server and the *Server (for
// store + hub access).
func startTraceStreamServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	srv := newTraceTestServer(t)
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)
	return ts, srv
}

// openTraceStream connects to the dialogue work-trace SSE stream and returns the
// response body reader. The caller closes resp.Body when done (a cancel/close of
// the underlying server suffices to end the stream).
func openTraceStream(t *testing.T, ts *httptest.Server, path string, lastEventID string) *bufio.Reader {
	t.Helper()
	req, err := http.NewRequest("GET", ts.URL+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return bufio.NewReader(resp.Body)
}

// TestWorkTraceStreamReplaysBeforeLive verifies the SSE endpoint replays
// persisted rows FIRST, then forwards live published events, in that order.
func TestWorkTraceStreamReplaysBeforeLive(t *testing.T) {
	ts, srv := startTraceStreamServer(t)
	ctx := context.Background()
	// Two persisted rows (sequence 1, 2).
	for i := 0; i < 2; i++ {
		if _, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	br := openTraceStream(t, ts, "/api/dialogues/dlg_1/work-trace/stream", "")

	// Expect replay rows sequence 1 then 2, each carrying its sequence as the
	// SSE id line.
	_, id1, _, err := readSSEEvent(t, br)
	if err != nil {
		t.Fatalf("read first replay: %v", err)
	}
	if id1 != "1" {
		t.Fatalf("first replayed id = %q, want 1", id1)
	}
	_, id2, _, err := readSSEEvent(t, br)
	if err != nil {
		t.Fatalf("read second replay: %v", err)
	}
	if id2 != "2" {
		t.Fatalf("second replayed id = %q, want 2", id2)
	}

	// Now persist a LIVE event via the persist-before-publish helper. It publishes
	// to the hub AFTER the row is durable; the stream must forward it (id 3).
	if _, err := srv.recordAndPublishWorkTrace(ctx, model.WorkTraceEvent{
		DialogueID: "dlg_1", Type: string(model.WorkTraceTask), PayloadJSON: "{}",
	}); err != nil {
		t.Fatalf("live record+publish: %v", err)
	}

	// The live event (sequence 3) must arrive after the replay.
	var got3 bool
	for i := 0; i < 3; i++ {
		_, id, _, rerr := readSSEEvent(t, br)
		if rerr != nil {
			t.Fatalf("read live event: %v", rerr)
		}
		if id == "3" {
			got3 = true
			break
		}
	}
	if !got3 {
		t.Fatal("live event (sequence 3) never arrived on stream")
	}
}

// TestWorkTraceStreamFiltersByDialogue verifies the stream is scoped: an event
// published for a DIFFERENT dialogue never reaches this dialogue's stream. It
// reads inline with a context-bounded timeout (Fix 1): the helper surfaces read
// errors through its return value and the test asserts them in the select
// branch, so a misbehaving stream fails the test instead of deadlocking.
func TestWorkTraceStreamFiltersByDialogue(t *testing.T) {
	ts, srv := startTraceStreamServer(t)
	ctx := context.Background()

	br := openTraceStream(t, ts, "/api/dialogues/dlg_A/work-trace/stream", "")

	// Publish a live event for a DIFFERENT dialogue. The hub forwards it; the
	// stream MUST filter it out (server-side, never trusting the client).
	if _, err := srv.recordAndPublishWorkTrace(ctx, model.WorkTraceEvent{
		DialogueID: "dlg_B", Type: string(model.WorkTraceError), PayloadJSON: "{}",
	}); err != nil {
		t.Fatalf("append other: %v", err)
	}
	// Publish a live event for OUR dialogue; it must arrive.
	if _, err := srv.recordAndPublishWorkTrace(ctx, model.WorkTraceEvent{
		DialogueID: "dlg_A", Type: string(model.WorkTraceWarning), PayloadJSON: "{}",
	}); err != nil {
		t.Fatalf("append ours: %v", err)
	}

	type sseResult struct {
		eventType, idLine, dataLine string
		err                         error
	}
	// Read events until ours arrives; if "dlg_B" data leaks, the filter failed.
	deadline := time.After(3 * time.Second)
	for {
		evCh := make(chan sseResult, 1)
		go func() {
			et, id, dl, rerr := readSSEEvent(t, br)
			evCh <- sseResult{et, id, dl, rerr}
		}()
		select {
		case ev := <-evCh:
			if ev.err != nil {
				t.Fatalf("readSSEEvent returned error: %v", ev.err)
			}
			if strings.Contains(ev.dataLine, `"dlg_B"`) {
				t.Fatalf("other dialogue's event leaked to our stream: %s", ev.dataLine)
			}
			if strings.Contains(ev.dataLine, `"dlg_A"`) {
				return // ours arrived; filter held
			}
		case <-deadline:
			t.Fatal("timeout waiting for our dialogue's event (or other dialogue leaked without ours)")
		}
	}
}

// TestWorkTraceStreamDropsUnpersistedHubEvent verifies the store-validated live
// forward (Fix 2): an event injected DIRECTLY via the hub (bypassing
// recordAndPublishWorkTrace, so never persisted to work_trace_events) must NOT
// be delivered to the SSE client. The store is the single source of truth; an
// unpersisted event has no matching row and is dropped before forwarding.
func TestWorkTraceStreamDropsUnpersistedHubEvent(t *testing.T) {
	ts, srv := startTraceStreamServer(t)
	ctx := context.Background()

	br := openTraceStream(t, ts, "/api/dialogues/dlg_1/work-trace/stream", "")

	// Inject an event DIRECTLY into the hub for OUR dialogue — bypassing
	// recordAndPublishWorkTrace, so it is NEVER persisted. It carries a
	// sequence the store has no row for.
	srv.hub.Publish(Event{
		Type: workTraceEventType,
		Data: model.WorkTraceEvent{
			ID: "rogue", DialogueID: "dlg_1", Sequence: 42,
			Type: string(model.WorkTraceError), PayloadJSON: `{"rogue":"unpersisted"}`,
		},
	})

	// Then persist a REAL event via the helper; it MUST arrive (sequence 1).
	if _, err := srv.recordAndPublishWorkTrace(ctx, model.WorkTraceEvent{
		DialogueID: "dlg_1", Type: string(model.WorkTraceWarning), PayloadJSON: "{}",
	}); err != nil {
		t.Fatalf("append real: %v", err)
	}

	type sseResult struct {
		eventType, idLine, dataLine string
		err                         error
	}
	deadline := time.After(3 * time.Second)
	for {
		evCh := make(chan sseResult, 1)
		go func() {
			et, id, dl, rerr := readSSEEvent(t, br)
			evCh <- sseResult{et, id, dl, rerr}
		}()
		select {
		case ev := <-evCh:
			if ev.err != nil {
				t.Fatalf("readSSEEvent returned error: %v", ev.err)
			}
			if strings.Contains(ev.dataLine, `"rogue"`) || strings.Contains(ev.dataLine, `"unpersisted"`) || ev.idLine == "42" {
				t.Fatalf("UNPERSISTED hub event reached the wire (security violation): %s", ev.dataLine)
			}
			if ev.idLine == "1" {
				return // only the persisted event (seq 1) arrived; property held
			}
		case <-deadline:
			t.Fatal("timeout: persisted event never arrived (or unpersisted event blocked the stream)")
		}
	}
}

// TestWorkTraceStreamLastEventIDResume verifies that the Last-Event-ID request
// header controls where replay starts: a client reconnecting with
// Last-Event-ID: 1 receives sequence 2 onward, never re-receiving 1.
func TestWorkTraceStreamLastEventIDResume(t *testing.T) {
	ts, srv := startTraceStreamServer(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	br := openTraceStream(t, ts, "/api/dialogues/dlg_1/work-trace/stream", "1") // resume after seq 1

	_, firstID, _, err := readSSEEvent(t, br)
	if err != nil {
		t.Fatalf("read resume: %v", err)
	}
	if firstID != "2" {
		t.Fatalf("Last-Event-ID=1 resume: first id = %q, want 2 (should not re-send 1)", firstID)
	}
}

// TestWorkTraceStreamLastEventIDHeaderWins verifies precedence (Fix 7): when
// BOTH the Last-Event-ID header AND the afterSequence query param are set, the
// HEADER wins and replay starts from the header's sequence.
func TestWorkTraceStreamLastEventIDHeaderWins(t *testing.T) {
	ts, srv := startTraceStreamServer(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if _, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_1", Type: string(model.WorkTraceIntent), PayloadJSON: "{}",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	// Header says resume after 2; query param says after 4. Header must win →
	// first emitted row is sequence 3, not 5.
	br := openTraceStream(t, ts, "/api/dialogues/dlg_1/work-trace/stream?afterSequence=4", "2")

	_, firstID, _, err := readSSEEvent(t, br)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if firstID != "3" {
		t.Fatalf("Last-Event-ID precedence: first id = %q, want 3 (header=2 should win over query=4)", firstID)
	}
}

// TestWorkTraceStoreGateRejectsDisallowedTypes is the direct security-gate test
// for Constraint #9. The store is the single trust boundary: AppendDialogueTrace
// must REJECT a trace event whose type is outside the allowlist (thinking /
// thinking_delta / raw_request / raw_response / empty string / credential-ish
// types) and persist NOTHING. The existing SSE tests prove isolation and
// unpersisted-event dropping at the transport layer; this proves the producer
// contract is enforced at the persistence boundary regardless of producer.
func TestWorkTraceStoreGateRejectsDisallowedTypes(t *testing.T) {
	srv := newTraceTestServer(t)
	ctx := context.Background()

	disallowed := []string{
		"thinking_delta", // streaming thinking prefix (use "thinking" type instead)
		"raw_request",    // raw upstream request body
		"raw_response",   // raw upstream response body
		"credentials",    // credential-ish type
		"",               // empty type
		"assistant_thinking",
	}
	for _, bad := range disallowed {
		ev, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_gate", Type: bad, PayloadJSON: `{"x":1}`,
		})
		if err == nil {
			t.Fatalf("type %q: expected rejection error, got row %+v", bad, ev)
		}
	}

	// ADR 0007: "thinking" IS allowed now as WorkTraceThinking
	allowedThinking := model.WorkTraceThinking
	ev, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		DialogueID: "dlg_gate", Type: string(allowedThinking), PayloadJSON: `{"thinking":"analysis step"}`,
	})
	if err != nil {
		t.Fatalf("type %q (allowed by ADR 0007): unexpected rejection error: %v", allowedThinking, err)
	}
	if ev.Type != string(allowedThinking) {
		t.Fatalf("type mismatch: got %q, want %q", ev.Type, allowedThinking)
	}

	// Now only the allowed thinking event should be persisted:
	got, err := srv.store.ListDialogueTrace(ctx, "dlg_gate", 0, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 thinking event to be persisted, got %d: %+v", len(got), got)
	}
	if got[0].Type != string(allowedThinking) {
		t.Fatalf("persisted event type mismatch: got %q, want %q", got[0].Type, allowedThinking)
	}

	// A credential-bearing payload on an ALLOWED type is accepted but redacted
	// (the gate zeros sensitive keys rather than rejecting the whole event). This
	// is the defense-in-depth branch of Constraint #9.
	redacted, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
		DialogueID: "dlg_gate", Type: string(model.WorkTraceTool),
		PayloadJSON: `{"tool":"Read","api_key":"sk-secret-12345","path":"a/b"}`,
	})
	if err != nil {
		t.Fatalf("redact-then-accept: %v", err)
	}
	if strings.Contains(redacted.PayloadJSON, "sk-secret-12345") {
		t.Fatalf("credential not redacted on allowed type: %s", redacted.PayloadJSON)
	}
	if !strings.Contains(redacted.PayloadJSON, "[redacted]") {
		t.Fatalf("expected [redacted] marker, got %s", redacted.PayloadJSON)
	}
}

// TestWorkTraceStreamNeverDeliversOtherDialogueOnReplay extends the live
// isolation test (TestWorkTraceStreamFiltersByDialogue) to the REPLAY path: a
// dialogue's persisted replay must not surface another dialogue's rows even when
// both are persisted before the stream connects. This closes the gap where
// isolation was only asserted against live hub events, not stored replay.
func TestWorkTraceStreamNeverDeliversOtherDialogueOnReplay(t *testing.T) {
	srv := newTraceTestServer(t)
	ctx := context.Background()
	// Persist rows for both dialogues BEFORE the stream connects.
	for i := 0; i < 2; i++ {
		if _, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_A", Type: string(model.WorkTraceIntent), PayloadJSON: `{"a":true}`,
		}); err != nil {
			t.Fatalf("append A: %v", err)
		}
		if _, err := srv.store.AppendDialogueTrace(ctx, model.WorkTraceEvent{
			DialogueID: "dlg_B", Type: string(model.WorkTraceIntent), PayloadJSON: `{"b":true}`,
		}); err != nil {
			t.Fatalf("append B: %v", err)
		}
	}

	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)
	br := openTraceStream(t, ts, "/api/dialogues/dlg_A/work-trace/stream", "")

	// The two A replay rows must arrive; no B row must ever leak.
	deadline := time.After(3 * time.Second)
	got := 0
	for got < 2 {
		evCh := make(chan struct {
			dataLine string
			err      error
		}, 1)
		go func() {
			_, _, dl, rerr := readSSEEvent(t, br)
			evCh <- struct {
				dataLine string
				err      error
			}{dl, rerr}
		}()
		select {
		case ev := <-evCh:
			if ev.err != nil {
				t.Fatalf("read error: %v", ev.err)
			}
			if strings.Contains(ev.dataLine, `"dlg_B"`) || strings.Contains(ev.dataLine, `"b":true`) {
				t.Fatalf("other dialogue leaked during replay: %s", ev.dataLine)
			}
			if strings.Contains(ev.dataLine, `"dlg_A"`) || strings.Contains(ev.dataLine, `"a":true`) {
				got++
			}
		case <-deadline:
			t.Fatalf("timeout: only %d/2 A replay rows arrived", got)
		}
	}
}
