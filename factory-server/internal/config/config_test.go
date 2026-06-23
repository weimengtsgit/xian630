package config

import (
	"path/filepath"
	"testing"
	"time"
)

func TestResolveDefaults(t *testing.T) {
	cfg := Resolve(nil)
	if cfg.Addr != "127.0.0.1:8787" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	if filepath.Base(filepath.Dir(cfg.DBPath)) != ".software-factory" {
		t.Fatalf("DBPath = %q", cfg.DBPath)
	}
	if cfg.CCStatusBaseURL != "http://127.0.0.1:8765" {
		t.Fatalf("CCStatusBaseURL = %q", cfg.CCStatusBaseURL)
	}
	if cfg.ArtifactRoot != ".factory-runs" {
		t.Fatalf("ArtifactRoot = %q", cfg.ArtifactRoot)
	}
	// WorkspaceRoot is resolved to an ABSOLUTE path even for the default "." so
	// the skill/blueprint path builders emit cwd-independent Read paths for the
	// claude subprocess (which runs with cwd = the per-attempt artifact dir, not
	// the server's cwd). See TestResolveWorkspaceRootAbsolute.
	if !filepath.IsAbs(cfg.WorkspaceRoot) {
		t.Fatalf("WorkspaceRoot must be absolute, got %q", cfg.WorkspaceRoot)
	}
	if cfg.LogPath != filepath.Join(".factory-runs", "factory-server.jsonl") {
		t.Fatalf("LogPath = %q", cfg.LogPath)
	}
	if cfg.LogMaxBytes != 10*1024*1024 {
		t.Fatalf("LogMaxBytes = %d", cfg.LogMaxBytes)
	}
	if cfg.LogMaxBackups != 5 {
		t.Fatalf("LogMaxBackups = %d", cfg.LogMaxBackups)
	}
	if cfg.ShutdownTimeout != 5*time.Second {
		t.Fatalf("ShutdownTimeout = %s", cfg.ShutdownTimeout)
	}
}

func TestResolveEnvOverrides(t *testing.T) {
	env := map[string]string{
		"FACTORY_ADDR":               "127.0.0.1:9999",
		"FACTORY_DBPATH":             "/tmp/factory.db",
		"FACTORY_CC_STATUS_BASE_URL": "http://127.0.0.1:7777",
		"FACTORY_ARTIFACT_ROOT":      "/tmp/factory-runs",
		"FACTORY_WORKSPACE_ROOT":     "/tmp/xian630",
		"FACTORY_LOG_PATH":           "/tmp/factory.log",
		"FACTORY_LOG_MAX_BYTES":      "2048",
		"FACTORY_LOG_MAX_BACKUPS":    "3",
	}
	cfg := Resolve(func(k string) string { return env[k] })
	if cfg.Addr != "127.0.0.1:9999" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	if cfg.DBPath != "/tmp/factory.db" {
		t.Fatalf("DBPath = %q", cfg.DBPath)
	}
	if cfg.CCStatusBaseURL != "http://127.0.0.1:7777" {
		t.Fatalf("CCStatusBaseURL = %q", cfg.CCStatusBaseURL)
	}
	if cfg.ArtifactRoot != "/tmp/factory-runs" {
		t.Fatalf("ArtifactRoot = %q", cfg.ArtifactRoot)
	}
	wantWorkspaceRoot, err := filepath.Abs("/tmp/xian630")
	if err != nil {
		t.Fatalf("Abs workspace root: %v", err)
	}
	if cfg.WorkspaceRoot != wantWorkspaceRoot {
		t.Fatalf("WorkspaceRoot = %q", cfg.WorkspaceRoot)
	}
	if cfg.LogPath != "/tmp/factory.log" {
		t.Fatalf("LogPath = %q", cfg.LogPath)
	}
	if cfg.LogMaxBytes != 2048 {
		t.Fatalf("LogMaxBytes = %d", cfg.LogMaxBytes)
	}
	if cfg.LogMaxBackups != 3 {
		t.Fatalf("LogMaxBackups = %d", cfg.LogMaxBackups)
	}
}

// TestResolveWorkspaceRootAbsolute locks in the fix for the solution_design
// `usedSkills required: schema_validation_failed` failure. WorkspaceRoot feeds
// executor.selectedSkillPaths / blueprintRefPaths, whose emitted paths the
// `claude` subprocess must Read. That subprocess runs with its working directory
// set to the per-attempt artifact dir (deep under ArtifactRoot), NOT the
// server's cwd — so a workspace-relative skill path resolves against the wrong
// base and the agent reports every required skill as missing, leaving
// usedSkills empty and failing validation. Resolve must therefore return an
// ABSOLUTE WorkspaceRoot for any input (relative or absolute) so the downstream
// skill-path base is cwd-independent.
func TestResolveWorkspaceRootAbsolute(t *testing.T) {
	cases := []string{".", "..", "/tmp/xian630"}
	for _, in := range cases {
		cfg := Resolve(func(k string) string {
			if k == "FACTORY_WORKSPACE_ROOT" {
				return in
			}
			return ""
		})
		if !filepath.IsAbs(cfg.WorkspaceRoot) {
			t.Fatalf("input %q: WorkspaceRoot must be absolute, got %q", in, cfg.WorkspaceRoot)
		}
		// The property that actually fixes the bug: the skill-path base built
		// from the workspace is absolute, so the agent can Read it from any cwd.
		skillBase := filepath.Join(cfg.WorkspaceRoot, ".claude", "skills")
		if !filepath.IsAbs(skillBase) {
			t.Fatalf("input %q: skill-path base must be absolute, got %q", in, skillBase)
		}
	}
}
