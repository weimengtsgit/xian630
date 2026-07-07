package server

import (
	"testing"
	"time"
)

// TestCredentialHandleAvailableLive verifies a freshly-stored runtime secret
// (not yet expired) resolves as available via its opaque handle.
func TestCredentialHandleAvailableLive(t *testing.T) {
	s := &Server{}
	s.credentialSecrets.Store("secret_live", runtimeCredentialSecret{
		DialogueID: "dlg_1",
		Scope:      "data_capture",
		Value:      "plaintext-never-persisted",
		ExpiresAt:  time.Now().Add(10 * time.Minute),
	})
	if !s.CredentialHandleAvailable("secret_live") {
		t.Fatalf("expected live handle to be available")
	}
}

// TestCredentialHandleAvailableExpired verifies an EXPIRED handle is rejected
// AND removed from the registry so it cannot be reused.
func TestCredentialHandleAvailableExpired(t *testing.T) {
	s := &Server{}
	s.credentialSecrets.Store("secret_expired", runtimeCredentialSecret{
		DialogueID: "dlg_1",
		Scope:      "data_capture",
		Value:      "plaintext-never-persisted",
		ExpiresAt:  time.Now().Add(-1 * time.Minute),
	})
	if s.CredentialHandleAvailable("secret_expired") {
		t.Fatalf("expected expired handle to be unavailable")
	}
	if _, ok := s.credentialSecrets.Load("secret_expired"); ok {
		t.Fatalf("expected expired handle to be deleted from the registry")
	}
}

// TestCredentialHandleAvailableUnknown verifies an unknown handle is rejected.
func TestCredentialHandleAvailableUnknown(t *testing.T) {
	s := &Server{}
	if s.CredentialHandleAvailable("secret_does_not_exist") {
		t.Fatalf("expected unknown handle to be unavailable")
	}
}

// TestStoreRuntimeSecretHandleShape verifies the returned handle is opaque
// (no plaintext leaks into the handle itself) and is retrievable.
func TestStoreRuntimeSecretHandleShape(t *testing.T) {
	s := &Server{}
	const value = "super-secret-bearer-token"
	handle := s.storeRuntimeSecret("dlg_1", "data_capture", value)
	if handle == "" {
		t.Fatalf("expected non-empty handle")
	}
	if containsVerbatim(handle, value) {
		t.Fatalf("handle %q must not embed the plaintext value", handle)
	}
	if !s.CredentialHandleAvailable(handle) {
		t.Fatalf("expected freshly-stored handle to be available")
	}
}

// containsVerbatim is a tiny local substring check to avoid importing strings
// for one assertion.
func containsVerbatim(haystack, needle string) bool {
	if len(needle) == 0 {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
