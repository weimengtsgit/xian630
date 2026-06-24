package config

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr             string
	DBPath           string
	CCStatusBaseURL  string
	ArtifactRoot     string
	WorkspaceRoot    string
	LogPath          string
	LogMaxBytes      int64
	LogMaxBackups    int
	ShutdownTimeout  time.Duration
	ContainerRuntime string // "podman" or "docker"
}

func Resolve(getenv func(string) string) Config {
	if getenv == nil {
		getenv = os.Getenv
	}
	home, _ := os.UserHomeDir()
	cfg := Config{
		Addr:             "127.0.0.1:8787",
		DBPath:           filepath.Join(home, ".software-factory", "state.db"),
		CCStatusBaseURL:  "http://127.0.0.1:8765",
		ArtifactRoot:     ".factory-runs",
		WorkspaceRoot:    ".",
		LogPath:          filepath.Join(".factory-runs", "factory-server.jsonl"),
		LogMaxBytes:      10 * 1024 * 1024,
		LogMaxBackups:    5,
		ShutdownTimeout:  5 * time.Second,
		ContainerRuntime: "podman", // default
	}
	if v := getenv("FACTORY_ADDR"); v != "" {
		cfg.Addr = v
	}
	if v := getenv("FACTORY_DBPATH"); v != "" {
		cfg.DBPath = v
	}
	if v := getenv("FACTORY_CC_STATUS_BASE_URL"); v != "" {
		cfg.CCStatusBaseURL = v
	}
	if v := getenv("FACTORY_ARTIFACT_ROOT"); v != "" {
		cfg.ArtifactRoot = v
	}
	if v := getenv("FACTORY_WORKSPACE_ROOT"); v != "" {
		cfg.WorkspaceRoot = v
	}
	if v := getenv("FACTORY_LOG_PATH"); v != "" {
		cfg.LogPath = v
	}
	if v := getenv("FACTORY_LOG_MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			cfg.LogMaxBytes = n
		}
	}
	if v := getenv("FACTORY_LOG_MAX_BACKUPS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.LogMaxBackups = n
		}
	}
	if v := getenv("FACTORY_CONTAINER_RUNTIME"); v != "" {
		switch strings.ToLower(v) {
		case "podman", "docker":
			cfg.ContainerRuntime = strings.ToLower(v)
		default:
			log.Printf("WARNING: Invalid FACTORY_CONTAINER_RUNTIME=%q, using podman", v)
		}
	}
	// Resolve WorkspaceRoot against the process cwd to an ABSOLUTE path. The
	// workspace feeds the project-local skill/blueprint path builders
	// (executor.selectedSkillPaths / blueprintRefPaths), which emit paths the
	// `claude` subprocess must Read. That subprocess runs with its working
	// directory set to the per-attempt artifact dir (deep under ArtifactRoot),
	// NOT the server's cwd — so a workspace-relative skill path resolves against
	// the wrong base and the agent reports every required skill as missing,
	// leaving usedSkills empty and failing validation (usedSkills required:
	// schema_validation_failed). An absolute workspace makes those Read paths
	// cwd-independent. filepath.Abs resolves against the server process's cwd,
	// which is stable at startup, and is idempotent for already-absolute inputs.
	if abs, err := filepath.Abs(cfg.WorkspaceRoot); err == nil {
		cfg.WorkspaceRoot = abs
	}
	return cfg
}
