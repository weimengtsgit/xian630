package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/deploy"
	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
)

// defaultContainerPort is the in-container port every preset app listens on
// (design §5.6). Manifest wiring of a custom port is a later task.
const defaultContainerPort = 80

const activeDeploymentProbeTimeout = 1500 * time.Millisecond

// A running job whose row has not advanced within this window is treated as a
// stale executor lock for direct rebuild actions. Fresh same-app jobs still
// block rebuild because both write the same generated app directory and image.
const rebuildRunningJobFreshness = time.Hour

var renamePath = os.Rename

// containerHealthURL builds the health-check URL for a container's host port.
// On Windows+WSL2, port forwarding through wslrelay is unreliable (IPv6-only
// on some installs, HTTP-broken on others), so we prefer the WSL VM IP.
func containerHealthURL(hostPort int) string {
	ip := wslVMIP()
	return fmt.Sprintf("http://%s:%d", ip, hostPort)
}

// containerAppURL builds the user-facing URL for a generated app's host port —
// the link shown in the portal. Override the host with FACTORY_APP_URL_HOST (e.g.
// the site's public/internal IP) for containerized deploys; defaults to the
// health-probe host so local/WSL dev keeps working.
func containerAppURL(hostPort int) string {
	return fmt.Sprintf("http://%s:%d", appURLHost(), hostPort)
}

// appURLHost honours FACTORY_APP_URL_HOST, falling back to the health-probe host.
func appURLHost() string {
	if v := os.Getenv("FACTORY_APP_URL_HOST"); v != "" {
		return v
	}
	return wslVMIP()
}

// wslVMIP returns the host a container health probe should target. The lookup
// order is: FACTORY_HEALTH_HOST env var, podman machine gateway (macOS/Linux),
// WSL VM IP (Windows+WSL2), and finally 127.0.0.1.
func wslVMIP() string {
	if v := os.Getenv("FACTORY_HEALTH_HOST"); v != "" {
		return v
	}
	if ip := deploy.PodmanMachineGateway(); ip != "" {
		return ip
	}
	out, err := exec.Command("wsl", "-d", "podman-machine-default", "--", "sh", "-c",
		"ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\\s)\\d+\\.\\d+\\.\\d+\\.\\d+'").Output()
	if err == nil {
		ip := strings.TrimSpace(string(out))
		if ip != "" {
			return ip
		}
	}
	return "127.0.0.1"
}

// errResponse pairs an HTTP status with a structured error_code, written as
// {"error": <message>, "error_code": <code>}.
type errResponse struct {
	status int
	code   model.ErrorCode
	msg    string
}

func (e errResponse) write(w http.ResponseWriter) {
	writeJSON(w, e.status, map[string]any{"error": e.msg, "error_code": string(e.code)})
}

// Error lets errResponse satisfy the error interface so startAppInternal can
// return it as a typed error that the HTTP handlers unpack back into a
// structured response.
func (e errResponse) Error() string { return e.msg }

// startApp handles POST /api/apps/:id/start. It is idempotent: if a running
// deployment already exists for the app it is returned with 200. Otherwise it
// builds the image, allocates a host port, runs the container and probes the
// health endpoint. On any failure it marks the app `error` and rolls back any
// partially-created container (stop+remove on health-check failure).
func (s *Server) startApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")

	// Per-app mutual exclusion (TryLock → 409 if another op is in flight).
	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	dep, _, err := s.startAppInternal(r.Context(), appID)
	if err != nil {
		if er, ok := err.(errResponse); ok {
			er.write(w)
			return
		}
		writeError(w, http.StatusInternalServerError, "start app")
		return
	}
	writeJSON(w, http.StatusOK, dep)
}

// startAppInternal is the shared start operation used by BOTH the legacy
// POST /api/apps/:id/start handler AND the dialogue .../open handler. It holds
// NO per-app lock itself (the HTTP handlers acquire appLock before calling so the
// per-app TryLock→409 semantics are preserved). It builds the image, allocates a
// port, runs the container, probes health, and persists the running deployment +
// flips the app to running. It returns the running Deployment and the refreshed
// Application on success. On failure it returns an errResponse (carrying the
// HTTP status + error_code) so HTTP handlers can write the structured error;
// the dialogue handler treats it as a non-resolving failure. Idempotent: an
// already-running, reachable deployment is returned as the fast path.
func (s *Server) startAppInternal(ctx context.Context, appID string) (*model.Deployment, *model.Application, error) {
	app, err := s.store.GetApplication(ctx, appID)
	if err != nil {
		return nil, nil, errResponse{http.StatusInternalServerError, model.ErrorUnknown, "get app"}
	}
	if app == nil {
		return nil, nil, errResponse{http.StatusNotFound, model.ErrorUnknown, "not found"}
	}

	rt := s.containerRuntime()
	// Idempotent fast path, but only after confirming the recorded deployment is
	// reachable. The DB can be stale after a manual podman stop or a server
	// restart, so a blind return would show "running" while nothing is usable.
	if active, _ := s.store.GetActiveDeployment(ctx, appID); active != nil {
		if err := s.healthCheck(ctx, active.URL, activeDeploymentProbeTimeout); err == nil {
			if err := s.store.SetAppRuntime(ctx, appID, string(model.AppStatusRunning), active.URL); err != nil {
				return nil, nil, errResponse{http.StatusInternalServerError, model.ErrorUnknown, "set app runtime"}
			}
			s.publishDeploymentUpdated(ctx, active.ID)
			s.publishAppUpdated(ctx, appID)
			return active, app, nil
		}
		_, _ = rt.StopContainer(ctx, active.ContainerName)
		_, _ = rt.RemoveContainer(ctx, active.ContainerName)
		_ = s.store.UpdateDeploymentStatus(ctx, active.ID, "stopped")
		_ = s.store.SetAppRuntime(ctx, appID, string(model.AppStatusStopped), "")
		s.publishDeploymentUpdated(ctx, active.ID)
		s.publishAppUpdated(ctx, appID)
	}

	tag := string(app.Source)
	buildApp := s.workspaceApp(*app)
	if err := s.prepareGeneratedStaticViteBuild(ctx, *app, buildApp.Path); err != nil {
		log.Printf("startAppInternal prepareGeneratedStaticViteBuild failed for %s: %v", appID, err)
		s.markAppError(ctx, appID)
		return nil, nil, errResponse{http.StatusBadGateway, model.ErrorImageBuildFailed, "image build failed"}
	}

	// 1. Build image.
	img, _, err := rt.BuildImage(ctx, buildApp, tag)
	if err != nil {
		log.Printf("startAppInternal BuildImage failed for %s: %v", appID, err)
		s.markAppError(ctx, appID)
		return nil, nil, errResponse{http.StatusBadGateway, model.ErrorImageBuildFailed, "image build failed"}
	}

	// 2. Allocate host port from the design-default pool 18000-18999.
	hostPort, err := deploy.DefaultAllocator().Choose(s.portInUse(ctx))
	if err != nil {
		s.markAppError(ctx, appID)
		return nil, nil, errResponse{http.StatusBadGateway, model.ErrorPortUnavailable, "port unavailable"}
	}

	// 3. Run container.
	cr, _, err := rt.RunContainer(ctx, img, app.Slug, hostPort, defaultContainerPort)
	if err != nil {
		if cr.Name != "" {
			_, _ = rt.RemoveContainer(ctx, cr.Name)
		}
		s.markAppError(ctx, appID)
		return nil, nil, errResponse{http.StatusBadGateway, model.ErrorPodmanRunFailed, "podman run failed"}
	}

	healthURL := containerHealthURL(hostPort)
	url := containerAppURL(hostPort)

	// 4. Health check. On failure, stop+remove the container (best-effort) and
	// record a failed deployment so the app is not left in a half-state.
	if err := s.healthCheck(ctx, healthURL, deploy.HealthCheckTimeout()); err != nil {
		logsRes, _ := s.runner.Run(ctx, "", rt.Name(), "logs", cr.Name)
		errMsg := err.Error()
		if logs := strings.TrimSpace(logsRes.Stdout + logsRes.Stderr); logs != "" {
			errMsg += "\ncontainer logs:\n" + deploy.Truncate(logs, 2000)
		}
		_, _ = rt.StopContainer(ctx, cr.Name)
		_, _ = rt.RemoveContainer(ctx, cr.Name)
		now := time.Now()
		failedDep := model.Deployment{
			ID:            "dep_" + idpkg.New(),
			AppID:         appID,
			ImageName:     stripTag(img.FullName, tag),
			ImageTag:      tag,
			ContainerName: cr.Name,
			HostPort:      hostPort,
			ContainerPort: defaultContainerPort,
			URL:           url,
			Status:        "failed",
			CreatedAt:     now,
		}
		_ = s.store.CreateDeployment(ctx, failedDep)
		s.publishDeploymentUpdated(ctx, failedDep.ID)
		s.markAppError(ctx, appID)
		return nil, nil, errResponse{http.StatusBadGateway, model.ErrorHealthCheckFailed, errMsg}
	}

	// 5. Success: persist the running deployment and flip the app to running.
	now := time.Now()
	dep := model.Deployment{
		ID:            "dep_" + idpkg.New(),
		AppID:         appID,
		ImageName:     stripTag(img.FullName, tag),
		ImageTag:      tag,
		ContainerName: cr.Name,
		HostPort:      hostPort,
		ContainerPort: defaultContainerPort,
		URL:           url,
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}
	if err := s.store.CreateDeployment(ctx, dep); err != nil {
		return nil, nil, errResponse{http.StatusInternalServerError, model.ErrorUnknown, "create deployment"}
	}
	if err := s.store.SetAppRuntime(ctx, appID, string(model.AppStatusRunning), url); err != nil {
		return nil, nil, errResponse{http.StatusInternalServerError, model.ErrorUnknown, "set app runtime"}
	}
	s.publishDeploymentUpdated(ctx, dep.ID)
	s.publishAppUpdated(ctx, appID)

	refreshed, _ := s.store.GetApplication(ctx, appID)
	if refreshed != nil {
		app = refreshed
	}
	return &dep, app, nil
}

// stopApp handles POST /api/apps/:id/stop. It is idempotent: no active
// deployment → 200 {"status":"already stopped"}. Otherwise it stops and
// removes the container (best-effort, ignoring not-found) and flips both the
// deployment and the app to stopped.
func (s *Server) stopApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")

	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	ctx := r.Context()
	active, err := s.store.GetActiveDeployment(ctx, appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get deployment")
		return
	}
	if active == nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "already stopped"})
		return
	}

	rt := s.containerRuntime()
	// Best-effort cleanup: a missing container must not fail the stop.
	_, _ = rt.StopContainer(ctx, active.ContainerName)
	_, _ = rt.RemoveContainer(ctx, active.ContainerName)

	if err := s.store.UpdateDeploymentStatus(ctx, active.ID, "stopped"); err != nil {
		writeError(w, http.StatusInternalServerError, "update deployment")
		return
	}
	if err := s.store.SetAppRuntime(ctx, appID, string(model.AppStatusStopped), ""); err != nil {
		writeError(w, http.StatusInternalServerError, "set app runtime")
		return
	}

	// Re-read so the response reflects the stopped timestamp.
	dep, _ := s.store.GetDeployment(ctx, active.ID)
	s.publishDeploymentUpdated(ctx, active.ID)
	s.publishAppUpdated(ctx, appID)
	writeJSON(w, http.StatusOK, dep)
}

// rebuildApp handles POST /api/apps/:id/rebuild. It rebuilds the app's image
// (tag = app.Source) but does NOT re-run the container — start must be invoked
// separately. The executor-busy conflict is now scoped PER APP: a rebuild
// conflicts only with a running pipeline JOB for the same app (same app_slug),
// not with jobs of unrelated apps. This is because a rebuild and a same-app job
// both write generated-apps/<slug>/ and the same image tag (a destructive race),
// while different apps touch disjoint dirs. The per-app appLock is still held so
// a rebuild also conflicts with start/stop/delete of the same app.
func (s *Server) rebuildApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")

	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	ctx := r.Context()
	// Per-app executor conflict: a running JOB for this app's slug writes the
	// same generated-apps/<slug>/ dir + image tag a rebuild targets. Serialize.
	if n, _ := s.store.CountRecentRunningJobsByAppSlug(ctx, app.Slug, time.Now().Add(-rebuildRunningJobFreshness)); n > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}

	tag := string(app.Source)
	buildApp := s.workspaceApp(*app)
	if err := s.prepareGeneratedStaticViteBuild(ctx, *app, buildApp.Path); err != nil {
		log.Printf("rebuildApp prepareGeneratedStaticViteBuild failed for %s: %v", appID, err)
		s.markAppError(ctx, appID)
		errResponse{http.StatusBadGateway, model.ErrorImageBuildFailed, "image build failed"}.write(w)
		return
	}
	img, _, err := s.containerRuntime().BuildImage(ctx, buildApp, tag)
	if err != nil {
		log.Printf("rebuildApp BuildImage failed for %s: %v", appID, err)
		s.markAppError(ctx, appID)
		errResponse{http.StatusBadGateway, model.ErrorImageBuildFailed, "image build failed"}.write(w)
		return
	}

	s.publishAppUpdated(ctx, appID)
	writeJSON(w, http.StatusOK, map[string]any{"status": "built", "image": img.FullName})
}

// prepareGeneratedStaticViteBuild mirrors the factory pipeline's static-vite
// image strategy for direct start/rebuild actions. Generated apps often ship a
// multi-stage Dockerfile that runs npm inside the container. In local Podman
// environments that can fail on npm registry access; it also fails when the app
// has no package-lock but the generated Dockerfile uses npm ci. Build dist/ on
// the host, then replace the Dockerfile with an offline nginx image that serves
// the prebuilt bundle.
func (s *Server) prepareGeneratedStaticViteBuild(ctx context.Context, app model.Application, appDir string) error {
	if app.Source != model.AppSourceGenerated {
		return nil
	}
	manifestPath := filepath.Join(s.cfg.WorkspaceRoot, app.ManifestPath)
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	manifest, err := scanner.ParseManifest(raw)
	if err != nil {
		return err
	}
	if manifest.Entry != "static-vite" {
		return nil
	}

	installName := "npm"
	installArgs := []string{"install"}
	if _, err := os.Stat(filepath.Join(appDir, "package-lock.json")); err == nil {
		installArgs = []string{"ci"}
	}
	log.Printf("prepareGeneratedStaticViteBuild: running %s %s in %s", installName, strings.Join(installArgs, " "), appDir)
	if res, err := s.runner.Run(ctx, appDir, installName, installArgs...); err != nil || res.ExitCode != 0 {
		log.Printf("prepareGeneratedStaticViteBuild: %s %s FAILED exit=%d err=%v", installName, strings.Join(installArgs, " "), res.ExitCode, err)
		return fmt.Errorf("%s %s failed: %w", installName, strings.Join(installArgs, " "), err)
	}

	buildCmd := strings.TrimSpace(manifest.Build.Command)
	if buildCmd == "" {
		buildCmd = "npm run build"
	}
	buildArgs := strings.Fields(buildCmd)
	if len(buildArgs) == 0 {
		buildArgs = []string{"npm", "run", "build"}
	}
	log.Printf("prepareGeneratedStaticViteBuild: running %s in %s", buildCmd, appDir)
	if res, err := s.runner.Run(ctx, appDir, buildArgs[0], buildArgs[1:]...); err != nil || res.ExitCode != 0 {
		log.Printf("prepareGeneratedStaticViteBuild: %s FAILED exit=%d err=%v", buildCmd, res.ExitCode, err)
		return fmt.Errorf("%s failed: %w", buildCmd, err)
	}

	outputDir := manifest.Build.OutputDir
	if outputDir == "" {
		outputDir = "dist"
	}
	if _, err := os.Stat(filepath.Join(appDir, outputDir, "index.html")); err != nil {
		return fmt.Errorf("build output missing index.html in %s: %w", outputDir, err)
	}
	_ = sanitizeGeneratedAppNginx(filepath.Join(appDir, "nginx.conf"), s.cfg.WorkspaceRoot)
	return writeStaticViteDockerfile(appDir, outputDir)
}

var serverNginxVariableUpstreamSetRe = regexp.MustCompile(`(?m)^(\s*)set\s+(\$[A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9.\-]+:\d+);\s*$`)
var serverNginxVariableHostSetRe = regexp.MustCompile(`(?m)^(\s*)set\s+(\$[A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9.\-]+);\s*$`)
var serverNginxVariableProxyPassRe = regexp.MustCompile(`(?m)^\s*proxy_pass\s+https?://\$[A-Za-z_][A-Za-z0-9_]*`)
var serverNginxOntologyLocationBlockRe = regexp.MustCompile(`(?ms)location\s+/api/ontology/\s*\{.*?\n\s*\}`)

func sanitizeGeneratedAppNginx(path, workspace string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	src := string(raw)
	out := collapseExternalVariableUpstreams(src)
	out = injectOntologyProxyHeaders(out, workspace)
	if out == src {
		return nil
	}
	return os.WriteFile(path, []byte(out), 0o644)
}

func collapseExternalVariableUpstreams(src string) string {
	out := rewriteServerOntologyVariablePortProxyPasses(src)
	converted := false
	for _, m := range serverNginxVariableUpstreamSetRe.FindAllStringSubmatch(out, -1) {
		indent, variable, upstream := m[1], m[2], m[3]
		host, _, _ := strings.Cut(upstream, ":")
		if !strings.Contains(host, ".") && !serverIsIPv4(host) {
			continue
		}
		proxyRe := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(indent) + `proxy_pass\s+http://` + regexp.QuoteMeta(variable) + `([^\s;]*);\s*$`)
		proxyMatch := proxyRe.FindStringSubmatch(out)
		if proxyMatch == nil {
			continue
		}
		uri := proxyMatch[1]
		if uri == "" {
			uri = "/"
		}
		out = strings.Replace(out, m[0]+"\n"+proxyMatch[0], indent+"proxy_pass http://"+upstream+uri+";", 1)
		out = strings.Replace(out, m[0]+"\r\n"+proxyMatch[0], indent+"proxy_pass http://"+upstream+uri+";", 1)
		converted = true
	}
	if converted && !serverNginxVariableProxyPassRe.MatchString(out) {
		out = removeDockerResolver(out)
	}
	return out
}

func rewriteServerOntologyVariablePortProxyPasses(src string) string {
	if !strings.Contains(src, "/api/ontology/") {
		return src
	}
	out := serverNginxOntologyLocationBlockRe.ReplaceAllStringFunc(src, rewriteServerOntologyVariablePortProxyPassBlock)
	if out != src && !serverNginxVariableProxyPassRe.MatchString(out) {
		out = removeDockerResolver(out)
	}
	return out
}

func rewriteServerOntologyVariablePortProxyPassBlock(block string) string {
	out := block
	for _, m := range serverNginxVariableHostSetRe.FindAllStringSubmatch(block, -1) {
		indent, variable, host := m[1], m[2], m[3]
		if !strings.Contains(host, ".") && !serverIsIPv4(host) {
			continue
		}
		proxyRe := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(indent) + `proxy_pass\s+http://` + regexp.QuoteMeta(variable) + `:(\d+)([^\s;]*);\s*$`)
		proxyMatch := proxyRe.FindStringSubmatch(out)
		if proxyMatch == nil {
			continue
		}
		port, uri := proxyMatch[1], proxyMatch[2]
		if uri != "" && uri != "/" {
			continue
		}
		replacement := indent + "rewrite ^/api/ontology/(.*)$ /$1 break;\n" +
			indent + "proxy_pass http://" + host + ":" + port + ";"
		out = strings.Replace(out, m[0]+"\n"+proxyMatch[0], replacement, 1)
		out = strings.Replace(out, m[0]+"\r\n"+proxyMatch[0], replacement, 1)
	}
	return out
}

func injectOntologyProxyHeaders(src, workspace string) string {
	if !strings.Contains(src, "/api/ontology/") {
		return src
	}
	env, err := readServerOntologyEnv(workspace)
	if err != nil {
		return src
	}
	out := src
	if token := strings.TrimSpace(env["ONTOLOGY_AUTH_TOKEN"]); token != "" {
		out = replaceServerProxySetHeader(out, "Authorization", "Bearer "+token)
	}
	if spaceID := strings.TrimSpace(env["ONTOLOGY_SPACE_ID"]); spaceID != "" {
		out = replaceServerProxySetHeader(out, "Spaceid", spaceID)
	}
	scopeType := strings.TrimSpace(env["ONTOLOGY_SCOPE_TYPE"])
	if scopeType == "" {
		scopeType = "Space"
	}
	return replaceServerProxySetHeader(out, "scopeType", scopeType)
}

func readServerOntologyEnv(workspace string) (map[string]string, error) {
	raw, err := os.ReadFile(filepath.Join(workspace, ".claude", "skills", "carrier-affiliation-data-skill", "config", "ontology.env"))
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key, value, _ := strings.Cut(line, "=")
		env[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return env, nil
}

func replaceServerProxySetHeader(src, header, value string) string {
	re := regexp.MustCompile(`(?m)^(\s*proxy_set_header\s+` + regexp.QuoteMeta(header) + `\s+)"[^"]*";\s*$`)
	return re.ReplaceAllString(src, `${1}"`+value+`";`)
}

func removeDockerResolver(src string) string {
	lines := strings.SplitAfter(src, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.Contains(line, "resolver ") && strings.Contains(line, "127.0.0.11") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "")
}

func serverIsIPv4(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return false
	}
	for _, p := range parts {
		if p == "" || len(p) > 3 {
			return false
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}

func writeStaticViteDockerfile(appDir, outputDir string) error {
	var b strings.Builder
	b.WriteString("FROM nginx:alpine\n")
	b.WriteString("COPY ")
	b.WriteString(strings.Trim(outputDir, "/"))
	b.WriteString("/ /usr/share/nginx/html/\n")
	if _, err := os.Stat(filepath.Join(appDir, "nginx.conf")); err == nil {
		b.WriteString("COPY nginx.conf /etc/nginx/conf.d/default.conf\n")
	}
	b.WriteString("EXPOSE 80\n")
	b.WriteString(`CMD ["nginx", "-g", "daemon off;"]`)
	b.WriteString("\n")
	if err := os.WriteFile(filepath.Join(appDir, "Dockerfile"), []byte(b.String()), 0o644); err != nil {
		return err
	}
	// Overwrite .dockerignore so podman build doesn't skip the prebuilt dist/.
	// Generated apps ship a .dockerignore that excludes dist + node_modules
	// (correct for the ORIGINAL multi-stage Dockerfile), but after we replace the
	// Dockerfile with the offline nginx one, dist/ MUST be included.
	ignoreContent := "node_modules\n"
	return os.WriteFile(filepath.Join(appDir, ".dockerignore"), []byte(ignoreContent), 0o644)
}

// rollbackRequestBody is the explicit-confirm body for POST /api/apps/:id/rollback.
// `confirm` MUST be true (400 otherwise). `version_id` optionally names the
// superseded version to roll back to; when omitted the most-recently-superseded
// version is chosen.
type rollbackRequestBody struct {
	Confirm   bool   `json:"confirm"`
	VersionID string `json:"version_id"`
}

// rollbackApp handles POST /api/apps/:id/rollback. It mirrors the
// confirm-clarification contract: an explicit-confirm body is required (400
// otherwise), and the app must be rollback-eligible (have a prior superseded
// version; 409 otherwise). The prior version is re-built, re-run, and re-health
// checked through the SAME path as a normal deploy; on success it is promoted to
// effective and the current is superseded. On rollback health failure the
// current effective is left running and an error is returned.
func (s *Server) rollbackApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")

	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	var body rollbackRequestBody
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
	}
	if !body.Confirm {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "confirmation required", "error_code": string(model.ErrorSchemaValidationFailed)})
		return
	}

	ctx := r.Context()
	app, err := s.store.GetApplication(ctx, appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// Eligibility: there must be a prior superseded version to roll back to.
	var target *model.ApplicationVersion
	if body.VersionID != "" {
		target, err = s.store.GetApplicationVersionByID(ctx, body.VersionID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "get version")
			return
		}
		if target == nil || target.ApplicationID != appID || target.Status != model.ApplicationVersionSuperseded {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "version not rollback-able"})
			return
		}
	} else {
		target, err = s.store.GetPreviousApplicationVersion(ctx, appID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "get previous version")
			return
		}
		if target == nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "no previous version to roll back to"})
			return
		}
	}

	// Resolve the prior version's source + image tag, then re-run it through the
	// full deploy path (build is skipped: the image tag is immutable and still
	// present in the runtime). Run a fresh container, health check, and on
	// success promote the prior version to effective.
	rt := s.containerRuntime()
	tag := target.ID
	image := deploy.ImageRef{FullName: "localhost/software-factory/" + app.Slug + ":" + tag}
	containerPort := defaultContainerPort

	hostPort, err := deploy.DefaultAllocator().Choose(s.portInUse(ctx))
	if err != nil {
		errResponse{http.StatusBadGateway, model.ErrorPortUnavailable, "port unavailable"}.write(w)
		return
	}
	cr, _, err := rt.RunContainer(ctx, image, app.Slug, hostPort, containerPort)
	if err != nil {
		if cr.Name != "" {
			_, _ = rt.RemoveContainer(ctx, cr.Name)
		}
		errResponse{http.StatusBadGateway, model.ErrorPodmanRunFailed, "rollback run failed"}.write(w)
		return
	}
	healthURL := containerHealthURL(hostPort)
	url := containerAppURL(hostPort)
	if err := s.healthCheck(ctx, healthURL, deploy.HealthCheckTimeout()); err != nil {
		logsRes, _ := s.runner.Run(ctx, "", rt.Name(), "logs", cr.Name)
		errMsg := err.Error()
		if logs := strings.TrimSpace(logsRes.Stdout + logsRes.Stderr); logs != "" {
			errMsg += "\ncontainer logs:\n" + deploy.Truncate(logs, 2000)
		}
		// Rollback health failure: do NOT flip the app; leave the current
		// effective running. Clean up the rollback candidate container only.
		_, _ = rt.StopContainer(ctx, cr.Name)
		_, _ = rt.RemoveContainer(ctx, cr.Name)
		errResponse{http.StatusBadGateway, model.ErrorHealthCheckFailed, "rollback health check failed; current version left running: " + errMsg}.write(w)
		return
	}

	// Success: record the running deployment, promote the prior version
	// (effective + deployment_id, supersede current), then stop the old
	// effective container (best-effort).
	now := time.Now()
	dep := model.Deployment{
		ID:            "dep_" + idpkg.New(),
		AppID:         appID,
		JobID:         "rollback-" + target.JobID,
		ImageName:     stripTag(image.FullName, tag),
		ImageTag:      tag,
		ContainerName: cr.Name,
		HostPort:      hostPort,
		ContainerPort: containerPort,
		URL:           url,
		Status:        "running",
		CreatedAt:     now,
		StartedAt:     &now,
	}
	if err := s.store.CreateDeployment(ctx, dep); err != nil {
		_, _ = rt.StopContainer(ctx, cr.Name)
		_, _ = rt.RemoveContainer(ctx, cr.Name)
		writeError(w, http.StatusInternalServerError, "create deployment")
		return
	}
	if err := s.store.PromoteApplicationVersion(ctx, appID, target.ID, dep.ID, url); err != nil {
		_, _ = rt.StopContainer(ctx, cr.Name)
		_, _ = rt.RemoveContainer(ctx, cr.Name)
		writeError(w, http.StatusInternalServerError, "promote version")
		return
	}
	// Stop the previously-effective container (the one superseded by rollback).
	s.stopPreviousDeploymentsServer(ctx, rt, appID, dep.ID)
	s.publishDeploymentUpdated(ctx, dep.ID)
	s.publishAppUpdated(ctx, appID)
	writeJSON(w, http.StatusOK, map[string]any{"status": "rolled back", "version_id": target.ID, "deployment": dep})
}

// stopPreviousDeploymentsServer is the server-side analogue of the executor's
// stopPreviousDeployments: it stops + removes every OTHER running deployment for
// the app (the container superseded by a promotion/rollback) and marks it
// stopped. Best-effort.
func (s *Server) stopPreviousDeploymentsServer(ctx context.Context, rt deploy.ContainerRuntime, appID, keepID string) {
	deps, err := s.store.ListDeploymentsByApp(ctx, appID)
	if err != nil {
		return
	}
	for _, dep := range deps {
		if dep.ID == keepID || dep.Status != "running" {
			continue
		}
		_, _ = rt.StopContainer(ctx, dep.ContainerName)
		_, _ = rt.RemoveContainer(ctx, dep.ContainerName)
		_ = s.store.UpdateDeploymentStatus(ctx, dep.ID, "stopped")
		s.publishDeploymentUpdated(ctx, dep.ID)
	}
}

// markAppError flips an app to error status, swallowing the error (callers have
// already decided on their response status and just want the DB to reflect the
// failure for diagnostics).
func (s *Server) markAppError(ctx context.Context, appID string) {
	_ = s.store.SetAppRuntime(ctx, appID, string(model.AppStatusError), "")
	s.publishAppUpdated(ctx, appID)
}

func (s *Server) workspaceApp(app model.Application) model.Application {
	if app.Path != "" && !filepath.IsAbs(app.Path) {
		root := s.cfg.WorkspaceRoot
		if root == "" {
			root = "."
		}
		app.Path = filepath.Join(root, app.Path)
	}
	return app
}

func (s *Server) containerRuntime() deploy.ContainerRuntime {
	if s.runtime != nil {
		return s.runtime
	}
	return deploy.NewPodman(s.runner)
}

// portInUse returns an isUsed predicate for the port Allocator that reports a
// port as taken when any running deployment already binds it.
func (s *Server) portInUse(ctx context.Context) func(int) bool {
	return func(port int) bool {
		apps, err := s.store.ListApplications(ctx)
		if err != nil {
			return false
		}
		for _, a := range apps {
			if dep, _ := s.store.GetActiveDeployment(ctx, a.ID); dep != nil && dep.HostPort == port {
				return true
			}
		}
		return false
	}
}

// stripTag removes the trailing ":<tag>" from a full image name, returning the
// bare image name stored separately in the deployments table.
func stripTag(fullName, tag string) string {
	suffix := ":" + tag
	if len(fullName) > len(suffix) && fullName[len(fullName)-len(suffix):] == suffix {
		return fullName[:len(fullName)-len(suffix)]
	}
	return fullName
}

// deleteApp handles DELETE /api/apps/:id for generated apps only. It removes the
// container, tombstones the app directory under the artifact root (so audit
// records survive), then deletes the deployment and application rows. The
// directory is moved-aside first and only removed after the DB rows are gone,
// so a DB failure rolls the directory back to its original location.
func (s *Server) deleteApp(w http.ResponseWriter, r *http.Request) {
	appID := Param(r, "id")
	if !s.appLock(appID).TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "app busy"})
		return
	}
	defer s.appLock(appID).Unlock()

	app, err := s.store.GetApplication(r.Context(), appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get app")
		return
	}
	if app == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if app.Source != model.AppSourceGenerated {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "only generated apps can be deleted"})
		return
	}
	appDir, err := s.safeGeneratedAppDir(*app)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": err.Error()})
		return
	}

	ctx := r.Context()
	deps, err := s.store.ListDeploymentsByApp(ctx, appID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list deployments")
		return
	}
	rt := s.containerRuntime()
	for _, dep := range deps {
		if dep.ContainerName == "" {
			continue
		}
		_, _ = rt.StopContainer(ctx, dep.ContainerName)
		_, _ = rt.RemoveContainer(ctx, dep.ContainerName)
	}

	tombstone := ""
	directCleanup := false
	if _, err := os.Stat(appDir); err == nil {
		tombstone = filepath.Join(s.cfg.ArtifactRoot, "deleted-apps", app.ID+"-"+app.Slug)
		if !filepath.IsAbs(tombstone) {
			tombstone = filepath.Join(s.cfg.WorkspaceRoot, tombstone)
		}
		_ = os.RemoveAll(tombstone)
		if err := os.MkdirAll(filepath.Dir(tombstone), 0o755); err != nil {
			writeError(w, http.StatusInternalServerError, "prepare tombstone")
			return
		}
		if err := moveDirectory(appDir, tombstone); err != nil {
			log.Printf("delete app %s: move app directory %q -> %q failed; falling back to post-delete cleanup: %v", appID, appDir, tombstone, err)
			tombstone = ""
			directCleanup = true
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusInternalServerError, "stat app directory")
		return
	}

	if err := s.store.DeleteApplicationWithDeployments(ctx, appID); err != nil {
		restoreTombstone(tombstone, appDir)
		writeError(w, http.StatusInternalServerError, "delete app")
		return
	}
	// Reconcile dialogues that referenced this app: null their
	// resolved_application_id so composeDialogueView does not silently dereference
	// a missing application (which would drop resolvedApplication and stall the
	// continuous loop). Best-effort: a store error here must not undo the delete.
	if dlgIDs, rerr := s.store.ClearDialoguesReferencingApp(ctx, appID); rerr == nil {
		for _, did := range dlgIDs {
			s.publishDialogueSimple("dialogue.clarification.updated", did, map[string]any{"app_deleted": appID})
		}
	}
	if tombstone != "" {
		_ = os.RemoveAll(tombstone)
	} else if directCleanup {
		if err := os.RemoveAll(appDir); err != nil {
			log.Printf("delete app %s: cleanup app directory %q: %v", appID, appDir, err)
		}
	}
	s.hub.Publish(Event{Type: "app.deleted", Data: map[string]string{"id": app.ID, "slug": app.Slug}})
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted", "id": app.ID, "slug": app.Slug})
}

// safeGeneratedAppDir resolves an app's workspace-relative path to an absolute
// directory under <WorkspaceRoot>/generated-apps and rejects anything that
// escapes that root (absolute paths, parent traversal, or a slug/path mismatch).
func (s *Server) safeGeneratedAppDir(app model.Application) (string, error) {
	if app.Slug == "" {
		return "", errors.New("generated app has no slug")
	}
	root := s.cfg.WorkspaceRoot
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	path := app.Path
	if path == "" {
		path = filepath.Join("generated-apps", app.Slug)
	}
	if filepath.IsAbs(path) {
		return "", errors.New("generated app path must be workspace-relative")
	}
	cleanRel := filepath.Clean(path)
	wantRel := filepath.Join("generated-apps", app.Slug)
	if cleanRel != wantRel {
		return "", errors.New("generated app path does not match generated-apps slug")
	}
	absDir, err := filepath.Abs(filepath.Join(absRoot, cleanRel))
	if err != nil {
		return "", err
	}
	prefix := filepath.Join(absRoot, "generated-apps") + string(os.PathSeparator)
	if !strings.HasPrefix(absDir+string(os.PathSeparator), prefix) {
		return "", errors.New("generated app path escapes generated-apps root")
	}
	return absDir, nil
}

// restoreTombstone moves a tombstoned directory back to its original location on
// DB-delete failure so the filesystem and DB stay consistent. Best-effort.
func restoreTombstone(tombstone, appDir string) {
	if tombstone == "" || appDir == "" {
		return
	}
	_ = moveDirectory(tombstone, appDir)
}

func moveDirectory(src, dst string) error {
	if err := renamePath(src, dst); err != nil {
		if !errors.Is(err, syscall.EXDEV) {
			return err
		}
		if err := copyDirectory(src, dst); err != nil {
			_ = os.RemoveAll(dst)
			return err
		}
		if err := os.RemoveAll(src); err != nil {
			_ = os.RemoveAll(dst)
			return err
		}
	}
	return nil
}

func copyDirectory(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !srcInfo.IsDir() {
		return fmt.Errorf("%s is not a directory", src)
	}
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode()
		switch {
		case d.IsDir():
			return os.MkdirAll(target, mode.Perm())
		case mode&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case mode.IsRegular():
			return copyFile(path, target, mode.Perm())
		default:
			return nil
		}
	})
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
