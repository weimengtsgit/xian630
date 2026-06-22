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
// runtime returns the configured container backend (docker or podman). Production
// always sets FactoryRunner.Runtime from FACTORY_CONTAINER_RUNTIME (server.go);
// when nil it defaults to podman so legacy tests that omit it keep working.
// Callers MUST use this instead of deploy.NewPodman directly, otherwise the
// image_build/deploy steps ignore FACTORY_CONTAINER_RUNTIME and always use podman.
func (f *FactoryRunner) runtime() deploy.ContainerRuntime {
	if f.Runtime != nil {
		return f.Runtime
	}
	return deploy.NewPodman(f.Cmds)
}

type FactoryRunner struct {
	Store   *store.Store
	Cmds    deploy.CommandRunner // used for npm and all container-runtime shell-outs
	Runtime deploy.ContainerRuntime
	// StreamCmds is the OPTIONAL streaming capability. When non-nil, runCmd and
	// the podman paths route each command through RunStreamWithInput and feed the
	// per-line callbacks into a commandStreamBatcher that emits live
	// command_stdout/command_stderr records. When nil (e.g. the non-streaming
	// test fakes), the steps fall back to the non-streaming Run + writeLogs path
	// unchanged, so every existing fake-based test keeps passing. Production
	// sets this to the *deploy.OSRunner (server.go), which satisfies
	// deploy.StreamCommandRunner.
	StreamCmds   deploy.StreamCommandRunner
	Alloc        deploy.Allocator
	Health       func(ctx context.Context, url string, timeout time.Duration) error // default deploy.CheckHTTP
	Workspace    string                                                             // workspace root (cfg.WorkspaceRoot)
	ArtifactRoot string                                                             // cfg.ArtifactRoot
}

// Run dispatches one factory step. A claude-mode step returns a failed result
// without touching the filesystem.
func (f *FactoryRunner) Run(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	switch step.Kind {
	case model.StepTestVerification:
		return f.runTestVerification(ctx, job, step, emit)
	case model.StepImageBuild:
		return f.runImageBuild(ctx, job, step, emit)
	case model.StepDeployment:
		return f.runDeployment(ctx, job, step, emit)
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

// writeLogs writes redacted, capped stdout.log/stderr.log into the attempt
// workspace and registers them as command_stdout/command_stderr artifacts
// (best-effort). Command logs are audit-only — they are never operational
// inputs to any validation — so they are written directly as redacted+capped
// files rather than as separate audit copies of an intact operational file.
func (f *FactoryRunner) writeLogs(ctx context.Context, job model.Job, step model.JobStep, res deploy.CommandResult) {
	w := runner.AttemptWorkspace{Root: f.ArtifactRoot, JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	_ = os.MkdirAll(w.Dir(), 0o755)
	reg := &artifactRegistrar{store: f.Store, jobID: job.ID, step: step}
	_ = reg.registerCappedLog(ctx, "command_stdout", w.StdoutPath(), []byte(res.Stdout), res.StdoutTruncated, "Factory command stdout (redacted, capped)")
	_ = reg.registerCappedLog(ctx, "command_stderr", w.StderrPath(), []byte(res.Stderr), res.StderrTruncated, "Factory command stderr (redacted, capped)")
}

// runCmd runs name+args in dir, writes the capped (redacted) artifact, and
// returns the result + ok=false on a non-zero exit (caller maps to the right
// ErrorCode). When a streaming runner is configured it routes the command
// through RunStreamWithInput and feeds stdout/stderr into a batcher that emits
// live command_stdout/command_stderr records; otherwise it uses the plain Run
// path. Either way the CommandResult (and thus the exit-code → error-code
// mapping and the capped artifact) is identical.
func (f *FactoryRunner) runCmd(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter, dir, name string, args ...string) (deploy.CommandResult, bool) {
	var res deploy.CommandResult
	var err error
	if f.StreamCmds != nil {
		b := newCommandStreamBatcher(ctx, emit)
		b.start()
		defer b.close()
		res, err = f.StreamCmds.RunStreamWithInput(ctx, dir, "", b.addStdout, b.addStderr, name, args...)
	} else {
		res, err = f.Cmds.Run(ctx, dir, name, args...)
	}
	f.writeLogs(ctx, job, step, res)
	if err != nil || res.ExitCode != 0 {
		return res, false
	}
	return res, true
}

// runTestVerification implements design §5.4.
func (f *FactoryRunner) runTestVerification(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
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
		if _, ok := f.runCmd(ctx, job, step, emit, projectDir, "npm", "ci"); !ok {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorDependencyInstallFailed, ErrorMessage: "npm ci failed"}, nil
		}
	} else {
		if _, ok := f.runCmd(ctx, job, step, emit, projectDir, "npm", "install"); !ok {
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
	if _, ok := f.runCmd(ctx, job, step, emit, projectDir, buildArgs[0], buildArgs[1:]...); !ok {
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
func (f *FactoryRunner) runImageBuild(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	app, fail, ok := f.resolveApp(ctx, job)
	if !ok {
		return fail, nil
	}
	if _, fail, ok := f.readManifest(app); !ok {
		return fail, nil
	}
	tag := "job-" + job.ID
	rt := f.runtime()
	// BuildImage runs `<docker|podman> build .` with dir = app.Path. app.Path
	// is a relative path against the workspace root (e.g. "generated-apps/demo"),
	// so resolve it to a workspace-rooted dir — mirroring what the npm steps
	// do — before handing it to BuildImage. In production the server's cwd is
	// factory-server/, not the workspace root, so a bare relative Path would
	// resolve against the wrong directory and the build would fail.
	buildApp := app
	buildApp.Path = filepath.Join(f.Workspace, app.Path)
	var res deploy.CommandResult
	var err error
	if f.StreamCmds != nil {
		b := newCommandStreamBatcher(ctx, emit)
		b.start()
		_, res, err = rt.BuildImageWithCallbacks(ctx, buildApp, tag, b.addStdout, b.addStderr)
		b.close()
	} else {
		_, res, err = rt.BuildImage(ctx, buildApp, tag)
	}
	f.writeLogs(ctx, job, step, res)
	if err != nil || res.ExitCode != 0 {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorImageBuildFailed, ErrorMessage: fmt.Sprintf("%s build failed: %v", rt.Name(), err)}, nil
	}
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

// runDeployment implements design §5.6.
func (f *FactoryRunner) runDeployment(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
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

	// Allocate a host port across the whole factory runtime. Generated jobs and
	// preset-app starts share the same 18000-18999 pool, so checking only this
	// app would collide with another running app.
	host, err := f.Alloc.Choose(f.portInUse(ctx))
	if err != nil {
		if errors.Is(err, deploy.ErrPortUnavailable) {
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorPortUnavailable, ErrorMessage: err.Error()}, nil
		}
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("allocate port: %v", err)}, nil
	}

	rt := f.runtime()
	var container deploy.ContainerRef
	var res deploy.CommandResult
	if f.StreamCmds != nil {
		b := newCommandStreamBatcher(ctx, emit)
		b.start()
		container, res, err = rt.RunContainerWithCallbacks(ctx, image, app.Slug, host, containerPort, b.addStdout, b.addStderr)
		b.close()
	} else {
		container, res, err = rt.RunContainer(ctx, image, app.Slug, host, containerPort)
	}
	f.writeLogs(ctx, job, step, res)
	if err != nil || res.ExitCode != 0 {
		if container.Name != "" {
			_, _ = rt.RemoveContainer(ctx, container.Name)
		}
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorPodmanRunFailed, ErrorMessage: fmt.Sprintf("%s run failed: %v", rt.Name(), err)}, nil
	}

	// Health check; on failure stop+remove (best-effort), mark deployment failed,
	// mark app error.
	url := "http://127.0.0.1:" + strconv.Itoa(host)
	health := f.Health
	if health == nil {
		health = deploy.CheckHTTP
	}
	if herr := health(ctx, url, 10*time.Second); herr != nil {
		_, _ = rt.StopContainer(ctx, container.Name)
		_, _ = rt.RemoveContainer(ctx, container.Name)
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
	dep := model.Deployment{
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
	}
	_ = f.Store.CreateDeployment(ctx, dep)
	_ = f.Store.SetAppRuntime(ctx, app.ID, string(model.AppStatusRunning), url)
	f.stopPreviousDeployments(ctx, rt, app.ID, dep.ID)
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

func (f *FactoryRunner) portInUse(ctx context.Context) func(int) bool {
	return func(port int) bool {
		apps, err := f.Store.ListApplications(ctx)
		if err != nil {
			return false
		}
		for _, app := range apps {
			deps, derr := f.Store.ListDeploymentsByApp(ctx, app.ID)
			if derr != nil {
				continue
			}
			for _, dep := range deps {
				if dep.Status == "running" && dep.HostPort == port {
					return true
				}
			}
		}
		return false
	}
}

func (f *FactoryRunner) stopPreviousDeployments(ctx context.Context, rt deploy.ContainerRuntime, appID, keepID string) {
	deps, err := f.Store.ListDeploymentsByApp(ctx, appID)
	if err != nil {
		return
	}
	for _, dep := range deps {
		if dep.ID == keepID || dep.Status != "running" {
			continue
		}
		_, _ = rt.StopContainer(ctx, dep.ContainerName)
		_, _ = rt.RemoveContainer(ctx, dep.ContainerName)
		_ = f.Store.UpdateDeploymentStatus(ctx, dep.ID, "stopped")
	}
}
