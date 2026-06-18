package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

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

// Run dispatches one claude-mode step. Any non-claude kind fails fast.
func (f *FakeClaudeRunner) Run(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	switch step.Kind {
	case model.StepRequirementAnalysis:
		return f.runRequirementAnalysis(ctx, job, step)
	case model.StepSolutionDesign:
		return f.runSolutionDesign(ctx, job, step)
	case model.StepCodeGeneration:
		return f.runCodeGeneration(ctx, job, step)
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

func (f *FakeClaudeRunner) runRequirementAnalysis(_ context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	out := map[string]any{
		"summary":        "Fake-claude requirement analysis for the local MVP loop.",
		"appType":        "timeline-replay",
		"needsUserInput": false,
		"questions":      []any{},
	}
	if err := f.writeOutput(job, step, out); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

func (f *FakeClaudeRunner) runSolutionDesign(_ context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	slug := f.slug()
	name := fakeGeneratedAppName(job.UserPrompt)
	out := map[string]any{
		"app": map[string]any{
			"slug":   slug,
			"name":   name,
			"type":   "timeline-replay",
			"source": "generated",
		},
		"artifactPlan": map[string]any{
			"projectDir":   "generated-apps/" + slug,
			"manifestPath": "generated-apps/" + slug + "/.factory/app.json",
		},
		"needsUserInput": false,
	}
	if err := f.writeOutput(job, step, out); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

func (f *FakeClaudeRunner) runCodeGeneration(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	slug := f.slug()
	name := fakeGeneratedAppName(job.UserPrompt)
	description := fakeGeneratedAppDescription(job.UserPrompt)
	out := map[string]any{
		"projectDir":     "generated-apps/" + slug,
		"createdFiles":   []string{"package.json", "vite.config.js", "index.html", "src/main.jsx", "src/App.jsx", "src/style.css", ".factory/app.json", "Dockerfile", "nginx.conf"},
		"needsUserInput": false,
	}
	if err := f.writeOutput(job, step, out); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	// Emit a minimal but genuinely buildable Vite + React generated app.
	appDir := filepath.Join(f.Workspace, "generated-apps", slug)
	if err := f.writeGeneratedApp(appDir, slug, name, description); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	// Register the app and link it to the job so the factory steps resolve it
	// via CreatedAppID.
	now := time.Now()
	app := model.Application{
		ID:           "app-" + slug,
		Slug:         slug,
		Name:         name,
		Type:         "timeline-replay",
		Source:       model.AppSourceGenerated,
		Description:  description,
		Path:         "generated-apps/" + slug,
		ManifestPath: "generated-apps/" + slug + "/.factory/app.json",
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
