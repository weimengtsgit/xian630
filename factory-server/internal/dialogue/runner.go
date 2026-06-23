package dialogue

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// Runner drives the two model-driven dialogue contracts (intent routing +
// business-agent drafting) via the claude CLI, mirroring the artifact
// discipline of package clarification. It VALIDATES every model output before
// returning or emitting it.
type Runner struct {
	Cmd           runner.CommandRunner
	Binary        string
	WorkspaceRoot string
	ArtifactRoot  string
}

type streamCommandRunner interface {
	RunStream(ctx context.Context, dir string, name string, onStdoutLine func(string), args ...string) (runner.CommandResult, error)
}

// ErrRouteInvalidIntent is returned when the router emits an intent outside the
// three allowed values.
var ErrRouteInvalidIntent = fmt.Errorf("route intent must be one of existing_application, application_generation, business_processing_agent")

// ErrRouteSlugNotCandidate is returned when the router returns a slug that is
// not among the candidates Factory supplied.
var ErrRouteSlugNotCandidate = fmt.Errorf("route returned a slug that is not a supplied candidate")

// ErrDraftTooManyQuestions is returned when a business draft round emits more
// than one question.
var ErrDraftTooManyQuestions = fmt.Errorf("business draft contract allows at most one question per round")

// RouteIntent runs one intent-routing model turn. It writes the bounded input,
// invokes claude in plan mode with Read/Grep/Glob only, parses + validates the
// RouteOutput, and emits redacted stream events. The returned RouteOutput keeps
// the internalBlueprintSlug for server-side use; it is stripped from every
// emitted StreamEvent.
func (r Runner) RouteIntent(ctx context.Context, input RouteInput, emit func(StreamEvent)) (RouteOutput, error) {
	dir := filepath.Join(r.artifactRoot(), "dialogues", input.DialogueID, "route")
	out, err := r.runModel(ctx, dir, input.DialogueID, "route", input, r.routePrompt, emit, "dialogue.route")
	if err != nil {
		return RouteOutput{}, err
	}
	var routeOut RouteOutput
	if err := json.Unmarshal([]byte(out), &routeOut); err != nil {
		return RouteOutput{}, fmt.Errorf("decode route output: %v: %w", err, runner.ErrOutputInvalidJSON)
	}
	routeOut = normalizeRouteOutput(routeOut)
	if err := validateRouteOutput(routeOut, input); err != nil {
		return RouteOutput{}, err
	}
	// Redact the internal slug before writing output.json / emitting events.
	// The internal slug survives ONLY in the returned RouteOutput for
	// server-side use; it must never appear in any emitted event or persisted
	// artifact, so emit a redacted projection that omits the field entirely.
	redacted := routeEventView{
		Intent:                   routeOut.Intent,
		Confidence:               routeOut.Confidence,
		ExistingApplicationSlugs: routeOut.ExistingApplicationSlugs,
		UserFacingReason:         routeOut.UserFacingReason,
		NeedsRouteConfirmation:   routeOut.NeedsRouteConfirmation,
	}
	redactedBytes, _ := json.MarshalIndent(redacted, "", "  ")
	_ = os.WriteFile(filepath.Join(dir, "output.json"), redactedBytes, 0o644)
	events := []StreamEvent{
		{Type: "dialogue.route.completed", DialogueID: input.DialogueID, Data: redacted},
	}
	if err := writeStream(filepath.Join(dir, "stream.jsonl"), events); err != nil {
		return RouteOutput{}, err
	}
	for _, ev := range events {
		emit(ev)
	}
	return routeOut, nil
}

// RunBusinessDraftRound runs one business-agent drafting model turn, following
// the same one-decision / consolidation / 6-round rules as clarification. It
// validates the draft and rejects rounds emitting more than one question.
func (r Runner) RunBusinessDraftRound(ctx context.Context, input BusinessDraftInput, emit func(StreamEvent)) (BusinessDraftOutput, error) {
	op := fmt.Sprintf("draft-round-%d", input.Round)
	dir := filepath.Join(r.artifactRoot(), "dialogues", input.DialogueID, op)
	out, err := r.runModel(ctx, dir, input.DialogueID, op, input, r.draftPrompt, emit, "dialogue.draft")
	if err != nil {
		return BusinessDraftOutput{}, err
	}
	var draftOut BusinessDraftOutput
	if err := json.Unmarshal([]byte(out), &draftOut); err != nil {
		return BusinessDraftOutput{}, fmt.Errorf("decode draft output: %v: %w", err, runner.ErrOutputInvalidJSON)
	}
	draftOut = normalizeDraftOutput(draftOut)
	// One-decision invariant: a drafting round emits at most ONE question.
	if !IsReadyToConfirmStatus(draftOut.Status) && len(draftOut.Questions) > 1 {
		return BusinessDraftOutput{}, fmt.Errorf("draft round %d emitted %d questions: %w", draftOut.Round, len(draftOut.Questions), ErrDraftTooManyQuestions)
	}
	outBytes, _ := json.MarshalIndent(draftOut, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "output.json"), outBytes, 0o644); err != nil {
		return BusinessDraftOutput{}, err
	}
	events := normalizeDraftEvents(input.DialogueID, draftOut, normalizeOptions{})
	if err := writeStream(filepath.Join(dir, "stream.jsonl"), events); err != nil {
		return BusinessDraftOutput{}, err
	}
	for _, ev := range events {
		emit(ev)
	}
	return draftOut, nil
}

// runModel is the shared artifact+stream+validate shell for both contracts.
// It writes input.json + prompt.md, runs claude in plan mode with
// Read/Grep/Glob only, captures stdout/stderr/stream, extracts the JSON object,
// and returns the raw JSON string for the caller to decode into its contract.
// It NEVER surfaces thinking_delta — only text_delta text is streamed.
func (r Runner) runModel(ctx context.Context, dir, dialogueID, op string, input any, promptFn func(string) string, emit func(StreamEvent), startedType string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	absInput, err := filepath.Abs(filepath.Join(dir, "input.json"))
	if err != nil {
		return "", fmt.Errorf("resolve input path: %w", err)
	}
	in, err := json.MarshalIndent(input, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode %s input: %w", op, err)
	}
	if err := os.WriteFile(absInput, in, 0o644); err != nil {
		return "", err
	}
	prompt := promptFn(absInput)
	if err := os.WriteFile(filepath.Join(dir, "prompt.md"), []byte(prompt), 0o644); err != nil {
		return "", err
	}
	res, assistantText, streamed, err := r.runClaude(ctx, dialogueID, op, startedType, prompt, emit)
	_ = os.WriteFile(filepath.Join(dir, "stdout.log"), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "stderr.log"), []byte(res.Stderr), 0o644)
	if err != nil {
		return "", fmt.Errorf("claude run: %w", err)
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("claude exit %d: %w", res.ExitCode, runner.ErrRunnerExitNonzero)
	}
	if strings.TrimSpace(assistantText) == "" {
		assistantText = res.Stdout
	}
	_ = streamed
	return extractJSONObject(assistantText), nil
}

func (r Runner) runClaude(ctx context.Context, dialogueID, op, startedType, prompt string, emit func(StreamEvent)) (runner.CommandResult, string, bool, error) {
	if sr, ok := r.Cmd.(streamCommandRunner); ok {
		return r.runClaudeStream(ctx, sr, dialogueID, op, startedType, prompt, emit)
	}
	res, err := r.Cmd.Run(ctx, r.workspaceRoot(), r.binary(),
		"--print", prompt,
		"--permission-mode", "plan",
		"--allowedTools", "Read,Grep,Glob",
		"--disallowedTools", "Bash,Edit,Write")
	return res, res.Stdout, false, err
}

func (r Runner) runClaudeStream(ctx context.Context, sr streamCommandRunner, dialogueID, op, startedType, prompt string, emit func(StreamEvent)) (runner.CommandResult, string, bool, error) {
	messageID := op + "_live"
	emit(StreamEvent{
		Type:       startedType + ".started",
		DialogueID: dialogueID,
		MessageID:  messageID,
		Data:       WorkLog{Type: "analysis_work_log", Content: "已连接 Claude Code 流式输出。"},
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
		visible := assistantText.String()
		if visible == "" || visible == lastVisible {
			return
		}
		lastVisible = visible
		emit(StreamEvent{
			Type:       startedType + ".delta",
			DialogueID: dialogueID,
			MessageID:  messageID,
			Delta:      visible,
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
	emit(StreamEvent{
		Type:       startedType + ".completed",
		DialogueID: dialogueID,
		MessageID:  messageID,
		Data:       WorkLog{Type: "analysis_work_log", Content: "结构化结果接收完成。"},
	})
	return res, finalText, true, err
}

func (r Runner) routePrompt(inputPath string) string {
	return "Use .claude/skills/dialogue-intent-routing/SKILL.md. " +
		fmt.Sprintf("The route input is at the absolute path %s — read it with the Read tool. ", inputPath) +
		"Output ONLY valid JSON matching the route output contract. " +
		"Use only the candidate applications and blueprints supplied in the input; never invent slugs or resource names, never state nothing is reusable, never describe a blueprint as a template, never expose hidden reasoning. " +
		"Do not emit business_processing_agent in the current phase. If the user asks to create an agent or assistant and no existing app is a strong fit, route to application_generation as a runnable assistant application."
}

func (r Runner) draftPrompt(inputPath string) string {
	return "Use .claude/skills/business-agent-drafting/SKILL.md. " +
		fmt.Sprintf("The draft input is at the absolute path %s — read it with the Read tool. ", inputPath) +
		"Output ONLY valid JSON matching the business draft contract. " +
		"Emit at most ONE required question per round (rounds 1–4), each with 2–3 options; at round 5 emit a consolidation list. " +
		"The agentDraft.prompt must be a complete future agent instruction but MUST NOT imply tool access, permissions, inputs, or runtime execution. " +
		"Never expose hidden reasoning, never invent resource names."
}

// validateRouteOutput enforces the route contract: valid intent, every returned
// slug must be among the supplied candidates. internalBlueprintSlug validity is
// checked here but the slug itself is retained for server-side use.
func validateRouteOutput(out RouteOutput, input RouteInput) error {
	if !validIntent(string(out.Intent)) {
		return fmt.Errorf("intent %q: %w", out.Intent, ErrRouteInvalidIntent)
	}
	appCandidates := make(map[string]bool, len(input.ExistingApplications))
	for _, a := range input.ExistingApplications {
		appCandidates[a.Slug] = true
	}
	for _, slug := range out.ExistingApplicationSlugs {
		if !appCandidates[slug] {
			return fmt.Errorf("existingApplicationSlugs entry %q: %w", slug, ErrRouteSlugNotCandidate)
		}
	}
	if out.InternalBlueprintSlug != "" {
		bpCandidates := make(map[string]bool, len(input.Blueprints))
		for _, b := range input.Blueprints {
			bpCandidates[b.Slug] = true
		}
		if !bpCandidates[out.InternalBlueprintSlug] {
			return fmt.Errorf("internalBlueprintSlug %q: %w", out.InternalBlueprintSlug, ErrRouteSlugNotCandidate)
		}
	}
	return nil
}

// normalizeRouteOutput defensively normalizes the dormant
// business_processing_agent intent to application_generation. The model (or a
// legacy path) may still emit it; normalization runs BEFORE validation and
// BEFORE any event/artifact is written, so the dormant intent never reaches a
// user-facing event or the persisted redacted route output.
func normalizeRouteOutput(out RouteOutput) RouteOutput {
	if out.Intent == IntentBusinessProcessingAgent {
		out.Intent = IntentApplicationGeneration
		out.ExistingApplicationSlugs = nil
		out.UserFacingReason = "我会先澄清你的需求，并生成一个可运行的助手应用。"
	}
	return out
}

func normalizeDraftOutput(out BusinessDraftOutput) BusinessDraftOutput {
	if IsReadyToConfirmStatus(out.Status) {
		out.Status = "ready_to_confirm"
	}
	for i := range out.Questions {
		for j := range out.Questions[i].Options {
			if out.Questions[i].Recommendation == out.Questions[i].Options[j].Value {
				out.Questions[i].Options[j].Recommended = true
			}
		}
	}
	return out
}

type normalizeOptions struct {
	SkipWorkLogs bool
}

func normalizeDraftEvents(dialogueID string, out BusinessDraftOutput, opts normalizeOptions) []StreamEvent {
	events := []StreamEvent{}
	if !opts.SkipWorkLogs {
		for i, wl := range out.WorkLog {
			id := fmt.Sprintf("worklog_%d", i+1)
			events = append(events,
				StreamEvent{Type: "dialogue.draft.started", DialogueID: dialogueID, MessageID: id, Data: wl},
				StreamEvent{Type: "dialogue.draft.delta", DialogueID: dialogueID, MessageID: id, Delta: wl.Content},
				StreamEvent{Type: "dialogue.draft.completed", DialogueID: dialogueID, MessageID: id, Data: wl},
			)
		}
	}
	for _, q := range out.Questions {
		events = append(events, StreamEvent{Type: "dialogue.draft.question.created", DialogueID: dialogueID, Data: q})
	}
	if len(out.Consolidation) > 0 {
		events = append(events, StreamEvent{Type: "dialogue.draft.consolidation.updated", DialogueID: dialogueID, Data: out.Consolidation})
	}
	events = append(events, StreamEvent{Type: "dialogue.draft.summary.updated", DialogueID: dialogueID, Data: out.AgentDraft})
	if IsReadyToConfirmStatus(out.Status) {
		events = append(events, StreamEvent{Type: "dialogue.draft.ready_to_confirm", DialogueID: dialogueID, Data: out.AgentDraft})
	}
	return events
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

// parseClaudeStreamLine is the thinking_delta filter (mirrors clarification):
// only content_block_delta/text_delta text is surfaced. thinking_delta and all
// other hidden provider fields are dropped.
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

// extractJSONObject mirrors the clarification tolerant JSON extractor.
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
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
	return s[start:]
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
