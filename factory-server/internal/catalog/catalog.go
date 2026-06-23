package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const configRelPath = ".factory/catalog.json"

type Config struct {
	Apps       map[string]Toggle `json:"apps"`
	Blueprints map[string]Toggle `json:"blueprints"`
}

type Toggle struct {
	Enabled       *bool `json:"enabled,omitempty"`
	ShowInAppList *bool `json:"showInAppList,omitempty"`
}

func (t *Toggle) UnmarshalJSON(data []byte) error {
	var flag bool
	if err := json.Unmarshal(data, &flag); err == nil {
		t.Enabled = boolPtr(flag)
		t.ShowInAppList = boolPtr(flag)
		return nil
	}
	type alias Toggle
	var raw alias
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*t = Toggle(raw)
	if t.Enabled != nil && t.ShowInAppList == nil {
		t.ShowInAppList = t.Enabled
	}
	return nil
}

func Load(root string) Config {
	raw, err := os.ReadFile(filepath.Join(root, configRelPath))
	if err != nil {
		return Config{}
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}
	}
	if cfg.Apps == nil {
		cfg.Apps = map[string]Toggle{}
	}
	if cfg.Blueprints == nil {
		cfg.Blueprints = map[string]Toggle{}
	}
	return cfg
}

func AppEnabled(cfg Config, slug string) bool {
	entry, ok := cfg.Apps[slug]
	if !ok || entry.Enabled == nil {
		return true
	}
	return *entry.Enabled
}

func AppVisibleInList(cfg Config, slug string) bool {
	entry, ok := cfg.Apps[slug]
	if !ok || entry.ShowInAppList == nil {
		return true
	}
	return *entry.ShowInAppList
}

func BlueprintEnabled(cfg Config, slug string) bool {
	entry, ok := cfg.Blueprints[slug]
	if !ok || entry.Enabled == nil {
		return true
	}
	return *entry.Enabled
}

func FilterBlueprintRefs(cfg Config, refs []string) []string {
	out := refs[:0:0]
	for _, ref := range refs {
		if BlueprintEnabled(cfg, ref) {
			out = append(out, ref)
		}
	}
	return out
}

func boolPtr(v bool) *bool {
	return &v
}
