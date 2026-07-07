package dataaccess

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteVersionStoresInternalAndRedactedViews(t *testing.T) {
	root := t.TempDir()
	result := Result{
		SchemaVersion: 1,
		Stage:         "data_access",
		Version:       "v1",
		Status:        StatusPendingConfirmation,
		CanFinalize:   true,
		CredentialRefs: []CredentialRef{{
			ID:                "cred_1",
			AuthType:          "bearer",
			Value:             "secret-token",
			RedactionRequired: true,
		}},
		Summary: Summary{
			Confirmed: []string{"已探测用户接口"},
		},
	}

	versionDir, err := WriteVersion(root, "job_1", result, "# 数据获取方案\n\nAuthorization: Bearer secret-token\n")
	if err != nil {
		t.Fatalf("WriteVersion: %v", err)
	}
	internalRaw, err := os.ReadFile(filepath.Join(versionDir, "dataAccessResult.internal.json"))
	if err != nil {
		t.Fatalf("read internal: %v", err)
	}
	if !strings.Contains(string(internalRaw), "secret-token") {
		t.Fatalf("internal result should preserve credential for downstream codegen: %s", internalRaw)
	}
	redactedRaw, err := os.ReadFile(filepath.Join(versionDir, "dataAccessResult.redacted.json"))
	if err != nil {
		t.Fatalf("read redacted: %v", err)
	}
	if strings.Contains(string(redactedRaw), "secret-token") || !strings.Contains(string(redactedRaw), "[REDACTED]") {
		t.Fatalf("redacted result should mask credential: %s", redactedRaw)
	}
	redactedMD, err := os.ReadFile(filepath.Join(versionDir, "data-access.redacted.md"))
	if err != nil {
		t.Fatalf("read redacted markdown: %v", err)
	}
	if strings.Contains(string(redactedMD), "secret-token") {
		t.Fatalf("redacted markdown leaked credential: %s", redactedMD)
	}
}

func TestFinalizeVersionCopiesOnlyMatchingPendingVersion(t *testing.T) {
	root := t.TempDir()
	result := Result{
		SchemaVersion: 1,
		Stage:         "data_access",
		Version:       "v2",
		Status:        StatusPendingConfirmation,
		CanFinalize:   true,
	}
	if _, err := WriteVersion(root, "job_2", result, "# 数据获取方案\n"); err != nil {
		t.Fatalf("WriteVersion: %v", err)
	}

	if err := FinalizeVersion(root, "job_2", "v1", "tester"); err == nil {
		t.Fatalf("FinalizeVersion stale version should fail")
	}
	if err := FinalizeVersion(root, "job_2", "v2", "tester"); err != nil {
		t.Fatalf("FinalizeVersion: %v", err)
	}
	finalRaw, err := os.ReadFile(filepath.Join(root, "jobs", "job_2", "data-access", "final", "dataAccessResult.internal.json"))
	if err != nil {
		t.Fatalf("read final: %v", err)
	}
	var final Result
	if err := json.Unmarshal(finalRaw, &final); err != nil {
		t.Fatalf("decode final: %v", err)
	}
	if final.Status != StatusFinalized || final.Confirmation.ConfirmedBy != "tester" || final.Confirmation.ConfirmedAt == "" {
		t.Fatalf("final confirmation = %+v status=%s", final.Confirmation, final.Status)
	}
}

func TestWriteVersionRejectsOversizedArtifacts(t *testing.T) {
	root := t.TempDir()
	result := Result{
		SchemaVersion: 1,
		Stage:         "data_access",
		Version:       "v1",
		Status:        StatusPendingConfirmation,
		CanFinalize:   true,
	}
	if _, err := WriteVersion(root, "job_big_md", result, strings.Repeat("x", MaxInternalMarkdownBytes+1)); err == nil {
		t.Fatalf("WriteVersion should reject oversized markdown")
	}
	result.Summary.Confirmed = []string{strings.Repeat("y", MaxInternalJSONBytes+1)}
	if _, err := WriteVersion(root, "job_big_json", result, "# 数据获取方案\n"); err == nil {
		t.Fatalf("WriteVersion should reject oversized json")
	}
}

// TestResultToleratesModelShapeVariance is the regression guard for the
// job_d175be2b… output_invalid_json failure: models emit dataAccessResult with
// codegenConstraints as an OBJECT (not []string), sourceInputs as a LIST (not a
// single object), and summary as a plain STRING (not the {confirmed,…} struct).
// The tolerant fields (json.RawMessage / Summary custom marshal) must decode
// without error and preserve the agent's values — the string summary round-trips
// verbatim — so a shape drift never hard-fails data_integration.
func TestResultToleratesModelShapeVariance(t *testing.T) {
	raw := `{
		"schemaVersion":1,"stage":"data_access","version":"v1","status":"pending_confirmation","canFinalize":true,
		"codegenConstraints":{"mockDataMode":"static_json","dataServicePattern":"environment_based_routing"},
		"sourceInputs":[{"sourceId":"user_prompt","type":"user_selection"}],
		"summary":"物资仓储数据接入方案：采用 mock 演示数据。"
	}`
	var r Result
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		t.Fatalf("shape variance must not fail the decode: %v", err)
	}
	if r.Status != StatusPendingConfirmation || !r.CanFinalize {
		t.Fatalf("typed fields not decoded: status=%s canFinalize=%v", r.Status, r.CanFinalize)
	}
	// The agent's string summary must round-trip verbatim (not collapsed to {} ).
	sb, err := json.Marshal(r.Summary)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	if !strings.Contains(string(sb), "mock 演示数据") {
		t.Fatalf("string summary not round-tripped verbatim: %s", string(sb))
	}
}
