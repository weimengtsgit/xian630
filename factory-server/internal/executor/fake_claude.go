package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	out := map[string]any{
		"app": map[string]any{
			"slug":   slug,
			"name":   "Factory Demo",
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
	out := map[string]any{
		"projectDir":     "generated-apps/" + slug,
		"createdFiles":   []string{"package.json", "vite.config.js", "index.html", "src/main.jsx", "src/App.jsx", ".factory/app.json", "Dockerfile", "nginx.conf"},
		"needsUserInput": false,
	}
	if err := f.writeOutput(job, step, out); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	// Emit a minimal but genuinely buildable Vite + React generated app.
	appDir := filepath.Join(f.Workspace, "generated-apps", slug)
	if err := f.writeGeneratedApp(appDir, slug); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: err.Error()}, nil
	}

	// Register the app and link it to the job so the factory steps resolve it
	// via CreatedAppID.
	now := time.Now()
	app := model.Application{
		ID:           "app-" + slug,
		Slug:         slug,
		Name:         "Factory Demo",
		Type:         "timeline-replay",
		Source:       model.AppSourceGenerated,
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
func (f *FakeClaudeRunner) writeGeneratedApp(appDir, slug string) error {
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
    <title>Factory Demo</title>
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

export function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Factory Demo</h1>
      <p>A timeline-replay app generated by the software factory fake-claude runner.</p>
    </div>
  );
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
			`"name":"Factory Demo",` +
			`"type":"timeline-replay",` +
			`"source":"generated",` +
			`"description":"fake-claude generated",` +
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
