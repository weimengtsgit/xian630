package executor

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

func TestReadPrototypeBundleRequiresContainedFiles(t *testing.T) {
	ws := runner.AttemptWorkspace{Root: t.TempDir(), JobID: "job_1", StepKind: model.StepDesignContract, Attempt: 1}
	protoDir := filepath.Join(ws.Dir(), "prototype")
	if err := os.MkdirAll(protoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(protoDir, "index.html"), "<!doctype html><title>首页</title>")
	writeFile(t, filepath.Join(protoDir, "styles.css"), "body{margin:0}")
	writeFile(t, filepath.Join(protoDir, "preview-manifest.json"), `{"mode":"static","defaultPage":"home","fidelity":"static","pages":[{"id":"home","title":"首页","file":"prototype/index.html","generated":true,"visibleByDefault":true}]}`)
	writeFile(t, filepath.Join(protoDir, "prototype-contract.json"), `{"prototypeStatus":"unconfirmed","downstreamConstraintLevel":"reference","immutable":false,"prototype":{"style":"ued_review","targetAudience":"ued","targetPlatform":"responsive","fidelity":"static","defaultPage":"home","confirmationPolicy":"unconfirmed_reference","pages":[{"id":"home","title":"首页","generated":true,"visibleByDefault":true}]}}`)

	bundle, err := readPrototypeBundle(ws)
	if err != nil {
		t.Fatalf("readPrototypeBundle err = %v", err)
	}
	if bundle.PreviewRelPath != "jobs/job_1/design_contract/attempt-1/prototype/preview-manifest.json" {
		t.Fatalf("PreviewRelPath = %q", bundle.PreviewRelPath)
	}
}

func TestReadPrototypeBundleRejectsPreviewOutsidePrototypeDir(t *testing.T) {
	ws := runner.AttemptWorkspace{Root: t.TempDir(), JobID: "job_1", StepKind: model.StepDesignContract, Attempt: 1}
	protoDir := filepath.Join(ws.Dir(), "prototype")
	if err := os.MkdirAll(protoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(protoDir, "index.html"), "<!doctype html>")
	writeFile(t, filepath.Join(protoDir, "styles.css"), "body{}")
	writeFile(t, filepath.Join(protoDir, "preview-manifest.json"), `{"mode":"static","defaultPage":"home","fidelity":"static","pages":[{"id":"home","title":"首页","file":"../secret.html","generated":true,"visibleByDefault":true}]}`)
	writeFile(t, filepath.Join(protoDir, "prototype-contract.json"), `{"prototypeStatus":"unconfirmed","downstreamConstraintLevel":"reference","immutable":false,"prototype":{"style":"ued_review","targetAudience":"ued","targetPlatform":"responsive","fidelity":"static","defaultPage":"home","confirmationPolicy":"unconfirmed_reference","pages":[{"id":"home","title":"首页","generated":true,"visibleByDefault":true}]}}`)

	if _, err := readPrototypeBundle(ws); err == nil {
		t.Fatalf("expected traversal-style preview file to be rejected")
	}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
