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
		Status:  "ready_to_confirm",
		Round:   1,
		WorkLog: []WorkLog{{Type: "analysis", Content: "识别到这是态势复盘类应用。"}},
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
		RecommendedBlueprints: []BlueprintRef{{
			Slug:          "carrier-formation-replay",
			Name:          "航母编队月度航迹复盘",
			AppType:       "situation_replay",
			Reason:        "近一月编队航迹复盘匹配",
			ReferenceKind: "structure|interaction|data-model|style",
		}},
	}
	b, _ := json.Marshal(out)
	stdout := string(b)
	if f.wrapStdout != nil {
		stdout = f.wrapStdout(stdout)
	}
	return runner.CommandResult{Stdout: stdout, ExitCode: 0}, nil
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
	// The blueprint catalog branch: a clarification.blueprint.recommended event
	// must be present whenever RecommendedBlueprints is non-empty.
	var sawBlueprint bool
	for _, ev := range events {
		if ev.Type == "clarification.blueprint.recommended" {
			sawBlueprint = true
			break
		}
	}
	if !sawBlueprint {
		t.Fatalf("expected clarification.blueprint.recommended event, got types: %v", eventTypes(events))
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
	if len(out.RecommendedBlueprints) != 1 || out.RecommendedBlueprints[0].Slug != "carrier-formation-replay" {
		t.Fatalf("blueprints = %+v", out.RecommendedBlueprints)
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
