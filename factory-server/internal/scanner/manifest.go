// Package scanner discovers software-factory applications by walking the
// workspace for `.factory/app.json` manifests under scene/ and generated-apps/.
//
// A manifest is a small JSON descriptor (see docs/software-factory-mvp-design.md
// §8) that declares an application's slug, source type, build/runtime config and
// optional docker deployment. ParseManifest turns bytes into a Manifest;
// ValidateManifest enforces the import rules before a manifest is admitted into
// the applications table.
package scanner

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Manifest is the on-disk representation of `.factory/app.json`.
type Manifest struct {
	SchemaVersion int      `json:"schemaVersion"`
	Slug          string   `json:"slug"`
	Name          string   `json:"name"`
	Type          string   `json:"type"`
	Source        string   `json:"source"`
	Description   string   `json:"description"`
	Entry         string   `json:"entry"`
	Path          string   `json:"path"`
	Tags          []string `json:"tags"`
	Build         Build    `json:"build"`
	Runtime       Runtime  `json:"runtime"`
	Docker        Docker   `json:"docker"`
}

// Build holds the production build command and artifact location.
type Build struct {
	Command   string `json:"command"`
	OutputDir string `json:"outputDir"`
}

// Runtime holds the local dev server command and default port.
type Runtime struct {
	DevCommand  string `json:"devCommand"`
	DefaultPort int    `json:"defaultPort"`
}

// Docker declares the optional containerised deployment for the app.
type Docker struct {
	Enabled     bool   `json:"enabled"`
	Dockerfile  string `json:"dockerfile"`
	Context     string `json:"context"`
	RuntimePort int    `json:"runtimePort"`
}

// ParseManifest unmarshals manifest JSON. Unknown fields are ignored.
func ParseManifest(raw []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, fmt.Errorf("parse manifest: %w", err)
	}
	return m, nil
}

// ValidateManifest enforces the design §8 import rules. `path` is the manifest
// FILE path relative to the scan root (e.g. "scene/x/.factory/app.json").
func ValidateManifest(path string, m Manifest) error {
	if m.SchemaVersion != 1 {
		return fmt.Errorf("manifest %s: unsupported schemaVersion %d (want 1)", path, m.SchemaVersion)
	}
	if m.Slug == "" {
		return fmt.Errorf("manifest %s: slug is required", path)
	}
	if m.Name == "" {
		return fmt.Errorf("manifest %s: name is required", path)
	}
	switch m.Source {
	case "preset", "generated":
	default:
		return fmt.Errorf("manifest %s: invalid source %q (want preset or generated)", path, m.Source)
	}
	if m.Entry != "static-vite" {
		return fmt.Errorf("manifest %s: unsupported entry %q (want static-vite)", path, m.Entry)
	}
	// source/path correlation: preset must live under scene/, generated under generated-apps/.
	switch m.Source {
	case "preset":
		if !strings.HasPrefix(m.Path, "scene/") {
			return fmt.Errorf("manifest %s: preset app path %q must start with scene/", path, m.Path)
		}
	case "generated":
		if !strings.HasPrefix(m.Path, "generated-apps/") {
			return fmt.Errorf("manifest %s: generated app path %q must start with generated-apps/", path, m.Path)
		}
	}
	// The brief's TestValidateManifestSourceAndPath passes a generated manifest
	// whose file path is under scene/. Enforce that the manifest FILE location
	// matches its declared source as well, so a generated manifest under scene/
	// is rejected.
	switch m.Source {
	case "preset":
		if !strings.HasPrefix(path, "scene/") {
			return fmt.Errorf("manifest %s: preset manifest must live under scene/", path)
		}
	case "generated":
		if !strings.HasPrefix(path, "generated-apps/") {
			return fmt.Errorf("manifest %s: generated manifest must live under generated-apps/", path)
		}
	}
	if m.Docker.Enabled {
		if m.Docker.Dockerfile == "" {
			return fmt.Errorf("manifest %s: docker.enabled requires dockerfile", path)
		}
		if m.Docker.Context == "" {
			return fmt.Errorf("manifest %s: docker.enabled requires context", path)
		}
		if m.Docker.RuntimePort <= 0 {
			return fmt.Errorf("manifest %s: docker.enabled requires runtimePort > 0", path)
		}
	}
	return nil
}
