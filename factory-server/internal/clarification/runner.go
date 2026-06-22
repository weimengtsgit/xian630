package clarification

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

type Runner struct {
	Cmd           runner.CommandRunner
	Binary        string
	WorkspaceRoot string
	ArtifactRoot  string
}

type streamCommandRunner interface {
	RunStream(ctx context.Context, dir string, name string, onStdoutLine func(string), args ...string) (runner.CommandResult, error)
}

func (r Runner) RunRound(ctx context.Context, input RoundInput, emit func(StreamEvent)) (RoundOutput, error) {
	dir := filepath.Join(r.artifactRoot(), "clarifications", input.SessionID, fmt.Sprintf("round-%d", input.Round))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return RoundOutput{}, err
	}
	absInput, err := filepath.Abs(filepath.Join(dir, "input.json"))
	if err != nil {
		return RoundOutput{}, fmt.Errorf("resolve input path: %w", err)
	}
	in, err := json.MarshalIndent(input, "", "  ")
	if err != nil {
		return RoundOutput{}, fmt.Errorf("encode clarification input: %w", err)
	}
	if err := os.WriteFile(absInput, in, 0o644); err != nil {
		return RoundOutput{}, err
	}
	prompt := r.prompt(absInput)
	if err := os.WriteFile(filepath.Join(dir, "prompt.md"), []byte(prompt), 0o644); err != nil {
		return RoundOutput{}, err
	}
	// NOTE on argument order: `claude --print` (v2.1.179) treats trailing
	// positionals AFTER the --flags as additional tool-deny tokens, not as the
	// prompt — reproducing the original "Input must be provided..." error. The
	// prompt MUST be the FIRST positional argument, before any --* options.
	// Verified live: claude --print "<prompt>" --permission-mode plan ... works;
	// claude --print ... --disallowedTools X "<prompt>" does not.
	res, assistantText, streamed, err := r.runClaude(ctx, input, prompt, emit)
	_ = os.WriteFile(filepath.Join(dir, "stdout.log"), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "stderr.log"), []byte(res.Stderr), 0o644)
	if err != nil {
		return RoundOutput{}, fmt.Errorf("claude run: %w", err)
	}
	if res.ExitCode != 0 {
		return RoundOutput{}, fmt.Errorf("claude exit %d: %w", res.ExitCode, runner.ErrRunnerExitNonzero)
	}
	if strings.TrimSpace(assistantText) == "" {
		assistantText = res.Stdout
	}
	extracted := extractJSONObject(assistantText)
	var out RoundOutput
	if err := json.Unmarshal([]byte(extracted), &out); err != nil {
		return RoundOutput{}, fmt.Errorf("decode clarification output: %v: %w", err, runner.ErrOutputInvalidJSON)
	}
	out = normalizeRoundOutput(out)
	outBytes, _ := json.MarshalIndent(out, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "output.json"), outBytes, 0o644); err != nil {
		return RoundOutput{}, err
	}
	events := normalizeEvents(input.SessionID, out, normalizeOptions{SkipWorkLogs: streamed})
	if err := writeStream(filepath.Join(dir, "stream.jsonl"), events); err != nil {
		return RoundOutput{}, err
	}
	for _, ev := range events {
		emit(ev)
	}
	return out, nil
}

func (r Runner) runClaude(ctx context.Context, input RoundInput, prompt string, emit func(StreamEvent)) (runner.CommandResult, string, bool, error) {
	if sr, ok := r.Cmd.(streamCommandRunner); ok {
		return r.runClaudeStream(ctx, sr, input, prompt, emit)
	}
	res, err := r.Cmd.Run(ctx, r.workspaceRoot(), r.binary(),
		"--print", prompt,
		"--permission-mode", "plan",
		"--allowedTools", "Read,Grep,Glob",
		"--disallowedTools", "Bash,Edit,Write")
	return res, res.Stdout, false, err
}

func (r Runner) runClaudeStream(ctx context.Context, sr streamCommandRunner, input RoundInput, prompt string, emit func(StreamEvent)) (runner.CommandResult, string, bool, error) {
	messageID := fmt.Sprintf("live_round_%d", input.Round)
	emit(StreamEvent{
		Type:      "clarification.message.started",
		SessionID: input.SessionID,
		MessageID: messageID,
		Data:      WorkLog{Type: "analysis_work_log", Content: "需求分析 agent 已连接 Claude Code 流式输出。"},
	})
	var assistantText strings.Builder
	var resultText string
	var lastVisible string
	res, err := sr.RunStream(ctx, r.workspaceRoot(), r.binary(), func(line string) {
		delta, result := parseClaudeStreamLine(line)
		if result != "" {
			resultText = result
		}
		if delta == "" {
			return
		}
		assistantText.WriteString(delta)
		visible := extractWorkLogStreamText(assistantText.String())
		if visible == "" || visible == lastVisible {
			return
		}
		lastVisible = visible
		emit(StreamEvent{
			Type:      "clarification.message.delta",
			SessionID: input.SessionID,
			MessageID: messageID,
			Delta:     visible,
		})
	},
		"--print", prompt,
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--permission-mode", "plan",
		"--allowedTools", "Read,Grep,Glob",
		"--disallowedTools", "Bash,Edit,Write")
	finalText := assistantText.String()
	if strings.TrimSpace(finalText) == "" {
		finalText = resultText
	}
	finalVisible := extractWorkLogStreamText(finalText)
	if finalVisible == "" {
		finalVisible = "结构化澄清结果接收完成，正在解析。"
	}
	emit(StreamEvent{
		Type:      "clarification.message.completed",
		SessionID: input.SessionID,
		MessageID: messageID,
		Data:      WorkLog{Type: "analysis_work_log", Content: finalVisible},
	})
	return res, finalText, true, err
}

func parseClaudeStreamLine(line string) (textDelta string, result string) {
	var top struct {
		Type   string          `json:"type"`
		Event  json.RawMessage `json:"event"`
		Result string          `json:"result"`
	}
	if err := json.Unmarshal([]byte(line), &top); err != nil {
		return "", ""
	}
	if top.Type == "result" {
		return "", top.Result
	}
	if top.Type != "stream_event" || len(top.Event) == 0 {
		return "", ""
	}
	var ev struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	}
	if err := json.Unmarshal(top.Event, &ev); err != nil {
		return "", ""
	}
	if ev.Type != "content_block_delta" || ev.Delta.Type != "text_delta" {
		return "", ""
	}
	return ev.Delta.Text, ""
}

func extractWorkLogStreamText(s string) string {
	workLogIdx := strings.Index(s, `"workLog"`)
	if workLogIdx < 0 {
		return ""
	}
	openRel := strings.IndexByte(s[workLogIdx:], '[')
	if openRel < 0 {
		return ""
	}
	segment := s[workLogIdx+openRel+1:]
	if end := strings.Index(segment, `"questions"`); end >= 0 {
		segment = segment[:end]
	}
	var parts []string
	for pos := 0; pos < len(segment); {
		idx := strings.Index(segment[pos:], `"content"`)
		if idx < 0 {
			break
		}
		pos += idx + len(`"content"`)
		colon := strings.IndexByte(segment[pos:], ':')
		if colon < 0 {
			break
		}
		pos += colon + 1
		for pos < len(segment) && (segment[pos] == ' ' || segment[pos] == '\n' || segment[pos] == '\t' || segment[pos] == '\r') {
			pos++
		}
		if pos >= len(segment) || segment[pos] != '"' {
			continue
		}
		value, next := parsePartialJSONString(segment, pos)
		if strings.TrimSpace(value) != "" {
			parts = append(parts, value)
		}
		if next <= pos {
			break
		}
		pos = next
	}
	return strings.Join(parts, "\n")
}

func parsePartialJSONString(s string, quotePos int) (string, int) {
	var b strings.Builder
	for i := quotePos + 1; i < len(s); {
		c := s[i]
		switch c {
		case '"':
			return b.String(), i + 1
		case '\\':
			if i+1 >= len(s) {
				return b.String(), len(s)
			}
			next := s[i+1]
			switch next {
			case '"', '\\', '/':
				b.WriteByte(next)
				i += 2
			case 'b':
				b.WriteByte('\b')
				i += 2
			case 'f':
				b.WriteByte('\f')
				i += 2
			case 'n':
				b.WriteByte('\n')
				i += 2
			case 'r':
				b.WriteByte('\r')
				i += 2
			case 't':
				b.WriteByte('\t')
				i += 2
			case 'u':
				if i+6 > len(s) {
					return b.String(), len(s)
				}
				n, err := strconv.ParseInt(s[i+2:i+6], 16, 32)
				if err != nil {
					return b.String(), i + 2
				}
				b.WriteRune(rune(n))
				i += 6
			default:
				b.WriteByte(next)
				i += 2
			}
		default:
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				return b.String(), len(s)
			}
			b.WriteRune(r)
			i += size
		}
	}
	return b.String(), len(s)
}

func (r Runner) prompt(inputPath string) string {
	return "Use .claude/skills/requirement-clarification/SKILL.md. " +
		fmt.Sprintf("The round input is at the absolute path %s — read it with the Read tool. ", inputPath) +
		"Output ONLY valid JSON matching the requirement clarification contract." +
		" Consult .claude/skills/requirement-clarification/blueprints.json for the 场景蓝本 catalog; when the user's intent matches a blueprint, populate requirement.blueprintRefs with the matching slug(s) and emit recommendedBlueprints cards. Blueprints are style/structure references only — never propose copying scene source."
}

type normalizeOptions struct {
	SkipWorkLogs bool
}

func normalizeEvents(sessionID string, out RoundOutput, opts ...normalizeOptions) []StreamEvent {
	var opt normalizeOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	events := []StreamEvent{}
	if !opt.SkipWorkLogs {
		for i, wl := range out.WorkLog {
			id := fmt.Sprintf("worklog_%d", i+1)
			events = append(events,
				StreamEvent{Type: "clarification.message.started", SessionID: sessionID, MessageID: id, Data: wl},
				StreamEvent{Type: "clarification.message.delta", SessionID: sessionID, MessageID: id, Delta: wl.Content},
				StreamEvent{Type: "clarification.message.completed", SessionID: sessionID, MessageID: id, Data: wl},
			)
		}
	}
	for _, q := range out.Questions {
		events = append(events, StreamEvent{Type: "clarification.question.created", SessionID: sessionID, Data: q})
	}
	events = append(events, StreamEvent{Type: "clarification.summary.updated", SessionID: sessionID, Data: out.Requirement})
	if len(out.RecommendedBlueprints) > 0 {
		events = append(events, StreamEvent{
			Type:      "clarification.blueprint.recommended",
			SessionID: sessionID,
			Data:      out.RecommendedBlueprints,
		})
	}
	if IsReadyToConfirmStatus(out.Status) {
		events = append(events, StreamEvent{Type: "clarification.ready_to_confirm", SessionID: sessionID, Data: out.Requirement})
	}
	return events
}

func normalizeRoundOutput(out RoundOutput) RoundOutput {
	if IsReadyToConfirmStatus(out.Status) {
		out.Status = "ready_to_confirm"
	}
	for i := range out.Questions {
		q := &out.Questions[i]
		if len(q.Recommendation) > 1 {
			q.MultiSelect = true
		}
		for j := range q.Options {
			if q.Recommendation.Contains(q.Options[j].Value) {
				q.Options[j].Recommended = true
			}
		}
	}
	return out
}

func writeStream(path string, events []StreamEvent) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, ev := range events {
		b, _ := json.Marshal(ev)
		if _, err := w.Write(append(b, '\n')); err != nil {
			return err
		}
	}
	return w.Flush()
}

// extractJSONObject returns the substring of s spanning the outermost balanced {...}
// object, tolerating markdown fences (```json … ```) and surrounding prose. If no
// balanced object is found, it returns s unchanged so json.Unmarshal produces the
// usual error.
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	// strip a leading ```lang fence and trailing ```
	if strings.HasPrefix(s, "```") {
		// drop the opening fence line
		if nl := strings.IndexByte(s, '\n'); nl >= 0 {
			s = strings.TrimSpace(s[nl+1:])
		}
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
		s = strings.TrimSpace(s)
	}
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return s
	}
	// find the matching closing brace by depth counting over the string from start
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return s[start:] // unbalanced; let json.Unmarshal report the error
}

func (r Runner) binary() string {
	if r.Binary == "" {
		return "claude"
	}
	return r.Binary
}

func (r Runner) workspaceRoot() string {
	if r.WorkspaceRoot == "" {
		return "."
	}
	return r.WorkspaceRoot
}

func (r Runner) artifactRoot() string {
	if r.ArtifactRoot == "" {
		return ".factory-runs"
	}
	return r.ArtifactRoot
}
