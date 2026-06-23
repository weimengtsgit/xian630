package scanner

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type presetVisibilityConfig struct {
	PresetApps map[string]struct {
		ShowInAppList *bool `json:"showInAppList"`
	} `json:"presetApps"`
}

func LoadPresetVisibility(root string) map[string]bool {
	path := filepath.Join(root, ".factory", "preset-apps.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]bool{}
	}
	var cfg presetVisibilityConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return map[string]bool{}
	}
	out := map[string]bool{}
	for slug, entry := range cfg.PresetApps {
		if entry.ShowInAppList != nil {
			out[slug] = *entry.ShowInAppList
		}
	}
	return out
}
