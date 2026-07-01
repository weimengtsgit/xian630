package dialogue

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// --- fakes (mirror clarification/runner_test.go) ---

type fakeCommandRunner struct {
	dir        string
	name       string
	args       []string
	rawStdout  string
	rawStdouts []string
	rawStderr  string
	exitCode   int
	calls      int
}

func (f *fakeCommandRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	f.dir, f.name, f.args = dir, name, args
	f.calls++
	stdout := f.rawStdout
	if len(f.rawStdouts) > 0 {
		idx := f.calls - 1
		if idx >= len(f.rawStdouts) {
			idx = len(f.rawStdouts) - 1
		}
		stdout = f.rawStdouts[idx]
	}
	return runner.CommandResult{Stdout: stdout, Stderr: f.rawStderr, ExitCode: f.exitCode}, nil
}

type fakeStreamCommandRunner struct {
	dir   string
	name  string
	args  []string
	lines []string
}

func (f *fakeStreamCommandRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	return runner.CommandResult{ExitCode: 1, Stderr: "Run should not be used when RunStream exists"}, nil
}

func (f *fakeStreamCommandRunner) RunStream(ctx context.Context, dir, name string, onStdoutLine func(string), args ...string) (runner.CommandResult, error) {
	f.dir, f.name, f.args = dir, name, args
	var stdout strings.Builder
	for _, line := range f.lines {
		stdout.WriteString(line)
		stdout.WriteByte('\n')
		onStdoutLine(line)
	}
	return runner.CommandResult{Stdout: stdout.String(), ExitCode: 0}, nil
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func sampleApps() []AppSummary {
	return []AppSummary{
		{Slug: "carrier-deck-wind-calculator", Name: "甲板风计算器", AppType: "command_dashboard"},
		{Slug: "fleet-replay", Name: "编队复盘", AppType: "situation_replay", IsGenerated: true},
	}
}

func sampleBlueprints() []BlueprintSummary {
	return []BlueprintSummary{
		{Slug: "carrier-formation-replay", Name: "航母编队复盘", AppType: "situation_replay"},
		{Slug: "tidal-window", Name: "潮汐窗口", AppType: "command_dashboard"},
	}
}

// --- intent routing: argv discipline ---

func TestRouteIntentPromptUsesSkillAndPermitsOnlyReadGrepGlob(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentExistingApplication, Confidence: ConfidenceHigh,
		ExistingApplicationSlugs: []string{"carrier-deck-wind-calculator"},
		UserFacingReason:         "已存在该应用", NeedsRouteConfirmation: true,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_1", UserMessage: "打开甲板风计算器",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	if fr.name != "claude" {
		t.Fatalf("command = %s", fr.name)
	}
	if !argContains(fr.args, "--permission-mode", "plan") {
		t.Fatalf("missing plan mode: %v", fr.args)
	}
	if !argContains(fr.args, "--allowedTools", "Read,Grep,Glob") {
		t.Fatalf("missing allowedTools: %v", fr.args)
	}
	if !argHasDisallowed(fr.args, "Bash,Edit,Write") {
		t.Fatalf("missing disallowedTools Bash,Edit,Write: %v", fr.args)
	}
	var sawPromptSkill bool
	for _, a := range fr.args {
		if strings.Contains(a, "dialogue-intent-routing") {
			sawPromptSkill = true
		}
	}
	if !sawPromptSkill {
		t.Fatalf("prompt must reference dialogue-intent-routing skill: %v", fr.args)
	}
	prompt := strings.Join(fr.args, " ")
	if !strings.Contains(prompt, filepath.Join(root, ".claude", "skills", "dialogue-intent-routing", "SKILL.md")) {
		t.Fatalf("prompt must use an absolute skill path rooted at WorkspaceRoot: %s", prompt)
	}
	for _, required := range []string{`"intent"`, `"confidence"`, `"existingApplicationSlugs"`, `"internalBlueprintSlug"`, `"userFacingReason"`, `"needsRouteConfirmation"`} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("prompt must inline route output contract field %s: %s", required, prompt)
		}
	}
	// artifacts written
	for _, rel := range []string{"input.json", "prompt.md", "output.json", "stdout.log", "stderr.log", "stream.jsonl"} {
		if _, err := os.Stat(filepath.Join(root, ".factory-runs", "dialogues", "dia_1", "route", rel)); err != nil {
			t.Fatalf("missing %s: %v", rel, err)
		}
	}
}

// --- intent routing: prompt hides business_processing_agent route ---

func TestRouteIntentPromptHidesBusinessProcessingAgentRoute(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentApplicationGeneration, Confidence: ConfidenceHigh,
		UserFacingReason: "将先澄清需求并生成一个可运行的助手应用。",
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_hide_biz", UserMessage: "帮我创建一个告警分诊 Agent",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	prompt := strings.Join(fr.args, " ")
	if strings.Contains(prompt, `"existing_application | application_generation | business_processing_agent"`) {
		t.Fatalf("prompt still exposes business_processing_agent as an active output: %s", prompt)
	}
	if strings.Contains(prompt, "For a `business_processing_agent` route") {
		t.Fatalf("prompt still instructs the model to produce a business route: %s", prompt)
	}
	if !strings.Contains(prompt, "assistant application") && !strings.Contains(prompt, "助手应用") {
		t.Fatalf("prompt must tell agent/assistant requests to become application_generation: %s", prompt)
	}
}

func TestRouteIntentRetriesInvalidJSON(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdouts: []string{
		"我先解释一下 {{{",
		mustJSON(t, RouteOutput{
			Intent:           IntentApplicationGeneration,
			Confidence:       ConfidenceHigh,
			UserFacingReason: "将先澄清需求并生成应用。",
		}),
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_route_retry", UserMessage: "生成一个todo",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	if fr.calls != 2 {
		t.Fatalf("calls = %d, want 2", fr.calls)
	}
	if out.Intent != IntentApplicationGeneration {
		t.Fatalf("intent = %s, want application_generation", out.Intent)
	}
}

// --- intent routing: invented slug rejection ---

func TestRouteIntentRejectsInventedAppSlug(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentExistingApplication, Confidence: ConfidenceHigh,
		ExistingApplicationSlugs: []string{"totally-fabricated-app"},
		UserFacingReason:         "x", NeedsRouteConfirmation: true,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_2", UserMessage: "x",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err == nil {
		t.Fatalf("expected error for invented app slug")
	}
	if !strings.Contains(err.Error(), "fabricated-app") && !strings.Contains(err.Error(), "existingApplicationSlugs") {
		t.Fatalf("error should name the invalid slug: %v", err)
	}
	for _, ev := range events {
		b, _ := json.Marshal(ev)
		if strings.Contains(string(b), "fabricated-app") {
			t.Fatalf("invented slug leaked into emitted event: %s", string(b))
		}
	}
}

func TestRouteIntentRejectsInventedBlueprintSlug(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentApplicationGeneration, Confidence: ConfidenceHigh,
		InternalBlueprintSlug: "invented-blueprint",
		UserFacingReason:      "x", NeedsRouteConfirmation: true,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_3", UserMessage: "x",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err == nil {
		t.Fatalf("expected error for invented blueprint slug")
	}
}

// --- intent routing: dormant business intent normalized to application generation ---

func TestRouteIntentNormalizesDormantBusinessIntentToApplicationGeneration(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent:                 IntentBusinessProcessingAgent,
		Confidence:             ConfidenceHigh,
		UserFacingReason:       "将配置一个业务处理智能体。",
		NeedsRouteConfirmation: false,
	})}
	var events []StreamEvent
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID:           "dia_norm_biz",
		UserMessage:          "创建一个审批 Agent",
		ExistingApplications: sampleApps(),
		Blueprints:           sampleBlueprints(),
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	if out.Intent != IntentApplicationGeneration {
		t.Fatalf("intent = %q, want application_generation", out.Intent)
	}
	if strings.Contains(out.UserFacingReason, "业务处理") || strings.Contains(out.UserFacingReason, "Agent") {
		t.Fatalf("reason should be assistant-application framing, got %q", out.UserFacingReason)
	}
	for _, ev := range events {
		b, _ := json.Marshal(ev)
		if strings.Contains(string(b), "business_processing_agent") {
			t.Fatalf("business intent leaked in event: %s", string(b))
		}
	}
}

func TestRouteIntentRequiresConfirmationForApplicationGeneration(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent:                 IntentApplicationGeneration,
		Confidence:             ConfidenceHigh,
		UserFacingReason:       "我会澄清需求并生成一个可运行的新应用。",
		NeedsRouteConfirmation: false,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID:           "dia_generation_confirmation",
		UserMessage:          "创建一个新的态势看板",
		ExistingApplications: sampleApps(),
		Blueprints:           sampleBlueprints(),
	}, func(StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	if !out.NeedsRouteConfirmation {
		t.Fatal("application_generation must provide a route-selection action")
	}
}

func TestRouteIntentNormalizesEmptyExistingApplicationToGeneration(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent:                   IntentExistingApplication,
		Confidence:               ConfidenceHigh,
		ExistingApplicationSlugs: nil,
		UserFacingReason:         "已有应用可复用。",
		NeedsRouteConfirmation:   false,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID:           "dia_empty_existing",
		UserMessage:          "创建一个新的排班应用",
		ExistingApplications: sampleApps(),
		Blueprints:           sampleBlueprints(),
	}, func(StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	if out.Intent != IntentApplicationGeneration {
		t.Fatalf("intent = %q, want application_generation", out.Intent)
	}
	if !out.NeedsRouteConfirmation {
		t.Fatal("empty existing-application result must offer application generation")
	}
	if strings.Contains(out.UserFacingReason, "已有应用") {
		t.Fatalf("empty existing-application reason leaked into generation route: %q", out.UserFacingReason)
	}
}

// --- intent routing: valid generation route keeps internal slug in output but redacts from events ---

func TestRouteIntentKeepsInternalSlugInOutputButRedactsFromEvents(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentApplicationGeneration, Confidence: ConfidenceHigh,
		InternalBlueprintSlug: "carrier-formation-replay",
		UserFacingReason:      "将基于现有蓝本生成新应用", NeedsRouteConfirmation: true,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_4", UserMessage: "做一个类似编队复盘的应用",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RouteIntent: %v", err)
	}
	if out.InternalBlueprintSlug != "carrier-formation-replay" {
		t.Fatalf("returned output must keep internal slug, got %q", out.InternalBlueprintSlug)
	}
	for _, ev := range events {
		b, _ := json.Marshal(ev)
		if strings.Contains(string(b), "carrier-formation-replay") || strings.Contains(string(b), "internalBlueprintSlug") {
			t.Fatalf("internal blueprint slug leaked into emitted event: %s", string(b))
		}
		if strings.Contains(string(b), "invented") {
			t.Fatalf("invented content leaked: %s", string(b))
		}
	}
}

// --- intent routing: ambiguous confidence surfaced ---

func TestRouteIntentAcceptsAmbiguousConfidence(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, RouteOutput{
		Intent: IntentApplicationGeneration, Confidence: ConfidenceAmbiguous,
		UserFacingReason: "无法确定是要新建应用还是处理业务", NeedsRouteConfirmation: true,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_5", UserMessage: "x",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent ambiguous: %v", err)
	}
	if out.Confidence != ConfidenceAmbiguous {
		t.Fatalf("confidence = %s", out.Confidence)
	}
}

func TestRouteIntentRejectsInvalidIntent(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, map[string]any{
		"intent": "free_form_chat", "confidence": "high",
		"existingApplicationSlugs": []string{}, "userFacingReason": "x",
		"needsRouteConfirmation": false,
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_6", UserMessage: "x",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err == nil {
		t.Fatalf("expected error for invalid intent")
	}
}

func TestRouteIntentAdaptsLegacyActionBlueprintOutput(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: "```json\n" + mustJSON(t, map[string]any{
		"action": "application_generation",
		"blueprint": map[string]any{
			"slug":    "carrier-formation-replay",
			"name":    "航母编队复盘",
			"appType": "situation_replay",
			"summary": "展示航母编队复盘。",
		},
	}) + "\n```"}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_legacy_shape", UserMessage: "写一个航母编队复盘应用",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(StreamEvent) {})
	if err != nil {
		t.Fatalf("RouteIntent should adapt legacy action/blueprint shape: %v", err)
	}
	if out.Intent != IntentApplicationGeneration {
		t.Fatalf("intent = %q, want application_generation", out.Intent)
	}
	if out.InternalBlueprintSlug != "carrier-formation-replay" {
		t.Fatalf("internalBlueprintSlug = %q", out.InternalBlueprintSlug)
	}
	if !out.NeedsRouteConfirmation {
		t.Fatal("legacy application_generation output must still require route confirmation")
	}
}

// --- intent routing: malformed JSON ---

func TestRouteIntentRejectsMalformedJSON(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: "not json at all {{{"}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_7", UserMessage: "x",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err == nil {
		t.Fatalf("expected error for malformed JSON")
	}
	if !strings.Contains(err.Error(), "output") && !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("error should describe JSON failure: %v", err)
	}
}

func TestRouteIntentIncludesAPIErrorOnNonZeroExit(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: "API Error: 402 Insufficient Balance", exitCode: 1}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_api_error", UserMessage: "请做一个后勤管理应用",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) {})
	if err == nil {
		t.Fatalf("expected route runner error")
	}
	if !strings.Contains(err.Error(), "API Error: 402 Insufficient Balance") {
		t.Fatalf("error should include the Claude API error, got: %v", err)
	}
	if !strings.Contains(err.Error(), runner.ErrRunnerExitNonzero.Error()) {
		t.Fatalf("error should preserve runner_exit_nonzero sentinel, got: %v", err)
	}
}

// --- intent routing: thinking_delta streams on a dedicated .thinking channel ---

// The conversation surface streams the model's thinking. thinking_delta is
// surfaced as a separate dialogue.route.thinking event (the 思考过程 block),
// while the safe output (text_delta) reconstructs on the .delta channel — the
// two never cross-contaminate. (#9 still applies to the executor/trace pipeline.)
func TestRouteIntentSurfacesThinkingOnThinkingChannel(t *testing.T) {
	root := t.TempDir()
	out := RouteOutput{
		Intent: IntentExistingApplication, Confidence: ConfidenceHigh,
		ExistingApplicationSlugs: []string{"carrier-deck-wind-calculator"},
		UserFacingReason:         "已存在", NeedsRouteConfirmation: true,
	}
	outJSON := mustJSON(t, out)
	// Split into two text_delta chunks with a thinking_delta in between.
	split := len(outJSON) / 2
	part1, part2 := outJSON[:split], outJSON[split:]
	fr := &fakeStreamCommandRunner{lines: []string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"stream_event","event":{"delta":{"text":` + strconv.Quote(part1) + `,"type":"text_delta"},"index":0,"type":"content_block_delta"}}`,
		`{"type":"stream_event","event":{"delta":{"thinking":"hidden internal reasoning about blueprints","type":"thinking_delta"},"index":1,"type":"content_block_delta"}}`,
		`{"type":"stream_event","event":{"delta":{"text":` + strconv.Quote(part2) + `,"type":"text_delta"},"index":0,"type":"content_block_delta"}}`,
		`{"type":"result","subtype":"success","result":` + strconv.Quote(outJSON) + `}`,
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	_, err := r.RouteIntent(context.Background(), RouteInput{
		DialogueID: "dia_8", UserMessage: "x",
		ExistingApplications: sampleApps(), Blueprints: sampleBlueprints(),
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RouteIntent stream: %v", err)
	}
	var sawDelta, sawThinking bool
	for _, ev := range events {
		if ev.Type == "dialogue.route.delta" {
			sawDelta = true
			if strings.Contains(ev.Delta, "hidden internal reasoning") {
				t.Fatalf("thinking leaked into the .delta (analysis) channel: %q", ev.Delta)
			}
		}
		if ev.Type == "dialogue.route.thinking" {
			sawThinking = true
			if !strings.Contains(ev.Delta, "hidden internal reasoning") {
				t.Fatalf(".thinking channel must carry the raw reasoning, got %q", ev.Delta)
			}
		}
	}
	if !sawDelta {
		t.Fatalf("no dialogue.route.delta emitted for the safe output")
	}
	if !sawThinking {
		t.Fatalf("no dialogue.route.thinking emitted for thinking_delta (conversation surface streams thinking)")
	}
}

// --- business drafting: valid agentDraft ---

func TestBusinessDraftRoundProducesValidAgentDraft(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, BusinessDraftOutput{
		Status: "ready_to_confirm", Round: 1,
		WorkLog: []WorkLog{{Type: "analysis", Content: "已识别业务处理需求"}},
		AgentDraft: BusinessAgentDraft{
			Name:        "物资申请审批 agent",
			Description: "辅助审批物资申请",
			Prompt:      "你是物资申请审批助手。阅读申请内容，依据规则给出建议。",
		},
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunBusinessDraftRound(context.Background(), BusinessDraftInput{
		DialogueID: "dia_b1", Round: 1, MaxRounds: 6, UserMessage: "做一个物资审批 agent",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunBusinessDraftRound: %v", err)
	}
	if out.AgentDraft.Name == "" || out.AgentDraft.Prompt == "" {
		t.Fatalf("agentDraft incomplete: %+v", out.AgentDraft)
	}
	if out.Status != "ready_to_confirm" {
		t.Fatalf("status = %s", out.Status)
	}
	if len(events) == 0 {
		t.Fatalf("expected events")
	}
}

// --- business drafting: prompt does not imply execution ---

func TestBusinessDraftPromptSkillDoesNotImplyExecution(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, BusinessDraftOutput{
		Status: "ready_to_confirm", Round: 1,
		AgentDraft: BusinessAgentDraft{Name: "x", Description: "y", Prompt: "z"},
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RunBusinessDraftRound(context.Background(), BusinessDraftInput{
		DialogueID: "dia_b2", Round: 1, MaxRounds: 6, UserMessage: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunBusinessDraftRound: %v", err)
	}
	var promptText string
	for _, a := range fr.args {
		if strings.Contains(a, "business-agent-drafting") {
			promptText = a
			break
		}
	}
	if promptText == "" {
		t.Fatalf("prompt must reference business-agent-drafting skill")
	}
	// The prompt must instruct the model the draft prompt must not imply tool access/execution.
	if !strings.Contains(promptText, "tool access") || !strings.Contains(promptText, "execution") {
		t.Fatalf("prompt must forbid implying tool access/execution: %s", promptText)
	}
}

// --- business drafting: rejects >1 question ---

func TestBusinessDraftRoundRejectsMoreThanOneQuestion(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: mustJSON(t, BusinessDraftOutput{
		Status: "waiting_user", Round: 1,
		Questions: []Question{
			{ID: "q1", Required: true, Options: []Option{{Value: "a"}, {Value: "b"}}},
			{ID: "q2", Required: true, Options: []Option{{Value: "c"}, {Value: "d"}}},
		},
	})}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RunBusinessDraftRound(context.Background(), BusinessDraftInput{
		DialogueID: "dia_b3", Round: 1, MaxRounds: 6, UserMessage: "x",
	}, func(ev StreamEvent) {})
	if err == nil {
		t.Fatalf("expected error for >1 question")
	}
}

// --- business drafting: malformed JSON ---

func TestBusinessDraftRoundRejectsMalformedJSON(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: "garbage {{{"}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	_, err := r.RunBusinessDraftRound(context.Background(), BusinessDraftInput{
		DialogueID: "dia_b4", Round: 1, MaxRounds: 6, UserMessage: "x",
	}, func(ev StreamEvent) {})
	if err == nil {
		t.Fatalf("expected error for malformed JSON")
	}
}

func TestBusinessDraftRoundRetriesInvalidJSON(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdouts: []string{
		"不是 JSON",
		mustJSON(t, BusinessDraftOutput{
			Status: "ready_to_confirm", Round: 1,
			AgentDraft: BusinessAgentDraft{Name: "x", Description: "y", Prompt: "z"},
		}),
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunBusinessDraftRound(context.Background(), BusinessDraftInput{
		DialogueID: "dia_b_retry", Round: 1, MaxRounds: 6, UserMessage: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunBusinessDraftRound: %v", err)
	}
	if fr.calls != 2 {
		t.Fatalf("calls = %d, want 2", fr.calls)
	}
	if out.AgentDraft.Name != "x" {
		t.Fatalf("agentDraft = %+v, want retry output", out.AgentDraft)
	}
}

func TestClassifyTurnRetriesInvalidJSON(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdouts: []string{
		"先分析一下，不是 JSON",
		mustJSON(t, TurnSummary{Intent: model.TurnIntentGeneralDialogue, Reply: "ok"}),
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.ClassifyTurn(context.Background(), TurnInput{
		DialogueID: "dia_turn_retry", UserMessage: "继续",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("ClassifyTurn: %v", err)
	}
	if fr.calls != 2 {
		t.Fatalf("calls = %d, want 2", fr.calls)
	}
	if out.Intent != model.TurnIntentGeneralDialogue {
		t.Fatalf("intent = %s, want general_dialogue", out.Intent)
	}
}

// --- helpers ---

func argContains(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

func argHasDisallowed(args []string, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--disallowedTools" && args[i+1] == value {
			return true
		}
	}
	return false
}
