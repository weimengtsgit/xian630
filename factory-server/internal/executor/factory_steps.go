package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// appURLHost returns the host used in the user-facing deployment URL for a
// generated app. Override with FACTORY_APP_URL_HOST (e.g. the site's public or
// internal IP) when factory runs in a container; otherwise fall back to the
// health-probe host so local/WSL dev keeps working.
func appURLHost() string {
	if v := os.Getenv("FACTORY_APP_URL_HOST"); v != "" {
		return v
	}
	return wslVMHealthIP()
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

// runTestVerification implements design §5.4. Task 6: it runs in the isolated
// candidate version dir so it never mutates the effective source. The candidate
// version is created here (the first factory step, seq 4) and reused by the
// later image_build/deploy steps via the job_id UNIQUE link.
func (f *FactoryRunner) runTestVerification(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	app, fail, ok := f.resolveApp(ctx, job)
	if !ok {
		return fail, nil
	}
	manifest, fail, ok := f.readManifest(app)
	if !ok {
		return fail, nil
	}

	// Resolve the isolated candidate dir (created + populated from the effective
	// source on first use). The npm/build commands run HERE, not in the
	// effective source, so candidate generation never mutates the effective tree.
	projectDir, fail, ok := f.resolveCandidateDir(ctx, app, job)
	if !ok {
		return fail, nil
	}

	// 1. Dependency install: npm ci when a lockfile is present, else npm install.
	if _, err := os.Stat(filepath.Join(projectDir, "package-lock.json")); err == nil {
		if _, ok := f.runCmd(ctx, job, step, emit, projectDir, "npm", "ci"); !ok {
			f.markCandidateFailed(ctx, job)
			return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorDependencyInstallFailed, ErrorMessage: "npm ci failed"}, nil
		}
	} else {
		if _, ok := f.runCmd(ctx, job, step, emit, projectDir, "npm", "install"); !ok {
			f.markCandidateFailed(ctx, job)
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
		f.markCandidateFailed(ctx, job)
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorBuildFailed, ErrorMessage: "build command failed"}, nil
	}

	// 3. Verify build output dir has an index.html.
	outDir := manifest.Build.OutputDir
	if outDir == "" {
		outDir = "dist"
	}
	if _, err := os.Stat(filepath.Join(projectDir, outDir, "index.html")); err != nil {
		f.markCandidateFailed(ctx, job)
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorBuildFailed, ErrorMessage: fmt.Sprintf("build output missing index.html in %s: %v", outDir, err)}, nil
	}

	return StepResult{Status: model.StepStatusSucceeded}, nil
}

// resolveCandidateDir returns the workspace-rooted isolated candidate dir for
// this job's version, creating + populating it from the effective source on
// first use. All factory build/verify steps operate in this dir so candidate
// generation never mutates the effective source tree. It is idempotent: a
// re-attempt reuses the existing candidate dir.
func (f *FactoryRunner) resolveCandidateDir(ctx context.Context, app model.Application, job model.Job) (string, StepResult, bool) {
	priorEff, _ := f.Store.GetEffectiveApplicationVersion(ctx, app.ID)
	version, vres, ok := f.ensureCandidateVersion(ctx, app.ID, job.ID, priorEff)
	if !ok {
		return "", vres, false
	}
	srcDir := filepath.Join(f.Workspace, app.Path)
	candidateDir := filepath.Join(srcDir, "versions", version.ID)
	// Populate the candidate dir from the effective source on first use. A
	// re-attempt (candidate dir already present) keeps it as-is so the build is
	// reproducible and the effective source is untouched.
	if _, statErr := os.Stat(candidateDir); os.IsNotExist(statErr) {
		if err := f.prepareCandidateSource(srcDir, candidateDir); err != nil {
			_ = f.Store.MarkApplicationVersionStatus(ctx, version.ID, model.ApplicationVersionFailed)
			return "", StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorBuildFailed, ErrorMessage: fmt.Sprintf("prepare candidate source: %v", err)}, false
		}
	}
	return candidateDir, StepResult{}, true
}

// markCandidateFailed flips this job's candidate version to failed (best-effort).
func (f *FactoryRunner) markCandidateFailed(ctx context.Context, job model.Job) {
	if v, _ := f.Store.GetApplicationVersionByJob(ctx, job.ID); v != nil {
		_ = f.Store.MarkApplicationVersionStatus(ctx, v.ID, model.ApplicationVersionFailed)
	}
}

// runImageBuild implements design §5.5. Task 6 builds each candidate in an
// isolated versioned dir generated-apps/<slug>/versions/<version-id>/ so the
// candidate build NEVER mutates the effective source. The image tag is
// version-keyed (localhost/software-factory/<slug>:<version-id>) so candidate +
// effective images coexist. An application_versions row (status=building) is
// recorded for this candidate, linked by job_id, with ParentVersionID = the
// app's current effective version (the baseline).
func (f *FactoryRunner) runImageBuild(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	app, fail, ok := f.resolveApp(ctx, job)
	if !ok {
		return fail, nil
	}
	manifest, fail, ok := f.readManifest(app)
	if !ok {
		return fail, nil
	}

	// Resolve the isolated candidate dir (created + populated by the earlier
	// test_verification step, or here on first use if verification was skipped).
	candidateDir, fail, ok := f.resolveCandidateDir(ctx, app, job)
	if !ok {
		return fail, nil
	}
	version, _ := f.Store.GetApplicationVersionByJob(ctx, job.ID)

	rt := f.runtime()
	buildApp := app
	buildApp.Path = candidateDir
	// The container runtime on this host cannot reach image/npm registries: the
	// podman machine proxies outbound through 127.0.0.1:7897 (a local SOCKS proxy
	// that is currently off), so any in-container `npm ci`/`npm run build` hangs
	// on "connection refused". For static-vite apps the host already built dist/
	// during test_verification (inside this candidate dir), so serve that
	// pre-built bundle with a dist-copy nginx image (nginx:alpine cached locally)
	// instead of the generated multi-stage Dockerfile — keeping image_build
	// fully offline.
	if manifest.Entry == "static-vite" {
		_ = writeStaticHostingDockerfile(buildApp.Path)
	}
	var res deploy.CommandResult
	var err error
	if f.StreamCmds != nil {
		b := newCommandStreamBatcher(ctx, emit)
		b.start()
		_, res, err = rt.BuildImageWithCallbacks(ctx, buildApp, version.ID, b.addStdout, b.addStderr)
		b.close()
	} else {
		_, res, err = rt.BuildImage(ctx, buildApp, version.ID)
	}
	f.writeLogs(ctx, job, step, res)
	if err != nil || res.ExitCode != 0 {
		_ = f.Store.MarkApplicationVersionStatus(ctx, version.ID, model.ApplicationVersionFailed)
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorImageBuildFailed, ErrorMessage: fmt.Sprintf("%s build failed: %v", rt.Name(), err)}, nil
	}
	// manifest is used to confirm the build context is valid for this app; the
	// actual output verification is the deploy step's health check.
	_ = manifest
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

// ensureCandidateVersion returns the application_versions row for this job,
// creating it (status=building) on first use. It is idempotent on job_id: a
// re-attempt of the same job reuses its version. The parent is the app's current
// effective version (the baseline), captured at candidate-creation time.
func (f *FactoryRunner) ensureCandidateVersion(ctx context.Context, appID, jobID string, priorEff *model.ApplicationVersion) (*model.ApplicationVersion, StepResult, bool) {
	if existing, err := f.Store.GetApplicationVersionByJob(ctx, jobID); err != nil {
		return nil, StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("lookup version for job %s: %v", jobID, err)}, false
	} else if existing != nil {
		return existing, StepResult{}, true
	}
	parentID := ""
	if priorEff != nil {
		parentID = priorEff.ID
	}
	created, err := f.Store.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID:            "ver_" + id.New(),
		ApplicationID: appID,
		ParentVersionID: parentID,
		JobID:         jobID,
		Status:        model.ApplicationVersionBuilding,
	})
	if err != nil {
		return nil, StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("create version for job %s: %v", jobID, err)}, false
	}
	return created, StepResult{}, true
}

// prepareCandidateSource populates the isolated versioned build dir with a copy
// of the effective source so the candidate build does not mutate the effective
// source. Any pre-existing versions dir is left intact (sibling versions); only
// this candidate's own dir is recreated.
func (f *FactoryRunner) prepareCandidateSource(srcDir, candidateDir string) error {
	if err := os.RemoveAll(candidateDir); err != nil {
		return err
	}
	if err := os.MkdirAll(candidateDir, 0o755); err != nil {
		return err
	}
	return copyDir(srcDir, candidateDir)
}

// runDeployment implements design §5.6. Task 6: the candidate version is
// promoted to effective ONLY after it passes the health check. On health
// failure, a prior effective version is RETAINED (the app stays running on it,
// its container is NOT stopped) and ONLY the candidate is marked failed. When no
// prior effective version exists (fresh app), the legacy behavior holds (app →
// error) so the first-deploy failure tests stay green.
func (f *FactoryRunner) runDeployment(ctx context.Context, job model.Job, step model.JobStep, emit runner.StepRecordEmitter) (StepResult, error) {
	app, fail, ok := f.resolveApp(ctx, job)
	if !ok {
		return fail, nil
	}
	manifest, fail, ok := f.readManifest(app)
	if !ok {
		return fail, nil
	}

	// Capture the prior effective version BEFORE creating/promoting so the
	// retain path knows whether to keep it alive.
	priorEff, _ := f.Store.GetEffectiveApplicationVersion(ctx, app.ID)

	// The candidate version this job produced (created in runImageBuild). If the
	// deployment step is entered without a build (e.g. a direct deploy, or a test
	// that drives steps in isolation), ensure the version exists here so the
	// version lifecycle is robust to the entry point.
	version, verr := f.Store.GetApplicationVersionByJob(ctx, job.ID)
	if verr != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("lookup version for job %s: %v", job.ID, verr)}, nil
	}
	if version == nil {
		v, vres, ok := f.ensureCandidateVersion(ctx, app.ID, job.ID, priorEff)
		if !ok {
			return vres, nil
		}
		version = v
	}

	tag := version.ID
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
		_ = f.Store.MarkApplicationVersionStatus(ctx, version.ID, model.ApplicationVersionFailed)
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorPodmanRunFailed, ErrorMessage: fmt.Sprintf("%s run failed: %v", rt.Name(), err)}, nil
	}

	// Health check. On failure, the candidate is marked failed; the prior
	// effective version (if any) is RETAINED.
	healthURL := fmt.Sprintf("http://%s:%d", wslVMHealthIP(), host)
	url := fmt.Sprintf("http://%s:%d", appURLHost(), host)
	health := f.Health
	if health == nil {
		health = deploy.CheckHTTP
	}
	if herr := health(ctx, healthURL, 10*time.Second); herr != nil {
		_, _ = rt.StopContainer(ctx, container.Name)
		_, _ = rt.RemoveContainer(ctx, container.Name)
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
			Status:        "failed",
			CreatedAt:     now,
		})
		_ = f.Store.MarkApplicationVersionStatus(ctx, version.ID, model.ApplicationVersionFailed)
		if priorEff == nil {
			// Fresh app, no prior effective version to retain: keep the legacy
			// behavior so the first-deploy failure tests stay green.
			_ = f.Store.SetAppRuntime(ctx, app.ID, string(model.AppStatusError), "")
		}
		// When a prior effective version exists it is RETAINED: the app keeps
		// serving on it and its container is NOT stopped.
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorHealthCheckFailed, ErrorMessage: herr.Error()}, nil
	}

	// Success: record the running deployment, then transactionally promote the
	// candidate (effective + deployment_id), supersede the prior effective, and
	// flip the app to running on the new URL.
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
	if err := f.Store.CreateDeployment(ctx, dep); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("create deployment: %v", err)}, nil
	}
	if err := f.Store.PromoteApplicationVersion(ctx, app.ID, version.ID, dep.ID, url); err != nil {
		return StepResult{Status: model.StepStatusFailed, ErrorCode: model.ErrorUnknown, ErrorMessage: fmt.Sprintf("promote version: %v", err)}, nil
	}
	// Stop the OLD effective container (best-effort, outside the tx). The new
	// one is already running + recorded.
	f.stopPreviousDeployments(ctx, rt, app.ID, dep.ID)
	return StepResult{Status: model.StepStatusSucceeded}, nil
}

// copyDir recursively copies src into dst, skipping any "versions" subdir (so a
// candidate copy never recursively includes sibling versions or itself). It does
// not follow symlinks beyond the top level. Best-effort: a copy error aborts.
func copyDir(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		// Never copy the versions subtree: it holds isolated candidate builds
		// (including, potentially, this one) and would cause recursion.
		if e.Name() == "versions" {
			continue
		}
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := os.MkdirAll(d, 0o755); err != nil {
				return err
			}
			if err := copyDir(s, d); err != nil {
				return err
			}
		} else {
			data, rerr := os.ReadFile(s)
			if rerr != nil {
				return rerr
			}
			if err := os.WriteFile(d, data, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
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

// writeStaticHostingDockerfile overwrites the app's Dockerfile with a dist-copy
// nginx image when the host has already built dist/index.html (i.e. a static-vite
// app whose test_verification step produced a bundle in the candidate dir). It
// exists because the container runtime on this host cannot reach image/npm
// registries (the podman machine proxies through a dead 127.0.0.1:7897), so the
// generated multi-stage Dockerfile that runs `npm ci` + `npm run build`
// in-container would hang. Serving the host-built dist/ from cached nginx:alpine
// keeps image_build fully offline. It is a no-op when dist/index.html is absent,
// so non-static apps are unaffected.
func writeStaticHostingDockerfile(appDir string) error {
	if _, err := os.Stat(filepath.Join(appDir, "dist", "index.html")); err != nil {
		return nil // not a host-built static app; leave the generated Dockerfile
	}
	var b strings.Builder
	b.WriteString("# Static-hosting image: dist/ was built on the host by test_verification.\n")
	b.WriteString("# The container runtime cannot reach npm registries, so there is NO\n")
	b.WriteString("# in-container node build — nginx serves the pre-built static assets.\n")
	b.WriteString("FROM nginx:alpine\n")
	b.WriteString("COPY dist/ /usr/share/nginx/html\n")
	// Ensure an nginx server config exists; write a minimal SPA fallback if the
	// generated app did not ship one.
	nginxConf := filepath.Join(appDir, "nginx.conf")
	if _, err := os.Stat(nginxConf); err != nil {
		_ = os.WriteFile(nginxConf, []byte("server {\n  listen 80;\n  server_name localhost;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri /index.html; }\n}\n"), 0o644)
	}
	b.WriteString("COPY nginx.conf /etc/nginx/conf.d/default.conf\n")
	b.WriteString("EXPOSE 80\n")
	b.WriteString("CMD [\"nginx\", \"-g\", \"daemon off;\"]\n")
	if err := os.WriteFile(filepath.Join(appDir, "Dockerfile"), []byte(b.String()), 0o644); err != nil {
		return err
	}
	// The dist-copy image REQUIRES dist/ in the build context, but the generated
	// .dockerignore (a leftover from in-container builds) excludes dist — which
	// makes `COPY dist/` fail with "no items matching glob". Override it so dist/
	// and nginx.conf are sent to the builder while still trimming node_modules etc.
	_ = os.WriteFile(filepath.Join(appDir, ".dockerignore"),
		[]byte("node_modules\n.git\n.vite\n*.log\n"), 0o644)
	return nil
}

// wslVMHealthIP returns the host a container health probe should target. On
// Windows+WSL2 it is the WSL VM IP (wslrelay forwarding is unreliable); in a
// containerized deploy set FACTORY_HEALTH_HOST (e.g. "host-gateway") to override.
func wslVMHealthIP() string {
	if v := os.Getenv("FACTORY_HEALTH_HOST"); v != "" {
		return v
	}
	out, err := exec.Command("wsl", "-d", "podman-machine-default", "--", "sh", "-c",
		`ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+\.\d+\.\d+\.\d+'`).Output()
	if err == nil {
		ip := strings.TrimSpace(string(out))
		if ip != "" {
			return ip
		}
	}
	return "127.0.0.1"
}
