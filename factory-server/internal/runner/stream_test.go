package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// recordEmitter captures every Emit call so a test can assert which records
// were produced (and verify hidden reasoning never appears). It also implements
// TraceEmitter so streamClaudeEvents' trace production can be asserted in tests.
type recordEmitter struct {
	records []recordEntry
	traces  []traceEntry
}

type recordEntry struct {
	kind    model.ExecutionRecordKind
	content string
}

// traceEntry captures one Trace call: the trace TYPE and its payload.
type traceEntry struct {
	traceType string
	payload   string
}

func (r *recordEmitter) Emit(_ context.Context, kind model.ExecutionRecordKind, content string) error {
	r.records = append(r.records, recordEntry{kind: kind, content: content})
	return nil
}

// Trace records a trace event for later assertion.
func (r *recordEmitter) Trace(_ context.Context, traceType, payload string) error {
	r.traces = append(r.traces, traceEntry{traceType: traceType, payload: payload})
	return nil
}

func (r *recordEmitter) traceOfType(t string) (traceEntry, bool) {
	for _, e := range r.traces {
		if e.traceType == t {
			return e, true
		}
	}
	return traceEntry{}, false
}

func (r *recordEmitter) tracePayloadContaining(substr string) bool {
	for _, e := range r.traces {
		if strings.Contains(e.payload, substr) {
			return true
		}
	}
	return false
}

func (r *recordEmitter) hasKind(k model.ExecutionRecordKind) bool {
	for _, e := range r.records {
		if e.kind == k {
			return true
		}
	}
	return false
}

func (r *recordEmitter) contentContaining(substr string) bool {
	for _, e := range r.records {
		if strings.Contains(e.content, substr) {
			return true
		}
	}
	return false
}

// TestStreamClaudeEventsDropsThinkingAndCapturesFileDeltas feeds the parser a REAL
// CLI stream-json shape (verified against a live code_generation capture: each
// event is a top-level NDJSON object; content blocks are NESTED inside
// assistant.message.content[]) and asserts the hidden-reasoning security
// boundary (Constraint #9):
//   - thinking blocks never become a record or trace (without a task-thinking
//     emitter this helper drops them via NopTaskThinkingEmitter);
//   - Write/Edit tool_use blocks become file_delta records (+N / +A -B);
//   - Read/Grep/Glob become activity records with a redacted RELATIVE path;
//   - non-allowlisted tools (WebSearch) and system events are ignored.
func TestStreamClaudeEventsDropsThinkingAndCapturesFileDeltas(t *testing.T) {
	emit := &recordEmitter{}
	stream := strings.Join([]string{
		// 1. system init — ignored (not an assistant turn).
		`{"type":"system","subtype":"init","session_id":"abc"}`,
		// 2. assistant turn with a thinking block (no task-thinking emitter in this
		//    helper, so it is dropped by NopTaskThinkingEmitter).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"THINKING_CANARY"}]}}`,
		// 3. assistant turn with a Read tool_use on an ABSOLUTE path → activity,
		//    path redacted to a RELATIVE form (no leading /, no home dir).
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/repo/generated-apps/demo/src/App.jsx"}}]}}`,
		// 4. assistant turn with a Write tool_use → file_delta "新建 … +N".
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Write","input":{"file_path":"/abs/repo/generated-apps/demo/src/index.html","content":"<!doctype html>\n<html>\n</html>"}}]}}`,
		// 5. assistant turn with an Edit tool_use → file_delta "编辑 … +A -B".
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/abs/repo/generated-apps/demo/src/App.jsx","old_string":"a\nb","new_string":"a\nb\nc\nd"}}]}}`,
		// 6. assistant turn with a non-allowlisted tool (WebSearch) → ignored.
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"WebSearch","input":{"query":"how to"}}]}}`,
		// 7. a partial line (no closing brace) — dropped, not decoded.
		`{"type":"assistant","message":{"content":[{`,
		"",
	}, "\n")
	streamClaudeEvents(context.Background(), emit, stream)

	// Thinking records must NEVER be produced (Constraint #9 security boundary).
	if emit.hasKind(model.ExecutionRecordThinking) {
		t.Errorf("thinking record leaked; records=%#v", emit.records)
	}
	if emit.contentContaining("THINKING_CANARY") {
		t.Errorf("thinking text leaked into a record; records=%#v", emit.records)
	}
	// Thinking must not reach the trace path either.
	for _, e := range emit.traces {
		if strings.Contains(e.payload, "THINKING_CANARY") {
			t.Errorf("thinking leaked into a trace payload: %+v", e)
		}
	}

	// Write → file_delta with +N, no " -" minus marker.
	writeDelta := findFileDelta(emit, "新建")
	if writeDelta == "" {
		t.Fatalf("no Write file_delta; records=%#v", emit.records)
	}
	if !strings.Contains(writeDelta, " +") || strings.Contains(writeDelta, " -") {
		t.Errorf("Write file_delta should be +N only: %q", writeDelta)
	}

	// Edit → file_delta with +A -B (both markers present).
	editDelta := findFileDelta(emit, "编辑")
	if editDelta == "" {
		t.Fatalf("no Edit file_delta; records=%#v", emit.records)
	}
	if !strings.Contains(editDelta, " +") || !strings.Contains(editDelta, " -") {
		t.Errorf("Edit file_delta should be +A -B: %q", editDelta)
	}

	// Read → activity with a RELATIVE redacted path.
	foundReadActivity := false
	for _, e := range emit.records {
		if e.kind == model.ExecutionRecordActivity && strings.HasPrefix(e.content, "Read ") {
			if strings.Contains(e.content, "/Users/") || strings.HasPrefix(e.content, "Read /") {
				t.Errorf("activity %q leaked absolute path", e.content)
			}
			if !strings.Contains(e.content, "generated-apps/demo/src/App.jsx") {
				t.Errorf("activity %q missing redacted relative path", e.content)
			}
			foundReadActivity = true
		}
	}
	if !foundReadActivity {
		t.Errorf("no Read activity record with redacted path; records=%#v", emit.records)
	}

	// WebSearch was NOT recorded (not in the allowlist).
	for _, e := range emit.records {
		if strings.Contains(e.content, "WebSearch") {
			t.Errorf("non-allowlisted tool leaked into record: %q", e.content)
		}
	}
}

// findFileDelta returns the first file_delta record content starting with prefix.
func findFileDelta(emit *recordEmitter, prefix string) string {
	for _, e := range emit.records {
		if e.kind == model.ExecutionRecordFileDelta && strings.HasPrefix(e.content, prefix) {
			return e.content
		}
	}
	return ""
}

// TestStreamClaudeEventsProducesSafeTraces is the Task 4 Step 1 fixture: a
// stream carrying assistant text, a safe tool_use, AND hidden thinking must
// produce a redacted observation trace (assistant_output) + a path-sanitized
// tool trace (tool.started), while NO thinking text ever reaches records or
// traces. This locks the producer side of the work-trace gate.
func TestStreamClaudeEventsProducesSafeTraces(t *testing.T) {
	emit := &recordEmitter{}
	stream := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"需要先确认阈值范围"}]}}`,
		`{"type":"tool_use","name":"Read","input":{"file_path":"src/rules.ts"}}`,
		`{"type":"thinking","thinking":"private chain of thought"}`,
	}, "\n")
	streamClaudeEvents(context.Background(), emit, stream)

	// Assistant text → a redacted capped observation trace (assistant_output).
	obs, ok := emit.traceOfType(string(model.WorkTraceAssistant))
	if !ok {
		t.Fatalf("no assistant_output trace produced; traces=%#v", emit.traces)
	}
	if !strings.Contains(obs.payload, "需要先确认阈值范围") {
		t.Errorf("observation payload missing assistant text: %q", obs.payload)
	}

	// tool_use → a tool trace with the tool NAME + path-sanitized input.
	tool, ok := emit.traceOfType(string(model.WorkTraceTool))
	if !ok {
		t.Fatalf("no tool trace produced; traces=%#v", emit.traces)
	}
	if !strings.Contains(tool.payload, "Read") {
		t.Errorf("tool trace missing tool name: %q", tool.payload)
	}
	if !strings.Contains(tool.payload, "src/rules.ts") {
		t.Errorf("tool trace missing redacted relative path: %q", tool.payload)
	}

	// HARD SECURITY: thinking must NEVER reach a record or a trace.
	if emit.contentContaining("private chain of thought") {
		t.Errorf("thinking leaked into a record; records=%#v", emit.records)
	}
	if emit.tracePayloadContaining("private chain of thought") {
		t.Errorf("thinking leaked into a trace payload; traces=%#v", emit.traces)
	}
}

// TestStreamClaudeEventsStderrForwardsAsCommandStderr verifies the runStream
// path forwards each stderr line as a command_stderr record. We exercise it via
// the public ClaudeRunner.Run with a fake streamCommandRunner.
func TestStreamClaudeEventsStderrForwardsAsCommandStderr(t *testing.T) {
	emit := &recordEmitter{}
	fr := &fakeStreamRunner{
		stdout: `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/a.ts"}}]}}
{"type":"result","result":"{\"workLog\":[]}"}`,
		stderr: "warning: low disk\nerror: retrying\n",
	}
	r := ClaudeRunner{Runner: fr, Binary: "claude"}
	ws := newWS(t)
	if err := r.Run(context.Background(), ws, "P", nil, false, emit); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !emit.contentContaining("low disk") {
		t.Errorf("stderr 'low disk' not forwarded as command_stderr record; records=%#v", emit.records)
	}
	if !emit.contentContaining("retrying") {
		t.Errorf("stderr 'retrying' not forwarded; records=%#v", emit.records)
	}
	// stdout tool_use still parsed even on the streaming path.
	if !emit.hasKind(model.ExecutionRecordActivity) {
		t.Errorf("no activity record from streaming stdout; records=%#v", emit.records)
	}
}

// fakeStreamRunner implements streamCommandRunner for the streaming-path test.
type fakeStreamRunner struct {
	stdout string
	stderr string
}

func (f *fakeStreamRunner) Run(_ context.Context, dir string, name string, args ...string) (CommandResult, error) {
	return CommandResult{Stdout: f.stdout, ExitCode: 0}, nil
}

func (f *fakeStreamRunner) RunWithInput(_ context.Context, dir, input string, name string, args ...string) (CommandResult, error) {
	return CommandResult{Stdout: f.stdout, ExitCode: 0}, nil
}

func (f *fakeStreamRunner) RunStreamWithInput(_ context.Context, dir, input string, onStdout, onStderr func(string), name string, args ...string) (CommandResult, error) {
	for _, line := range strings.Split(strings.TrimRight(f.stdout, "\n"), "\n") {
		if onStdout != nil {
			onStdout(line)
		}
	}
	for _, line := range strings.Split(strings.TrimRight(f.stderr, "\n"), "\n") {
		if onStderr != nil {
			onStderr(line)
		}
	}
	return CommandResult{Stdout: f.stdout, Stderr: f.stderr, ExitCode: 0}, nil
}

// TestDecodeWorkLogLiftsOnlyPublicField verifies the workLog decoder reads ONLY
// the public workLog array and ignores a sibling "thinking" field. This locks
// the hidden-reasoning boundary at the decoder level: even if the provider
// emits thinking in the final result object, it never reaches a summary record.
func TestDecodeWorkLogLiftsOnlyPublicField(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output.json")
	// The output carries BOTH a public workLog AND a hidden thinking field.
	// DecodeWorkLog must return ONLY the workLog entries.
	doc := `{
	  "thinking":"HIDDEN_REASONING must never become a record",
	  "workLog":[
	    {"content":"public progress entry 1"},
	    {"content":"public progress entry 2"}
	  ],
	  "summary":"other field"
	}`
	if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	got := DecodeWorkLog(path)
	if len(got) != 2 {
		t.Fatalf("DecodeWorkLog = %#v, want 2 entries", got)
	}
	if got[0] != "public progress entry 1" || got[1] != "public progress entry 2" {
		t.Fatalf("DecodeWorkLog entries = %#v", got)
	}
	for _, e := range got {
		if strings.Contains(e, "HIDDEN_REASONING") {
			t.Errorf("hidden reasoning leaked into workLog entry: %q", e)
		}
	}
}

// TestExtractStreamResultReturnsFinalResultEvent is the F2 regression: with
// stream-json stdout, the raw stream is NDJSON (one event per line). The FIRST
// line is a system/assistant event, NOT the stage's output contract. Naively
// grabbing the first `{` (as ReadAndDecode/extractJSONObject does) therefore
// yields a stream envelope, breaking read-only stage validation. extractStreamResult
// must scan every line, keep the LAST type=result event, and return its `result`
// string — which IS the agent's final public answer (the output.json contract).
func TestExtractStreamResultReturnsFinalResultEvent(t *testing.T) {
	// A realistic read-only stage stream: system init, assistant text, hidden
	// thinking, a safe tool_use, and the final result whose `result` field is the
	// JSON contract as a STRING. The contract here is a requirement_analysis
	// freeze output (complete+supported) that ValidateRequirementAnalysis accepts.
	contract := `{"confirmedRequirementId":"clar_ok","summary":"frozen","appType":"timeline-replay","appName":"demo","generationProfile":{"base":["software-factory-app"]},"validation":{"complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[]}}`
	stream := strings.Join([]string{
		`{"type":"system","subtype":"init","session_id":"abc","tools":["Read","Grep"]}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Analyzing"}]}}`,
		`{"type":"thinking","thinking":"SECRET_REASONING the model's private chain of thought"}`,
		`{"type":"thinking_delta","thinking_delta":"more SECRET_PARTIAL reasoning"}`,
		`{"type":"tool_use","name":"Read","input":{"file_path":"scene/x/scene.md"}}`,
		// The final result: result is the JSON contract as a JSON-string value.
		`{"type":"result","subtype":"success","is_error":false,"result":` + jsonString(contract) + `,"total_cost_usd":0.01}`,
		"",
	}, "\n")

	got := extractStreamResult(stream)
	if got != contract {
		t.Fatalf("extractStreamResult =\n %q\nwant the contract string\n %q", got, contract)
	}
	// It must NOT be the first event (the system init envelope).
	if strings.HasPrefix(got, `{"type":"system"`) {
		t.Errorf("extractStreamResult returned the first stream event, not the final result")
	}
	// Hidden reasoning must never appear in the extracted result.
	if strings.Contains(got, "SECRET_REASONING") || strings.Contains(got, "SECRET_PARTIAL") {
		t.Errorf("extracted result leaked hidden reasoning: %q", got)
	}
}

// TestExtractStreamResultKeepsLastResultEvent confirms that when more than one
// result-bearing line exists (e.g. a streamed partial then the final), the LAST
// one wins — matching the documented "keep the LAST type=result" contract.
func TestExtractStreamResultKeepsLastResultEvent(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"result","result":"first"}`,
		`{"type":"assistant","message":{} }`,
		`{"type":"result","result":"second"}`,
	}, "\n")
	if got := extractStreamResult(stream); got != "second" {
		t.Fatalf("extractStreamResult = %q, want %q (last result)", got, "second")
	}
}

// TestExtractStreamResultEmptyWhenNoResultEvent confirms a truncated/errored run
// with no result event yields "" so the caller's `if out != ""` guard skips the
// output.json write (and validation surfaces output_missing instead of garbage).
func TestExtractStreamResultEmptyWhenNoResultEvent(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"assistant","message":{}}`,
		"",
	}, "\n")
	if got := extractStreamResult(stream); got != "" {
		t.Fatalf("extractStreamResult = %q, want empty for no result event", got)
	}
}

// TestExtractStreamResultStripsCodeFences confirms a result the model wrapped in
// a markdown code fence (observed in a live capture: "```json\n{…}\n```") is
// unwrapped before being returned, so writing it to output.json yields valid
// JSON for the stage validators.
func TestExtractStreamResultStripsCodeFences(t *testing.T) {
	stream := `{"type":"result","subtype":"success","result":` + jsonString("```json\n{\"a\":1}\n```") + `}`
	got := extractStreamResult(stream)
	if got != `{"a":1}` {
		t.Fatalf("extractStreamResult = %q, want {\"a\":1} (code fences stripped)", got)
	}
	// No fence → unchanged.
	if got := extractStreamResult(`{"type":"result","result":` + jsonString("{\"a\":1}") + `}`); got != `{"a":1}` {
		t.Fatalf("extractStreamResult altered an unfenced result: %q", got)
	}
}

// TestExtractStreamResultThenValidateRequirementAnalysis is the end-to-end F2
// proof: the extracted result, when written to output.json, must PASS a real
// stage validator (here requirement_analysis). This confirms the extraction
// yields a validatable contract, not a stream envelope. Without F2 the current
// code writes the raw NDJSON → validation fails (the test's RED precondition).
func TestExtractStreamResultThenValidateRequirementAnalysis(t *testing.T) {
	contract := `{"confirmedRequirementId":"clar_ok","summary":"frozen","appType":"timeline-replay","appName":"demo","generationProfile":{"base":["software-factory-app"]},"validation":{"complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[]}}`
	stream := strings.Join([]string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"thinking","thinking":"SECRET_REASONING"}`,
		`{"type":"tool_use","name":"Read","input":{"file_path":"scene/x/scene.md"}}`,
		`{"type":"result","subtype":"success","result":` + jsonString(contract) + `}`,
		"",
	}, "\n")
	extracted := extractStreamResult(stream)
	if extracted == "" {
		t.Fatalf("extractStreamResult returned empty for a stream with a result event")
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "output.json")
	if err := os.WriteFile(out, []byte(extracted), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateRequirementAnalysis(out); err != nil {
		t.Fatalf("ValidateRequirementAnalysis on extracted result failed: %v", err)
	}
}

// jsonString returns s as a JSON string literal (so we can embed a JSON document
// as the `result` field of a stream result event without hand-escaping).
func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// TestDecodeWorkLogAbsentIsNoOp verifies a missing workLog yields nil, not an
// error (the decoder is best-effort).
func TestDecodeWorkLogAbsentIsNoOp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output.json")
	_ = os.WriteFile(path, []byte(`{"summary":"no workLog here","thinking":"x"}`), 0o644)
	if got := DecodeWorkLog(path); got != nil {
		t.Fatalf("DecodeWorkLog = %#v, want nil for absent workLog", got)
	}
}

// capturingThinkingEmitter is a test double that captures Think calls.
type capturingThinkingEmitter struct {
	thoughts []string
}

func (c *capturingThinkingEmitter) Think(_ context.Context, content string) error {
	c.thoughts = append(c.thoughts, content)
	return nil
}

// TestClaudeStreamThinkingGoesOnlyToTaskThinkingEmitter verifies that both
// top-level thinking_delta events and nested assistant thinking blocks are routed
// to the TaskThinkingEmitter and never appear in records or traces.
func TestClaudeStreamThinkingGoesOnlyToTaskThinkingEmitter(t *testing.T) {
	records := &recordEmitter{}
	thinking := &capturingThinkingEmitter{}
	lines := []string{
		`{"type":"thinking_delta","thinking_delta":"private reasoning"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"nested reasoning"},{"type":"text","text":"public"}]}}`,
	}

	// Use the existing stream processing entry point.
	streamClaudeEventsWithThinking(context.Background(), records, thinking, strings.Join(lines, "\n"))

	if len(thinking.thoughts) != 2 || thinking.thoughts[0] != "private reasoning" || thinking.thoughts[1] != "nested reasoning" {
		t.Errorf("thinking emitter got %#v", thinking.thoughts)
	}
	for _, rec := range records.records {
		if strings.Contains(rec.content, "private reasoning") || strings.Contains(rec.content, "nested reasoning") {
			t.Fatalf("thinking leaked into execution record: %#v", rec)
		}
	}
	for _, tr := range records.traces {
		if strings.Contains(tr.payload, "private reasoning") || strings.Contains(tr.payload, "nested reasoning") {
			t.Fatalf("thinking leaked into work trace: %#v", tr)
		}
	}
}
