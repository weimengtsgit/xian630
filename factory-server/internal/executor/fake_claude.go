package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// FakeClaudeRunner is a deterministic StepRunner for the three claude-mode
// pipeline steps. It is wired into the Dispatcher when FACTORY_FAKE_CLAUDE is
// truthy so the full six-step pipeline can run end-to-end locally without a real
// Claude CLI (design Task 16). It writes the same output.json contract the real
// claude runner produces and, on code_generation, emits a minimal but genuinely
// buildable Vite + React generated app under generated-apps/<Slug>/ and registers
// it in the store. The downstream factory steps (test_verification / image_build /
// deployment) then run real npm + podman against that app — that is intentional.
type FakeClaudeRunner struct {
	Store        *store.Store
	Workspace    string // cfg.WorkspaceRoot; generated app is written under <Workspace>/generated-apps/<Slug>
	ArtifactRoot string // cfg.ArtifactRoot; claude step output.json lives under here
	Slug         string // generated-app slug; defaults to "factory-demo" when empty
}

type fakeSceneTemplate struct {
	TemplateSlug string
	Name         string
	Type         string
	Description  string
	Keywords     []string
	// Profile is the optional README Generation Profile to report as "followed"
	// when the confirmed requirement carries none. nil for all entries except
	// scenes whose domain/pattern skills (e.g. affiliation-inference-dashboard)
	// are not derivable from appType alone.
	Profile map[string][]string
}

type fakeGenerationPlan struct {
	Slug         string
	Name         string
	Type         string
	Description  string
	TemplateSlug string
	Legacy       bool
}

var fakeSceneTemplates = []fakeSceneTemplate{
	{
		TemplateSlug: "carrier-homeport-tide-window",
		Name:         "航母母港潮汐窗口计算器",
		Type:         "command-dashboard",
		Description:  "四大航母母港潮汐窗口状态看板",
		Keywords:     []string{"航母母港潮汐窗口计算器", "潮汐", "诺福克", "圣迭戈", "布雷默顿", "横须贺", "12.8", "可出港时间窗"},
	},
	{
		TemplateSlug: "carrier-deck-wind-calculator",
		Name:         "甲板风实时计算器",
		Type:         "command-dashboard",
		Description:  "航母活动区域甲板风条件评估看板",
		Keywords:     []string{"甲板风实时计算器", "甲板风", "格点风场", "10 米", "20 节", "30 节", "无弹射器辅助", "安全着舰"},
	},
	{
		TemplateSlug: "merchant-density-grid-alert",
		Name:         "海域网格商船密度异常告警器",
		Type:         "command-dashboard",
		Description:  "AIS 商船密度网格异常告警",
		Keywords:     []string{"AIS", "50 海里", "30 天滑动平均", "商船密度", "商船数量", "70%", "50%", "数量曲线"},
	},
	{
		TemplateSlug: "social-sighting-cluster-alert",
		Name:         "开源社区异常监测",
		Type:         "command-dashboard",
		Description:  "社媒海上目击聚合告警地图",
		Keywords:     []string{"社交媒体", "推特", "Instagram", "公开搜索", "GPS", "EXIF", "散点图", "目击潮", "新帖子"},
	},
	{
		TemplateSlug: "carrier-formation-replay",
		Name:         "航母编队月度航迹复盘",
		Type:         "timeline-replay",
		Description:  "展示航母编队近一个月日级航迹、伴随舰队形、事件点和复盘时间轴。",
		Keywords:     []string{"航母编队月度航迹复盘", "近一个月", "日级航迹", "航行路线", "伴随舰队形", "关键事件点", "时间轴"},
	},
	{
		TemplateSlug: "east-sea-situation",
		Name:         "东海目标态势演示",
		Type:         "map-dashboard",
		Description:  "基于东海卫星地图展示目标列表、轨迹、警戒区、事件时间线和融合态势面板。",
		Keywords:     []string{"东海目标态势演示", "东海方向", "目标列表", "目标轨迹", "警戒区", "融合态势", "目标态势"},
	},
	{
		TemplateSlug: "carrier-air-wing-affiliation-inference",
		Name:         "航母舰载机归属推断工具",
		Type:         "command-dashboard",
		Description:  "基于 ADS-B 海上起降事件和航母已知位置库推断舰载机归属、交叉部署和离舰告警。",
		Keywords: []string{
			"航母舰载机归属推断工具", "舰载机归属", "ADS-B", "ICAO", "海上起降",
			"航母已知位置", "归属置信度", "交叉部署", "已离舰", "关系树", "起降热力地图",
			"air wing", "affiliation", "adsb", "heatmap",
		},
		Profile: map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"command-dashboard", "maritime-alert-dashboard", "affiliation-inference-dashboard"},
		},
	},
}

// Run dispatches one claude-mode step. Any non-claude kind fails fast.
func (f *FakeClaudeRunner) Run(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	if emit == nil {
		emit = runner.NopEmitter{}
	}
	switch step.Kind {
	case model.StepRequirementAnalysis:
		return f.runRequirementAnalysis(ctx, job, step)
	case model.StepSolutionDesign:
		return f.runSolutionDesign(ctx, job, step)
	case model.StepCodeGeneration:
		return f.runCodeGeneration(ctx, job, step)
	case model.StepCollaborationOrchestration, model.StepDomainAnalysis,
		model.StepDesignContract, model.StepDataIntegration,
		model.StepCodeReview, model.StepSecurityReview, model.StepProductAcceptance:
		// Collaboration-pipeline gates. In fake-claude mode (FACTORY_FAKE_CLAUDE)
		// the full pipeline runs without a real Claude CLI, so these gates pass
		// deterministically: the fake never emits a blocking finding. The real
		// claude_runner decodes the gate's JSON status and maps "blocked" to a
		// repairable ErrorBlockingReview; the fake exercises only the happy path.
		return StepResult{Status: model.StepStatusSucceeded}, nil
	default:
		return StepResult{
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorUnknown,
			ErrorMessage: "fake claude: unhandled step " + string(step.Kind),
		}, nil
	}
}

func (f *FakeClaudeRunner) slug() string {
	if f.Slug != "" {
		return f.Slug
	}
	return "factory-demo"
}

// workspace mirrors ClaudeStepRunner.workspace so the fake resolves skill paths
// against the same root the real runner would.
func (f *FakeClaudeRunner) workspace() string {
	if f.Workspace == "" {
		return "."
	}
	return f.Workspace
}

// profileForJob starts with the confirmed Factory-derived profile, or an
// app-type fallback for direct legacy jobs, then adds any scene-specific skills
// required by the matched blueprint. This keeps fake output compatible with the
// normal dialogue path while retaining a safe fallback for low-level tests.
func profileForJob(job model.Job, scene fakeSceneTemplate) map[string][]string {
	profile, _ := parseGenerationProfile(json.RawMessage(job.ConfirmedRequirementJSON))
	if len(profile) == 0 {
		profile = generationProfileForAppTypePublic(scene.Type)
	}
	return mergeGenerationProfiles(profile, scene.Profile)
}

func mergeGenerationProfiles(base, additions map[string][]string) map[string][]string {
	merged := make(map[string][]string, len(base)+len(additions))
	for group, skills := range base {
		merged[group] = append([]string(nil), skills...)
	}
	for group, skills := range additions {
		for _, skill := range skills {
			present := false
			for _, existing := range merged[group] {
				if existing == skill {
					present = true
					break
				}
			}
			if !present {
				merged[group] = append(merged[group], skill)
			}
		}
	}
	return merged
}

// plan derives the generation plan for a claude-mode step. Naming precedence
// (mirrors the Factory rule so the fake and real runners agree):
//  1. Explicit f.Slug escape hatch (lower-level tests): legacy minimal app,
//     slug/name from the prompt, Legacy=true. Kept verbatim for compat.
//  2. Pre-allocated name/slug on the job (the dialogue-confirm path, allocated
//     by confirmDialogueClarification via idpkg.Base36Serial + factoryAppSlug):
//     used VERBATIM, never re-serialised. Type/Description from the matched scene.
//  3. Legacy / direct-created job: pick the scene via matchFakeSceneTemplate,
//     then allocate a UPPERCASE Base36 serial that does not collide with any
//     app slug already in the store or under generated-apps/.
func (f *FakeClaudeRunner) plan(ctx context.Context, job model.Job) fakeGenerationPlan {
	prompt := job.UserPrompt
	if f.Slug != "" {
		slug := f.slug()
		return fakeGenerationPlan{
			Slug:        slug,
			Name:        fakeGeneratedAppName(prompt),
			Type:        "timeline-replay",
			Description: fakeGeneratedAppDescription(prompt),
			Legacy:      true,
		}
	}
	scene := matchFakeSceneTemplate(prompt)
	// Pre-allocated name/slug from a dialogue-confirm job win over re-serialising.
	if name := strings.TrimSpace(job.AppName); name != "" {
		if slug := strings.TrimSpace(job.AppSlug); slug != "" {
			return fakeGenerationPlan{
				Slug:         slug,
				Name:         name,
				Type:         scene.Type,
				Description:  scene.Description,
				TemplateSlug: scene.TemplateSlug,
			}
		}
	}
	// Legacy / direct-created job: Factory Base36 serial, never demoNN.
	serial := idpkg.Base36Serial(func(cand string) bool {
		return f.serialTaken(ctx, scene, cand)
	})
	return fakeGenerationPlan{
		Slug:         fakeAppSlug(scene.Name, scene.TemplateSlug, serial),
		Name:         scene.Name + "-" + serial,
		Type:         scene.Type,
		Description:  scene.Description,
		TemplateSlug: scene.TemplateSlug,
	}
}

// slugifyRawLocal mirrors server.slugifyRaw: lowercase, keep [a-z0-9], map
// every other rune (including '-' and '_') to '-', then trim/collapse hyphens.
// Re-implemented here because executor must not import the server package.
func slugifyRawLocal(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	return out
}

// fakeAppSlug mirrors server.factoryAppSlug's contract. serial is lowercased;
// the slug anchors on the ASCII portion of name, falling back to anchor (the
// scene's ASCII TemplateSlug) and finally "app". Deterministic in
// (name, anchor, suffix) so the collision predicate can test the exact slug.
func fakeAppSlug(name, anchor, suffix string) string {
	serial := strings.ToLower(suffix)
	if namePart := slugifyRawLocal(name); namePart != "" {
		return namePart + "-" + serial
	}
	anchor2 := slugifyRawLocal(anchor)
	if anchor2 == "" {
		anchor2 = "app"
	}
	return anchor2 + "-" + serial
}

// serialTaken reports whether the slug derived from (scene.Name,
// scene.TemplateSlug, candSerial) is already used by an app in the store OR
// exists as a directory under generated-apps/. Reuses the read-dir +
// store-list pattern of the former nextDemoIndex.
func (f *FakeClaudeRunner) serialTaken(ctx context.Context, scene fakeSceneTemplate, candSerial string) bool {
	candidate := fakeAppSlug(scene.Name, scene.TemplateSlug, candSerial)
	if f.Store != nil {
		if apps, err := f.Store.ListApplications(ctx); err == nil {
			for _, app := range apps {
				if app.Slug == candidate {
					return true
				}
			}
		}
	}
	generatedRoot := filepath.Join(f.Workspace, "generated-apps")
	if entries, err := os.ReadDir(generatedRoot); err == nil {
		for _, entry := range entries {
			if entry.Name() == candidate {
				return true
			}
		}
	}
	return false
}

// matchFakeSceneTemplate picks the scene whose keywords appear most often in
// the prompt; ties resolve to the first match so the default (index 0) only
// wins when no scene scores above zero.
func matchFakeSceneTemplate(prompt string) fakeSceneTemplate {
	best := fakeSceneTemplates[0]
	bestScore := 0
	for _, scene := range fakeSceneTemplates {
		score := 0
		for _, keyword := range scene.Keywords {
			if strings.Contains(prompt, keyword) {
				score++
			}
		}
		if score > bestScore {
			best = scene
			bestScore = score
		}
	}
	return best
}

// writeOutput serialises v to the step's attempt workspace output.json path.
func (f *FakeClaudeRunner) writeOutput(job model.Job, step model.JobStep, v any) error {
	w := runner.AttemptWorkspace{Root: f.ArtifactRoot, JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	if err := os.MkdirAll(w.Dir(), 0o755); err != nil && !os.IsExist(err) {
		return fmt.Errorf("mkdir %s: %w", w.Dir(), err)
	}
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal output.json: %w", err)
	}
	if err := os.WriteFile(w.OutputPath(), raw, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", w.OutputPath(), err)
	}
	return nil
}

func (f *FakeClaudeRunner) runRequirementAnalysis(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	plan := f.plan(ctx, job)
	profile := profileForJob(job, matchFakeSceneTemplate(job.UserPrompt))
	// Task 5: requirement_analysis is now a FREEZE/AUDIT of the job's confirmed
	// requirement, not a clarify step. Emit the frozen contract the real runner
	// produces: the validated requirement plus a validation block that marks it
	// complete+supported. The pipeline either SUCCEEDS here or fails; it never
	// pauses for clarification.
	out := map[string]any{
		"confirmedRequirementId": job.ClarificationSessionID,
		"summary":                "Fake-claude frozen requirement for " + plan.Name + ".",
		"appType":                plan.Type,
		"appName":                plan.Name,
		"targetUsers":            []string{"fake-claude operator"},
		"coreScenario":           "Fake-claude generated scenario",
		"primaryView":            "map + timeline",
		"mainEntities":           []string{"formation", "event"},
		"dataPolicy":             "mock_data",
		"acceptanceFocus":        []string{"track replay"},
		"generationProfile":      profile,
		"constraints":            []string{"React + Vite"},
		"risks":                  []string{"no real data"},
		"validation": map[string]any{
			"complete":            true,
			"supported":           true,
			"missingFields":       []string{},
			"unsupportedRequests": []string{},
		},
	}
	if err := f.writeOutput(job, step, out); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

// generationProfileForAppTypePublic is the fake runner's local derivation of the
// Factory generationProfile. It mirrors server.generationProfileForAppType but
// lives in the executor package (the server helper is not exported and the fake
// runner must not import the server package). Kept in sync deliberately.
func generationProfileForAppTypePublic(appType string) map[string][]string {
	switch appType {
	case "situation_replay", "timeline-replay":
		return map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"map-timeline-replay"},
		}
	case "operations_management":
		return map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"operations-management-console"},
		}
	case "command_dashboard", "command-dashboard":
		return map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"command-dashboard"},
		}
	case "map-dashboard":
		return map[string][]string{
			"base":    {"software-factory-app"},
			"domain":  {"defense-operations-ui"},
			"pattern": {"map-timeline-replay"},
		}
	default:
		return map[string][]string{"base": {"software-factory-app"}}
	}
}

func (f *FakeClaudeRunner) runSolutionDesign(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	plan := f.plan(ctx, job)
	profile := profileForJob(job, matchFakeSceneTemplate(job.UserPrompt))
	out := map[string]any{
		"app": map[string]any{
			"slug":   plan.Slug,
			"name":   plan.Name,
			"type":   plan.Type,
			"source": "generated",
		},
		"artifactPlan": map[string]any{
			"projectDir":   "generated-apps/" + plan.Slug,
			"manifestPath": "generated-apps/" + plan.Slug + "/.factory/app.json",
		},
		"needsUserInput": false,
		"usedSkills":     selectedSkillPaths(f.workspace(), profile),
		"warnings":       []string{},
	}
	if err := f.writeOutput(job, step, out); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

func (f *FakeClaudeRunner) runCodeGeneration(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	plan := f.plan(ctx, job)
	profile := profileForJob(job, matchFakeSceneTemplate(job.UserPrompt))
	out := map[string]any{
		"projectDir":     "generated-apps/" + plan.Slug,
		"createdFiles":   []string{"package.json", "vite.config.js", "index.html", "src/main.jsx", "src/App.jsx", "src/style.css", ".factory/app.json", "Dockerfile", "nginx.conf"},
		"needsUserInput": false,
		"usedSkills":     selectedSkillPaths(f.workspace(), profile),
		"warnings":       []string{},
	}
	if err := f.writeOutput(job, step, out); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	// Emit a minimal but genuinely buildable Vite + React generated app.
	appDir := filepath.Join(f.Workspace, "generated-apps", plan.Slug)
	if plan.Legacy {
		if err := f.writeGeneratedApp(appDir, plan.Slug, plan.Name, plan.Description); err != nil {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
		}
	} else if err := f.copySceneTemplate(appDir, plan); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	// Register the app and link it to the job so the factory steps resolve it
	// via CreatedAppID.
	now := time.Now()
	app := model.Application{
		ID:           "app-" + plan.Slug,
		Slug:         plan.Slug,
		Name:         plan.Name,
		Type:         plan.Type,
		Source:       model.AppSourceGenerated,
		Description:  plan.Description,
		Path:         "generated-apps/" + plan.Slug,
		ManifestPath: "generated-apps/" + plan.Slug + "/.factory/app.json",
		Status:       model.AppStatusStopped,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := f.Store.UpsertApplication(ctx, app); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("upsert app: %v", err)}, nil
	}
	if err := f.Store.SetJobCreatedApp(ctx, job.ID, app.ID, app.Slug, app.Name); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("link job app: %v", err)}, nil
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

func (f *FakeClaudeRunner) copySceneTemplate(appDir string, plan fakeGenerationPlan) error {
	src := filepath.Join(f.Workspace, "scene", plan.TemplateSlug)
	if _, err := os.Stat(src); err != nil {
		return fmt.Errorf("scene template %s: %w", src, err)
	}
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		base := entry.Name()
		if entry.IsDir() && (base == "node_modules" || base == "dist") {
			return filepath.SkipDir
		}
		dst := filepath.Join(appDir, rel)
		if entry.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		content, err := transformTemplateFile(filepath.ToSlash(rel), raw, plan)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, content, info.Mode())
	})
}

func transformTemplateFile(rel string, raw []byte, plan fakeGenerationPlan) ([]byte, error) {
	switch rel {
	case ".factory/app.json":
		return transformManifest(raw, plan)
	case "package.json":
		return transformPackageJSON(raw, plan.Slug)
	case "package-lock.json":
		return transformPackageLockJSON(raw, plan.Slug)
	case "index.html":
		return []byte(replaceHTMLTitle(string(raw), plan.Name)), nil
	default:
		return raw, nil
	}
}

func transformManifest(raw []byte, plan fakeGenerationPlan) ([]byte, error) {
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("parse template manifest: %w", err)
	}
	manifest["slug"] = plan.Slug
	manifest["name"] = plan.Name
	manifest["type"] = plan.Type
	manifest["source"] = string(model.AppSourceGenerated)
	manifest["description"] = plan.Description
	manifest["path"] = "generated-apps/" + plan.Slug
	return json.MarshalIndent(manifest, "", "  ")
}

func transformPackageJSON(raw []byte, slug string) ([]byte, error) {
	var pkg map[string]any
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return nil, fmt.Errorf("parse package.json: %w", err)
	}
	pkg["name"] = slug
	return json.MarshalIndent(pkg, "", "  ")
}

func transformPackageLockJSON(raw []byte, slug string) ([]byte, error) {
	var lock map[string]any
	if err := json.Unmarshal(raw, &lock); err != nil {
		return nil, fmt.Errorf("parse package-lock.json: %w", err)
	}
	lock["name"] = slug
	if packages, ok := lock["packages"].(map[string]any); ok {
		if root, ok := packages[""].(map[string]any); ok {
			root["name"] = slug
		}
	}
	return json.MarshalIndent(lock, "", "  ")
}

func replaceHTMLTitle(html string, title string) string {
	start := strings.Index(html, "<title>")
	end := strings.Index(html, "</title>")
	if start < 0 || end < 0 || end < start {
		return html
	}
	return html[:start+len("<title>")] + title + html[end:]
}

// writeGeneratedApp lays down the files for a minimal Vite + React app that
// `npm install && npm run build` (and `podman build`) can succeed against.
func (f *FakeClaudeRunner) writeGeneratedApp(appDir, slug, name, description string) error {
	files := map[string]string{
		"package.json": `{` +
			`"name":"` + slug + `",` +
			`"private":true,` +
			`"version":"0.0.0",` +
			`"type":"module",` +
			`"scripts":{"dev":"vite","build":"vite build","preview":"vite preview"},` +
			`"dependencies":{"react":"^18.3.1","react-dom":"^18.3.1"},` +
			`"devDependencies":{"@vitejs/plugin-react":"^4.3.1","vite":"^5.4.0"}` +
			`}`,
		"vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
		"index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>` + name + `</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
		filepath.Join("src", "main.jsx"): `import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
		filepath.Join("src", "App.jsx"): `import React from "react";
import "./style.css";

export function App() {
  return (
    <div className="app-shell">
      <aside className="side-panel">
        <span className="eyebrow">SOFTWARE FACTORY GENERATED</span>
        <h1>` + name + `</h1>
        <p>` + description + `</p>
        <div className="metrics">
          <span><strong>30</strong> 天</span>
          <span><strong>8</strong> 事件</span>
          <span><strong>东海</strong> 海域</span>
        </div>
      </aside>
      <main className="map-stage">
        <div className="coast coast-cn">浙江 / 福建</div>
        <div className="coast coast-jp">琉球方向</div>
        <div className="coast coast-tw">台湾岛</div>
        <svg className="track" viewBox="0 0 900 560" role="img" aria-label="航母编队近一个月航迹">
          <path d="M95 365 C170 315 235 300 310 270 S470 220 560 185 S705 145 805 105" />
          {[95, 205, 315, 425, 535, 650, 760, 805].map((x, index) => (
            <g key={x}>
              <circle cx={x} cy={365 - index * 36} r="7" />
              <text x={x + 13} y={369 - index * 36}>D+{index * 4}</text>
            </g>
          ))}
        </svg>
        <section className="event-board">
          <h2>时间点事件</h2>
          {["补给航渡", "舰载机训练", "编队转向", "远海协同", "靠近识别区"].map(item => (
            <div className="event" key={item}>
              <span></span>
              <p>{item}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
`,
		filepath.Join("src", "style.css"): `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #07111f;
  color: #e8f7ff;
  font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 320px 1fr;
  background:
    linear-gradient(90deg, rgba(9, 20, 34, 0.98), rgba(9, 20, 34, 0.72)),
    radial-gradient(circle at 75% 20%, rgba(75, 210, 255, 0.22), transparent 32%),
    #07111f;
}

.side-panel {
  padding: 38px 30px;
  border-right: 1px solid rgba(111, 218, 255, 0.2);
  background: rgba(6, 16, 28, 0.84);
}

.eyebrow {
  color: #7be4ff;
  font-size: 12px;
  letter-spacing: 0;
}

h1 {
  margin: 18px 0 14px;
  font-size: 30px;
  line-height: 1.2;
}

p {
  color: #aac1d1;
  line-height: 1.7;
}

.metrics {
  display: grid;
  gap: 10px;
  margin-top: 30px;
}

.metrics span,
.event {
  border: 1px solid rgba(111, 218, 255, 0.22);
  background: rgba(17, 38, 58, 0.7);
  border-radius: 8px;
  padding: 12px;
}

.metrics strong {
  color: #71e8ff;
  margin-right: 8px;
}

.map-stage {
  position: relative;
  min-height: 100vh;
  overflow: hidden;
}

.coast {
  position: absolute;
  color: rgba(225, 247, 255, 0.85);
  border: 1px solid rgba(151, 232, 255, 0.18);
  background: rgba(75, 117, 78, 0.28);
  padding: 10px 14px;
  border-radius: 8px;
}

.coast-cn {
  left: 8%;
  top: 16%;
}

.coast-jp {
  right: 9%;
  top: 11%;
}

.coast-tw {
  right: 18%;
  bottom: 14%;
}

.track {
  position: absolute;
  inset: 9% 8% 18% 7%;
  width: 85%;
  height: 73%;
}

.track path {
  fill: none;
  stroke: #62dfff;
  stroke-width: 4;
  stroke-dasharray: 10 10;
}

.track circle {
  fill: #ff675f;
  stroke: white;
  stroke-width: 3;
}

.track text {
  fill: #e8f7ff;
  font-size: 18px;
}

.event-board {
  position: absolute;
  right: 28px;
  bottom: 26px;
  width: 280px;
  display: grid;
  gap: 8px;
}

.event-board h2 {
  margin: 0 0 4px;
  font-size: 18px;
}

.event {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
}

.event span {
  width: 8px;
  height: 8px;
  border-radius: 99px;
  background: #ff675f;
}

.event p {
  margin: 0;
  color: #dff6ff;
}

@media (max-width: 760px) {
  .app-shell {
    grid-template-columns: 1fr;
  }

  .side-panel {
    border-right: 0;
    border-bottom: 1px solid rgba(111, 218, 255, 0.2);
  }

  .map-stage {
    min-height: 620px;
  }
}
`,
		"Dockerfile": `# Multi-stage build for the fake-claude generated app.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
# No checked-in lockfile: use npm install (resolves a fresh lockfile).
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,
		"nginx.conf": `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`,
		filepath.Join(".factory", "app.json"): `{` +
			`"schemaVersion":1,` +
			`"slug":"` + slug + `",` +
			`"name":` + jsonString(name) + `,` +
			`"type":"timeline-replay",` +
			`"source":"generated",` +
			`"description":` + jsonString(description) + `,` +
			`"entry":"static-vite",` +
			`"path":"generated-apps/` + slug + `",` +
			`"build":{"command":"npm run build","outputDir":"dist"},` +
			`"docker":{"enabled":true,"dockerfile":"Dockerfile","context":".","runtimePort":80}` +
			`}`,
	}
	for rel, content := range files {
		full := filepath.Join(appDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil && !os.IsExist(err) {
			return fmt.Errorf("mkdir %s: %w", filepath.Dir(full), err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", full, err)
		}
	}
	return nil
}

func fakeGeneratedAppName(prompt string) string {
	if strings.Contains(prompt, "航母") || strings.Contains(prompt, "东海") || strings.Contains(prompt, "航迹") {
		return "航母编队月度航迹复盘"
	}
	return "Factory Demo"
}

func fakeGeneratedAppDescription(prompt string) string {
	if strings.Contains(prompt, "航母") || strings.Contains(prompt, "东海") || strings.Contains(prompt, "航迹") {
		return "展示航母编队近一个月在东海方向的航行轨迹、关键时间点事件和阶段性态势摘要。"
	}
	return "A timeline-replay app generated by the software factory fake-claude runner."
}

func jsonString(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}
