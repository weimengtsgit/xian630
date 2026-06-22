// Package config holds runtime configuration with sensible defaults and
// environment overrides.
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Config is the resolved configuration for the cc-status server.
type Config struct {
	// Addr is the listen address (loopback only by design).
	Addr string `json:"addr"`
	// DBPath is the SQLite database file.
	DBPath string `json:"db_path"`
	// GhostTimeout: a running entity with no update for this long is reaped to
	// StatusStale.
	GhostTimeout time.Duration `json:"ghost_timeout"`
	// TTL: completed/stale entities older than this are pruned.
	TTL time.Duration `json:"ttl"`
	// ScanInterval: how often the skill-name filesystem scanner refreshes.
	ScanInterval time.Duration `json:"scan_interval"`
	// ReaperInterval: how often the ghost reaper runs.
	ReaperInterval time.Duration `json:"reaper_interval"`
	// RetainInterval: how often the TTL prune runs.
	RetainInterval time.Duration `json:"retain_interval"`
	// IngestPath is the HTTP path the hook CLI posts events to.
	IngestPath string `json:"ingest_path"`
	// LogPath is the JSONL runtime event log.
	LogPath string `json:"log_path"`
	// LogMaxBytes rotates LogPath once it grows beyond this size.
	LogMaxBytes int64 `json:"log_max_bytes"`
	// LogMaxBackups is the number of rotated logs kept as .1, .2, ...
	LogMaxBackups int `json:"log_max_backups"`
}

// Default returns the built-in defaults.
func Default() Config {
	home, _ := os.UserHomeDir()
	if home == "" {
		home = "."
	}
	return Config{
		Addr:           "127.0.0.1:8765",
		DBPath:         filepath.Join(home, ".cc-status", "state.db"),
		GhostTimeout:   5 * time.Minute,
		TTL:            7 * 24 * time.Hour,
		ScanInterval:   60 * time.Second,
		ReaperInterval: 30 * time.Second,
		RetainInterval: 10 * time.Minute,
		IngestPath:     "/api/v1/events/ingest",
		LogPath:        filepath.Join(home, ".cc-status", "events.jsonl"),
		LogMaxBytes:    10 * 1024 * 1024,
		LogMaxBackups:  5,
	}
}

// Load applies XIAN630_* / CC_STATUS_* environment overrides on top of Default.
func Load() Config {
	c := Default()
	if v := os.Getenv("CC_STATUS_ADDR"); v != "" {
		c.Addr = v
	}
	if v := os.Getenv("CC_STATUS_DBPATH"); v != "" {
		c.DBPath = v
	}
	if v := os.Getenv("CC_STATUS_GHOST_TIMEOUT"); v != "" {
		if d, ok := time.ParseDuration(v); ok == nil {
			c.GhostTimeout = d
		}
	}
	if v := os.Getenv("CC_STATUS_TTL"); v != "" {
		if d, ok := time.ParseDuration(v); ok == nil {
			c.TTL = d
		}
	}
	if v := os.Getenv("CC_STATUS_SCAN_INTERVAL"); v != "" {
		if d, ok := time.ParseDuration(v); ok == nil {
			c.ScanInterval = d
		}
	}
	if v := os.Getenv("CC_STATUS_LOG_PATH"); v != "" {
		c.LogPath = v
	}
	if v := os.Getenv("CC_STATUS_LOG_MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			c.LogMaxBytes = n
		}
	}
	if v := os.Getenv("CC_STATUS_LOG_MAX_BACKUPS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.LogMaxBackups = n
		}
	}
	return c
}

// ServerURL returns the base URL the hook CLI posts to.
func (c Config) ServerURL() string {
	return "http://" + c.Addr
}
