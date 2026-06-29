package projectdocs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProjectStepDocumentWritesMarkdownAndIndex(t *testing.T) {
	root, out := fixture(t, `{"appName":"Demo","features":["A","B"]}`)
	entry, err := (Generator{}).ProjectStep(Source{ProjectRoot: root, JobID: "job_1", StepID: "step_1", Attempt: 2, AgentKey: "requirement-analyst", StepKind: "requirement_analysis", SourceArtifactID: "art_1", OutputPath: out, GeneratedAt: time.Date(2026, 6, 29, 0, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatalf("ProjectStep: %v", err)
	}
	if entry.Path != "docs/01-requirements.md" || entry.Type != "requirements" || !strings.HasPrefix(entry.SourceChecksum, "sha256:") {
		t.Fatalf("entry = %#v", entry)
	}
	raw, err := os.ReadFile(filepath.Join(root, "docs", "01-requirements.md"))
	if err != nil {
		t.Fatalf("read doc: %v", err)
	}
	if !strings.Contains(string(raw), "# 需求文档") || !strings.Contains(string(raw), "requirement-analyst") {
		t.Fatalf("doc content: %s", raw)
	}
	idx := readIndex(t, root)
	if len(idx.Documents) != 1 || idx.Documents[0].SourceArtifactID != "art_1" {
		t.Fatalf("index = %#v", idx)
	}
}

func TestProjectStepDocumentIsIdempotentBySourceChecksum(t *testing.T) {
	root, out := fixture(t, `{"summary":"same"}`)
	g := Generator{}
	for i := 0; i < 2; i++ {
		if _, err := g.ProjectStep(Source{ProjectRoot: root, JobID: "job", StepID: "s", Attempt: 1, AgentKey: "solution", StepKind: "solution_design", SourceArtifactID: "a", OutputPath: out}); err != nil {
			t.Fatalf("ProjectStep[%d]: %v", i, err)
		}
	}
	idx := readIndex(t, root)
	if len(idx.Documents) != 1 {
		t.Fatalf("documents len=%d want 1: %#v", len(idx.Documents), idx.Documents)
	}
}

func TestProjectStepRetryReplacesLatestAttemptEntry(t *testing.T) {
	root, out := fixture(t, `{"summary":"one"}`)
	g := Generator{}
	if _, err := g.ProjectStep(Source{ProjectRoot: root, JobID: "job", StepID: "s", Attempt: 1, AgentKey: "coder", StepKind: "code_generation", SourceArtifactID: "a1", OutputPath: out}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, []byte(`{"summary":"two"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := g.ProjectStep(Source{ProjectRoot: root, JobID: "job", StepID: "s", Attempt: 2, AgentKey: "coder", StepKind: "code_generation", SourceArtifactID: "a2", OutputPath: out}); err != nil {
		t.Fatal(err)
	}
	idx := readIndex(t, root)
	if len(idx.Documents) != 1 || idx.Documents[0].Attempt != 2 || idx.Documents[0].SourceArtifactID != "a2" {
		t.Fatalf("index = %#v", idx)
	}
}

func TestProjectSummaryUsesLatestDocuments(t *testing.T) {
	root, out := fixture(t, `{"summary":"one"}`)
	g := Generator{}
	_, _ = g.ProjectStep(Source{ProjectRoot: root, JobID: "job", StepID: "s1", Attempt: 1, AgentKey: "req", StepKind: "requirement_analysis", SourceArtifactID: "a1", OutputPath: out})
	_, _ = g.ProjectStep(Source{ProjectRoot: root, JobID: "job", StepID: "s2", Attempt: 1, AgentKey: "sol", StepKind: "solution_design", SourceArtifactID: "a2", OutputPath: out})
	if err := g.GenerateSummary(root); err != nil {
		t.Fatalf("GenerateSummary: %v", err)
	}
	for _, rel := range []string{"docs/00-summary.md", "README.md"} {
		raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("read %s: %v", rel, err)
		}
		if !strings.Contains(string(raw), "docs/01-requirements.md") || !strings.Contains(string(raw), "docs/02-solution.md") {
			t.Fatalf("summary %s = %s", rel, raw)
		}
	}
}

func fixture(t *testing.T, output string) (string, string) {
	t.Helper()
	root := t.TempDir()
	out := filepath.Join(t.TempDir(), "output.json")
	if err := os.WriteFile(out, []byte(output), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, out
}

func readIndex(t *testing.T, root string) Index {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(IndexPath)))
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	var idx Index
	if err := json.Unmarshal(raw, &idx); err != nil {
		t.Fatalf("parse index: %v", err)
	}
	return idx
}
