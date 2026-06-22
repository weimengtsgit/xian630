package runner

import (
	"context"
	"encoding/json"
	"fmt"
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
// trailing line) and emits the records the drawer renders:
//
//   - thinking / thinking_delta → thinking records. 方案 B relaxes the old
//     "ignore all hidden reasoning" policy: the model's reasoning IS now shown.
//     Each thought is still redacted at the stepEmitter chokepoint before
//     persist+SSE, so a credential the model reasons about is masked. Chunked to
//     ≤4 KiB so a long trace becomes browsable records, not one giant blob.
//   - tool_use Write/Edit → file_delta records ("新建 src/App.jsx +142" /
//     "编辑 src/App.jsx +12 -5") computed from the tool input, so the drawer
//     shows the live per-file code-generation progress like Claude Code / Codex.
//   - tool_use Read/Grep/Glob → activity records with a redacted relative path.
//     Non-allowlisted tools (WebSearch, …) and Bash are ignored.
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
		emitStreamLine(ctx, emit, line)
	}
}

// claudeStreamEvent is the minimal projection of ONE real Claude Code CLI
// stream-json line. Verified against a live capture (code_generation
// attempt-1/stdout.log, CLI v2.1.181): each line is a top-level NDJSON object
// whose "type" is one of system / assistant / user / result / stream_event.
// Only "assistant" turns carry the content blocks we render, and they are
// NESTED under message.content[] (NOT top-level): a thinking block
// {type:"thinking",thinking:"…"}, a tool_use block
// {type:"tool_use",name:"Write|Edit|Read",input:{file_path,…}}, or a text
// block {type:"text",text:"…"}. stream_event (--include-partial-messages
// partials), system (hooks/init), and user (tool results) are ignored — we
// render complete turns only, which carry the full thinking text + full
// tool_use input (so file deltas are accurate) and still stream in live as the
// agent works turn by turn. Any field absent from these structs is dropped by
// json.Unmarshal.
type claudeStreamEvent struct {
	Type    string `json:"type"`
	Message struct {
		Content []contentBlock `json:"content"`
	} `json:"message"`
}

// contentBlock is one block inside an assistant turn's message.content[]. Only
// the fields the drawer consumes are modeled.
type contentBlock struct {
	Type     string         `json:"type"`     // thinking | text | tool_use
	Thinking string         `json:"thinking"` // type=thinking (方案 B)
	Text     string         `json:"text"`     // type=text
	Name     string         `json:"name"`     // type=tool_use
	Input    map[string]any `json:"input"`    // type=tool_use
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

// repoPathAnchors are repo-rooted directory prefixes. When a tool path contains
// one, redactPath keeps from that anchor onward so the recorded path is
// repo-relative (e.g. generated-apps/<slug>/src/App.jsx) instead of leaking the
// operator's absolute home/repo path. A live capture showed the model emitting
// absolute paths like /Users/<name>/…/xian630/generated-apps/…; the old
// leading-slash-only strip turned that into Users/<name>/…/xian630/generated-apps/…
// — still leaking the full local path. Anchoring on the known repo dirs makes
// the recorded path both safe and short.
var repoPathAnchors = []string{
	"generated-apps/", ".factory-runs/", ".claude/", "scene/",
	"factory-server/", "cc-status/", "docs/",
}

// redactPath reduces an absolute or workspace-rooted path to a clean relative
// form. It prefers anchoring on a known repo directory (so the result is
// repo-relative and never carries the home/absolute prefix); otherwise it strips
// a leading slash / drive letter. In all cases it drops "." / ".." segments so a
// parent-directory reference can never reach a record.
func redactPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	p = filepath.ToSlash(p)
	for _, anchor := range repoPathAnchors {
		if i := strings.Index(p, anchor); i >= 0 {
			return cleanRelPath(p[i:])
		}
	}
	// No known anchor: strip a leading slash / drive letter, then clean segments.
	p = strings.TrimPrefix(p, "/")
	if len(p) >= 2 && p[1] == ':' && (p[0] == 'C' || p[0] == 'c') {
		p = p[2:]
		p = strings.TrimPrefix(p, "/")
	}
	return cleanRelPath(p)
}

// cleanRelPath drops empty / "." / ".." segments so a recorded path can never
// escape via parent-directory references.
func cleanRelPath(p string) string {
	clean := make([]string, 0)
	for _, seg := range strings.Split(p, "/") {
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

// emitStreamLine decodes one real CLI stream-json line and emits the records
// the drawer renders. Only "assistant" turns are decoded further — their
// message.content[] blocks become records (verified against a live capture):
//
//   - thinking block → thinking record(s) (方案 B: hidden reasoning now shown;
//     still redacted at the stepEmitter chokepoint). Chunked to ≤4 KiB.
//   - tool_use Write/Edit → file_delta record ("新建 src/App.jsx +142" /
//     "编辑 src/App.jsx +12 -5") computed from the input, for live per-file
//     code-generation progress.
//   - tool_use Read/Grep/Glob → activity record with a redacted relative path.
//     Non-allowlisted tools and Bash are ignored.
//
// It swallows decode errors: a malformed line is a transport hiccup, not a step
// failure.
func emitStreamLine(ctx context.Context, emit StepRecordEmitter, line string) {
	var ev claudeStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return
	}
	if ev.Type != "assistant" {
		return
	}
	for _, b := range ev.Message.Content {
		switch b.Type {
		case "tool_use":
			switch b.Name {
			case "Write", "Edit":
				if d, ok := computeFileDelta(b.Name, b.Input); ok {
					_ = emit.Emit(ctx, model.ExecutionRecordFileDelta, d.content())
				}
			default:
				if safeToolNames[b.Name] {
					_ = emit.Emit(ctx, model.ExecutionRecordActivity, toolUseActivityContent(b.Name, b.Input))
				}
			}
		}
	}
}

// maxThinkingChunkBytes caps a single thinking record so a long reasoning trace
// is split into browsable chunks rather than one giant blob. 4 KiB mirrors the
// command-chunk cap.
const maxThinkingChunkBytes = 4 * 1024

// emitThinking emits the model's thinking text as one or more thinking records,
// each ≤ maxThinkingChunkBytes on a UTF-8 rune boundary. Empty text is a no-op.
func emitThinking(ctx context.Context, emit StepRecordEmitter, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	for len(text) > 0 {
		chunk := truncateUTF8(text, maxThinkingChunkBytes)
		_ = emit.Emit(ctx, model.ExecutionRecordThinking, chunk)
		text = text[len(chunk):]
	}
}

// fileDelta is the +added/-removed change to one file, derived from a Write/Edit
// tool_use input. path is redacted to a relative form.
type fileDelta struct {
	path    string
	added   int
	removed int
}

// content renders the delta as a single drawer line: "新建 <path> +N" for a
// Write (new file, no removals) or "编辑 <path> +A -B" for an Edit.
func (d fileDelta) content() string {
	if d.removed > 0 {
		return fmt.Sprintf("编辑 %s  +%d -%d", d.path, d.added, d.removed)
	}
	return fmt.Sprintf("新建 %s  +%d", d.path, d.added)
}

// computeFileDelta derives the file_delta for a Write/Edit tool_use, using the
// REAL CLI tool input shape (verified against a live capture): Write input is
// {file_path, content}; Edit input is {file_path, old_string, new_string}.
// Write: added = line count of content, removed = 0. Edit: added = new_string
// lines, removed = old_string lines. ok=false when there is no file_path or the
// tool is neither Write nor Edit.
func computeFileDelta(name string, input map[string]any) (fileDelta, bool) {
	if input == nil {
		return fileDelta{}, false
	}
	path, ok := inputString(input, "file_path")
	if !ok || path == "" {
		return fileDelta{}, false
	}
	d := fileDelta{path: redactPath(path)}
	switch name {
	case "Write":
		if c, ok := inputString(input, "content"); ok {
			d.added = countLines(c)
		}
	case "Edit":
		if o, ok := inputString(input, "old_string"); ok {
			d.removed = countLines(o)
		}
		if n, ok := inputString(input, "new_string"); ok {
			d.added = countLines(n)
		}
	default:
		return fileDelta{}, false
	}
	return d, true
}

// countLines returns the number of lines in s: newline count, +1 when the final
// line has no trailing newline. Empty string is 0 lines.
func countLines(s string) int {
	if s == "" {
		return 0
	}
	n := strings.Count(s, "\n")
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

// inputString returns the string value of input[key]; ok=false if absent or not
// a string.
func inputString(input map[string]any, key string) (string, bool) {
	if v, ok := input[key]; ok {
		if s, ok := v.(string); ok {
			return s, true
		}
	}
	return "", false
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
	// A live capture shows the model sometimes wraps its final JSON answer in a
	// markdown code fence ("```json\n{…}\n```"). Writing that verbatim to
	// output.json breaks json.Unmarshal validation, so strip a fence that wraps
	// the WHOLE result before returning.
	return stripCodeFences(last)
}

// stripCodeFences removes a single surrounding markdown code fence (```lang …
// ```) that wraps the entire string. It only acts when the string STARTS with
// ```, so a fenced snippet inside prose is left intact.
func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	// Drop the opening fence line ("```" or "```json", …).
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[i+1:]
	} else {
		return s
	}
	s = strings.TrimSpace(s)
	if strings.HasSuffix(s, "```") {
		s = strings.TrimSuffix(s, "```")
	}
	return strings.TrimSpace(s)
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
