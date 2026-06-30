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
