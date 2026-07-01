package runner

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func writeJSON(t *testing.T, dir, name string, content []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

func TestValidateRequirementAnalysisMissingFile(t *testing.T) {
	_, err := ValidateRequirementAnalysis(filepath.Join(t.TempDir(), "nope.json"))
	if !errors.Is(err, ErrOutputMissing) {
		t.Fatalf("err = %v, want ErrOutputMissing", err)
	}
}

func TestValidateRequirementAnalysisInvalidJSON(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte("{not json"))
	_, err := ValidateRequirementAnalysis(p)
	if !errors.Is(err, ErrOutputInvalidJSON) {
		t.Fatalf("err = %v, want ErrOutputInvalidJSON", err)
	}
}

// TestValidateRequirementAnalysisNeedsUserInput was renamed/repurposed for the
// Task-5 freeze contract. The old contract emitted {needsUserInput, questions}
// and the validator surfaced that as a pause; the new contract hard-fails
// instead. A frozen-requirement output that lacks the validation block (the old
// shape) MUST now be rejected with ErrSchemaValidationFailed — there is no
// clarification path inside the pipeline step.
func TestValidateRequirementAnalysisNeedsUserInput(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"summary": "x", "needsUserInput": true,
		"questions": [{"id":"q1","question":"how big?","defaultAnswer":"5"}]
	}`))
	_, err := ValidateRequirementAnalysis(p)
	if err == nil {
		t.Fatal("err = nil, want rejection of legacy needsUserInput shape (no clarification path in the freeze step)")
	}
	// decode is lenient (unknown fields ignored), so the legacy shape decodes
	// fine and is rejected by the validation rules: no validation block means
	// validation.complete=false → ErrSchemaValidationFailed. The point of this
	// test is that the old clarify-then-pause contract is gone.
	if !errors.Is(err, ErrSchemaValidationFailed) && !errors.Is(err, ErrOutputInvalidJSON) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed or ErrOutputInvalidJSON", err)
	}
}

// TestValidateRequirementAnalysisRequiresFrozenRequirement is the new happy
// path: a fully-frozen, validated requirement output passes and produces no
// waiting_user signal.
func TestValidateRequirementAnalysisRequiresFrozenRequirement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output.json")
	if err := os.WriteFile(path, []byte(`{
	  "confirmedRequirementId":"clar_1",
	  "summary":"复盘近 1 个月东海方向航母编队航迹",
	  "appType":"situation_replay",
	  "appName":"航母编队月度航迹复盘",
	  "targetUsers":["态势分析人员"],
	  "coreScenario":"复盘近 1 个月航迹",
	  "primaryView":"地图 + 时间轴",
	  "mainEntities":["编队","事件"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["轨迹联动"],
	  "generationProfile":{"base":["software-factory-app"],"domain":["defense-operations-ui"],"pattern":["map-timeline-replay"]},
	  "constraints":["React + Vite"],
	  "risks":["真实数据未接入"],
	  "validation":{"complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[]}
	}`), 0644); err != nil {
		t.Fatal(err)
	}
	out, err := ValidateRequirementAnalysis(path)
	if err != nil {
		t.Fatalf("ValidateRequirementAnalysis: %v", err)
	}
	if out.NeedsUserInput {
		t.Fatalf("NeedsUserInput = true, want false")
	}
}

// TestValidateRequirementAnalysisToleratesExtraFields is the regression test for
// the LLM adding audit detail the frozen struct does not model. The
// requirement_analysis prompt asks the agent to AUDIT blueprintRefs + skills,
// and a thorough agent emits extra fields (top-level blueprintRefs,
// validation.blueprintRefsAudit, validation.skillsAudit) on an otherwise-valid,
// complete, supported frozen requirement. readAndDecode ignores unknown fields
// by design, so this output must decode AND pass validation rather than fail as
// output_invalid_json. (Mirrors the real job_290ab010… failure.)
func TestValidateRequirementAnalysisToleratesExtraFields(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
	  "confirmedRequirementId":"clar_1",
	  "summary":"航母母港潮汐窗口计算器",
	  "appType":"command_dashboard",
	  "appName":"航母母港潮汐窗口计算器",
	  "targetUsers":["commanders"],
	  "coreScenario":"监控四大航母母港潮汐数据",
	  "primaryView":"2×2港口卡片矩阵看板",
	  "mainEntities":["四大母港","潮汐数据"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["window_calculation_accuracy"],
	  "generationProfile":{"base":["software-factory-app"],"domain":["defense-operations-ui"],"pattern":["command-dashboard"]},
	  "blueprintRefs":["carrier-homeport-tide-window"],
	  "constraints":[],
	  "risks":[],
	  "validation":{
	    "complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[],
	    "blueprintRefsAudit":{"carrier-homeport-tide-window":{"exists":true,"type":"reference-only"}},
	    "skillsAudit":{"software-factory-app":{"exists":true,"path":".claude/skills/software-factory-app/SKILL.md"}}
	  }
	}`))
	out, err := ValidateRequirementAnalysis(p)
	if err != nil {
		t.Fatalf("ValidateRequirementAnalysis: %v, want nil (extra LLM audit fields must be tolerated)", err)
	}
	if out.NeedsUserInput {
		t.Fatalf("NeedsUserInput = true, want false")
	}
}

func TestValidateRequirementAnalysisToleratesFencedJSONAndStructuredRisks(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte("```json\n"+`{
	  "confirmedRequirementId":"job_290ab010e9b56d3a914ef8e0",
	  "summary":"航母母港潮汐窗口计算器",
	  "appType":"command_dashboard",
	  "appName":"航母母港潮汐窗口计算器",
	  "targetUsers":["commanders"],
	  "coreScenario":"监控四大航母母港潮汐数据",
	  "primaryView":"2×2港口卡片矩阵看板",
	  "mainEntities":["四大母港","潮汐数据"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["window_calculation_accuracy"],
	  "generationProfile":{"base":["software-factory-app"],"domain":["defense-operations-ui"],"pattern":["command-dashboard"]},
	  "blueprintRefs":["carrier-homeport-tide-window"],
	  "constraints":["吃水阈值固定为12.8米"],
	  "risks":[
	    {"category":"data_accuracy","description":"mock 数据可能无法完全模拟真实 API","mitigation":"预留真实数据源接口"}
	  ],
	  "validation":{"complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[]}
	}`+"\n```"))
	out, err := ValidateRequirementAnalysis(p)
	if err != nil {
		t.Fatalf("ValidateRequirementAnalysis: %v, want nil for fenced JSON with structured risks", err)
	}
	if out.NeedsUserInput {
		t.Fatalf("NeedsUserInput = true, want false")
	}
}

// TestReadAndDecodeToleratesProseLeadingFencedJSON mirrors the real
// code_generation output_invalid_json failure: when an agent cannot write files
// it sometimes emits explanatory prose with the intended output.json buried in a
// ```json fence mid-document. ReadAndDecode must extract the object from under
// the leading prose (extractJSONObject finds the first '{') and decode it
// leniently, not fail from-offset. This is the decoder finishCodeGeneration now
// uses, so this locks code_generation's tolerance to the same shape.
func TestReadAndDecodeToleratesProseLeadingFencedJSON(t *testing.T) {
	doc := "我明白了问题所在。系统处于 thinking mode，plan mode 阻止写入。\n\n" +
		"### output.json 内容\n\n```json\n" +
		`{"projectDir":"generated-apps/carrier-homeport-tide-window",` +
		`"createdFiles":["generated-apps/carrier-homeport-tide-window/.factory/app.json",` +
		`"generated-apps/carrier-homeport-tide-window/src/App.jsx"],` +
		`"usedSkills":["/Users/x/x/.claude/skills/software-factory-app/SKILL.md"],` +
		`"auditNote":"extra field the strict decoder used to reject"}` +
		"\n```\n\n### 部署说明\n\n```bash\nnpm install\n```\n"
	p := writeJSON(t, t.TempDir(), "output.json", []byte(doc))
	var got struct {
		ProjectDir string   `json:"projectDir"`
		UsedSkills []string `json:"usedSkills"`
	}
	if err := ReadAndDecode(p, &got); err != nil {
		t.Fatalf("ReadAndDecode: %v, want nil for prose-leading fenced JSON", err)
	}
	if got.ProjectDir != "generated-apps/carrier-homeport-tide-window" {
		t.Fatalf("ProjectDir = %q", got.ProjectDir)
	}
	if len(got.UsedSkills) != 1 {
		t.Fatalf("UsedSkills = %v", got.UsedSkills)
	}
}

func TestReadAndDecodeRepairsUnescapedQuotesInsideStringValues(t *testing.T) {
	doc := "Here is the solution design:\n\n```json\n" +
		`{"needsUserInput":false,"questions":[],"usedSkills":["skill"],` +
		`"app":{"description":"区分"无弹射器辅助起飞"与"安全着舰"双条件判定"}}` +
		"\n```"
	p := writeJSON(t, t.TempDir(), "output.json", []byte(doc))
	var got struct {
		App struct {
			Description string `json:"description"`
		} `json:"app"`
	}
	if err := ReadAndDecode(p, &got); err != nil {
		t.Fatalf("ReadAndDecode: %v, want nil for unescaped quotes inside a string value", err)
	}
	if got.App.Description != `区分"无弹射器辅助起飞"与"安全着舰"双条件判定` {
		t.Fatalf("Description = %q", got.App.Description)
	}
}

// TestValidateRequirementAnalysisRejectedRequirement proves the hard-fail rule:
// a structurally-valid frozen output whose validation reports complete=false or
// supported=false is rejected with ErrSchemaValidationFailed (the step must NOT
// pause for clarification — it fails the pipeline). The rejection reason must
// be surfaced in the error so the user knows why.
func TestValidateRequirementAnalysisRejectedRequirement(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
	  "confirmedRequirementId":"clar_2",
	  "summary":"需求不完整",
	  "appType":"situation_replay",
	  "appName":"demo",
	  "generationProfile":{"base":["software-factory-app"]},
	  "validation":{"complete":false,"supported":true,"missingFields":["coreScenario"],"unsupportedRequests":[]}
	}`))
	_, err := ValidateRequirementAnalysis(p)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for validation.complete=false", err)
	}
	if !strings.Contains(err.Error(), "coreScenario") {
		t.Fatalf("rejection error should surface missing field coreScenario; got: %v", err)
	}

	p2 := writeJSON(t, t.TempDir(), "output.json", []byte(`{
	  "confirmedRequirementId":"clar_3",
	  "summary":"超出能力边界",
	  "appType":"unknown_type",
	  "appName":"demo",
	  "generationProfile":{"base":["software-factory-app"]},
	  "validation":{"complete":true,"supported":false,"missingFields":[],"unsupportedRequests":["real-time satellite feed"]}
	}`))
	_, err = ValidateRequirementAnalysis(p2)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for validation.supported=false", err)
	}
	if !strings.Contains(err.Error(), "real-time satellite feed") {
		t.Fatalf("rejection error should surface unsupported request; got: %v", err)
	}
}

func TestValidateSolutionDesignHappy(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"needsUserInput": false,
		"usedSkills": [".claude/skills/software-factory-app/SKILL.md"]
	}`))
	out, err := ValidateSolutionDesign(p)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if out.NeedsUserInput {
		t.Fatal("NeedsUserInput = true, want false")
	}
}

// TestSolutionDesignQuestionNormalizesAlternateFields proves the Question
// decoder tolerates the model's alternate field names: question text under
// `text` (not `question`) and option identity under `id` (not `value`). Without
// this the clarification card loses its question text and option values.
func TestSolutionDesignQuestionNormalizesAlternateFields(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"needsUserInput": true,
		"usedSkills": [".claude/skills/software-factory-app/SKILL.md"],
		"questions": [
			{
				"id": "q1",
				"text": "用演示数据还是真实API？",
				"options": [
					{"id": "mock", "label": "演示数据"},
					{"id": "api", "label": "真实API"}
				]
			}
		]
	}`))
	out, err := ValidateSolutionDesign(p)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(out.Questions) != 1 {
		t.Fatalf("questions = %d, want 1", len(out.Questions))
	}
	q := out.Questions[0]
	if q.Question != "用演示数据还是真实API？" {
		t.Fatalf("question text = %q, want normalized from `text`", q.Question)
	}
	if len(q.Options) != 2 {
		t.Fatalf("options = %d, want 2", len(q.Options))
	}
	if q.Options[0].Value != "mock" {
		t.Fatalf("option[0].value = %q, want normalized from `id`", q.Options[0].Value)
	}
	if q.Options[0].Label != "演示数据" {
		t.Fatalf("option[0].label = %q", q.Options[0].Label)
	}
}

// TestValidateSolutionDesignRequiresUsedSkills proves the Task-6 contract: a
// solution_design output that loaded+followed no project-local skills is
// rejected with ErrSchemaValidationFailed. The generative steps must report
// which skills they actually used.
func TestValidateSolutionDesignRequiresUsedSkills(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"needsUserInput": false
	}`))
	_, err := ValidateSolutionDesign(p)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for missing usedSkills", err)
	}
}

func TestValidateSolutionDesignEmptyUsedSkillsRejected(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"needsUserInput": false,
		"usedSkills": []
	}`))
	_, err := ValidateSolutionDesign(p)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for empty usedSkills", err)
	}
}

func TestValidateCodeGenerationMissingManifest(t *testing.T) {
	dir := t.TempDir()
	out := writeJSON(t, dir, "output.json", []byte(`{
		"projectDir": "generated-apps/slug",
		"needsUserInput": false,
		"usedSkills": [".claude/skills/software-factory-app/SKILL.md"]
	}`))
	projectDir := t.TempDir() // .factory/app.json absent
	_, err := ValidateCodeGeneration(out, projectDir)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed", err)
	}
}

func TestValidateCodeGenerationManifestPresent(t *testing.T) {
	dir := t.TempDir()
	out := writeJSON(t, dir, "output.json", []byte(`{
		"projectDir": "generated-apps/slug",
		"needsUserInput": false,
		"usedSkills": [".claude/skills/software-factory-app/SKILL.md"]
	}`))
	projectDir := t.TempDir()
	manifestDir := filepath.Join(projectDir, ".factory")
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "app.json"), []byte(validGeneratedManifest("generated-apps/slug")), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ValidateCodeGeneration(out, projectDir)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if res.NeedsUserInput {
		t.Fatal("NeedsUserInput = true, want false")
	}
}

func TestValidateCodeGenerationRejectsInvalidManifest(t *testing.T) {
	dir := t.TempDir()
	out := writeJSON(t, dir, "output.json", []byte(`{
		"projectDir": "generated-apps/slug",
		"needsUserInput": false,
		"usedSkills": [".claude/skills/software-factory-app/SKILL.md"]
	}`))
	projectDir := t.TempDir()
	manifestDir := filepath.Join(projectDir, ".factory")
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "app.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := ValidateCodeGeneration(out, projectDir)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed", err)
	}
}

// TestValidateCodeGenerationRequiresUsedSkills proves the Task-6 contract:
// code_generation must report which project-local skills it loaded+followed.
// An output without usedSkills is rejected with ErrSchemaValidationFailed,
// independent of the manifest check.
func TestValidateCodeGenerationRequiresUsedSkills(t *testing.T) {
	dir := t.TempDir()
	out := writeJSON(t, dir, "output.json", []byte(`{
		"projectDir": "generated-apps/slug",
		"needsUserInput": false
	}`))
	projectDir := t.TempDir()
	manifestDir := filepath.Join(projectDir, ".factory")
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "app.json"), []byte(validGeneratedManifest("generated-apps/slug")), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := ValidateCodeGeneration(out, projectDir)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed for missing usedSkills", err)
	}
}

func validGeneratedManifest(path string) string {
	return `{
		"schemaVersion": 1,
		"slug": "slug",
		"name": "Generated App",
		"type": "command-dashboard",
		"source": "generated",
		"description": "generated by test",
		"entry": "static-vite",
		"path": "` + path + `",
		"build": {"command": "npm run build", "outputDir": "dist"},
		"runtime": {"devCommand": "npm run dev", "defaultPort": 5173},
		"docker": {"enabled": true, "dockerfile": "Dockerfile", "context": ".", "runtimePort": 80}
	}`
}

// guard against accidental drift in sentinel string values vs model codes.
func TestSentinelStrings(t *testing.T) {
	cases := []struct {
		err error
		s   string
	}{
		{ErrOutputMissing, string(model.ErrorOutputMissing)},
		{ErrOutputInvalidJSON, string(model.ErrorOutputInvalidJSON)},
		{ErrSchemaValidationFailed, string(model.ErrorSchemaValidationFailed)},
		{ErrFileConstraintViolated, string(model.ErrorFileConstraintViolated)},
		{ErrRunnerExitNonzero, string(model.ErrorRunnerExitNonzero)},
	}
	for _, c := range cases {
		if c.err.Error() != c.s {
			t.Errorf("sentinel %v Error() = %q, want %q", c.err, c.err.Error(), c.s)
		}
	}
}

// TestValidateSolutionDesignToleratesThinkingAndWorkLog locks the
// hidden-reasoning boundary at the contract decoder level: an output that
// carries BOTH a public workLog AND a hidden "thinking" field must still
// validate (the decoder is lenient and ignores unknown fields), AND the
// thinking field must not influence the result. The executor's DecodeWorkLog
// (tested in stream_test.go) is the narrow path that lifts ONLY workLog into
// records; this test confirms the validator itself never trips on a thinking
// field and never surfaces it.
func TestValidateSolutionDesignToleratesThinkingAndWorkLog(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"needsUserInput": false,
		"usedSkills": [".claude/skills/software-factory-app/SKILL.md"],
		"thinking": "HIDDEN_PROVIDER_REASONING that must never reach a record",
		"reasoning": "another hidden field",
		"workLog": [{"content":"public: designed the map view"}]
	}`))
	out, err := ValidateSolutionDesign(p)
	if err != nil {
		t.Fatalf("ValidateSolutionDesign: %v, want nil (thinking/workLog must be tolerated)", err)
	}
	if out.NeedsUserInput {
		t.Fatal("NeedsUserInput = true, want false")
	}
	// The validator's StepOutput carries only NeedsUserInput + Questions — it
	// structurally cannot leak thinking because those fields are not modeled.
}

// TestValidateRequirementAnalysisToleratesThinkingAndWorkLog mirrors the above
// for the requirement_analysis freeze step: a thinking field must not break
// validation and must never be surfaced.
func TestValidateRequirementAnalysisToleratesThinkingAndWorkLog(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"confirmedRequirementId":"clar_x",
		"summary":"frozen",
		"appType":"timeline-replay",
		"appName":"demo",
		"generationProfile":{"base":["software-factory-app"]},
		"thinking":"HIDDEN_REASONING_CHAIN",
		"workLog":[{"content":"public: audited blueprints"}],
		"validation":{"complete":true,"supported":true,"missingFields":[],"unsupportedRequests":[]}
	}`))
	out, err := ValidateRequirementAnalysis(p)
	if err != nil {
		t.Fatalf("ValidateRequirementAnalysis: %v, want nil", err)
	}
	if out.NeedsUserInput {
		t.Fatal("NeedsUserInput = true, want false")
	}
}

func TestValidateRequirementAnalysisRejectsSummaryChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	raw := `{
	  "confirmedRequirementId":"clar_1",
	  "summary":"需求摘要 B",
	  "appType":"operations_tool",
	  "appName":"请假审批",
	  "targetUsers":["员工"],
	  "coreScenario":"提交和审批请假",
	  "primaryView":"审批工作台",
	  "mainEntities":["请假单"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["可提交审批"],
	  "generationProfile":{"base":["software-factory-app"]},
	  "constraints":{},
	  "risks":[],
	  "validation":{"complete":true,"supported":true}
	}`
	if err := os.WriteFile(p, []byte(raw), 0o644); err != nil {
		t.Fatalf("write output: %v", err)
	}
	_, err := ValidateRequirementAnalysisWithConfirmedSummary(p, `{"summary":"需求摘要 A","appType":"operations_tool","appName":"请假审批","coreScenario":"提交和审批请假"}`)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed", err)
	}
}

func TestValidateRequirementAnalysisAcceptsMatchingSummaryChecksum(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	confirmed := `{"summary":"需求摘要 A","appType":"operations_tool","appName":"请假审批","coreScenario":"提交和审批请假","primaryView":"审批工作台","mainEntities":["请假单"],"dataPolicy":"mock_data","acceptanceFocus":["可提交审批"]}`
	raw := `{
	  "confirmedRequirementId":"clar_1",
	  "summary":"需求摘要 A",
	  "appType":"operations_tool",
	  "appName":"请假审批",
	  "targetUsers":["员工"],
	  "coreScenario":"提交和审批请假",
	  "primaryView":"审批工作台",
	  "mainEntities":["请假单"],
	  "dataPolicy":"mock_data",
	  "acceptanceFocus":["可提交审批"],
	  "generationProfile":{"base":["software-factory-app"]},
	  "constraints":{},
	  "risks":[],
	  "validation":{"complete":true,"supported":true}
	}`
	if err := os.WriteFile(p, []byte(raw), 0o644); err != nil {
		t.Fatalf("write output: %v", err)
	}
	if _, err := ValidateRequirementAnalysisWithConfirmedSummary(p, confirmed); err != nil {
		t.Fatalf("ValidateRequirementAnalysisWithConfirmedSummary: %v", err)
	}
}

// TestValidateDataIntegrationRequiresStepwiseFallbackQuestion is the Task-9
// data-capture fallback contract: when the ontology boundary is unavailable
// (verification.ontology.status="failed"), the step MUST surface a structured
// clarification (needsUserInput + 1 question) rather than silently degrading to
// internet or demo. The validator returns the executor-facing StepOutput
// (NeedsUserInput true, 1 question) AND the decoded detail so the executor can
// upsert the data-contract artifact with the source boundary.
func TestValidateDataIntegrationRequiresStepwiseFallbackQuestion(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	raw := `{
	  "status":"needs_input",
	  "summary":"本体接口不可用",
	  "sourceBoundary":"ontology",
	  "verification":{"ontology":{"status":"failed","reason":"401"}},
	  "needsUserInput":true,
	  "questions":[{"id":"fallback-internet","question":"本体接口不可用，是否降级为互联网抓取？","options":[{"value":"internet","label":"降级为互联网抓取","recommended":true},{"value":"ontology","label":"继续提供本体接口信息"}]}],
	  "dataContract":{"fields":[]},
	  "workLog":[{"content":"已验证本体接口，返回 401"}]
	}`
	out, detail, err := ValidateDataIntegration(writeTempFileForContractTest(t, p, raw))
	if err != nil {
		t.Fatalf("ValidateDataIntegration: %v", err)
	}
	if !out.NeedsUserInput || len(out.Questions) != 1 {
		t.Fatalf("out = %#v", out)
	}
	if detail.SourceBoundary != "ontology" || detail.Verification.Ontology.Status != "failed" {
		t.Fatalf("detail = %#v", detail)
	}
}

// TestValidateDataIntegrationAcceptsConfirmedDemoFallback locks decision #30:
// the legitimate stepwise-degradation SUCCESS path produces a passed result
// whose sourceBoundary is "demo" with a non-empty fallbackHistory (ontology
// failed -> user confirmed internet -> internet failed -> user confirmed
// demo). That history is the audit trace of the user-confirmed degradation,
// so the validator must ACCEPT it. No-silent-degradation is enforced by the
// prompt + executor needsUserInput flow, not here.
func TestValidateDataIntegrationAcceptsConfirmedDemoFallback(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "output.json")
	raw := `{"status":"passed","summary":"使用演示数据","sourceBoundary":"demo","needsUserInput":false,"dataContract":{"fields":[{"name":"id"}]},"fallbackHistory":["ontology_failed","internet_failed"]}`
	if _, _, err := ValidateDataIntegration(writeTempFileForContractTest(t, p, raw)); err != nil {
		t.Fatalf("confirmed demo fallback must be accepted: %v", err)
	}
}

func writeTempFileForContractTest(t *testing.T, path, raw string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}
