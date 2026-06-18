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
	if cfg.WorkspaceRoot != "." {
		t.Fatalf("WorkspaceRoot = %q", cfg.WorkspaceRoot)
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
	if cfg.WorkspaceRoot != "/tmp/xian630" {
		t.Fatalf("WorkspaceRoot = %q", cfg.WorkspaceRoot)
	}
}
