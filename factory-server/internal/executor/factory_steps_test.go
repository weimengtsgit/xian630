package executor

import (
	"context"
	"os"
	"path/filepath"
	"sort"
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

// TestImageBuildRunsPodmanBuild: podman build invoked with the version-keyed
// tag. A candidate build resolves to an isolated versioned dir under the app's
// generated-apps/<slug>/ tree and tags the image
// localhost/software-factory/<slug>:<version-id> so candidate + effective
// images coexist.
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
	// The tag is the candidate version id (ver_<rand>), not the job id. Capture
	// it from the build argv and assert the repo/slug prefix + the ver_ tag.
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
	// argv shape: build -t localhost/software-factory/demo:<ver-id> .
	wantTagPrefix := "localhost/software-factory/demo:ver_"
	gotTag := ""
	for i, a := range buildCall.Args {
		if a == "-t" && i+1 < len(buildCall.Args) {
			gotTag = buildCall.Args[i+1]
		}
	}
	if !strings.HasPrefix(gotTag, wantTagPrefix) {
		t.Fatalf("image tag = %q, want prefix %q", gotTag, wantTagPrefix)
	}
	// The candidate build must run inside the isolated versioned dir, NOT the
	// effective source dir (generated-apps/demo). The candidate dir is
	// generated-apps/demo/versions/<ver-id>.
	if !strings.HasPrefix(buildCall.Dir, filepath.Join(ws, "generated-apps", "demo", "versions")+string(os.PathSeparator)) {
		t.Fatalf("podman build dir = %q, want a versioned subdir under generated-apps/demo/versions/", buildCall.Dir)
	}
	// An application_versions row must have been recorded for this candidate,
	// linked to the job, in the building state.
	versions, err := st.ListApplicationVersions(context.Background(), "app-demo")
	if err != nil {
		t.Fatalf("ListApplicationVersions: %v", err)
	}
	if len(versions) != 1 || versions[0].JobID != job.ID || versions[0].Status != model.ApplicationVersionBuilding {
		t.Fatalf("expected one building version for job %s; got %+v", job.ID, versions)
	}
}

// TestImageBuildUsesConfiguredRuntimeNotPodman: when FactoryRunner.Runtime is
// set (production wires it from FACTORY_CONTAINER_RUNTIME), image_build MUST
// drive that runtime and MUST NOT shell out to a hardcoded podman. Regression
// test for the bug where FACTORY_CONTAINER_RUNTIME=docker was set and the
// server logged container_runtime=docker, yet image_build still ran
// `podman build` and failed with "podman: executable file not found".
func TestImageBuildUsesConfiguredRuntimeNotPodman(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	r, cmds := newFactoryRunner(st, ws, true)
	fr := &fakeContainerRuntime{name: "docker"}
	r.Runtime = fr

	job, step := factoryJobStep(model.StepImageBuild)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	if fr.buildCalls != 1 {
		t.Fatalf("configured runtime BuildImage calls = %d, want 1", fr.buildCalls)
	}
	for _, c := range cmds.calls {
		if c.Name == "podman" {
			t.Fatalf("hardcoded podman invoked despite a custom Runtime being set: %v", c.Args)
		}
	}
}

// TestImageBuildFailsOnInvalidNginxConfig: a static-vite app whose generated
// nginx.conf nginx refuses to load (here: a truncated location regex
// "^/api/marinecadastre/(\d", the real-world glm long-output-truncation failure)
// must fail image_build with the nginx -t output — not sail through and surface
// 30s later as a non-repairable deploy health_check_failed.
func TestImageBuildFailsOnInvalidNginxConfig(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	// Ship a generated nginx.conf with a truncated location regex (missing "+)").
	// writeStaticHostingDockerfile only synthesizes one when absent, so it keeps
	// this broken file and bakes it into the nginx:alpine image.
	appDir := filepath.Join(ws, "generated-apps", "demo")
	if err := os.WriteFile(filepath.Join(appDir, "nginx.conf"),
		[]byte("server {\n  listen 80;\n  location ~ ^/api/marinecadastre/(\\d {\n    return 200;\n  }\n}\n"),
		0o644); err != nil {
		t.Fatalf("write nginx.conf: %v", err)
	}
	r, cmds := newFactoryRunner(st, ws, true)
	// Simulate `nginx -t` rejecting the baked config (the validation runs
	// `podman run --rm <image> nginx -t`). The fake build step itself succeeds.
	cmds.setRes("podman run", deploy.CommandResult{
		ExitCode: 1,
		Stderr:   `nginx: [emerg] pcre2_compile() failed: missing closing parenthesis in "^/api/marinecadastre/(\d" in /etc/nginx/conf.d/default.conf:13`,
	})

	job, step := factoryJobStep(model.StepImageBuild)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed || res.ErrorCode != model.ErrorImageBuildFailed {
		t.Fatalf("status = %s/%s (%s), want failed/image_build_failed", res.Status, res.ErrorCode, res.ErrorMessage)
	}
	if !strings.Contains(res.ErrorMessage, "nginx") ||
		!strings.Contains(res.ErrorMessage, "missing closing parenthesis") {
		t.Fatalf("error message should include the nginx -t output; got:\n%s", res.ErrorMessage)
	}
	// The candidate version must be marked failed.
	versions, err := st.ListApplicationVersions(context.Background(), "app-demo")
	if err != nil {
		t.Fatalf("ListApplicationVersions: %v", err)
	}
	if len(versions) != 1 || versions[0].Status != model.ApplicationVersionFailed {
		t.Fatalf("expected one failed version; got %+v", versions)
	}
}

// TestSanitizeNginxLocationRegexesQuotesBraceQuantifier: an unquoted location
// regex with a brace quantifier (the real "\d{4}" failure) gets quoted; regexes
// without braces, prefix locations, and already-quoted regexes are untouched;
// and the transform is idempotent.
func TestSanitizeNginxLocationRegexesQuotesBraceQuantifier(t *testing.T) {
	dir := t.TempDir()
	conf := filepath.Join(dir, "nginx.conf")
	in := `server {
    listen 80;
    location ~ ^/api/marinecadastre/(\d{4})/MapServer/(.*)$ {
        return 200;
    }
    location ~* ^/v[0-9]+/items$ {
        return 200;
    }
    location ~ "^/already/(\d{2})/x$" {
        return 200;
    }
    location / {
        try_files $uri /index.html;
    }
}`
	if err := os.WriteFile(conf, []byte(in), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := sanitizeNginxLocationRegexes(conf); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	gotBytes, _ := os.ReadFile(conf)
	got := string(gotBytes)
	wantBrace := `    location ~ "^/api/marinecadastre/(\d{4})/MapServer/(.*)$" {`
	wantNoBrace := `    location ~* ^/v[0-9]+/items$ {`
	wantAlready := `    location ~ "^/already/(\d{2})/x$" {`
	for _, want := range []string{wantBrace, wantNoBrace, wantAlready} {
		if !strings.Contains(got, want) {
			t.Fatalf("sanitized output missing %q;\ngot:\n%s", want, got)
		}
	}
	// The brace location must be quoted exactly once (no double-quoting).
	if c := strings.Count(got, "~ \"^/api/marinecadastre"); c != 1 {
		t.Fatalf("brace location quoted %d times, want 1;\ngot:\n%s", c, got)
	}
	// Idempotent: a second run is a no-op.
	if err := sanitizeNginxLocationRegexes(conf); err != nil {
		t.Fatalf("sanitize 2nd: %v", err)
	}
	got2Bytes, _ := os.ReadFile(conf)
	if string(got2Bytes) != got {
		t.Fatalf("sanitize not idempotent;\n2nd run:\n%s", string(got2Bytes))
	}
	// A missing file (non-nginx app) is not an error.
	if err := sanitizeNginxLocationRegexes(filepath.Join(dir, "nope.conf")); err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
}

// TestSanitizeNginxProxyPassUpstreams: a literal external-host proxy_pass is
// converted to a variable + server-level resolver; container names, IPs,
// localhost, and already-variable upstreams are left literal. Idempotent.
func TestSanitizeNginxProxyPassUpstreams(t *testing.T) {
	dir := t.TempDir()
	conf := filepath.Join(dir, "nginx.conf")
	in := `server {
    listen 80;
    root /usr/share/nginx/html;
    location /api/wind/ {
        proxy_pass https://api.open-meteo.com/;
    }
    location /api/internal/ {
        proxy_pass http://factory:8787/;
    }
    location /api/local/ {
        proxy_pass http://127.0.0.1:3000/;
    }
    location /api/var/ {
        set $backend "api.example.com";
        proxy_pass https://$backend/path;
    }
    location / { try_files $uri /index.html; }
}`
	if err := os.WriteFile(conf, []byte(in), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := sanitizeNginxProxyPassUpstreams(conf); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	gotBytes, _ := os.ReadFile(conf)
	got := string(gotBytes)

	wantConv := "        set $sf_upstream \"api.open-meteo.com\";\n        proxy_pass https://$sf_upstream/;"
	if !strings.Contains(got, wantConv) {
		t.Fatalf("external host not converted to variable;\ngot:\n%s", got)
	}
	// Container name, IP, and localhost literals left as-is.
	for _, want := range []string{
		"proxy_pass http://factory:8787/;",
		"proxy_pass http://127.0.0.1:3000/;",
		"proxy_pass https://$backend/path;",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected literal left untouched %q;\ngot:\n%s", want, got)
		}
	}
	// Server-level resolver injected exactly once, after the (single) listen.
	if c := strings.Count(got, "resolver 8.8.8.8"); c != 1 {
		t.Fatalf("resolver injected %d times, want 1;\ngot:\n%s", c, got)
	}
	if !strings.HasPrefix(strings.TrimSpace(strings.Split(got, "resolver 8.8.8.8")[0]), "listen 80;") {
		// sanity: resolver comes right after the listen line (allow for the
		// trailing newline + indent we injected)
	}
	listenIdx := strings.Index(got, "listen 80;")
	resolverIdx := strings.Index(got, "resolver 8.8.8.8")
	if listenIdx < 0 || resolverIdx < 0 || resolverIdx < listenIdx {
		t.Fatalf("resolver should come after listen;\ngot:\n%s", got)
	}
	// Idempotent.
	if err := sanitizeNginxProxyPassUpstreams(conf); err != nil {
		t.Fatalf("sanitize 2nd: %v", err)
	}
	got2, _ := os.ReadFile(conf)
	if string(got2) != got {
		t.Fatalf("sanitize not idempotent;\n2nd:\n%s", string(got2))
	}
	// Missing file is not an error.
	if err := sanitizeNginxProxyPassUpstreams(filepath.Join(dir, "nope.conf")); err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
}

func TestSanitizeNginxVariableProxyPassWithPort(t *testing.T) {
	dir := t.TempDir()
	conf := filepath.Join(dir, "nginx.conf")
	in := `server {
    listen 80;
    resolver 127.0.0.11 8.8.8.8 114.114.114.114 valid=30s ipv6=off;
    location /api/ontology/ {
        set $ontology_upstream ceshi.projects.bingosoft.net:8081;
        proxy_pass http://$ontology_upstream/;
        proxy_set_header Host ceshi.projects.bingosoft.net;
    }
}`
	if err := os.WriteFile(conf, []byte(in), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := sanitizeNginxVariableProxyPassUpstreams(conf); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	gotBytes, _ := os.ReadFile(conf)
	got := string(gotBytes)
	if strings.Contains(got, "127.0.0.11") {
		t.Fatalf("Docker-only resolver should be removed from generated app config;\ngot:\n%s", got)
	}
	if strings.Contains(got, "$ontology_upstream") {
		t.Fatalf("variable upstream should be collapsed to literal host:port;\ngot:\n%s", got)
	}
	if !strings.Contains(got, "proxy_pass http://ceshi.projects.bingosoft.net:8081/;") {
		t.Fatalf("literal upstream proxy_pass missing;\ngot:\n%s", got)
	}
	if err := sanitizeNginxVariableProxyPassUpstreams(conf); err != nil {
		t.Fatalf("sanitize 2nd: %v", err)
	}
	got2Bytes, _ := os.ReadFile(conf)
	if string(got2Bytes) != got {
		t.Fatalf("sanitize not idempotent;\n2nd:\n%s", string(got2Bytes))
	}
}

func TestSanitizeNginxVariableProxyPassWithPortAndURI(t *testing.T) {
	dir := t.TempDir()
	conf := filepath.Join(dir, "nginx.conf")
	in := `server {
    listen 80;
    resolver 127.0.0.11 8.8.8.8 114.114.114.114 valid=30s ipv6=off;
    location /api/ontology/ {
        set $ontology_upstream ceshi.projects.bingosoft.net:8081;
        proxy_pass http://$ontology_upstream/daasDMS/;
        proxy_set_header Host ceshi.projects.bingosoft.net;
    }
}`
	if err := os.WriteFile(conf, []byte(in), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := sanitizeNginxVariableProxyPassUpstreams(conf); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	gotBytes, _ := os.ReadFile(conf)
	got := string(gotBytes)
	if strings.Contains(got, "127.0.0.11") {
		t.Fatalf("Docker-only resolver should be removed from generated app config;\ngot:\n%s", got)
	}
	if strings.Contains(got, "$ontology_upstream") {
		t.Fatalf("variable upstream should be collapsed to literal host:port with URI;\ngot:\n%s", got)
	}
	if !strings.Contains(got, "proxy_pass http://ceshi.projects.bingosoft.net:8081/daasDMS/;") {
		t.Fatalf("literal upstream proxy_pass with URI missing;\ngot:\n%s", got)
	}
}

func TestSanitizeOntologyNginxProxyCredentialsReplacesPlaceholders(t *testing.T) {
	dir := t.TempDir()
	envDir := filepath.Join(dir, ".claude", "skills", "carrier-affiliation-data-skill", "config")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatalf("mkdir env dir: %v", err)
	}
	envFile := filepath.Join(envDir, "ontology.env")
	if err := os.WriteFile(envFile, []byte("ONTOLOGY_AUTH_TOKEN=real-token\nONTOLOGY_SPACE_ID=real-space\nONTOLOGY_SCOPE_TYPE=Space\n"), 0o644); err != nil {
		t.Fatalf("write env: %v", err)
	}
	conf := filepath.Join(dir, "nginx.conf")
	in := `server {
    listen 80;
    location /api/ontology/ {
        proxy_set_header Authorization "Bearer <ONTOLOGY_AUTH_TOKEN>";
        proxy_set_header Spaceid "SPACE_123";
        proxy_set_header scopeType "Space";
    }
}`
	if err := os.WriteFile(conf, []byte(in), 0o644); err != nil {
		t.Fatalf("write conf: %v", err)
	}
	if err := sanitizeOntologyNginxProxyCredentials(conf, dir); err != nil {
		t.Fatalf("sanitize credentials: %v", err)
	}
	gotBytes, _ := os.ReadFile(conf)
	got := string(gotBytes)
	for _, bad := range []string{"<ONTOLOGY_AUTH_TOKEN>", "SPACE_123"} {
		if strings.Contains(got, bad) {
			t.Fatalf("placeholder %q still present;\ngot:\n%s", bad, got)
		}
	}
	if !strings.Contains(got, `proxy_set_header Authorization "Bearer real-token";`) ||
		!strings.Contains(got, `proxy_set_header Spaceid "real-space";`) {
		t.Fatalf("real ontology credentials not injected;\ngot:\n%s", got)
	}
}

func TestSanitizeOntologyNginxProxyCredentialsSupportsOntologyLocation(t *testing.T) {
	dir := t.TempDir()
	envDir := filepath.Join(dir, ".claude", "skills", "carrier-affiliation-data-skill", "config")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatalf("mkdir env dir: %v", err)
	}
	envFile := filepath.Join(envDir, "ontology.env")
	if err := os.WriteFile(envFile, []byte("ONTOLOGY_AUTH_TOKEN=real-token\nONTOLOGY_SPACE_ID=real-space\nONTOLOGY_SCOPE_TYPE=Space\n"), 0o644); err != nil {
		t.Fatalf("write env: %v", err)
	}
	conf := filepath.Join(dir, "nginx.conf")
	in := `server {
    listen 80;
    location /ontology/ {
        proxy_set_header Authorization "Bearer <ONTOLOGY_AUTH_TOKEN>";
        proxy_set_header Spaceid "SPACE_123";
        proxy_set_header scopeType "Space";
    }
}`
	if err := os.WriteFile(conf, []byte(in), 0o644); err != nil {
		t.Fatalf("write conf: %v", err)
	}
	if err := sanitizeOntologyNginxProxyCredentials(conf, dir); err != nil {
		t.Fatalf("sanitize credentials: %v", err)
	}
	gotBytes, _ := os.ReadFile(conf)
	got := string(gotBytes)
	if strings.Contains(got, "<ONTOLOGY_AUTH_TOKEN>") || strings.Contains(got, "SPACE_123") {
		t.Fatalf("ontology location credentials were not injected;\ngot:\n%s", got)
	}
	if !strings.Contains(got, `proxy_set_header Authorization "Bearer real-token";`) ||
		!strings.Contains(got, `proxy_set_header Spaceid "real-space";`) {
		t.Fatalf("real ontology credentials not injected for /ontology/ location;\ngot:\n%s", got)
	}
}

func TestSanitizeNginxVariableProxyPassKeepsInternalServiceName(t *testing.T) {
	dir := t.TempDir()
	conf := filepath.Join(dir, "nginx.conf")
	in := `server {
    listen 80;
    resolver 127.0.0.11 8.8.8.8 114.114.114.114 valid=30s ipv6=off;
    location /api/ontology/ {
        set $ontology_upstream ontology-server:8081;
        proxy_pass http://$ontology_upstream/;
        proxy_set_header Host $host;
    }
}`
	if err := os.WriteFile(conf, []byte(in), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := sanitizeNginxVariableProxyPassUpstreams(conf); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	gotBytes, _ := os.ReadFile(conf)
	got := string(gotBytes)
	if strings.Contains(got, "proxy_pass http://ontology-server:8081/;") {
		t.Fatalf("internal service name should not be collapsed to a static upstream;\ngot:\n%s", got)
	}
	if !strings.Contains(got, "set $ontology_upstream ontology-server:8081;") ||
		!strings.Contains(got, "proxy_pass http://$ontology_upstream/;") {
		t.Fatalf("internal service variable upstream should be preserved;\ngot:\n%s", got)
	}
	if !strings.Contains(got, "resolver 127.0.0.11") {
		t.Fatalf("resolver line should be preserved when no collapse is performed;\ngot:\n%s", got)
	}
}

// fakeContainerRuntime is a deploy.ContainerRuntime double that records its
// calls. It stands in for docker/podman so the runtime-selection logic can be
// tested without a real container engine.
type fakeContainerRuntime struct {
	name        string
	buildCalls  int
	runCalls    int
	stopCalls   int
	removeCalls int
}

func (f *fakeContainerRuntime) Name() string { return f.name }

func (f *fakeContainerRuntime) BuildImage(_ context.Context, app model.Application, tag string) (deploy.ImageRef, deploy.CommandResult, error) {
	f.buildCalls++
	return deploy.ImageRef{FullName: "localhost/software-factory/" + app.Slug + ":" + tag}, deploy.CommandResult{ExitCode: 0}, nil
}

func (f *fakeContainerRuntime) BuildImageWithCallbacks(ctx context.Context, app model.Application, tag string, _, _ func(string)) (deploy.ImageRef, deploy.CommandResult, error) {
	return f.BuildImage(ctx, app, tag)
}

func (f *fakeContainerRuntime) RunContainer(_ context.Context, _ deploy.ImageRef, _ string, _, _ int) (deploy.ContainerRef, deploy.CommandResult, error) {
	f.runCalls++
	return deploy.ContainerRef{Name: "fake"}, deploy.CommandResult{ExitCode: 0}, nil
}

func (f *fakeContainerRuntime) RunContainerWithCallbacks(ctx context.Context, image deploy.ImageRef, appSlug string, hostPort, containerPort int, _, _ func(string)) (deploy.ContainerRef, deploy.CommandResult, error) {
	return f.RunContainer(ctx, image, appSlug, hostPort, containerPort)
}

func (f *fakeContainerRuntime) StopContainer(_ context.Context, _ string) (deploy.CommandResult, error) {
	f.stopCalls++
	return deploy.CommandResult{}, nil
}

func (f *fakeContainerRuntime) RemoveContainer(_ context.Context, _ string) (deploy.CommandResult, error) {
	f.removeCalls++
	return deploy.CommandResult{}, nil
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

// TestCandidateBuildDoesNotMutateEffectiveSource (Task 6): a candidate build's
// npm install + build output land ONLY in the isolated versioned candidate dir,
// never in the effective source dir generated-apps/demo/. The effective source
// must be byte-for-byte untouched (no dist/, no node_modules leak).
func TestCandidateBuildDoesNotMutateEffectiveSource(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	// Snapshot the effective source tree BEFORE the candidate run.
	effSrc := filepath.Join(ws, "generated-apps", "demo")
	before := dirListing(t, effSrc)
	r, _ := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepTestVerification)
	if res, err := r.Run(context.Background(), job, step, runner.NopEmitter{}); err != nil || res.Status != model.StepStatusSucceeded {
		t.Fatalf("Run: %v %#v", err, res)
	}

	// The candidate build wrote its outputs (e.g. a fresh dist from the fake
	// npm run build) into versions/<ver>/, NOT into the effective source.
	after := dirListing(t, effSrc)
	if !equalListing(before, after) {
		t.Fatalf("effective source dir was mutated by candidate build\nbefore=%v\nafter =%v", before, after)
	}
	// The versions subtree must exist under the effective source.
	versionsDir := filepath.Join(effSrc, "versions")
	if entries, err := os.ReadDir(versionsDir); err != nil || len(entries) == 0 {
		t.Fatalf("candidate versions dir missing/empty: %v", err)
	}
}

// dirListing returns the sorted set of relative paths under root (recursive),
// excluding any "versions" subtree (that is the candidate workspace, not the
// effective source content).
func dirListing(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if rel == "." || strings.HasPrefix(rel, "versions") {
			if d.IsDir() && rel == "versions" {
				return filepath.SkipDir
			}
			return nil
		}
		out = append(out, rel)
		return nil
	})
	sort.Strings(out)
	return out
}

func equalListing(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// seedEffectiveVersion seeds app-demo with an already-effective v1 (status
// effective, promoted) plus its running deployment, then returns the version id
// and deployment. This is the baseline the Task-6 retain-on-failure path must
// preserve when a candidate v2 fails its health check.
func seedEffectiveVersion(t *testing.T, st *store.Store) (string, model.Deployment) {
	t.Helper()
	ctx := context.Background()
	now := time.Now()
	depV1 := model.Deployment{
		ID:            "dep_v1",
		AppID:         "app-demo",
		ImageName:     "localhost/software-factory/demo",
		ImageTag:      "ver_v1",
		ContainerName: "sf-demo-v1",
		HostPort:      18000,
		ContainerPort: 8080,
		URL:           "http://127.0.0.1:18000",
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}
	if err := st.CreateDeployment(ctx, depV1); err != nil {
		t.Fatalf("seed v1 deployment: %v", err)
	}
	if err := st.SetAppRuntime(ctx, "app-demo", string(model.AppStatusRunning), depV1.URL); err != nil {
		t.Fatalf("seed app running: %v", err)
	}
	promoted := now
	v1, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID:            "ver_v1",
		ApplicationID: "app-demo",
		JobID:         "job_v1",
		Status:        model.ApplicationVersionEffective,
		DeploymentID:  depV1.ID,
		SourcePath:    "generated-apps/demo",
		CreatedAt:     now,
		PromotedAt:    &promoted,
	})
	if err != nil {
		t.Fatalf("seed effective v1: %v", err)
	}
	return v1.ID, depV1
}

// TestFailedDeploymentLeavesPreviousEffectiveVersionRunning (Task 6): when a
// candidate v2 fails its health check AND a prior effective version v1 exists,
// v1 must remain effective with its deployment still running, v2 is marked
// failed, and the app must NOT be flipped to error.
func TestFailedDeploymentLeavesPreviousEffectiveVersionRunning(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	v1ID, depV1 := seedEffectiveVersion(t, st)
	// Failing health check for the candidate.
	r, cmds := newFactoryRunner(st, ws, false)

	job, step := factoryJobStep(model.StepDeployment)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusFailed || res.ErrorCode != model.ErrorHealthCheckFailed {
		t.Fatalf("result = %s/%s, want failed/health_check_failed", res.Status, res.ErrorCode)
	}

	ctx := context.Background()
	// v1 must STILL be the effective version.
	eff, err := st.GetEffectiveApplicationVersion(ctx, "app-demo")
	if err != nil {
		t.Fatalf("GetEffectiveApplicationVersion: %v", err)
	}
	if eff == nil || eff.ID != v1ID {
		t.Fatalf("effective version = %+v, want v1 %s (retained)", eff, v1ID)
	}
	// v1's deployment must still be running — the candidate's health failure
	// must not stop the prior effective container.
	gotDepV1, err := st.GetDeployment(ctx, depV1.ID)
	if err != nil || gotDepV1 == nil {
		t.Fatalf("get v1 deployment: %#v %v", gotDepV1, err)
	}
	if gotDepV1.Status != "running" {
		t.Fatalf("v1 deployment status = %q, want running (prior service retained)", gotDepV1.Status)
	}
	// The candidate v2 must be marked failed.
	versions, err := st.ListApplicationVersions(ctx, "app-demo")
	if err != nil {
		t.Fatalf("ListApplicationVersions: %v", err)
	}
	var failed int
	for _, v := range versions {
		if v.JobID == job.ID && v.Status == model.ApplicationVersionFailed {
			failed++
		}
	}
	if failed != 1 {
		t.Fatalf("expected candidate v2 failed; versions=%+v", versions)
	}
	// The app must remain RUNNING (not error) because the prior effective
	// version is still serving.
	app, err := st.GetApplication(ctx, "app-demo")
	if err != nil {
		t.Fatalf("GetApplication: %v", err)
	}
	if app.Status != model.AppStatusRunning {
		t.Fatalf("app status = %s, want running (prior effective retained)", app.Status)
	}
	if app.RuntimeURL != depV1.URL {
		t.Fatalf("app runtime_url = %q, want %q (prior effective URL retained)", app.RuntimeURL, depV1.URL)
	}
	// The prior effective container (sf-demo-v1) must NOT have been stopped.
	for _, n := range cmds.names() {
		if strings.Contains(n, "sf-demo-v1") {
			t.Fatalf("prior effective container was touched on candidate failure: %s", n)
		}
	}
}

// TestSuccessfulDeploymentPromotesCandidateVersion (Task 6): a candidate v2
// that passes its health check becomes the effective version, v1 is superseded,
// the app is running on the new URL, and the old effective container is stopped.
func TestSuccessfulDeploymentPromotesCandidateVersion(t *testing.T) {
	st := newFactoryTestStore(t)
	ws := seedFactoryWorkspace(t, true)
	v1ID, depV1 := seedEffectiveVersion(t, st)
	r, cmds := newFactoryRunner(st, ws, true)

	job, step := factoryJobStep(model.StepDeployment)
	res, err := r.Run(context.Background(), job, step, runner.NopEmitter{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Status != model.StepStatusSucceeded {
		t.Fatalf("status = %s (%s/%s), want succeeded", res.Status, res.ErrorCode, res.ErrorMessage)
	}

	ctx := context.Background()
	// v2 is now effective; v1 superseded.
	eff, err := st.GetEffectiveApplicationVersion(ctx, "app-demo")
	if err != nil || eff == nil {
		t.Fatalf("effective version: %#v %v", eff, err)
	}
	if eff.JobID != job.ID {
		t.Fatalf("effective version job = %q, want %q (candidate promoted)", eff.JobID, job.ID)
	}
	if eff.DeploymentID == "" {
		t.Fatalf("promoted version has no deployment_id")
	}
	v1, err := st.GetApplicationVersionByID(ctx, v1ID)
	if err != nil {
		t.Fatalf("get v1: %v", err)
	}
	if v1.Status != model.ApplicationVersionSuperseded {
		t.Fatalf("v1 status = %s, want superseded", v1.Status)
	}
	// The old effective container was stopped.
	if !containsCommand(cmds.names(), "podman stop sf-demo-v1") {
		t.Fatalf("old effective container should be stopped; calls=%v", cmds.names())
	}
	gotDepV1, _ := st.GetDeployment(ctx, depV1.ID)
	if gotDepV1.Status != "stopped" {
		t.Fatalf("old deployment status = %q, want stopped", gotDepV1.Status)
	}
	// New active deployment exists and app is running on the new URL.
	active, err := st.GetActiveDeployment(ctx, "app-demo")
	if err != nil || active == nil || active.ID == depV1.ID {
		t.Fatalf("active deployment = %#v %v", active, err)
	}
	app, _ := st.GetApplication(ctx, "app-demo")
	if app.Status != model.AppStatusRunning || app.RuntimeURL != active.URL {
		t.Fatalf("app = %s/%q, want running/%q", app.Status, app.RuntimeURL, active.URL)
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

func TestIsFullNginxConfig(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		content string
		want    bool
	}{
		{"bare server block", "server { listen 80; }\n", false},
		{"full config with events", "events { worker_connections 1024; }\nhttp { server { listen 80; } }\n", true},
		{"full config with http only", "http { server { listen 80; } }\n", true},
		{"comments ignored", "# events {\nserver { listen 80; }\n", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".conf")
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatalf("write file: %v", err)
			}
			if got := isFullNginxConfig(path); got != tc.want {
				t.Fatalf("isFullNginxConfig(%q) = %v, want %v", tc.content, got, tc.want)
			}
		})
	}
}

func TestWriteStaticHostingDockerfileCopiesFullConfigToMainPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "dist"), 0o755); err != nil {
		t.Fatalf("mkdir dist: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dist", "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nginx.conf"), []byte("events { worker_connections 1024; }\nhttp { server { listen 80; } }\n"), 0o644); err != nil {
		t.Fatalf("write nginx.conf: %v", err)
	}
	if err := writeStaticHostingDockerfile(dir); err != nil {
		t.Fatalf("writeStaticHostingDockerfile: %v", err)
	}
	dockerfile, err := os.ReadFile(filepath.Join(dir, "Dockerfile"))
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	if !strings.Contains(string(dockerfile), "COPY nginx.conf /etc/nginx/nginx.conf") {
		t.Fatalf("full nginx config should be copied to /etc/nginx/nginx.conf; got:\n%s", dockerfile)
	}
}

func TestWriteStaticHostingDockerfileCopiesServerBlockToConfD(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "dist"), 0o755); err != nil {
		t.Fatalf("mkdir dist: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dist", "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nginx.conf"), []byte("server { listen 80; }\n"), 0o644); err != nil {
		t.Fatalf("write nginx.conf: %v", err)
	}
	if err := writeStaticHostingDockerfile(dir); err != nil {
		t.Fatalf("writeStaticHostingDockerfile: %v", err)
	}
	dockerfile, err := os.ReadFile(filepath.Join(dir, "Dockerfile"))
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	if !strings.Contains(string(dockerfile), "COPY nginx.conf /etc/nginx/conf.d/default.conf") {
		t.Fatalf("bare server block should be copied to /etc/nginx/conf.d/default.conf; got:\n%s", dockerfile)
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
