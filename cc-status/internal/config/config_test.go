package config

import (
	"path/filepath"
	"testing"
)

func TestDefaultLogConfig(t *testing.T) {
	cfg := Default()
	if filepath.Base(cfg.LogPath) != "events.jsonl" {
		t.Fatalf("LogPath = %q", cfg.LogPath)
	}
	if filepath.Base(filepath.Dir(cfg.LogPath)) != ".cc-status" {
		t.Fatalf("LogPath dir = %q", filepath.Dir(cfg.LogPath))
	}
	if cfg.LogMaxBytes != 10*1024*1024 {
		t.Fatalf("LogMaxBytes = %d", cfg.LogMaxBytes)
	}
	if cfg.LogMaxBackups != 5 {
		t.Fatalf("LogMaxBackups = %d", cfg.LogMaxBackups)
	}
}

func TestLoadLogEnvOverrides(t *testing.T) {
	t.Setenv("CC_STATUS_LOG_PATH", "/tmp/cc-status-events.jsonl")
	t.Setenv("CC_STATUS_LOG_MAX_BYTES", "4096")
	t.Setenv("CC_STATUS_LOG_MAX_BACKUPS", "7")

	cfg := Load()
	if cfg.LogPath != "/tmp/cc-status-events.jsonl" {
		t.Fatalf("LogPath = %q", cfg.LogPath)
	}
	if cfg.LogMaxBytes != 4096 {
		t.Fatalf("LogMaxBytes = %d", cfg.LogMaxBytes)
	}
	if cfg.LogMaxBackups != 7 {
		t.Fatalf("LogMaxBackups = %d", cfg.LogMaxBackups)
	}
}
