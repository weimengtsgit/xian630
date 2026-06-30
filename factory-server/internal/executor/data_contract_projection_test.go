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
	meta, project, err := dataContractProjection(detail, model.StepStatusWaitingUser)
	if err != nil {
		t.Fatalf("dataContractProjection err = %v", err)
	}
	if !project {
		t.Fatal("must project data_contract metadata during needs_input (waiting_user)")
	}
	if !strings.Contains(meta, "ontology_failed") {
		t.Fatalf("metadata missing fallbackHistory: %s", meta)
	}
	if !strings.Contains(meta, `"status":"failed"`) || !strings.Contains(meta, `"status":"pending"`) {
		t.Fatalf("metadata missing per-boundary verification states: %s", meta)
	}

	if _, project2, err2 := dataContractProjection(detail, model.StepStatusSucceeded); err2 != nil || !project2 {
		t.Fatalf("must still project on success: project=%v err=%v", project2, err2)
	}
	if _, project3, _ := dataContractProjection(detail, model.StepStatusFailed); project3 {
		t.Fatal("must not project on failed status")
	}
	if _, project4, _ := dataContractProjection(detail, model.StepStatusRunning); project4 {
		t.Fatal("must not project on running status")
	}
}
