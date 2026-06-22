package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// newFakeClaudeTestStore returns an in-memory store (no seeded app — the fake
// runner is expected to upsert the generated app itself).
func newFakeClaudeTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// fakeClaudeJobStep builds a job + a single running step of the given kind. The
// job has no CreatedAppID: code_generation must populate it.
func fakeClaudeJobStep(kind model.StepKind) (model.Job, model.JobStep) {
	job := model.Job{
		ID:              "job_fake_1",
		UserPrompt:      "x",
		Status:          model.JobStatusRunning,
		CurrentStepKind: kind,
	}
	step := model.JobStep{
		ID:      "step_" + string(kind),
		JobID:   "job_fake_1",
		Kind:    kind,
		Seq:     1,
		Status:  model.StepStatusRunning,
		Attempt: 1,
	}
	return job, step
}

func fakeClaudeJobStepWithPrompt(id string, kind model.StepKind, prompt string) (model.Job, model.JobStep) {
	job, step := fakeClaudeJobStep(kind)
	job.ID = id
	job.UserPrompt = prompt
	step.ID = "step_" + id + "_" + string(kind)
	step.JobID = id
	return job, step
}

// readOutputJSON reads the output.json for the given job/step from the artifact
// root and unmarshals it into *m.
func readOutputJSON(t *testing.T, artifactRoot string, job model.Job, step model.JobStep, m *map[string]any) {
	t.Helper()
	w := runner.AttemptWorkspace{Root: artifactRoot, JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	raw, err := os.ReadFile(w.OutputPath())
	if err != nil {
		t.Fatalf("read output.json %s: %v", w.OutputPath(), err)
	}
	if err := json.Unmarshal(raw, m); err != nil {
		t.Fatalf("parse output.json: %v", err)
	}
}

func writeFakeSceneTemplate(t *testing.T, ws string, sceneSlug string, appName string, appType string, description string) {
	t.Helper()
	sceneDir := filepath.Join(ws, "scene", sceneSlug)
	files := map[string]string{
		"package.json":                   `{"name":"` + sceneSlug + `","private":true,"version":"0.0.0","type":"module","scripts":{"build":"vite build"},"dependencies":{"@vitejs/plugin-react":"^4.3.4","vite":"^6.0.11","react":"^18.3.1","react-dom":"^18.3.1"},"devDependencies":{}}`,
		"index.html":                     `<!doctype html><html><head><title>` + appName + `</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
		filepath.Join("src", "main.jsx"): `console.log("template")`,
		filepath.Join(".factory", "app.json"): `{
			"schemaVersion":1,
			"slug":"` + sceneSlug + `",
			"name":"` + appName + `",
			"type":"` + appType + `",
			"source":"preset",
			"description":"` + description + `",
			"entry":"static-vite",
			"path":"scene/` + sceneSlug + `",
			"build":{"command":"npm run build","outputDir":"dist"},
			"docker":{"enabled":true,"dockerfile":"Dockerfile","context":".","runtimePort":80}
		}`,
		"Dockerfile": `FROM nginx:alpine`,
	}
	for rel, content := range files {
		full := filepath.Join(sceneDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(full), err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
	if err := os.MkdirAll(filepath.Join(sceneDir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sceneDir, "node_modules", "skip.txt"), []byte("skip"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestFakeClaudeRequirementAnalysisWritesOutput: requirement_analysis writes a
// valid output.json (with appType/questions) and returns succeeded.
func TestFakeClaudeRequirementAnalysisWritesOutput(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepRequirementAnalysis)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}
	var out map[string]any
	readOutputJSON(t, art, job, step, &out)
	if out["appType"] != "timeline-replay" {
		t.Fatalf("appType = %v, want timeline-replay", out["appType"])
	}
	if out["appName"] == nil {
		t.Fatalf("output missing appName field (frozen requirement shape)")
	}
	// Task 5: the freeze step emits a validation block, NOT needsUserInput.
	if _, ok := out["needsUserInput"]; ok {
		t.Fatalf("output must not carry needsUserInput (no clarification in the freeze step)")
	}
	if _, ok := out["questions"]; ok {
		t.Fatalf("output must not carry questions (no clarification in the freeze step)")
	}
	validation, ok := out["validation"].(map[string]any)
	if !ok {
		t.Fatalf("output missing validation block, got %v", out["validation"])
	}
	if validation["complete"] != true || validation["supported"] != true {
		t.Fatalf("validation = %+v, want complete=true supported=true", validation)
	}
	if _, ok := out["generationProfile"].(map[string]any); !ok {
		t.Fatalf("output missing generationProfile, got %v", out["generationProfile"])
	}
}

// TestFakeClaudeSolutionDesignWritesOutput: solution_design writes output.json
// declaring the generated app slug/type/source and returns succeeded.
func TestFakeClaudeSolutionDesignWritesOutput(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepSolutionDesign)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}
	var out map[string]any
	readOutputJSON(t, art, job, step, &out)
	app, _ := out["app"].(map[string]any)
	if app == nil || app["slug"] != "factory-demo" || app["type"] != "timeline-replay" || app["source"] != "generated" {
		t.Fatalf("app block = %v, want slug=factory-demo type=timeline-replay source=generated", app)
	}
	// Task 6: the fake must emit a non-empty usedSkills (the skills it "followed")
	// so the solution_design validator's usedSkills-required rule passes without
	// the fake bypassing the validator.
	used, _ := out["usedSkills"].([]any)
	if len(used) == 0 {
		t.Fatalf("usedSkills = %v, want non-empty (fake must report followed skills)", out["usedSkills"])
	}
}

// TestFakeClaudeCodeGenerationWritesApp: code_generation writes output.json, lays
// down a real buildable generated app (package.json, .factory/app.json,
// Dockerfile, nginx.conf, src), upserts the app in the store and links the job
// to it (CreatedAppID/slug/name set).
func TestFakeClaudeCodeGenerationWritesApp(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepCodeGeneration)
	// Seed the job row so SetJobCreatedApp/GetJob reflect the link the runner
	// writes — the real executor creates the job before any step runs.
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}

	// output.json present with the projectDir.
	var out map[string]any
	readOutputJSON(t, art, job, step, &out)
	if out["projectDir"] != "generated-apps/factory-demo" {
		t.Fatalf("projectDir = %v, want generated-apps/factory-demo", out["projectDir"])
	}
	// Task 6: the fake must emit a non-empty usedSkills so the code_generation
	// validator's usedSkills-required rule passes without bypassing it.
	used, _ := out["usedSkills"].([]any)
	if len(used) == 0 {
		t.Fatalf("usedSkills = %v, want non-empty (fake must report followed skills)", out["usedSkills"])
	}

	appDir := filepath.Join(ws, "generated-apps", "factory-demo")
	for _, rel := range []string{
		"package.json",
		"vite.config.js",
		"index.html",
		filepath.Join("src", "main.jsx"),
		filepath.Join("src", "App.jsx"),
		filepath.Join(".factory", "app.json"),
		"Dockerfile",
		"nginx.conf",
	} {
		if _, err := os.Stat(filepath.Join(appDir, rel)); err != nil {
			t.Fatalf("generated app missing %s: %v", rel, err)
		}
	}

	// The generated app must be present in ListApplications.
	apps, err := st.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("list apps: %v", err)
	}
	var found *model.Application
	for i := range apps {
		if apps[i].Slug == "factory-demo" {
			found = &apps[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("generated app factory-demo not in store after code_generation")
	}
	if found.Source != model.AppSourceGenerated {
		t.Fatalf("app source = %s, want generated", found.Source)
	}
	if found.Path != "generated-apps/factory-demo" {
		t.Fatalf("app path = %s, want generated-apps/factory-demo", found.Path)
	}
	if found.ManifestPath != "generated-apps/factory-demo/.factory/app.json" {
		t.Fatalf("app manifest_path = %s, want generated-apps/factory-demo/.factory/app.json", found.ManifestPath)
	}

	// Job must be linked to the app.
	got, err := st.GetJob(context.Background(), job.ID)
	if err != nil || got == nil {
		t.Fatalf("get job: %v (%v)", err, got)
	}
	if got.CreatedAppID != "app-factory-demo" {
		t.Fatalf("job.created_app_id = %q, want app-factory-demo", got.CreatedAppID)
	}
	if got.AppSlug != "factory-demo" || got.AppName != "Factory Demo" {
		t.Fatalf("job app slug/name = %q/%q, want factory-demo/Factory Demo", got.AppSlug, got.AppName)
	}
}

func TestFakeClaudeCodeGenerationMatchesSceneTemplateAndIncrementsDemoSuffix(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	writeFakeSceneTemplate(t, ws, "carrier-homeport-tide-window", "航母母港潮汐窗口计算器", "command-dashboard", "四大航母母港潮汐窗口状态看板")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art}
	prompt := "请生成一个应用，名称为「航母母港潮汐窗口计算器」。应用需要接入公开的潮汐预测 API，抓取诺福克、圣迭戈、布雷默顿、横须贺四大航母母港未来 72 小时潮汐数据。"

	job1, step1 := fakeClaudeJobStepWithPrompt("job_demo_1", model.StepCodeGeneration, prompt)
	if err := st.CreateJob(context.Background(), job1); err != nil {
		t.Fatalf("create job1: %v", err)
	}
	res, err := r.Run(context.Background(), job1, step1, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run job1: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("job1 status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}

	job2, step2 := fakeClaudeJobStepWithPrompt("job_demo_2", model.StepCodeGeneration, prompt)
	if err := st.CreateJob(context.Background(), job2); err != nil {
		t.Fatalf("create job2: %v", err)
	}
	res, err = r.Run(context.Background(), job2, step2, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run job2: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("job2 status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}

	for _, tc := range []struct {
		slug string
		name string
	}{
		{"carrier-homeport-tide-window-demo01", "航母母港潮汐窗口计算器demo01"},
		{"carrier-homeport-tide-window-demo02", "航母母港潮汐窗口计算器demo02"},
	} {
		appDir := filepath.Join(ws, "generated-apps", tc.slug)
		if _, err := os.Stat(filepath.Join(appDir, "src", "main.jsx")); err != nil {
			t.Fatalf("generated template copy missing src/main.jsx for %s: %v", tc.slug, err)
		}
		if _, err := os.Stat(filepath.Join(appDir, "node_modules", "skip.txt")); !os.IsNotExist(err) {
			t.Fatalf("node_modules copied for %s; err=%v", tc.slug, err)
		}
		raw, err := os.ReadFile(filepath.Join(appDir, ".factory", "app.json"))
		if err != nil {
			t.Fatalf("read manifest for %s: %v", tc.slug, err)
		}
		var manifest map[string]any
		if err := json.Unmarshal(raw, &manifest); err != nil {
			t.Fatalf("manifest invalid json for %s: %v", tc.slug, err)
		}
		if manifest["slug"] != tc.slug || manifest["name"] != tc.name || manifest["source"] != "generated" || manifest["path"] != "generated-apps/"+tc.slug {
			t.Fatalf("manifest for %s = %+v", tc.slug, manifest)
		}
	}

	got1, err := st.GetJob(context.Background(), job1.ID)
	if err != nil || got1 == nil {
		t.Fatalf("get job1: %v (%v)", err, got1)
	}
	if got1.AppSlug != "carrier-homeport-tide-window-demo01" || got1.AppName != "航母母港潮汐窗口计算器demo01" {
		t.Fatalf("job1 app = %q/%q", got1.AppSlug, got1.AppName)
	}
	got2, err := st.GetJob(context.Background(), job2.ID)
	if err != nil || got2 == nil {
		t.Fatalf("get job2: %v (%v)", err, got2)
	}
	if got2.AppSlug != "carrier-homeport-tide-window-demo02" || got2.AppName != "航母母港潮汐窗口计算器demo02" {
		t.Fatalf("job2 app = %q/%q", got2.AppSlug, got2.AppName)
	}
}

func TestFakeClaudeMatchesAllDemoScenePrompts(t *testing.T) {
	cases := []struct {
		name string
		text string
		slug string
	}{
		{"tide", "航母母港潮汐窗口计算器 诺福克 圣迭戈 布雷默顿 横须贺 72 小时 12.8 可出港时间窗", "carrier-homeport-tide-window"},
		{"deck wind", "甲板风实时计算器 公开格点风场 10 米高度风速 20 节 30 节 无弹射器辅助 安全着舰", "carrier-deck-wind-calculator"},
		{"ais density", "海域网格商船密度异常告警器 AIS 船舶位置 50 海里 30 天滑动平均 商船数量 70% 50%", "merchant-density-grid-alert"},
		{"social sighting", "海域网格商船密度异常告警器 社交媒体 推特 Instagram GPS EXIF 散点图 目击潮 新帖子", "social-sighting-cluster-alert"},
		{"formation replay", "航母编队月度航迹复盘 近一个月 日级航迹 航行路线 伴随舰队形 关键事件点 时间轴", "carrier-formation-replay"},
		{"east sea", "东海目标态势演示 东海方向 目标列表 目标轨迹 警戒区 融合态势 目标态势", "east-sea-situation"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := matchFakeSceneTemplate(tc.text)
			if got.TemplateSlug != tc.slug {
				t.Fatalf("TemplateSlug = %q, want %q", got.TemplateSlug, tc.slug)
			}
		})
	}
}

// TestFakeClaudeCodeGenerationIsIdempotent: running code_generation twice does
// not error (UpsertApplication + repeated writes are idempotent). The job link
// is still set on the second run.
func TestFakeClaudeCodeGenerationIsIdempotent(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	art := filepath.Join(ws, ".factory-runs")
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: art, Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepCodeGeneration)
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	for i := 0; i < 2; i++ {
		res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
		if err != nil {
			t.Fatalf("Run %d: %v", i+1, err)
		}
		if res.Status != model.StepStatusSucceeded {
			t.Fatalf("Run %d status = %s (%s), want succeeded", i+1, res.Status, res.ErrorMessage)
		}
	}
	apps, err := st.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("list apps: %v", err)
	}
	count := 0
	for _, a := range apps {
		if a.Slug == "factory-demo" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one factory-demo app row after 2 runs, got %d", count)
	}
}

// TestFakeClaudeUnhandledStepFails: a non-claude step kind fails fast with
// ErrorUnknown rather than being silently accepted.
func TestFakeClaudeUnhandledStepFails(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"), Slug: "factory-demo"}

	job, step := fakeClaudeJobStep(model.StepDeployment) // a factory step kind
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed || res.ErrorCode != model.ErrorUnknown {
		t.Fatalf("status/error = %s/%s, want failed/unknown", res.Status, res.ErrorCode)
	}
}

// TestFakeClaudeExplicitSlugUsesLegacyFactoryDemo: an explicit Slug keeps the
// legacy minimal fake app path for compatibility with lower-level tests.
func TestFakeClaudeExplicitSlugUsesLegacyFactoryDemo(t *testing.T) {
	st := newFakeClaudeTestStore(t)
	ws := t.TempDir()
	r := &FakeClaudeRunner{Store: st, Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"), Slug: "factory-demo"}

	if got, want := r.slug(), "factory-demo"; got != want {
		t.Fatalf("slug() = %q, want %q", got, want)
	}
	// And code_generation uses the explicit slug end-to-end.
	job, step := fakeClaudeJobStep(model.StepCodeGeneration)
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s), want succeeded", res.Status, res.ErrorMessage)
	}
	if _, err := os.Stat(filepath.Join(ws, "generated-apps", "factory-demo", "package.json")); err != nil {
		t.Fatalf("default-slug app not written: %v", err)
	}
}
