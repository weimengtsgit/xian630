package clarification

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

type fakeCommandRunner struct {
	dir  string
	name string
	args []string
	// rawStdout, when non-empty, is returned verbatim instead of the default
	// marshaled RoundOutput. Used for contract edge cases that the current Go
	// structs cannot yet express.
	rawStdout string
	// wrapStdout, when non-nil, transforms the marshaled RoundOutput before it
	// is returned as Stdout. Used to drive RunRound with fenced or prose-wrapped
	// JSON and prove the tolerant parser.
	wrapStdout func(string) string
}

func (f *fakeCommandRunner) Run(ctx context.Context, dir, name string, args ...string) (runner.CommandResult, error) {
	f.dir, f.name, f.args = dir, name, args
	if f.rawStdout != "" {
		return runner.CommandResult{Stdout: f.rawStdout, ExitCode: 0}, nil
	}
	out := RoundOutput{
		Status:                 "ready_to_confirm",
		Round:                  1,
		WorkLog:                []WorkLog{{Type: "analysis", Content: "识别到这是态势复盘类应用。"}},
		NormalizedScenarioName: "航母编队月度航迹复盘",
		Requirement: Requirement{
			AppType: "situation_replay", AppName: "航母编队月度航迹复盘",
			TargetUsers: []string{"态势分析人员"}, CoreScenario: "复盘近 1 个月航迹",
			PrimaryView: "地图 + 时间轴", MainEntities: []string{"编队", "事件"},
			DataPolicy: "mock_data", AcceptanceFocus: []string{"轨迹联动"},
			GenerationProfile: map[string][]string{
				"base":    []string{"software-factory-app"},
				"domain":  []string{"defense-operations-ui"},
				"pattern": []string{"map-timeline-replay"},
			},
			BlueprintRefs: []string{"carrier-formation-replay"},
		},
	}
	b, _ := json.Marshal(out)
	stdout := string(b)
	if f.wrapStdout != nil {
		stdout = f.wrapStdout(stdout)
	}
	return runner.CommandResult{Stdout: stdout, ExitCode: 0}, nil
}

type fakeStreamCommandRunner struct {
	dir      string
	name     string
	args     []string
	lines    []string
	exitCode int
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
	return runner.CommandResult{Stdout: stdout.String(), ExitCode: f.exitCode}, nil
}

func TestRunnerWritesArtifactsAndNormalizesEvents(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_1", Round: 1, MaxRounds: 3, InitialPrompt: "生成航母复盘应用",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.Status != "ready_to_confirm" {
		t.Fatalf("status = %s", out.Status)
	}
	if fr.name != "claude" {
		t.Fatalf("command = %s", fr.name)
	}
	// The prompt must be passed to claude as a positional argument. The fake
	// runner ignores args, so a regression that drops the prompt still passes
	// the rest of the suite — assert it is present here.
	var sawPromptArg bool
	for _, a := range fr.args {
		if strings.Contains(a, "requirement-clarification") {
			sawPromptArg = true
			break
		}
	}
	if !sawPromptArg {
		t.Fatalf("prompt was not passed as a positional argument; args = %v", fr.args)
	}
	for _, rel := range []string{"input.json", "prompt.md", "output.json", "stdout.log", "stderr.log", "stream.jsonl"} {
		if _, err := os.Stat(filepath.Join(root, ".factory-runs", "clarifications", "clar_1", "round-1", rel)); err != nil {
			t.Fatalf("missing %s: %v", rel, err)
		}
	}
	promptRaw, err := os.ReadFile(filepath.Join(root, ".factory-runs", "clarifications", "clar_1", "round-1", "prompt.md"))
	if err != nil {
		t.Fatalf("read prompt.md: %v", err)
	}
	promptText := string(promptRaw)
	if !strings.Contains(promptText, "requirement-clarification") {
		t.Fatalf("prompt should reference requirement-clarification skill: %s", promptText)
	}
	if len(events) == 0 {
		t.Fatalf("expected normalized events")
	}
	// Adaptive contract: blueprint recommendation events are gone (blueprints
	// are an internal Factory reference). Assert NO such event is emitted and
	// that the normalizedScenarioName is surfaced instead.
	for _, ev := range events {
		if ev.Type == "clarification.blueprint.recommended" {
			t.Fatalf("blueprint recommendation event must be removed in adaptive contract: %#v", ev)
		}
	}
}

func TestRunnerTreatsConfirmedOutputAsReadyToConfirm(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "confirmed",
  "round": 1,
  "workLog": [{"type":"ready","content":"需求规格已就绪"}],
  "questions": [],
  "requirement": {
    "appType": "command_dashboard",
    "appName": "潮汐窗口",
    "targetUsers": ["作战指挥人员"],
    "coreScenario": "四港潮汐窗口监控",
    "primaryView": "2x2 卡片矩阵",
    "mainEntities": ["港口","潮汐"],
    "dataPolicy": "mock_then_api",
    "acceptanceFocus": ["窗口计算"],
    "generationProfile": {"base":["software-factory-app"]}
  }
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_confirmed_status", Round: 1, MaxRounds: 3, InitialPrompt: "生成潮汐窗口应用",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.Status != "ready_to_confirm" {
		t.Fatalf("status = %q, want ready_to_confirm", out.Status)
	}
	var sawReady bool
	for _, ev := range events {
		if ev.Type == "clarification.ready_to_confirm" {
			sawReady = true
		}
		if ev.Type == "clarification.question.created" {
			t.Fatalf("unexpected question event for confirmed output: %#v", ev)
		}
	}
	if !sawReady {
		t.Fatalf("missing clarification.ready_to_confirm event; events=%#v", events)
	}
}

func TestPromptTextForcesSimplifiedChinese(t *testing.T) {
	r := Runner{}
	prompt := r.promptText(`C:\tmp\input.json`)
	for _, want := range []string{
		"Simplified Chinese",
		"workLog content",
		"question text",
		"recommendation copy",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

// TestRunnerParsesFencedJSON proves RunRound tolerates claude wrapping its
// stdout in a ```json … ``` markdown fence.
func TestRunnerParsesFencedJSON(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{wrapStdout: func(s string) string {
		return "```json\n" + s + "\n```"
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_fence", Round: 1, MaxRounds: 3, InitialPrompt: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.Status != "ready_to_confirm" {
		t.Fatalf("status = %s", out.Status)
	}
	if out.Requirement.AppType != "situation_replay" {
		t.Fatalf("apptype = %s", out.Requirement.AppType)
	}
	if out.NormalizedScenarioName != "航母编队月度航迹复盘" {
		t.Fatalf("normalizedScenarioName = %q", out.NormalizedScenarioName)
	}
	// output.json must hold the clean (re-marshaled) object, not the raw fence.
	raw, err := os.ReadFile(filepath.Join(root, ".factory-runs", "clarifications", "clar_fence", "round-1", "output.json"))
	if err != nil {
		t.Fatalf("read output.json: %v", err)
	}
	if strings.HasPrefix(string(raw), "```") {
		t.Fatalf("output.json still contains fence: %s", string(raw))
	}
}

// TestRunnerParsesProseWrappedJSON proves RunRound tolerates leading/trailing
// prose around the JSON object.
func TestRunnerParsesProseWrappedJSON(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{wrapStdout: func(s string) string {
		return "Sure, here is the clarification output:\n" + s + "\nLet me know if you need changes."
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_prose", Round: 1, MaxRounds: 3, InitialPrompt: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.Status != "ready_to_confirm" {
		t.Fatalf("status = %s", out.Status)
	}
	if out.Requirement.AppType != "situation_replay" {
		t.Fatalf("apptype = %s", out.Requirement.AppType)
	}
}

func TestRunnerParsesRecommendationArrayAndMarksRecommendedOptions(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"analysis","content":"需要确认验收重点"}],
  "questions": [{
    "id": "acceptance_focus",
    "label": "验收重点",
    "question": "您最关注哪些验收点?",
    "required": true,
    "recommendation": ["window_calculation", "status_display"],
    "multiSelect": true,
    "options": [
      {"value":"window_calculation","label":"窗口计算"},
      {"value":"status_display","label":"状态显示"},
      {"value":"refresh_mechanism","label":"刷新机制"}
    ],
    "allowCustom": true
  }],
  "requirement": {
    "appType":"command_dashboard",
    "appName":"航母母港潮汐窗口计算器",
    "targetUsers":[],
    "coreScenario":"潮汐窗口判断",
    "primaryView":"四格仪表盘",
    "mainEntities":["港口","潮高","窗口"],
    "dataPolicy":"live_api",
    "acceptanceFocus":[],
    "generationProfile":{"base":["software-factory-app"],"domain":["defense-operations-ui"],"pattern":["command-dashboard"]}
  }
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_multi", Round: 1, MaxRounds: 3, InitialPrompt: "x",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if got := []string(out.Questions[0].Recommendation); len(got) != 2 || got[0] != "window_calculation" || got[1] != "status_display" {
		t.Fatalf("recommendation = %#v", got)
	}
	if !out.Questions[0].MultiSelect {
		t.Fatalf("multiSelect = false, want true")
	}
	var questionEvent *Question
	for _, ev := range events {
		if ev.Type != "clarification.question.created" {
			continue
		}
		b, _ := json.Marshal(ev.Data)
		var q Question
		if err := json.Unmarshal(b, &q); err != nil {
			t.Fatalf("unmarshal question event: %v", err)
		}
		questionEvent = &q
		break
	}
	if questionEvent == nil {
		t.Fatalf("missing clarification.question.created; got %v", eventTypes(events))
	}
	if !questionEvent.Options[0].Recommended || !questionEvent.Options[1].Recommended || questionEvent.Options[2].Recommended {
		t.Fatalf("recommended options = %#v", questionEvent.Options)
	}
}

func TestRunnerUsesClaudeStreamJSONAndEmitsLiveOutputDeltas(t *testing.T) {
	root := t.TempDir()
	part1 := `{"status":"ready_to_confirm","round":1,"workLog":[{"type":"analysis","content":"已识别`
	part2 := `应用类型"}],"questions":[],"requirement":{"appType":"command_dashboard","appName":"潮汐窗口","targetUsers":["作战参谋"],"coreScenario":"计算出港窗口","primaryView":"四格仪表盘","mainEntities":["港口","潮汐"],"dataPolicy":"mock_data","acceptanceFocus":["窗口计算"],"generationProfile":{"base":["software-factory-app"],"domain":["defense-operations-ui"],"pattern":["command-dashboard"]}}}`
	fr := &fakeStreamCommandRunner{lines: []string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"stream_event","event":{"content_block":{"text":"","type":"text"},"index":0,"type":"content_block_start"}}`,
		`{"type":"stream_event","event":{"delta":{"text":` + strconv.Quote(part1) + `,"type":"text_delta"},"index":0,"type":"content_block_delta"}}`,
		`{"type":"stream_event","event":{"delta":{"thinking":"hidden reasoning must not be emitted","type":"thinking_delta"},"index":1,"type":"content_block_delta"}}`,
		`{"type":"stream_event","event":{"delta":{"text":` + strconv.Quote(part2) + `,"type":"text_delta"},"index":0,"type":"content_block_delta"}}`,
		`{"type":"result","subtype":"success","result":` + strconv.Quote(part1+part2) + `}`,
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_stream", Round: 1, MaxRounds: 3, InitialPrompt: "x",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.Requirement.AppName != "潮汐窗口" {
		t.Fatalf("appName = %s", out.Requirement.AppName)
	}
	if !contains(fr.args, "--output-format") || !contains(fr.args, "stream-json") || !contains(fr.args, "--include-partial-messages") || !contains(fr.args, "--verbose") {
		t.Fatalf("stream-json args missing: %v", fr.args)
	}
	var sawStarted, sawPartialText, sawCompleted bool
	for _, ev := range events {
		if ev.MessageID == "worklog_1" {
			t.Fatalf("streamed round must not emit duplicate normalized worklog messages after completion")
		}
		if ev.MessageID != "live_round_1" {
			continue
		}
		switch ev.Type {
		case "clarification.message.started":
			sawStarted = true
		case "clarification.message.delta":
			if strings.Contains(ev.Delta, "已接收") {
				t.Fatalf("delta should stream visible work-log text, not byte-count progress: %q", ev.Delta)
			}
			if strings.Contains(ev.Delta, "已识别") {
				sawPartialText = true
			}
			if strings.Contains(ev.Delta, "hidden reasoning") {
				t.Fatalf("thinking delta leaked into user-facing event: %q", ev.Delta)
			}
		case "clarification.message.completed":
			sawCompleted = true
		}
	}
	if !sawStarted || !sawPartialText || !sawCompleted {
		t.Fatalf("live stream events missing started=%v partialText=%v completed=%v; got %v", sawStarted, sawPartialText, sawCompleted, eventTypes(events))
	}
	// The model's raw reasoning streams on a dedicated .thinking channel (the
	// 思考过程 block) — separate from the safe .delta work-log above.
	var sawThinking bool
	for _, ev := range events {
		if ev.Type == "clarification.message.thinking" && strings.Contains(ev.Delta, "hidden reasoning") {
			sawThinking = true
		}
	}
	if !sawThinking {
		t.Fatalf("clarification.message.thinking must surface the model's reasoning (conversation streams thinking); events=%v", eventTypes(events))
	}
}

// TestRunnerSurfacesClaudeAPIErrorAsVisibleNotice proves that when the Claude
// Code CLI returns an upstream API error (here a GLM 529 overloaded) instead of
// a clarification document, the live completed event surfaces the real reason
// rather than the optimistic "结构化澄清结果接收完成，正在解析。" fallback — so the
// user sees why the round failed before the session flips to "已失败".
func TestRunnerSurfacesClaudeAPIErrorAsVisibleNotice(t *testing.T) {
	root := t.TempDir()
	apiErr := `API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][该模型当前访问量过大，请您稍后再试]"}}`
	fr := &fakeStreamCommandRunner{
		exitCode: 1,
		lines: []string{
			`{"type":"system","subtype":"init"}`,
			`{"type":"assistant","message":{"content":[{"type":"text","text":` + strconv.Quote(apiErr) + `}]}}`,
			`{"type":"result","subtype":"success","is_error":true,"result":` + strconv.Quote(apiErr) + `}`,
		},
	}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	_, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_err", Round: 1, MaxRounds: 3, InitialPrompt: "x",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err == nil {
		t.Fatalf("RunRound: expected error for API failure, got nil")
	}
	var completed *StreamEvent
	for i := range events {
		if events[i].Type == "clarification.message.completed" && events[i].MessageID == "live_round_1" {
			completed = &events[i]
			break
		}
	}
	if completed == nil {
		t.Fatalf("missing live_round_1 completed event; got %v", eventTypes(events))
	}
	wl, ok := completed.Data.(WorkLog)
	if !ok {
		t.Fatalf("completed event data is not a WorkLog: %#v", completed.Data)
	}
	if strings.Contains(wl.Content, "正在解析") {
		t.Fatalf("completed event still shows optimistic fallback: %q", wl.Content)
	}
	if !strings.Contains(wl.Content, "需求澄清失败") || !strings.Contains(wl.Content, "529") {
		t.Fatalf("completed event does not surface the real API error: %q", wl.Content)
	}
}

func TestRunnerParsesToolUseWrappedJSONFromAssistantEvent(t *testing.T) {
	root := t.TempDir()
	payload := `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [
    {
      "type": "analysis",
      "content": "Need one more clarification before generation."
    }
  ],
  "questions": [
    {
      "id": "deck_scope",
      "label": "Deck scope",
      "question": "Should the app show all carrier activity areas or a selected subset?",
      "required": true,
      "recommendation": "all_known_areas",
      "multiSelect": false,
      "options": [
        {
          "value": "all_known_areas",
          "label": "All known areas",
          "reason": "Matches the current request."
        }
      ],
      "allowCustom": false
    }
  ],
  "requirement": {
    "appType": "command_dashboard",
    "appName": "Deck Wind Calculator",
    "targetUsers": ["Operations staff"],
    "coreScenario": "Assess deck-wind feasibility by area",
    "primaryView": "Area list with wind and deck-wind range",
    "mainEntities": ["activity area", "wind field", "carrier"],
    "blueprintRefs": ["carrier-deck-wind-calculator"],
    "dataPolicy": "live_api",
    "acceptanceFocus": ["deck_wind_range"],
    "generationProfile": {
      "base": ["software-factory-app"],
      "domain": ["defense-operations-ui"],
      "pattern": ["command-dashboard"]
    }
  },
  "recommendedBlueprints": [
    {
      "slug": "carrier-deck-wind-calculator",
      "name": "Deck wind calculator",
      "appType": "command_dashboard",
      "reason": "Direct match for deck-wind monitoring.",
      "referenceKind": "structure|interaction|data-model|style"
    }
  ]
}`
	content := "Plan notes\n```json\n" + payload + "\n```"
	assistantLine := `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"C:\\\\temp\\\\output.json","content":` + strconv.Quote(content) + `}}]}}`
	fr := &fakeStreamCommandRunner{lines: []string{
		`{"type":"system","subtype":"init"}`,
		assistantLine,
	}}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_tool_use", Round: 1, MaxRounds: 3, InitialPrompt: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.Status != "waiting_user" {
		t.Fatalf("status = %q", out.Status)
	}
	if out.Requirement.AppName != "Deck Wind Calculator" {
		t.Fatalf("appName = %q", out.Requirement.AppName)
	}
	if len(out.Questions) != 1 || out.Questions[0].ID != "deck_scope" {
		t.Fatalf("questions = %#v", out.Questions)
	}
}

// eventTypes collects the Type field from a slice of events for failure messages.
func eventTypes(events []StreamEvent) []string {
	types := make([]string, len(events))
	for i, ev := range events {
		types[i] = ev.Type
	}
	return types
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// --- adaptive 6-round contract (Step 4) ---

// TestRunnerAcceptsAllQuestionsInOneRound proves the runner accepts a model
// round that emits ALL open high-impact questions at once (batch clarification)
// and passes every question through — the user confirms them in a single group.
func TestRunnerAcceptsAllQuestionsInOneRound(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"analysis","content":"分析中"}],
  "questions": [
    {"id":"q1","required":true,"options":[{"value":"a"},{"value":"b"}]},
    {"id":"q2","required":true,"options":[{"value":"c"},{"value":"d"}]}
  ],
  "requirement": {"appType":"command_dashboard","appName":"x"}
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_multi_q", Round: 1, MaxRounds: 6, InitialPrompt: "x",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("runner must accept multiple questions in one round (batch clarification): %v", err)
	}
	if len(out.Questions) != 2 {
		t.Fatalf("both questions must pass through, got %d", len(out.Questions))
	}
	// Both questions emit a created event so the portal renders them in one group.
	var created int
	for _, ev := range events {
		if ev.Type == "clarification.question.created" {
			created++
		}
	}
	if created != 2 {
		t.Fatalf("expected 2 question.created events (one per batched question), got %d", created)
	}
}

// TestRunnerAcceptsExactlyOneQuestion proves a valid one-decision round passes.
func TestRunnerAcceptsExactlyOneQuestion(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "waiting_user",
  "round": 1,
  "workLog": [{"type":"analysis","content":"需要确认应用类型"}],
  "questions": [
    {"id":"app_type","label":"应用类型","required":true,"recommendation":"command_dashboard","options":[{"value":"command_dashboard","label":"指挥仪表盘"},{"value":"situation_replay","label":"态势复盘"}],"allowCustom":false}
  ],
  "requirement": {"appType":"command_dashboard","appName":"潮汐窗口"}
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_one_q", Round: 1, MaxRounds: 6, InitialPrompt: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunRound one question: %v", err)
	}
	if len(out.Questions) != 1 {
		t.Fatalf("questions = %d, want 1", len(out.Questions))
	}
}

// TestRunnerEmitsConsolidationEvent proves a round-5 consolidation list is
// surfaced as a clarification.consolidation.updated event.
func TestRunnerEmitsConsolidationEvent(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "waiting_user",
  "round": 5,
  "workLog": [{"type":"analysis","content":"汇总推荐"}],
  "questions": [],
  "consolidation": [
    {"field":"primaryView","recommendedValue":"四格仪表盘","reason":"匹配指挥决策","alternatives":["列表"]},
    {"field":"dataPolicy","recommendedValue":"mock_data","reason":"先验数据","alternatives":["live_api"]}
  ],
  "requirement": {"appType":"command_dashboard","appName":"潮汐窗口"}
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	_, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_consol", Round: 5, MaxRounds: 6, InitialPrompt: "x",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunRound consolidation: %v", err)
	}
	var sawConsolidation bool
	for _, ev := range events {
		if ev.Type == "clarification.consolidation.updated" {
			sawConsolidation = true
			b, _ := json.Marshal(ev.Data)
			var entries []ConsolidationEntry
			if err := json.Unmarshal(b, &entries); err != nil {
				t.Fatalf("unmarshal consolidation event: %v", err)
			}
			if len(entries) != 2 || entries[0].Field != "primaryView" {
				t.Fatalf("consolidation entries = %+v", entries)
			}
		}
	}
	if !sawConsolidation {
		t.Fatalf("missing clarification.consolidation.updated; got %v", eventTypes(events))
	}
}

// TestApplyConsolidationAdjustment proves the round-6 merge: only the selected
// field is overridden; every other missing field takes its persisted
// recommended value; the result is ready_to_confirm. No model turn is invoked.
func TestApplyConsolidationAdjustment(t *testing.T) {
	base := Requirement{
		AppType: "command_dashboard", AppName: "潮汐窗口计算器",
		TargetUsers: []string{"作战参谋"}, CoreScenario: "计算出港窗口",
		GenerationProfile: map[string][]string{"base": {"software-factory-app"}},
	}
	consolidation := []ConsolidationEntry{
		{Field: "primaryView", RecommendedValue: json.RawMessage(`"四格仪表盘"`), Reason: "r", Alternatives: []string{"列表"}},
		{Field: "mainEntities", RecommendedValue: json.RawMessage(`["港口","潮汐","窗口"]`), Reason: "r"},
		{Field: "dataPolicy", RecommendedValue: json.RawMessage(`"mock_data"`), Reason: "r"},
		{Field: "acceptanceFocus", RecommendedValue: json.RawMessage(`["窗口计算"]`), Reason: "r"},
	}
	// User adjusts primaryView away from the recommendation.
	merged, err := ApplyConsolidationAdjustment(base, consolidation, "primaryView", "双屏对比")
	if err != nil {
		t.Fatalf("ApplyConsolidationAdjustment: %v", err)
	}
	if merged.PrimaryView != "双屏对比" {
		t.Fatalf("selected field should be overridden, got %q", merged.PrimaryView)
	}
	// Other missing fields take their recommended values.
	if merged.DataPolicy != "mock_data" {
		t.Fatalf("dataPolicy should be merged recommended value, got %q", merged.DataPolicy)
	}
	if len(merged.MainEntities) != 3 || merged.MainEntities[0] != "港口" {
		t.Fatalf("mainEntities should be merged: %+v", merged.MainEntities)
	}
	if len(merged.AcceptanceFocus) != 1 || merged.AcceptanceFocus[0] != "窗口计算" {
		t.Fatalf("acceptanceFocus should be merged: %+v", merged.AcceptanceFocus)
	}
}

// TestApplyConsolidationAdjustmentRejectsUnknownField proves only a known field
// (present in the consolidation list) may be adjusted.
func TestApplyConsolidationAdjustmentRejectsUnknownField(t *testing.T) {
	consolidation := []ConsolidationEntry{
		{Field: "primaryView", RecommendedValue: json.RawMessage(`"x"`)},
	}
	_, err := ApplyConsolidationAdjustment(Requirement{}, consolidation, "notInList", "v")
	if err == nil {
		t.Fatalf("expected error for field not in consolidation list")
	}
}

// TestApplyConsolidationAdjustmentRejectsInvalidValue proves a malformed
// recommendedValue is rejected rather than silently dropped.
func TestApplyConsolidationAdjustmentRejectsInvalidValue(t *testing.T) {
	consolidation := []ConsolidationEntry{
		{Field: "primaryView", RecommendedValue: json.RawMessage(`{broken`), Reason: "r"},
	}
	_, err := ApplyConsolidationAdjustment(Requirement{}, consolidation, "primaryView", "v")
	if err == nil {
		t.Fatalf("expected error for malformed recommendedValue")
	}
}

// TestRunnerRedactsBlueprintRefsFromUserFacingEvents proves the
// clarification.summary.updated and clarification.ready_to_confirm events do
// NOT leak the internal blueprintRefs (hidden Factory slugs). The persisted
// RoundOutput.Requirement must STILL carry blueprintRefs server-side.
func TestRunnerRedactsBlueprintRefsFromUserFacingEvents(t *testing.T) {
	root := t.TempDir()
	// A ready_to_confirm round whose persisted requirement carries an internal
	// blueprint slug that must never reach the frontend.
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "ready_to_confirm",
  "round": 1,
  "workLog": [{"type":"ready","content":"ok"}],
  "questions": [],
  "requirement": {
    "appType":"command_dashboard","appName":"潮汐窗口","targetUsers":["作战参谋"],
    "coreScenario":"窗口计算","primaryView":"四格仪表盘","mainEntities":["港口","潮汐"],
    "dataPolicy":"mock_data","acceptanceFocus":["窗口计算"],
    "generationProfile":{"base":["software-factory-app"]},
    "blueprintRefs":["carrier-homeport-tide-window"]
  }
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	var events []StreamEvent
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_redact", Round: 1, MaxRounds: 6, InitialPrompt: "x",
	}, func(ev StreamEvent) { events = append(events, ev) })
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	// (3) Server-side retention: the returned requirement still has the slug.
	if len(out.Requirement.BlueprintRefs) != 1 || out.Requirement.BlueprintRefs[0] != "carrier-homeport-tide-window" {
		t.Fatalf("server-side BlueprintRefs must be retained, got %+v", out.Requirement.BlueprintRefs)
	}
	// output.json must also retain blueprintRefs (persisted metadata).
	raw, err := os.ReadFile(filepath.Join(root, ".factory-runs", "clarifications", "clar_redact", "round-1", "output.json"))
	if err != nil {
		t.Fatalf("read output.json: %v", err)
	}
	if !strings.Contains(string(raw), "blueprintRefs") {
		t.Fatalf("output.json must retain blueprintRefs server-side")
	}
	const slug = "carrier-homeport-tide-window"
	var sawSummary, sawReady bool
	for _, ev := range events {
		switch ev.Type {
		case "clarification.summary.updated":
			sawSummary = true
			b, _ := json.Marshal(ev.Data)
			body := string(b)
			if strings.Contains(body, "blueprintRefs") {
				t.Fatalf("clarification.summary.updated leaks blueprintRefs: %s", body)
			}
			if strings.Contains(body, slug) {
				t.Fatalf("clarification.summary.updated leaks blueprint slug: %s", body)
			}
		case "clarification.ready_to_confirm":
			sawReady = true
			b, _ := json.Marshal(ev.Data)
			body := string(b)
			if strings.Contains(body, "blueprintRefs") {
				t.Fatalf("clarification.ready_to_confirm leaks blueprintRefs: %s", body)
			}
			if strings.Contains(body, slug) {
				t.Fatalf("clarification.ready_to_confirm leaks blueprint slug: %s", body)
			}
		}
	}
	if !sawSummary {
		t.Fatalf("missing clarification.summary.updated; got %v", eventTypes(events))
	}
	if !sawReady {
		t.Fatalf("missing clarification.ready_to_confirm; got %v", eventTypes(events))
	}
}

// TestRunnerSurfacesNormalizedScenarioName proves the scenario name is carried
// on the round output for Task 4 to append the Base36 serial.
func TestRunnerSurfacesNormalizedScenarioName(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "ready_to_confirm",
  "round": 1,
  "normalizedScenarioName": "潮汐窗口计算",
  "workLog": [{"type":"ready","content":"ok"}],
  "questions": [],
  "requirement": {"appType":"command_dashboard","appName":"潮汐窗口","targetUsers":["x"],"coreScenario":"y","primaryView":"z","mainEntities":["a"],"dataPolicy":"mock_data","acceptanceFocus":["b"],"generationProfile":{"base":["software-factory-app"]}}
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_name", Round: 1, MaxRounds: 6, InitialPrompt: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if out.NormalizedScenarioName != "潮汐窗口计算" {
		t.Fatalf("normalizedScenarioName = %q", out.NormalizedScenarioName)
	}
	// Must NOT contain a Base36 serial appended here (Factory does that in Task 4).
	if strings.ContainsAny(out.NormalizedScenarioName, "0123456789") {
		t.Fatalf("scenario name must not include serial here: %q", out.NormalizedScenarioName)
	}
}

// TestNormalizeHighImpactStructuralValidation asserts the runner parses and
// validates openHighImpact entries (D3). Each surviving entry must have a
// non-empty id+label, at most 3 options each with a value+label, and no internal
// slug patterns. Malformed entries are dropped, not fatal.
func TestNormalizeHighImpactStructuralValidation(t *testing.T) {
	t.Run("keeps valid entries and caps options at 3", func(t *testing.T) {
		got := normalizeHighImpact([]HighImpactItem{
			{
				ID: "data_policy", Label: "数据来源策略", Recommendation: "mock_data",
				Options: []Option{
					{Value: "mock_data", Label: "Mock 数据优先"},
					{Value: "api_first", Label: "接口数据优先"},
					{Value: "manual", Label: "手动录入"},
					{Value: "extra", Label: "多余选项应被截断"},
				},
			},
			{ID: "scope", Label: "应用范围"},
		})
		if len(got) != 2 {
			t.Fatalf("len = %d, want 2: %#v", len(got), got)
		}
		if len(got[0].Options) != 3 {
			t.Fatalf("options = %d, want capped at 3", len(got[0].Options))
		}
		if got[0].Recommendation != "mock_data" {
			t.Fatalf("recommendation lost: %q", got[0].Recommendation)
		}
	})

	t.Run("drops entries missing id or label", func(t *testing.T) {
		got := normalizeHighImpact([]HighImpactItem{
			{ID: "", Label: "无 id"},
			{ID: "no_label", Label: "  "},
			{ID: "ok", Label: "正常"},
		})
		if len(got) != 1 || got[0].ID != "ok" {
			t.Fatalf("got = %#v, want only the ok entry", got)
		}
	})

	t.Run("drops internal slug-looking values", func(t *testing.T) {
		got := normalizeHighImpact([]HighImpactItem{
			{ID: "software-factory-app", Label: "内部 slug 当 id"},
			{ID: "ok", Label: "normal"},
		})
		if len(got) != 1 || got[0].ID != "ok" {
			t.Fatalf("got = %#v, want internal-slug id dropped", got)
		}
		// An option value that is an internal slug must also be dropped.
		got2 := normalizeHighImpact([]HighImpactItem{
			{ID: "ok", Label: "正常", Options: []Option{
				{Value: "carrier-formation-replay", Label: "slug option"},
				{Value: "real_value", Label: "真选项"},
			}},
		})
		if len(got2[0].Options) != 1 || got2[0].Options[0].Value != "real_value" {
			t.Fatalf("slug option not dropped: %#v", got2[0].Options)
		}
	})

	t.Run("dedupes by id", func(t *testing.T) {
		got := normalizeHighImpact([]HighImpactItem{
			{ID: "dup", Label: "一"},
			{ID: "dup", Label: "二"},
		})
		if len(got) != 1 {
			t.Fatalf("got = %#v, want deduped to 1", got)
		}
	})

	t.Run("nil/empty in returns nil", func(t *testing.T) {
		if got := normalizeHighImpact(nil); got != nil {
			t.Fatalf("nil in must yield nil, got %#v", got)
		}
		if got := normalizeHighImpact([]HighImpactItem{{ID: "", Label: ""}}); got != nil {
			t.Fatalf("all-invalid in must yield nil, got %#v", got)
		}
	})

	t.Run("plain Chinese user language is never treated as a slug", func(t *testing.T) {
		if looksLikeInternalSlug("数据策略") {
			t.Fatal("Chinese must not match slug heuristic")
		}
		if looksLikeInternalSlug("Mock 数据优先") {
			t.Fatal("mixed Chinese must not match slug heuristic")
		}
		if !looksLikeInternalSlug("command-dashboard") {
			t.Fatal("snake/kebab slug must match")
		}
	})
}

// TestRunnerParsesOpenHighImpact proves RunRound decodes openHighImpact from the
// skill JSON and validates it, and that a round returning BOTH a complete
// requirement AND a non-empty openHighImpact does NOT short-circuit: the output
// still carries the open list (the handler, not the runner, decides the gate).
func TestRunnerParsesOpenHighImpact(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "ready_to_confirm",
  "round": 1,
  "workLog": [{"type":"ready","content":"需求已收敛"}],
  "questions": [],
  "requirement": {
    "appType": "command_dashboard","appName": "潮汐窗口","targetUsers": ["作战指挥人员"],
    "coreScenario": "潮汐监控","primaryView": "卡片","mainEntities": ["港口"],
    "dataPolicy": "mock_data","acceptanceFocus": ["窗口"],"generationProfile": {"base":["software-factory-app"]}
  },
  "openHighImpact": [
    {"id": "data_policy","label": "数据来源策略","recommendation": "mock_data",
     "options": [{"value":"mock_data","label":"Mock 数据优先"},{"value":"api_first","label":"接口优先"}]},
    {"id": "scope","label": "应用范围","options": [{"value":"all","label":"全部"},{"value":"part","label":"部分"}]}
  ]
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_hi", Round: 1, MaxRounds: 6, InitialPrompt: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	// The complete requirement does NOT clear openHighImpact: the runner carries
	// it verbatim (validated) so the handler can apply the gate. This is the core
	// D3 invariant: a complete requirement is not a confirmed high-impact decision.
	if len(out.OpenHighImpact) != 2 {
		t.Fatalf("openHighImpact len = %d, want 2: %#v", len(out.OpenHighImpact), out.OpenHighImpact)
	}
	if out.OpenHighImpact[0].ID != "data_policy" {
		t.Fatalf("first item id = %q", out.OpenHighImpact[0].ID)
	}
	if out.OpenHighImpact[0].Recommendation != "mock_data" {
		t.Fatalf("recommendation lost: %q", out.OpenHighImpact[0].Recommendation)
	}
	if len(out.OpenHighImpact[0].Options) != 2 {
		t.Fatalf("options len = %d", len(out.OpenHighImpact[0].Options))
	}
}

// TestRunnerDropsMalformedHighImpact proves a model round emitting a malformed
// openHighImpact entry (missing label, internal slug) still produces a usable
// round: the malformed entry is dropped, the valid one survives.
func TestRunnerDropsMalformedHighImpact(t *testing.T) {
	root := t.TempDir()
	fr := &fakeCommandRunner{rawStdout: `{
  "status": "waiting_user","round": 1,
  "workLog": [{"type":"analysis","content":"x"}],
  "questions": [],
  "requirement": {"appType":"command_dashboard","generationProfile": {"base":["software-factory-app"]}},
  "openHighImpact": [
    {"id": "","label": "no id"},
    {"id": "software-factory-app","label": "slug"},
    {"id": "real","label": "真高影响项","options": [{"value":"a","label":"甲"},{"value":"b","label":"乙"}]}
  ]
}`}
	r := Runner{Cmd: fr, WorkspaceRoot: root, ArtifactRoot: filepath.Join(root, ".factory-runs")}
	out, err := r.RunRound(context.Background(), RoundInput{
		SessionID: "clar_hi_mal", Round: 1, MaxRounds: 6, InitialPrompt: "x",
	}, func(ev StreamEvent) {})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if len(out.OpenHighImpact) != 1 || out.OpenHighImpact[0].ID != "real" {
		t.Fatalf("only the valid item should survive: %#v", out.OpenHighImpact)
	}
}
