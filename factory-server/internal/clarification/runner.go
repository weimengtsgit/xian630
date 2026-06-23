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
	// Adaptive invariant: rounds 1–4 accept ZERO questions or EXACTLY ONE
	// required question. A model round emitting more than one question is a
	// contract violation — reject it rather than silently truncating. Round 5
	// (consolidation) emits no questions by construction; this guard still
	// holds it to the same discipline.
	if !IsReadyToConfirmStatus(out.Status) && len(out.Questions) > 1 {
		return RoundOutput{}, fmt.Errorf("clarification round %d emitted %d questions; adaptive contract allows at most one: %w", out.Round, len(out.Questions), ErrAdaptiveTooManyQuestions)
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
		"Output ONLY valid JSON matching the adaptive requirement clarification contract. " +
		"Emit at most ONE required question per round (rounds 1–4), each with 2–3 options. " +
		"At round 5 (only if still incomplete) emit a consolidation list recommending a value for every remaining field. " +
		"Blueprints are an internal Factory reference — do not surface them in any user-facing output; never call a blueprint a template, never invent slugs."
}

// ErrAdaptiveTooManyQuestions is returned when a clarification round emits more
// than one question. The adaptive contract allows at most one required question
// per round.
var ErrAdaptiveTooManyQuestions = errors.New("adaptive contract allows at most one question per round")

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
		}
	}
	return true
}

// validateRequirementComplete enforces the required confirmed-requirement
// fields. It mirrors the SKILL.md "Required Confirmed Requirement Fields" list.
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
	if req.PrimaryView == "" {
		missing = append(missing, "primaryView")
	}
	if len(req.MainEntities) == 0 {
		missing = append(missing, "mainEntities")
	}
	if req.DataPolicy == "" {
		missing = append(missing, "dataPolicy")
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
