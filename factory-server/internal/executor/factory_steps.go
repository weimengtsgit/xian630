package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// FactoryRunner implements StepRunner for the three factory-backed steps:
// test_verification (§5.4), image_build (§5.5) and deployment (§5.6). The
// Claude-mode steps are NOT handled here — the dispatcher routes those to the
// claude runner (Task 16); if a claude step reaches this runner it fails fast
// with ErrorUnknown rather than attempting npm/podman work.
type FactoryRunner struct {
	Store        *store.Store
	Cmds         deploy.CommandRunner // used for both npm and podman (via deploy.NewPodman)
	Alloc        deploy.Allocator
	Health       func(ctx context.Context, url string, timeout time.Duration) error // default deploy.CheckHTTP
	Workspace    string                                                             // workspace root (cfg.WorkspaceRoot)
	ArtifactRoot string                                                             // cfg.ArtifactRoot
}

// Run dispatches one factory step. A claude-mode step returns a failed result
// without touching the filesystem.
func (f *FactoryRunner) Run(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	switch step.Kind {
	case model.StepTestVerification:
		return f.runTestVerification(ctx, job, step)
	case model.StepImageBuild:
		return f.runImageBuild(ctx, job, step)
	case model.StepDeployment:
		return f.runDeployment(ctx, job, step)
	default:
		// claude-mode steps are owned by the claude runner (Task 16).
		return StepResult{
			Status:       model.StepStatusFailed,
			ErrorCode:    model.ErrorUnknown,
			ErrorMessage: "claude-mode step not handled by factory runner",
		}, nil
	}
}

// resolveApp looks up the application for this job. It prefers the explicit
// CreatedAppID and falls back to the slug. On miss it returns a schema-validation
// failure (the job references an app that does not exist).
func (f *FactoryRunner) resolveApp(ctx context.Context, job model.Job) (model.Application, StepResult, bool) {
	if job.CreatedAppID != "" {
		app, err := f.Store.GetApplication(ctx, job.CreatedAppID)
		if err != nil {
			return model.Application{}, StepResult{
				Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed,
				ErrorMessage: fmt.Sprintf("lookup app %s: %v", job.CreatedAppID, err),
			}, false
		}
		if app != nil {
			return *app, StepResult{}, true
		}
	}
	if job.AppSlug != "" {
		app, err := f.Store.GetApplicationBySlug(ctx, job.AppSlug)
		if err != nil {
			return model.Application{}, StepResult{
				Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed,
				ErrorMessage: fmt.Sprintf("lookup app slug %s: %v", job.AppSlug, err),
			}, false
		}
		if app != nil {
			return *app, StepResult{}, true
		}
	}
	return model.Application{}, StepResult{
		Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed,
		ErrorMessage: "job references no app",
	}, false
}

// readManifest re-reads `.factory/app.json` for the app on every step (no
// caching, design §5.4). A missing/invalid manifest is a schema_validation_failed.
func (f *FactoryRunner) readManifest(app model.Application) (scanner.Manifest, StepResult, bool) {
	manifestPath := filepath.Join(f.Workspace, app.Path, ".factory", "app.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return scanner.Manifest{}, StepResult{
			Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed,
			ErrorMessage: fmt.Sprintf("read manifest %s: %v", manifestPath, err),
		}, false
	}
	m, err := scanner.ParseManifest(raw)
	if err != nil {
		return scanner.Manifest{}, StepResult{
			Status: model.StepStatusFailed, ErrorCode: model.ErrorSchemaValidationFailed,
			ErrorMessage: fmt.Sprintf("parse manifest: %v", err),
		}, false
	}
	return m, StepResult{}, true
}

// writeLogs writes stdout.log/stderr.log into the attempt workspace (best-effort).
func (f *FactoryRunner) writeLogs(job model.Job, step model.JobStep, res deploy.CommandResult) {
	w := runner.AttemptWorkspace{Root: f.ArtifactRoot, JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	_ = os.MkdirAll(w.Dir(), 0o755)
	_ = os.WriteFile(w.StdoutPath(), []byte(res.Stdout), 0o644)
	_ = os.WriteFile(w.StderrPath(), []byte(res.Stderr), 0o644)
}

// runCmd runs name+args in dir, writes logs, and returns the result + ok=false on
// a non-zero exit (caller maps to the right ErrorCode).
func (f *FactoryRunner) runCmd(ctx context.Context, job model.Job, step model.JobStep, dir, name string, args ...string) (deploy.CommandResult, bool) {
	res, err := f.Cmds.Run(ctx, dir, name, args...)
	f.writeLogs(job, step, res)
	if err != nil || res.ExitCode != 0 {
		return res, false
	}
	return res, true
}

// runTestVerification implements design §5.4.
func (f *FactoryRunner) runTestVerification(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	app, fail, ok := f.resolveApp(ctx, job)
	if !ok {
		return fail, nil
	}
	manifest, fail, ok := f.readManifest(app)
	if !ok {
		return fail, nil
	}
	projectDir := filepath.Join(f.Workspace, app.Path)

	// 1. Dependency install: npm ci when a lockfile is present, else npm install.
	if _, err := os.Stat(filepath.Join(projectDir, "package-lock.json")); err == nil {
		if _, ok := f.runCmd(ctx, job, step, projectDir, "npm", "ci"); !ok {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorDependencyInstallFailed, ErrorMessage: "npm ci failed"}, nil
		}
	} else {
		if _, ok := f.runCmd(ctx, job, step, projectDir, "npm", "install"); !ok {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorDependencyInstallFailed, ErrorMessage: "npm install failed"}, nil
		}
	}

	// 2. Build: manifest.Build.Command (default "npm run build"), split into args.
	buildCmd := strings.TrimSpace(manifest.Build.Command)
	if buildCmd == "" {
		buildCmd = "npm run build"
	}
	buildArgs := strings.Fields(buildCmd)
	if len(buildArgs) == 0 {
		buildArgs = []string{"npm", "run", "build"}
	}
	if _, ok := f.runCmd(ctx, job, step, projectDir, buildArgs[0], buildArgs[1:]...); !ok {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorBuildFailed, ErrorMessage: "build command failed"}, nil
	}

	// 3. Verify build output dir has an index.html.
	outDir := manifest.Build.OutputDir
	if outDir == "" {
		outDir = "dist"
	}
	if _, err := os.Stat(filepath.Join(projectDir, outDir, "index.html")); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorBuildFailed, ErrorMessage: fmt.Sprintf("build output missing index.html in %s: %v", outDir, err)}, nil
	}

	return StepResult{Status: model.StepStatusSucceeded}, nil
}

// runImageBuild implements design §5.5.
func (f *FactoryRunner) runImageBuild(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	app, fail, ok := f.resolveApp(ctx, job)
	if !ok {
		return fail, nil
	}
	if _, fail, ok := f.readManifest(app); !ok {
		return fail, nil
	}
	tag := "job-" + job.ID
	podman := deploy.NewPodman(f.Cmds)
	// BuildImage runs `podman build .` with dir = app.Path. app.Path is a
	// relative path against the workspace root (e.g. "generated-apps/demo"),
	// so resolve it to a workspace-rooted dir — mirroring what the npm steps
	// do — before handing it to BuildImage. In production the server's cwd is
	// factory-server/, not the workspace root, so a bare relative Path would
	// resolve against the wrong directory and the build would fail.
	buildApp := app
	buildApp.Path = filepath.Join(f.Workspace, app.Path)
	_, res, err := podman.BuildImage(ctx, buildApp, tag)
	f.writeLogs(job, step, res)
	if err != nil || res.ExitCode != 0 {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorImageBuildFailed, ErrorMessage: fmt.Sprintf("podman build failed: %v", err)}, nil
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

// runDeployment implements design §5.6.
func (f *FactoryRunner) runDeployment(ctx context.Context, job model.Job, step model.JobStep) (StepResult, error) {
	app, fail, ok := f.resolveApp(ctx, job)
	if !ok {
		return fail, nil
	}
	manifest, fail, ok := f.readManifest(app)
	if !ok {
		return fail, nil
	}

	tag := "job-" + job.ID
	image := deploy.ImageRef{FullName: "localhost/software-factory/" + app.Slug + ":" + tag}
	containerPort := manifest.Docker.RuntimePort
	if containerPort <= 0 {
		containerPort = 80
	}

	// Allocate a host port: isUsed scans all deployments for the app.
	host, err := f.Alloc.Choose(func(port int) bool {
		deps, derr := f.Store.ListDeploymentsByApp(ctx, app.ID)
		if derr != nil {
			return false
		}
		for _, d := range deps {
			if d.HostPort == port && d.Status == "running" {
				return true
			}
		}
		return false
	})
	if err != nil {
		if errors.Is(err, deploy.ErrPortUnavailable) {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorPortUnavailable, ErrorMessage: err.Error()}, nil
		}
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("allocate port: %v", err)}, nil
	}

	podman := deploy.NewPodman(f.Cmds)
	container, res, err := podman.RunContainer(ctx, image, app.Slug, host, containerPort)
	f.writeLogs(job, step, res)
	if err != nil || res.ExitCode != 0 {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorPodmanRunFailed, ErrorMessage: fmt.Sprintf("podman run failed: %v", err)}, nil
	}

	// Health check; on failure stop+remove (best-effort), mark deployment failed,
	// mark app error.
	url := "http://127.0.0.1:" + strconv.Itoa(host)
	health := f.Health
	if health == nil {
		health = deploy.CheckHTTP
	}
	if herr := health(ctx, url, 10*time.Second); herr != nil {
		_, _ = podman.StopContainer(ctx, container.Name)
		_, _ = podman.RemoveContainer(ctx, container.Name)
		_ = f.Store.CreateDeployment(ctx, model.Deployment{
			ID:            "dep_" + id.New(),
			AppID:         app.ID,
			JobID:         job.ID,
			ImageName:     image.FullName,
			ImageTag:      tag,
			ContainerName: container.Name,
			HostPort:      host,
			ContainerPort: containerPort,
			URL:           url,
			Status:        "failed",
			CreatedAt:     time.Now(),
		})
		_ = f.Store.SetAppRuntime(ctx, app.ID, string(model.AppStatusError), "")
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorHealthCheckFailed, ErrorMessage: herr.Error()}, nil
	}

	// Success: record a running deployment + flip app to running.
	now := time.Now()
	_ = f.Store.CreateDeployment(ctx, model.Deployment{
		ID:            "dep_" + id.New(),
		AppID:         app.ID,
		JobID:         job.ID,
		ImageName:     image.FullName,
		ImageTag:      tag,
		ContainerName: container.Name,
		HostPort:      host,
		ContainerPort: containerPort,
		URL:           url,
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	})
	_ = f.Store.SetAppRuntime(ctx, app.ID, string(model.AppStatusRunning), url)
	return StepResult{Status: model.StepStatusSucceeded}, nil
}
