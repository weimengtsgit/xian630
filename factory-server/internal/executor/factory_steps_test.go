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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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
	res, err := r.Run(context.Background(), job, step)
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

// TestFactoryRunnerRejectsClaudeStep: a claude-mode kind returns a failed
// ErrorUnknown result without executing any command.
func TestFactoryRunnerRejectsClaudeStep(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepRequirementAnalysis)
	res, err := r.Run(context.Background(), job, step)
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
