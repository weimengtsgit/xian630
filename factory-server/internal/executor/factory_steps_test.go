package executor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// fakeCmdRunner is a deploy.CommandRunner that records every invocation and
// returns a configurable CommandResult keyed on the command name + first arg.
type fakeCmdRunner struct {
	mu       sync.Mutex
	results  map[string]deploy.CommandResult // key: name+" "+firstArg (or name)
	calls    []fakeCmdCall
	failOn   map[string]bool // key present → return non-zero
	anyFail  map[string]bool // alternate: exact name match returns fail
	defaults deploy.CommandResult
}

type fakeCmdCall struct {
	Dir   string
	Name  string
	Args  []string
	Res   deploy.CommandResult
	Index int
}

func newFakeCmdRunner() *fakeCmdRunner {
	return &fakeCmdRunner{
		results: map[string]deploy.CommandResult{},
		failOn:  map[string]bool{},
		anyFail: map[string]bool{},
		defaults: deploy.CommandResult{
			ExitCode: 0,
			Stdout:   "ok",
		},
	}
}

func keyOf(name string, args []string) string {
	if len(args) > 0 {
		return name + " " + args[0]
	}
	return name
}

func (f *fakeCmdRunner) Run(_ context.Context, dir, name string, args ...string) (deploy.CommandResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := keyOf(name, args)
	res, ok := f.results[key]
	if !ok {
		// fallback to bare name key
		if r2, ok2 := f.results[name]; ok2 {
			res = r2
		} else {
			res = f.defaults
		}
	}
	if f.failOn[key] || f.anyFail[name] {
		res.ExitCode = 1
		res.Stderr = "fake failure"
	}
	call := fakeCmdCall{Dir: dir, Name: name, Args: append([]string{}, args...), Res: res, Index: len(f.calls)}
	f.calls = append(f.calls, call)
	return res, nil
}

func (f *fakeCmdRunner) setRes(key string, r deploy.CommandResult) {
	f.results[key] = r
}

func (f *fakeCmdRunner) setCIFail() {
	f.failOn["npm ci"] = true
	f.failOn["npm install"] = true
}

func (f *fakeCmdRunner) names() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.Name + " " + strings.Join(c.Args, " ")
	}
	return out
}

func containsCommand(commands []string, want string) bool {
	for _, got := range commands {
		if got == want {
			return true
		}
	}
	return false
}

// seedFactoryWorkspace writes a generated-app workspace under a temp dir and
// returns the workspace root. It writes the manifest, package.json, optional
// package-lock.json, and dist/index.html.
func seedFactoryWorkspace(t *testing.T, withLock bool) string {
	t.Helper()
	root := t.TempDir()
	appDir := filepath.Join(root, "generated-apps", "demo")
	for _, d := range []string{filepath.Join(appDir, ".factory"), filepath.Join(appDir, "dist")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	manifest := `{
  "schemaVersion": 1,
  "slug": "demo",
  "name": "Demo",
  "type": "static",
  "source": "generated",
  "description": "demo app",
  "entry": "static-vite",
  "path": "generated-apps/demo",
  "build": {"command": "npm run build", "outputDir": "dist"},
  "docker": {"enabled": true, "dockerfile": "Dockerfile", "context": ".", "runtimePort": 8080}
}`
	if err := os.WriteFile(filepath.Join(appDir, ".factory", "app.json"), []byte(manifest), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "package.json"), []byte(`{"name":"demo"}`), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	if withLock {
		if err := os.WriteFile(filepath.Join(appDir, "package-lock.json"), []byte(`{}`), 0o644); err != nil {
			t.Fatalf("write lock: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(appDir, "dist", "index.html"), []byte(`<html></html>`), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	return root
}

func newFactoryTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now()
	app := model.Application{
		ID:        "app-demo",
		Slug:      "demo",
		Name:      "Demo",
		Type:      "static",
		Source:    model.AppSourceGenerated,
		Path:      "generated-apps/demo",
		Status:    model.AppStatusStopped,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := st.UpsertApplication(context.Background(), app); err != nil {
		t.Fatalf("upsert app: %v", err)
	}
	return st
}

func newFactoryRunner(st *store.Store, ws string, healthOk bool) (*FactoryRunner, *fakeCmdRunner) {
	cmds := newFakeCmdRunner()
	health := func(ctx context.Context, url string, timeout time.Duration) error {
		if !healthOk {
			return errHealthFailed
		}
		return nil
	}
	return &FactoryRunner{
		Store:        st,
		Cmds:         cmds,
		Alloc:        deploy.Allocator{Start: 18000, End: 18999},
		Health:       health,
		Workspace:    ws,
		ArtifactRoot: filepath.Join(ws, ".factory-runs"),
	}, cmds
}

func factoryJobStep(kind model.StepKind) (model.Job, model.JobStep) {
	job := model.Job{
		ID:              "job_demo_1",
		UserPrompt:      "x",
		AppSlug:         "demo",
		CreatedAppID:    "app-demo",
		Status:          model.JobStatusRunning,
		CurrentStepKind: kind,
	}
	step := model.JobStep{
		ID:      "step_" + string(kind),
		JobID:   "job_demo_1",
		Kind:    kind,
		Seq:     4,
		Status:  model.StepStatusRunning,
		Attempt: 1,
	}
	return job, step
}

var errHealthFailed = &healthErr{}

type healthErr struct{}

func (*healthErr) Error() string { return "health_check_failed" }

// TestTestVerificationRunsCiThenBuild: package-lock.json present → npm ci then
// npm run build, both succeed, result succeeded.
func TestTestVerificationRunsCiThenBuild(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepTestVerification)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	names := cmds.names()
	if len(names) != 2 {
		t.Fatalf("expected 2 commands, got %d: %v", len(names), names)
	}
	if names[0] != "npm ci" {
		t.Fatalf("cmd[0] = %q, want %q", names[0], "npm ci")
	}
	if names[1] != "npm run build" {
		t.Fatalf("cmd[1] = %q, want %q", names[1], "npm run build")
	}
}

// TestTestVerificationNpmInstallWhenNoLock: no lock file → npm install.
func TestTestVerificationNpmInstallWhenNoLock(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, false)
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepTestVerification)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s, want succeeded", res.Status)
	}
	if got := cmds.names()[0]; got != "npm install" {
		t.Fatalf("cmd[0] = %q, want %q", got, "npm install")
	}
}

// TestTestVerificationDependencyInstallFails: npm ci exits non-zero →
// dependency_install_failed.
func TestTestVerificationDependencyInstallFails(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)
	cmds.setCIFail()

	job, step := factoryJobStep(model.StepTestVerification)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed {
		t.Fatalf("status = %s, want failed", res.Status)
	}
	if res.ErrorCode != model.ErrorDependencyInstallFailed {
		t.Fatalf("error code = %s, want dependency_install_failed", res.ErrorCode)
	}
	if got := cmds.names()[0]; got != "npm ci" {
		t.Fatalf("cmd[0] = %q, want npm ci", got)
	}
}

// TestImageBuildRunsPodmanBuild: podman build invoked with the right tag.
func TestImageBuildRunsPodmanBuild(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepImageBuild)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	names := cmds.names()
	want := "podman build -t localhost/software-factory/demo:job-job_demo_1 ."
	if len(names) != 1 || names[0] != want {
		t.Fatalf("calls = %v, want [%q]", names, want)
	}
	// The podman build must run in the workspace-rooted project dir
	// (filepath.Join(workspace, app.Path)), not the bare relative app.Path.
	// In production the server's cwd is factory-server/, not the workspace
	// root, so a bare "generated-apps/demo" would resolve the build context
	// against the wrong directory.
	wantDir := filepath.Join(ws, "generated-apps", "demo")
	var buildCall *fakeCmdCall
	for i := range cmds.calls {
		c := &cmds.calls[i]
		if c.Name == "podman" && len(c.Args) > 0 && c.Args[0] == "build" {
			buildCall = c
			break
		}
	}
	if buildCall == nil {
		t.Fatalf("no podman build call recorded; calls=%v", names)
	}
	if buildCall.Dir != wantDir {
		t.Fatalf("podman build dir = %q, want %q (workspace-rooted)", buildCall.Dir, wantDir)
	}
}

// TestDeploymentRunsContainerHealthchecks: podman run + health ok → deployment
// row running + app running.
func TestDeploymentRunsContainerHealthchecks(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepDeployment)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	// podman run was invoked.
	hasRun := false
	for _, c := range cmds.calls {
		if c.Name == "podman" && len(c.Args) > 0 && c.Args[0] == "run" {
			hasRun = true
			break
		}
	}
	if !hasRun {
		t.Fatalf("no podman run recorded; calls=%v", cmds.names())
	}
	dep, err := st.GetActiveDeployment(context.Background(), "app-demo")
	if err != nil {
		t.Fatalf("GetActiveDeployment: %v", err)
	}
	if dep == nil || dep.Status != "running" {
		t.Fatalf("no running deployment; dep=%+v", dep)
	}
	if dep.HostPort != 18000 {
		t.Fatalf("host port = %d, want 18000", dep.HostPort)
	}
	if dep.ContainerPort != 8080 {
		t.Fatalf("container port = %d, want 8080", dep.ContainerPort)
	}
	app, err := st.GetApplication(context.Background(), "app-demo")
	if err != nil {
		t.Fatalf("GetApplication: %v", err)
	}
	if app.Status != model.AppStatusRunning {
		t.Fatalf("app status = %s, want running", app.Status)
	}
}

func TestDeploymentSkipsPortsUsedByOtherRunningApps(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	now := time.Now()
	other := model.Application{
		ID:         "app-other",
		Slug:       "other",
		Name:       "Other",
		Type:       "static",
		Source:     model.AppSourcePreset,
		Path:       "scene/other",
		Status:     model.AppStatusRunning,
		RuntimeURL: "http://127.0.0.1:18000",
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := st.UpsertApplication(context.Background(), other); err != nil {
		t.Fatalf("upsert other app: %v", err)
	}
	if err := st.CreateDeployment(context.Background(), model.Deployment{
		ID:            "dep_other",
		AppID:         other.ID,
		ImageName:     "localhost/software-factory/other",
		ImageTag:      "preset",
		ContainerName: "sf-other-live",
		HostPort:      18000,
		ContainerPort: 80,
		URL:           "http://127.0.0.1:18000",
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}); err != nil {
		t.Fatalf("create other deployment: %v", err)
	}
	r, _ := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepDeployment)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	dep, err := st.GetActiveDeployment(context.Background(), "app-demo")
	if err != nil {
		t.Fatalf("GetActiveDeployment: %v", err)
	}
	if dep == nil {
		t.Fatalf("no active deployment for app-demo")
	}
	if dep.HostPort != 18001 {
		t.Fatalf("host port = %d, want 18001 because 18000 is used by another app", dep.HostPort)
	}
}

func TestDeploymentStopsPreviousRunningDeploymentForSameAppAfterSuccess(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	now := time.Now()
	old := model.Deployment{
		ID:            "dep_old",
		AppID:         "app-demo",
		ImageName:     "localhost/software-factory/demo",
		ImageTag:      "old",
		ContainerName: "sf-demo-old",
		HostPort:      18000,
		ContainerPort: 8080,
		URL:           "http://127.0.0.1:18000",
		Status:        "running",
		CreatedAt:     now.Add(-time.Minute),
		StartedAt:     &now,
	}
	if err := st.CreateDeployment(context.Background(), old); err != nil {
		t.Fatalf("create old deployment: %v", err)
	}
	if err := st.SetAppRuntime(context.Background(), "app-demo", string(model.AppStatusRunning), old.URL); err != nil {
		t.Fatalf("set app runtime: %v", err)
	}
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepDeployment)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	if !containsCommand(cmds.names(), "podman stop sf-demo-old") || !containsCommand(cmds.names(), "podman rm sf-demo-old") {
		t.Fatalf("old deployment should be stopped and removed; calls=%v", cmds.names())
	}
	gotOld, err := st.GetDeployment(context.Background(), old.ID)
	if err != nil || gotOld == nil {
		t.Fatalf("get old deployment: %#v %v", gotOld, err)
	}
	if gotOld.Status != "stopped" {
		t.Fatalf("old deployment status = %q, want stopped", gotOld.Status)
	}
	active, err := st.GetActiveDeployment(context.Background(), "app-demo")
	if err != nil || active == nil {
		t.Fatalf("get active deployment: %#v %v", active, err)
	}
	if active.ID == old.ID || active.HostPort != 18001 {
		t.Fatalf("active deployment = %#v, want new deployment on 18001", active)
	}
}

func TestDeploymentSkipsAllRunningDeploymentsForSameApp(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	now := time.Now()
	for _, dep := range []model.Deployment{
		{
			ID:            "dep_old_18000",
			AppID:         "app-demo",
			ImageName:     "localhost/software-factory/demo",
			ImageTag:      "old",
			ContainerName: "sf-demo-old-18000",
			HostPort:      18000,
			ContainerPort: 8080,
			URL:           "http://127.0.0.1:18000",
			Status:        "running",
			CreatedAt:     now.Add(-2 * time.Minute),
			StartedAt:     &now,
		},
		{
			ID:            "dep_old_18002",
			AppID:         "app-demo",
			ImageName:     "localhost/software-factory/demo",
			ImageTag:      "old",
			ContainerName: "sf-demo-old-18002",
			HostPort:      18002,
			ContainerPort: 8080,
			URL:           "http://127.0.0.1:18002",
			Status:        "running",
			CreatedAt:     now.Add(-time.Minute),
			StartedAt:     &now,
		},
	} {
		if err := st.CreateDeployment(context.Background(), dep); err != nil {
			t.Fatalf("create deployment %s: %v", dep.ID, err)
		}
	}
	r, _ := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepDeployment)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	active, err := st.GetActiveDeployment(context.Background(), "app-demo")
	if err != nil || active == nil {
		t.Fatalf("get active deployment: %#v %v", active, err)
	}
	if active.HostPort != 18001 {
		t.Fatalf("host port = %d, want 18001 because 18000 and 18002 are already running", active.HostPort)
	}
}

// TestDeploymentHealthFailCleansUp: health fails → podman stop + rm recorded,
// deployment failed, app error, result health_check_failed.
func TestDeploymentHealthFailCleansUp(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, false)

	job, step := factoryJobStep(model.StepDeployment)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed {
		t.Fatalf("status = %s, want failed", res.Status)
	}
	if res.ErrorCode != model.ErrorHealthCheckFailed {
		t.Fatalf("error code = %s, want health_check_failed", res.ErrorCode)
	}
	names := cmds.names()
	hasStop, hasRm := false, false
	for _, n := range names {
		if strings.HasPrefix(n, "podman stop ") {
			hasStop = true
		}
		if strings.HasPrefix(n, "podman rm ") {
			hasRm = true
		}
	}
	if !hasStop || !hasRm {
		t.Fatalf("expected podman stop + rm; calls=%v", names)
	}
	deps, err := st.ListDeploymentsByApp(context.Background(), "app-demo")
	if err != nil {
		t.Fatalf("ListDeploymentsByApp: %v", err)
	}
	if len(deps) == 0 || deps[0].Status != "failed" {
		t.Fatalf("expected failed deployment row; got %+v", deps)
	}
	app, err := st.GetApplication(context.Background(), "app-demo")
	if err != nil {
		t.Fatalf("GetApplication: %v", err)
	}
	if app.Status != model.AppStatusError {
		t.Fatalf("app status = %s, want error", app.Status)
	}
}

// TestFactoryStepRedactsCredentialInCommandStdout (Task-2 Fix-2): the
// factory-step command-log path routes stdout/stderr through registerCappedLog,
// which redacts credentials before writing the audit-only stdout.log/stderr.log.
// A credential planted in a factory command's stdout must be masked in the
// resulting stdout.log artifact content, and a command_stderr artifact row
// must be registered. This guards the design invariant that command logs are
// displayable sanitized audit copies.
func TestFactoryStepRedactsCredentialInCommandStdout(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)
	// Plant a credential in npm run build's stdout. build is the LAST command
	// run by StepTestVerification, so its stdout.log is the final content of
	// the attempt's stdout.log (writeLogs writes per-command to the same
	// attempt path). Asserting on build's stdout.log isolates the redaction
	// path from the overwrite ordering.
	cmds.setRes("npm run", deploy.CommandResult{
		ExitCode: 0,
		Stdout:   "built ok\nAuthorization: Bearer leak-xyz\nDB_PASSWORD=hunter2\n",
	})

	job, step := factoryJobStep(model.StepTestVerification)
	if _, err := r.Run(context.Background(), job, step, runner.NopEmitter{}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// The attempt workspace stdout.log must contain [REDACTED] and not the
	// planted secrets. writeLogs writes to the attempt dir derived from the
	// same ArtifactRoot/JobID/StepKind/Attempt the runner uses.
	w := runner.AttemptWorkspace{
		Root: r.ArtifactRoot, JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt,
	}
	stdoutLog, err := os.ReadFile(w.StdoutPath())
	if err != nil {
		t.Fatalf("read stdout.log %s: %v", w.StdoutPath(), err)
	}
	if strings.Contains(string(stdoutLog), "leak-xyz") {
		t.Fatalf("stdout.log leaked bearer token: %s", stdoutLog)
	}
	if strings.Contains(string(stdoutLog), "hunter2") {
		t.Fatalf("stdout.log leaked password: %s", stdoutLog)
	}
	if !strings.Contains(string(stdoutLog), "[REDACTED]") {
		t.Fatalf("stdout.log missing [REDACTED]: %s", stdoutLog)
	}
	// Non-secret stdout must survive so the log stays diagnostic.
	if !strings.Contains(string(stdoutLog), "built ok") {
		t.Fatalf("stdout.log lost non-secret content: %s", stdoutLog)
	}
	// A command_stdout artifact row was registered pointing at stdout.log.
	arts, err := st.ListArtifactsByJob(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListArtifactsByJob: %v", err)
	}
	var hasStdout, hasStderr bool
	for _, a := range arts {
		if a.Kind == "command_stdout" {
			hasStdout = true
		}
		if a.Kind == "command_stderr" {
			hasStderr = true
		}
	}
	if !hasStdout || !hasStderr {
		t.Fatalf("expected command_stdout + command_stderr artifacts; got %+v", arts)
	}
}

// TestFactoryRunnerRejectsClaudeStep: a claude-mode kind returns a failed
// ErrorUnknown result without executing any command.
func TestFactoryRunnerRejectsClaudeStep(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepRequirementAnalysis)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed || res.ErrorCode != model.ErrorUnknown {
		t.Fatalf("status/code = %s/%s, want failed/unknown", res.Status, res.ErrorCode)
	}
	if len(cmds.calls) != 0 {
		t.Fatalf("expected no commands; got %v", cmds.names())
	}
}

// ---- Factory command streaming (Task 3 completion) ----
//
// These tests exercise the live command_stdout/command_stderr record streaming
// wired into the factory steps. They inject a fake streaming runner that
// produces known stdout/stderr lines (including a multi-KiB burst to exercise
// the ≤4 KiB chunk boundary and an end-flush of the tail), and assert:
//   - the lines appear in command_stdout / command_stderr records;
//   - a ≥4 KiB pending buffer is flushed mid-stream into a ≤4 KiB chunk;
//   - the remaining tail is flushed when the command ends (no dropped output);
//   - output ACCUMULATES across the commands of one step (not overwritten —
//     the Task-2 cross-task note that writeLogs clobbered earlier commands);
//   - a non-zero exit still maps to the right error code;
//   - secrets in stdout are still redacted in the capped artifact.

// fakeStreamCmdRunner is a deploy.CommandRunner AND deploy.StreamCommandRunner.
// It records every Run AND RunStreamWithInput call, and for streaming calls it
// replays a configured script of stdout/stderr lines into the callbacks (so the
// batcher can be exercised deterministically without spawning subprocesses).
type fakeStreamCmdRunner struct {
	mu        sync.Mutex
	calls     []fakeCmdCall
	streams   []fakeStreamCall
	results   map[string]deploy.CommandResult // key name[+arg0]
	defaults  deploy.CommandResult
	stdoutFor map[string][]string // key → stdout lines
	stderrFor map[string][]string // key → stderr lines
	failOn    map[string]bool
}

type fakeStreamCall struct {
	Dir   string
	Name  string
	Args  []string
	Res   deploy.CommandResult
	Index int
}

func newFakeStreamCmdRunner() *fakeStreamCmdRunner {
	return &fakeStreamCmdRunner{
		results:   map[string]deploy.CommandResult{},
		stdoutFor: map[string][]string{},
		stderrFor: map[string][]string{},
		failOn:    map[string]bool{},
		defaults:  deploy.CommandResult{ExitCode: 0, Stdout: "ok"},
	}
}

func (f *fakeStreamCmdRunner) Run(_ context.Context, dir, name string, args ...string) (deploy.CommandResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := keyOf(name, args)
	res := f.lookup(key, name)
	if f.failOn[key] {
		res.ExitCode = 1
		res.Stderr = "fake failure"
	}
	f.calls = append(f.calls, fakeCmdCall{Dir: dir, Name: name, Args: append([]string{}, args...), Res: res, Index: len(f.calls)})
	return res, nil
}

func (f *fakeStreamCmdRunner) RunStreamWithInput(_ context.Context, dir, _ string, onStdout, onStderr func(string), name string, args ...string) (deploy.CommandResult, error) {
	f.mu.Lock()
	key := keyOf(name, args)
	res := f.lookupLocked(key, name)
	stdoutLines := append([]string{}, f.stdoutFor[key]...)
	stderrLines := append([]string{}, f.stderrFor[key]...)
	// Mirror the production OSRunner: the returned CommandResult carries the
	// accumulated stdout/stderr, not a static default. Derive from the replayed
	// lines unless the caller set an explicit result for this key (which carries
	// its own Stdout/Stderr).
	if _, explicit := f.results[key]; !explicit {
		if len(stdoutLines) > 0 {
			res.Stdout = strings.Join(stdoutLines, "\n") + "\n"
		}
		if len(stderrLines) > 0 {
			res.Stderr = strings.Join(stderrLines, "\n") + "\n"
		}
	}
	if f.failOn[key] {
		res.ExitCode = 1
	}
	call := fakeStreamCall{Dir: dir, Name: name, Args: append([]string{}, args...), Res: res, Index: len(f.streams)}
	f.streams = append(f.streams, call)
	f.mu.Unlock()
	// Replay lines OUTSIDE the lock so callbacks (which emit records through a
	// mutex-guarded emitter) cannot deadlock against this runner's lock.
	for _, ln := range stdoutLines {
		if onStdout != nil {
			onStdout(ln)
		}
	}
	for _, ln := range stderrLines {
		if onStderr != nil {
			onStderr(ln)
		}
	}
	return res, nil
}

func (f *fakeStreamCmdRunner) lookup(key, name string) deploy.CommandResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lookupLocked(key, name)
}

func (f *fakeStreamCmdRunner) lookupLocked(key, name string) deploy.CommandResult {
	if r, ok := f.results[key]; ok {
		return r
	}
	if r, ok := f.results[name]; ok {
		return r
	}
	return f.defaults
}

// recordingEmitter is a runner.StepRecordEmitter that captures every emitted
// record for assertions.
type recordingEmitter struct {
	mu      sync.Mutex
	records []recEmitterEntry
}

type recEmitterEntry struct {
	Kind    model.ExecutionRecordKind
	Content string
}

func (r *recordingEmitter) Emit(_ context.Context, kind model.ExecutionRecordKind, content string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, recEmitterEntry{Kind: kind, Content: content})
	return nil
}

func (r *recordingEmitter) snapshot() []recEmitterEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]recEmitterEntry, len(r.records))
	copy(out, r.records)
	return out
}

func (r *recordingEmitter) joined(k model.ExecutionRecordKind) string {
	var b strings.Builder
	for _, e := range r.snapshot() {
		if e.Kind == k {
			b.WriteString(e.Content)
		}
	}
	return b.String()
}

func (r *recordingEmitter) ofKind(k model.ExecutionRecordKind) []recEmitterEntry {
	var out []recEmitterEntry
	for _, e := range r.snapshot() {
		if e.Kind == k {
			out = append(out, e)
		}
	}
	return out
}

// TestFactoryStepStreamsStdoutAndStderrRecords: with a streaming runner wired,
// a test_verification step emits command_stdout records containing each stdout
// line and command_stderr records for stderr lines. Output accumulates across
// the two commands (npm ci + npm run build) — neither command's output is
// overwritten by the other.
func TestFactoryStepStreamsStdoutAndStderrRecords(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	cmds := newFakeStreamCmdRunner()
	cmds.stdoutFor["npm ci"] = []string{"ci: installing", "ci: done"}
	cmds.stderrFor["npm ci"] = []string{"ci: warn deprecated"}
	cmds.stdoutFor["npm run"] = []string{"build: bundling", "build: done"}
	cmds.stderrFor["npm run"] = []string{"build: warn sourcemap"}
	health := func(ctx context.Context, url string, timeout time.Duration) error { return nil }
	r := &FactoryRunner{
		Store:        st,
		Cmds:         cmds,
		StreamCmds:   cmds, // streaming-capable: routes runCmd through the batcher
		Alloc:        deploy.Allocator{Start: 18000, End: 18999},
		Health:       health,
		Workspace:    ws,
		ArtifactRoot: filepath.Join(ws, ".factory-runs"),
	}

	emit := &recordingEmitter{}
	job, step := factoryJobStep(model.StepTestVerification)
	res, err := r.Run(context.Background(), job, step, emit)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s, want succeeded", res.Status)
	}

	stdoutJoined := emit.joined(model.ExecutionRecordCommandStdout)
	stderrJoined := emit.joined(model.ExecutionRecordCommandStderr)
	for _, want := range []string{"ci: installing", "ci: done", "build: bundling", "build: done"} {
		if !strings.Contains(stdoutJoined, want) {
			t.Errorf("command_stdout missing %q; got:\n%s", want, stdoutJoined)
		}
	}
	for _, want := range []string{"ci: warn deprecated", "build: warn sourcemap"} {
		if !strings.Contains(stderrJoined, want) {
			t.Errorf("command_stderr missing %q; got:\n%s", want, stderrJoined)
		}
	}
}

// TestFactoryStepStreamingChunksLargeOutputAndFlushesTail: a stdout burst larger
// than the 4 KiB batch threshold produces at least one ≤4 KiB mid-stream
// command_stdout chunk AND a final chunk carrying the remainder (no dropped
// tail). The time-based flush path is asserted structurally elsewhere.
func TestFactoryStepStreamingChunksLargeOutputAndFlushesTail(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	cmds := newFakeStreamCmdRunner()
	// One big "line" of 10 KiB — well above the 4 KiB chunk threshold.
	big := strings.Repeat("x", 10*1024)
	cmds.stdoutFor["npm ci"] = []string{"ci-ok"}
	cmds.stdoutFor["npm run"] = []string{big, "tail-line"}
	health := func(ctx context.Context, url string, timeout time.Duration) error { return nil }
	r := &FactoryRunner{
		Store: st, Cmds: cmds, StreamCmds: cmds,
		Alloc: deploy.Allocator{Start: 18000, End: 18999}, Health: health,
		Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"),
	}
	emit := &recordingEmitter{}
	job, step := factoryJobStep(model.StepTestVerification)
	if _, err := r.Run(context.Background(), job, step, emit); err != nil {
		t.Fatalf("Run: %v", err)
	}
	chunks := emit.ofKind(model.ExecutionRecordCommandStdout)
	if len(chunks) < 2 {
		t.Fatalf("want ≥2 command_stdout chunks (mid-stream + end flush); got %d: %#v", len(chunks), chunks)
	}
	const maxChunk = 4 * 1024
	for i, c := range chunks {
		if len(c.Content) > maxChunk {
			t.Errorf("chunk %d is %d bytes, exceeds 4 KiB cap", i, len(c.Content))
		}
	}
	// The tail line must survive — end-flush dropped nothing.
	joined := emit.joined(model.ExecutionRecordCommandStdout)
	if !strings.Contains(joined, "tail-line") {
		t.Errorf("tail-line dropped by end-flush; joined:\n%s", joined)
	}
	if !strings.Contains(joined, "ci-ok") {
		t.Errorf("ci-ok lost — accumulation across commands failed; joined:\n%s", joined)
	}
	// The 10 KiB of 'x' must all be present (across multiple chunks).
	if got := strings.Count(joined, "x"); got != 10*1024 {
		t.Errorf("x count = %d, want %d (some stdout dropped)", got, 10*1024)
	}
}

// TestFactoryStepStreamingPreservesErrorCode: streaming does not change the
// exit-code → error-code mapping. A failing npm run build still yields
// build_failed; a failing npm ci yields dependency_install_failed.
func TestFactoryStepStreamingPreservesErrorCode(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	cmds := newFakeStreamCmdRunner()
	cmds.failOn["npm run"] = true
	cmds.stderrFor["npm run"] = []string{"build error: ENOTFOUND"}
	health := func(ctx context.Context, url string, timeout time.Duration) error { return nil }
	r := &FactoryRunner{
		Store: st, Cmds: cmds, StreamCmds: cmds,
		Alloc: deploy.Allocator{Start: 18000, End: 18999}, Health: health,
		Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"),
	}
	emit := &recordingEmitter{}
	job, step := factoryJobStep(model.StepTestVerification)
	res, err := r.Run(context.Background(), job, step, emit)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed || res.ErrorCode != model.ErrorBuildFailed {
		t.Fatalf("status/code = %s/%s, want failed/build_failed", res.Status, res.ErrorCode)
	}
	// The streamed build error must still appear as a command_stderr record.
	if !strings.Contains(emit.joined(model.ExecutionRecordCommandStderr), "build error: ENOTFOUND") {
		t.Errorf("command_stderr missing streamed build error; got:\n%s", emit.joined(model.ExecutionRecordCommandStderr))
	}
}

// TestFactoryStepStreamingStillRedactsSecretInArtifact: even though records now
// stream live, the capped stdout.log artifact is still written through the
// redaction path, so a secret in stdout is masked in the artifact file.
func TestFactoryStepStreamingStillRedactsSecretInArtifact(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	cmds := newFakeStreamCmdRunner()
	cmds.stdoutFor["npm run"] = []string{"built ok", "Authorization: Bearer leak-xyz", "DB_PASSWORD=hunter2"}
	health := func(ctx context.Context, url string, timeout time.Duration) error { return nil }
	r := &FactoryRunner{
		Store: st, Cmds: cmds, StreamCmds: cmds,
		Alloc: deploy.Allocator{Start: 18000, End: 18999}, Health: health,
		Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"),
	}
	emit := &recordingEmitter{}
	job, step := factoryJobStep(model.StepTestVerification)
	if _, err := r.Run(context.Background(), job, step, emit); err != nil {
		t.Fatalf("Run: %v", err)
	}
	w := runner.AttemptWorkspace{Root: r.ArtifactRoot, JobID: job.ID, StepKind: step.Kind, Attempt: step.Attempt}
	stdoutLog, err := os.ReadFile(w.StdoutPath())
	if err != nil {
		t.Fatalf("read stdout.log: %v", err)
	}
	if strings.Contains(string(stdoutLog), "leak-xyz") || strings.Contains(string(stdoutLog), "hunter2") {
		t.Fatalf("stdout.log leaked a secret: %s", stdoutLog)
	}
	if !strings.Contains(string(stdoutLog), "[REDACTED]") {
		t.Fatalf("stdout.log missing [REDACTED]: %s", stdoutLog)
	}
	// Streaming coverage: the batcher DID emit a command_stdout record (the
	// non-secret marker "built ok" survives). recordingEmitter is a pre-chokepoint
	// test seam — it captures exactly what the batcher handed the emitter, before
	// stepEmitter.Emit redacts. In production the persisted + SSE record IS
	// redacted at that chokepoint, so we deliberately do NOT assert the secret
	// here; that guarantee is proven directly by
	// TestStepEmitterEmitRedactsBeforePersistAndPublish.
	if !strings.Contains(emit.joined(model.ExecutionRecordCommandStdout), "built ok") {
		t.Errorf("command_stdout record not streamed; got:\n%s", emit.joined(model.ExecutionRecordCommandStdout))
	}
}

// TestFactoryImageBuildStreamsPodmanStdout: image_build emits live
// command_stdout records from podman build (argv stays centralized in
// deploy.Podman — the executor never copies the podman argv).
func TestFactoryImageBuildStreamsPodmanStdout(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	cmds := newFakeStreamCmdRunner()
	cmds.stdoutFor["podman build"] = []string{"STEP 1: FROM", "STEP 2: COPY", "DONE"}
	health := func(ctx context.Context, url string, timeout time.Duration) error { return nil }
	r := &FactoryRunner{
		Store: st, Cmds: cmds, StreamCmds: cmds,
		Alloc: deploy.Allocator{Start: 18000, End: 18999}, Health: health,
		Workspace: ws, ArtifactRoot: filepath.Join(ws, ".factory-runs"),
	}
	emit := &recordingEmitter{}
	job, step := factoryJobStep(model.StepImageBuild)
	res, err := r.Run(context.Background(), job, step, emit)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s, want succeeded", res.Status)
	}
	joined := emit.joined(model.ExecutionRecordCommandStdout)
	for _, want := range []string{"STEP 1: FROM", "STEP 2: COPY", "DONE"} {
		if !strings.Contains(joined, want) {
			t.Errorf("command_stdout missing %q; got:\n%s", want, joined)
		}
	}
}
