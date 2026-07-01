package clarification

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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
	absOutput, err := filepath.Abs(filepath.Join(dir, "output.json"))
	if err != nil {
		return RoundOutput{}, fmt.Errorf("resolve output path: %w", err)
	}
	in, err := json.MarshalIndent(input, "", "  ")
	if err != nil {
		return RoundOutput{}, fmt.Errorf("encode clarification input: %w", err)
	}
	if err := os.WriteFile(absInput, in, 0o644); err != nil {
		return RoundOutput{}, err
	}
	// 同一轮自动重试会复用 round 目录；运行前清掉旧 output.json，避免误读上一轮坏结果。
	_ = os.Remove(absOutput)
	prompt := r.promptText(absInput, absOutput)
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
	rawCandidates := []string{assistantText, res.Stdout}
	rawForRepair := strings.TrimSpace(assistantText + "\n" + res.Stdout)
	if raw, ok, rerr := readModelOutputFile(absOutput); rerr != nil {
		return RoundOutput{}, rerr
	} else if ok {
		// 文件契约比 stdout 更稳定；一旦文件存在，就只信文件内容，避免 stdout 说明文字污染解析。
		rawCandidates = []string{raw}
		rawForRepair = raw
	}
	out, err := decodeRoundOutput(rawCandidates...)
	if err != nil {
		if errors.Is(err, runner.ErrOutputInvalidJSON) {
			if repaired, ok := r.repairOutputJSON(ctx, input, absOutput, rawForRepair, err); ok {
				out, err = decodeRoundOutput(repaired)
			}
		}
	}
	if err != nil {
		return RoundOutput{}, err
	}
	out = normalizeRoundOutput(out)
	outBytes, _ := json.MarshalIndent(out, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "output.json"), outBytes, 0o644); err != nil {
		return RoundOutput{}, err
	}
	// A clarification round may return ZERO questions (ready) OR ALL open
	// high-impact questions at once so the user can answer them in a single
	// batch (the portal renders them as one question_group and the batch-answer
	// handler persists them together, then advances once). The D3 gate — not
	// this count — keeps ready_to_confirm withheld while openHighImpact is
	// non-empty, so batching does not let a high-impact item slip through.
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
	args := append([]string{
		"--print", prompt,
		"--permission-mode", "acceptEdits",
		"--allowedTools", "Read,Grep,Glob,Write",
		"--disallowedTools", "Bash,Edit",
	}, claudeModelArgs()...)
	runner.LLMConsoleRequest(fmt.Sprintf("clarification round %d", input.Round), r.binary(), args, prompt)
	res, err := r.Cmd.Run(ctx, r.workspaceRoot(), r.binary(), args...)
	// Non-streaming fallback: the captured stdout is still stream-json NDJSON,
	// so trace each line for parity with the streaming path.
	for _, line := range strings.Split(res.Stdout, "\n") {
		runner.LLMConsoleStreamLine(line)
	}
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
	var assistantThinking strings.Builder
	var resultText string
	var resultIsError bool
	var lastVisible string
	var lastVisibleThinking string
	args := append([]string{
		"--print", prompt,
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--permission-mode", "acceptEdits",
		"--allowedTools", "Read,Grep,Glob,Write",
		"--disallowedTools", "Bash,Edit",
	}, claudeModelArgs()...)
	runner.LLMConsoleRequest(fmt.Sprintf("clarification round %d", input.Round), r.binary(), args, prompt)
	res, err := sr.RunStream(ctx, r.workspaceRoot(), r.binary(), func(line string) {
		runner.LLMConsoleStreamLine(line)
		delta, thinking, result, isErr := parseClaudeStreamLine(line)
		if result != "" {
			resultText = result
			resultIsError = isErr
		}
		if delta != "" {
			assistantText.WriteString(delta)
			visible := extractWorkLogStreamText(assistantText.String())
			if visible != "" && visible != lastVisible {
				lastVisible = visible
				emit(StreamEvent{
					Type:      "clarification.message.delta",
					SessionID: input.SessionID,
					MessageID: messageID,
					Delta:     visible,
				})
			}
		}
		// Surface the model's raw reasoning (thinking_delta) as a parallel
		// clarification.message.thinking stream so the workbench renders a live
		// 思考过程 block. Set, not append (full-so-far), mirroring the .delta emit.
		if thinking != "" {
			assistantThinking.WriteString(thinking)
			visibleThinking := assistantThinking.String()
			if visibleThinking != "" && visibleThinking != lastVisibleThinking {
				lastVisibleThinking = visibleThinking
				emit(StreamEvent{
					Type:      "clarification.message.thinking",
					SessionID: input.SessionID,
					MessageID: messageID,
					Delta:     visibleThinking,
				})
			}
		}
	}, args...)
	finalText := assistantText.String()
	if strings.TrimSpace(finalText) == "" {
		finalText = resultText
	}
	finalVisible := extractWorkLogStreamText(finalText)
	if finalVisible == "" {
		// When the CLI surfaced an error (e.g. an upstream API 529 overloaded)
		// instead of a clarification document, show the real reason rather than
		// the optimistic "parsing" string — otherwise the bubble reads "正在解析"
		// right up until the session flips to "已失败", which looks like a parser
		// crash instead of a model-side failure.
		if notice := claudeErrorNotice(finalText, resultIsError); notice != "" {
			finalVisible = notice
		} else {
			finalVisible = "结构化澄清结果接收完成，正在解析。"
		}
	}
	emit(StreamEvent{
		Type:      "clarification.message.completed",
		SessionID: input.SessionID,
		MessageID: messageID,
		Data:      WorkLog{Type: "analysis_work_log", Content: finalVisible},
	})
	return res, finalText, true, err
}

func parseClaudeStreamLine(line string) (textDelta, thinkingDelta, result string, resultIsError bool) {
	var top struct {
		Type    string          `json:"type"`
		Event   json.RawMessage `json:"event"`
		Result  string          `json:"result"`
		IsError bool            `json:"is_error"`
	}
	if err := json.Unmarshal([]byte(line), &top); err != nil {
		return "", "", "", false
	}
	if top.Type == "result" {
		return "", "", top.Result, top.IsError
	}
	if top.Type != "stream_event" || len(top.Event) == 0 {
		return "", "", "", false
	}
	var ev struct {
		Type  string `json:"type"`
		Delta struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
	}
	if err := json.Unmarshal(top.Event, &ev); err != nil {
		return "", "", "", false
	}
	if ev.Type != "content_block_delta" {
		return "", "", "", false
	}
	if ev.Delta.Type == "thinking_delta" {
		return "", ev.Delta.Thinking, "", false
	}
	if ev.Delta.Type == "text_delta" {
		return ev.Delta.Text, "", "", false
	}
	return "", "", "", false
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

// claudeErrorNotice returns a user-facing Chinese notice when the Claude Code
// CLI returned an error (e.g. an upstream API 529 "overloaded") in lieu of a
// clarification document, so the failure reason is visible in the work-log
// bubble before the session transitions to "已失败". It keys off the result
// envelope's is_error flag (authoritative) and the CLI's "API Error" marker as a
// textual fallback. Returns "" for ordinary output — including a valid document
// that simply omits workLog — so the caller keeps its optimistic "正在解析"
// fallback in that case and does not misreport a successful round as failed.
func claudeErrorNotice(finalText string, resultIsError bool) string {
	t := strings.TrimSpace(finalText)
	if t == "" {
		return ""
	}
	if !resultIsError && !looksLikeClaudeError(t) {
		return ""
	}
	return "需求澄清失败：" + truncateNotice(t)
}

// looksLikeClaudeError detects a Claude Code CLI error surfaced as the assistant
// text/result, e.g. `API Error: 529 {"type":"error",...}`. The CLI prints
// upstream API failures with the literal "API Error" prefix; "overloaded_error"
// covers the Anthropic-style error type that some gateways pass through.
func looksLikeClaudeError(s string) bool {
	return strings.Contains(s, "API Error") ||
		strings.Contains(s, "overloaded_error")
}

// truncateNotice caps an error notice so a pathological blob cannot flood the
// work-log bubble; real CLI failures are short strings.
func truncateNotice(s string) string {
	const max = 500
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

func (r Runner) prompt(inputPath string) string {
	return "Use .claude/skills/requirement-clarification/SKILL.md. " +
		fmt.Sprintf("The round input is at the absolute path %s — read it with the Read tool. ", inputPath) +
		"Output ONLY valid JSON matching the adaptive requirement clarification contract. " +
		"SCOPE: this 业务逻辑 clarification settles BUSINESS LOGIC ONLY (业务目标、核心场景、角色/用户、业务规则、主要业务对象 mainEntities). Do NOT ask the user about INTERFACE design (primaryView/视图/布局/组件) or DATA sources (dataPolicy/数据来源/数据字段) — those are clarified in later stages (界面解析 / 数据抓取). If primaryView or dataPolicy are still empty at ready_to_confirm, leave them empty; the later stages fill them. " +
		"Emit ALL open high-impact questions in one round (rounds 1–4), each with 2–3 options, so the user confirms them in a single batch. " +
		"At round 5 (only if still incomplete) emit a consolidation list recommending a value for every remaining field. " +
		"Blueprints are an internal Factory reference — do not surface them in any user-facing output; never call a blueprint a template, never invent slugs. " +
		"When emitting the requirement (especially at the ready_to_confirm round), include a `description` field: a concise plain-Chinese paragraph detailing the confirmed requirement (覆盖目标、范围、关键能力), so the 确认需求摘要 carries a detailed explanation alongside the structured fields."
}

type normalizeOptions struct {
	SkipWorkLogs bool
}

// PublicRequirement projects a Requirement into its user-facing form, stripping
// the internal BlueprintRefs. It is the ONLY shape that may appear in a
// user-facing SSE event; the raw Requirement (with blueprintRefs) is retained
// on the persisted RoundOutput returned to the caller and written to
// output.json. Handlers in other packages MUST route every clarification /
// dialogue event payload through this helper rather than publishing the raw
// Requirement, which carries internal Factory blueprint slugs.
func PublicRequirement(r Requirement) requirementView {
	return requirementWithoutBlueprintRefs(r)
}

// requirementWithoutBlueprintRefs projects a Requirement into its user-facing
// form, stripping the internal BlueprintRefs. It is the ONLY shape that may
// appear in a user-facing SSE event; the raw Requirement (with blueprintRefs)
// is retained on the persisted RoundOutput returned to the caller and written
// to output.json. PublicRequirement is the exported alias used by handlers.
func requirementWithoutBlueprintRefs(r Requirement) requirementView {
	return requirementView{
		AppType:           r.AppType,
		AppName:           r.AppName,
		TargetUsers:       r.TargetUsers,
		CoreScenario:      r.CoreScenario,
		PrimaryView:       r.PrimaryView,
		MainEntities:      r.MainEntities,
		DataPolicy:        r.DataPolicy,
		AcceptanceFocus:   r.AcceptanceFocus,
		Description:       r.Description,
		JudgementBoundary: r.JudgementBoundary,
		GenerationProfile: r.GenerationProfile,
	}
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
	// Blueprints are internal server-side metadata (Requirement.BlueprintRefs).
	// They MUST NOT appear in any user-facing SSE event. Emit a projection that
	// omits the field entirely so it cannot leak by omission — the persisted
	// RoundOutput.Requirement (returned to the caller and written to output.json)
	// still carries blueprintRefs intact.
	events = append(events, StreamEvent{Type: "clarification.summary.updated", SessionID: sessionID, Data: requirementWithoutBlueprintRefs(out.Requirement)})
	// Adaptive: emit a consolidation event for the round-5 recommendation list.
	// Blueprints are no longer surfaced in any user-facing event (the
	// clarification.blueprint.recommended event has been removed); blueprints
	// are an internal Factory reference persisted only in requirement metadata.
	if len(out.Consolidation) > 0 {
		events = append(events, StreamEvent{
			Type:      "clarification.consolidation.updated",
			SessionID: sessionID,
			Data:      out.Consolidation,
		})
	}
	if IsReadyToConfirmStatus(out.Status) {
		events = append(events, StreamEvent{Type: "clarification.ready_to_confirm", SessionID: sessionID, Data: requirementWithoutBlueprintRefs(out.Requirement)})
	}
	return events
}

func normalizeRoundOutput(out RoundOutput) RoundOutput {
	if IsReadyToConfirmStatus(out.Status) {
		out.Status = "ready_to_confirm"
	}
	out.OpenHighImpact = normalizeHighImpact(out.OpenHighImpact)
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

// normalizeHighImpact validates and redacts the model's openHighImpact list,
// enforcing the user-facing contract (D3). Each item must have a non-empty id
// and label and at most 3 options, each option a non-empty value+label. Items
// or options that fail structural validation are dropped rather than failing the
// whole round (best-effort: a single malformed entry must not abort a usable
// round). Known internal blueprint/catalog slug patterns are best-effort
// excluded from id/label — the skill is instructed not to emit them, but the
// structural gate is the required one. An empty/nil input returns nil so the
// JSON field stays omitted.
func normalizeHighImpact(items []HighImpactItem) []HighImpactItem {
	if len(items) == 0 {
		return nil
	}
	out := make([]HighImpactItem, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, it := range items {
		id := strings.TrimSpace(it.ID)
		label := strings.TrimSpace(it.Label)
		if id == "" || label == "" {
			continue
		}
		if looksLikeInternalSlug(id) || looksLikeInternalSlug(label) {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		var opts []Option
		for _, opt := range it.Options {
			v := strings.TrimSpace(opt.Value)
			l := strings.TrimSpace(opt.Label)
			if v == "" || l == "" {
				continue
			}
			if looksLikeInternalSlug(v) {
				continue
			}
			opts = append(opts, Option{Value: v, Label: l, Reason: opt.Reason, Recommended: opt.Recommended})
		}
		if len(opts) > 3 {
			opts = opts[:3]
		}
		seen[id] = struct{}{}
		out = append(out, HighImpactItem{ID: id, Label: label, Recommendation: HighImpactRecommendation(strings.TrimSpace(string(it.Recommendation))), Options: opts})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// looksLikeInternalSlug is a best-effort guard that rejects values matching the
// factory's internal slug conventions (snake_case catalog/blueprint names such
// as software-factory-app or carrier-formation-replay). It is conservative: it
// only flags strings that contain a hyphen AND look like a slug (lowercase +
// hyphens/digits only, length >= 4) — plain user language like "数据策略" or
// "Mock 数据优先" is never matched. The skill is instructed not to emit internal
// names; this is a backstop, not the primary gate.
func looksLikeInternalSlug(s string) bool {
	if len(s) < 4 || !strings.ContainsRune(s, '-') {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
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
// object, tolerating markdown fences (```json … ```), surrounding prose, and
// JSON strings (e.g., "{\"status\":...}"). If no balanced object is found, it
// returns s unchanged so json.Unmarshal produces the usual error.
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	// If the entire text is a JSON string (starts and ends with quotes), unquote it first.
	// This handles the case where claude stream-json returns result as a quoted JSON string.
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		unquoted, err := strconv.Unquote(s)
		if err == nil && strings.HasPrefix(unquoted, "{") {
			s = unquoted
		}
	}
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

func decodeRoundOutput(rawCandidates ...string) (RoundOutput, error) {
	var lastErr error
	for _, candidate := range clarificationJSONCandidates(rawCandidates...) {
		var out RoundOutput
		if err := json.Unmarshal([]byte(candidate), &out); err != nil {
			repaired, repairErr := repairLooseJSONStringQuotes(candidate)
			if repairErr != nil {
				lastErr = err
				continue
			}
			if err := json.Unmarshal([]byte(repaired), &out); err != nil {
				lastErr = err
				continue
			}
		}
		if !looksLikeRoundOutput(out) {
			lastErr = fmt.Errorf("decoded JSON does not match clarification contract")
			continue
		}
		return out, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no clarification JSON found in Claude output")
	}
	return RoundOutput{}, fmt.Errorf("decode clarification output: %v: %w", lastErr, runner.ErrOutputInvalidJSON)
}

func clarificationJSONCandidates(rawCandidates ...string) []string {
	seen := make(map[string]struct{})
	var out []string
	add := func(candidate string) {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			return
		}
		if _, ok := seen[candidate]; ok {
			return
		}
		seen[candidate] = struct{}{}
		out = append(out, candidate)
	}

	for _, raw := range rawCandidates {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		add(raw)
		for _, obj := range extractJSONObjects(raw) {
			add(obj)
		}
		scanner := bufio.NewScanner(strings.NewReader(raw))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			if _, _, result, _ := parseClaudeStreamLine(line); result != "" {
				add(result)
				for _, obj := range extractJSONObjects(result) {
					add(obj)
				}
			}
			if candidate := extractAssistantMessageText(line); candidate != "" {
				add(candidate)
				for _, obj := range extractJSONObjects(candidate) {
					add(obj)
				}
			}
		}
	}
	return out
}

func extractAssistantMessageText(line string) string {
	var top struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type  string         `json:"type"`
				Text  string         `json:"text"`
				Input map[string]any `json:"input"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &top); err != nil {
		return ""
	}
	if top.Type != "assistant" {
		return ""
	}
	var parts []string
	for _, block := range top.Message.Content {
		switch block.Type {
		case "text":
			if text := strings.TrimSpace(block.Text); text != "" {
				parts = append(parts, text)
			}
		case "tool_use":
			if text := toolUseInputText(block.Input); text != "" {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "\n\n")
}

func toolUseInputText(input map[string]any) string {
	for _, key := range []string{"content", "prompt", "question", "message", "text"} {
		value, ok := input[key]
		if !ok {
			continue
		}
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

func extractJSONObjects(s string) []string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		if nl := strings.IndexByte(s, '\n'); nl >= 0 {
			s = strings.TrimSpace(s[nl+1:])
		}
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
		s = strings.TrimSpace(s)
	}

	var out []string
	for start := 0; start < len(s); {
		open := strings.IndexByte(s[start:], '{')
		if open < 0 {
			break
		}
		open += start
		depth := 0
		inStr := false
		esc := false
		for i := open; i < len(s); i++ {
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
					out = append(out, s[open:i+1])
					start = i + 1
					goto nextObject
				}
			}
		}
		break
	nextObject:
	}
	return out
}

// repairLooseJSONStringQuotes repairs a common non-JSON pattern from some
// Anthropic-compatible providers: raw double quotes embedded inside a JSON
// string value, e.g. `"content":"覆盖"全流程""`. The heuristic only escapes
// quotes that appear while already inside a string and are clearly not acting
// as the end delimiter because the next significant byte is not one of the
// legal post-string tokens in JSON.
func repairLooseJSONStringQuotes(s string) (string, error) {
	var b strings.Builder
	inString := false
	escape := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !inString {
			b.WriteByte(c)
			if c == '"' {
				inString = true
			}
			continue
		}
		if escape {
			b.WriteByte(c)
			escape = false
			continue
		}
		switch c {
		case '\\':
			b.WriteByte(c)
			escape = true
		case '"':
			if isLikelyStringTerminator(s, i+1) {
				b.WriteByte(c)
				inString = false
			} else {
				b.WriteString(`\"`)
			}
		default:
			b.WriteByte(c)
		}
	}
	if inString || escape {
		return "", fmt.Errorf("unterminated JSON string")
	}
	return b.String(), nil
}

func isLikelyStringTerminator(s string, next int) bool {
	for ; next < len(s); next++ {
		switch s[next] {
		case ' ', '\n', '\r', '\t':
			continue
		case ',', '}', ']', ':':
			return true
		default:
			return false
		}
	}
	return true
}

func looksLikeRoundOutput(out RoundOutput) bool {
	if out.Round <= 0 {
		return false
	}
	switch out.Status {
	case "waiting_user", "ready_to_confirm", "confirmed", "active":
	default:
		return false
	}
	return len(out.WorkLog) > 0 ||
		len(out.Questions) > 0 ||
		!requirementIsZero(out.Requirement)
}

func requirementIsZero(req Requirement) bool {
	return req.AppType == "" &&
		req.AppName == "" &&
		len(req.TargetUsers) == 0 &&
		req.CoreScenario == "" &&
		req.PrimaryView == "" &&
		len(req.MainEntities) == 0 &&
		len(req.BlueprintRefs) == 0 &&
		req.DataPolicy == "" &&
		len(req.AcceptanceFocus) == 0 &&
		len(req.GenerationProfile) == 0
}

func readModelOutputFile(path string) (string, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read output file: %w", err)
	}
	return string(raw), true, nil
}

func (r Runner) repairOutputJSON(ctx context.Context, input RoundInput, outputPath, badOutput string, decodeErr error) (string, bool) {
	if strings.TrimSpace(badOutput) == "" {
		return "", false
	}
	// 修复轮只修 JSON 语法，不重新分析需求，避免完整重跑导致业务内容漂移。
	prompt := "Repair malformed JSON for the requirement clarification contract. " +
		fmt.Sprintf("Write the repaired JSON object to the absolute path %s using the Write tool. ", outputPath) +
		"Preserve the original content and decisions; only fix JSON syntax, escaping, truncation, or markdown/prose wrapping. " +
		"Do not add new requirements, questions, reasoning, markdown, or explanatory prose. " +
		fmt.Sprintf("Decode error: %v\n\nMalformed output:\n%s", decodeErr, limitRepairPayload(badOutput, 24000))
	dir := filepath.Dir(outputPath)
	_ = os.WriteFile(filepath.Join(dir, "repair-prompt.md"), []byte(prompt), 0o644)
	_ = os.Remove(outputPath)
	args := append([]string{
		"--print", prompt,
		"--permission-mode", "acceptEdits",
		"--allowedTools", "Read,Grep,Glob,Write",
		"--disallowedTools", "Bash,Edit",
	}, claudeModelArgs()...)
	runner.LLMConsoleRequest(fmt.Sprintf("clarification JSON repair round %d", input.Round), r.binary(), args, prompt)
	res, err := r.Cmd.Run(ctx, r.workspaceRoot(), r.binary(), args...)
	_ = os.WriteFile(filepath.Join(dir, "repair-stdout.log"), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "repair-stderr.log"), []byte(res.Stderr), 0o644)
	if err != nil || res.ExitCode != 0 {
		return "", false
	}
	if raw, ok, rerr := readModelOutputFile(outputPath); rerr == nil && ok {
		return raw, true
	}
	if strings.TrimSpace(res.Stdout) != "" {
		return res.Stdout, true
	}
	return "", false
}

func limitRepairPayload(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n...[truncated]"
}

func (r Runner) promptText(inputPath, outputPath string) string {
	return "Use .claude/skills/requirement-clarification/SKILL.md as a reference for the clarification contract only. " +
		fmt.Sprintf("The round input is at the absolute path %s and must be read with the Read tool. ", inputPath) +
		fmt.Sprintf("Write the final clarification payload to the absolute path %s using the Write tool. ", outputPath) +
		"Do not call Edit, Bash, or any other file-modifying tool. Do not create a plan file. " +
		"All human-readable output fields must use Simplified Chinese, including workLog content, question text, option labels, option descriptions, requirement summaries, and recommendation copy; only identifiers, slugs, file paths, enum keys, and code symbols may remain non-Chinese. " +
		"The output.json file must contain ONLY valid JSON matching the requirement clarification contract, with no markdown fences and no extra prose. " +
		"After writing the file, the final assistant message may be a short confirmation; Factory will parse output.json first and stdout only as fallback. " +
		"Consult .claude/skills/requirement-clarification/blueprints.json for the internal scene blueprint catalog; when the user's intent matches a blueprint, populate requirement.blueprintRefs with the matching slug(s). If no blueprint matches, use an empty blueprintRefs array. Blueprints are hidden style/structure references only: never emit user-facing blueprint recommendations, never call them templates, and never copy scene source."
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

// ErrConsolidationFieldUnknown is returned by ApplyConsolidationAdjustment when
// the user-selected field is not present in the consolidation list.
var ErrConsolidationFieldUnknown = errors.New("selected field is not in the consolidation list")

// ErrConsolidationValueInvalid is returned by ApplyConsolidationAdjustment when
// a consolidation entry's recommendedValue is malformed JSON or the wrong type
// for its field.
var ErrConsolidationValueInvalid = errors.New("consolidation recommendedValue is invalid for its field")

// ApplyConsolidationAdjustment implements the round-6 merge (no model turn).
// It (a) permits only the one selectedField the user adjusted, applying
// selectedValue to it; (b) merges the persisted recommended values for every
// OTHER missing field in the consolidation list; (c) validates completeness of
// the result; and (d) returns the requirement marked ready_to_confirm. It does
// NOT invoke the model. The handler (Task 4) calls this directly.
//
// current is the requirement carried into round 6 (the confirmed-so-far
// fields). consolidation is the round-5 recommendation list. selectedField is
// the single field the user chose to override; selectedValue is their pick. If
// selectedField is empty, every missing field takes its recommendation (a pure
// accept-all).
func ApplyConsolidationAdjustment(current Requirement, consolidation []ConsolidationEntry, selectedField string, selectedValue any) (Requirement, error) {
	if selectedField != "" {
		known := false
		for _, e := range consolidation {
			if e.Field == selectedField {
				known = true
				break
			}
		}
		if !known {
			return Requirement{}, fmt.Errorf("field %q: %w", selectedField, ErrConsolidationFieldUnknown)
		}
	}
	out := current
	// Apply the persisted recommended value for every consolidation field EXCEPT
	// the selected one (which the user overrides).
	for _, e := range consolidation {
		if e.Field == selectedField {
			if err := setRequirementField(&out, e.Field, selectedValue); err != nil {
				return Requirement{}, fmt.Errorf("field %q selected value: %w", e.Field, err)
			}
			continue
		}
		// Only fill in fields that are currently empty/missing — a previously
		// confirmed value is preserved, not overwritten by the recommendation.
		if !requirementFieldEmpty(out, e.Field) {
			continue
		}
		var v any
		if err := json.Unmarshal(e.RecommendedValue, &v); err != nil {
			return Requirement{}, fmt.Errorf("field %q: %w", e.Field, ErrConsolidationValueInvalid)
		}
		if err := setRequirementField(&out, e.Field, v); err != nil {
			return Requirement{}, fmt.Errorf("field %q: %w", e.Field, err)
		}
	}
	if err := validateRequirementComplete(out); err != nil {
		return Requirement{}, err
	}
	return out, nil
}

// setRequirementField assigns a typed value to a named Requirement field by
// JSON tag. It accepts the value shapes a consolidation entry carries (string
// for scalar fields, []any for slice fields).
func setRequirementField(req *Requirement, field string, value any) error {
	v := reflect.ValueOf(req).Elem()
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := strings.Split(f.Tag.Get("json"), ",")[0]
		if tag != field {
			continue
		}
		fv := v.Field(i)
		switch fv.Kind() {
		case reflect.String:
			s, ok := value.(string)
			if !ok {
				return fmt.Errorf("expected string for %s: %w", field, ErrConsolidationValueInvalid)
			}
			fv.SetString(s)
		case reflect.Slice:
			arr, ok := value.([]any)
			if !ok {
				return fmt.Errorf("expected array for %s: %w", field, ErrConsolidationValueInvalid)
			}
			out := make([]string, 0, len(arr))
			for _, a := range arr {
				s, ok := a.(string)
				if !ok {
					return fmt.Errorf("expected string element for %s: %w", field, ErrConsolidationValueInvalid)
				}
				out = append(out, s)
			}
			fv.Set(reflect.ValueOf(out))
		case reflect.Map:
			// generationProfile: map[string][]string. Consolidation does not
			// typically adjust this (it is set early), but handle defensively.
			b, err := json.Marshal(value)
			if err != nil {
				return fmt.Errorf("field %s: %w", field, ErrConsolidationValueInvalid)
			}
			var m map[string][]string
			if err := json.Unmarshal(b, &m); err != nil {
				return fmt.Errorf("field %s: %w", field, ErrConsolidationValueInvalid)
			}
			fv.Set(reflect.ValueOf(m))
		case reflect.Struct:
			b, err := json.Marshal(value)
			if err != nil {
				return fmt.Errorf("field %s: %w", field, ErrConsolidationValueInvalid)
			}
			holder := reflect.New(fv.Type())
			if err := json.Unmarshal(b, holder.Interface()); err != nil {
				return fmt.Errorf("field %s: %w", field, ErrConsolidationValueInvalid)
			}
			fv.Set(holder.Elem())
		default:
			return fmt.Errorf("field %s unsupported kind %s: %w", field, fv.Kind(), ErrConsolidationValueInvalid)
		}
		return nil
	}
	return fmt.Errorf("field %q: %w", field, ErrConsolidationFieldUnknown)
}

// requirementFieldEmpty reports whether a Requirement field (by JSON tag) is at
// its zero value, so ApplyConsolidationAdjustment only fills missing fields.
func requirementFieldEmpty(req Requirement, field string) bool {
	v := reflect.ValueOf(&req).Elem()
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := strings.Split(f.Tag.Get("json"), ",")[0]
		if tag != field {
			continue
		}
		fv := v.Field(i)
		switch fv.Kind() {
		case reflect.String:
			return fv.String() == ""
		case reflect.Slice, reflect.Map:
			return fv.Len() == 0
		case reflect.Struct:
			return reflect.DeepEqual(fv.Interface(), reflect.Zero(fv.Type()).Interface())
		}
	}
	return true
}

// validateRequirementComplete enforces the required business-confirmation
// fields. primaryView/dataPolicy 属于后续界面解析/数据抓取阶段，不能在业务
// 逻辑确认和 consolidation 合并时阻塞 ready_to_confirm。
func validateRequirementComplete(req Requirement) error {
	missing := []string{}
	if req.AppType == "" {
		missing = append(missing, "appType")
	}
	if req.AppName == "" {
		missing = append(missing, "appName")
	}
	if len(req.TargetUsers) == 0 {
		missing = append(missing, "targetUsers")
	}
	if req.CoreScenario == "" {
		missing = append(missing, "coreScenario")
	}
	if len(req.MainEntities) == 0 {
		missing = append(missing, "mainEntities")
	}
	if len(req.AcceptanceFocus) == 0 {
		missing = append(missing, "acceptanceFocus")
	}
	if len(req.GenerationProfile) == 0 {
		missing = append(missing, "generationProfile")
	}
	if len(missing) > 0 {
		return fmt.Errorf("requirement incomplete, missing %s: %w", strings.Join(missing, ", "), ErrConsolidationValueInvalid)
	}
	return nil
}

func claudeModelArgs() []string {
	for _, key := range []string{"CLAUDE_CODE_MODEL", "ANTHROPIC_MODEL"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return []string{"--model", value}
		}
	}
	return nil
}
