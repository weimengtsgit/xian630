package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// safeToolNames is the allowlist of Claude tool_use names that become activity
// records. Bash is absent by design (it is disallowed via --disallowedTools, and
// even if a tool_use for it appeared it would NOT be recorded as activity — the
// factory runs npm/podman itself). Unknown tools are ignored, never recorded.
var safeToolNames = map[string]bool{
	"Read":  true,
	"Grep":  true,
	"Glob":  true,
	"Edit":  true,
	"Write": true,
}

// streamClaudeEvents parses one chunk of claude stream-json stdout (which may
// contain zero, one, or several newline-delimited JSON objects, or a partial
// trailing line) and emits an activity record for each SAFE tool_use event.
//
// Hidden-reasoning policy: only the top-level "type" is consulted to dispatch,
// and only tool_use events are decoded further. thinking, reasoning,
// thinking_delta, and every other provider-private event type are IGNORED —
// their JSON is never fully decoded into a Go struct, so a hidden field can
// never reach a record. The tool_use input is reduced to a single redacted
// relative file_path before it is recorded; the full input (which may carry
// command text, file contents, etc.) is NOT recorded.
//
// A chunk that is not a complete JSON object (a partial line flushed by the
// streaming pipe) is silently dropped — the next chunk completes it. This keeps
// the parser robust to arbitrary pipe buffering.
func streamClaudeEvents(ctx context.Context, emit StepRecordEmitter, chunk string) {
	if emit == nil {
		return
	}
	for _, line := range strings.Split(chunk, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		emitToolUseActivity(ctx, emit, line)
	}
}

// claudeStreamEvent is the minimal projection of one stream-json line needed to
// decide whether it is a safe tool_use. Only "type" is decoded first; the
// tool_use branch then decodes name + a NARROW slice of input. Any other field
// the provider adds (thinking, reasoning, partial messages, etc.) is ignored
// because it is not in this struct.
type claudeStreamEvent struct {
	Type string `json:"type"`
	// Only present on tool_use events.
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`
}

// toolUseActivityRedacter rewrites an absolute or workspace-rooted path in a
// tool_use input down to a safe relative path. It strips a leading workspace
// root and any parent-directory traversal, so the recorded activity never leaks
// the developer's home directory or absolute repo path. This mirrors the
// executor's redactExecutionText philosophy: record the SHAPE of activity, not
// secrets or absolute paths.
func toolUseActivityContent(name string, input map[string]any) string {
	if input == nil {
		return name
	}
	// file_path is the conventional key for Read/Edit/Write; Grep/Glob use
	// path/pattern. Prefer file_path, then path, then pattern.
	for _, key := range []string{"file_path", "path", "pattern"} {
		if v, ok := input[key].(string); ok && v != "" {
			return name + " " + redactPath(v)
		}
	}
	return name
}

// redactPath reduces an absolute or workspace-rooted path to its relative form.
// It strips a leading slash, any drive letter, and resolves "." / ".." segments
// so the result is always a clean relative path. Absolute home/repo paths never
// reach a record.
func redactPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	// Drop Windows drive letter (C:\) and leading slashes — record relative.
	p = strings.TrimPrefix(p, "/")
	if len(p) >= 2 && p[1] == ':' && (p[0] == 'C' || p[0] == 'c') {
		p = p[2:]
		p = strings.TrimPrefix(p, "\\")
	}
	p = strings.TrimPrefix(p, "/")
	// Collapse any ".." segments — the recorded path must never escape.
	clean := make([]string, 0)
	for _, seg := range strings.Split(p, string(filepath.Separator)) {
		switch seg {
		case "", ".":
			// skip
		case "..":
			// drop — never let a parent ref into a record
		default:
			clean = append(clean, seg)
		}
	}
	return strings.Join(clean, "/")
}

// emitToolUseActivity decodes one JSON line and, if it is a safe tool_use,
// emits one activity record with a redacted relative path. It swallows decode
// errors: a malformed stream-json line is a transport hiccup, not a step
// failure, and the run continues. This is the chokepoint that guarantees hidden
// reasoning cannot leak: only tool_use is decoded, and only its name + a
// redacted path are recorded.
func emitToolUseActivity(ctx context.Context, emit StepRecordEmitter, line string) {
	var ev claudeStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return
	}
	if ev.Type != "tool_use" {
		return
	}
	if !safeToolNames[ev.Name] {
		return
	}
	_ = emit.Emit(ctx, model.ExecutionRecordActivity, toolUseActivityContent(ev.Name, ev.Input))
}

// extractStreamResult scans stream-json NDJSON stdout and returns the `result`
// field of the final type=result event — the agent's final public answer. For
// the freeze/design/codegen stages that string IS the output.json contract
// (codegen writes its own output.json, so this path is a no-op there via the
// absent-file guard in the caller).
//
// Why this exists (F2): Task 3 switched every stage to
// `--output-format stream-json --include-partial-messages --verbose`. With those
// flags stdout is NDJSON — one JSON event per line (system, assistant, thinking,
// tool_use, ..., ending with a type=result event). The read-only stages
// (requirement_analysis, solution_design) run in plan mode and cannot write
// output.json themselves, so ClaudeRunner.Run falls back to writing res.Stdout
// verbatim. The lenient decoder (extractJSONObject) then grabs the FIRST `{`,
// which is a system/assistant ENVELOPE, not the contract — breaking validation
// with schema_validation_failed/output_invalid_json. extractStreamResult instead
// walks every line, keeps the LAST type=result event, and returns its `result`
// string, which IS the agent's final public answer.
//
// Hidden-reasoning policy (F3 boundary): only the top-level "type" and the
// "result" field of a type=result event are decoded. thinking, thinking_delta,
// assistant, tool_use, and every other provider-private event type are NOT
// decoded beyond their type — their bodies never reach the returned string.
// Returns "" if no type=result event is present (error/truncated run); the
// caller's `if out != ""` guard then skips the output.json write so validation
// surfaces output_missing instead of garbage.
func extractStreamResult(stdout string) string {
	var last string
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var ev claudeResultEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue // a malformed/partial line is a transport hiccup, not fatal
		}
		if ev.Type == "result" {
			last = ev.Result
		}
	}
	return last
}

// claudeResultEvent is the minimal projection of one stream-json line needed to
// extract the final result. Only "type" and "result" are decoded; thinking,
// reasoning, and every other field the provider might add are NOT in this struct
// so json.Unmarshal drops them (the hidden-reasoning boundary).
type claudeResultEvent struct {
	Type   string `json:"type"`
	Result string `json:"result"`
}

// DecodeWorkLog reads output.json and returns the PUBLIC workLog entries the
// agent authored. workLog is the ONLY agent-authored field that becomes summary
// records. The decoder struct (workLogEnvelope) models ONLY workLog + content —
// thinking, reasoning, and every other field the provider might add are NOT in
// the struct, so json.Unmarshal drops them. A missing/empty/unparseable workLog
// yields nil; this is best-effort and never fails the step.
//
// The envelope deliberately lives here (not in contracts.go's stage decoders)
// because workLog decoding into records is a RECORD concern, not a contract
// validation concern: the validators already decode their own stage struct
// leniently and ignore workLog; this decoder is the narrow path that lifts ONLY
// workLog into records.
func DecodeWorkLog(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	payload := extractJSONObject(string(raw))
	var env workLogEnvelope
	if err := json.Unmarshal([]byte(payload), &env); err != nil {
		return nil
	}
	out := make([]string, 0, len(env.WorkLog))
	for _, e := range env.WorkLog {
		if c := strings.TrimSpace(e.Content); c != "" {
			out = append(out, truncateUTF8(c, maxWorkLogEntryBytes))
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// workLogEnvelope models ONLY the public workLog field. Adding any other field
// here would risk lifting a hidden provider field into records; this struct is
// intentionally minimal.
type workLogEnvelope struct {
	WorkLog []struct {
		Content string `json:"content"`
	} `json:"workLog"`
}

// maxWorkLogEntryBytes caps a single workLog summary record so a runaway agent
// cannot emit an unbounded summary. 4 KiB mirrors the command-chunk cap.
const maxWorkLogEntryBytes = 4 * 1024

// truncateUTF8 trims s to at most max bytes on a UTF-8 rune boundary so the
// retained prefix is always valid UTF-8.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
