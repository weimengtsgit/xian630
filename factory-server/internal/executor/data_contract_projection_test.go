package executor

import (
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// TestDataContractProjectionProjectsVerificationDuringNeedsInput locks the
// review-round-2 finding: the data_contract verification metadata must be
// projected not only on success but ALSO while the step is waiting for the user
// to confirm a degradation (needs_input → waiting_user). Otherwise the
// workbench data-flow track can only show a card-level waiting state and cannot
// render the real per-boundary state (ontology red breakpoint + internet
// waiting confirmation) that spec #32 requires.
func TestDataContractProjectionProjectsVerificationDuringNeedsInput(t *testing.T) {
	detail := runner.DataIntegrationOutput{
		Status:         "needs_input",
		Summary:        "本体接口不可用，等待降级确认",
		SourceBoundary: "internet",
		Verification: runner.DataVerification{
			Ontology: runner.DataVerificationNode{Status: "failed", Reason: "401"},
			Internet: runner.DataVerificationNode{Status: "pending"},
			Demo:     runner.DataVerificationNode{Status: "pending"},
		},
		FallbackHistory: []string{"ontology_failed"},
	}
	proj, err := dataContractProjection(detail, model.StepStatusWaitingUser)
	if err != nil {
		t.Fatalf("dataContractProjection err = %v", err)
	}
	if !proj.Project {
		t.Fatal("must project data_contract metadata during needs_input (waiting_user)")
	}
	if proj.Label != "数据验证状态" || proj.Path != "" {
		t.Fatalf("waiting projection must not expose a final data-contract document link: label=%q path=%q", proj.Label, proj.Path)
	}
	if !strings.Contains(proj.Metadata, "ontology_failed") {
		t.Fatalf("metadata missing fallbackHistory: %s", proj.Metadata)
	}
	if !strings.Contains(proj.Metadata, `"status":"failed"`) || !strings.Contains(proj.Metadata, `"status":"pending"`) {
		t.Fatalf("metadata missing per-boundary verification states: %s", proj.Metadata)
	}

	proj2, err2 := dataContractProjection(detail, model.StepStatusSucceeded)
	if err2 != nil || !proj2.Project {
		t.Fatalf("must still project on success: project=%v err=%v", proj2.Project, err2)
	}
	if proj2.Label != "数据契约" || proj2.Path != "docs/data-integration.md" {
		t.Fatalf("success projection must expose final data-contract document: label=%q path=%q", proj2.Label, proj2.Path)
	}
	proj3, _ := dataContractProjection(detail, model.StepStatusFailed)
	if proj3.Project {
		t.Fatal("must not project on failed status")
	}
	proj4, _ := dataContractProjection(detail, model.StepStatusRunning)
	if proj4.Project {
		t.Fatal("must not project on running status")
	}
}

func TestDataContractProjectionMarksCompatibilityFailureForInterfaceRevalidation(t *testing.T) {
	detail := runner.DataIntegrationOutput{
		Status:         "needs_input",
		Summary:        "数据契约缺少界面预览假定字段",
		SourceBoundary: "internet",
		Verification: runner.DataVerification{
			Ontology: runner.DataVerificationNode{Status: "failed", Reason: "401"},
			Internet: runner.DataVerificationNode{Status: "passed"},
			Demo:     runner.DataVerificationNode{Status: "pending"},
		},
		FallbackHistory: []string{"ontology_failed"},
		Compatibility: runner.DataCompatibility{
			Status:        "failed",
			MissingFields: []string{"approvalStatus"},
		},
	}
	proj, err := dataContractProjection(detail, model.StepStatusWaitingUser)
	if err != nil {
		t.Fatalf("dataContractProjection err = %v", err)
	}
	if !proj.Project {
		t.Fatal("compatibility failure still needs a projected artifact for the workbench route")
	}
	if proj.Status != "compatible_failed" {
		t.Fatalf("projection status = %q, want compatible_failed so interface_parsing revalidation activates", proj.Status)
	}
	if proj.Path != "" {
		t.Fatalf("compatibility failure is not a confirmed data-contract document yet, path=%q", proj.Path)
	}
}
