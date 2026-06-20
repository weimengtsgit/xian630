package config

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	Addr              string
	DBPath            string
	CCStatusBaseURL   string
	ArtifactRoot      string
	WorkspaceRoot     string
	ShutdownTimeout   time.Duration
	ContainerRuntime  string // "podman" or "docker"
}

func Resolve(getenv func(string) string) Config {
	if getenv == nil {
		getenv = os.Getenv
	}
	home, _ := os.UserHomeDir()
	cfg := Config{
		Addr:            "127.0.0.1:8787",
		DBPath:          filepath.Join(home, ".software-factory", "state.db"),
		CCStatusBaseURL: "http://127.0.0.1:8765",
		ArtifactRoot:    ".factory-runs",
		WorkspaceRoot:   ".",
		ShutdownTimeout: 5 * time.Second,
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
	cfg.ContainerRuntime = "podman" // default
	if v := getenv("FACTORY_CONTAINER_RUNTIME"); v != "" {
		switch strings.ToLower(v) {
		case "podman", "docker":
			cfg.ContainerRuntime = strings.ToLower(v)
		default:
			log.Printf("WARNING: Invalid FACTORY_CONTAINER_RUNTIME=%q, using podman", v)
		}
	}
	return cfg
}
