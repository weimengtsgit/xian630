package scanner

import "testing"

func TestParseManifest(t *testing.T) {
	raw := []byte(`{
  "schemaVersion": 1,
  "slug": "east-sea-situation",
  "name": "东海目标态势演示",
  "type": "map-dashboard",
  "source": "preset",
  "description": "demo",
  "entry": "static-vite",
  "path": "scene/east-sea-situation",
  "tags": ["map"],
  "build": {"command": "npm run build", "outputDir": "dist"},
  "runtime": {"devCommand": "npm run dev", "defaultPort": 5173},
  "docker": {"enabled": true, "dockerfile": "Dockerfile", "context": ".", "runtimePort": 80}
}`)
	m, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if m.Slug != "east-sea-situation" || m.Entry != "static-vite" || !m.Docker.Enabled {
		t.Fatalf("manifest = %#v", m)
	}
}

func TestValidateManifestSourceAndPath(t *testing.T) {
	m := Manifest{SchemaVersion: 1, Slug: "x", Name: "x", Source: "generated", Entry: "static-vite"}
	if err := ValidateManifest("scene/x/.factory/app.json", m); err == nil {
		t.Fatal("expected generated manifest under scene to fail")
	}
}
