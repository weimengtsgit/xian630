package runner

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func writeJSON(t *testing.T, dir, name string, content []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

func TestValidateRequirementAnalysisMissingFile(t *testing.T) {
	_, err := ValidateRequirementAnalysis(filepath.Join(t.TempDir(), "nope.json"))
	if !errors.Is(err, ErrOutputMissing) {
		t.Fatalf("err = %v, want ErrOutputMissing", err)
	}
}

func TestValidateRequirementAnalysisInvalidJSON(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte("{not json"))
	_, err := ValidateRequirementAnalysis(p)
	if !errors.Is(err, ErrOutputInvalidJSON) {
		t.Fatalf("err = %v, want ErrOutputInvalidJSON", err)
	}
}

func TestValidateRequirementAnalysisNeedsUserInput(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"summary": "x", "needsUserInput": true,
		"questions": [{"id":"q1","question":"how big?","defaultAnswer":"5"}]
	}`))
	out, err := ValidateRequirementAnalysis(p)
	if err != nil {
		t.Fatalf("err = %v, want nil (needsUserInput is a signal, not an error)", err)
	}
	if !out.NeedsUserInput {
		t.Fatal("NeedsUserInput = false, want true")
	}
	if len(out.Questions) != 1 || out.Questions[0].ID != "q1" {
		t.Fatalf("Questions = %+v, want one with id q1", out.Questions)
	}
}

func TestValidateRequirementAnalysisUnknownFieldRejected(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"summary":"x","needsUserInput":false,"bogusField":1
	}`))
	_, err := ValidateRequirementAnalysis(p)
	if err == nil {
		t.Fatal("err = nil, want JSON decode error for unknown field")
	}
}

func TestValidateSolutionDesignHappy(t *testing.T) {
	p := writeJSON(t, t.TempDir(), "output.json", []byte(`{
		"needsUserInput": false
	}`))
	out, err := ValidateSolutionDesign(p)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if out.NeedsUserInput {
		t.Fatal("NeedsUserInput = true, want false")
	}
}

func TestValidateCodeGenerationMissingManifest(t *testing.T) {
	dir := t.TempDir()
	out := writeJSON(t, dir, "output.json", []byte(`{
		"projectDir": "generated-apps/slug",
		"needsUserInput": false
	}`))
	projectDir := t.TempDir() // .factory/app.json absent
	_, err := ValidateCodeGeneration(out, projectDir)
	if !errors.Is(err, ErrSchemaValidationFailed) {
		t.Fatalf("err = %v, want ErrSchemaValidationFailed", err)
	}
}

func TestValidateCodeGenerationManifestPresent(t *testing.T) {
	dir := t.TempDir()
	out := writeJSON(t, dir, "output.json", []byte(`{
		"projectDir": "generated-apps/slug",
		"needsUserInput": false
	}`))
	projectDir := t.TempDir()
	manifestDir := filepath.Join(projectDir, ".factory")
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "app.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ValidateCodeGeneration(out, projectDir)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if res.NeedsUserInput {
		t.Fatal("NeedsUserInput = true, want false")
	}
}

// guard against accidental drift in sentinel string values vs model codes.
func TestSentinelStrings(t *testing.T) {
	cases := []struct {
		err error
		s   string
	}{
		{ErrOutputMissing, string(model.ErrorOutputMissing)},
		{ErrOutputInvalidJSON, string(model.ErrorOutputInvalidJSON)},
		{ErrSchemaValidationFailed, string(model.ErrorSchemaValidationFailed)},
		{ErrFileConstraintViolated, string(model.ErrorFileConstraintViolated)},
		{ErrRunnerExitNonzero, string(model.ErrorRunnerExitNonzero)},
	}
	for _, c := range cases {
		if c.err.Error() != c.s {
			t.Errorf("sentinel %v Error() = %q, want %q", c.err, c.err.Error(), c.s)
		}
	}
}
